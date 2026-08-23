// Smart Collections + natural-language search over the on-device photo cache.
//
// Collections are STANDING QUERIES, not stored folders: each COLLECTION_DEF
// carries a `test(record)` that runs over the honest on-device metrics plus the
// cached Pass A description (record.derived.passA), so a collection is always a
// live, truthful view of the current library. `semanticFilter` is a cheap,
// client-side natural-language match over those same cached descriptions — no
// model call, so it works offline over whatever the ranker has already cached.
//
// Every export degrades to a silent empty/pass-through result and NEVER throws.
// All browser APIs are touched only inside function bodies (and Date is read
// lazily), so importing this module in Node never runs anything that throws.

import { listPhotos } from "./gems-photolib.js";
import { ensureDescriptions } from "./gems-ranker.js";

// ---------------------------------------------------------------------------
// Small, safe field accessors over the public record shape.
// ---------------------------------------------------------------------------

function passAOf(record) {
  const passA = record?.derived?.passA;
  return passA && typeof passA === "object" ? passA : null;
}

function qualityOf(record) {
  const quality = record?.metrics?.quality;
  return Number.isFinite(quality) ? quality : 0;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function includesTag(tags, tag) {
  return asArray(tags).some((entry) => String(entry).toLowerCase() === tag);
}

// The current calendar month window, read lazily so module load never touches
// Date. Returns null when Date is somehow unavailable (guarded for safety).
function currentMonthWindow() {
  try {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
    return { start, end };
  } catch (error) {
    console.info("Month window unavailable", error);
    return null;
  }
}

// A stable label for "Best of <current month>", computed once per session at
// module load. The window itself is recomputed per test() call, so the query
// stays correct even across a month boundary; only the label is fixed.
function currentMonthLabel() {
  try {
    return new Date().toLocaleString(undefined, { month: "long" });
  } catch (error) {
    console.info("Month label unavailable", error);
    return "this month";
  }
}

// Does passA carry a real, edit-worthy technical flaw (not just "none")?
// We look for the three flaws the model is asked to flag: motion blur,
// closed eyes, and a subject cut off by the frame.
function hasRealFlaw(passA) {
  return asArray(passA?.technical_flaws).some((flaw) => {
    const norm = String(flaw).toLowerCase();
    if (norm === "none" || norm === "") return false;
    return (
      norm.includes("blur") ||
      norm.includes("closed-eye") ||
      norm.includes("closed eye") ||
      norm.includes("cut-off") ||
      norm.includes("cut off") ||
      norm.includes("cutoff")
    );
  });
}

// ---------------------------------------------------------------------------
// Standing-query definitions.
// `needsDescription` flags the ones that lean on passA, so callers know these
// may simply show fewer/no photos when signed out (descriptions uncached).
// ---------------------------------------------------------------------------

export const COLLECTION_DEFS = Object.freeze([
  Object.freeze({
    key: "hidden-gems",
    label: "Hidden gems",
    needsDescription: false,
    test(record) {
      return record?.gem === true;
    },
  }),
  Object.freeze({
    key: "best-of-month",
    label: `Best of ${currentMonthLabel()}`,
    needsDescription: false,
    test(record) {
      const window = currentMonthWindow();
      if (!window) return false;
      const addedAt = record?.addedAt;
      if (!Number.isFinite(addedAt)) return false;
      return addedAt >= window.start && addedAt < window.end && qualityOf(record) >= 70;
    },
  }),
  Object.freeze({
    key: "worth-editing",
    label: "Worth editing",
    needsDescription: true,
    test(record) {
      if (hasRealFlaw(passAOf(record))) return true;
      const quality = qualityOf(record);
      return quality >= 45 && quality <= 70;
    },
  }),
  Object.freeze({
    key: "with-friends",
    label: "With friends",
    needsDescription: true,
    test(record) {
      const passA = passAOf(record);
      if (!passA) return false;
      const people = Number(passA.people_count);
      if (Number.isFinite(people) && people >= 2) return true;
      return includesTag(passA.vibe_tags, "candid-social");
    },
  }),
  Object.freeze({
    key: "never-posted",
    label: "Never posted",
    needsDescription: false,
    test(record) {
      // Everything the user hasn't exported yet. No export flag is set today,
      // so this shows the whole library — which is the correct behavior.
      return record?.derived?.exported !== true;
    },
  }),
  Object.freeze({
    key: "dating-picks",
    label: "Dating picks",
    needsDescription: true,
    test(record) {
      const passA = passAOf(record);
      if (!passA) return false;
      const bestFor = asArray(passA.best_for).map((entry) => String(entry).toLowerCase());
      if (bestFor.includes("dating") || bestFor.includes("profile-pic")) return true;
      const expression = Number(passA.expression);
      const distance = String(passA.distance ?? "").toLowerCase();
      return Number.isFinite(expression) && expression >= 4 && distance !== "wide";
    },
  }),
]);

// ---------------------------------------------------------------------------
// computeCollections — live standing queries over the current library.
// ---------------------------------------------------------------------------

// ensureDescriptions returns an id→description Map and persists new descriptions
// to IndexedDB, but the frozen public records we hold are not mutated in place.
// So we fold the Map back onto each record before running the tests.
function withDescriptions(records, described) {
  return records.map((record) => {
    const existing = record?.derived?.passA;
    if (existing) return record;
    const description = described.get(record.id);
    if (!description) return record;
    return { ...record, derived: { ...(record.derived ?? {}), passA: description } };
  });
}

export async function computeCollections() {
  try {
    const records = await listPhotos();
    if (!Array.isArray(records) || records.length === 0) return [];

    let described = new Map();
    try {
      described = await ensureDescriptions(records);
    } catch (error) {
      console.info("Descriptions skipped for collections", error);
    }
    const augmented = withDescriptions(records, described);

    const collections = [];
    for (const def of COLLECTION_DEFS) {
      const photos = augmented.filter((record) => {
        try {
          return def.test(record) === true;
        } catch (error) {
          console.info("Collection test skipped", def.key, error);
          return false;
        }
      });
      if (photos.length > 0) {
        collections.push({ key: def.key, label: def.label, photos, count: photos.length });
      }
    }
    console.info(`Computed ${collections.length} smart collections`);
    return collections;
  } catch (error) {
    console.info("Collections computation skipped", error);
    return [];
  }
}

// ---------------------------------------------------------------------------
// semanticFilter — cheap client-side NL search over cached descriptions.
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "a", "an", "the", "of", "my", "me", "in", "on", "with", "photos", "pics",
  "where", "everyone", "all", "and", "is", "are",
]);

function tokenize(query) {
  try {
    return String(query ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
  } catch (error) {
    console.info("Query tokenize skipped", error);
    return [];
  }
}

// A lowercase haystack of everything we can cheaply say about a photo, drawn
// only from its name and cached description — never a model call.
function haystackOf(record) {
  const parts = [String(record?.name ?? "")];
  const passA = passAOf(record);
  if (passA) {
    parts.push(String(passA.content ?? ""));
    parts.push(asArray(passA.vibe_tags).join(" "));
    parts.push(asArray(passA.best_for).join(" "));
    parts.push(String(passA.candid_or_posed ?? ""));
    parts.push(String(passA.distance ?? ""));
    const people = Number(passA.people_count);
    if (Number.isFinite(people) && people >= 2) parts.push("friends group people");
    const expression = Number(passA.expression);
    if (Number.isFinite(expression) && expression >= 4) parts.push("smiling happy expression");
  }
  return parts.join(" ").toLowerCase();
}

export function semanticFilter(records, query) {
  const list = Array.isArray(records) ? records : [];
  try {
    const tokens = tokenize(query);
    if (tokens.length === 0) return list;
    return list.filter((record) => {
      const haystack = haystackOf(record);
      return tokens.some((token) => haystack.includes(token));
    });
  } catch (error) {
    console.info("Semantic filter skipped", error);
    return list;
  }
}
