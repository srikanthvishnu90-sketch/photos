/**
 * Retrieval policy shared by reference indexing and scene generation.
 *
 * This module is deliberately provider- and database-agnostic. The database
 * must apply ownership/rights filters before returning candidates; this code
 * treats a missing rights proof, incompatible embedding, duplicate payload,
 * or undersized result as a hard failure rather than weakening the query.
 */

export const REFERENCE_RETRIEVAL_POLICY_VERSION =
  "reference-retrieval-v1" as const;
export const REFERENCE_RETRIEVAL_MODEL = "gemini-embedding-2" as const;
export const REFERENCE_RETRIEVAL_DIMENSIONS = 768 as const;
export const REFERENCE_RETRIEVAL_POOL_SIZE = 12 as const;
export const REFERENCE_RETRIEVAL_COUNT = 3 as const;
export const REFERENCE_MMR_LAMBDA = 0.72 as const;
export const REFERENCE_RELEVANCE_FLOOR = 0.2 as const;

export type ConditioningRights = "owned" | "licensed";
export type ReferenceSource = "style_pack" | "user_upload";

export interface RetrievalCandidate {
  assetId: string;
  bucket: string;
  storagePath: string;
  source: ReferenceSource;
  stylePackId: string | null;
  description: string;
  gradeNotes: string;
  tags: readonly string[];
  rights: ConditioningRights;
  usableForConditioning: true;
  contentSha256: string;
  conditioningSha256: string;
  embeddingModel: typeof REFERENCE_RETRIEVAL_MODEL;
  indexingVersion: string;
  relevance: number;
  visualEmbedding: readonly number[];
  /** Lower values are selected first. This is server-computed, never caller supplied. */
  sourcePriority: number;
}

export interface SelectedReference extends RetrievalCandidate {
  mmrScore: number;
  selectionRank: number;
  maximumRedundancy: number;
}

export class ReferenceRetrievalError extends Error {
  constructor(
    readonly code:
      | "invalid_candidate"
      | "incompatible_embedding"
      | "insufficient_references",
    message: string,
  ) {
    super(message);
    this.name = "ReferenceRetrievalError";
  }
}

function finiteUnitInterval(value: number): boolean {
  return Number.isFinite(value) && value >= -1 && value <= 1;
}

function assertSha256(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new ReferenceRetrievalError(
      "invalid_candidate",
      `${field} must be a lowercase SHA-256 digest`,
    );
  }
}

function normalizedVector(vector: readonly number[]): number[] {
  if (vector.length !== REFERENCE_RETRIEVAL_DIMENSIONS) {
    throw new ReferenceRetrievalError(
      "incompatible_embedding",
      `expected ${REFERENCE_RETRIEVAL_DIMENSIONS} embedding dimensions`,
    );
  }

  let magnitudeSquared = 0;
  const copy = new Array<number>(vector.length);
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index];
    if (!Number.isFinite(value)) {
      throw new ReferenceRetrievalError(
        "incompatible_embedding",
        "embedding contains a non-finite component",
      );
    }
    copy[index] = value;
    magnitudeSquared += value * value;
  }

  if (!Number.isFinite(magnitudeSquared) || magnitudeSquared <= 1e-18) {
    throw new ReferenceRetrievalError(
      "incompatible_embedding",
      "embedding magnitude is zero",
    );
  }

  const magnitude = Math.sqrt(magnitudeSquared);
  return copy.map((value) => value / magnitude);
}

export function cosineSimilarity(
  left: readonly number[],
  right: readonly number[],
): number {
  const normalizedLeft = normalizedVector(left);
  const normalizedRight = normalizedVector(right);
  let dot = 0;
  for (let index = 0; index < normalizedLeft.length; index += 1) {
    dot += normalizedLeft[index] * normalizedRight[index];
  }
  return Math.max(-1, Math.min(1, dot));
}

function validateCandidate(candidate: RetrievalCandidate): void {
  if (
    !candidate.assetId ||
    !candidate.bucket ||
    !candidate.storagePath ||
    !candidate.description ||
    !candidate.indexingVersion
  ) {
    throw new ReferenceRetrievalError(
      "invalid_candidate",
      "reference metadata is incomplete",
    );
  }
  if (
    candidate.rights !== "owned" &&
    candidate.rights !== "licensed"
  ) {
    throw new ReferenceRetrievalError(
      "invalid_candidate",
      "reference has no conditioning rights",
    );
  }
  if (candidate.usableForConditioning !== true) {
    throw new ReferenceRetrievalError(
      "invalid_candidate",
      "reference is disabled for conditioning",
    );
  }
  if (candidate.embeddingModel !== REFERENCE_RETRIEVAL_MODEL) {
    throw new ReferenceRetrievalError(
      "incompatible_embedding",
      "reference embedding model does not match retrieval model",
    );
  }
  if (!finiteUnitInterval(candidate.relevance)) {
    throw new ReferenceRetrievalError(
      "invalid_candidate",
      "reference relevance is outside cosine bounds",
    );
  }
  if (
    !Number.isSafeInteger(candidate.sourcePriority) ||
    candidate.sourcePriority < 0
  ) {
    throw new ReferenceRetrievalError(
      "invalid_candidate",
      "reference source priority is invalid",
    );
  }
  assertSha256(candidate.contentSha256, "contentSha256");
  assertSha256(candidate.conditioningSha256, "conditioningSha256");
  normalizedVector(candidate.visualEmbedding);
}

function stableCandidateOrder(
  left: RetrievalCandidate,
  right: RetrievalCandidate,
): number {
  return (
    left.sourcePriority - right.sourcePriority ||
    right.relevance - left.relevance ||
    left.conditioningSha256.localeCompare(right.conditioningSha256) ||
    left.assetId.localeCompare(right.assetId)
  );
}

/**
 * Greedy MMR with a lexicographic source tier. A selected style pack therefore
 * fills its available slots before global/user fallback references, while MMR
 * still prevents near-duplicates inside that tier.
 */
export function selectDiverseReferences(
  input: readonly RetrievalCandidate[],
  options: {
    k?: number;
    lambda?: number;
    relevanceFloor?: number;
  } = {},
): SelectedReference[] {
  const k = options.k ?? REFERENCE_RETRIEVAL_COUNT;
  const lambda = options.lambda ?? REFERENCE_MMR_LAMBDA;
  const relevanceFloor =
    options.relevanceFloor ?? REFERENCE_RELEVANCE_FLOOR;

  if (!Number.isSafeInteger(k) || k < 1 || k > REFERENCE_RETRIEVAL_COUNT) {
    throw new ReferenceRetrievalError(
      "invalid_candidate",
      `k must be between 1 and ${REFERENCE_RETRIEVAL_COUNT}`,
    );
  }
  if (!Number.isFinite(lambda) || lambda < 0.5 || lambda > 0.9) {
    throw new ReferenceRetrievalError(
      "invalid_candidate",
      "MMR lambda is outside the server policy range",
    );
  }
  if (!finiteUnitInterval(relevanceFloor)) {
    throw new ReferenceRetrievalError(
      "invalid_candidate",
      "relevance floor is outside cosine bounds",
    );
  }

  const seenAssetIds = new Set<string>();
  const seenStorageObjects = new Set<string>();
  const seenPayloadHashes = new Set<string>();
  const eligible: RetrievalCandidate[] = [];

  for (const candidate of input) {
    validateCandidate(candidate);
    if (candidate.relevance < relevanceFloor) continue;

    const objectKey = `${candidate.bucket}/${candidate.storagePath}`;
    if (
      seenAssetIds.has(candidate.assetId) ||
      seenStorageObjects.has(objectKey) ||
      seenPayloadHashes.has(candidate.conditioningSha256)
    ) {
      continue;
    }
    seenAssetIds.add(candidate.assetId);
    seenStorageObjects.add(objectKey);
    seenPayloadHashes.add(candidate.conditioningSha256);
    eligible.push(candidate);
  }

  if (eligible.length < k) {
    throw new ReferenceRetrievalError(
      "insufficient_references",
      `retrieval produced ${eligible.length} distinct references; ${k} required`,
    );
  }

  eligible.sort(stableCandidateOrder);
  const selected: SelectedReference[] = [];
  const remaining = new Set(eligible);

  while (selected.length < k) {
    const remainingCandidates = [...remaining];
    const activePriority = Math.min(
      ...remainingCandidates.map((candidate) => candidate.sourcePriority),
    );
    const activeTier = remainingCandidates.filter(
      (candidate) => candidate.sourcePriority === activePriority,
    );

    let best: RetrievalCandidate | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    let bestRedundancy = 0;

    for (const candidate of activeTier) {
      let maximumRedundancy = 0;
      if (selected.length > 0) {
        maximumRedundancy = Math.max(
          ...selected.map((prior) =>
            cosineSimilarity(
              candidate.visualEmbedding,
              prior.visualEmbedding,
            )
          ),
        );
      }
      const score =
        lambda * candidate.relevance -
        (1 - lambda) * maximumRedundancy;

      const replacesBest =
        score > bestScore + Number.EPSILON ||
        (Math.abs(score - bestScore) <= Number.EPSILON &&
          best !== null &&
          stableCandidateOrder(candidate, best) < 0);
      if (best === null || replacesBest) {
        best = candidate;
        bestScore = score;
        bestRedundancy = maximumRedundancy;
      }
    }

    if (best === null) {
      throw new ReferenceRetrievalError(
        "insufficient_references",
        "MMR could not select the required reference count",
      );
    }

    selected.push({
      ...best,
      mmrScore: bestScore,
      selectionRank: selected.length + 1,
      maximumRedundancy: bestRedundancy,
    });
    remaining.delete(best);
  }

  return selected;
}

export function canonicalReferenceManifest(
  references: readonly SelectedReference[],
): string {
  if (references.length !== REFERENCE_RETRIEVAL_COUNT) {
    throw new ReferenceRetrievalError(
      "insufficient_references",
      `exactly ${REFERENCE_RETRIEVAL_COUNT} references are required`,
    );
  }

  return JSON.stringify({
    policyVersion: REFERENCE_RETRIEVAL_POLICY_VERSION,
    model: REFERENCE_RETRIEVAL_MODEL,
    dimensions: REFERENCE_RETRIEVAL_DIMENSIONS,
    lambda: REFERENCE_MMR_LAMBDA,
    references: references.map((reference) => ({
      assetId: reference.assetId,
      source: reference.source,
      stylePackId: reference.stylePackId,
      conditioningSha256: reference.conditioningSha256,
      indexingVersion: reference.indexingVersion,
      selectionRank: reference.selectionRank,
      relevance: reference.relevance,
      maximumRedundancy: reference.maximumRedundancy,
    })),
  });
}
