// Pure maximum-marginal-relevance selection for conditioning references.

export type ReferenceCandidate = Readonly<{
  id: string;
  queryDistance: number;
  visualEmbedding: readonly number[];
  packPriority?: number;
  [key: string]: unknown;
}>;

export function parsePgVector(value: unknown, dimensions = 768): readonly number[] {
  if (Array.isArray(value)) {
    const parsed = value.map(Number);
    if (parsed.length === dimensions && parsed.every(Number.isFinite)) return Object.freeze(parsed);
  }
  if (typeof value !== "string") throw new Error("vector_invalid");
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) throw new Error("vector_invalid");
  const parsed = trimmed.slice(1, -1).split(",").map((entry) => Number(entry.trim()));
  if (parsed.length !== dimensions || parsed.some((entry) => !Number.isFinite(entry))) {
    throw new Error("vector_invalid");
  }
  return Object.freeze(parsed);
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || !a.length) throw new Error("vector_dimensions_mismatch");
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aNorm += a[i] * a[i];
    bNorm += b[i] * b[i];
  }
  if (!aNorm || !bNorm) throw new Error("vector_norm_invalid");
  return dot / Math.sqrt(aNorm * bNorm);
}

export function selectDiverseReferences<T extends ReferenceCandidate>(
  candidates: readonly T[],
  k = 3,
  lambda = 0.72,
): readonly T[] {
  const remaining = [...candidates].filter((candidate) =>
    Number.isFinite(candidate.queryDistance) && Array.isArray(candidate.visualEmbedding)
  );
  if (!remaining.length || k <= 0) return Object.freeze([]);
  const target = Math.min(Math.trunc(k), remaining.length);
  const weight = Math.max(0, Math.min(1, lambda));
  const selected: T[] = [];

  while (selected.length < target && remaining.length) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      const relevance = 1 - candidate.queryDistance;
      const packBoost = candidate.packPriority === 0 ? 0.035 : 0;
      let redundancy = 0;
      for (const chosen of selected) {
        redundancy = Math.max(
          redundancy,
          cosineSimilarity(candidate.visualEmbedding, chosen.visualEmbedding),
        );
      }
      const score = weight * (relevance + packBoost) - (1 - weight) * redundancy;
      if (score > bestScore || (score === bestScore && candidate.id < remaining[bestIndex].id)) {
        bestScore = score;
        bestIndex = i;
      }
    }
    selected.push(remaining.splice(bestIndex, 1)[0]);
  }
  return Object.freeze(selected);
}
