import type { RpcInvoker } from "./reference-index-state-client-v1.ts";
import type { AntiCopyDecision } from "./scene-anti-copy-v1.ts";

export class SceneProviderCallError extends Error {
  constructor(
    readonly code:
      | "database_error"
      | "provider_call_not_invokable"
      | "upload_not_authorized"
      | "invalid_rpc_response",
    message: string,
  ) {
    super(message);
    this.name = "SceneProviderCallError";
  }
}

function firstRow(data: unknown): Record<string, unknown> {
  const value = Array.isArray(data) ? data[0] : data;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SceneProviderCallError(
      "invalid_rpc_response",
      "scene provider RPC returned no row",
    );
  }
  return value as Record<string, unknown>;
}

export async function reserveSceneProviderCall(
  rpc: RpcInvoker,
  input: {
    jobId: string;
    profileId: string;
    attemptId: string;
    leaseToken: string;
    callId: string;
    callIndex: 0 | 1;
    provider: string;
    modelRef: string;
    requestHash: string;
    referenceManifestHash: string;
    aestheticReferenceHashes: readonly string[];
    fixedReferenceSnapshotId: string;
    fixedReferenceHashes: readonly string[];
    identityReferenceHashes: readonly string[];
  },
): Promise<{
  invokeAllowed: boolean;
  providerCallId: string;
  status: string;
  fundingSource: "user_reserved" | "system_anti_copy";
}> {
  const result = await rpc("reserve_scene_provider_call_v2", {
    p_job_id: input.jobId,
    p_profile_id: input.profileId,
    p_attempt_id: input.attemptId,
    p_lease_token: input.leaseToken,
    p_call_id: input.callId,
    p_call_index: input.callIndex,
    p_provider: input.provider,
    p_model_ref: input.modelRef,
    p_request_hash: input.requestHash,
    p_reference_manifest_hash: input.referenceManifestHash,
    p_aesthetic_reference_hashes: [...input.aestheticReferenceHashes],
    p_fixed_reference_snapshot_id: input.fixedReferenceSnapshotId,
    p_fixed_reference_hashes: [...input.fixedReferenceHashes],
    p_identity_reference_hashes: [...input.identityReferenceHashes],
  });
  if (result.error) {
    throw new SceneProviderCallError(
      "database_error",
      `provider call reservation failed: ${result.error.message}`,
    );
  }
  const row = firstRow(result.data);
  const fundingSource = String(row.funding_source);
  if (fundingSource !== "user_reserved" && fundingSource !== "system_anti_copy") {
    throw new SceneProviderCallError(
      "invalid_rpc_response",
      "provider call returned an invalid funding source",
    );
  }
  return {
    invokeAllowed: row.invoke_allowed === true,
    providerCallId: String(row.provider_call_id),
    status: String(row.call_status),
    fundingSource,
  };
}

export async function recordSceneProviderCandidate(
  rpc: RpcInvoker,
  input: {
    jobId: string;
    profileId: string;
    attemptId: string;
    leaseToken: string;
    providerCallId: string;
    providerRequestId: string | null;
    providerResponseId: string | null;
    outputMime: "image/jpeg" | "image/png" | "image/webp";
    outputWidth: number;
    outputHeight: number;
    outputContentSha256: string;
    outputEmbeddingDigest: string;
    antiCopyDecision: AntiCopyDecision;
    inputUnits: number;
    outputUnits: number;
    costMicros: number;
    providerMeta: Record<string, unknown>;
  },
): Promise<{
  providerCallId: string;
  decision: "accepted" | "copy_rejected";
  rerollAllowed: boolean;
}> {
  const args = {
    p_job_id: input.jobId,
    p_profile_id: input.profileId,
    p_attempt_id: input.attemptId,
    p_lease_token: input.leaseToken,
    p_provider_call_id: input.providerCallId,
    p_provider_request_id: input.providerRequestId,
    p_provider_response_id: input.providerResponseId,
    p_output_mime: input.outputMime,
    p_output_width: input.outputWidth,
    p_output_height: input.outputHeight,
    p_output_content_sha256: input.outputContentSha256,
    p_output_embedding_digest: input.outputEmbeddingDigest,
    p_maximum_similarity: input.antiCopyDecision.maximumSimilarity,
    p_matched_reference_kind: input.antiCopyDecision.matchedReferenceKind,
    p_matched_reference_sha256:
      input.antiCopyDecision.matchedReferenceSha256,
    p_input_units: input.inputUnits,
    p_output_units: input.outputUnits,
    p_cost_micros: input.costMicros,
    p_provider_meta: input.providerMeta,
  };
  let response = await rpc("record_scene_provider_candidate", args);
  for (let retry = 0; response.error && retry < 2; retry += 1) {
    await new Promise((resolve) => setTimeout(resolve, 75 * (retry + 1)));
    response = await rpc("record_scene_provider_candidate", args);
  }
  if (response.error) {
    throw new SceneProviderCallError(
      "database_error",
      `provider candidate record failed: ${response.error.message}`,
    );
  }
  const row = firstRow(response.data);
  const decision = String(row.decision);
  if (decision !== "accepted" && decision !== "copy_rejected") {
    throw new SceneProviderCallError(
      "invalid_rpc_response",
      "provider candidate returned an invalid anti-copy decision",
    );
  }
  return {
    providerCallId: String(row.provider_call_id),
    decision,
    rerollAllowed: row.reroll_allowed === true,
  };
}

export async function recordSceneProviderFailure(
  rpc: RpcInvoker,
  input: {
    jobId: string;
    profileId: string;
    attemptId: string;
    leaseToken: string;
    providerCallId: string;
    outcome: "provider_rejected" | "provider_failed" | "indeterminate";
    errorCode: string;
    errorDetail: string;
    providerRequestId?: string | null;
  },
): Promise<string> {
  const response = await rpc("record_scene_provider_failure", {
    p_job_id: input.jobId,
    p_profile_id: input.profileId,
    p_attempt_id: input.attemptId,
    p_lease_token: input.leaseToken,
    p_provider_call_id: input.providerCallId,
    p_outcome: input.outcome,
    p_error_code: input.errorCode,
    p_error_detail: input.errorDetail,
    p_provider_request_id: input.providerRequestId ?? null,
  });
  if (response.error) {
    throw new SceneProviderCallError(
      "database_error",
      `provider failure record failed: ${response.error.message}`,
    );
  }
  return String(response.data);
}

export async function authorizeSceneOutputUpload(
  rpc: RpcInvoker,
  input: {
    jobId: string;
    profileId: string;
    attemptId: string;
    leaseToken: string;
    providerCallId: string;
    contentSha256: string;
  },
): Promise<{
  providerCallId: string;
  candidateIndex: 0 | 1;
  rerollUsed: boolean;
  maximumSimilarity: number;
  matchedReferenceKind: string;
  matchedReferenceSha256: string;
  referenceSnapshotId: string;
  referenceManifestHash: string;
  retrievedAestheticHashes: readonly string[];
  identityReferenceHashes: readonly string[];
  outputEmbeddingDigest: string;
  antiCopyPolicyVersion: string;
  antiCopyThreshold: number;
  fixedReferenceSnapshotId: string;
  fixedReferenceManifestHash: string;
  fixedReferenceHashes: readonly string[];
  fixedReferenceEmbeddingDigests: readonly string[];
}> {
  const response = await rpc("authorize_scene_output_upload_v2", {
    p_job_id: input.jobId,
    p_profile_id: input.profileId,
    p_attempt_id: input.attemptId,
    p_lease_token: input.leaseToken,
    p_provider_call_id: input.providerCallId,
    p_content_sha256: input.contentSha256,
  });
  if (response.error) {
    throw new SceneProviderCallError(
      "database_error",
      `upload authorization failed: ${response.error.message}`,
    );
  }
  const row = firstRow(response.data);
  if (row.authorized !== true || (row.candidate_index !== 0 && row.candidate_index !== 1)) {
    throw new SceneProviderCallError(
      "upload_not_authorized",
      "candidate is not authorized for Storage upload",
    );
  }
  const retrievedAestheticHashes = Array.isArray(
      row.retrieved_aesthetic_hashes,
    )
    ? row.retrieved_aesthetic_hashes.map(String)
    : [];
  const fixedReferenceHashes = Array.isArray(row.fixed_reference_hashes)
    ? row.fixed_reference_hashes.map(String)
    : [];
  const identityReferenceHashes = Array.isArray(row.identity_reference_hashes)
    ? row.identity_reference_hashes.map(String)
    : [];
  const fixedReferenceEmbeddingDigests = Array.isArray(
      row.fixed_reference_embedding_digests,
    )
    ? row.fixed_reference_embedding_digests.map(String)
    : [];
  return {
    providerCallId: String(row.provider_call_id),
    candidateIndex: row.candidate_index,
    rerollUsed: row.reroll_used === true,
    maximumSimilarity: Number(row.maximum_similarity),
    matchedReferenceKind: String(row.matched_reference_kind),
    matchedReferenceSha256: String(row.matched_reference_sha256),
    referenceSnapshotId: String(row.reference_snapshot_id),
    referenceManifestHash: String(row.reference_manifest_hash),
    retrievedAestheticHashes,
    identityReferenceHashes,
    outputEmbeddingDigest: String(row.output_embedding_digest),
    antiCopyPolicyVersion: String(row.anti_copy_policy_version),
    antiCopyThreshold: Number(row.anti_copy_threshold),
    fixedReferenceSnapshotId: String(row.fixed_reference_snapshot_id),
    fixedReferenceManifestHash: String(row.fixed_reference_manifest_hash),
    fixedReferenceHashes,
    fixedReferenceEmbeddingDigests,
  };
}
