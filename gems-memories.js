// gems-memories.js — proactive Memories from real capture metadata.
//
// The library only ever knew import time; this reads each photo's true EXIF
// capture timestamp + GPS on-device (exifr from a CDN, guarded like the other
// models), then clusters photos into real EVENTS by time proximity (and location
// when available) — the basis for auto-albums, trip recaps, and a genuinely smart
// daily gem. All on-device; capture meta caches into the photo's derived record.
// Pure helpers (haversine / clustering / titles / gem scoring) are unit-tested.
import { updatePhotoDerived } from "./gems-photolib.js";

const EXIFR_URL = "https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/full.esm.mjs";
const GAP_HOURS = 8; // a >8h gap starts a new event
const RADIUS_KM = 40; // or a location jump > 40km
const MIN_MEMORY = 3; // an event needs at least this many photos to be a "memory"

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested).
// ---------------------------------------------------------------------------

/** Great-circle distance in km between two {lat,lon} points. */
export function haversineKm(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return Infinity;
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Cluster items into events. items: [{ id, t (epoch ms), lat?, lon? }].
 * A new event starts when the time gap exceeds gapHours OR (both points have
 * GPS and) the location jumps more than radiusKm. Returns arrays of items,
 * each sorted by time, in chronological order.
 */
export function clusterByTimeLoc(items, { gapHours = GAP_HOURS, radiusKm = RADIUS_KM } = {}) {
  const withT = items.filter((it) => Number.isFinite(it.t)).sort((a, b) => a.t - b.t);
  const gapMs = gapHours * 3600 * 1000;
  const clusters = [];
  let current = [];
  for (const it of withT) {
    if (!current.length) {
      current = [it];
      continue;
    }
    const prev = current[current.length - 1];
    const timeGap = it.t - prev.t;
    const locJump =
      it.lat != null && prev.lat != null ? haversineKm(it, prev) : 0;
    if (timeGap > gapMs || locJump > radiusKm) {
      clusters.push(current);
      current = [it];
    } else {
      current.push(it);
    }
  }
  if (current.length) clusters.push(current);
  return clusters;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

/** Human date-range label for a memory. start/end are epoch ms. */
export function formatDateRange(start, end) {
  const s = new Date(start);
  const e = new Date(end);
  if (Number.isNaN(s.getTime())) return "";
  // UTC-consistent so a label is deterministic regardless of the viewer's zone.
  const sM = s.getUTCMonth(), sD = s.getUTCDate(), sY = s.getUTCFullYear();
  const eM = e.getUTCMonth(), eD = e.getUTCDate(), eY = e.getUTCFullYear();
  const sameDay = sY === eY && sM === eM && sD === eD;
  const sameMonth = sY === eY && sM === eM;
  if (sameDay) return `${MONTHS[sM]} ${sD}, ${sY}`;
  if (sameMonth) return `${MONTHS[sM]} ${sD}–${eD}, ${sY}`;
  return `${MONTHS[sM]} ${sD} – ${MONTHS[eM]} ${eD}, ${eY}`;
}

/** A title for a cluster (date-based; span implies day/weekend/trip). */
export function titleFor(cluster) {
  if (!cluster.length) return "Untitled";
  const start = cluster[0].t;
  const end = cluster[cluster.length - 1].t;
  const days = Math.round((end - start) / (24 * 3600 * 1000)) + 1;
  const range = formatDateRange(start, end);
  const hasGeo = cluster.some((c) => c.lat != null);
  const kind = days <= 1 ? "" : days <= 3 ? " weekend" : " trip";
  const lead = hasGeo && days > 1 ? "Trip · " : "";
  return `${lead}${range}${kind && !lead ? kind : ""}`.trim();
}

/**
 * How "gem-worthy" a photo is (higher = stronger). Blends on-device quality with
 * the cached Pass-A appeal, and lightly favours photos with people. Pure.
 */
export function gemScore(record) {
  const quality = Number(record?.metrics?.quality ?? 0); // 0..100
  const passA = record?.derived?.passA ?? {};
  const appeal = Number(passA.appeal ?? 0); // 1..5
  const people = Number(passA.people_count ?? 0);
  let score = quality + appeal * 12; // appeal dominates when present
  if (people > 0) score += 8;
  if (passA.smile === true || passA.smile === "yes") score += 6;
  if (passA.photo_type && passA.photo_type !== "photo") score -= 40; // screenshots/docs sink
  return score;
}

// ---------------------------------------------------------------------------
// EXIF capture metadata (browser only).
// ---------------------------------------------------------------------------

let exifrPromise = null;
function canReadExif() {
  return typeof window !== "undefined" && typeof Blob !== "undefined";
}
async function getExifr() {
  if (exifrPromise) return exifrPromise;
  exifrPromise = (async () => (await import(/* @vite-ignore */ EXIFR_URL)).default)().catch((error) => {
    console.info("exifr unavailable — Memories fall back to import time", error);
    exifrPromise = null;
    return null;
  });
  return exifrPromise;
}

/** Read capture time + GPS from a photo Blob. Returns { takenAt, lat, lon }. */
export async function readCaptureMeta(blob) {
  const out = { takenAt: null, lat: null, lon: null };
  try {
    if (!blob || !canReadExif()) return out;
    const exifr = await getExifr();
    if (!exifr) return out;
    const data = await exifr.parse(blob, { pick: ["DateTimeOriginal", "CreateDate"] }).catch(() => null);
    const dt = data?.DateTimeOriginal || data?.CreateDate;
    if (dt) {
      const ms = dt instanceof Date ? dt.getTime() : Date.parse(dt);
      if (Number.isFinite(ms)) out.takenAt = ms;
    }
    const gps = await exifr.gps(blob).catch(() => null);
    if (gps && Number.isFinite(gps.latitude)) {
      out.lat = gps.latitude;
      out.lon = gps.longitude;
    }
  } catch (error) {
    console.info("readCaptureMeta failed", error);
  }
  return out;
}

/**
 * Ensure records have cached capture meta (derived.capture). Reads EXIF for up
 * to `limit` records lacking it. getBlob(id) → Blob. Returns { read }.
 */
export async function ensureCaptureMeta(records, getBlob, limit = 200) {
  let read = 0;
  try {
    const pending = (records || []).filter((r) => r?.id && !r.derived?.capture);
    for (const r of pending) {
      if (read >= limit) break;
      let blob = null;
      try {
        blob = await getBlob(r.id);
      } catch {
        blob = null;
      }
      if (!blob) continue;
      const meta = await readCaptureMeta(blob);
      await updatePhotoDerived(r.id, { capture: meta });
      // reflect locally so buildMemories sees it in this pass
      r.derived = { ...(r.derived || {}), capture: meta };
      read += 1;
    }
  } catch (error) {
    console.info("ensureCaptureMeta skipped", error);
  }
  return { read };
}

/** The effective capture time for a record (EXIF, else import time). */
function timeOf(record) {
  const t = record?.derived?.capture?.takenAt;
  return Number.isFinite(t) ? t : record?.addedAt ?? null;
}

/**
 * Build Memories from records (which should already carry derived.capture where
 * possible). Returns [{ id, title, coverId, photoIds, start, end, size, hasGeo }],
 * newest first, only events with >= MIN_MEMORY photos.
 */
export function buildMemories(records, { minSize = MIN_MEMORY } = {}) {
  const items = (records || [])
    .filter((r) => r?.id)
    .map((r) => ({
      id: r.id,
      t: timeOf(r),
      lat: r.derived?.capture?.lat ?? null,
      lon: r.derived?.capture?.lon ?? null,
      record: r,
    }))
    .filter((it) => Number.isFinite(it.t));

  const clusters = clusterByTimeLoc(items);
  const memories = [];
  for (const cluster of clusters) {
    if (cluster.length < minSize) continue;
    const start = cluster[0].t;
    const end = cluster[cluster.length - 1].t;
    // Cover = strongest photo in the event.
    let cover = cluster[0];
    let best = -Infinity;
    for (const c of cluster) {
      const s = gemScore(c.record);
      if (s > best) {
        best = s;
        cover = c;
      }
    }
    memories.push({
      id: `mem-${start}`,
      title: titleFor(cluster),
      coverId: cover.id,
      photoIds: cluster.map((c) => c.id),
      start,
      end,
      size: cluster.length,
      hasGeo: cluster.some((c) => c.lat != null),
    });
  }
  memories.sort((a, b) => b.end - a.end); // newest events first
  return memories;
}
