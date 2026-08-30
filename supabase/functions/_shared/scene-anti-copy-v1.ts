import {
  cosineSimilarity,
  REFERENCE_RETRIEVAL_DIMENSIONS,
  REFERENCE_RETRIEVAL_MODEL,
} from "./reference-retrieval-policy-v1.ts";

export const SCENE_ANTI_COPY_POLICY_VERSION = "scene-anti-copy-v1" as const;
export const SCENE_ANTI_COPY_THRESHOLD = 0.95 as const;
export const SCENE_MAX_CANDIDATES = 2 as const;

export type ConditioningReferenceKind =
  | "retrieved_style"
  | "user_inspiration"
  | "realism"
  | "environment"
  | "identity";

export interface AntiCopyReference {
  kind: ConditioningReferenceKind;
  sha256: string;
  embeddingModel: typeof REFERENCE_RETRIEVAL_MODEL;
  visualEmbedding: readonly number[];
}

export interface AntiCopyDecision {
  policyVersion: typeof SCENE_ANTI_COPY_POLICY_VERSION;
  embeddingModel: typeof REFERENCE_RETRIEVAL_MODEL;
  dimensions: typeof REFERENCE_RETRIEVAL_DIMENSIONS;
  metric: "cosine";
  threshold: typeof SCENE_ANTI_COPY_THRESHOLD;
  rejected: boolean;
  maximumSimilarity: number;
  matchedReferenceKind: ConditioningReferenceKind;
  matchedReferenceSha256: string;
}

export class SceneAntiCopyError extends Error {
  constructor(
    readonly code:
      | "invalid_embedding"
      | "invalid_reference"
      | "reroll_manifest_reused",
    message: string,
  ) {
    super(message);
    this.name = "SceneAntiCopyError";
  }
}

export function exceedsAntiCopyThreshold(similarity: number): boolean {
  if (!Number.isFinite(similarity) || similarity < -1 || similarity > 1) {
    throw new SceneAntiCopyError(
      "invalid_embedding",
      "anti-copy similarity is outside cosine bounds",
    );
  }
  return similarity > SCENE_ANTI_COPY_THRESHOLD;
}

function assertDigest(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new SceneAntiCopyError(
      "invalid_reference",
      "reference SHA-256 digest is invalid",
    );
  }
}

export function evaluateSceneCandidateSimilarity(
  outputEmbedding: readonly number[],
  references: readonly AntiCopyReference[],
): AntiCopyDecision {
  if (outputEmbedding.length !== REFERENCE_RETRIEVAL_DIMENSIONS) {
    throw new SceneAntiCopyError(
      "invalid_embedding",
      "candidate embedding has the wrong dimensions",
    );
  }
  if (references.length === 0) {
    throw new SceneAntiCopyError(
      "invalid_reference",
      "anti-copy evaluation requires at least one attached reference",
    );
  }

  let maximumSimilarity = Number.NEGATIVE_INFINITY;
  let matched: AntiCopyReference | null = null;
  for (const reference of references) {
    assertDigest(reference.sha256);
    if (reference.embeddingModel !== REFERENCE_RETRIEVAL_MODEL) {
      throw new SceneAntiCopyError(
        "invalid_embedding",
        "reference and candidate embeddings use different models",
      );
    }
    const similarity = cosineSimilarity(
      outputEmbedding,
      reference.visualEmbedding,
    );
    if (
      matched === null ||
      similarity > maximumSimilarity + Number.EPSILON ||
      (Math.abs(similarity - maximumSimilarity) <= Number.EPSILON &&
        reference.sha256.localeCompare(matched.sha256) < 0)
    ) {
      matched = reference;
      maximumSimilarity = similarity;
    }
  }

  if (matched === null || !Number.isFinite(maximumSimilarity)) {
    throw new SceneAntiCopyError(
      "invalid_embedding",
      "anti-copy similarity could not be computed",
    );
  }

  return {
    policyVersion: SCENE_ANTI_COPY_POLICY_VERSION,
    embeddingModel: REFERENCE_RETRIEVAL_MODEL,
    dimensions: REFERENCE_RETRIEVAL_DIMENSIONS,
    metric: "cosine",
    threshold: SCENE_ANTI_COPY_THRESHOLD,
    // Deliberately strict: exactly 0.95 is accepted; only greater values reject.
    rejected: exceedsAntiCopyThreshold(maximumSimilarity),
    maximumSimilarity,
    matchedReferenceKind: matched.kind,
    matchedReferenceSha256: matched.sha256,
  };
}

export function candidateAction(
  candidateIndex: number,
  decision: AntiCopyDecision,
): "accept" | "reroll" | "reject_terminal" {
  if (!Number.isSafeInteger(candidateIndex) || candidateIndex < 0 || candidateIndex >= SCENE_MAX_CANDIDATES) {
    throw new SceneAntiCopyError(
      "invalid_reference",
      "candidate index is outside the anti-copy policy",
    );
  }
  if (!decision.rejected) return "accept";
  return candidateIndex === 0 ? "reroll" : "reject_terminal";
}

/**
 * A reroll may reuse identity inputs, because substituting a different person
 * would violate identity policy. All aesthetic/reference inputs must change,
 * and the single reference that triggered the guard must never be sent again.
 */
export function assertRerollReferencesChanged(
  firstManifestSha256: string,
  secondManifestSha256: string,
  firstReferences: readonly Pick<AntiCopyReference, "kind" | "sha256">[],
  secondReferences: readonly Pick<AntiCopyReference, "kind" | "sha256">[],
  rejectedReferenceSha256: string,
): void {
  assertDigest(firstManifestSha256);
  assertDigest(secondManifestSha256);
  assertDigest(rejectedReferenceSha256);
  if (firstManifestSha256 === secondManifestSha256) {
    throw new SceneAntiCopyError(
      "reroll_manifest_reused",
      "anti-copy reroll must use a different reference manifest",
    );
  }

  const firstAestheticHashes = new Set(
    firstReferences
      .filter((reference) => reference.kind !== "identity")
      .map((reference) => reference.sha256),
  );
  for (const reference of secondReferences) {
    assertDigest(reference.sha256);
    if (
      reference.kind !== "identity" &&
      (reference.sha256 === rejectedReferenceSha256 ||
        firstAestheticHashes.has(reference.sha256))
    ) {
      throw new SceneAntiCopyError(
        "reroll_manifest_reused",
        "anti-copy reroll reused an aesthetic reference",
      );
    }
  }
}

export function publicAntiCopyProvenance(
  decision: AntiCopyDecision,
  options: {
    acceptedCallId: string;
    acceptedCandidateIndex: number;
    rerollUsed: boolean;
    initialRejection?: {
      callId: string;
      maximumSimilarity: number;
      matchedReferenceKind: ConditioningReferenceKind;
      matchedReferenceSha256: string;
    };
  },
): Record<string, unknown> {
  return {
    policyVersion: decision.policyVersion,
    embeddingModel: decision.embeddingModel,
    metric: decision.metric,
    threshold: decision.threshold,
    acceptedCallId: options.acceptedCallId,
    acceptedCandidateIndex: options.acceptedCandidateIndex,
    acceptedMaximumSimilarity: decision.maximumSimilarity,
    matchedReferenceKind: decision.matchedReferenceKind,
    matchedReferenceSha256: decision.matchedReferenceSha256,
    rerollUsed: options.rerollUsed,
    ...(options.initialRejection
      ? { initialRejection: options.initialRejection }
      : {}),
  };
}
