// Client module for College-Commitment / Template Graphics (Master Features
// #17). A chosen template + one of the user's photos → the template-graphics
// edge function → a fan-made mockup graphic. Every failure degrades to a plain
// { error } object; nothing here ever throws.
//
// Privacy: a photo's FULL-RESOLUTION pixels leave the device only for an
// explicitly requested graphic (the user picked this photo and this template).
// Listings and ranking never carry full-res pixels — only this on-demand call
// does, mirroring the editor's export path.

import { getPhotoBlob, listPhotos } from "./gems-photolib.js";
import { getSession, recordTasteEvent } from "./gems-supabase.js";

// Keep in sync with gems-supabase.js, which declares these but does not export
// them (client-safe by design — RLS does the real gatekeeping). Same pattern as
// gems-ranker.js.
const SUPABASE_URL = "https://hkwkxacvcgorhthwyslx.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_Z8Fw1dZYiqOGUDITzU929A_i2k9wANc";

const TEMPLATE_ENDPOINT = `${SUPABASE_URL}/functions/v1/template-graphics`;

// Form-field descriptors for each template, so the UI can render a form.
// MIRRORS the edge TEMPLATE_DEFS in supabase/functions/template-graphics/
// prompts.js — keep the slugs, field keys, and option values in sync across the
// two files (the edge prompts.js is the canonical source of prompt text).
export const TEMPLATE_LABELS = [
  {
    slug: "college_commitment",
    label: "College Commitment",
    fields: [
      { key: "schoolName", label: "School", type: "text" },
      { key: "sport", label: "Sport", type: "text" },
      { key: "homeOrAway", label: "Kit", type: "select", options: ["home", "away"] },
      { key: "jerseyNumber", label: "Jersey number", type: "text" },
      {
        key: "realisticOrGraphic",
        label: "Style",
        type: "select",
        options: ["graphic", "realistic"],
      },
    ],
  },
  {
    slug: "grad",
    label: "Graduation",
    fields: [
      { key: "schoolName", label: "School", type: "text" },
      { key: "year", label: "Year", type: "text" },
    ],
  },
  {
    slug: "game_day",
    label: "Game Day",
    fields: [
      { key: "teamName", label: "Team", type: "text" },
      { key: "opponent", label: "Opponent", type: "text" },
    ],
  },
];

const LABELS_BY_SLUG = new Map(TEMPLATE_LABELS.map((entry) => [entry.slug, entry]));

// Base64-encode a Blob's bytes in chunks (same approach as gems-ranker.js).
async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000; // keep String.fromCharCode argument counts sane
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// Build a template graphic from one stored photo. Returns { url } on success,
// or an { error, paywall?, cap? } object on any failure. Never throws.
//   402 template_cap_reached → { error: "cap", paywall, cap }
//   503 image_model_quota    → { error: "quota" }
//   anything else            → { error: "failed" }
export async function buildTemplateGraphic({ slug, fields = {}, photoId } = {}) {
  try {
    if (typeof btoa === "undefined" || typeof fetch === "undefined") {
      return { error: "failed" };
    }
    if (!LABELS_BY_SLUG.has(String(slug ?? ""))) return { error: "failed" };
    if (!photoId) return { error: "failed" };

    const session = await getSession();
    if (!session) return { error: "failed" };

    // Full-resolution pixels leave the device only here, for this explicit,
    // user-initiated graphic request.
    const blob = await getPhotoBlob(photoId);
    if (!blob) return { error: "failed" };
    const imageBase64 = await blobToBase64(blob);

    recordTasteEvent("template_requested", { slug });

    const response = await fetch(TEMPLATE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
        apikey: SUPABASE_PUBLISHABLE_KEY,
      },
      body: JSON.stringify({
        slug,
        fields: fields ?? {},
        imageBase64,
        mimeType: blob.type || "image/jpeg",
      }),
    });

    if (response.status === 402) {
      let cap;
      try {
        cap = (await response.json())?.cap;
      } catch {
        // ignore
      }
      return { error: "cap", paywall: true, cap };
    }
    if (response.status === 503) return { error: "quota" };
    if (!response.ok) return { error: "failed" };

    const data = await response.json();
    if (!data?.url) return { error: "failed" };
    return { url: data.url };
  } catch (error) {
    console.info("Template graphic build failed", error);
    return { error: "failed" };
  }
}

// Best-effort helper: surface up to 3 OTHER photos from the library that may
// work better for the chosen template — the clearest face shots, approximated
// by on-device quality (highest quality first). Optionally uses gems-ranker for
// a smarter pick when it's available, but always degrades to the quality sort.
// Returns up to 3 public photo records; never throws.
export async function suggestBetterPhotos(slug) {
  try {
    const records = await listPhotos();
    if (!Array.isArray(records) || !records.length) return [];

    // Optional smarter pass via the ranker (natural-language "clearest face"
    // request). Import lazily so this module never hard-depends on it.
    try {
      const ranker = await import("./gems-ranker.js");
      if (ranker?.rankPhotos) {
        const label = LABELS_BY_SLUG.get(String(slug ?? ""))?.label ?? "this template";
        const ranked = await ranker.rankPhotos({
          request: `clearest, sharpest photos with a clear face for a ${label} graphic`,
          purpose: "template",
        });
        const picks = (ranked ?? [])
          .map((entry) => entry?.record)
          .filter(Boolean)
          .slice(0, 3);
        if (picks.length) return picks;
      }
    } catch (error) {
      console.info("Ranker suggestion skipped, using quality sort", error);
    }

    // Fallback: on-device quality, highest first.
    return [...records]
      .sort((a, b) => (b.metrics?.quality ?? 0) - (a.metrics?.quality ?? 0))
      .slice(0, 3);
  } catch (error) {
    console.info("suggestBetterPhotos failed", error);
    return [];
  }
}
