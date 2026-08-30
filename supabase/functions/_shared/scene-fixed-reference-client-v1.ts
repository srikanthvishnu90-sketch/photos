import type { RpcInvoker } from "./reference-index-state-client-v1.ts";
import type {
  AntiCopyReference,
  ConditioningReferenceKind,
} from "./scene-anti-copy-v1.ts";
import {
  REFERENCE_RETRIEVAL_DIMENSIONS,
  REFERENCE_RETRIEVAL_MODEL,
} from "./reference-retrieval-policy-v1.ts";

export type FixedSceneReferenceKind = Exclude<
  ConditioningReferenceKind,
  "retrieved_style" | "identity"
>;

export interface FixedSceneAntiCopyReference extends AntiCopyReference {
  kind: FixedSceneReferenceKind;
  assetId: string;
  storageBucket: "inspiration-conditioning";
  storagePath: string;
  // Exact pgvector output text returned by PostgREST. This stays process-local;
  // only its SHA-256 is persisted, and SQL recomputes that digest from the
  // indexed row to prove which embedding was evaluated.
  embeddingEvidenceText: string;
  embeddingDigest: string;
  attachmentPlacement: "before_retrieval" | "after_retrieval";
  attachmentIndex: number;
}

export interface RecordedFixedSceneReferenceSnapshot {
  snapshotId: string;
  manifestHash: string;
  referenceHashes: readonly string[];
  embeddingDigests: readonly string[];
  replayed: boolean;
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseSceneVisualEmbedding(value: unknown): number[] {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("scene_fixed_reference_embedding_invalid");
    }
  }
  if (!Array.isArray(parsed)
    || parsed.length !== REFERENCE_RETRIEVAL_DIMENSIONS) {
    throw new Error("scene_fixed_reference_embedding_invalid");
  }
  const embedding = parsed.map(Number);
  if (embedding.some((component) => !Number.isFinite(component))) {
    throw new Error("scene_fixed_reference_embedding_invalid");
  }
  return embedding;
}

export async function digestSceneVisualEmbeddingEvidence(
  value: string,
): Promise<string> {
  if (!value || value.length > 65536) {
    throw new Error("scene_fixed_reference_embedding_invalid");
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function firstRow(data: unknown): Record<string, unknown> {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("scene_fixed_reference_snapshot_not_recorded");
  }
  return row as Record<string, unknown>;
}

export async function recordSceneFixedReferenceSnapshot(
  rpc: RpcInvoker,
  input: {
    jobId: string;
    profileId: string;
    attemptId: string;
    leaseToken: string;
    references: readonly FixedSceneAntiCopyReference[];
  },
): Promise<RecordedFixedSceneReferenceSnapshot> {
  if (input.references.length > 6) {
    throw new Error("scene_fixed_reference_count_invalid");
  }
  const hashes = new Set<string>();
  const evidence = await Promise.all(input.references.map(async (
    reference,
    index,
  ) => {
    if (!(["user_inspiration", "realism", "environment"] as const)
      .includes(reference.kind)) {
      throw new Error("scene_fixed_reference_kind_invalid");
    }
    const evidenceEmbedding = parseSceneVisualEmbedding(
      reference.embeddingEvidenceText,
    );
    if (!SHA256_RE.test(reference.sha256)
      || !SHA256_RE.test(reference.embeddingDigest)
      || hashes.has(reference.sha256)
      || reference.embeddingModel !== REFERENCE_RETRIEVAL_MODEL
      || reference.visualEmbedding.length !== REFERENCE_RETRIEVAL_DIMENSIONS
      || !evidenceEmbedding.every(
        (component, componentIndex) =>
          component === reference.visualEmbedding[componentIndex],
      )
      || await digestSceneVisualEmbeddingEvidence(
        reference.embeddingEvidenceText,
      )
        !== reference.embeddingDigest
      || !UUID_RE.test(reference.assetId)
      || reference.storageBucket !== "inspiration-conditioning"
      || !reference.storagePath
      || reference.storagePath.length > 1024
      || !["before_retrieval", "after_retrieval"].includes(
        reference.attachmentPlacement,
      )
      || reference.attachmentIndex !== index) {
      throw new Error("scene_fixed_reference_evidence_invalid");
    }
    hashes.add(reference.sha256);
    return {
      attachmentIndex: reference.attachmentIndex,
      attachmentPlacement: reference.attachmentPlacement,
      kind: reference.kind,
      sha256: reference.sha256,
      assetId: reference.assetId,
      storageBucket: reference.storageBucket,
      storagePath: reference.storagePath,
      embeddingModel: reference.embeddingModel,
      embeddingDigest: reference.embeddingDigest,
    };
  }));
  const referenceHashes = evidence.map((reference) => reference.sha256);
  const referenceKinds = evidence.map((reference) => reference.kind);
  const embeddingDigests = evidence.map(
    (reference) => reference.embeddingDigest,
  );
  const result = await rpc("record_scene_fixed_reference_snapshot", {
    p_job_id: input.jobId,
    p_profile_id: input.profileId,
    p_attempt_id: input.attemptId,
    p_lease_token: input.leaseToken,
    p_manifest: {
      schema: "scene-fixed-reference-v1",
      references: evidence,
    },
    p_reference_hashes: referenceHashes,
    p_reference_kinds: referenceKinds,
    p_embedding_digests: embeddingDigests,
  });
  if (result.error) {
    throw new Error(
      `scene_fixed_reference_snapshot_failed:${result.error.message}`,
    );
  }
  const row = firstRow(result.data);
  return {
    snapshotId: String(row.snapshot_id),
    manifestHash: String(row.manifest_hash),
    referenceHashes,
    embeddingDigests,
    replayed: row.replayed === true,
  };
}
