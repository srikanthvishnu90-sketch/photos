import { base64EncodeBytes } from "./gemini-embedding-rest-v1.ts";
import type { RpcInvoker } from "./reference-index-state-client-v1.ts";
import type { RetrievedConditioningReference } from "./reference-retriever-v1.ts";
import {
  buildSceneReferenceSnapshotPlan,
  recordSceneReferenceSnapshot,
} from "./scene-reference-snapshot-v1.ts";
import { ledgeredRetrievalQueryEmbedding } from "./scene-embedding-call-client-v1.ts";
import { retrieveSceneReferencesFromSupabase } from "./supabase-reference-retriever-v1.ts";

export interface PreparedSceneReferenceConditioning {
  parts: Array<Record<string, unknown>>;
  instruction: string;
  references: readonly RetrievedConditioningReference[];
  snapshotId: string;
  manifestHash: string;
  aestheticReferenceHashes: readonly string[];
  promptHash: string;
  embeddingInputHash: string;
}

/**
 * Performs the complete pre-provider retrieval boundary: ledger query
 * embedding, rights-filtered MMR, hash-verified one-time downloads, immutable
 * selection snapshot, then provider-ready image parts.
 */
export async function prepareSceneReferenceConditioning(
  input: {
    supabase: Parameters<typeof retrieveSceneReferencesFromSupabase>[0]["supabase"];
    rpc: RpcInvoker;
    apiKey: string;
    jobId: string;
    profileId: string;
    attemptId: string;
    leaseToken: string;
    candidateIndex: 0 | 1;
    prompt: string;
    stylePackId: string | null;
    excludedConditioningHashes?: readonly string[];
    signal?: AbortSignal;
  },
): Promise<PreparedSceneReferenceConditioning> {
  const promptEmbedding = await ledgeredRetrievalQueryEmbedding(input.rpc, {
    apiKey: input.apiKey,
    jobId: input.jobId,
    profileId: input.profileId,
    attemptId: input.attemptId,
    leaseToken: input.leaseToken,
    embeddingCallId: crypto.randomUUID(),
    prompt: input.prompt,
    signal: input.signal,
  });
  const retrieval = await retrieveSceneReferencesFromSupabase({
    supabase: input.supabase,
    profileId: input.profileId,
    prompt: input.prompt,
    stylePackId: input.stylePackId,
    excludedConditioningHashes: input.excludedConditioningHashes,
    promptEmbedding,
  });
  const plan = buildSceneReferenceSnapshotPlan({
    retrieval,
    stylePackId: input.stylePackId,
    attachedReferences: retrieval.references.map((reference, index) => ({
      kind: "retrieved_style",
      sha256: reference.selected.conditioningSha256,
      assetId: reference.selected.assetId,
      attachmentIndex: index,
    })),
  });
  const snapshot = await recordSceneReferenceSnapshot(input.rpc, {
    jobId: input.jobId,
    profileId: input.profileId,
    attemptId: input.attemptId,
    leaseToken: input.leaseToken,
    candidateIndex: input.candidateIndex,
    stylePackId: input.stylePackId,
    plan,
  });

  return {
    parts: [
      {
        text: "REFERENCE ROLE — PHOTOGRAPHIC CHARACTER: the next three images define only light, grade, framing habits, texture, and everyday imperfection; never copy their content.",
      },
      ...retrieval.references.map((reference) => ({
        inlineData: {
          mimeType: reference.image.mimeType,
          data: base64EncodeBytes(reference.image.bytes),
        },
      })),
    ],
    instruction: plan.conditioningInstruction,
    references: retrieval.references,
    snapshotId: snapshot.snapshotId,
    manifestHash: snapshot.manifestHash,
    aestheticReferenceHashes: plan.aestheticReferenceHashes,
    promptHash: plan.promptHash,
    embeddingInputHash: plan.embeddingInputHash,
  };
}
