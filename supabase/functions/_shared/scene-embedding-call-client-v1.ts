import {
  embedGeminiRetrievalQuery,
  GeminiEmbeddingError,
  GEMINI_EMBEDDING_DIMENSIONS,
  retrievalQueryText,
} from "./gemini-embedding-rest-v1.ts";
import type { RpcInvoker } from "./reference-index-state-client-v1.ts";
import type {
  PromptEmbedding,
  RetrievedConditioningReference,
} from "./reference-retriever-v1.ts";
import type { AntiCopyReference } from "./scene-anti-copy-v1.ts";
import {
  evaluateGeneratedSceneCandidate,
  type EvaluatedSceneCandidate,
} from "./scene-candidate-evaluator-v1.ts";

export const GEMINI_EMBEDDING_PRICING_VERSION = "2026-08-17" as const;
export const GEMINI_TEXT_EMBEDDING_MICRO_USD_PER_MILLION_TOKENS =
  200_000 as const;
export const GEMINI_IMAGE_EMBEDDING_MICRO_USD_PER_IMAGE = 120 as const;

export class SceneEmbeddingCallError extends Error {
  constructor(
    readonly code:
      | "database_error"
      | "embedding_call_recovery_required"
      | "invalid_rpc_response",
    message: string,
  ) {
    super(message);
    this.name = "SceneEmbeddingCallError";
  }
}

function firstRow(data: unknown): Record<string, unknown> {
  const value = Array.isArray(data) ? data[0] : data;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SceneEmbeddingCallError(
      "invalid_rpc_response",
      "scene embedding RPC returned no row",
    );
  }
  return value as Record<string, unknown>;
}

function usageTokenCount(usage: Record<string, unknown>): number {
  const value = Number(usage.promptTokenCount ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function textEmbeddingCostMicros(promptTokens: number): number {
  if (!Number.isSafeInteger(promptTokens) || promptTokens < 0) {
    throw new Error("embedding_token_count_invalid");
  }
  return Math.ceil(
    promptTokens *
      GEMINI_TEXT_EMBEDDING_MICRO_USD_PER_MILLION_TOKENS /
      1_000_000,
  );
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function reserveEmbeddingCall(
  rpc: RpcInvoker,
  input: {
    jobId: string;
    profileId: string;
    attemptId: string;
    leaseToken: string;
    callId: string;
    purpose: "reference_retrieval_query" | "anti_copy_output";
    candidateIndex: 0 | 1;
    requestHash: string;
  },
): Promise<{ invokeAllowed: boolean; callId: string; status: string }> {
  const result = await rpc("reserve_scene_embedding_call", {
    p_job_id: input.jobId,
    p_profile_id: input.profileId,
    p_attempt_id: input.attemptId,
    p_lease_token: input.leaseToken,
    p_call_id: input.callId,
    p_purpose: input.purpose,
    p_candidate_index: input.candidateIndex,
    p_request_hash: input.requestHash,
  });
  if (result.error) {
    throw new SceneEmbeddingCallError(
      "database_error",
      `embedding call reservation failed: ${result.error.message}`,
    );
  }
  const row = firstRow(result.data);
  return {
    invokeAllowed: row.invoke_allowed === true,
    callId: String(row.embedding_call_id),
    status: String(row.call_status),
  };
}

async function recordEmbeddingResult(
  rpc: RpcInvoker,
  input: {
    jobId: string;
    profileId: string;
    attemptId: string;
    leaseToken: string;
    callId: string;
    resultDigest: string | null;
    vectorPayload: readonly number[] | null;
    providerRequestId: string | null;
    inputUnits: number;
    outputUnits: number;
    costMicros: number;
    providerMeta: Record<string, unknown>;
  },
): Promise<{ resultDigest: string; replayed: boolean }> {
  const args = {
    p_job_id: input.jobId,
    p_profile_id: input.profileId,
    p_attempt_id: input.attemptId,
    p_lease_token: input.leaseToken,
    p_embedding_call_id: input.callId,
    p_result_digest: input.resultDigest,
    p_vector_payload: input.vectorPayload,
    p_provider_request_id: input.providerRequestId,
    p_input_units: input.inputUnits,
    p_output_units: input.outputUnits,
    p_cost_micros: input.costMicros,
    p_provider_meta: input.providerMeta,
  };
  let response = await rpc("record_scene_embedding_result", args);
  for (let retry = 0; response.error && retry < 2; retry += 1) {
    await new Promise((resolve) => setTimeout(resolve, 75 * (retry + 1)));
    response = await rpc("record_scene_embedding_result", args);
  }
  if (response.error) {
    throw new SceneEmbeddingCallError(
      "database_error",
      `embedding result commit is unknown: ${response.error.message}`,
    );
  }
  const row = firstRow(response.data);
  return {
    resultDigest: String(row.result_digest),
    replayed: row.replayed === true,
  };
}

async function recordEmbeddingFailure(
  rpc: RpcInvoker,
  input: {
    jobId: string;
    profileId: string;
    attemptId: string;
    leaseToken: string;
    callId: string;
    error: unknown;
  },
): Promise<void> {
  const providerError = input.error instanceof GeminiEmbeddingError
    ? input.error
    : null;
  const outcome = providerError?.code === "provider_rejected"
    ? "provider_rejected"
    : providerError?.code === "provider_timeout" ||
        providerError?.code === "provider_failed"
    ? "indeterminate"
    : "provider_failed";
  await rpc("record_scene_embedding_failure", {
    p_job_id: input.jobId,
    p_profile_id: input.profileId,
    p_attempt_id: input.attemptId,
    p_lease_token: input.leaseToken,
    p_embedding_call_id: input.callId,
    p_outcome: outcome,
    p_error_code: providerError?.code ?? "embedding_failed",
    p_error_detail: String(
      input.error instanceof Error ? input.error.message : input.error,
    ).slice(0, 1_000),
    p_provider_request_id: null,
  });
}

async function recoveredRetrievalEmbedding(
  rpc: RpcInvoker,
  input: { jobId: string; profileId: string; requestHash: string },
): Promise<PromptEmbedding | null> {
  const response = await rpc("get_scene_retrieval_embedding", {
    p_job_id: input.jobId,
    p_profile_id: input.profileId,
    p_request_hash: input.requestHash,
  });
  if (response.error) {
    throw new SceneEmbeddingCallError(
      "database_error",
      `retrieval embedding recovery failed: ${response.error.message}`,
    );
  }
  const values = Array.isArray(response.data) ? response.data : [];
  if (values.length === 0) return null;
  const row = firstRow(values);
  if (!Array.isArray(row.vector_payload) || row.vector_payload.length !== GEMINI_EMBEDDING_DIMENSIONS) {
    throw new SceneEmbeddingCallError(
      "invalid_rpc_response",
      "stored retrieval embedding is invalid",
    );
  }
  const vector = row.vector_payload.map(Number);
  if (vector.some((component) => !Number.isFinite(component))) {
    throw new SceneEmbeddingCallError(
      "invalid_rpc_response",
      "stored retrieval embedding contains non-finite values",
    );
  }
  return {
    model: "gemini-embedding-2",
    dimensions: GEMINI_EMBEDDING_DIMENSIONS,
    values: vector,
    inputSha256: input.requestHash,
  };
}

export async function ledgeredRetrievalQueryEmbedding(
  rpc: RpcInvoker,
  input: {
    apiKey: string;
    jobId: string;
    profileId: string;
    attemptId: string;
    leaseToken: string;
    embeddingCallId: string;
    prompt: string;
    signal?: AbortSignal;
  },
): Promise<PromptEmbedding> {
  // embedGeminiRetrievalQuery applies the official asymmetric query prefix.
  const queryInput = retrievalQueryText(input.prompt);
  const requestHash = await sha256Text(queryInput);
  const reservation = await reserveEmbeddingCall(rpc, {
    ...input,
    callId: input.embeddingCallId,
    purpose: "reference_retrieval_query",
    candidateIndex: 0,
    requestHash,
  });
  if (!reservation.invokeAllowed) {
    const recovered = await recoveredRetrievalEmbedding(rpc, {
      jobId: input.jobId,
      profileId: input.profileId,
      requestHash,
    });
    if (recovered) return recovered;
    throw new SceneEmbeddingCallError(
      "embedding_call_recovery_required",
      `retrieval embedding already has status ${reservation.status}`,
    );
  }

  try {
    const embedded = await embedGeminiRetrievalQuery(
      input.apiKey,
      input.prompt,
      input.signal,
    );
    if (embedded.inputSha256 !== requestHash) {
      throw new Error("retrieval_embedding_input_hash_mismatch");
    }
    const tokens = usageTokenCount(embedded.usageMetadata);
    await recordEmbeddingResult(rpc, {
      ...input,
      callId: reservation.callId,
      resultDigest: null,
      vectorPayload: embedded.values,
      providerRequestId: embedded.providerRequestId,
      inputUnits: tokens,
      outputUnits: 0,
      costMicros: textEmbeddingCostMicros(tokens),
      providerMeta: {
        pricingVersion: GEMINI_EMBEDDING_PRICING_VERSION,
        usage: embedded.usageMetadata,
      },
    });
    return {
      model: embedded.model,
      dimensions: embedded.dimensions,
      values: embedded.values,
      inputSha256: embedded.inputSha256,
    };
  } catch (error) {
    await recordEmbeddingFailure(rpc, {
      ...input,
      callId: reservation.callId,
      error,
    }).catch(() => undefined);
    throw error;
  }
}

export async function ledgeredSceneCandidateEvaluation(
  rpc: RpcInvoker,
  input: {
    apiKey: string;
    jobId: string;
    profileId: string;
    attemptId: string;
    leaseToken: string;
    embeddingCallId: string;
    candidateIndex: 0 | 1;
    contentSha256: string;
    bytes: Uint8Array;
    mimeType: "image/jpeg" | "image/png" | "image/webp";
    references: readonly RetrievedConditioningReference[];
    additionalReferences?: readonly AntiCopyReference[];
    signal?: AbortSignal;
  },
): Promise<EvaluatedSceneCandidate> {
  const reservation = await reserveEmbeddingCall(rpc, {
    ...input,
    callId: input.embeddingCallId,
    purpose: "anti_copy_output",
    requestHash: input.contentSha256,
  });
  if (!reservation.invokeAllowed) {
    throw new SceneEmbeddingCallError(
      "embedding_call_recovery_required",
      `candidate embedding already has status ${reservation.status}`,
    );
  }

  try {
    const evaluated = await evaluateGeneratedSceneCandidate(input);
    const tokens = usageTokenCount(evaluated.usageMetadata);
    await recordEmbeddingResult(rpc, {
      ...input,
      callId: reservation.callId,
      resultDigest: evaluated.outputEmbeddingDigest,
      vectorPayload: null,
      providerRequestId: evaluated.providerRequestId,
      inputUnits: Math.max(tokens, 1),
      outputUnits: 0,
      costMicros: GEMINI_IMAGE_EMBEDDING_MICRO_USD_PER_IMAGE,
      providerMeta: {
        pricingVersion: GEMINI_EMBEDDING_PRICING_VERSION,
        usage: evaluated.usageMetadata,
      },
    });
    return evaluated;
  } catch (error) {
    await recordEmbeddingFailure(rpc, {
      ...input,
      callId: reservation.callId,
      error,
    }).catch(() => undefined);
    throw error;
  }
}
