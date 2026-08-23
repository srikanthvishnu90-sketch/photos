// Style-Match for the Gems client — "make my photo look like this."
// Two real flows sit on top of the deployed edge functions:
//   1. Read a REFERENCE photo's grade with rank-photos ("describe", Pass A) —
//      its vibe_tags + content become a style-transfer instruction.
//   2. Regrade one of the user's OWN photos with edit-photo (kind
//      "style_match") — full-resolution pixels leave the device ONLY for this
//      explicitly requested edit, per the privacy architecture.
// A named aesthetic ("Dark Gym", "Golden Hour") is the same flow without a
// reference photo — the instruction is built straight from the label.
// Every failure — signed out, offline, model error, cap, quota — degrades to a
// plain { error } object. Nothing here ever throws.

import { getPhotoBlob } from "./gems-photolib.js";
import { getSession, recordTasteEvent } from "./gems-supabase.js";

// Keep in sync with gems-supabase.js, which declares these but does not export
// them (client-safe by design — owner-only RLS does the real gatekeeping).
const SUPABASE_URL = "https://hkwkxacvcgorhthwyslx.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_Z8Fw1dZYiqOGUDITzU929A_i2k9wANc";

const RANK_ENDPOINT = `${SUPABASE_URL}/functions/v1/rank-photos`;
const EDIT_ENDPOINT = `${SUPABASE_URL}/functions/v1/edit-photo`;
const THUMB_MAX_EDGE = 512; // matches the ranker's Pass A thumbnail size
const JPEG_QUALITY = 0.82;

// ---------------------------------------------------------------------------
// Browser-API helpers. Every DOM/canvas/btoa/fetch touch lives inside a
// function body behind a typeof guard, so importing this module in Node never
// throws at load time (see verify smoke test).
// ---------------------------------------------------------------------------

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
  if (typeof btoa === "undefined") return null;
  return btoa(binary);
}

// Downscale a stored photo to a 512px-max-edge JPEG thumbnail for the describe
// pass. Returns { mimeType, base64 } or null when the photo or canvas support
// is missing.
async function makeThumbnail(id, maxEdge = THUMB_MAX_EDGE) {
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
      const base64 = await blobToBase64(jpeg);
      if (!base64) return null;
      return Object.freeze({ mimeType: "image/jpeg", base64 });
    } finally {
      try {
        bitmap.close?.();
      } catch {
        // ignore
      }
    }
  } catch (error) {
    console.info("Style reference thumbnail build failed", id, error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Instruction builders — the natural-language grade the edit model receives.
// The identity guardrail is verbatim on every path: change only the grade.
// ---------------------------------------------------------------------------

const IDENTITY_GUARD =
  "Change ONLY the grade/color/mood — keep the subject, people, faces, " +
  "identity, composition and framing of the target photo exactly as they are.";

function referenceInstruction(look) {
  return (
    `Regrade this photo to match this look: ${look}. ` +
    "Apply that color palette, contrast, exposure, grain and overall mood. " +
    IDENTITY_GUARD
  );
}

function aestheticInstruction(aesthetic) {
  return (
    `Regrade this photo into a ${aesthetic} look — apply that palette, ` +
    "contrast, exposure, grain and mood; keep subject/identity/composition unchanged."
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Read a reference photo's GRADE via rank-photos Pass A ("describe") and turn
// its vibe_tags + content into a style-transfer instruction for the target.
// Signed out / offline / model error → { error }. Never throws.
export async function describeReferenceGrade(referencePhotoId) {
  try {
    if (!referencePhotoId) return { error: "no_reference" };

    const thumb = await makeThumbnail(referencePhotoId);
    if (!thumb) return { error: "reference_unavailable" };

    const session = await getSession();
    if (!session) return { error: "signed_out" };

    const response = await fetch(RANK_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
        apikey: SUPABASE_PUBLISHABLE_KEY,
      },
      body: JSON.stringify({
        action: "describe",
        photos: [
          { id: referencePhotoId, mimeType: thumb.mimeType, base64: thumb.base64 },
        ],
      }),
    });
    if (!response.ok) return { error: "describe_failed" };

    const data = await response.json().catch(() => null);
    const described = Array.isArray(data?.photos) ? data.photos[0] : null;
    if (!described) return { error: "describe_failed" };

    const tags = Array.isArray(described.vibe_tags)
      ? described.vibe_tags.filter((tag) => typeof tag === "string" && tag.trim())
      : [];
    const content =
      typeof described.content === "string" ? described.content.trim() : "";

    // Prefer the controlled vibe_tags as the look descriptor; fall back to the
    // one-line content when tags are absent so we never send an empty look.
    let look = tags.join(", ");
    if (look && content) look = `${look} (${content})`;
    if (!look) look = content;
    if (!look) return { error: "describe_failed" };

    return { instruction: referenceInstruction(look) };
  } catch (error) {
    console.info("describeReferenceGrade failed", error);
    return { error: "describe_failed" };
  }
}

// Shared edit-photo call: full-res target pixels + instruction → { url } or a
// mapped { error }. Full-resolution pixels leave the device ONLY here, for an
// explicitly requested edit (privacy architecture — ranking/metrics/thumbnails
// all stay on-device). Never throws.
async function postStyleEdit({ targetPhotoId, instruction }) {
  try {
    if (!targetPhotoId) return { error: "no_target" };
    if (!instruction) return { error: "no_instruction" };

    const blob = await getPhotoBlob(targetPhotoId);
    if (!blob) return { error: "target_unavailable" };

    const session = await getSession();
    if (!session) return { error: "signed_out" };

    const imageBase64 = await blobToBase64(blob);
    if (!imageBase64) return { error: "encode_failed" };

    const response = await fetch(EDIT_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
        apikey: SUPABASE_PUBLISHABLE_KEY,
      },
      body: JSON.stringify({
        instruction,
        kind: "style_match",
        photoId: targetPhotoId,
        imageBase64,
        mimeType: blob.type || "image/jpeg",
      }),
    });
    const data = await response.json().catch(() => null);

    if (response.ok && data?.url) return { url: data.url };
    if (response.status === 402) return { error: "cap", paywall: true };
    if (response.status === 503) return { error: "quota", quota: true };
    return { error: "failed" };
  } catch (error) {
    console.info("postStyleEdit failed", error);
    return { error: "failed" };
  }
}

// Apply a REFERENCE photo's grade to one of the user's own photos.
// describeReferenceGrade → edit-photo. Returns { url } or { error, paywall?,
// quota? }. Never throws.
export async function applyStyleFromReference({ targetPhotoId, referencePhotoId }) {
  try {
    const described = await describeReferenceGrade(referencePhotoId);
    if (described.error) return described;

    const result = await postStyleEdit({
      targetPhotoId,
      instruction: described.instruction,
    });
    if (result.url) {
      recordTasteEvent("style_match_applied", { targetPhotoId, referencePhotoId });
    }
    return result;
  } catch (error) {
    console.info("applyStyleFromReference failed", error);
    return { error: "failed" };
  }
}

// Apply a NAMED aesthetic ("Dark Gym", "Golden Hour") to one of the user's own
// photos. Same edit-photo flow, instruction built from the label. Returns
// { url } or { error, paywall?, quota? }. Never throws.
export async function applyAestheticGrade({ targetPhotoId, aesthetic }) {
  try {
    const label = typeof aesthetic === "string" ? aesthetic.trim() : "";
    if (!label) return { error: "no_aesthetic" };

    const result = await postStyleEdit({
      targetPhotoId,
      instruction: aestheticInstruction(label),
    });
    if (result.url) {
      recordTasteEvent("aesthetic_applied", { aesthetic: label });
    }
    return result;
  } catch (error) {
    console.info("applyAestheticGrade failed", error);
    return { error: "failed" };
  }
}
