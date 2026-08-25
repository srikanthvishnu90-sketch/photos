// gems-share.js — shareable taste profile card + Instagram two-tap export.
// Draws a portrait share card on a canvas and hands it to the native share
// sheet (or falls back to a plain download). Zero dependencies.
// Safe to import in Node: nothing touches canvas / navigator at module load,
// and every browser API is guarded so it degrades instead of throwing.

import { recordTasteEvent } from "./gems-supabase.js";

const IS_BROWSER =
  typeof document !== "undefined" && typeof URL !== "undefined";

// Instagram-friendly portrait (4:5).
const CARD_WIDTH = 1080;
const CARD_HEIGHT = 1350;

// Palette mirrors styles.css tokens — resolved to literals so the card renders
// identically on an OffscreenCanvas that never sees the page's CSS variables.
const INK = "#170b10";
const MAUVE = "#746d70";
const SURFACE = "#f7f6f6";
const WHITE = "#ffffff";
const BORDER = "#dfd9dc";
const DEEP_PETAL = "#274a86";
const PETAL = "#aec6ec";

// The three taste chart colors, in slot order (euro, gym, golden).
const SLOT_COLORS = Object.freeze(["#dca96c", "#3d3036", "#e8865a"]);

const DISPLAY_FONT = '"Fraunces", Georgia, serif';
const UI_FONT = '"Instrument Sans", -apple-system, BlinkMacSystemFont, sans-serif';

function firstNameOf(name) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return "Your";
  return trimmed.split(/\s+/)[0];
}

// A possessive that reads right whether or not the name ends in "s".
function possessive(word) {
  const value = String(word ?? "");
  return /s$/i.test(value) ? `${value}'` : `${value}'s`;
}

function normalizeTaste(taste) {
  if (!Array.isArray(taste)) return [];
  return taste
    .map((entry) => ({
      name: String(entry?.name ?? "").trim(),
      percent: Number(entry?.percent) || 0,
    }))
    .filter((entry) => entry.name && entry.percent > 0)
    .slice(0, 3);
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

// Prefer OffscreenCanvas; fall back to a detached <canvas>. Returns null when
// neither exists (e.g. Node).
function makeCanvas(width, height) {
  try {
    if (typeof OffscreenCanvas === "function") {
      return new OffscreenCanvas(width, height);
    }
  } catch {
    /* fall through to DOM canvas */
  }
  if (IS_BROWSER) {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      return canvas;
    } catch {
      /* ignore */
    }
  }
  return null;
}

async function canvasToPngBlob(canvas) {
  // OffscreenCanvas path.
  if (typeof canvas.convertToBlob === "function") {
    return canvas.convertToBlob({ type: "image/png" });
  }
  // HTMLCanvasElement path.
  if (typeof canvas.toBlob === "function") {
    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob), "image/png");
    });
  }
  return null;
}

// Best-effort: wait for the display/ui fonts so the card isn't drawn in a
// system fallback the first time it's rendered. Never blocks on failure.
async function ensureFonts() {
  try {
    if (typeof document !== "undefined" && document.fonts?.ready) {
      await Promise.race([
        document.fonts.ready,
        new Promise((resolve) => setTimeout(resolve, 400)),
      ]);
    }
  } catch {
    /* fonts are optional — fallbacks are fine */
  }
}

/**
 * Draw a portrait share card. Never throws — returns null on any failure.
 * @param {{name?: string, taste?: Array<{name: string, percent: number}>}} card
 * @returns {Promise<Blob|null>}
 */
export async function renderTasteCard({ name, taste } = {}) {
  try {
    const canvas = makeCanvas(CARD_WIDTH, CARD_HEIGHT);
    if (!canvas) return null;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    await ensureFonts();

    const rows = normalizeTaste(taste);
    const marginX = 96;
    const contentW = CARD_WIDTH - marginX * 2;

    // Clean near-white ground.
    ctx.fillStyle = WHITE;
    ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

    // Thin pink accent rule along the top — the only pink on the card.
    ctx.fillStyle = PETAL;
    ctx.fillRect(0, 0, CARD_WIDTH, 8);

    ctx.textBaseline = "alphabetic";

    // Wordmark, small, top-left.
    ctx.fillStyle = INK;
    ctx.font = `italic 600 40px ${DISPLAY_FONT}`;
    ctx.textAlign = "left";
    ctx.fillText("Gems", marginX, 150);
    // Petal accent dot after the wordmark.
    ctx.fillStyle = DEEP_PETAL;
    const dotX = marginX + ctx.measureText("Gems").width + 16;
    ctx.beginPath();
    ctx.arc(dotX, 138, 7, 0, Math.PI * 2);
    ctx.fill();

    // Eyebrow.
    ctx.fillStyle = MAUVE;
    ctx.font = `600 30px ${UI_FONT}`;
    ctx.fillText("TASTE PROFILE", marginX, 320);

    // Headline: "{firstName}'s taste".
    const headline = `${possessive(firstNameOf(name))} taste`;
    ctx.fillStyle = INK;
    ctx.font = `italic 500 108px ${DISPLAY_FONT}`;
    ctx.fillText(headline, marginX, 430);

    // Segmented taste bar.
    const barY = 560;
    const barH = 34;
    const totalPercent = rows.reduce((sum, entry) => sum + entry.percent, 0);

    if (rows.length && totalPercent > 0) {
      // Rounded track.
      ctx.save();
      roundRect(ctx, marginX, barY, contentW, barH, barH / 2);
      ctx.clip();
      let cursor = marginX;
      rows.forEach((entry, index) => {
        const w = (entry.percent / totalPercent) * contentW;
        ctx.fillStyle = SLOT_COLORS[index] ?? MAUVE;
        ctx.fillRect(cursor, barY, Math.ceil(w) + 1, barH);
        cursor += w;
      });
      ctx.restore();

      // Legend rows: color dot · percent · name.
      let rowY = barY + barH + 96;
      rows.forEach((entry, index) => {
        ctx.fillStyle = SLOT_COLORS[index] ?? MAUVE;
        ctx.beginPath();
        ctx.arc(marginX + 13, rowY - 16, 13, 0, Math.PI * 2);
        ctx.fill();

        ctx.textAlign = "left";
        ctx.fillStyle = INK;
        ctx.font = `600 52px ${UI_FONT}`;
        ctx.fillText(`${Math.round(entry.percent)}%`, marginX + 46, rowY);

        ctx.fillStyle = MAUVE;
        ctx.font = `500 44px ${UI_FONT}`;
        ctx.fillText(entry.name, marginX + 210, rowY);

        rowY += 96;
      });
    } else {
      ctx.fillStyle = MAUVE;
      ctx.font = `500 44px ${UI_FONT}`;
      ctx.fillText("Your taste is still taking shape.", marginX, barY + 60);
    }

    // Divider above footer.
    ctx.fillStyle = BORDER;
    ctx.fillRect(marginX, CARD_HEIGHT - 190, contentW, 1.5);

    // Footer line.
    ctx.textAlign = "left";
    ctx.fillStyle = INK;
    ctx.font = `italic 500 40px ${DISPLAY_FONT}`;
    ctx.fillText("Made with Gems", marginX, CARD_HEIGHT - 120);

    ctx.fillStyle = MAUVE;
    ctx.font = `500 28px ${UI_FONT}`;
    ctx.fillText("Every photo, sorted by taste.", marginX, CARD_HEIGHT - 76);

    const blob = await canvasToPngBlob(canvas);
    return blob ?? null;
  } catch (error) {
    console.info("[gems-share] card render skipped:", error);
    return null;
  }
}

// Turn our {blob, name} shapes into File objects when the platform supports it.
function toFiles(files) {
  if (typeof File !== "function") return [];
  const out = [];
  for (const item of files) {
    if (!item?.blob) continue;
    try {
      out.push(
        new File([item.blob], item.name || "gems.png", {
          type: item.blob.type || "image/png",
        }),
      );
    } catch {
      /* skip anything that won't wrap */
    }
  }
  return out;
}

function downloadBlob(blob, filename) {
  if (!IS_BROWSER) return false;
  let url = null;
  try {
    url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "gems.png";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  } catch (error) {
    console.info("[gems-share] download failed:", error);
    return false;
  } finally {
    if (url) {
      try {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Share image files through the native share sheet, or fall back to a plain
 * download. Never promises "posts for you" — the user places the post.
 * @param {Array<{blob: Blob, name?: string}>} files
 * @param {{text?: string}} [options]
 * @returns {Promise<{shared: boolean, downloaded?: boolean}>}
 */
export async function shareImages(files, { text } = {}) {
  const list = Array.isArray(files) ? files.filter((item) => item?.blob) : [];
  if (!list.length) return { shared: false, downloaded: false };

  // Preferred path: native share sheet with real File objects.
  try {
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      const shareFiles = toFiles(list);
      const payload = { files: shareFiles };
      if (
        shareFiles.length &&
        (typeof navigator.canShare !== "function" || navigator.canShare(payload))
      ) {
        await navigator.share({ files: shareFiles, text });
        return { shared: true };
      }
    }
  } catch (error) {
    // AbortError = user dismissed; anything else = unsupported. Either way we
    // fall through to a download so the card is never lost.
    console.info("[gems-share] native share unavailable:", error);
  }

  // Fallback: download each file so the user can post it manually.
  let downloaded = false;
  for (const item of list) {
    if (downloadBlob(item.blob, item.name)) downloaded = true;
  }
  return { shared: false, downloaded };
}

// A few tasteful hashtags keyed off the aesthetic set name.
function hashtagsFor(setName) {
  const tags = ["#Gems", "#TasteProfile"];
  const slug = String(setName ?? "")
    .replace(/[^a-zA-Z0-9]+/g, "")
    .trim();
  if (slug) tags.push(`#${slug}`);
  tags.push("#AestheticEdit");
  // De-dupe while preserving order.
  return [...new Set(tags)].join(" ");
}

/**
 * A short, paste-ready caption block. Deterministic (no RNG).
 * @param {{setName?: string, count?: number}} [options]
 * @returns {string}
 */
export function buildCaption({ setName, count } = {}) {
  const name = String(setName ?? "").trim();
  const n = Number(count);
  const lead = name ? `My taste, mapped: ${name}.` : "My taste, mapped by Gems.";
  const second =
    Number.isFinite(n) && n > 0
      ? `Learned from ${Math.round(n)} choices — and counting.`
      : "Every photo, sorted by taste.";
  return `${lead}\n${second}\n\n${hashtagsFor(name)}`;
}

/**
 * End-to-end: render the card, hand it to the share sheet (or download), and
 * log the outcome. Never throws.
 * @param {{name?: string, taste?: Array<{name: string, percent: number}>}} card
 * @returns {Promise<{shared: boolean, downloaded?: boolean}>}
 */
export async function shareTasteProfile({ name, taste } = {}) {
  try {
    const blob = await renderTasteCard({ name, taste });
    if (!blob) {
      recordTasteEvent("taste_shared", { shared: false, rendered: false });
      return { shared: false, downloaded: false };
    }
    const result = await shareImages([{ blob, name: "gems-taste.png" }], {
      text: "My taste, mapped by Gems",
    });
    recordTasteEvent("taste_shared", {
      shared: Boolean(result?.shared),
      downloaded: Boolean(result?.downloaded),
    });
    return result;
  } catch (error) {
    console.info("[gems-share] shareTasteProfile skipped:", error);
    return { shared: false, downloaded: false };
  }
}
