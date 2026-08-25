// "Hidden gem of the day" — one forgotten-but-strong photo, chosen fresh every
// calendar day. The pick is DETERMINISTIC per day: the same date always yields
// the same gem, and it rotates when the day rolls over. Nothing here ever
// throws — every failure path degrades to null so Home falls back to its demo
// scene. All work is on-device: it only reads the local photo library.

import { listPhotos, describePhoto } from "./gems-photolib.js";
import { gemScore } from "./gems-memories.js";

// How many of the strongest forgotten photos the daily gem rotates through.
const DAILY_POOL = 24;

// The evocative lead that opens every reason line.
const REASON_LEAD = "You forgot about this one";

// YYYYMMDD-derived integer for a given epoch-ms instant. Pure and
// deterministic: same ms → same index; a day later → a different index.
// Exported for tests. Never throws — a bad input collapses to 0.
export function dayIndex(ms) {
  try {
    const date = new Date(Number(ms));
    if (Number.isNaN(date.getTime())) return 0;
    return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
  } catch {
    return 0;
  }
}

// One honest line about why this gem is worth a second look. Prefers the
// cached Pass A description (record.derived.passA.content); otherwise falls
// back to the metric-grounded describePhoto(). Always returns a string.
function reasonFor(record) {
  try {
    const content = record?.derived?.passA?.content;
    if (typeof content === "string" && content.trim()) {
      return `${REASON_LEAD} — ${content.trim()}`;
    }
    const detail = describePhoto(record?.metrics);
    if (typeof detail === "string" && detail.trim()) {
      return `${REASON_LEAD} — ${detail.trim()}`;
    }
  } catch (error) {
    console.info("Hidden-gem reason fallback", error);
  }
  return `${REASON_LEAD} — a strong shot you never posted.`;
}

// Pick today's hidden gem, or null when there's nothing to surface.
//   - Candidate pool: gems, or quality >= 70.
//   - Prefer forgotten ones (derived.exported !== true); only fall back to the
//     whole pool if every candidate has already been exported.
//   - Deterministic per calendar day: index dayIndex(now) into the pool sorted
//     by a stable key (id), so the same day always yields the same gem.
// `now` (epoch ms) can be injected for tests; in the browser it defaults to
// Date.now(). We never touch Date at module load, so a Node import is inert.
export async function pickGemOfTheDay(now = null) {
  try {
    const records = await listPhotos();
    if (!Array.isArray(records) || records.length === 0) return null;

    const pool = records.filter(
      (record) =>
        record &&
        (record.gem === true || (record.metrics?.quality ?? 0) >= 70),
    );
    if (pool.length === 0) return null;

    const forgotten = pool.filter((record) => record.derived?.exported !== true);
    const candidates = forgotten.length > 0 ? forgotten : pool;

    // Rank by real strength (quality + Pass-A appeal + people/smile), not blur
    // alone — then rotate the day through the STRONGEST forgotten photos. Ties
    // break by id so a given day is always reproducible.
    const strongest = [...candidates]
      .sort(
        (a, b) =>
          gemScore(b) - gemScore(a) ||
          String(a.id).localeCompare(String(b.id)),
      )
      .slice(0, DAILY_POOL);

    const ms = now == null ? Date.now() : Number(now);
    const index = dayIndex(ms) % strongest.length;
    const record = strongest[index];
    if (!record) return null;

    return { record, reason: reasonFor(record) };
  } catch (error) {
    console.info("Hidden gem of the day unavailable", error);
    return null;
  }
}
