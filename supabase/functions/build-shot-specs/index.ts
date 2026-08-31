// build-shot-specs — R19 of the Reference Protocol.
//
// Every reference in the library must carry a stored SHOT SPEC before it is
// allowed to drive composition. We cannot send Gemini a depth map or a pose
// skeleton, so we send MEASUREMENTS instead: an offline pass that interrogates
// each reference photograph and stores what it actually contains.
//
// The captioning literature is specific about the method — asking a VLM to
// "describe this image" produces poor spatial detail, while a fixed
// QUESTIONNAIRE (question -> answer -> caption) gets reliable spatial
// relations. So this asks for one strict JSON schema, never prose.
//
// Runs once per reference, not once per generation, so the cost is ~$0 amortised.
// Service-role only; verify_jwt is off (see config.toml) and the SERVICE key is
// the gate, exactly like cleanup-scene-outputs.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

// The helpers below take the request-scoped client. Typing it as the bare
// ReturnType<typeof createClient> does not match the instance's inferred schema
// generics, so name it explicitly.
// deno-lint-ignore no-explicit-any
type Db = SupabaseClient<any, any, any>;

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const SPEC_MODEL = Deno.env.get("GEMS_SPEC_MODEL") ?? "gemini-3.1-flash";
const SPEC_VERSION = 1;
// Stamped on assets whose measurement failed, so they are not retried forever.
// A `rebuild` run re-attempts them deliberately.
const FAILED_VERSION = -1;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

const QUESTIONNAIRE = `You are measuring a REFERENCE PHOTOGRAPH so an image generator can reproduce its framing, light and look with a different person in it.

Answer by MEASUREMENT, not description. Do not write prose. Return ONLY JSON matching this exact shape:

{
  "outline": {
    "camera_distance": "wide" | "medium-wide" | "medium" | "close",
    "subject_present": true | false,
    "subject_frame_fraction": 0.0-1.0,
    "subject_position": "left-third" | "centre" | "right-third" | "none",
    "horizon_height": 0.0-1.0,
    "camera_elevation": "low" | "eye" | "slightly-high" | "high",
    "foreground_element": "<short phrase, or 'none'>",
    "depth_layers": "flat" | "two-layer" | "layered",
    "aspect": "portrait" | "square" | "landscape"
  },
  "lighting": {
    "direction": "<clock position + elevation, e.g. 'back-left, low'>",
    "hardness": "hard" | "soft" | "diffuse",
    "temperature_k": 2000-9000,
    "key_to_fill": "strong" | "moderate" | "flat",
    "shadow_note": "<one short clause on where shadows fall and how sharp>",
    "time_of_day": "dawn" | "morning" | "midday" | "afternoon" | "golden-hour" | "dusk" | "night" | "indoor"
  },
  "aesthetic": {
    "palette": ["#rrggbb", "#rrggbb", "#rrggbb"],
    "contrast": "low" | "medium" | "high",
    "grain": "none" | "fine" | "visible",
    "capture": "phone-casual" | "camera-deliberate"
  },
  "integrity": {
    "looks_ai_generated": true | false,
    "has_watermark_or_text": true | false,
    "usable_as_reference": true | false
  }
}

Definitions you must follow exactly:
- subject_frame_fraction: the fraction of the FRAME AREA the main person occupies. A person filling a third of the frame is 0.33. If no person, 0.
- horizon_height: distance from the TOP of the frame to the horizon, 0.0 at the top edge, 1.0 at the bottom.
- looks_ai_generated: true if this reads as an AI render rather than a real photograph. Be strict — this flag removes the photo from use.`;

/**
 * Constant-time secret comparison, mirroring cleanup-scene-outputs. The gate is
 * the SERVICE ROLE KEY itself, which is already an env var here — so this needs
 * no new secret provisioned, and nothing but the owner can spend Gemini quota
 * or flip eligibility flags. verify_jwt is off, so THIS is the only gate.
 */
async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function secretsMatch(actual: string, expected: string): Promise<boolean> {
  if (!actual || !expected) return false;
  const [a, b] = await Promise.all([sha256(actual), sha256(expected)]);
  if (a.byteLength !== b.byteLength) return false;
  let different = 0;
  for (let i = 0; i < a.byteLength; i++) different |= a[i] ^ b[i];
  return different === 0;
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "POST, OPTIONS",
    },
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Clamp a number into range, or null when the model returned nonsense. */
function num(v: unknown, lo: number, hi: number): number | null {
  // Number(null) === Number("") === Number(false) === Number([]) === 0, all
  // finite — so coercing first would silently store 0 for a missing value and
  // the caller's "is it null?" guard would never fire. Reject by TYPE first.
  if (typeof v !== "number" && typeof v !== "string") return null;
  if (typeof v === "string" && v.trim() === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, n));
}

function oneOf(v: unknown, allowed: string[]): string | null {
  const s = String(v ?? "").toLowerCase().trim();
  return allowed.includes(s) ? s : null;
}

/**
 * Validate the model's JSON into the stored shape. A spec that fails validation
 * is not stored at all — a half-measured reference driving a composition block
 * is worse than no spec, because the generic fallback is known-good (R21).
 */
function validateSpec(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, any>;
  const o = r.outline ?? {};
  const l = r.lighting ?? {};
  const a = r.aesthetic ?? {};
  const i = r.integrity ?? {};

  const camera_distance = oneOf(o.camera_distance, ["wide", "medium-wide", "medium", "close"]);
  const subject_frame_fraction = num(o.subject_frame_fraction, 0, 1);
  const horizon_height = num(o.horizon_height, 0, 1);
  // The three fields the composition block is actually rendered from. Without
  // all three there is nothing to say that the generic default doesn't say better.
  if (!camera_distance || subject_frame_fraction === null || horizon_height === null) return null;

  const palette = Array.isArray(a.palette)
    ? a.palette.filter((c: unknown) => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c)).slice(0, 4)
    : [];

  return {
    outline: {
      camera_distance,
      subject_present: o.subject_present === true,
      subject_frame_fraction,
      subject_position: oneOf(o.subject_position, ["left-third", "centre", "right-third", "none"]) ?? "none",
      horizon_height,
      camera_elevation: oneOf(o.camera_elevation, ["low", "eye", "slightly-high", "high"]) ?? "eye",
      foreground_element: typeof o.foreground_element === "string"
        ? o.foreground_element.trim().slice(0, 120)
        : "none",
      depth_layers: oneOf(o.depth_layers, ["flat", "two-layer", "layered"]) ?? "two-layer",
      aspect: oneOf(o.aspect, ["portrait", "square", "landscape"]) ?? "portrait",
    },
    lighting: {
      direction: typeof l.direction === "string" ? l.direction.trim().slice(0, 80) : "",
      hardness: oneOf(l.hardness, ["hard", "soft", "diffuse"]) ?? "soft",
      temperature_k: num(l.temperature_k, 2000, 9000) ?? 5200,
      key_to_fill: oneOf(l.key_to_fill, ["strong", "moderate", "flat"]) ?? "moderate",
      shadow_note: typeof l.shadow_note === "string" ? l.shadow_note.trim().slice(0, 160) : "",
      time_of_day: oneOf(l.time_of_day, [
        "dawn", "morning", "midday", "afternoon", "golden-hour", "dusk", "night", "indoor",
      ]) ?? "afternoon",
    },
    aesthetic: {
      palette,
      contrast: oneOf(a.contrast, ["low", "medium", "high"]) ?? "medium",
      grain: oneOf(a.grain, ["none", "fine", "visible"]) ?? "none",
      capture: oneOf(a.capture, ["phone-casual", "camera-deliberate"]) ?? "phone-casual",
    },
    integrity: {
      looks_ai_generated: i.looks_ai_generated === true,
      has_watermark_or_text: i.has_watermark_or_text === true,
      usable_as_reference: i.usable_as_reference !== false,
    },
  };
}

const PACKS = [
  "euro-summer", "dubai", "old-money", "luxury-cars",
  "beach-club", "boat", "dark-luxe", "after-dark",
  "campus", "game-day", "alpine", "tokyo-neon", "marrakech", "wellness",

];

/**
 * Register storage objects that have no inspiration_assets row.
 *
 * The importer (tool/import-pack-references.sh) uploads to storage; the row
 * INSERT was a one-shot backfill migration. Now that the generator selects from
 * the TABLE rather than a storage listing, anything imported after that
 * migration is invisible to generation until it is registered — silent drift
 * that starts with the very next import. This closes it.
 */
async function syncLibrary(
  supabase: Db,
): Promise<{ inserted: number; scanned: number }> {
  let inserted = 0;
  let scanned = 0;
  for (const pack of [...PACKS, "_realism"]) {
    const prefix = pack === "_realism" ? "_global/realism" : `_global/packs/${pack}`;
    const packId = pack === "_realism" ? "realism" : pack;
    const { data: files } = await supabase.storage
      .from("inspiration").list(prefix, { limit: 1000, sortBy: { column: "name", order: "asc" } });
    const paths = (files ?? [])
      .filter((f) => f.name && /\.(jpe?g|png|webp)$/i.test(f.name))
      .map((f) => `${prefix}/${f.name}`);
    if (!paths.length) continue;
    scanned += paths.length;
    const { data: existing } = await supabase
      .from("inspiration_assets").select("storage_path").in("storage_path", paths);
    const known = new Set((existing ?? []).map((r: { storage_path: string }) => r.storage_path));
    const missing = paths.filter((path) => !known.has(path));
    if (!missing.length) continue;
    const rows = missing.map((path) => ({
      profile_id: null,
      storage_path: path,
      label: path.slice(path.lastIndexOf("/") + 1),
      source: "style_pack",
      style_pack_id: packId,
    }));
    const { error } = await supabase.from("inspiration_assets").insert(rows);
    if (error) { console.info("sync insert failed", packId, error.message); continue; }
    inserted += rows.length;
  }
  return { inserted, scanned };
}

/** F9 — stamp a failed measurement so the pending query stops returning it. */
async function markFailed(
  supabase: Db,
  id: string,
): Promise<void> {
  try {
    await supabase.from("inspiration_assets")
      .update({ shot_spec_version: FAILED_VERSION }).eq("id", id);
  } catch (error) {
    console.info("could not mark failure", id, error);
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return json(200, { ok: true });
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" });

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const supplied = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!(await secretsMatch(supplied, serviceKey))) {
    return json(401, { error: "unauthorized" });
  }
  if (!GEMINI_API_KEY) return json(500, { error: "missing_gemini_key" });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const body = await request.json().catch(() => ({})) as {
    limit?: number;
    pack?: string;
    rebuild?: boolean;
    sync?: boolean;
  };
  // Register any storage object that has no row yet, so newly imported
  // references become visible to generation rather than silently ignored.
  const synced = body.sync ? await syncLibrary(supabase) : null;
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(body.limit) || DEFAULT_LIMIT));

  let query = supabase
    .from("inspiration_assets")
    .select("id, storage_path, style_pack_id")
    .is("profile_id", null)
    .eq("eligible", true)
    // Deterministic order, so a caller looping until remaining==0 makes
    // monotonic progress instead of resampling the same rows.
    .order("storage_path", { ascending: true })
    .limit(limit);
  // Pending = never attempted. shot_spec_version is stamped even on failure
  // (with FAILED_VERSION), so an asset the model can never measure is not
  // retried forever — that would spend Gemini quota indefinitely and leave
  // `remaining` permanently above zero.
  if (!body.rebuild) query = query.is("shot_spec", null).is("shot_spec_version", null);
  if (body.pack) query = query.eq("style_pack_id", body.pack);

  const { data: assets, error } = await query;
  if (error) return json(502, { error: "query_failed", detail: error.message });
  if (!assets?.length) return json(200, { measured: 0, remaining: 0, synced, note: "nothing pending" });

  let measured = 0;
  let rejected = 0;
  let failed = 0;
  const flagged: string[] = [];

  for (const asset of assets) {
    try {
      const { data: file } = await supabase.storage.from("inspiration").download(asset.storage_path);
      if (!file) { failed++; await markFailed(supabase, asset.id); continue; }
      const b64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${SPEC_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contents: [{
              parts: [
                { inline_data: { mime_type: file.type || "image/jpeg", data: b64 } },
                { text: QUESTIONNAIRE },
              ],
            }],
            generationConfig: { responseMimeType: "application/json", temperature: 0 },
          }),
        },
      );
      if (!res.ok) { failed++; await markFailed(supabase, asset.id); continue; }
      const data = await res.json();
      const text = (data?.candidates?.[0]?.content?.parts ?? [])
        .map((p: Record<string, unknown>) => p.text).filter(Boolean).join("");
      let parsed: unknown = null;
      try { parsed = JSON.parse(text); } catch { parsed = null; }

      const spec = validateSpec(parsed);
      if (!spec) { failed++; await markFailed(supabase, asset.id); continue; }

      const integrity = spec.integrity as Record<string, boolean>;
      // R13, enforced at measurement time: a reference that reads as an AI
      // render is flagged in the database, not just skipped by a filename regex.
      const isRender = integrity.looks_ai_generated === true;
      const unusable = integrity.usable_as_reference === false || integrity.has_watermark_or_text === true;
      if (isRender || unusable) { rejected++; flagged.push(asset.storage_path); }

      const { error: upErr } = await supabase
        .from("inspiration_assets")
        .update({
          shot_spec: spec,
          shot_spec_version: SPEC_VERSION,
          is_ai_render: isRender,
          eligible: !(isRender || unusable),
        })
        .eq("id", asset.id);
      if (upErr) { failed++; continue; }
      measured++;
    } catch (error) {
      console.info("shot spec failed", asset.storage_path, error);
      failed++;
      await markFailed(supabase, asset.id);
    }
  }

  const { count } = await supabase
    .from("inspiration_assets")
    .select("id", { count: "exact", head: true })
    .is("profile_id", null).eq("eligible", true)
    .is("shot_spec", null).is("shot_spec_version", null);

  return json(200, {
    synced,
    measured,
    rejected,
    failed,
    remaining: count ?? null,
    spec_version: SPEC_VERSION,
    flagged: flagged.slice(0, 20),
  });
});
