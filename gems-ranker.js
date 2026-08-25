// Client ranking module for the Gems scoring brain (docs/rank-photos.md).
// Two passes against the rank-photos edge function:
//   Pass A ("describe") — each photo is captioned ONCE, as a 512px JPEG
//     thumbnail, and the description is cached on-device (record.derived.passA)
//     so a photo never has to leave the device twice.
//   Pass B ("rank") — cached descriptions (never pixels) are scored against a
//     natural-language request plus the user's aesthetics and recent behavior.
// Every failure — signed out, offline, model error — degrades to the honest
// on-device quality ranking from gems-photolib. Nothing here ever throws.

import { getPhotoBlob, listPhotos, updatePhotoDerived } from "./gems-photolib.js";
import { getSession, getSupabase, recordTasteEvent } from "./gems-supabase.js";
import { photoIdsForQuery } from "./gems-faces.js";

// Keep in sync with gems-supabase.js, which declares these but does not
// export them (client-safe by design — RLS does the real gatekeeping).
const SUPABASE_URL = "https://hkwkxacvcgorhthwyslx.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_Z8Fw1dZYiqOGUDITzU929A_i2k9wANc";

const RANK_ENDPOINT = `${SUPABASE_URL}/functions/v1/rank-photos`;
const DESCRIBE_BATCH = 14; // server caps at 16 per call; stay comfortably under
const THUMB_MAX_EDGE = 512;
const JPEG_QUALITY = 0.82;

// Queries that read as a ranking request rather than a filename fragment.
const RANK_WORDS = /\b(best|top|favorite|gems|cover|dating|profile|dump)\b/i;

let describeUnavailableLogged = false;

function noteDescribeUnavailable(reason) {
  if (!describeUnavailableLogged) {
    describeUnavailableLogged = true;
    console.info(
      "Photo descriptions unavailable (signed out or offline?), using cached ones only",
      reason,
    );
  }
}

// All browser APIs (canvas, createImageBitmap, btoa, fetch) are touched only
// inside function bodies and behind typeof guards, so importing this module
// in Node never throws at load time.
function makeCanvas(width, height) {
  try {
    if (typeof OffscreenCanvas !== "undefined") {
      return new OffscreenCanvas(width, height);
    }
  } catch (error) {
    console.info("OffscreenCanvas unavailable, using DOM canvas", error);
  }
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  return null;
}

function canvasToJpegBlob(canvas) {
  if (typeof canvas.convertToBlob === "function") {
    return canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
  }
  if (typeof canvas.toBlob === "function") {
    return new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
    );
  }
  return null;
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000; // keep String.fromCharCode argument counts sane
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// Downscale one stored photo to a JPEG thumbnail for the describe pass.
// Returns { mimeType, base64 } or null when the photo or canvas support is
// missing — callers just skip the photo.
export async function makeThumbnail(id, maxEdge = THUMB_MAX_EDGE) {
  try {
    if (typeof createImageBitmap === "undefined" || typeof btoa === "undefined") {
      return null;
    }
    const blob = await getPhotoBlob(id);
    if (!blob) return null;
    const bitmap = await createImageBitmap(blob);
    try {
      const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = makeCanvas(width, height);
      if (!canvas) return null;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0, width, height);
      const jpeg = await canvasToJpegBlob(canvas);
      if (!jpeg) return null;
      return Object.freeze({
        mimeType: "image/jpeg",
        base64: await blobToBase64(jpeg),
      });
    } finally {
      try {
        bitmap.close?.();
      } catch {
        // ignore
      }
    }
  } catch (error) {
    console.info("Thumbnail build failed", id, error);
    return null;
  }
}

async function postRankFunction(session, payload) {
  const response = await fetch(RANK_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
      apikey: SUPABASE_PUBLISHABLE_KEY,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`rank-photos ${payload.action} failed: HTTP ${response.status}`);
  }
  return response.json();
}

// Pass A with an on-device cache: make sure every record has a description,
// describing only the ones that lack record.derived.passA. Returns an
// id → description Map covering everything we have (cached + newly fetched).
// Signed out / offline / model error → returns just the cached ones.
export async function ensureDescriptions(records) {
  const described = new Map();
  try {
    const list = Array.isArray(records) ? records : [];
    for (const record of list) {
      if (record?.id && record.derived?.passA) {
        described.set(record.id, record.derived.passA);
      }
    }
    const pending = list.filter((record) => record?.id && !record.derived?.passA);
    if (!pending.length) return described;

    const session = await getSession();
    if (!session) {
      noteDescribeUnavailable("signed out");
      return described;
    }

    for (let start = 0; start < pending.length; start += DESCRIBE_BATCH) {
      const batch = pending.slice(start, start + DESCRIBE_BATCH);
      const photos = [];
      for (const record of batch) {
        const thumb = await makeThumbnail(record.id);
        if (thumb) {
          photos.push({ id: record.id, mimeType: thumb.mimeType, base64: thumb.base64 });
        }
      }
      if (!photos.length) continue;

      const data = await postRankFunction(session, { action: "describe", photos });
      const model = data?.model ?? null;
      for (const description of data?.photos ?? []) {
        if (!description?.id) continue;
        described.set(description.id, description);
        await updatePhotoDerived(description.id, {
          passA: description,
          passAModel: model,
        });
      }
    }
  } catch (error) {
    noteDescribeUnavailable(error);
  }
  return described;
}

// The user's chosen aesthetics, in their chosen order. Empty when signed out
// or unset — Pass B just weighs taste less.
async function fetchUserAesthetics() {
  try {
    const supabase = await getSupabase();
    const session = await getSession();
    if (!supabase || !session) return [];
    const { data } = await supabase
      .from("profile_aesthetics")
      .select("label")
      .eq("profile_id", session.user.id)
      .order("position");
    return (data ?? []).map((row) => row?.label).filter(Boolean);
  } catch (error) {
    console.info("Aesthetics fetch skipped", error);
    return [];
  }
}

// Compact recent-behavior digest for Pass B (docs/rank-photos.md): counts of
// the user's latest taste_events, e.g. "photo_kept x12, rank_requested x3".
async function fetchTasteSummary() {
  try {
    const supabase = await getSupabase();
    const session = await getSession();
    if (!supabase || !session) return null;
    const { data } = await supabase
      .from("taste_events")
      .select("event_type")
      .eq("profile_id", session.user.id)
      .order("created_at", { ascending: false })
      .limit(60);
    if (!data?.length) return null;
    const counts = new Map();
    for (const row of data) {
      if (!row?.event_type) continue;
      counts.set(row.event_type, (counts.get(row.event_type) ?? 0) + 1);
    }
    return [...counts].map(([type, count]) => `${type} x${count}`).join(", ") || null;
  } catch (error) {
    console.info("Taste summary skipped", error);
    return null;
  }
}

// Rank the whole library against a natural-language request. Returns
// [{ record, score, because }] sorted by score desc; records the model did
// not rank are appended with score null. On ANY failure the result is the
// on-device quality ranking (score/because null) — honest, never fabricated.
export async function rankPhotos({ request, purpose = "general" } = {}) {
  let records = [];
  try {
    records = await listPhotos();
    if (!records.length) return [];

    // Face filter: "best photos of me" / "photos of <name>" restricts the
    // candidates to that person when the user has tagged faces (on-device). A
    // null/empty match leaves the full library in play, so search never breaks.
    try {
      const personIds = await photoIdsForQuery(request);
      if (personIds && personIds.length) {
        const set = new Set(personIds);
        const filtered = records.filter((r) => set.has(r.id));
        if (filtered.length) records = filtered;
      }
    } catch (error) {
      console.info("face filter skipped", error);
    }

    const described = await ensureDescriptions(records);

    // Sequential indices for the rank payload, with a parallel index → record
    // join table.
    const descriptions = [];
    const recordAtIndex = [];
    for (const record of records) {
      const description = described.get(record.id);
      if (!description) continue;
      descriptions.push({ ...description, index: recordAtIndex.length });
      recordAtIndex.push(record);
    }
    if (!descriptions.length) throw new Error("no descriptions available");

    const session = await getSession();
    if (!session) throw new Error("signed out");

    const [userAesthetics, tasteSummary] = await Promise.all([
      fetchUserAesthetics(),
      fetchTasteSummary(),
    ]);

    const data = await postRankFunction(session, {
      action: "rank",
      request: String(request ?? ""),
      purpose,
      userAesthetics,
      tasteSummary,
      descriptions,
    });
    const ranking = Array.isArray(data?.ranking) ? data.ranking : [];
    if (!ranking.length) throw new Error("empty ranking");

    const results = [];
    const rankedIds = new Set();
    for (const entry of ranking) {
      const record = recordAtIndex[entry?.index];
      if (!record || rankedIds.has(record.id)) continue;
      rankedIds.add(record.id);
      results.push(
        Object.freeze({
          record,
          score: Number.isFinite(entry.score) ? entry.score : null,
          because: entry.because ?? null,
        }),
      );
    }
    // Deterministic order: the model is noisy within a few points at temp 0.2,
    // so near-tied photos would otherwise swap the #1 crown between identical
    // re-ranks. Break ties by on-device quality, then id, so a given library +
    // request always yields the same order.
    results.sort(
      (a, b) =>
        (b.score ?? -1) - (a.score ?? -1) ||
        (b.record.metrics?.quality ?? 0) - (a.record.metrics?.quality ?? 0) ||
        (a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0),
    );
    for (const record of records) {
      if (!rankedIds.has(record.id)) {
        results.push(Object.freeze({ record, score: null, because: null }));
      }
    }

    recordTasteEvent("rank_requested", {
      purpose,
      request,
      top5: results.slice(0, 5).map((entry) => entry.record.id),
    });
    return results;
  } catch (error) {
    console.info("Rank fell back to on-device quality ordering", error);
    return [...records]
      .sort((a, b) => (b.metrics?.quality ?? 0) - (a.metrics?.quality ?? 0))
      .map((record) => Object.freeze({ record, score: null, because: null }));
  }
}

// Heuristic: does this search-box query read as a natural-language ranking
// request ("best beach pics for my profile") rather than a filename fragment
// ("IMG_2041")? 3+ words, or any ranking keyword.
export function isRankQuery(query) {
  try {
    const text = String(query ?? "").trim();
    if (!text) return false;
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    return wordCount >= 3 || RANK_WORDS.test(text);
  } catch {
    return false;
  }
}
