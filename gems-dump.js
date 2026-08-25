// Make-me-a-photo-dump — the killer feature (docs/MASTER-FEATURES.md #10).
//
// Flow: a request + two visual answers (vibe, date range) → THREE complete
// options (clean / casual / editorial). Each option is DETERMINISTIC code over
// a single Pass B ranking: one rankPhotos() call feeds all three styles, and
// gems-rank-assembly.js turns each style's re-weighted scores into a
// variety-balanced SET (cover first, candid/wide/close quota, dedupe, a closer
// to end on). The SET is the product — twelve top scores that all look alike is
// a failure. Revision ("more friends", "replace slide six") is lightweight,
// deterministic, and never calls the model again.
//
// Nothing here ever throws: every failure degrades to an empty/unchanged
// result so the Studio dump flow never breaks. All browser APIs are reached
// only through the imported modules, which guard them, so importing this file
// in Node is safe.

import { listPhotos } from "./gems-photolib.js";
import { rankPhotos, ensureDescriptions } from "./gems-ranker.js";
import { assembleDump } from "./gems-rank-assembly.js";
import { similarityLookup } from "./gems-embeddings.js";
import { recordTasteEvent } from "./gems-supabase.js";

// The controlled vibe vocabulary (mirrors rank-photos/prompts.js). Used by the
// style tuners and by revision parsing.
export const VIBE_TAGS = Object.freeze([
  "dark-moody",
  "low-exposure",
  "flash-night",
  "warm-film",
  "golden-hour",
  "clean-bright",
  "editorial",
  "streetwear",
  "gym",
  "euro-summer",
  "candid-social",
  "luxury",
  "grain",
]);

const VIBE_SET = new Set(VIBE_TAGS);

// Build a deterministic score re-weighter for one style. It lightly biases the
// SAME Pass B ranking toward a style's aesthetic so the three options diverge
// instead of being three cuts of one ranking. Bounded, side-effect free.
function makeTune(favored, opts = {}) {
  const favoredSet = new Set(favored);
  const tagBonus = opts.tagBonus ?? 4;
  const clarityWeight = opts.clarityWeight ?? 0;
  const intentWeight = opts.intentWeight ?? 0;
  const coverBonus = opts.coverBonus ?? 0;
  return function tune(scored) {
    if (!Array.isArray(scored)) return [];
    return scored.map((item) => {
      const description = item?.description ?? {};
      const tags = Array.isArray(description.vibe_tags) ? description.vibe_tags : [];
      let bonus = 0;
      for (const tag of tags) {
        if (favoredSet.has(tag)) bonus += tagBonus;
      }
      if (clarityWeight) bonus += ((description.subject_clarity ?? 3) - 3) * clarityWeight;
      if (intentWeight) bonus += ((description.intentionality ?? 3) - 3) * intentWeight;
      if (coverBonus && Array.isArray(description.best_for) && description.best_for.includes("cover")) {
        bonus += coverBonus;
      }
      const base = Number.isFinite(item?.score) ? item.score : 0;
      return { ...item, score: base + bonus };
    });
  };
}

// Three complete presets. Same Pass B ranking, three different SETs:
//   clean     — fewer, crisp, high subject_clarity, stricter dedupe
//   casual    — the default: more slots, candid-social + warm-film, looser dedupe
//   editorial — tightest, cover-forward, dark-moody / editorial / high-intentionality
export const DUMP_STYLES = Object.freeze([
  Object.freeze({
    key: "clean",
    label: "Clean",
    sublabel: "Crisp, bright, edited down",
    purpose: "dump",
    slots: 9,
    dupeThreshold: 0.5,
    tune: makeTune(["clean-bright", "editorial", "luxury"], {
      tagBonus: 4,
      clarityWeight: 3,
    }),
  }),
  Object.freeze({
    key: "casual",
    label: "Casual",
    sublabel: "Friends, film, warmth",
    purpose: "dump",
    slots: 12,
    dupeThreshold: 0.62,
    tune: makeTune(["candid-social", "warm-film", "golden-hour", "euro-summer"], {
      tagBonus: 4,
    }),
  }),
  Object.freeze({
    key: "editorial",
    label: "Editorial",
    sublabel: "Moody, deliberate, tight",
    purpose: "dump",
    slots: 8,
    dupeThreshold: 0.45,
    tune: makeTune(["dark-moody", "editorial", "low-exposure", "streetwear"], {
      tagBonus: 4,
      intentWeight: 3,
      coverBonus: 6,
    }),
  }),
]);

// Any style whose date prefilter drops the library below this many photos falls
// back to the whole library (the deepest set needs its slots filled).
const MIN_FOR_RANGE = Math.max(...DUMP_STYLES.map((style) => style.slots));

function inRange(addedAt, dateRange) {
  if (!dateRange) return true;
  const at = Number(addedAt);
  if (!Number.isFinite(at)) return false;
  const start = Number.isFinite(dateRange.startMs) ? dateRange.startMs : -Infinity;
  const end = Number.isFinite(dateRange.endMs) ? dateRange.endMs : Infinity;
  return at >= start && at <= end;
}

/**
 * Build the three dump options for a request.
 * @param {{request?: string, dateRange?: {startMs:number, endMs:number}|null}} options
 * @returns {Promise<{options: Array, request: string, reason?: string}>}
 */
export async function buildDumpOptions({ request = "a photo dump", dateRange = null } = {}) {
  const cleanRequest = String(request ?? "").trim() || "a photo dump";
  try {
    const records = await listPhotos();
    if (!Array.isArray(records) || !records.length) {
      return { options: [], request: cleanRequest, reason: "empty" };
    }

    // Warm the Pass A cache so the re-list inside rankPhotos carries fresh
    // descriptions. Best-effort — never blocks the build.
    try {
      await ensureDescriptions(records);
    } catch (error) {
      console.info("Dump descriptions stayed cached-only", error);
    }

    // One Pass B ranking feeds all three styles.
    const ranked = await rankPhotos({ request: cleanRequest, purpose: "dump" });
    let scored = (Array.isArray(ranked) ? ranked : [])
      .filter((entry) => entry && entry.record && entry.record.id)
      .map((entry) => ({
        id: entry.record.id,
        record: entry.record,
        description: entry.record.derived?.passA ?? {},
        score: entry.score ?? entry.record.metrics?.quality ?? 0,
      }));

    if (!scored.length) {
      return { options: [], request: cleanRequest, reason: "empty" };
    }

    // Date prefilter, with a graceful fallback when the window is too thin.
    if (dateRange) {
      const filtered = scored.filter((item) => inRange(item.record.addedAt, dateRange));
      if (filtered.length >= MIN_FOR_RANGE) {
        scored = filtered;
      } else {
        console.info("Dump date range too thin, using full library", filtered.length);
      }
    }

    // On-device CLIP similarity for true perceptual dedup (skip near-identical
    // burst frames). Null when no index → assembleDump falls back to captions.
    let simLookup = null;
    try {
      simLookup = await similarityLookup();
    } catch (error) {
      console.info("dump dedup lookup skipped", error);
    }

    const options = DUMP_STYLES.map((style) => {
      const assembled = assembleDump(style.tune(scored.map((item) => ({ ...item }))), {
        slots: style.slots,
        dupeThreshold: style.dupeThreshold,
        simLookup,
      });
      const photos = (Array.isArray(assembled) ? assembled : [])
        .map((item) => item?.record)
        .filter(Boolean);
      return {
        key: style.key,
        label: style.label,
        sublabel: style.sublabel,
        photos,
        count: photos.length,
      };
    }).filter((option) => option.count > 0);

    recordTasteEvent("dump_built", { request: cleanRequest, styles: DUMP_STYLES.length });

    if (!options.length) {
      return { options: [], request: cleanRequest, reason: "empty" };
    }
    return { options, request: cleanRequest };
  } catch (error) {
    console.info("Dump build failed", error);
    return { options: [], request: cleanRequest, reason: "error" };
  }
}

/**
 * Parse a conversational revision instruction into a deterministic intent.
 * Exported for testability.
 * @param {string} instruction
 * @returns {{kind: string, arg: (number|string|null)}}
 */
export function parseRevision(instruction) {
  const text = String(instruction ?? "").trim().toLowerCase();
  if (!text) return Object.freeze({ kind: "unknown", arg: null });

  const replace = text.match(/(?:replace|swap)\s+(?:slide|slot|photo|pic|#)?\s*(\d+)/);
  if (replace) return Object.freeze({ kind: "replace", arg: Number(replace[1]) });

  const remove = text.match(/(?:remove|delete|drop|cut)\s+(?:slide|slot|photo|pic|#)?\s*(\d+)/);
  if (remove) return Object.freeze({ kind: "remove", arg: Number(remove[1]) });

  if (/\bmore\s+(friends|people|group|candid)/.test(text)) {
    return Object.freeze({ kind: "more_friends", arg: null });
  }

  const vibe = text.match(/\bmore\s+([a-z][a-z0-9-]+)/);
  if (vibe && VIBE_SET.has(vibe[1])) {
    return Object.freeze({ kind: "more_vibe", arg: vibe[1] });
  }

  return Object.freeze({ kind: "unknown", arg: null });
}

function byQuality(a, b) {
  const qa = a?.metrics?.quality ?? 0;
  const qb = b?.metrics?.quality ?? 0;
  if (qb !== qa) return qb - qa;
  const ida = String(a?.id ?? "");
  const idb = String(b?.id ?? "");
  return ida < idb ? -1 : ida > idb ? 1 : 0;
}

/**
 * Lightweight conversational revision over an existing option's photos. No new
 * model call — it pulls candidates from the on-device library and reorders/
 * swaps deterministically. Returns a NEW option of the same shape (plus an
 * optional `note`); unknown or impossible instructions return it unchanged.
 * @param {{key:string,label:string,sublabel:string,photos:Array,count:number}} option
 * @param {string} instruction
 */
export async function reviseDump(option, instruction) {
  try {
    if (!option || !Array.isArray(option.photos)) return option;
    const parsed = parseRevision(instruction);
    const photos = [...option.photos];
    const inSet = new Set(photos.map((photo) => photo?.id));

    let library = [];
    try {
      library = await listPhotos();
    } catch (error) {
      console.info("Dump revision library unavailable", error);
      library = [];
    }
    const unused = (Array.isArray(library) ? library : []).filter(
      (record) => record && record.id && !inSet.has(record.id),
    );

    const done = (next, note) => ({
      key: option.key,
      label: option.label,
      sublabel: option.sublabel,
      photos: next,
      count: next.length,
      note,
    });

    if (parsed.kind === "more_friends") {
      const friends = unused
        .filter((record) => {
          const description = record.derived?.passA ?? {};
          return (description.people_count ?? 0) >= 2 || description.candid_or_posed === "candid";
        })
        .sort(byQuality);
      if (!friends.length) return done(photos, "No more group shots in your library.");
      photos.push(friends[0]);
      return done(photos, "Brought in another shot with friends.");
    }

    if (parsed.kind === "more_vibe") {
      const vibe = parsed.arg;
      const matches = unused
        .filter((record) => (record.derived?.passA?.vibe_tags ?? []).includes(vibe))
        .sort(byQuality);
      if (!matches.length) return done(photos, `No more ${vibe} photos to add.`);
      photos.push(matches[0]);
      return done(photos, `Added a ${vibe} photo.`);
    }

    if (parsed.kind === "replace") {
      const slot = parsed.arg - 1;
      if (!Number.isInteger(slot) || slot < 0 || slot >= photos.length) {
        return done(photos, `There is no slide ${parsed.arg}.`);
      }
      const next = [...unused].sort(byQuality)[0];
      if (!next) return done(photos, "No spare photo to swap in.");
      photos[slot] = next;
      return done(photos, `Replaced slide ${parsed.arg}.`);
    }

    if (parsed.kind === "remove") {
      const slot = parsed.arg - 1;
      if (!Number.isInteger(slot) || slot < 0 || slot >= photos.length) {
        return done(photos, `There is no slide ${parsed.arg}.`);
      }
      photos.splice(slot, 1);
      return done(photos, `Removed slide ${parsed.arg}.`);
    }

    return {
      key: option.key,
      label: option.label,
      sublabel: option.sublabel,
      photos: option.photos,
      count: option.photos.length,
      note: "Try “more friends”, “more warm-film”, or “replace slide 3”.",
    };
  } catch (error) {
    console.info("Dump revision skipped", error);
    return option;
  }
}
