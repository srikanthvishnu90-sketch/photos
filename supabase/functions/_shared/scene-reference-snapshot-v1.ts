import {
  buildReferenceConditioningInstruction,
  REFERENCE_CONDITIONING_PROMPT_VERSION,
} from "./reference-conditioning-prompt-v1.ts";
import type { ReferenceRetrievalSnapshot } from "./reference-retriever-v1.ts";
import {
  REFERENCE_RETRIEVAL_POLICY_VERSION,
} from "./reference-retrieval-policy-v1.ts";
import type { RpcInvoker } from "./reference-index-state-client-v1.ts";
import type { ConditioningReferenceKind } from "./scene-anti-copy-v1.ts";

export interface AttachedSceneReference {
  kind: ConditioningReferenceKind;
  sha256: string;
  /** Zero-based order inside the retrieval-conditioning image group. */
  attachmentIndex: number;
  assetId?: string | null;
}

export interface SceneReferenceSnapshotPlan {
  promptHash: string;
  embeddingInputHash: string;
  manifest: Record<string, unknown>;
  aestheticReferenceHashes: string[];
  identityReferenceHashes: string[];
  selectedAssetIds: string[];
  selectedConditioningHashes: string[];
  selectionEvidence: Record<string, unknown>[];
  conditioningInstruction: string;
}

function assertDigest(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("scene_reference_digest_invalid");
  }
}

export function buildSceneReferenceSnapshotPlan(input: {
  retrieval: ReferenceRetrievalSnapshot;
  attachedReferences: readonly AttachedSceneReference[];
  stylePackId: string | null;
}): SceneReferenceSnapshotPlan {
  if (input.retrieval.references.length !== 3) {
    throw new Error("scene_retrieval_reference_count_invalid");
  }
  const orderedAttachments = [...input.attachedReferences].sort(
    (left, right) => left.attachmentIndex - right.attachmentIndex,
  );
  if (
    orderedAttachments.length < 3 ||
    orderedAttachments.some(
      (reference, index) => reference.attachmentIndex !== index,
    )
  ) {
    throw new Error("scene_reference_attachment_order_invalid");
  }

  const allHashes = new Set<string>();
  for (const reference of orderedAttachments) {
    assertDigest(reference.sha256);
    if (allHashes.has(reference.sha256)) {
      throw new Error("scene_reference_bytes_duplicated");
    }
    allHashes.add(reference.sha256);
  }

  const selectedAssetIds = input.retrieval.references.map(
    (reference) => reference.selected.assetId,
  );
  const selectedConditioningHashes = input.retrieval.references.map(
    (reference) => reference.selected.conditioningSha256,
  );
  for (const sha256 of selectedConditioningHashes) {
    const attached = orderedAttachments.find(
      (reference) =>
        reference.kind === "retrieved_style" && reference.sha256 === sha256,
    );
    if (!attached) throw new Error("retrieved_reference_not_attached");
  }

  const aestheticReferenceHashes = orderedAttachments
    .filter((reference) => reference.kind !== "identity")
    .map((reference) => reference.sha256);
  const identityReferenceHashes = orderedAttachments
    .filter((reference) => reference.kind === "identity")
    .map((reference) => reference.sha256);
  const selectionEvidence = input.retrieval.references.map((reference) => ({
    assetId: reference.selected.assetId,
    conditioningSha256: reference.selected.conditioningSha256,
    source: reference.selected.source,
    stylePackId: reference.selected.stylePackId,
    rights: reference.selected.rights,
    indexingVersion: reference.selected.indexingVersion,
    selectionRank: reference.selected.selectionRank,
    relevance: reference.selected.relevance,
    mmrScore: reference.selected.mmrScore,
    maximumRedundancy: reference.selected.maximumRedundancy,
  }));
  const conditioningInstruction = buildReferenceConditioningInstruction(
    input.retrieval.references.map((reference) => ({
      selectionRank: reference.selected.selectionRank,
      gradeNotes: reference.selected.gradeNotes,
      description: reference.selected.description,
    })),
  );

  return {
    promptHash: input.retrieval.promptHash,
    embeddingInputHash: input.retrieval.embeddingInputHash,
    manifest: {
      retrievalPolicyVersion: REFERENCE_RETRIEVAL_POLICY_VERSION,
      conditioningPromptVersion: REFERENCE_CONDITIONING_PROMPT_VERSION,
      retrievalManifestSha256: input.retrieval.manifestSha256,
      stylePackId: input.stylePackId,
      references: orderedAttachments.map((reference) => ({
        attachmentIndex: reference.attachmentIndex,
        kind: reference.kind,
        sha256: reference.sha256,
        assetId: reference.assetId ?? null,
      })),
    },
    aestheticReferenceHashes,
    identityReferenceHashes,
    selectedAssetIds,
    selectedConditioningHashes,
    selectionEvidence,
    conditioningInstruction,
  };
}

function firstRow(value: unknown): Record<string, unknown> {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("scene_reference_snapshot_not_recorded");
  }
  return row as Record<string, unknown>;
}

export async function recordSceneReferenceSnapshot(
  rpc: RpcInvoker,
  input: {
    jobId: string;
    profileId: string;
    attemptId: string;
    leaseToken: string;
    candidateIndex: 0 | 1;
    stylePackId: string | null;
    plan: SceneReferenceSnapshotPlan;
  },
): Promise<{ snapshotId: string; manifestHash: string; replayed: boolean }> {
  const result = await rpc("record_scene_reference_snapshot", {
    p_job_id: input.jobId,
    p_profile_id: input.profileId,
    p_attempt_id: input.attemptId,
    p_lease_token: input.leaseToken,
    p_candidate_index: input.candidateIndex,
    p_prompt_hash: input.plan.promptHash,
    p_embedding_input_hash: input.plan.embeddingInputHash,
    p_style_pack_id: input.stylePackId,
    p_manifest: input.plan.manifest,
    p_aesthetic_reference_hashes: input.plan.aestheticReferenceHashes,
    p_identity_reference_hashes: input.plan.identityReferenceHashes,
    p_selected_asset_ids: input.plan.selectedAssetIds,
    p_selected_conditioning_hashes: input.plan.selectedConditioningHashes,
    p_selection_evidence: input.plan.selectionEvidence,
  });
  if (result.error) {
    throw new Error(`scene_reference_snapshot_failed:${result.error.message}`);
  }
  const row = firstRow(result.data);
  return {
    snapshotId: String(row.snapshot_id),
    manifestHash: String(row.manifest_hash),
    replayed: row.replayed === true,
  };
}
