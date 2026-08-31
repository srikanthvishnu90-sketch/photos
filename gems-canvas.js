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
  "sharpness", "clarity", "dehaze", "vignette", "grain",
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

function paintFull(bitmap, adjust = {}, opts = {}) {
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
    // Dehaze folds into contrast + saturation (haze is low-contrast, low-color).
    const blurPx = a.sharpness < 0 ? (Math.abs(a.sharpness) / 100) * 4 : 0;
    ctx.filter =
      baseFilter({
        brightness: a.brightness,
        contrast: a.contrast + a.dehaze * 0.5,
        saturation: a.saturation + a.dehaze * 0.35,
      }) + (blurPx ? ` blur(${blurPx.toFixed(2)}px)` : "");
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

    // Pass 2b — Clarity: large-radius local contrast (midtone punch). Blur a
    // copy, then push each pixel away from its local average by `clarity`.
    if (a.clarity) {
      try {
        const blurCanvas = makeCanvas(w, h);
        const bctx = blurCanvas?.getContext("2d");
        if (bctx) {
          const radius = Math.max(2, Math.round(Math.min(w, h) / 55));
          bctx.filter = `blur(${radius}px)`;
          bctx.drawImage(canvas, 0, 0);
          const lo = bctx.getImageData(0, 0, w, h).data;
          const cur = ctx.getImageData(0, 0, w, h);
          const cd = cur.data;
          const amt = (a.clarity / 100) * 0.8;
          for (let i = 0; i < cd.length; i += 4) {
            cd[i] += (cd[i] - lo[i]) * amt;
            cd[i + 1] += (cd[i + 1] - lo[i + 1]) * amt;
            cd[i + 2] += (cd[i + 2] - lo[i + 2]) * amt;
          }
          ctx.putImageData(cur, 0, 0);
        }
      } catch (error) {
        console.info("clarity pass skipped", error);
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

    // Pass 4 — film grain. Deferred when this is one link in a grade chain, so
    // grain lands AFTER halation (grain is always the last thing that happens
    // to a frame, in a camera and on film alike).
    if (a.grain > 0 && !opts.deferGrain) {
      grainPass(ctx, w, h, { amount: a.grain });
    }

    return canvas;
  } catch (error) {
    console.info("paintFull failed", error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Film physics — grain, halation and three-way colour grading.
//
// These three are why a "look" can't be a colour mapping. A LUT maps every
// input colour to one output colour identically across the frame; halation
// depends on WHERE the highlights are, and grain is a live structure with its
// own statistics. So they are passes, not presets. See the Grade Engine
// research doc, specs 01-02.
// ---------------------------------------------------------------------------

/**
 * Film/sensor grain, modelled rather than overlaid.
 *
 * Real noise is (a) luminance-dependent — coarse in the shadows, finer through
 * the midtones, nearly absent in speculars — and (b) per-channel, because a
 * Bayer sensor and a three-layer emulsion both carry slightly different noise
 * in R, G and B. Flat monochrome noise composited across the whole frame is the
 * single most recognisable "grain overlay" tell, which is exactly what this
 * replaces.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} w
 * @param {number} h
 * @param {{amount?:number, shadowBias?:number, chroma?:number, seed?:number}} params
 *   amount 0..100; shadowBias 0..1 (how much heavier grain runs in the shadows);
 *   chroma 0..1 (0 = pure luminance noise, 1 = fully independent per channel).
 */
function grainPass(ctx, w, h, params = {}) {
  try {
    const amount = clampAdj(params.amount);
    if (amount <= 0) return;
    const shadowBias = params.shadowBias == null ? 0.75 : Math.max(0, Math.min(1, params.shadowBias));
    const chroma = params.chroma == null ? 0.35 : Math.max(0, Math.min(1, params.chroma));
    const scale = (amount / 100) * 34; // peak ±levels at amount 100
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    // Deterministic PRNG — a recipe must replay identically every time.
    let seed = (params.seed == null ? 0x9e3779b9 : params.seed) >>> 0;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return (seed >>> 8) / 8388608 - 1; // -1..1
    };
    for (let i = 0; i < d.length; i += 4) {
      const L = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      // Amplitude curve: heaviest in the low tones, dying out in the speculars.
      const shadowW = 1 - smooth((L - 0.05) / 0.5);
      const specW = 1 - smooth((L - 0.7) / 0.3);
      const amp = specW * (0.55 + shadowBias * shadowW) * scale;
      if (amp <= 0) continue;
      const luma = rnd() * amp;
      if (chroma <= 0) {
        d[i] += luma; d[i + 1] += luma; d[i + 2] += luma;
      } else {
        // Green carries the least noise on a Bayer sensor (twice the photosites).
        d[i] += luma + rnd() * amp * chroma;
        d[i + 1] += luma + rnd() * amp * chroma * 0.6;
        d[i + 2] += luma + rnd() * amp * chroma * 1.15;
      }
    }
    ctx.putImageData(img, 0, 0);
  } catch (error) {
    console.info("grainPass skipped", error);
  }
}

/**
 * Halation — light punching through the emulsion, reflecting off the film base
 * and re-exposing from behind. It is red-weighted, it is tied to the intensity
 * of each individual highlight, and it only blooms where the light was strong
 * enough to make the round trip. (Remjet backing suppresses it; stripping that
 * backing is exactly why CineStill halates so hard.)
 *
 * Three steps: threshold the highlights above a knee, blur that mask, screen it
 * back with a red-dominant weighting.
 *
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas
 * @param {CanvasRenderingContext2D} ctx
 * @param {{knee?:number, radius?:number, strength?:number, hue?:[number,number,number]}} params
 *   knee 0..1 luminance where halation starts; radius 0..100 (% of the short
 *   edge, scaled); strength 0..100; hue = per-channel weighting.
 */
function halationPass(canvas, ctx, params = {}) {
  try {
    const strength = clampAdj(params.strength);
    if (strength <= 0) return;
    const w = canvas.width;
    const h = canvas.height;
    const knee = params.knee == null ? 0.72 : Math.max(0, Math.min(0.99, params.knee));
    const radiusPct = params.radius == null ? 18 : Math.max(1, Math.min(100, params.radius));
    const hue = Array.isArray(params.hue) && params.hue.length === 3
      ? params.hue
      : [1, 0.32, 0.18]; // red-weighted, as real halation is
    const src = ctx.getImageData(0, 0, w, h);
    const sd = src.data;
    const halo = ctx.createImageData(w, h);
    const hd = halo.data;
    let lit = false;
    for (let i = 0; i < sd.length; i += 4) {
      const L = (0.2126 * sd[i] + 0.7152 * sd[i + 1] + 0.0722 * sd[i + 2]) / 255;
      if (L <= knee) { hd[i + 3] = 255; continue; }
      // Intensity above the knee, squared — only genuinely bright light blooms.
      const t = (L - knee) / (1 - knee);
      const e = t * t * 255;
      hd[i] = e * hue[0];
      hd[i + 1] = e * hue[1];
      hd[i + 2] = e * hue[2];
      hd[i + 3] = 255;
      lit = true;
    }
    if (!lit) return;
    const haloCanvas = makeCanvas(w, h);
    const hctx = haloCanvas?.getContext("2d");
    if (!hctx) return;
    hctx.putImageData(halo, 0, 0);
    // Blur it in a second buffer (filter applies on draw, not on putImageData).
    const blurCanvas = makeCanvas(w, h);
    const bctx = blurCanvas?.getContext("2d");
    if (!bctx) return;
    const radius = Math.max(2, (radiusPct / 100) * Math.min(w, h) * 0.09);
    bctx.filter = `blur(${radius.toFixed(2)}px)`;
    bctx.drawImage(haloCanvas, 0, 0);
    bctx.filter = "none";
    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = Math.min(1, strength / 100);
    ctx.drawImage(blurCanvas, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  } catch (error) {
    console.info("halationPass skipped", error);
  }
}

/**
 * Three-way colour grading — shadows, midtones and highlights tinted
 * independently. This is what replaced two-way split toning, precisely because
 * midtones needed their own control, and it is most of what people mean when
 * they say a photo looks "graded" rather than "filtered": warm highlights
 * opposed by cool shadows, with the midtones (and therefore skin) left honest.
 *
 * A flat full-frame tint — the thing this replaces — lifts the blacks, dulls
 * the whites and dirties the skin all at once.
 *
 * @param {Uint8ClampedArray} data
 * @param {{shadows?:object, midtones?:object, highlights?:object, balance?:number}} g3
 *   each zone { h: 0..360, s: 0..100, l: -100..100 }; balance -100..100 shifts
 *   the pivot between the shadow and highlight zones.
 */
function threeWayPass(data, g3 = {}) {
  const zones = [];
  for (const key of ["shadows", "midtones", "highlights"]) {
    const z = g3[key];
    if (!z || (!z.s && !z.l)) continue;
    const [r, g, b] = hslToRgb(((Number(z.h) || 0) % 360 + 360) % 360, 1, 0.5);
    zones.push({
      key,
      // Direction away from neutral grey, scaled by saturation.
      dr: (r - 128) / 128,
      dg: (g - 128) / 128,
      db: (b - 128) / 128,
      s: Math.max(0, Math.min(100, Number(z.s) || 0)) / 100,
      l: clampAdj(z.l) / 100,
    });
  }
  if (!zones.length) return;
  const balance = clampAdj(g3.balance) / 100;
  const pivot = 0.5 + balance * 0.25;
  const SCALE = 58; // levels of tint at s=100 inside a zone
  for (let i = 0; i < data.length; i += 4) {
    const L = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    let r = data[i], g = data[i + 1], b = data[i + 2];
    for (const z of zones) {
      let w;
      if (z.key === "shadows") w = 1 - smooth(L / Math.max(0.05, pivot));
      else if (z.key === "highlights") w = smooth((L - pivot) / Math.max(0.05, 1 - pivot));
      else w = 1 - Math.abs(L - pivot) / Math.max(0.05, Math.max(pivot, 1 - pivot));
      if (w <= 0) continue;
      if (z.s) {
        const k = w * z.s * SCALE;
        r += z.dr * k; g += z.dg * k; b += z.db * k;
      }
      if (z.l) {
        const k = w * z.l * 70;
        r += k; g += k; b += k;
      }
    }
    data[i] = r < 0 ? 0 : r > 255 ? 255 : r;
    data[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
    data[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
  }
}

/** Build a 256-entry LUT from piecewise-linear control points in 0..255. */
function lutFromPoints(points) {
  const pts = Array.isArray(points) && points.length >= 2
    ? [...points].sort((a, b) => a[0] - b[0])
    : [[0, 0], [255, 255]];
  const lut = new Uint8ClampedArray(256);
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    while (j < pts.length - 2 && i > pts[j + 1][0]) j += 1;
    const [x0, y0] = pts[j];
    const [x1, y1] = pts[j + 1];
    const t = x1 === x0 ? 0 : (i - x0) / (x1 - x0);
    lut[i] = y0 + (y1 - y0) * Math.max(0, Math.min(1, t));
  }
  return lut;
}

/**
 * Apply a grade's curve block in place: a luminance curve for the shape of the
 * contrast, plus optional per-channel RGB curves for casts and lifted blacks.
 * @param {Uint8ClampedArray} data
 * @param {{luma?:Array, r?:Array, g?:Array, b?:Array}} curve
 */
function curvePass(data, curve = {}) {
  const luma = curve.luma ? lutFromPoints(curve.luma) : null;
  const rl = curve.r ? lutFromPoints(curve.r) : null;
  const gl = curve.g ? lutFromPoints(curve.g) : null;
  const bl = curve.b ? lutFromPoints(curve.b) : null;
  if (!luma && !rl && !gl && !bl) return;
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i], g = data[i + 1], b = data[i + 2];
    if (luma) { r = luma[r]; g = luma[g]; b = luma[b]; }
    if (rl) r = rl[r];
    if (gl) g = gl[g];
    if (bl) b = bl[b];
    data[i] = r; data[i + 1] = g; data[i + 2] = b;
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
 * Composite a painted overlay canvas on top of the photo and return a JPEG Blob.
 * The overlay is stretched to the bitmap's pixel size (callers paint at natural
 * resolution, so it's 1:1). Used by the Draw and Text tools — fully on-device.
 * @param {ImageBitmap|HTMLImageElement} bitmap
 * @param {HTMLCanvasElement} overlay
 * @returns {Blob|null}
 */
export function applyOverlay(bitmap, overlay, blendMode = "source-over") {
  try {
    if (!bitmap) return null;
    const w = bitmap.width || bitmap.naturalWidth || 0;
    const h = bitmap.height || bitmap.naturalHeight || 0;
    if (!w || !h) return null;
    const canvas = makeCanvas(w, h);
    if (!canvas) return null;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, w, h);
    if (overlay) {
      // A blend mode (e.g. "soft-light" for Dodge & Burn) composites the painted
      // layer tonally instead of just pasting it on top.
      ctx.globalCompositeOperation = blendMode;
      ctx.drawImage(overlay, 0, 0, w, h);
      ctx.globalCompositeOperation = "source-over";
    }
    return encodeCanvas(canvas, "image/jpeg", 0.92);
  } catch (error) {
    console.info("applyOverlay failed", error);
    return null;
  }
}

function smooth01(t) {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

/**
 * Build a feathered selection mask heuristically (no ML): "sky", "foreground",
 * "bright", or "dark". Returns a canvas of white pixels with per-pixel alpha =
 * selection strength, for use as the mask in applyMaskedAdjust / applyPortraitBlur.
 * @param {ImageBitmap|HTMLImageElement} bitmap
 * @param {"sky"|"foreground"|"bright"|"dark"} type
 * @returns {HTMLCanvasElement|null}
 */
export function buildAutoMask(bitmap, type = "sky") {
  try {
    if (!bitmap) return null;
    const w = bitmap.width || bitmap.naturalWidth || 0;
    const h = bitmap.height || bitmap.naturalHeight || 0;
    if (!w || !h) return null;
    const src = makeCanvas(w, h);
    const sctx = src?.getContext("2d");
    if (!sctx) return null;
    sctx.drawImage(bitmap, 0, 0, w, h);
    let img;
    try {
      img = sctx.getImageData(0, 0, w, h);
    } catch (error) {
      console.info("buildAutoMask getImageData blocked", error);
      return null;
    }
    const d = img.data;
    const out = makeCanvas(w, h);
    const octx = out?.getContext("2d");
    if (!octx) return null;
    const o = octx.createImageData(w, h);
    const od = o.data;
    const skyness = (hue, sat, lum, y) => {
      const posW = Math.max(0, 1 - (y / h) / 0.62); // upper ~62% of the frame
      const blueish = hue >= 185 && hue <= 260 ? Math.min(1, sat * 2 + 0.3) : 0;
      const brightLow = lum > 0.6 && sat < 0.35 ? 1 : 0;
      return posW * Math.max(blueish, brightLow);
    };
    for (let i = 0, px = 0; i < d.length; i += 4, px += 1) {
      const y = (px / w) | 0;
      const [hue, sat, lum] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
      let weight = 0;
      if (type === "sky") weight = skyness(hue, sat, lum, y);
      else if (type === "foreground") weight = 1 - skyness(hue, sat, lum, y);
      else if (type === "bright") weight = smooth01((lum - 0.55) / 0.3);
      else if (type === "dark") weight = smooth01((0.45 - lum) / 0.3);
      od[i] = 255;
      od[i + 1] = 255;
      od[i + 2] = 255;
      od[i + 3] = Math.max(0, Math.min(255, weight * 255));
    }
    octx.putImageData(o, 0, 0);
    return out;
  } catch (error) {
    console.info("buildAutoMask failed", error);
    return null;
  }
}

// Keep `layer`'s pixels only inside (or, if invert, outside) a white alpha mask.
function maskLayer(layer, mask, invert) {
  const lctx = layer.getContext("2d");
  if (!lctx) return;
  lctx.globalCompositeOperation = invert ? "destination-out" : "destination-in";
  lctx.drawImage(mask, 0, 0, layer.width, layer.height);
  lctx.globalCompositeOperation = "source-over";
}

/**
 * Local adjustment: apply the full adjust pipeline, then composite the result
 * over the original ONLY where the mask is painted (feathered). `invert` applies
 * it everywhere EXCEPT the mask. The mask is a canvas with white = affected.
 * @param {ImageBitmap|HTMLImageElement} bitmap
 * @param {object} adjust
 * @param {HTMLCanvasElement} mask
 * @param {boolean} [invert]
 * @returns {Blob|null}
 */
export function applyMaskedAdjust(bitmap, adjust, mask, invert = false) {
  try {
    if (!bitmap || !mask) return null;
    const w = bitmap.width || bitmap.naturalWidth || 0;
    const h = bitmap.height || bitmap.naturalHeight || 0;
    if (!w || !h) return null;
    const layer = paintFull(bitmap, adjust); // adjusted full image (a canvas)
    if (!layer) return null;
    maskLayer(layer, mask, invert);
    const out = makeCanvas(w, h);
    const octx = out?.getContext("2d");
    if (!octx) return null;
    octx.drawImage(bitmap, 0, 0, w, h);
    octx.drawImage(layer, 0, 0);
    return encodeCanvas(out, "image/jpeg", 0.92);
  } catch (error) {
    console.info("applyMaskedAdjust failed", error);
    return null;
  }
}

/**
 * Portrait / lens blur: keep the focus mask sharp and blur everything else
 * (or the reverse if invert). `radiusPx` is the blur radius in image pixels.
 * @param {ImageBitmap|HTMLImageElement} bitmap
 * @param {HTMLCanvasElement} mask  white = the in-focus subject
 * @param {number} radiusPx
 * @param {boolean} [invert]  blur INSIDE the mask instead
 * @returns {Blob|null}
 */
export function applyPortraitBlur(bitmap, mask, radiusPx = 8, invert = false) {
  try {
    if (!bitmap || !mask) return null;
    const w = bitmap.width || bitmap.naturalWidth || 0;
    const h = bitmap.height || bitmap.naturalHeight || 0;
    if (!w || !h) return null;
    const blurred = makeCanvas(w, h);
    const bctx = blurred?.getContext("2d");
    if (!bctx) return null;
    bctx.filter = `blur(${Math.max(0.5, radiusPx)}px)`;
    bctx.drawImage(bitmap, 0, 0, w, h);
    bctx.filter = "none";
    // Sharp original, kept only in the focus region, laid over the blurred base.
    const sharp = makeCanvas(w, h);
    const sctx = sharp?.getContext("2d");
    if (!sctx) return null;
    sctx.drawImage(bitmap, 0, 0, w, h);
    maskLayer(sharp, mask, invert); // keep sharp inside focus (invert → outside)
    const out = makeCanvas(w, h);
    const octx = out?.getContext("2d");
    if (!octx) return null;
    octx.drawImage(blurred, 0, 0);
    octx.drawImage(sharp, 0, 0);
    return encodeCanvas(out, "image/jpeg", 0.92);
  } catch (error) {
    console.info("applyPortraitBlur failed", error);
    return null;
  }
}

// Run a 256-entry lookup table over R/G/B (used by Curves and Levels).
function applyLut(bitmap, lut) {
  try {
    const w = bitmap.width || bitmap.naturalWidth || 0;
    const h = bitmap.height || bitmap.naturalHeight || 0;
    if (!w || !h) return null;
    const canvas = makeCanvas(w, h);
    if (!canvas) return null;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, w, h);
    let img;
    try {
      img = ctx.getImageData(0, 0, w, h);
    } catch (error) {
      console.info("getImageData blocked", error);
      return null;
    }
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = lut[d[i]];
      d[i + 1] = lut[d[i + 1]];
      d[i + 2] = lut[d[i + 2]];
    }
    ctx.putImageData(img, 0, 0);
    return encodeCanvas(canvas, "image/jpeg", 0.92);
  } catch (error) {
    console.info("applyLut failed", error);
    return null;
  }
}

/**
 * Tone curve. `points` is an array of [x, y] control points in 0..255 (sorted by
 * x, endpoints included), remapping input tone x → output tone y. Piecewise-
 * linear between points. Returns a JPEG Blob.
 * @param {ImageBitmap|HTMLImageElement} bitmap
 * @param {Array<[number, number]>} points
 * @returns {Blob|null}
 */
export function applyCurve(bitmap, points) {
  try {
    if (!bitmap) return null;
    const pts =
      Array.isArray(points) && points.length >= 2
        ? [...points].sort((a, b) => a[0] - b[0])
        : [[0, 0], [255, 255]];
    const lut = new Uint8ClampedArray(256);
    let j = 0;
    for (let i = 0; i < 256; i += 1) {
      while (j < pts.length - 2 && i > pts[j + 1][0]) j += 1;
      const [x0, y0] = pts[j];
      const [x1, y1] = pts[j + 1];
      const t = x1 === x0 ? 0 : (i - x0) / (x1 - x0);
      lut[i] = y0 + (y1 - y0) * Math.max(0, Math.min(1, t));
    }
    return applyLut(bitmap, lut);
  } catch (error) {
    console.info("applyCurve failed", error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// HSL / Color Mix — per color-range hue/saturation/luminance (Lightroom-style)
// ---------------------------------------------------------------------------

// The eight color bands and their hue centers (degrees).
export const HSL_BANDS = Object.freeze([
  { key: "red", label: "Red", center: 0 },
  { key: "orange", label: "Orange", center: 30 },
  { key: "yellow", label: "Yellow", center: 60 },
  { key: "green", label: "Green", center: 120 },
  { key: "aqua", label: "Aqua", center: 180 },
  { key: "blue", label: "Blue", center: 240 },
  { key: "purple", label: "Purple", center: 285 },
  { key: "magenta", label: "Magenta", center: 330 },
]);

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  let h = 0;
  const l = (mx + mn) / 2;
  const d = mx - mn;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

// Triangular weight: how strongly a hue belongs to a band center (wrap-aware).
function bandWeight(h, center, half) {
  let d = Math.abs(h - center);
  if (d > 180) d = 360 - d;
  return d >= half ? 0 : 1 - d / half;
}

function activeBandsFrom(bands) {
  return HSL_BANDS.map((band) => ({ ...band, adj: bands[band.key] })).filter(
    (band) => band.adj && (band.adj.h || band.adj.s || band.adj.l),
  );
}

// Per-pixel HSL pass over an ImageData buffer (shared by applyHsl and grades
// that carry an `hsl` block, e.g. After Dark's greens→emerald / blues→navy).
function hslPass(data, activeBands, half = 40) {
  for (let i = 0; i < data.length; i += 4) {
    let [hue, sat, lum] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    if (sat < 0.02) continue; // near-gray → no meaningful hue
    let hShift = 0;
    let satAcc = 0;
    let lumAcc = 0;
    for (const band of activeBands) {
      const weight = bandWeight(hue, band.center, half);
      if (weight <= 0) continue;
      hShift += ((band.adj.h || 0) / 100) * 30 * weight;
      satAcc += ((band.adj.s || 0) / 100) * weight;
      lumAcc += ((band.adj.l || 0) / 100) * weight;
    }
    if (hShift === 0 && satAcc === 0 && lumAcc === 0) continue;
    hue = (hue + hShift + 360) % 360;
    sat = Math.max(0, Math.min(1, sat * (1 + satAcc)));
    lum = Math.max(0, Math.min(1, lum + lumAcc * 0.5));
    const [r, g, b] = hslToRgb(hue, sat, lum);
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }
}

/**
 * Per-color-range HSL. `bands` maps a band key (red/orange/yellow/green/aqua/
 * blue/purple/magenta) to { h, s, l } in -100..100 (hue shift, saturation,
 * luminance). Returns a JPEG Blob; a no-op set returns a faithful re-encode.
 * @param {ImageBitmap|HTMLImageElement} bitmap
 * @param {Record<string,{h?:number,s?:number,l?:number}>} bands
 * @returns {Blob|null}
 */
export function applyHsl(bitmap, bands = {}) {
  try {
    if (!bitmap) return null;
    const active = activeBandsFrom(bands);
    const w = bitmap.width || bitmap.naturalWidth || 0;
    const h = bitmap.height || bitmap.naturalHeight || 0;
    if (!w || !h) return null;
    const canvas = makeCanvas(w, h);
    if (!canvas) return null;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, w, h);
    if (!active.length) return encodeCanvas(canvas, "image/jpeg", 0.92);
    let img;
    try {
      img = ctx.getImageData(0, 0, w, h);
    } catch (error) {
      console.info("getImageData blocked", error);
      return encodeCanvas(canvas, "image/jpeg", 0.92);
    }
    hslPass(img.data, active);
    ctx.putImageData(img, 0, 0);
    return encodeCanvas(canvas, "image/jpeg", 0.92);
  } catch (error) {
    console.info("applyHsl failed", error);
    return null;
  }
}

/**
 * Multiply each channel by a gain — the math behind a white-balance eyedropper
 * (scale R/G/B so a tapped neutral point becomes gray).
 * @param {ImageBitmap|HTMLImageElement} bitmap
 * @param {[number, number, number]} gains  per-channel multipliers
 * @returns {Blob|null}
 */
export function applyChannelGains(bitmap, gains = [1, 1, 1]) {
  try {
    if (!bitmap) return null;
    const rf = Number(gains[0]) || 1;
    const gf = Number(gains[1]) || 1;
    const bf = Number(gains[2]) || 1;
    const w = bitmap.width || bitmap.naturalWidth || 0;
    const h = bitmap.height || bitmap.naturalHeight || 0;
    if (!w || !h) return null;
    const canvas = makeCanvas(w, h);
    if (!canvas) return null;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, w, h);
    let img;
    try {
      img = ctx.getImageData(0, 0, w, h);
    } catch (error) {
      console.info("getImageData blocked", error);
      return encodeCanvas(canvas, "image/jpeg", 0.92);
    }
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = d[i] * rf;
      d[i + 1] = d[i + 1] * gf;
      d[i + 2] = d[i + 2] * bf;
    }
    ctx.putImageData(img, 0, 0);
    return encodeCanvas(canvas, "image/jpeg", 0.92);
  } catch (error) {
    console.info("applyChannelGains failed", error);
    return null;
  }
}

/**
 * Levels: remap tones between a black point and white point with a midtone gamma.
 * @param {ImageBitmap|HTMLImageElement} bitmap
 * @param {{black?:number, white?:number, gamma?:number}} levels  black/white 0..255, gamma 0.1..3
 * @returns {Blob|null}
 */
export function applyLevels(bitmap, levels = {}) {
  try {
    if (!bitmap) return null;
    let black = Math.max(0, Math.min(254, Number(levels.black) || 0));
    let white = Math.max(black + 1, Math.min(255, Number(levels.white) ?? 255));
    const gamma = Math.max(0.1, Math.min(3, Number(levels.gamma) || 1));
    const inv = 1 / gamma;
    const lut = new Uint8ClampedArray(256);
    const span = white - black;
    for (let i = 0; i < 256; i += 1) {
      let v = (i - black) / span;
      v = Math.max(0, Math.min(1, v));
      lut[i] = Math.pow(v, inv) * 255;
    }
    return applyLut(bitmap, lut);
  } catch (error) {
    console.info("applyLevels failed", error);
    return null;
  }
}

// One keystone pass: scale each strip along `axis` by a factor that ramps across
// the perpendicular axis (strip-based approximation of a projective warp).
function keystonePass(source, w, h, amount, vertical) {
  const canvas = makeCanvas(w, h);
  const ctx = canvas?.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, w, h); // fill gaps with the un-warped image
  const k = (amount / 100) * 0.3;
  const strips = 220;
  if (vertical) {
    for (let s = 0; s < strips; s += 1) {
      const y0 = (s / strips) * h;
      const sh = h / strips + 1;
      const t = (s + 0.5) / strips;
      const scale = 1 + k * (t - 0.5) * 2; // top narrower/wider than bottom
      const sw = w * scale;
      ctx.drawImage(source, 0, y0, w, sh, (w - sw) / 2, y0, sw, sh);
    }
  } else {
    for (let s = 0; s < strips; s += 1) {
      const x0 = (s / strips) * w;
      const sw = w / strips + 1;
      const t = (s + 0.5) / strips;
      const scale = 1 + k * (t - 0.5) * 2;
      const sh = h * scale;
      ctx.drawImage(source, x0, 0, sw, h, x0, (h - sh) / 2, sw, sh);
    }
  }
  return canvas;
}

/**
 * Perspective / keystone correction. `vertical` fixes converging verticals
 * (tilted-up buildings), `horizontal` fixes converging horizontals. Both -100..100.
 * @param {ImageBitmap|HTMLImageElement} bitmap
 * @param {{vertical?:number, horizontal?:number}} ops
 * @returns {Blob|null}
 */
export function applyPerspective(bitmap, ops = {}) {
  try {
    if (!bitmap) return null;
    const w = bitmap.width || bitmap.naturalWidth || 0;
    const h = bitmap.height || bitmap.naturalHeight || 0;
    if (!w || !h) return null;
    const v = clampAdj(ops.vertical);
    const hz = clampAdj(ops.horizontal);
    let current = bitmap;
    if (v) current = keystonePass(current, w, h, v, true) || current;
    if (hz) current = keystonePass(current, w, h, hz, false) || current;
    if (current === bitmap) {
      const c = makeCanvas(w, h);
      c?.getContext("2d")?.drawImage(bitmap, 0, 0, w, h);
      return c ? encodeCanvas(c, "image/jpeg", 0.92) : null;
    }
    return encodeCanvas(current, "image/jpeg", 0.92);
  } catch (error) {
    console.info("applyPerspective failed", error);
    return null;
  }
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
  // ---------------------------------------------------------------------
  // The looks. Each one is a full recipe, not a filter: tone, a curve for the
  // SHAPE of the contrast, per-band HSL, and three-way colour grading that
  // tints the shadows, midtones and highlights separately. Film physics
  // (grain, halation) where the look calls for it.
  //
  // Two rules run through all of them:
  //   1. Skin is protected. The orange band is never pushed hard, so faces stay
  //      faces while the rest of the frame is graded.
  //   2. No flat full-frame tint. Warm highlights opposed by cool shadows is
  //      what reads as "graded"; one hue washed over everything is what reads
  //      as a cheap filter.
  // ---------------------------------------------------------------------
  {
    key: "dark-gym",
    label: "Dark Gym",
    adjust: {
      exposure: -14, contrast: 26, highlights: -18, shadows: -20, whites: -6,
      blacks: -14, saturation: -26, vibrance: -6, warmth: -14, clarity: 22,
      sharpness: 10, vignette: 18,
    },
    curve: { luma: [[0, 0], [48, 32], [128, 126], [208, 224], [255, 255]] },
    hsl: {
      red: { s: -10 }, orange: { s: -6, l: -4 }, yellow: { s: -24 },
      green: { s: -30, l: -20 }, blue: { s: -18, l: -16 },
    },
    grade3: {
      shadows: { h: 212, s: 22 }, midtones: { h: 210, s: 6 },
      highlights: { h: 200, s: 8, l: -4 }, balance: -8,
    },
    // Hard gym light doesn't bloom — contrast and steel, no halation.
    film: { grain: { amount: 12, shadowBias: 0.85, chroma: 0.25 } },
  },
  {
    key: "golden-hour",
    label: "Golden Hour",
    adjust: {
      exposure: 6, contrast: -4, highlights: -30, shadows: 20, whites: 6,
      blacks: -4, saturation: 8, vibrance: 16, warmth: 26, clarity: -4,
      vignette: 8,
    },
    curve: { luma: [[0, 10], [60, 60], [128, 134], [198, 208], [255, 254]] },
    hsl: {
      orange: { s: 12, l: 6 }, yellow: { h: -8, s: 18, l: 6 },
      green: { h: 14, s: -16 }, blue: { h: 6, s: -10, l: -10 },
    },
    grade3: {
      shadows: { h: 250, s: 14 }, midtones: { h: 32, s: 8 },
      highlights: { h: 38, s: 30 }, balance: 10,
    },
    // The whole point of golden hour is light blooming off a low sun.
    film: {
      grain: { amount: 8, shadowBias: 0.8, chroma: 0.35 },
      halation: { knee: 0.7, radius: 22, strength: 34 },
    },
  },
  {
    key: "euro-summer",
    label: "Euro Summer",
    adjust: {
      exposure: 10, contrast: 6, highlights: -22, shadows: 16, whites: 8,
      blacks: -6, saturation: 6, vibrance: 14, warmth: 14, tint: 2,
      clarity: 6, sharpness: 4, vignette: 4,
    },
    curve: { luma: [[0, 8], [64, 62], [128, 132], [196, 204], [255, 252]] },
    hsl: {
      orange: { s: 6, l: 4 }, yellow: { h: -6, s: 14, l: 8 },
      green: { h: 12, s: -14, l: 6 }, aqua: { s: 16, l: -4 },
      blue: { h: -6, s: 18, l: -6 },
    },
    grade3: {
      shadows: { h: 205, s: 16 }, midtones: { h: 35, s: 5 },
      highlights: { h: 44, s: 22 }, balance: 6,
    },
    film: {
      grain: { amount: 9, shadowBias: 0.7, chroma: 0.3 },
      halation: { knee: 0.8, radius: 14, strength: 16 },
    },
  },
  {
    key: "clean-editorial",
    label: "Clean Editorial",
    adjust: {
      exposure: 4, contrast: 14, highlights: -14, shadows: 8, whites: 10,
      blacks: -8, saturation: -8, vibrance: 6, clarity: 10, sharpness: 8,
    },
    curve: { luma: [[0, 0], [64, 58], [128, 130], [192, 200], [255, 255]] },
    hsl: {
      orange: { s: 4, l: 2 }, yellow: { s: -12 },
      green: { s: -18, l: -4 }, blue: { s: -6, l: -4 },
    },
    grade3: {
      shadows: { h: 220, s: 8 }, highlights: { h: 40, s: 6 }, balance: 0,
    },
    film: { grain: { amount: 5, shadowBias: 0.6, chroma: 0.2 } },
  },
  {
    key: "nightlife",
    label: "Nightlife",
    adjust: {
      exposure: -18, contrast: 30, highlights: -24, shadows: -10, whites: -10,
      blacks: -16, saturation: 10, vibrance: 12, warmth: -16, clarity: 14,
      sharpness: 6, vignette: 22,
    },
    curve: { luma: [[0, 4], [48, 30], [128, 124], [206, 226], [255, 252]] },
    hsl: {
      orange: { s: -4 }, green: { s: -34, l: -24 }, aqua: { s: 18, l: -6 },
      blue: { h: -8, s: 16, l: -10 }, purple: { s: 20 },
      magenta: { s: 24, l: 4 },
    },
    grade3: {
      shadows: { h: 196, s: 26 }, midtones: { h: 280, s: 8 },
      highlights: { h: 322, s: 24 }, balance: -6,
    },
    // Neon bleeds. Lower knee, wider radius, and the halo pulled toward
    // magenta rather than the pure red of daylight halation.
    film: {
      grain: { amount: 20, shadowBias: 0.9, chroma: 0.45 },
      halation: { knee: 0.62, radius: 26, strength: 48, hue: [1, 0.28, 0.42] },
    },
  },
  {
    key: "film",
    label: "Film",
    adjust: {
      exposure: 2, contrast: -6, highlights: -18, shadows: 12, whites: -8,
      blacks: 8, saturation: -6, vibrance: 8, warmth: 10, clarity: -2,
    },
    // The stock look lives in the curve: a lifted toe for matte blacks and a
    // rolled shoulder, with opposing per-channel toes (warm shadow, cool
    // highlight rolloff) — which is what print emulation actually is.
    curve: {
      luma: [[0, 20], [56, 66], [128, 132], [200, 204], [255, 244]],
      r: [[0, 12], [128, 130], [255, 252]],
      b: [[0, 16], [128, 124], [255, 246]],
    },
    hsl: {
      orange: { s: 6, l: 4 }, yellow: { h: -6, s: 8 },
      green: { h: 10, s: -20, l: 4 }, blue: { h: 6, s: -8, l: -6 },
    },
    grade3: {
      shadows: { h: 214, s: 14 }, midtones: { h: 36, s: 6 },
      highlights: { h: 42, s: 16 }, balance: 4,
    },
    film: {
      grain: { amount: 26, shadowBias: 0.8, chroma: 0.4 },
      halation: { knee: 0.74, radius: 18, strength: 26 },
    },
  },
  {
    key: "coastal",
    label: "Coastal",
    adjust: {
      exposure: 12, contrast: -8, highlights: -20, shadows: 22, whites: 10,
      blacks: 4, saturation: 2, vibrance: 12, warmth: -6, tint: -2,
      clarity: -4, sharpness: 4,
    },
    curve: { luma: [[0, 14], [64, 70], [128, 134], [196, 206], [255, 252]] },
    hsl: {
      orange: { s: 4, l: 4 }, yellow: { s: -8, l: 6 },
      green: { h: 16, s: -14, l: 6 }, aqua: { s: 22, l: 4 },
      blue: { h: -8, s: 20, l: 2 },
    },
    grade3: {
      shadows: { h: 206, s: 16 }, midtones: { h: 190, s: 4 },
      highlights: { h: 48, s: 10 }, balance: 8,
    },
    film: { grain: { amount: 6, shadowBias: 0.6, chroma: 0.25 } },
  },
  {
    key: "streetwear",
    label: "Streetwear",
    adjust: {
      exposure: -4, contrast: 28, highlights: -20, shadows: -6, whites: 4,
      blacks: -14, saturation: 12, vibrance: 18, warmth: -6, clarity: 20,
      sharpness: 12, vignette: 10,
    },
    curve: { luma: [[0, 0], [52, 36], [128, 128], [204, 220], [255, 255]] },
    hsl: {
      red: { s: 16 }, orange: { s: 6, l: -2 }, yellow: { s: -10 },
      green: { s: -24, l: -12 }, blue: { h: -6, s: 14, l: -10 },
    },
    grade3: {
      shadows: { h: 218, s: 20 }, highlights: { h: 30, s: 10 }, balance: -4,
    },
    film: { grain: { amount: 10, shadowBias: 0.75, chroma: 0.3 } },
  },
  // "After Dark" (internal codename "Dark Batman") — moody luxury, low-exposure.
  // The single client-side definition of this grade; the values below are the
  // web-prototype mapping of the founder's Lightroom recipe (exposure ~−1 stop,
  // tamed highlights/whites, deep-but-clean blacks, global mute, navy split-tone,
  // subtle vignette, no grain). `aliases` route described edits ("after dark",
  // "moody", "batman vibe") here; `aiStyle` is the grade block for AI edits
  // (mirrored into supabase/functions/edit-photo/index.ts).
  {
    key: "after-dark",
    label: "After Dark",
    aliases: ["after dark", "quiet money", "batman", "dark batman", "moody luxury", "dark aesthetic", "moody"],
    adjust: {
      exposure: -52,
      brightness: -8,
      contrast: 12,
      highlights: -42,
      whites: -18,
      shadows: -14,
      blacks: -10,
      saturation: -25,
      vibrance: -10,
      warmth: -8,
      sharpness: 6,
      vignette: 14,
    },
    tint: { color: "#0d1826", alpha: 0.16 },
    // Per-channel color moves from the recipe, now native (not just approximated):
    // foliage → dark emerald, skies → navy, skin protected (muted only slightly).
    hsl: {
      green: { h: -6, s: -30, l: -40 },
      blue: { s: -35, l: -25 },
      orange: { s: -8 },
    },
    aiStyle:
      "STYLE — After Dark (moody luxury, low-exposure): Re-grade the photo, do not " +
      "regenerate it. Pull overall exposure down roughly one stop so the scene reads " +
      "dusk-like even if shot in daylight. Compress highlights: skies become steel-blue " +
      "or navy with retained gradient detail, never white and never clipped. Deepen " +
      "shadows and blacks but keep them CLEAN and keep the subject's silhouette readable " +
      "— deliberate low-key, not underexposure. Desaturate globally about 25%, pushing " +
      "greens toward dark emerald and blues toward navy; protect skin tones, muting them " +
      "only slightly. Slightly cool color temperature. No added grain, no matte/faded " +
      "lift, no vignette heavier than subtle. Preserve the subject's exact facial " +
      "identity, pose, clothing, and composition. Mood: quiet, expensive, cinematic — a " +
      "lone figure against light, wealth in shadow. Do not crush shadow detail into pure " +
      "black. Do not add film grain. Do not blow or tint highlights orange. Do not " +
      "brighten the sky.",
  },
]);

// Which adjust keys require the full per-pixel pipeline (paintFull) rather than
// the cheap 4-key paintAdjust — so richer grades like After Dark render fully.
const RICH_ADJUST_KEYS = Object.freeze([
  "exposure", "highlights", "shadows", "whites", "blacks", "vibrance", "sharpness", "vignette", "grain",
]);

/**
 * Apply a FILTER_GRADES entry (adjust + optional tint) and return a JPEG Blob.
 * @param {ImageBitmap|HTMLImageElement} bitmap
 * @param {{adjust?:object, tint?:object}} grade
 * @returns {Blob|null}
 */
/**
 * Downscale a bitmap to a working resolution for PREVIEW rendering.
 *
 * The v2 grade chain is several per-pixel passes deep, so its cost scales with
 * megapixels: a 12MP phone photo measures ~2.5s for the heaviest look on
 * desktop Chromium, and worse on a phone. Nobody needs 12MP to decide whether
 * they like a look, so previews run capped and only the committed version is
 * rendered at full size. Returns the original untouched when it already fits.
 *
 * @param {ImageBitmap|HTMLImageElement|HTMLCanvasElement} bitmap
 * @param {number} maxEdge long-side cap in px
 * @returns {ImageBitmap|HTMLCanvasElement} the original, or a downscaled canvas
 */
export function fitForPreview(bitmap, maxEdge = 1600) {
  try {
    if (!bitmap) return bitmap;
    const w = bitmap.width || bitmap.naturalWidth || 0;
    const h = bitmap.height || bitmap.naturalHeight || 0;
    if (!w || !h) return bitmap;
    const long = Math.max(w, h);
    if (long <= maxEdge) return bitmap;
    const scale = maxEdge / long;
    const canvas = makeCanvas(Math.round(w * scale), Math.round(h * scale));
    const ctx = canvas?.getContext("2d");
    if (!ctx) return bitmap;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas;
  } catch (error) {
    console.info("fitForPreview failed, using full size", error);
    return bitmap;
  }
}

export function applyGrade(bitmap, grade = {}) {
  const adjust = grade.adjust || {};
  // A grade takes the full pipeline if it moves any of the rich tonal keys, or
  // if it carries any of the v2 layers (curve / three-way / film physics).
  const rich =
    RICH_ADJUST_KEYS.some((key) => adjust[key]) ||
    !!grade.curve || !!grade.grade3 || !!grade.film;
  let canvas;
  if (rich) {
    const film = grade.film || {};
    const wantsHalation = !!(film.halation && film.halation.strength);
    // Grain must land after halation, so defer it out of paintFull when this
    // grade has film physics of its own.
    const deferGrain = wantsHalation || !!film.grain;
    canvas = paintFull(bitmap, adjust, { deferGrain });
    const ctx = canvas?.getContext("2d");
    if (ctx && canvas) {
      const w = canvas.width;
      const h = canvas.height;
      // One read/write for every per-pixel layer: curve → HSL → three-way.
      const activeBands = grade.hsl ? activeBandsFrom(grade.hsl) : [];
      const needsPixelLayers = !!grade.curve || activeBands.length > 0 || !!grade.grade3;
      if (needsPixelLayers) {
        try {
          const img = ctx.getImageData(0, 0, w, h);
          if (grade.curve) curvePass(img.data, grade.curve);
          if (activeBands.length) hslPass(img.data, activeBands);
          if (grade.grade3) threeWayPass(img.data, grade.grade3);
          ctx.putImageData(img, 0, 0);
        } catch (error) {
          console.info("grade pixel layers skipped", error);
        }
      }
      // Legacy flat tint. Kept so saved presets and After Dark are untouched;
      // new looks express colour through `grade3` instead, which tints the
      // tonal zones separately rather than washing the whole frame.
      if (grade.tint?.color && grade.tint.alpha) {
        ctx.globalCompositeOperation = "soft-light";
        ctx.globalAlpha = Math.max(0, Math.min(1, Number(grade.tint.alpha) || 0));
        ctx.fillStyle = grade.tint.color;
        ctx.fillRect(0, 0, w, h);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
      }
      if (wantsHalation) halationPass(canvas, ctx, film.halation);
      if (deferGrain) {
        const g = film.grain || {};
        grainPass(ctx, w, h, {
          amount: g.amount == null ? clampAdj(adjust.grain) : g.amount,
          shadowBias: g.shadowBias,
          chroma: g.chroma,
          seed: g.seed,
        });
      }
    }
  } else {
    // The simple path, for grades that are genuinely just four numbers.
    canvas = paintAdjust(bitmap, adjust, grade.tint || null);
  }
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
/**
 * Replay a "recipe" — an ordered list of parametric ops — onto a photo. Each op
 * is { op, params }: "adjust", "grade" ({key}), "curve", "levels", "hsl",
 * "gains". Brush/position ops aren't in recipes (they can't transfer between
 * photos). Returns the final JPEG Blob, or null if nothing applied.
 * @param {ImageBitmap|HTMLImageElement} bitmap
 * @param {Array<{op:string, params:any}>} ops
 * @returns {Promise<Blob|null>}
 */
export async function applyRecipe(bitmap, ops) {
  try {
    if (!bitmap || !Array.isArray(ops) || !ops.length) return null;
    let current = bitmap;
    let lastBlob = null;
    for (const entry of ops) {
      let blob = null;
      const p = entry?.params;
      switch (entry?.op) {
        case "adjust":
          blob = applyAdjust(current, p || {});
          break;
        case "grade": {
          const grade = FILTER_GRADES.find((g) => g.key === p?.key);
          if (grade) blob = applyGrade(current, grade);
          break;
        }
        case "curve":
          blob = applyCurve(current, p);
          break;
        case "levels":
          blob = applyLevels(current, p || {});
          break;
        case "hsl":
          blob = applyHsl(current, p || {});
          break;
        case "gains":
          blob = applyChannelGains(current, p || [1, 1, 1]);
          break;
        default:
          blob = null;
      }
      if (blob) {
        lastBlob = blob;
        const next = await loadBitmap(blob);
        if (next) current = next;
      }
    }
    return lastBlob;
  } catch (error) {
    console.info("applyRecipe failed", error);
    return null;
  }
}

export function cssFilterFor(adjust = {}) {
  const b = clampAdj(adjust.brightness);
  const c = clampAdj(adjust.contrast);
  const s = clampAdj(adjust.saturation);
  const w = clampAdj(adjust.warmth);
  const exp = clampAdj(adjust.exposure);
  // Fold exposure into brightness (multiplicative) so grades like After Dark
  // preview correctly on the <img> without a re-encode.
  const brightness = (1 + b / 100) * Math.pow(2, exp / 100);
  const parts = [
    `brightness(${brightness.toFixed(3)})`,
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
