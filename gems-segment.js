// gems-segment.js — true on-device person segmentation for the "Person" mask.
// Lazily loads MediaPipe Tasks Vision (ESM) + the Selfie Segmenter model from a
// CDN the first time it's used (same pattern as the Supabase client). Everything
// is guarded: if the model can't load or run, segmentPerson() returns null and
// the caller falls back to the heuristic "Subject" mask. Nothing here throws.

const VISION_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
const WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";

const SEG_EDGE = 512; // segment at 512px for speed, then scale the mask up

let segmenterPromise = null;

async function getSegmenter() {
  if (segmenterPromise) return segmenterPromise;
  segmenterPromise = (async () => {
    const vision = await import(/* @vite-ignore */ VISION_URL);
    const { ImageSegmenter, FilesetResolver } = vision;
    const files = await FilesetResolver.forVisionTasks(WASM_BASE);
    return ImageSegmenter.createFromOptions(files, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
      runningMode: "IMAGE",
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    });
  })().catch((error) => {
    console.info("Person segmenter unavailable — falling back", error);
    segmenterPromise = null; // allow a later retry
    return null;
  });
  return segmenterPromise;
}

/** Is on-device person segmentation possible in this browser at all? */
export function canSegment() {
  return typeof WebAssembly !== "undefined" && typeof createImageBitmap !== "undefined";
}

/**
 * Segment the person/foreground in a photo. Returns a mask canvas at the photo's
 * natural resolution (white with per-pixel alpha = person confidence), or null
 * on any failure so the caller can fall back.
 * @param {ImageBitmap|HTMLImageElement} bitmap
 * @returns {Promise<HTMLCanvasElement|null>}
 */
export async function segmentPerson(bitmap) {
  try {
    if (!bitmap || !canSegment()) return null;
    const seg = await getSegmenter();
    if (!seg) return null;
    const natW = bitmap.width || bitmap.naturalWidth || 0;
    const natH = bitmap.height || bitmap.naturalHeight || 0;
    if (!natW || !natH) return null;
    const scale = Math.min(1, SEG_EDGE / Math.max(natW, natH));
    const sw = Math.max(1, Math.round(natW * scale));
    const sh = Math.max(1, Math.round(natH * scale));
    const small = document.createElement("canvas");
    small.width = sw;
    small.height = sh;
    small.getContext("2d")?.drawImage(bitmap, 0, 0, sw, sh);

    const result = seg.segment(small);
    const conf = result?.confidenceMasks?.[0];
    if (!conf) {
      result?.close?.();
      return null;
    }
    const w = conf.width;
    const h = conf.height;
    const probs = conf.getAsFloat32Array();
    // Build a small mask (white + alpha), then upscale to natural resolution.
    const maskSmall = document.createElement("canvas");
    maskSmall.width = w;
    maskSmall.height = h;
    const mctx = maskSmall.getContext("2d");
    if (!mctx) {
      result?.close?.();
      return null;
    }
    const img = mctx.createImageData(w, h);
    const md = img.data;
    for (let i = 0, j = 0; i < probs.length; i += 1, j += 4) {
      md[j] = 255;
      md[j + 1] = 255;
      md[j + 2] = 255;
      md[j + 3] = Math.max(0, Math.min(255, probs[i] * 255));
    }
    mctx.putImageData(img, 0, 0);
    result?.close?.();

    const out = document.createElement("canvas");
    out.width = natW;
    out.height = natH;
    const octx = out.getContext("2d");
    if (!octx) return null;
    octx.imageSmoothingEnabled = true;
    octx.drawImage(maskSmall, 0, 0, natW, natH); // upscale, feathering the edge
    return out;
  } catch (error) {
    console.info("segmentPerson failed", error);
    return null;
  }
}
