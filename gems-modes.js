// Scoped Studio modes — the Dating Profile Director (docs/MASTER-FEATURES.md #18)
// and the Travel / Event scoped dumps (#19).
//
// Both build on the same honest engine as the photo-dump flow: the on-device
// library (gems-photolib), one Pass-B ranking (gems-ranker), and deterministic
// set assembly (gems-rank-assembly). The dating director is different in shape —
// it fills SIX named roles rather than a flat set, using the cached Pass-A
// signals to decide which photo plays which part, and it names the GAPS
// (missing full-body, missing activity shot) as first-class output so the user
// knows exactly what to go shoot.
//
// Nothing here ever throws. Every browser API is reached only through the
// imported modules, which guard them, so importing this file in Node is safe:
// the async builders degrade to { error } and detectDateClusters is pure.

import { listPhotos } from "./gems-photolib.js";
import { rankPhotos } from "./gems-ranker.js";
import { assembleDump } from "./gems-rank-assembly.js";
import { recordTasteEvent } from "./gems-supabase.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// The Pass-A description for a public record, always an object.
function descOf(record) {
  const passA = record?.derived?.passA;
  return passA && typeof passA === "object" ? passA : {};
}

// Lowercased content sentence for keyword matching.
function contentOf(desc) {
  return String(desc?.content ?? "").toLowerCase();
}

function hasTag(desc, tag) {
  return Array.isArray(desc?.vibe_tags) && desc.vibe_tags.includes(tag);
}

function bestFor(desc, value) {
  return Array.isArray(desc?.best_for) && desc.best_for.includes(value);
}

function matchesAny(text, words) {
  return words.some((word) => text.includes(word));
}

// ---------------------------------------------------------------------------
// TASK A.1 — Dating Profile Director
// ---------------------------------------------------------------------------

// Six roles, in presentation order. Each carries a scorer over the Pass-A
// signals (higher = better fit), a `min` bar the best candidate must clear to
// fill the role, and a specific gap tip for when nothing clears it. `fallback`
// lets the Lead take the best available photo even without strong signal — a
// dating profile always needs a headline shot; the other five are genuinely
// "missing" when the signal isn't there.
const DATING_ROLES = Object.freeze([
  Object.freeze({
    role: "Lead",
    min: 0,
    fallback: true,
    gap: "You're missing a strong lead shot — a sharp, well-lit photo of just you, looking at the camera.",
    score(desc) {
      let s = 0;
      if (bestFor(desc, "cover")) s += 5;
      if (bestFor(desc, "profile-pic")) s += 4;
      if (bestFor(desc, "dating")) s += 3;
      if (desc.distance === "close") s += 3;
      else if (desc.distance === "mid") s += 2;
      else if (desc.distance === "wide") s -= 2;
      if (Number.isFinite(desc.expression)) s += desc.expression * 0.8;
      if (Number.isFinite(desc.subject_clarity)) s += desc.subject_clarity * 0.4;
      if (desc.candid_or_posed === "posed") s += 1;
      s += (desc.people_count ?? 0) <= 1 ? 2 : -2;
      return s;
    },
  }),
  Object.freeze({
    role: "Social",
    min: 3,
    gap: "Add a photo with friends — a candid group shot shows you have a life outside the app.",
    score(desc) {
      let s = 0;
      const people = Number.isFinite(desc.people_count) ? desc.people_count : 0;
      if (people >= 2) s += Math.min(people, 3) * 2;
      if (desc.candid_or_posed === "candid") s += 3;
      if (hasTag(desc, "candid-social")) s += 4;
      if (bestFor(desc, "story")) s += 1;
      if (matchesAny(contentOf(desc), ["friend", "group", "party", "crowd", "people"])) s += 2;
      return s;
    },
  }),
  Object.freeze({
    role: "Activity",
    min: 3,
    gap: "Show yourself doing something — a gym, sport, or hobby shot proves you're active.",
    score(desc) {
      let s = 0;
      if (hasTag(desc, "gym")) s += 3;
      if (hasTag(desc, "streetwear")) s += 1;
      if (bestFor(desc, "sports-graphic")) s += 5;
      if (
        matchesAny(contentOf(desc), [
          "gym", "lift", "run", "ball", "sport", "court", "bike", "cycl",
          "ski", "surf", "climb", "skate", "yoga", "hike", "workout",
          "training", "match", "field", "pitch", "board", "dance",
        ])
      ) {
        s += 4;
      }
      if (desc.distance === "mid" || desc.distance === "wide") s += 1;
      return s;
    },
  }),
  Object.freeze({
    role: "Full-body",
    min: 3,
    gap: "You're missing a full-body shot — stand back and get your whole outfit in frame.",
    score(desc) {
      let s = 0;
      if (desc.distance === "wide") s += 5;
      if (
        matchesAny(contentOf(desc), [
          "full body", "full-body", "outfit", "standing", "ootd", "mirror",
          "head to toe", "whole", "fit ", "posing",
        ])
      ) {
        s += 3;
      }
      if ((desc.people_count ?? 0) <= 1) s += 1;
      return s;
    },
  }),
  Object.freeze({
    role: "Personality",
    min: 4,
    gap: "Add a candid, expressive shot — a real laugh or a genuine moment reads as personality.",
    score(desc) {
      let s = 0;
      const expression = Number.isFinite(desc.expression) ? desc.expression : 0;
      if (expression >= 4) s += 5;
      else if (expression === 3) s += 1;
      if (desc.candid_or_posed === "candid") s += 3;
      if (hasTag(desc, "candid-social") || hasTag(desc, "warm-film")) s += 1;
      if (matchesAny(contentOf(desc), ["laugh", "smile", "smiling", "candid"])) s += 2;
      return s;
    },
  }),
  Object.freeze({
    role: "Environment",
    min: 4,
    gap: "Add a scenic or travel shot — a photo somewhere interesting hints at your world.",
    score(desc) {
      let s = 0;
      if (desc.distance === "wide") s += 3;
      if (hasTag(desc, "euro-summer") || hasTag(desc, "golden-hour")) s += 3;
      if (
        matchesAny(contentOf(desc), [
          "beach", "city", "street", "travel", "mountain", "landscape",
          "sunset", "sunrise", "view", "ocean", "sea", "lake", "forest",
          "desert", "skyline", "rooftop", "coast", "hill", "park", "temple",
          "bridge", "trip", "vacation", "abroad",
        ])
      ) {
        s += 4;
      }
      if ((desc.people_count ?? 0) === 0) s += 2;
      return s;
    },
  }),
]);

/**
 * Build a six-role dating profile from the on-device library.
 * @returns {Promise<{slots: Array<{role:string, record:object|null, because:string}>, gaps: string[]} | {error: string}>}
 */
export async function buildDatingProfile() {
  try {
    const records = await listPhotos();
    if (!Array.isArray(records) || !records.length) {
      return { error: "empty" };
    }

    const ranked = await rankPhotos({
      request: "dating profile picks",
      purpose: "dating",
    });
    const ordered = (Array.isArray(ranked) ? ranked : [])
      .filter((entry) => entry && entry.record && entry.record.id);
    if (!ordered.length) {
      return { error: "empty" };
    }

    // A gentle base bias toward the overall better photo, so that when two
    // candidates tie on role fit, the higher-ranked one wins deterministically.
    const total = ordered.length;
    const rankBonus = (index) => (total > 1 ? (1 - index / total) : 0);

    const used = new Set();
    const slots = [];
    const gaps = [];

    for (const role of DATING_ROLES) {
      let best = null;
      let bestScore = -Infinity;
      ordered.forEach((entry, index) => {
        const id = entry.record.id;
        if (used.has(id)) return;
        const fit = role.score(descOf(entry.record));
        const combined = fit + rankBonus(index);
        if (combined > bestScore) {
          bestScore = combined;
          best = { entry, fit };
        }
      });

      const clears = best && (best.fit >= role.min || (role.fallback && best.entry));
      if (clears) {
        used.add(best.entry.record.id);
        slots.push({
          role: role.role,
          record: best.entry.record,
          because: best.entry.because ?? "",
        });
      } else {
        slots.push({ role: role.role, record: null, because: role.gap });
        gaps.push(role.gap);
      }
    }

    const filled = slots.filter((slot) => slot.record).length;
    recordTasteEvent("dating_profile_built", { filled, gaps: gaps.length });
    return { slots, gaps };
  } catch (error) {
    console.info("Dating profile build failed", error);
    return { error: "failed" };
  }
}

// ---------------------------------------------------------------------------
// TASK A.2 — Travel / Event scoped modes
// ---------------------------------------------------------------------------

// The two scoped modes. slotTemplate is the storytelling shape a full recap
// aims for (establishing → arrival → … → closer); the ordered set is assembled
// to `slots` length and the template drives how many, plus optional labelling.
export const SCOPED_MODES = Object.freeze([
  Object.freeze({
    key: "travel",
    label: "Travel recap",
    slots: 10,
    slotTemplate: Object.freeze([
      "establishing wide", "arrival", "food", "detail", "candid",
      "landscape", "group", "action", "golden", "closer",
    ]),
  }),
  Object.freeze({
    key: "event",
    label: "Event",
    slots: 8,
    slotTemplate: Object.freeze([
      "arrival", "group", "action", "candid", "detail", "crowd", "reaction", "closer",
    ]),
  }),
]);

function scopedModeFor(key) {
  return SCOPED_MODES.find((mode) => mode.key === key) ?? SCOPED_MODES[0];
}

/**
 * Build one scoped, storytelling-ordered dump for a travel or event window.
 * When no explicit window is given, the densest date cluster is auto-detected.
 * @param {{mode?: string, startMs?: number|null, endMs?: number|null}} options
 * @returns {Promise<{option:{label:string, photos:object[], count:number}, cluster:object|null} | {error:string}>}
 */
export async function buildScopedDump({ mode = "travel", startMs = null, endMs = null } = {}) {
  try {
    const config = scopedModeFor(mode);
    const records = await listPhotos();
    if (!Array.isArray(records) || !records.length) {
      return { error: "empty" };
    }

    // Resolve the scope window: explicit range, else the densest cluster.
    let cluster = null;
    let windowStart = Number.isFinite(startMs) ? startMs : null;
    let windowEnd = Number.isFinite(endMs) ? endMs : null;
    if (windowStart === null && windowEnd === null) {
      const clusters = detectDateClusters(records);
      if (clusters.length) {
        cluster = clusters[0];
        windowStart = cluster.startMs;
        windowEnd = cluster.endMs;
      }
    } else {
      cluster = {
        startMs: windowStart ?? -Infinity,
        endMs: windowEnd ?? Infinity,
        count: 0,
        label: "Selected range",
      };
    }

    const inWindow = (record) => {
      const at = Number(record?.addedAt);
      if (!Number.isFinite(at)) return false;
      const start = Number.isFinite(windowStart) ? windowStart : -Infinity;
      const end = Number.isFinite(windowEnd) ? windowEnd : Infinity;
      return at >= start && at <= end;
    };

    // Scope the library to the window; fall back to the whole library if the
    // window turns up empty so the mode still produces a set.
    let scoped = windowStart === null && windowEnd === null
      ? records
      : records.filter(inWindow);
    if (!scoped.length) scoped = records;
    const scopedIds = new Set(scoped.map((record) => record.id));

    // One Pass-B ranking over the whole library, then keep the scoped ids in
    // rank order and feed them to the deterministic set assembler.
    const ranked = await rankPhotos({ request: config.label, purpose: "dump" });
    const scored = (Array.isArray(ranked) ? ranked : [])
      .filter((entry) => entry && entry.record && entry.record.id && scopedIds.has(entry.record.id))
      .map((entry) => ({
        id: entry.record.id,
        record: entry.record,
        description: entry.record.derived?.passA ?? {},
        score: entry.score ?? entry.record.metrics?.quality ?? 0,
      }));

    if (!scored.length) {
      return { error: "empty" };
    }

    const assembled = assembleDump(scored, { slots: config.slots });
    const photos = (Array.isArray(assembled) ? assembled : [])
      .map((item) => item?.record)
      .filter(Boolean);

    if (!photos.length) {
      return { error: "empty" };
    }

    // The synthetic explicit-range cluster starts at count 0; fill it in with
    // how many photos actually landed in the window.
    if (cluster && (!Number.isFinite(cluster.count) || cluster.count === 0)) {
      cluster.count = scoped.length;
    }

    const option = { label: config.label, photos, count: photos.length };
    recordTasteEvent("scoped_dump_built", { mode: config.key, count: photos.length });
    return { option, cluster };
  } catch (error) {
    console.info("Scoped dump build failed", error);
    return { error: "failed" };
  }
}

// ---------------------------------------------------------------------------
// TASK A.3 — Date clustering (pure, deterministic, exported for tests)
// ---------------------------------------------------------------------------

const DAY_MS = 86400000;
const CLUSTER_GAP_DAYS = 2; // days apart that still belong to one trip/event
const MONTHS = Object.freeze([
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
]);

function clusterLabel(startMs, endMs) {
  const start = new Date(startMs);
  const end = new Date(endMs);
  const sm = MONTHS[start.getUTCMonth()];
  const sd = start.getUTCDate();
  const em = MONTHS[end.getUTCMonth()];
  const ed = end.getUTCDate();
  if (sm === em && sd === ed) return `${sm} ${sd}`;
  if (sm === em) return `${sm} ${sd}–${ed}`;
  return `${sm} ${sd} – ${em} ${ed}`;
}

/**
 * Group photos by day, merge adjacent days into clusters, return them sorted by
 * photo count (densest first). Pure and deterministic. Records without a finite
 * addedAt are ignored.
 * @param {Array<{addedAt?: number}>} records
 * @returns {Array<{startMs:number, endMs:number, count:number, label:string}>}
 */
export function detectDateClusters(records) {
  try {
    const list = Array.isArray(records) ? records : [];
    // Aggregate per UTC day: photo count and the true min/max timestamps.
    const days = new Map();
    for (const record of list) {
      const at = Number(record?.addedAt);
      if (!Number.isFinite(at)) continue;
      const day = Math.floor(at / DAY_MS);
      const bucket = days.get(day);
      if (bucket) {
        bucket.count += 1;
        if (at < bucket.minMs) bucket.minMs = at;
        if (at > bucket.maxMs) bucket.maxMs = at;
      } else {
        days.set(day, { day, count: 1, minMs: at, maxMs: at });
      }
    }
    if (!days.size) return [];

    const sortedDays = [...days.values()].sort((a, b) => a.day - b.day);
    const clusters = [];
    let current = null;
    for (const bucket of sortedDays) {
      if (current && bucket.day - current.lastDay <= CLUSTER_GAP_DAYS) {
        current.count += bucket.count;
        current.endMs = Math.max(current.endMs, bucket.maxMs);
        current.startMs = Math.min(current.startMs, bucket.minMs);
        current.lastDay = bucket.day;
      } else {
        if (current) clusters.push(current);
        current = {
          startMs: bucket.minMs,
          endMs: bucket.maxMs,
          count: bucket.count,
          lastDay: bucket.day,
        };
      }
    }
    if (current) clusters.push(current);

    return clusters
      .map((cluster) => ({
        startMs: cluster.startMs,
        endMs: cluster.endMs,
        count: cluster.count,
        label: clusterLabel(cluster.startMs, cluster.endMs),
      }))
      // Densest first; ties broken by the tighter span, then the earlier start.
      .sort(
        (a, b) =>
          b.count - a.count ||
          (a.endMs - a.startMs) - (b.endMs - b.startMs) ||
          a.startMs - b.startMs,
      );
  } catch (error) {
    console.info("Date clustering skipped", error);
    return [];
  }
}
