// gems-enrich.js — the background "make everything work" pass.
//
// After a user imports photos, this quietly runs every on-device intelligence
// pass so 'best photos', 'photos of me', semantic search, and Memories just work
// with nothing to find or turn on (the founder's call: automatic, in background).
// All on-device except the analysis pass (Pass A), which needs a session and is
// cost-capped. Fully guarded, sequential to avoid thrashing the device, and a
// singleton so overlapping imports don't stack. Never throws.
import { listPhotos, getPhotoBlob } from "./gems-photolib.js";
import { loadBitmap } from "./gems-canvas.js";
import { enrollBatch, canRecognizeFaces } from "./gems-faces.js";
import { indexBatch, canEmbed } from "./gems-embeddings.js";
import { ensureCaptureMeta } from "./gems-memories.js";
import { ensureDescriptions } from "./gems-ranker.js";
import { getSession } from "./gems-supabase.js";

let running = false;

async function loadBitmapFor(id) {
  const blob = await getPhotoBlob(id);
  return blob ? loadBitmap(blob) : null;
}

/**
 * Run the on-device intelligence passes over the library (capped). Safe to call
 * repeatedly — each pass skips already-processed photos, and a run in progress
 * is a no-op. Fire-and-forget: callers never await it.
 */
export async function enrichLibrary({ limit = 200, faceLimit = 80, indexLimit = 80 } = {}) {
  if (running) return;
  running = true;
  try {
    const records = await listPhotos();
    if (!Array.isArray(records) || !records.length) return;
    const ids = records.map((r) => r.id);

    // 1) EXIF capture meta (cheap) — dates + locations for Memories & ordering.
    try { await ensureCaptureMeta(records, getPhotoBlob, limit); } catch (e) { console.info("enrich: capture meta", e); }

    // 2) Faces (on-device) — powers 'of me' + identity-locked generation.
    try { if (canRecognizeFaces()) await enrollBatch(ids, loadBitmapFor, faceLimit); } catch (e) { console.info("enrich: faces", e); }

    // 3) CLIP index (on-device) — powers semantic search + perceptual dedup.
    try { if (canEmbed()) await indexBatch(ids, getPhotoBlob, indexLimit); } catch (e) { console.info("enrich: index", e); }

    // 4) Analysis / Pass A (needs a session; metered + capped) — powers best_type,
    //    appeal, vibe tags. Only when signed in; degrades to cached otherwise.
    try {
      if (await getSession()) await ensureDescriptions(records);
    } catch (e) { console.info("enrich: analysis", e); }
  } catch (error) {
    console.info("enrichLibrary skipped", error);
  } finally {
    running = false;
  }
}

/** Wire the automatic run to the import event (idempotent listener). */
let wired = false;
export function autoEnrichOnImport() {
  if (wired || typeof window === "undefined") return;
  wired = true;
  window.addEventListener("gems:photos-imported", () => {
    // Let the reveal/UI settle a beat, then enrich in the background.
    window.setTimeout(() => void enrichLibrary(), 800);
  });
}
