// On-device photo library engine for the Gems client.
// Core product principle: photos never leave the device. Originals live in
// IndexedDB, quality is scored on import with classic signal processing
// (Laplacian sharpness, luma statistics — no ML, no uploads), and ranking is
// honest: the metrics are what they are. Every function degrades to a silent
// empty/no-op result when IndexedDB is unavailable (private browsing), so the
// app flow never breaks.

import { recordTasteEvent } from "./gems-supabase.js";
import { ensureDbUser, dbNameFor, onDbUserChange } from "./gems-db-user.js";

const DB_NAME = "gems-photolib";
const DB_VERSION = 1;
const STORE_NAME = "photos";
const THUMB_MAX = 320; // long-side cap for the analysis downscale

// Import performance tuning. The import path is the product's fundamental
// ability: pull in a whole camera roll (hundreds to a few thousand photos),
// analyze fast, and never freeze the tab. We analyze with a small async pool
// (overlapping createImageBitmap/decode), yield to the event loop so the UI
// paints live, and batch the IndexedDB writes into few transactions.
const CONCURRENCY = 4; // in-flight analyses; caps peak decode memory on mobile
const WRITE_CHUNK = 25; // records buffered per IndexedDB transaction
const YIELD_EVERY = 8; // yield to the event loop every N processed files
const PROGRESS_EVERY = 4; // fire onProgress at most every N processed files

// Quality blend weights — sharpness dominates, then contrast, then exposure.
const WEIGHTS = Object.freeze({ sharpness: 0.55, contrast: 0.25, exposure: 0.2 });

// Sharpness normalization anchors (Laplacian variance on the 320px downscale).
// Typical sharp photos land above ~500, blurry below ~100; a log ramp between
// these anchors keeps the score discriminating instead of saturated.
const SHARP_LOG_FLOOR = 1; // log10(variance + 1) at ~variance 9 → score 0
const SHARP_LOG_CEIL = Math.log10(801); // ~variance 800 → score 1

let dbPromise = null;
let dbUnavailableLogged = false;

// Object URLs are cached per photo id so repeated listPhotos() calls reuse the
// same URL instead of leaking a new one each time.
const objectUrlCache = new Map();

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function noteDbUnavailable(error) {
  if (!dbUnavailableLogged) {
    dbUnavailableLogged = true;
    console.info(
      "Photo library storage unavailable (private browsing?), continuing without persistence",
      error,
    );
  }
}

// On account switch, drop the cached connection + object URLs so the next open
// uses the new account's isolated DB — no photos ever bleed between accounts.
onDbUserChange(() => {
  const prev = dbPromise;
  dbPromise = null;
  if (prev) prev.then((db) => { try { db?.close?.(); } catch { /* already closed */ } }).catch(() => {});
  for (const url of objectUrlCache.values()) { try { URL.revokeObjectURL(url); } catch { /* ignore */ } }
  objectUrlCache.clear();
});

async function openDb() {
  await ensureDbUser(); // partition the DB by the signed-in account
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") {
        noteDbUnavailable("indexedDB missing");
        resolve(null);
        return;
      }
      const request = indexedDB.open(dbNameFor(DB_NAME), DB_VERSION);
      request.onupgradeneeded = () => {
        try {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: "id" });
          }
        } catch (error) {
          console.info("Photo library upgrade skipped", error);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        noteDbUnavailable(request.error);
        resolve(null);
      };
      request.onblocked = () => {
        noteDbUnavailable("open blocked");
        resolve(null);
      };
    } catch (error) {
      noteDbUnavailable(error);
      resolve(null);
    }
  });
  return dbPromise;
}

// Wrap one IDB request in a promise; resolves fallback instead of rejecting.
function requestToPromise(request, fallback) {
  return new Promise((resolve) => {
    try {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        console.info("Photo library request failed", request.error);
        resolve(fallback);
      };
    } catch (error) {
      console.info("Photo library request failed", error);
      resolve(fallback);
    }
  });
}

async function withStore(mode, work, fallback) {
  try {
    const db = await openDb();
    if (!db) return fallback;
    const tx = db.transaction(STORE_NAME, mode);
    return await work(tx.objectStore(STORE_NAME));
  } catch (error) {
    console.info("Photo library operation skipped", error);
    return fallback;
  }
}

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

// Downscale a bitmap onto a canvas (max THUMB_MAX on the long side) and return
// its ImageData, or null when canvas support is missing. When a `holder`
// object is passed, a single canvas/context is reused across calls (resized in
// place) instead of allocating one per photo — the metric math is identical
// because the same downscaled pixels are produced either way; this only avoids
// per-photo canvas/context churn during a large import.
function drawBitmapToImageData(bitmap, holder = null) {
  try {
    const scale = Math.min(1, THUMB_MAX / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    let canvas;
    let ctx;
    if (holder && holder.canvas) {
      canvas = holder.canvas;
      // Setting width/height also clears the surface — no manual clear needed.
      canvas.width = width;
      canvas.height = height;
      ctx = holder.ctx;
    } else {
      canvas = makeCanvas(width, height);
      if (!canvas) return null;
      ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (holder) {
        holder.canvas = canvas;
        holder.ctx = ctx;
      }
    }
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height);
  } catch (error) {
    console.info("Photo downscale failed", error);
    return null;
  }
}

// Backward-compatible single-shot downscale (allocates its own canvas).
function bitmapToImageData(bitmap) {
  return drawBitmapToImageData(bitmap, null);
}

// Classic signal-processing metrics from grayscale pixel data:
//   sharpness  — variance of a 3x3 Laplacian convolution (focus measure)
//   brightness — mean luma, 0–255
//   contrast   — standard deviation of luma
function computeMetrics(imageData) {
  const { data, width, height } = imageData;
  const luma = new Float32Array(width * height);
  let lumaSum = 0;
  for (let i = 0, p = 0; i < luma.length; i += 1, p += 4) {
    const y = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    luma[i] = y;
    lumaSum += y;
  }
  const brightness = lumaSum / luma.length;

  let varianceSum = 0;
  for (let i = 0; i < luma.length; i += 1) {
    const d = luma[i] - brightness;
    varianceSum += d * d;
  }
  const contrast = Math.sqrt(varianceSum / luma.length);

  // Laplacian (0 1 0 / 1 -4 1 / 0 1 0) over interior pixels.
  let lapSum = 0;
  let lapSqSum = 0;
  let lapCount = 0;
  for (let y = 1; y < height - 1; y += 1) {
    const row = y * width;
    for (let x = 1; x < width - 1; x += 1) {
      const i = row + x;
      const lap =
        luma[i - width] + luma[i + width] + luma[i - 1] + luma[i + 1] - 4 * luma[i];
      lapSum += lap;
      lapSqSum += lap * lap;
      lapCount += 1;
    }
  }
  let sharpness = 0;
  if (lapCount > 0) {
    const mean = lapSum / lapCount;
    sharpness = Math.max(0, lapSqSum / lapCount - mean * mean);
  }

  return {
    sharpness: Math.round(sharpness * 100) / 100,
    brightness: Math.round(brightness * 100) / 100,
    contrast: Math.round(contrast * 100) / 100,
  };
}

// Exposure score peaks at mid-brightness: full marks in the comfortable
// mid band, then a linear falloff so <40 and >215 luma are clearly penalized.
function exposureScore(brightness) {
  if (brightness >= 80 && brightness <= 175) return 1;
  if (brightness < 80) return clamp01((brightness - 20) / 60);
  return clamp01((235 - brightness) / 60);
}

// Log-scale sharpness normalization keeps the score discriminating: variance
// ~10 scores near 0, ~100 (blurry ceiling) around 0.5, ~500+ (sharp) near 1.
function sharpnessScore(sharpness) {
  const logValue = Math.log10(Math.max(0, sharpness) + 1);
  return clamp01((logValue - SHARP_LOG_FLOOR) / (SHARP_LOG_CEIL - SHARP_LOG_FLOOR));
}

function contrastScore(contrast) {
  return clamp01(contrast / 60);
}

function computeQuality(metrics) {
  const blended =
    WEIGHTS.sharpness * sharpnessScore(metrics.sharpness) +
    WEIGHTS.contrast * contrastScore(metrics.contrast) +
    WEIGHTS.exposure * exposureScore(metrics.brightness);
  return Math.round(clamp01(blended) * 100);
}

function urlForRecord(record) {
  try {
    const cached = objectUrlCache.get(record.id);
    if (cached) return cached;
    if (typeof URL === "undefined" || !record.blob) return null;
    const url = URL.createObjectURL(record.blob);
    objectUrlCache.set(record.id, url);
    return url;
  } catch (error) {
    console.info("Object URL creation failed", error);
    return null;
  }
}

// Public shape: everything except the blob, plus a cached object URL.
// `derived` carries downstream annotations (e.g. the ranker's cached Pass A
// description) and is always present, defaulting to {}.
function toPublicRecord(record, gem = false) {
  return Object.freeze({
    id: record.id,
    name: record.name,
    width: record.width,
    height: record.height,
    addedAt: record.addedAt,
    metrics: Object.freeze({ ...record.metrics }),
    derived: Object.freeze({ ...(record.derived ?? {}) }),
    gem,
    url: urlForRecord(record),
  });
}

// Gem policy — honest, relative to the actual library:
//   candidates are photos with quality >= 70 OR in the top 25% by quality,
//   whichever rule marks MORE photos; quality < 40 is never a gem.
function computeGemIds(records) {
  const gemIds = new Set();
  try {
    const eligible = records.filter(
      (record) => (record.metrics?.quality ?? 0) >= 40,
    );
    if (eligible.length === 0) return gemIds;

    const byThreshold = eligible.filter((record) => record.metrics.quality >= 70);

    const sorted = [...eligible].sort(
      (a, b) => b.metrics.quality - a.metrics.quality,
    );
    const topCount = Math.max(1, Math.ceil(records.length * 0.25));
    const cutoff = sorted[Math.min(topCount, sorted.length) - 1].metrics.quality;
    const byTopQuartile = eligible.filter(
      (record) => record.metrics.quality >= cutoff,
    );

    const winners =
      byThreshold.length >= byTopQuartile.length ? byThreshold : byTopQuartile;
    for (const record of winners) gemIds.add(record.id);
  } catch (error) {
    console.info("Gem ranking skipped", error);
  }
  return gemIds;
}

async function getAllRecords() {
  return withStore("readonly", (store) => requestToPromise(store.getAll(), []), []);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Yield control to the event loop so the UI paints and onProgress renders live
// during a long import. Prefers requestIdleCallback (bounded by a timeout so we
// never stall throughput), falls back to a macrotask, and never throws.
function yieldToEventLoop() {
  return new Promise((resolve) => {
    try {
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(() => resolve(), { timeout: 32 });
      } else if (typeof setTimeout === "function") {
        setTimeout(resolve, 0);
      } else {
        resolve();
      }
    } catch {
      resolve();
    }
  });
}

// Persist a batch of analyzed records in a single readwrite transaction. All
// put()s are issued synchronously (so the transaction stays active), and a bad
// record is neutralized (preventDefault) so it can't abort its siblings. A
// failing chunk resolves to [] and the import continues — one chunk never
// breaks the whole import. Returns the records that were committed.
async function persistChunk(chunk) {
  if (!chunk.length) return [];
  const ok = await withStore(
    "readwrite",
    (store) =>
      new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
          if (!settled) {
            settled = true;
            resolve(value);
          }
        };
        try {
          const tx = store.transaction;
          tx.oncomplete = () => finish(true);
          tx.onerror = () => {
            console.info("Photo import chunk failed", tx.error);
            finish(false);
          };
          tx.onabort = () => {
            console.info("Photo import chunk aborted", tx.error);
            finish(false);
          };
          for (const record of chunk) {
            try {
              const req = store.put(record);
              req.onerror = (event) => {
                // Swallow a single bad record so it doesn't abort the chunk.
                try {
                  event.preventDefault();
                } catch {
                  // ignore
                }
                console.info("Photo put skipped for one record", req.error);
              };
            } catch (error) {
              console.info("Photo put skipped for one record", error);
            }
          }
        } catch (error) {
          console.info("Photo import chunk failed", error);
          finish(false);
        }
      }),
    false,
  );
  return ok ? chunk : [];
}

// Import image Files: analyze on-device, persist originals in IndexedDB, and
// return the stored records (without blobs, with object URLs). Built to scale
// to a real camera roll (hundreds to a few thousand photos):
//   - a small async pool (CONCURRENCY) overlaps createImageBitmap/decode
//     without decoding everything at once (bounds peak memory on mobile);
//   - each ImageBitmap is closed immediately after getImageData;
//   - one reusable canvas is resized in place instead of allocated per photo;
//   - analyzed records are buffered and written WRITE_CHUNK at a time (far
//     fewer IndexedDB transactions at scale);
//   - the loop yields to the event loop periodically so the tab never freezes
//     and options.onProgress renders live.
// The metric math is byte-identical to before. Non-image files are skipped
// silently; a failing file or chunk never breaks the batch.
//
// options.onProgress?: ({ done, total, gems }) => void — called periodically,
//   where `done` = image files processed so far, `total` = image files in the
//   batch, and `gems` = running count of likely gems (reconciled to the
//   authoritative gem count in a final call).
export async function importPhotoFiles(fileList, options = {}) {
  const imported = [];
  const onProgress =
    options && typeof options.onProgress === "function" ? options.onProgress : null;
  try {
    const files = Array.from(fileList ?? []);
    const imageFiles = files.filter(
      (file) =>
        file && typeof file.type === "string" && file.type.startsWith("image/"),
    );
    const total = imageFiles.length;

    let done = 0;
    let runningGems = 0;
    let lastEmitted = -1;
    const storedRecords = [];
    let writeBuffer = [];
    // One canvas/context reused across the whole import.
    const canvasHolder = {};

    const emit = (gemsValue) => {
      if (!onProgress) return;
      try {
        onProgress({ done, total, gems: gemsValue ?? runningGems });
      } catch (error) {
        console.info("Photo import progress callback failed", error);
      }
    };

    // Show the total up front so the UI can render its scale immediately.
    emit();

    const flush = async () => {
      if (!writeBuffer.length) return;
      const chunk = writeBuffer;
      writeBuffer = [];
      const committed = await persistChunk(chunk);
      for (const record of committed) storedRecords.push(record);
    };

    let cursor = 0;
    const analyzeNext = async () => {
      while (cursor < imageFiles.length) {
        const file = imageFiles[cursor];
        cursor += 1;
        try {
          const bitmap = await createImageBitmap(file);
          const width = bitmap.width;
          const height = bitmap.height;
          const imageData = drawBitmapToImageData(bitmap, canvasHolder);
          // Free the decoded bitmap the instant its pixels are captured.
          try {
            bitmap.close?.();
          } catch {
            // ignore
          }
          if (imageData) {
            const base = computeMetrics(imageData);
            const metrics = { ...base, quality: computeQuality(base) };
            const record = {
              id: crypto.randomUUID(),
              name: file.name,
              type: file.type,
              blob: file,
              width,
              height,
              addedAt: Date.now(),
              metrics,
            };
            // Provisional running signal (absolute-threshold rule); the
            // authoritative gem set is computed once the batch is complete.
            if (metrics.quality >= 70) runningGems += 1;
            writeBuffer.push(record);
            if (writeBuffer.length >= WRITE_CHUNK) await flush();
          }
        } catch (error) {
          console.info("Photo import skipped for one file", error);
        }

        done += 1;
        if (done - lastEmitted >= PROGRESS_EVERY || done === total) {
          lastEmitted = done;
          emit();
        }
        if (done % YIELD_EVERY === 0) await yieldToEventLoop();
      }
    };

    // Cap in-flight work at the pool size; workers share the file cursor.
    const workerCount = Math.max(1, Math.min(CONCURRENCY, total || 1));
    const workers = [];
    for (let i = 0; i < workerCount; i += 1) workers.push(analyzeNext());
    await Promise.all(workers);

    // Write whatever is left in the buffer.
    await flush();

    // Authoritative, honest gem set over the just-imported batch (quality >= 70
    // OR top 25%, whichever marks more; quality < 40 is never a gem).
    const gemIds = computeGemIds(storedRecords);

    for (const record of storedRecords) {
      imported.push(toPublicRecord(record, gemIds.has(record.id)));
    }

    // Reconcile the live progress number to the authoritative gem count.
    emit(gemIds.size);

    recordTasteEvent("photos_imported", { count: imported.length });

    // Explicit "which were picked and why (quality)" breadcrumb — the future
    // taste model trains on this. We only capture the signal here; no training.
    try {
      const topQuality = [...storedRecords]
        .sort((a, b) => (b.metrics?.quality ?? 0) - (a.metrics?.quality ?? 0))
        .slice(0, 5)
        .map((record) => ({ id: record.id, quality: record.metrics?.quality ?? 0 }));
      recordTasteEvent("gems_selected", {
        total,
        gems: gemIds.size,
        gemIds: Array.from(gemIds).slice(0, 50),
        topQuality,
      });
    } catch (error) {
      console.info("Gem selection signal skipped", error);
    }

    // Additive, decoupled hook: let the first-run Hidden-Gems reveal trigger
    // off a successful import without this module knowing anything about it.
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("gems:photos-imported", {
          detail: { count: imported.length },
        }),
      );
    }
  } catch (error) {
    console.info("Photo import failed", error);
  }
  return imported;
}

// All photos, newest first, with honest gem flags computed against the
// current library.
export async function listPhotos() {
  try {
    const records = await getAllRecords();
    records.sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0));
    const gemIds = computeGemIds(records);
    return records.map((record) => toPublicRecord(record, gemIds.has(record.id)));
  } catch (error) {
    console.info("Photo listing failed", error);
    return [];
  }
}

// One photo in the same public shape, or null.
export async function getPhoto(id) {
  try {
    if (!id) return null;
    const records = await getAllRecords();
    const record = records.find((entry) => entry.id === id);
    if (!record) return null;
    const gemIds = computeGemIds(records);
    return toPublicRecord(record, gemIds.has(record.id));
  } catch (error) {
    console.info("Photo lookup failed", error);
    return null;
  }
}

// Number of stored photos.
export async function photoCount() {
  try {
    return await withStore(
      "readonly",
      (store) => requestToPromise(store.count(), 0),
      0,
    );
  } catch (error) {
    console.info("Photo count failed", error);
    return 0;
  }
}

// Remove a photo and release its cached object URL. (For future use.)
export async function deletePhoto(id) {
  try {
    if (!id) return false;
    const deleted = await withStore(
      "readwrite",
      (store) => requestToPromise(store.delete(id), null).then(() => true),
      false,
    );
    const url = objectUrlCache.get(id);
    if (url) {
      try {
        URL.revokeObjectURL(url);
      } catch (error) {
        console.info("Object URL revoke failed", error);
      }
      objectUrlCache.delete(id);
    }
    return deleted;
  } catch (error) {
    console.info("Photo delete failed", error);
    return false;
  }
}

// Merge a partial `derived` object into a stored record and persist it.
// Used by the ranker to cache model descriptions on-device so each photo is
// only ever described once. Returns true when the merge was persisted.
export async function updatePhotoDerived(id, derived) {
  try {
    if (!id || !derived || typeof derived !== "object") return false;
    return await withStore(
      "readwrite",
      async (store) => {
        const record = await requestToPromise(store.get(id), null);
        if (!record) return false;
        record.derived = { ...(record.derived ?? {}), ...derived };
        return requestToPromise(store.put(record), null).then(() => true);
      },
      false,
    );
  } catch (error) {
    console.info("Photo derived update failed", error);
    return false;
  }
}

// The original stored Blob (full resolution), or null. Deliberately separate
// from the public record shape — listings never carry blobs; this exists for
// thumbnail generation and full-res edit export.
export async function getPhotoBlob(id) {
  try {
    if (!id) return null;
    const record = await withStore(
      "readonly",
      (store) => requestToPromise(store.get(id), null),
      null,
    );
    return record?.blob ?? null;
  } catch (error) {
    console.info("Photo blob lookup failed", error);
    return null;
  }
}

// One honest, metric-grounded sentence about why a photo works (or doesn't).
// We only measure focus, light, and contrast — never subjects or faces — so
// the copy never claims more than the signal processing actually saw.
export function describePhoto(metrics) {
  try {
    const sharpness = metrics?.sharpness ?? 0;
    const brightness = metrics?.brightness ?? 0;
    const contrast = metrics?.contrast ?? 0;

    const sharp = sharpness >= 500;
    const soft = sharpness < 100;
    const dark = brightness < 40;
    const dim = brightness >= 40 && brightness < 80;
    const hot = brightness > 215;
    const bright = brightness > 175 && brightness <= 215;
    const flat = contrast < 25;
    const punchy = contrast >= 60;

    if (sharp && dark) {
      return "Crisp detail hiding in the shadows — the editor's lighting fix would make it shine.";
    }
    if (sharp && hot) {
      return "Sharp but overexposed — pulling the highlights back would recover a strong shot.";
    }
    if (soft && (dark || dim)) {
      return "Soft focus and low light — best kept as a moody filler shot.";
    }
    if (dark) {
      return "Underexposed — the editor's lighting fix would help here.";
    }
    if (hot) {
      return "Blown out in places — worth a pass with the exposure pulled down.";
    }
    if (soft) {
      return "A little soft — could work as a moody filler shot.";
    }
    if (sharp && punchy) {
      return "Tack-sharp with bold contrast — strong crop potential.";
    }
    if (sharp && flat) {
      return "Tack-sharp but flat light — a gentle contrast boost would add depth.";
    }
    if (sharp) {
      return "Tack-sharp with balanced light — strong crop potential.";
    }
    if (flat) {
      return "Even but flat light — a touch more contrast would give it depth.";
    }
    if (bright || dim) {
      return "Decent focus with light leaning off-center — a small exposure nudge would balance it.";
    }
    return "Solid focus and balanced light — a dependable everyday shot.";
  } catch (error) {
    console.info("Photo description failed", error);
    return "A photo from your library.";
  }
}
