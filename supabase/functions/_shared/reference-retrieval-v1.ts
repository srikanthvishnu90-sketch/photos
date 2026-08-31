// reference-retrieval-v1 — R15/R16 of the Reference Protocol.
//
// Replaces `environmentRef % candidates.length`. A modulo is not a choice: it
// makes the reference a function of the batch slot index, so the same request
// lands on a different photograph the moment one file is added to the pack, and
// two adjacent slots land on two adjacent files — which, in a library imported
// from one shoot, are usually the same place from two steps away. That is the
// batch flow's worst failure mode: six scenes conditioned on six near-duplicate
// references produce six near-duplicate images.
//
// R15 — selection is a two-stage retrieval. Stage one is TEXT->IMAGE: the
// request text shortlists the pack by what the user actually asked for. Stage
// two is IMAGE->IMAGE: a visual encoder ranks that shortlist by measured
// quality and coherence with the pack's centre. Text finds the candidates;
// visual features choose among them.
//
// R16 — a batch draws DIVERSE references, enforced by maximal marginal
// relevance, not sampled and hoped.
//
// R18 — retrieval failure degrades to the NO-REFERENCE path, never to a random
// photograph: a wrong reference is worse than none, because the model will
// faithfully reproduce the wrong location.
//
// This module is deliberately PURE — no fetch, no Supabase client, no Deno
// globals — so the maths is testable in node (tool/retrieval-eval.mjs) and so
// the caller owns every billable call and every rights check. It also never
// throws. A thrown error inside reference selection would take down a
// generation that could have proceeded without a reference at all, so bad input
// is dropped and reported through the returned `notes`, not raised.
//
// ---------------------------------------------------------------------------
// DATABASE STATE (measured 2026-08-30 against project hkwkxacvcgorhthwyslx)
// ---------------------------------------------------------------------------
// public.inspiration_assets holds 955 global rows and has columns:
//   id, profile_id, storage_path, label, source, created_at, mime_type,
//   byte_size, style_pack_id, shot_spec, shot_spec_version, is_ai_render,
//   eligible, quality_score
// There is NO embedding column, and `pgvector` is NOT installed. Today every
// row has shot_spec = null and quality_score = null, so retrieval runs in its
// degraded ORDERED_SPREAD mode until an indexing pass fills those in. That is
// the normal state, not an error state, and it is handled explicitly below.
//
// To reach the full two-stage path this SQL is required (NOT applied by this
// module — hand it to the owner; note the repo rule that migrations are applied
// live via the Management API, never `supabase db push`):
//
//   create extension if not exists vector with schema extensions;
//
//   alter table public.inspiration_assets
//     add column if not exists text_embedding extensions.vector(768),
//     add column if not exists visual_embedding extensions.vector(768),
//     add column if not exists embedding_model text,
//     add column if not exists embedded_at timestamptz;
//
//   -- Partial index: only the global, still-eligible library is ever queried
//   -- for scene conditioning, and that is ~955 rows out of a table that will
//   -- grow with per-user uploads.
//   create index if not exists inspiration_assets_text_embedding_hnsw
//     on public.inspiration_assets
//     using hnsw (text_embedding extensions.vector_cosine_ops)
//     where profile_id is null and eligible and not is_ai_render;
//
//   create index if not exists inspiration_assets_pack_lookup
//     on public.inspiration_assets (style_pack_id, storage_path)
//     where profile_id is null and eligible and not is_ai_render;
//
// Until pgvector exists, embeddings can also be carried in the existing
// `shot_spec` jsonb (no DDL at all) and passed to this module as plain arrays;
// the ranking maths is identical either way. That is the cheaper first step,
// because a 955-row pack is small enough to rank in memory — an HNSW index only
// starts paying for itself when the library reaches tens of thousands.

export const REFERENCE_RETRIEVAL_VERSION = "reference-retrieval-v1" as const;

/** Balance point between relevance and spread. Tuned for k=6 batch flows. */
export const DEFAULT_MMR_LAMBDA = 0.7 as const;

/** Dimensionality of the hashed lexical space used when no encoder has run. */
export const LEXICAL_FEATURE_DIMENSIONS = 96 as const;

/** Assumed quality of a reference nothing has measured yet (R14 is unrun). */
export const NEUTRAL_QUALITY_SCORE = 0.5 as const;

/**
 * A partially-embedded library is the expected mid-backfill state. Below this
 * many embedded rows we rank the WHOLE pack by metadata instead of ranking the
 * embedded sliver: a handful of embedded photos would otherwise monopolise
 * every batch simply for having been indexed first.
 */
export const MIN_EMBEDDED_POOL_SIZE = 8 as const;

export type ReferenceVector = readonly number[];

export type ReferenceCandidateV1 = Readonly<{
  /** Stable identity. Use the asset UUID; fall back to storage_path. */
  id: string;
  storagePath: string;
  stylePackId?: string | null;
  label?: string | null;
  /** R14 measured quality in [0,1]. Null means unmeasured, not bad. */
  qualityScore?: number | null;
  /** Doc-side vector in the TEXT->IMAGE space (SigLIP/CLIP class). */
  textEmbedding?: ReferenceVector | null;
  /** Visual vector in the IMAGE->IMAGE space (DINOv2 class). */
  visualEmbedding?: ReferenceVector | null;
  /** R19 measured shot spec; its text is folded into the lexical fallback. */
  shotSpec?: Readonly<Record<string, unknown>> | null;
}>;

export type RetrievalRequest = Readonly<{
  /** What the user actually asked for. May be empty. */
  text: string;
  stylePackId?: string | null;
  /** Query-side vector in the SAME space as candidate.textEmbedding. */
  queryEmbedding?: ReferenceVector | null;
  /**
   * Extra determinism key. It settles TIE-BREAKS and the ordered-spread offset,
   * so it moves the result only where the ranking itself is indifferent. It is
   * deliberately not a re-roll: retrieval is a function of the query, and a seed
   * that perturbed relevance would be the modulo problem wearing a hat. To get
   * genuinely different places on a retry, exclude what was already used
   * (`RetrievalOptions.exclude`) rather than reseeding.
   */
  seed?: string | null;
}>;

/**
 * How the selection was actually made. `orderedSpread` is not a failure: it is
 * the honest degrade when nothing has been encoded yet.
 */
export type RetrievalMode =
  | "two_stage"
  | "text_only"
  | "visual_only"
  | "ordered_spread"
  | "none";

export type RankedReference = Readonly<{
  candidate: ReferenceCandidateV1;
  /** Stage one, TEXT->IMAGE affinity, mapped to [0,1]. */
  textScore: number;
  /** Stage two, quality + coherence with the pack's centre, in [0,1]. */
  visualScore: number;
  /** Weighted combination the shortlist is ordered by. */
  score: number;
  /** 1-based position after ranking, before MMR. */
  rank: number;
  /** Unit vector MMR measures redundancy in. All picks share one space. */
  features: ReferenceVector;
}>;

export type ReferenceSelection = Readonly<{
  version: typeof REFERENCE_RETRIEVAL_VERSION;
  mode: RetrievalMode;
  /** True whenever the full two-stage path could not run end to end. */
  degraded: boolean;
  picks: readonly RankedReference[];
  /** Mean pairwise cosine of the picks. Lower is more diverse. */
  diversity: number;
  /** Machine-readable explanations; safe to log, never user-facing. */
  notes: readonly string[];
}>;

export type RetrievalOptions = Readonly<{
  /** How many references the batch needs. One per scene. */
  count?: number;
  lambda?: number;
  /** Shortlist size handed to stage two. Defaults to 4x count, min 12. */
  shortlistSize?: number;
  /** Weight on stage one vs stage two in the combined score. */
  textWeight?: number;
  visualWeight?: number;
  /** Split of stage two between measured quality and pack coherence. */
  qualityWeight?: number;
  coherenceWeight?: number;
  minEmbeddedPoolSize?: number;
  /**
   * Reference ids or storage paths already used — a previous batch, or the
   * scenes the user just asked to redo. This is the supported way to get
   * different places without breaking reproducibility: the query is unchanged,
   * the pool is smaller, so the answer is still a deterministic function of the
   * request plus what the user has already seen.
   */
  exclude?: readonly string[];
}>;

// ---------------------------------------------------------------------------
// Pure vector maths. Non-throwing by contract (see the header): a malformed
// vector scores 0 rather than aborting a generation.
// ---------------------------------------------------------------------------

function isFiniteVector(value: unknown): value is ReferenceVector {
  return Array.isArray(value) && value.length > 0 &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

export function l2Normalize(vector: ReferenceVector): ReferenceVector {
  let squared = 0;
  for (const entry of vector) squared += entry * entry;
  const norm = Math.sqrt(squared);
  // A zero vector has no direction. Returning it unchanged keeps cosine at 0,
  // which reads as "no signal" rather than as a spurious perfect match.
  if (!Number.isFinite(norm) || norm <= 0) return Object.freeze([...vector]);
  return Object.freeze(vector.map((entry) => entry / norm));
}

export function cosineSimilarity(a: ReferenceVector, b: ReferenceVector): number {
  if (!isFiniteVector(a) || !isFiniteVector(b) || a.length !== b.length) return 0;
  let dot = 0;
  let aSquared = 0;
  let bSquared = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aSquared += a[i] * a[i];
    bSquared += b[i] * b[i];
  }
  if (aSquared <= 0 || bSquared <= 0) return 0;
  const value = dot / Math.sqrt(aSquared * bSquared);
  return Math.max(-1, Math.min(1, value));
}

export function meanVector(vectors: readonly ReferenceVector[]): ReferenceVector {
  const usable = vectors.filter(isFiniteVector);
  if (!usable.length) return Object.freeze([]);
  const dimensions = usable[0].length;
  const sum = new Array<number>(dimensions).fill(0);
  let counted = 0;
  for (const vector of usable) {
    if (vector.length !== dimensions) continue;
    for (let i = 0; i < dimensions; i++) sum[i] += vector[i];
    counted++;
  }
  if (!counted) return Object.freeze([]);
  return l2Normalize(sum.map((entry) => entry / counted));
}

/**
 * Mean pairwise cosine of a set. This is the number the batch is actually
 * judged on: it is what "six near-duplicate references" measures as.
 */
export function meanPairwiseSimilarity(vectors: readonly ReferenceVector[]): number {
  if (vectors.length < 2) return 0;
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      total += cosineSimilarity(vectors[i], vectors[j]);
      pairs++;
    }
  }
  return pairs ? total / pairs : 0;
}

// ---------------------------------------------------------------------------
// Determinism. Nothing in this module reads Math.random or a clock.
// ---------------------------------------------------------------------------

/** FNV-1a, 32-bit. Small, dependency-free, and stable across runtimes. */
export function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Tie-break key. Hashing the seed WITH the id, rather than comparing ids
 * directly, matters: a raw id sort would hand every tie to whichever file sorts
 * first, so `1.jpg` would win every tie in every pack forever. The hash spreads
 * ties across the library while staying exactly reproducible for one request.
 */
export function deterministicTieBreak(seed: string, id: string): number {
  return stableHash(`${seed} ${id}`);
}

export function requestSeed(request: RetrievalRequest): string {
  const text = String(request.text ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return [
    REFERENCE_RETRIEVAL_VERSION,
    request.stylePackId ?? "",
    text,
    request.seed ?? "",
  ].join(" ");
}

// ---------------------------------------------------------------------------
// Lexical fallback space. Used when no encoder has run against the library.
// ---------------------------------------------------------------------------

// Tokens that appear on nearly every asset carry no discriminating signal, and
// leaving them in makes every candidate look similar to every other one — which
// would quietly defeat MMR by flattening all the redundancy scores together.
const STOP_TOKENS = new Set([
  "jpg", "jpeg", "png", "webp", "img", "image", "photo", "pic", "global",
  "packs", "pack", "ref", "refs", "reference", "final", "copy", "edit", "the",
  "and", "with", "for", "from", "this", "that", "shot", "dsc", "screenshot",
]);

export function lexicalTokens(value: string): readonly string[] {
  return String(value ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) =>
      token.length >= 3 && token.length <= 32 &&
      !/^\d+$/.test(token) && !STOP_TOKENS.has(token)
    );
}

/**
 * Hashed bag-of-tokens. A hashing trick rather than a learned vocabulary
 * because there is no vocabulary to learn from: the library is 955 files whose
 * names are mostly numbers.
 */
export function lexicalFeatureVector(
  value: string,
  dimensions: number = LEXICAL_FEATURE_DIMENSIONS,
): ReferenceVector {
  const bins = new Array<number>(dimensions).fill(0);
  for (const token of lexicalTokens(value)) {
    bins[stableHash(token) % dimensions] += 1;
  }
  return l2Normalize(bins);
}

/** Everything textual we actually know about one reference, concatenated. */
function candidateText(candidate: ReferenceCandidateV1): string {
  const parts = [candidate.storagePath, candidate.label ?? "", candidate.stylePackId ?? ""];
  if (candidate.shotSpec && typeof candidate.shotSpec === "object") {
    // The R19 shot spec is measurements, not prose, but its enum values
    // ("golden-hour", "locker-room", "hard") are exactly the words a user types.
    parts.push(collectSpecStrings(candidate.shotSpec, 0).join(" "));
  }
  return parts.join(" ");
}

function collectSpecStrings(value: unknown, depth: number): string[] {
  if (depth > 4) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((entry) => collectSpecStrings(entry, depth + 1));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .flatMap(([key, entry]) => [key, ...collectSpecStrings(entry, depth + 1)]);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Stage one + stage two ranking.
// ---------------------------------------------------------------------------

function validCandidates(
  candidates: readonly ReferenceCandidateV1[],
): ReferenceCandidateV1[] {
  const seen = new Set<string>();
  const usable: ReferenceCandidateV1[] = [];
  for (const candidate of candidates ?? []) {
    if (!candidate || typeof candidate !== "object") continue;
    const id = typeof candidate.id === "string" && candidate.id
      ? candidate.id
      : String(candidate.storagePath ?? "");
    if (!id || seen.has(id)) continue;
    if (typeof candidate.storagePath !== "string" || !candidate.storagePath) continue;
    seen.add(id);
    usable.push(candidate.id === id ? candidate : { ...candidate, id });
  }
  return usable;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** Cosine lives in [-1,1]; scores and MMR weights want [0,1]. */
function unitFromCosine(value: number): number {
  return clamp01((value + 1) / 2);
}

function normalizedPair(first: number, second: number): [number, number] {
  const a = Number.isFinite(first) ? Math.max(0, first) : 0;
  const b = Number.isFinite(second) ? Math.max(0, second) : 0;
  const total = a + b;
  if (total <= 0) return [0.5, 0.5];
  return [a / total, b / total];
}

type FeatureSpace = Readonly<{
  kind: "visual" | "text" | "lexical";
  vectors: ReadonlyMap<string, ReferenceVector>;
}>;

/**
 * Pick ONE space for the whole call. Cosines are only meaningful inside a
 * single space, so a mixed set (some rows DINOv2-encoded, some filename-hashed)
 * would produce redundancy numbers that mean nothing — the exact failure MMR is
 * supposed to prevent.
 */
function resolveFeatureSpace(
  candidates: readonly ReferenceCandidateV1[],
  minPool: number,
): FeatureSpace {
  for (const kind of ["visual", "text"] as const) {
    const vectors = new Map<string, ReferenceVector>();
    let dimensions = 0;
    for (const candidate of candidates) {
      const raw = kind === "visual" ? candidate.visualEmbedding : candidate.textEmbedding;
      if (!isFiniteVector(raw)) continue;
      if (!dimensions) dimensions = raw.length;
      if (raw.length !== dimensions) continue;
      vectors.set(candidate.id, l2Normalize(raw));
    }
    // Either the whole pack is encoded, or enough of it that ranking the
    // encoded subset is better than ignoring the encoder entirely.
    if (vectors.size === candidates.length || vectors.size >= minPool) {
      if (vectors.size > 0) return { kind, vectors };
    }
  }
  const vectors = new Map<string, ReferenceVector>();
  for (const candidate of candidates) {
    vectors.set(candidate.id, lexicalFeatureVector(candidateText(candidate)));
  }
  return { kind: "lexical", vectors };
}

/**
 * Stage one and stage two, in order. Returns every candidate the chosen feature
 * space covers, ranked. Callers normally want `selectReferences` instead.
 */
export function rankReferences(
  request: RetrievalRequest,
  candidates: readonly ReferenceCandidateV1[],
  options: RetrievalOptions = {},
): readonly RankedReference[] {
  const usable = validCandidates(candidates);
  if (!usable.length) return Object.freeze([]);

  const minPool = options.minEmbeddedPoolSize ?? MIN_EMBEDDED_POOL_SIZE;
  const space = resolveFeatureSpace(usable, minPool);
  const covered = usable.filter((candidate) => space.vectors.has(candidate.id));
  if (!covered.length) return Object.freeze([]);

  // Weights are normalised to sum to 1 so `score` always lands in [0,1]. That
  // is not cosmetic: MMR below subtracts a cosine redundancy from this score,
  // and the two terms have to live on the same scale or lambda stops meaning
  // anything.
  const [textWeight, visualWeight] = normalizedPair(
    options.textWeight ?? 0.6,
    options.visualWeight ?? 0.4,
  );
  const [qualityWeight, coherenceWeight] = normalizedPair(
    options.qualityWeight ?? 0.5,
    options.coherenceWeight ?? 0.5,
  );

  // STAGE ONE — TEXT->IMAGE. A real query vector is used when the caller has
  // one; otherwise the hashed lexical space stands in. When the request carries
  // no words at all, every candidate scores the same and stage two decides.
  const queryVector = isFiniteVector(request.queryEmbedding)
    ? l2Normalize(request.queryEmbedding)
    : lexicalFeatureVector(String(request.text ?? ""));

  // STAGE TWO — the pack's centre is a property of the PACK, computed over
  // every candidate rather than over the query-biased shortlist. Coherence with
  // it deliberately pulls toward the typical photo; MMR below pushes back out.
  // Lambda is where that trade is settled, and it is the only place it is.
  const centre = meanVector(covered.map((candidate) => space.vectors.get(candidate.id)!));

  const seed = requestSeed(request);
  const scored = covered.map((candidate) => {
    const features = space.vectors.get(candidate.id)!;
    const textVector = space.kind === "visual"
      // The visual space and the text space are different spaces; a text query
      // cannot be compared against DINOv2 features. Stage one falls back to the
      // lexical view of the candidate so the request text still counts.
      ? lexicalFeatureVector(candidateText(candidate))
      : features;
    const textReference = space.kind === "visual"
      ? lexicalFeatureVector(String(request.text ?? ""))
      : queryVector;
    const textScore = unitFromCosine(cosineSimilarity(textReference, textVector));
    const quality = typeof candidate.qualityScore === "number" &&
        Number.isFinite(candidate.qualityScore)
      ? clamp01(candidate.qualityScore)
      : NEUTRAL_QUALITY_SCORE;
    const coherence = centre.length ? unitFromCosine(cosineSimilarity(features, centre)) : 0.5;
    const visualScore = clamp01(qualityWeight * quality + coherenceWeight * coherence);
    return {
      candidate,
      features,
      textScore,
      visualScore,
      score: textWeight * textScore + visualWeight * visualScore,
      tieBreak: deterministicTieBreak(seed, candidate.id),
    };
  });

  scored.sort((left, right) =>
    right.score - left.score ||
    left.tieBreak - right.tieBreak ||
    left.candidate.id.localeCompare(right.candidate.id)
  );

  return Object.freeze(scored.map((entry, index) =>
    Object.freeze({
      candidate: entry.candidate,
      textScore: entry.textScore,
      visualScore: entry.visualScore,
      score: entry.score,
      rank: index + 1,
      features: entry.features,
    })
  ));
}

// ---------------------------------------------------------------------------
// R16 — maximal marginal relevance.
// ---------------------------------------------------------------------------

/**
 * Greedy MMR: repeatedly take the candidate maximising
 *   lambda * relevance - (1 - lambda) * max similarity to what is already taken.
 *
 * Relevance is the RAW ranking score, deliberately not rescaled. Min-max
 * rescaling a shortlist looks tidier but stretches whatever relevance spread
 * exists to the full [0,1] range, so the relevance term dominates the cosine
 * redundancy term and MMR quietly collapses back into top-N. Both terms are
 * already in [0,1] because `rankReferences` normalises its weights.
 *
 * When every score is equal the relevance term is constant and redundancy alone
 * decides — exactly right for a pack nothing has ranked yet.
 */
export function selectByMaximalMarginalRelevance(
  ranked: readonly RankedReference[],
  count: number,
  lambda: number = DEFAULT_MMR_LAMBDA,
  seed = "",
): readonly RankedReference[] {
  const target = Number.isFinite(count) ? Math.trunc(count) : 0;
  if (target <= 0 || !ranked.length) return Object.freeze([]);

  const weight = Number.isFinite(lambda) ? Math.max(0, Math.min(1, lambda)) : DEFAULT_MMR_LAMBDA;
  const relevance = ranked.map((entry) =>
    Number.isFinite(entry.score) ? Math.max(0, Math.min(1, entry.score)) : 0
  );

  const remaining = ranked.map((_, index) => index);
  const selected: RankedReference[] = [];
  const wanted = Math.min(target, ranked.length);

  while (selected.length < wanted && remaining.length) {
    let bestSlot = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    let bestTieBreak = Number.POSITIVE_INFINITY;

    for (let slot = 0; slot < remaining.length; slot++) {
      const index = remaining[slot];
      const entry = ranked[index];
      let redundancy = 0;
      for (const chosen of selected) {
        redundancy = Math.max(redundancy, cosineSimilarity(entry.features, chosen.features));
      }
      const value = weight * relevance[index] - (1 - weight) * redundancy;
      const tieBreak = deterministicTieBreak(seed, entry.candidate.id);
      // An explicit epsilon plus a hashed tie-break is what makes an all-
      // identical pack terminate deterministically instead of depending on the
      // sort's stability.
      if (
        value > bestScore + 1e-12 ||
        (Math.abs(value - bestScore) <= 1e-12 && tieBreak < bestTieBreak)
      ) {
        bestSlot = slot;
        bestScore = value;
        bestTieBreak = tieBreak;
      }
    }

    selected.push(ranked[remaining[bestSlot]]);
    remaining.splice(bestSlot, 1);
  }

  return Object.freeze(selected);
}

// ---------------------------------------------------------------------------
// Degraded path: deterministic ordered spread.
// ---------------------------------------------------------------------------

/**
 * What runs today. With no embeddings, no shot specs and numeric filenames
 * there is genuinely no signal to rank on, so pretending otherwise would be
 * theatre. This preserves the current ordered behaviour and fixes only the part
 * that is provably wrong: it walks the pack in even STRIDES instead of taking
 * consecutive indices, because consecutively-named files come from the same
 * shoot and are the near-duplicates R16 exists to avoid. The starting offset is
 * derived from the request, so the same request always yields the same places.
 */
export function selectOrderedSpread(
  candidates: readonly ReferenceCandidateV1[],
  count: number,
  seed: string,
): readonly ReferenceCandidateV1[] {
  const usable = validCandidates(candidates);
  const target = Number.isFinite(count) ? Math.trunc(count) : 0;
  if (target <= 0 || !usable.length) return Object.freeze([]);

  const ordered = [...usable].sort((left, right) =>
    left.storagePath.localeCompare(right.storagePath) || left.id.localeCompare(right.id)
  );
  const wanted = Math.min(target, ordered.length);
  const stride = Math.max(1, Math.floor(ordered.length / wanted));
  const start = stableHash(seed) % ordered.length;

  const taken = new Set<number>();
  const picks: ReferenceCandidateV1[] = [];
  for (let i = 0; picks.length < wanted && i < ordered.length * 2; i++) {
    let index = (start + i * stride) % ordered.length;
    // Strides can collide once they wrap; advance rather than return a
    // duplicate, because a repeated reference is a repeated image.
    let guard = 0;
    while (taken.has(index) && guard < ordered.length) {
      index = (index + 1) % ordered.length;
      guard++;
    }
    if (taken.has(index)) break;
    taken.add(index);
    picks.push(ordered[index]);
  }
  return Object.freeze(picks);
}

// ---------------------------------------------------------------------------
// Composed entry point.
// ---------------------------------------------------------------------------

function rankedFromCandidates(
  candidates: readonly ReferenceCandidateV1[],
): readonly RankedReference[] {
  return Object.freeze(candidates.map((candidate, index) =>
    Object.freeze({
      candidate,
      textScore: 0,
      visualScore: NEUTRAL_QUALITY_SCORE,
      score: 0,
      rank: index + 1,
      features: lexicalFeatureVector(candidateText(candidate)),
    })
  ));
}

/**
 * The one function generate-scene should call. Never throws; an empty `picks`
 * is the R18 signal to take the NO-REFERENCE path.
 */
export function selectReferences(
  request: RetrievalRequest,
  candidates: readonly ReferenceCandidateV1[],
  options: RetrievalOptions = {},
): ReferenceSelection {
  const notes: string[] = [];
  const count = Number.isFinite(options.count) ? Math.trunc(options.count as number) : 1;
  const all = validCandidates(candidates);
  const excluded = new Set(options.exclude ?? []);
  const usable = excluded.size
    ? all.filter((candidate) =>
      !excluded.has(candidate.id) && !excluded.has(candidate.storagePath)
    )
    : all;
  const seed = requestSeed(request);

  if (count <= 0) {
    return frozenSelection("none", true, [], ["count_not_positive"]);
  }
  if (all.length && !usable.length) {
    // Everything the pack has to offer has already been used. Better to say so
    // than to hand back a photograph the user has explicitly moved past.
    return frozenSelection("none", true, [], ["all_candidates_excluded"]);
  }
  if (!usable.length) {
    // R18. The caller must generate with no reference rather than reach for
    // whatever photograph is nearest to hand.
    return frozenSelection("none", true, [], ["no_candidates"]);
  }
  if (all.length < candidates.length) notes.push("dropped_invalid_candidates");
  if (usable.length < all.length) notes.push("applied_exclusions");
  if (usable.length < count) notes.push("insufficient_candidates");

  const minPool = options.minEmbeddedPoolSize ?? MIN_EMBEDDED_POOL_SIZE;
  const space = resolveFeatureSpace(usable, minPool);
  const hasQueryVector = isFiniteVector(request.queryEmbedding);
  const hasRequestText = lexicalTokens(String(request.text ?? "")).length > 0;

  // Nothing encoded and nothing to read: the ordered spread is the honest
  // answer. Ranking hashed numeric filenames would be noise dressed as a score.
  if (space.kind === "lexical" && !hasQueryVector && !hasRequestText) {
    const spread = selectOrderedSpread(usable, count, seed);
    notes.push("no_text_signal", "no_embeddings");
    const ranked = rankedFromCandidates(spread);
    return frozenSelection("ordered_spread", true, ranked, notes);
  }
  if (space.kind === "lexical") {
    notes.push("no_embeddings");
    const anyLexicalSignal = usable.some((candidate) =>
      lexicalTokens(candidateText(candidate)).length > 0
    );
    if (!anyLexicalSignal) {
      const spread = selectOrderedSpread(usable, count, seed);
      notes.push("no_candidate_text");
      return frozenSelection("ordered_spread", true, rankedFromCandidates(spread), notes);
    }
  }

  const ranked = rankReferences(request, usable, options);
  if (!ranked.length) {
    return frozenSelection("none", true, [], [...notes, "ranking_produced_nothing"]);
  }
  if (ranked.length < usable.length) notes.push("partial_embedding_coverage");

  const shortlistSize = Math.max(
    count,
    options.shortlistSize ?? Math.max(12, count * 4),
  );
  const shortlist = ranked.slice(0, Math.min(shortlistSize, ranked.length));
  const picks = selectByMaximalMarginalRelevance(
    shortlist,
    count,
    options.lambda ?? DEFAULT_MMR_LAMBDA,
    seed,
  );

  const mode: RetrievalMode = space.kind === "visual"
    ? (hasQueryVector ? "two_stage" : "visual_only")
    : space.kind === "text"
    ? (hasQueryVector ? "two_stage" : "text_only")
    : "text_only";
  // Full two-stage needs both encoders. Anything less is a real retrieval, but
  // a degraded one, and the caller should be able to see that in its logs.
  const degraded = mode !== "two_stage" || notes.length > 0;

  return frozenSelection(mode, degraded, picks, notes);
}

function frozenSelection(
  mode: RetrievalMode,
  degraded: boolean,
  picks: readonly RankedReference[],
  notes: readonly string[],
): ReferenceSelection {
  return Object.freeze({
    version: REFERENCE_RETRIEVAL_VERSION,
    mode,
    degraded,
    picks: Object.freeze([...picks]),
    diversity: meanPairwiseSimilarity(picks.map((pick) => pick.features)),
    notes: Object.freeze([...notes]),
  });
}

/** R18 in one call: true when the caller must generate without a reference. */
export function shouldUseNoReferencePath(selection: ReferenceSelection): boolean {
  return !selection || !selection.picks.length;
}

// ---------------------------------------------------------------------------
// Row mapping. Pure, so it stays testable, but shaped for the live table.
// ---------------------------------------------------------------------------

/**
 * Maps one `inspiration_assets` row to a candidate, or null when the row must
 * not condition a generation. R13 — eligibility is DATA, not a filename regex.
 * Embedding columns are read opportunistically so this keeps working unchanged
 * once the SQL at the top of this file has been applied.
 */
export function referenceCandidateFromRow(
  row: Readonly<Record<string, unknown>> | null | undefined,
): ReferenceCandidateV1 | null {
  if (!row || typeof row !== "object") return null;
  const storagePath = typeof row.storage_path === "string" ? row.storage_path : "";
  if (!storagePath || !/\.(jpe?g|png|webp)$/i.test(storagePath)) return null;
  if (row.eligible === false || row.is_ai_render === true) return null;

  const id = typeof row.id === "string" && row.id ? row.id : storagePath;
  const quality = typeof row.quality_score === "number" && Number.isFinite(row.quality_score)
    ? row.quality_score
    : null;
  const shotSpec = row.shot_spec && typeof row.shot_spec === "object" && !Array.isArray(row.shot_spec)
    ? row.shot_spec as Record<string, unknown>
    : null;

  return Object.freeze({
    id,
    storagePath,
    stylePackId: typeof row.style_pack_id === "string" ? row.style_pack_id : null,
    label: typeof row.label === "string" ? row.label : null,
    qualityScore: quality,
    textEmbedding: parseEmbeddingColumn(row.text_embedding),
    visualEmbedding: parseEmbeddingColumn(row.visual_embedding),
    shotSpec,
  });
}

/**
 * pgvector arrives from PostgREST as the literal text `[0.1,0.2,...]`, and as a
 * plain array when the vector is carried in jsonb instead. Both are accepted so
 * the embeddings can ship in `shot_spec` before any DDL is applied.
 */
export function parseEmbeddingColumn(value: unknown): ReferenceVector | null {
  if (isFiniteVector(value)) return Object.freeze([...value]);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  const parsed = trimmed.slice(1, -1).split(",")
    .map((entry) => Number(entry.trim()));
  if (!parsed.length || parsed.some((entry) => !Number.isFinite(entry))) return null;
  return Object.freeze(parsed);
}
