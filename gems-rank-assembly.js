// Deterministic set assembly for dumps — applied AFTER Pass B scoring.
// Code, not a model: the set is the product; twelve top scores that all look
// alike is a failure even though every individual pick was "right".
// (docs/rank-photos.md)

const DEFAULT_SLOTS = 12;
const DUPE_THRESHOLD = 0.6;

// Phase-B upgrade point: replace with embedding cosine similarity. Until
// then, similarity = Jaccard overlap of vibe_tags plus content-word overlap.
export function descriptionSimilarity(a, b) {
  const tagsA = new Set(a.vibe_tags ?? []);
  const tagsB = new Set(b.vibe_tags ?? []);
  const tagUnion = new Set([...tagsA, ...tagsB]);
  const tagOverlap = tagUnion.size
    ? [...tagsA].filter((tag) => tagsB.has(tag)).length / tagUnion.size
    : 0;

  const words = (value) =>
    new Set(String(value ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  const wordsA = words(a.content);
  const wordsB = words(b.content);
  const wordUnion = new Set([...wordsA, ...wordsB]);
  const wordOverlap = wordUnion.size
    ? [...wordsA].filter((word) => wordsB.has(word)).length / wordUnion.size
    : 0;

  return 0.55 * tagOverlap + 0.45 * wordOverlap;
}

/**
 * @param {Array<{description: object, score: number, id?: string}>} scored
 *   Pass-B results joined with their Pass-A descriptions.
 * @param {{slots?: number, dupeThreshold?: number}} options
 * @returns {Array} the assembled set, slot order = presentation order.
 */
// Embedding cosine ≥ this = the same shot / burst frame (perceptual, not text).
const EMB_DUPE_THRESHOLD = 0.93;

// simLookup(idA, idB) -> cosine|null lets callers pass an on-device CLIP
// similarity function (gems-embeddings.similarityLookup) for true perceptual
// dedup; when absent or a pair isn't indexed, we fall back to caption overlap.
export function assembleDump(
  scored,
  { slots = DEFAULT_SLOTS, dupeThreshold = DUPE_THRESHOLD, simLookup = null } = {},
) {
  const pool = [...scored]
    .filter((item) => item?.description && Number.isFinite(item.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);
  if (!pool.length) return [];

  const picked = [];
  const isDupe = (candidate) =>
    picked.some((existing) => {
      if (simLookup && existing.id && candidate.id) {
        const sim = simLookup(existing.id, candidate.id);
        if (typeof sim === "number") return sim >= EMB_DUPE_THRESHOLD;
      }
      return descriptionSimilarity(existing.description, candidate.description) > dupeThreshold;
    });

  // Slot 1: highest-scoring cover.
  const coverIndex = pool.findIndex((item) =>
    (item.description.best_for ?? []).includes("cover"),
  );
  picked.push(pool.splice(coverIndex === -1 ? 0 : coverIndex, 1)[0]);

  const need = {
    candid: (item) => item.description.candid_or_posed === "candid",
    wide: (item) => item.description.distance === "wide",
    close: (item) => item.description.distance === "close",
  };

  // Reserve required variety early: best non-dupe candidate for each unmet
  // constraint, in score order.
  for (const check of Object.values(need)) {
    if (picked.length >= slots) break;
    if (picked.some(check)) continue;
    const index = pool.findIndex((item) => check(item) && !isDupe(item));
    if (index !== -1) picked.push(pool.splice(index, 1)[0]);
  }

  // Greedy fill by score, skipping near-duplicates; leave one slot open for
  // the closer.
  while (picked.length < slots - 1 && pool.length) {
    const index = pool.findIndex((item) => !isDupe(item));
    if (index === -1) break;
    picked.push(pool.splice(index, 1)[0]);
  }

  // Final slot: prefer expression >= 4, else a scenic close, else best rest.
  if (picked.length < slots && pool.length) {
    const closerIndex = pool.findIndex(
      (item) =>
        !isDupe(item) &&
        ((item.description.expression ?? 0) >= 4 || item.description.distance === "close"),
    );
    const fallback = pool.findIndex((item) => !isDupe(item));
    const index = closerIndex !== -1 ? closerIndex : fallback;
    if (index !== -1) picked.push(pool.splice(index, 1)[0]);
  }

  // Presentation order matters: if the set doesn't already end on a closer
  // but contains one (past the cover slot), move the best closer to the end.
  const isCloser = (item) =>
    (item.description.expression ?? 0) >= 4 || item.description.distance === "close";
  if (picked.length > 2 && !isCloser(picked.at(-1))) {
    const closerIndex = picked.findIndex((item, index) => index > 0 && isCloser(item));
    if (closerIndex !== -1) picked.push(picked.splice(closerIndex, 1)[0]);
  }

  return picked;
}
