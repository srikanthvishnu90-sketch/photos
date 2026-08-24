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

// The full camera-app / Photoshop-style adjustment set. Cheap tonal moves
// (brightness/contrast/saturation) run through the compositor filter; the rest —
// exposure, highlights, shadows, whites, blacks, temperature, tint, vibrance —
// run as a single per-pixel pass; sharpen/blur is a convolution/blur pass; and
// vignette + grain are overlays. Everything is optional: a zero value is skipped.
const ADJUST_KEYS = Object.freeze([
  "exposure", "brightness", "contrast", "highlights", "shadows",
  "whites", "blacks", "saturation", "vibrance", "warmth", "tint",
  "sharpness", "clarity", "vignette", "grain",
]);

function anyPixelWork(a) {
  return (
    a.exposure || a.highlights || a.shadows || a.whites || a.blacks ||
    a.vibrance || a.warmth || a.tint
  );
}

// Smooth 0..1 ramp so highlight/shadow lifts don't band.
function smooth(t) {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

// One per-pixel tone + color pass over ImageData (mutates in place).
function pixelPass(data, a) {
  const exp = Math.pow(2, clampAdj(a.exposure) / 100); // ±1 stop at ±100
  const hi = clampAdj(a.highlights) / 100;
  const sh = clampAdj(a.shadows) / 100;
  const wh = clampAdj(a.whites) / 100;
  const bl = clampAdj(a.blacks) / 100;
  const temp = (clampAdj(a.warmth) / 100) * 46; // ± red/blue shift
  const tnt = (clampAdj(a.tint) / 100) * 40; // ± green/magenta
  const vib = clampAdj(a.vibrance) / 100;
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i] * exp;
    let g = data[i + 1] * exp;
    let b = data[i + 2] * exp;
    // Luma drives the tonal-zone weights.
    const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    if (hi) { const w = smooth((L - 0.5) / 0.5) * hi * 90; r += w; g += w; b += w; }
    if (sh) { const w = smooth((0.5 - L) / 0.5) * sh * 90; r += w; g += w; b += w; }
    if (wh) { const w = smooth((L - 0.7) / 0.3) * wh * 70; r += w; g += w; b += w; }
    if (bl) { const w = smooth((0.3 - L) / 0.3) * bl * 70; r += w; g += w; b += w; }
    if (temp) { r += temp; b -= temp; }
    if (tnt) { r += tnt * 0.5; b += tnt * 0.5; g -= tnt * 0.5; }
    if (vib) {
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const sat = (mx - mn) / 255;
      const amt = vib * (1 - sat); // push muted pixels more than already-vivid ones
      const avg = (r + g + b) / 3;
      r = avg + (r - avg) * (1 + amt);
      g = avg + (g - avg) * (1 + amt);
      b = avg + (b - avg) * (1 + amt);
    }
    data[i] = r < 0 ? 0 : r > 255 ? 255 : r;
    data[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
    data[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
  }
}

// 3x3 sharpen (unsharp) convolution. amount 0..1. Returns new Uint8ClampedArray.
function sharpen(src, w, h, amount) {
  const out = new Uint8ClampedArray(src.length);
  const k = amount * 0.8;
  const center = 1 + 4 * k;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        const up = y > 0 ? src[o - w * 4 + c] : src[o + c];
        const dn = y < h - 1 ? src[o + w * 4 + c] : src[o + c];
        const lf = x > 0 ? src[o - 4 + c] : src[o + c];
        const rt = x < w - 1 ? src[o + 4 + c] : src[o + c];
        out[o + c] = center * src[o + c] - k * (up + dn + lf + rt);
      }
      out[o + 3] = src[o + 3];
    }
  }
  return out;
}

function paintFull(bitmap, adjust = {}) {
  try {
    const a = {};
    for (const key of ADJUST_KEYS) a[key] = clampAdj(adjust[key]);
    const w = bitmap.width || bitmap.naturalWidth || 0;
    const h = bitmap.height || bitmap.naturalHeight || 0;
    if (!w || !h) return null;
    const canvas = makeCanvas(w, h);
    if (!canvas) return null;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    // Pass 1 — brightness/contrast/saturation via the compositor filter, plus a
    // negative-sharpness blur (CSS blur only softens; positive sharpen is below).
    const blurPx = a.sharpness < 0 ? (Math.abs(a.sharpness) / 100) * 4 : 0;
    ctx.filter =
      baseFilter({ brightness: a.brightness, contrast: a.contrast, saturation: a.saturation }) +
      (blurPx ? ` blur(${blurPx.toFixed(2)}px)` : "");
    ctx.drawImage(bitmap, 0, 0, w, h);
    ctx.filter = "none";

    // Pass 2 — per-pixel tone + color, and positive sharpen.
    const needsPixels = anyPixelWork(a) || a.sharpness > 0;
    if (needsPixels) {
      let img;
      try {
        img = ctx.getImageData(0, 0, w, h);
      } catch (error) {
        console.info("getImageData blocked (tainted canvas?)", error);
        img = null;
      }
      if (img) {
        if (anyPixelWork(a)) pixelPass(img.data, a);
        if (a.sharpness > 0) {
          const sharper = sharpen(img.data, w, h, a.sharpness / 100);
          img.data.set(sharper);
        }
        ctx.putImageData(img, 0, 0);
      }
    }

    // Pass 3 — vignette (darken or lighten the corners).
    if (a.vignette) {
      const cx = w / 2, cy = h / 2;
      const outer = Math.hypot(cx, cy);
      const grad = ctx.createRadialGradient(cx, cy, outer * 0.55, cx, cy, outer);
      const strength = Math.min(0.85, Math.abs(a.vignette) / 100 * 0.85);
      if (a.vignette > 0) {
        grad.addColorStop(0, "rgba(0,0,0,0)");
        grad.addColorStop(1, `rgba(0,0,0,${strength})`);
      } else {
        grad.addColorStop(0, "rgba(255,255,255,0)");
        grad.addColorStop(1, `rgba(255,255,255,${strength})`);
      }
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    }

    // Pass 4 — film grain (monochrome noise, soft-light).
    if (a.grain > 0) {
      const amt = (a.grain / 100) * 40;
      const noise = ctx.createImageData(w, h);
      const nd = noise.data;
      // Deterministic pseudo-noise (no Math.random — keeps re-encodes stable).
      let seed = 0x9e3779b9;
      for (let i = 0; i < nd.length; i += 4) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const v = 128 + (((seed >>> 24) / 255) * 2 - 1) * amt;
        nd[i] = nd[i + 1] = nd[i + 2] = v;
        nd[i + 3] = 255;
      }
      const grainCanvas = makeCanvas(w, h);
      grainCanvas?.getContext("2d")?.putImageData(noise, 0, 0);
      if (grainCanvas) {
        ctx.globalCompositeOperation = "soft-light";
        ctx.globalAlpha = 0.6;
        ctx.drawImage(grainCanvas, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
      }
    }
    return canvas;
  } catch (error) {
    console.info("paintFull failed", error);
    return null;
  }
}

/**
 * Apply the full tonal + color + detail adjustment set and return a JPEG Blob
 * (quality 0.92). Accepts the camera-app keys (all -100..100, 0 = neutral):
 * exposure, brightness, contrast, highlights, shadows, whites, blacks,
 * saturation, vibrance, warmth, tint, sharpness (negative = blur), vignette,
 * grain. Deterministic; runs fully on-device.
 * @param {ImageBitmap|HTMLImageElement} bitmap
 * @param {object} adjust
 * @returns {Blob|null}
 */
export function applyAdjust(bitmap, adjust = {}) {
  const canvas = paintFull(bitmap, adjust);
  if (!canvas) return null;
  return encodeCanvas(canvas, "image/jpeg", 0.92);
}

/**
 * Geometry: rotate in 90° steps and/or flip. `rotate` is degrees (any multiple
 * of 90; other values are snapped). Returns a JPEG Blob.
 * @param {ImageBitmap|HTMLImageElement} bitmap
 * @param {{rotate?:number, flipH?:boolean, flipV?:boolean}} ops
 * @returns {Blob|null}
 */
export function applyGeometry(bitmap, ops = {}) {
  try {
    if (!bitmap) return null;
    const w = bitmap.width || bitmap.naturalWidth || 0;
    const h = bitmap.height || bitmap.naturalHeight || 0;
    if (!w || !h) return null;
    let deg = Math.round((Number(ops.rotate) || 0) / 90) * 90;
    deg = ((deg % 360) + 360) % 360;
    const swap = deg === 90 || deg === 270;
    const canvas = makeCanvas(swap ? h : w, swap ? w : h);
    if (!canvas) return null;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((deg * Math.PI) / 180);
    ctx.scale(ops.flipH ? -1 : 1, ops.flipV ? -1 : 1);
    ctx.drawImage(bitmap, -w / 2, -h / 2, w, h);
    return encodeCanvas(canvas, "image/jpeg", 0.92);
  } catch (error) {
    console.info("applyGeometry failed", error);
    return null;
  }
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
