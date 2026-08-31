// gems-lighting.js — turn ONE generated base image into 5 lighting "looks" fully
// ON-DEVICE, so a batch dump costs one model call per SCENE, never one per look.
//
// The whole point of the batch flow's economics: 6 scenes × 5 lighting variants
// would be 30 paid pro generations (and the free tier is ONE request capped at
// 10 images). Instead we generate a neutral daylight base per scene and re-grade
// it into 5 moods with the existing canvas engine — instant, free, deterministic.
//
// Honesty: these are colour/mood grades of the same frame, not a physical
// relight (sky geometry and cast shadows don't move). The UI copy says "looks",
// not "re-lit".
import { FILTER_GRADES, applyGrade, fitForPreview } from "./gems-canvas.js";

// The 5 looks, in display order. `grade` is a FILTER_GRADES key, or null for the
// base frame shown as-is (Midday). All keys below exist in gems-canvas.js.
export const BATCH_LIGHTS = Object.freeze([
  { key: "dawn", label: "Dawn", grade: "film" },
  { key: "midday", label: "Midday", grade: null },
  { key: "golden", label: "Golden hour", grade: "golden-hour" },
  { key: "dusk", label: "Dusk", grade: "nightlife" },
  { key: "night", label: "Night", grade: "after-dark" },
]);

// Default pick = Golden hour (index 2), matching the mockup.
export const DEFAULT_LIGHT_INDEX = 2;

// Never let a batch multiply into a runaway number of paid base generations.
export const BATCH_MAX_SCENES = 6;

function gradeByKey(key) {
  return FILTER_GRADES.find((g) => g.key === key) || null;
}

/**
 * Produce the 5 lighting looks for one base image.
 * @param {string} baseUrl - a signed URL (or object URL) for the generated base.
 * @returns {Promise<Array<{ key, label, url, revocable }>>} one entry per look.
 *   Midday reuses baseUrl (revocable:false); the rest are fresh object URLs
 *   (revocable:true) the caller must URL.revokeObjectURL when discarding a scene.
 *   On any failure a look falls back to the base URL so the row is never empty.
 */
export async function lightingVariants(baseUrl) {
  const out = BATCH_LIGHTS.map((l) => ({ key: l.key, label: l.label, url: baseUrl, revocable: false }));
  let bitmap = null;
  try {
    const res = await fetch(baseUrl);
    const blob = await res.blob();
    // Capped: these five looks are regraded for viewing, and the chain costs
    // real time per megapixel.
    bitmap = fitForPreview(await createImageBitmap(blob), 1600);
  } catch (error) {
    console.info("lightingVariants: base unavailable, using base for all looks", error);
    return out;
  }
  for (let i = 0; i < BATCH_LIGHTS.length; i++) {
    const light = BATCH_LIGHTS[i];
    if (!light.grade) continue; // Midday = base as-is
    try {
      const grade = gradeByKey(light.grade);
      const graded = grade ? applyGrade(bitmap, grade) : null;
      if (graded) {
        out[i] = { key: light.key, label: light.label, url: URL.createObjectURL(graded), revocable: true };
      }
    } catch (error) {
      console.info(`lightingVariants: ${light.key} grade failed, using base`, error);
    }
  }
  bitmap.close?.();
  return out;
}

// Revoke any object URLs a scene's variants created (call on redo / close).
export function revokeVariants(variants) {
  for (const v of variants || []) {
    if (v?.revocable && v.url) {
      try { URL.revokeObjectURL(v.url); } catch { /* ignore */ }
    }
  }
}
