// gems-canvas.js — the real, client-side image engine behind GEMS manual
// editing (Master Features #5). Pure canvas operations: load a Blob into a
// drawable bitmap, apply brightness/contrast/saturation/warmth adjustments,
// crop in pixel space, and one-tap aesthetic grades derived from the eight
// onboarding looks.
//
// Everything runs fully on-device — no backend, works offline. Every browser
// API is guarded so a Node `import` (used by smoke tests) never throws at load
// and every function returns null rather than throwing on failure.

// ---------------------------------------------------------------------------
// Small guarded helpers
// ---------------------------------------------------------------------------

const hasDocument = typeof document !== "undefined" && !!document.createElement;

function clampAdj(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-100, Math.min(100, n));
}

// Build a 2D drawing surface. Prefers a real <canvas> (has toDataURL, which we
// use for a synchronous, deterministic encode) and falls back to OffscreenCanvas
// only for feature detection. Returns null when neither is available (Node).
function makeCanvas(w, h) {
  const width = Math.max(1, Math.round(w || 1));
  const height = Math.max(1, Math.round(h || 1));
  try {
    if (hasDocument) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      return canvas;
    }
    if (typeof OffscreenCanvas !== "undefined") {
      return new OffscreenCanvas(width, height);
    }
  } catch (error) {
    console.info("Canvas creation failed", error);
  }
  return null;
}

// Synchronous, deterministic dataURL → Blob (avoids the async toBlob callback so
// the adjust/crop/grade functions can return a Blob directly).
function dataUrlToBlob(dataUrl) {
  try {
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return null;
    const header = dataUrl.slice(0, comma);
    const body = dataUrl.slice(comma + 1);
    const mimeMatch = /:(.*?);/.exec(header);
    const mime = mimeMatch ? mimeMatch[1] : "image/jpeg";
    const isBase64 = /;base64/i.test(header);
    const binary = isBase64
      ? (typeof atob === "function" ? atob(body) : "")
      : decodeURIComponent(body);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  } catch (error) {
    console.info("dataUrl → Blob failed", error);
    return null;
  }
}

// Encode a canvas to a JPEG Blob at the given quality. Returns null on failure.
function encodeCanvas(canvas, type = "image/jpeg", quality = 0.92) {
  try {
    if (!canvas || typeof canvas.toDataURL !== "function") return null;
    const dataUrl = canvas.toDataURL(type, quality);
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return null;
    return dataUrlToBlob(dataUrl);
  } catch (error) {
    console.info("Canvas encode failed", error);
    return null;
  }
}

// The CSS filter used for the actual pixel render — brightness/contrast/
// saturation only. Warmth is a separate tint pass for a truer result.
function baseFilter(adjust = {}) {
  const b = clampAdj(adjust.brightness);
  const c = clampAdj(adjust.contrast);
  const s = clampAdj(adjust.saturation);
  return (
    `brightness(${(1 + b / 100).toFixed(3)}) ` +
    `contrast(${(1 + c / 100).toFixed(3)}) ` +
    `saturate(${(1 + s / 100).toFixed(3)})`
  );
}

// Paint a bitmap into a canvas with adjustments + an optional grade tint.
// Warmth is applied as a multiply overlay (warm tint vs. cool tint); grade
// tints use soft-light for a filmic wash. Returns the canvas, or null.
function paintAdjust(bitmap, adjust = {}, tint = null) {
  try {
    if (!bitmap) return null;
    const w = bitmap.width || bitmap.naturalWidth || 0;
    const h = bitmap.height || bitmap.naturalHeight || 0;
    if (!w || !h) return null;
    const canvas = makeCanvas(w, h);
    if (!canvas) return null;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    // Pass 1 — tonal adjustments via the compositor's filter.
    ctx.filter = baseFilter(adjust);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    ctx.filter = "none";

    // Pass 2 — warmth as a gentle multiply tint.
    const warmth = clampAdj(adjust.warmth);
    if (warmth !== 0) {
      ctx.globalCompositeOperation = "multiply";
      ctx.globalAlpha = Math.min(0.5, (Math.abs(warmth) / 100) * 0.5);
      ctx.fillStyle = warmth > 0 ? "rgb(255, 214, 170)" : "rgb(170, 202, 255)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }

    // Pass 3 — optional grade tint (soft-light keeps highlights/shadows).
    if (tint && tint.color) {
      const alpha = Math.max(0, Math.min(1, Number(tint.alpha) || 0));
      if (alpha > 0) {
        ctx.globalCompositeOperation = "soft-light";
        ctx.globalAlpha = alpha;
        ctx.fillStyle = tint.color;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
      }
    }
    return canvas;
  } catch (error) {
    console.info("paintAdjust failed", error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decode a Blob into a drawable bitmap. Prefers createImageBitmap and falls
 * back to an <img> element (both are valid drawImage sources with width/height).
 * @param {Blob} blob
 * @returns {Promise<ImageBitmap|HTMLImageElement|null>}
 */
export async function loadBitmap(blob) {
  if (!blob) return null;
  try {
    if (typeof createImageBitmap === "function") {
      return await createImageBitmap(blob);
    }
  } catch (error) {
    console.info("createImageBitmap failed, falling back to <img>", error);
  }
  if (!hasDocument || typeof URL === "undefined" || !URL.createObjectURL) {
    return null;
  }
  return new Promise((resolve) => {
    let url = "";
    const img = new Image();
    const cleanup = () => {
      try {
        if (url) URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
    };
    img.onload = () => {
      cleanup();
      resolve(img);
    };
    img.onerror = () => {
      cleanup();
      resolve(null);
    };
    try {
      url = URL.createObjectURL(blob);
      img.decoding = "async";
      img.src = url;
    } catch (error) {
      console.info("Image fallback failed", error);
      cleanup();
      resolve(null);
    }
  });
}

/**
 * Apply tonal adjustments and return a JPEG Blob (quality 0.92). Deterministic.
 * @param {ImageBitmap|HTMLImageElement} bitmap
 * @param {{brightness?:number, contrast?:number, saturation?:number, warmth?:number}} adjust
 * @returns {Blob|null}
 */
export function applyAdjust(bitmap, adjust = {}) {
  const canvas = paintAdjust(bitmap, adjust, null);
  if (!canvas) return null;
  return encodeCanvas(canvas, "image/jpeg", 0.92);
}

/**
 * Crop a rectangle (in bitmap pixel space) and return a JPEG Blob. The rect is
 * validated and clamped to the bitmap bounds; an empty rect returns null.
 * @param {ImageBitmap|HTMLImageElement} bitmap
 * @param {{x:number, y:number, w:number, h:number}} rect
 * @returns {Blob|null}
 */
export function applyCrop(bitmap, rect = {}) {
  try {
    if (!bitmap) return null;
    const natW = bitmap.width || bitmap.naturalWidth || 0;
    const natH = bitmap.height || bitmap.naturalHeight || 0;
    if (!natW || !natH) return null;

    let x = Math.round(Number(rect.x) || 0);
    let y = Math.round(Number(rect.y) || 0);
    let w = Math.round(Number(rect.w) || 0);
    let h = Math.round(Number(rect.h) || 0);

    // Clamp origin into bounds, then clamp size to what remains.
    x = Math.max(0, Math.min(x, natW - 1));
    y = Math.max(0, Math.min(y, natH - 1));
    w = Math.max(1, Math.min(w, natW - x));
    h = Math.max(1, Math.min(h, natH - y));
    if (w < 1 || h < 1) return null;

    const canvas = makeCanvas(w, h);
    if (!canvas) return null;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, x, y, w, h, 0, 0, w, h);
    return encodeCanvas(canvas, "image/jpeg", 0.92);
  } catch (error) {
    console.info("applyCrop failed", error);
    return null;
  }
}

/**
 * The eight onboarding aesthetics as one-tap grades. Each entry carries an
 * `adjust` (brightness/contrast/saturation/warmth, all -100..100) and an
 * optional `tint` overlay {color, alpha}.
 */
export const FILTER_GRADES = Object.freeze([
  {
    key: "dark-gym",
    label: "Dark Gym",
    adjust: { brightness: -18, contrast: 28, saturation: -22, warmth: -18 },
    tint: { color: "#2a3550", alpha: 0.1 },
  },
  {
    key: "golden-hour",
    label: "Golden Hour",
    adjust: { brightness: 6, contrast: -10, saturation: 14, warmth: 35 },
    tint: { color: "#ffb257", alpha: 0.14 },
  },
  {
    key: "euro-summer",
    label: "Euro Summer",
    adjust: { brightness: 16, contrast: 4, saturation: 20, warmth: 22 },
    tint: { color: "#ffd08a", alpha: 0.08 },
  },
  {
    key: "clean-editorial",
    label: "Clean Editorial",
    adjust: { brightness: 4, contrast: 16, saturation: -8, warmth: 0 },
    tint: null,
  },
  {
    key: "nightlife",
    label: "Nightlife",
    adjust: { brightness: -14, contrast: 34, saturation: 6, warmth: -24 },
    tint: { color: "#241a3a", alpha: 0.16 },
  },
  {
    key: "film",
    label: "Film",
    adjust: { brightness: 4, contrast: -14, saturation: -4, warmth: 14 },
    tint: { color: "#e9d8b8", alpha: 0.1 },
  },
  {
    key: "coastal",
    label: "Coastal",
    adjust: { brightness: 14, contrast: -8, saturation: 4, warmth: -6 },
    tint: { color: "#bfe0ff", alpha: 0.08 },
  },
  {
    key: "streetwear",
    label: "Streetwear",
    adjust: { brightness: 0, contrast: 30, saturation: 26, warmth: -4 },
    tint: null,
  },
]);

/**
 * Apply a FILTER_GRADES entry (adjust + optional tint) and return a JPEG Blob.
 * @param {ImageBitmap|HTMLImageElement} bitmap
 * @param {{adjust?:object, tint?:object}} grade
 * @returns {Blob|null}
 */
export function applyGrade(bitmap, grade = {}) {
  const canvas = paintAdjust(bitmap, grade.adjust || {}, grade.tint || null);
  if (!canvas) return null;
  return encodeCanvas(canvas, "image/jpeg", 0.92);
}

/**
 * The equivalent CSS `filter` string for a set of adjustments — used for a
 * live, re-encode-free preview on an <img> while the user drags. Warmth is
 * approximated (sepia for warm, a slight hue-rotate for cool). Always returns
 * a valid, non-empty filter string.
 * @param {{brightness?:number, contrast?:number, saturation?:number, warmth?:number}} adjust
 * @returns {string}
 */
export function cssFilterFor(adjust = {}) {
  const b = clampAdj(adjust.brightness);
  const c = clampAdj(adjust.contrast);
  const s = clampAdj(adjust.saturation);
  const w = clampAdj(adjust.warmth);
  const parts = [
    `brightness(${(1 + b / 100).toFixed(3)})`,
    `contrast(${(1 + c / 100).toFixed(3)})`,
    `saturate(${(1 + s / 100).toFixed(3)})`,
  ];
  if (w > 0) {
    parts.push(`sepia(${((w / 100) * 0.35).toFixed(3)})`);
  } else if (w < 0) {
    parts.push(`hue-rotate(${((w / 100) * 12).toFixed(1)}deg)`);
    parts.push(`saturate(${(1 + (-w / 100) * 0.05).toFixed(3)})`);
  }
  return parts.join(" ");
}
