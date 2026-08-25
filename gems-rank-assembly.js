// Deterministic set assembly for dumps — applied AFTER Pass B scoring.
// Code, not a model: the set is the product; twelve top scores that all look
// alike is a failure even though every individual pick was "right".
// (docs/rank-photos.md)

const DEFAULT_SLOTS = 12;
const DUPE_THRESHOLD = 0.6;

// ---- "Best photos" = a forced MIX of the founder's 4 types, not a score-sort.
//   1 group · 2 self-action (wide) · 3 self-scenery · 4 standout object.
// "of me" INCLUDES objects (they're your aesthetic). Further-from-camera already
// wins in Pass B scoring; here we guarantee variety across the four types.
const BEST_TYPE_ORDER = ["group", "self-action", "self-scenery", "object"];

// Classify a Pass-A description into a best-photo type. Uses the model's
// best_type when present (new field); otherwise derives it from the older
// fields so cached photos still bucket correctly. Pure.
export function bestTypeOf(passA = {}) {
  const bt = passA.best_type;
  if (typeof bt === "string" && bt) return bt;
  const t = passA.photo_type;
  const n = Number(passA.people_count ?? 0);
  const dist = passA.distance;
  const scale = Number(passA.subject_scale ?? 0);
  if (t === "screenshot" || t === "document" || t === "meme") return "utility";
  if (n >= 2) return "group";
  if (n === 1) {
    if (t === "action") return "self-action";
    if (dist === "wide" || scale >= 4) return "self-scenery";
    if (dist === "mid") return "self-action";
    return "portrait"; // tight single-person
  }
  if (["object", "scene", "art", "food"].includes(t)) return "object";
  return "utility";
}

/**
 * Reorder scored results into the forced 4-type "best photos" mix. Items are
 * { record, score } (record.derived.passA carries the type). Returns a new
 * array: the mix first (one of each available type, then the strongest of any
 * type), followed by everything else in score order. `includeObjects` = false
 * drops type 4 (used only if a caller ever wants people-only). Pure.
 */
export function assembleBestPhotos(
  results,
  { slots = DEFAULT_SLOTS, includeObjects = true, preferIds = null } = {},
) {
  const list = (Array.isArray(results) ? results : []).filter((r) => r?.record);
  const pref = preferIds instanceof Set && preferIds.size ? preferIds : null;
  const typed = list.map((r) => ({
    r,
    id: r.record.id,
    score: Number.isFinite(r.score) ? r.score : (r.record.metrics?.quality ?? 0),
    bt: bestTypeOf(r.record.derived?.passA ?? {}),
  }));
  // Sort by score, but when a preferred set is given ("best photos of ME"),
  // photos that are actually the user win within each type bucket — the mix
  // (incl. objects) is kept, just re-prioritized toward you as faces resolve.
  const eligible = typed
    .filter((x) => x.bt !== "utility" && (includeObjects || x.bt !== "object"))
    .sort((a, b) =>
      (pref ? (pref.has(b.id) ? 1 : 0) - (pref.has(a.id) ? 1 : 0) : 0) || b.score - a.score,
    );
  if (!eligible.length) return list;

  const used = new Set();
  const picked = [];
  // 1) Force one of each named type, in the founder's priority order.
  for (const type of BEST_TYPE_ORDER) {
    if (type === "object" && !includeObjects) continue;
    const hit = eligible.find((x) => !used.has(x.id) && x.bt === type);
    if (hit) { used.add(hit.id); picked.push(hit); }
  }
  // 2) Fill remaining slots by score, but don't let one type dominate the set:
  // cap any single type at ~40% until the others have had their turn.
  const cap = Math.max(2, Math.ceil(slots * 0.4));
  const count = {};
  picked.forEach((x) => { count[x.bt] = (count[x.bt] || 0) + 1; });
  const deferred = [];
  for (const x of eligible) {
    if (picked.length >= slots) break;
    if (used.has(x.id)) continue;
    if ((count[x.bt] || 0) >= cap) { deferred.push(x); continue; }
    used.add(x.id); picked.push(x); count[x.bt] = (count[x.bt] || 0) + 1;
  }
  // 3) Top up from deferred (over-cap) if still short.
  for (const x of deferred) {
    if (picked.length >= slots) break;
    if (used.has(x.id)) continue;
    used.add(x.id); picked.push(x);
  }
  // 4) Everything else (the long tail) in score order, then any utility last.
  const tail = typed
    .filter((x) => !used.has(x.id))
    .sort((a, b) => (a.bt === "utility") - (b.bt === "utility") || b.score - a.score);
  return [...picked.map((x) => x.r), ...tail.map((x) => x.r)];
}

// ---- Dating profile = 6 slots, each a photo TYPE that makes a strong profile.
// Each slot matches Pass-A signals for SELECTION from the library, and names a
// DATING_SHOTS recipe label (in gems-scenes.js) for GAP-FILLING by generation.
// Founder: "select + offer to fill gaps"; a mix of everything.
export const DATING_SLOTS = Object.freeze([
  { id: "face", label: "Clear face", recipe: "Golden-hour portrait",
    match: (p, bt) => bt === "portrait" || (Number(p.people_count ?? 0) === 1 && (p.distance === "close" || p.distance === "mid")) },
  { id: "fullbody", label: "Full-body / outfit", recipe: "Full-body outfit",
    match: (p, bt) => bt === "self-scenery" || (Number(p.people_count ?? 0) === 1 && (p.distance === "wide" || Number(p.subject_scale ?? 0) >= 4)) },
  { id: "social", label: "With friends", recipe: "Rooftop social",
    match: (p, bt) => bt === "group" || Number(p.people_count ?? 0) >= 2 },
  { id: "activity", label: "Doing something", recipe: "Driver's seat",
    match: (p, bt) => bt === "self-action" || p.photo_type === "action" },
  { id: "candid", label: "Candid personality", recipe: "Street candid",
    match: (p) => p.candid_or_posed === "candid" && Number(p.people_count ?? 0) === 1 },
  { id: "standout", label: "Standout / aesthetic", recipe: "Walking away",
    match: (p, bt) => bt === "object" || p.photo_type === "scene" || (Array.isArray(p.vibe_tags) && p.vibe_tags.length >= 3) },
]);

/**
 * Slot the user's scored photos into the 6 dating-profile slots. Prefers the
 * user's OWN photos (preferIds) for the solo slots; the social slot is a group;
 * the standout slot can be any aesthetic shot. Screenshots/docs/memes (utility)
 * are dropped. Returns { lineup: [{slot,label,recipe,record|null}], gaps: [id] }.
 * Pure. Input = [{ record, score }] (record.derived.passA carries the signals).
 */
export function assembleDatingProfile(results, { preferIds = null } = {}) {
  const list = (Array.isArray(results) ? results : []).filter((r) => r?.record);
  const pref = preferIds instanceof Set && preferIds.size ? preferIds : null;
  const typed = list
    .map((r) => {
      const p = r.record.derived?.passA ?? {};
      return {
        r,
        id: r.record.id,
        p,
        bt: bestTypeOf(p),
        score: Number.isFinite(r.score) ? r.score : (r.record.metrics?.quality ?? 0),
      };
    })
    .filter((x) => x.bt !== "utility"); // never a screenshot/doc/meme in a dating profile

  const used = new Set();
  const lineup = DATING_SLOTS.map((slot) => {
    // Solo slots prefer photos that are actually the user; social/standout don't.
    const wantMe = pref && slot.id !== "social" && slot.id !== "standout";
    const hit = typed
      .filter((x) => !used.has(x.id) && slot.match(x.p, x.bt))
      .sort((a, b) => {
        if (wantMe) {
          const d = (pref.has(b.id) ? 1 : 0) - (pref.has(a.id) ? 1 : 0);
          if (d) return d;
        }
        return b.score - a.score;
      })[0];
    if (hit) {
      used.add(hit.id);
      return { slot: slot.id, label: slot.label, recipe: slot.recipe, record: hit.r.record };
    }
    return { slot: slot.id, label: slot.label, recipe: slot.recipe, record: null };
  });

  const gaps = lineup.filter((s) => !s.record).map((s) => s.slot);
  return { lineup, gaps };
}

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
