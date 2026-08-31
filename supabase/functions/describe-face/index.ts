// describe-face — measure the user's own facial structure and build, once.
//
// WHY THIS EXISTS. Identity is carried into a generation through two channels:
// the reference PIXELS and the reference WORDS. Consistency guidance for this
// model family is explicit that a written profile alongside the photographs
// keeps identity when the photographs alone are not enough, and it is the only
// way to carry facts a single frontal photo cannot show — their profile, their
// height, their build.
//
// It is also the answer to a specific failure: the model's default is to render
// an idealised lookalike. Naming the actual bone structure gives the prompt
// something concrete to hold against that prior.
//
// AUTHENTICATED, per-user, owner-only. This reads a person's face and stores a
// description of their body — it must never run on a service key or be callable
// for someone else's profile.
import { createClient } from "npm:@supabase/supabase-js@2";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const FACE_MODEL = Deno.env.get("GEMS_FACE_MODEL") ?? "gemini-3.1-flash";
const PROFILE_VERSION = 1;
const MAX_PHOTOS = 5;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const QUESTIONNAIRE = `You are describing ONE person's permanent facial structure so an image generator can render the same individual accurately. All attached photographs are the SAME person.

Describe STRUCTURE, not attractiveness. Never flatter, never soften, never say "well-proportioned" or "handsome" — those words are useless to a generator and actively harmful, because the model's default failure is to idealise. Describe what is actually there, including asymmetry.

Return ONLY JSON in exactly this shape, each value a short factual phrase:

{
  "face_shape": "<oval | round | square | heart | oblong | diamond, plus width relative to length>",
  "jaw": "<jaw width and angle, chin shape and projection>",
  "cheekbones": "<height, prominence, how full the cheeks are>",
  "eyes": "<shape, spacing relative to eye width, depth of set, lid type, colour>",
  "eyebrows": "<thickness, shape, how far apart, any asymmetry>",
  "nose": "<bridge width and straightness, tip shape, nostril width, length relative to face>",
  "mouth": "<lip fullness upper vs lower, mouth width relative to nose, resting expression>",
  "hair": "<hairline shape, density, texture, length, colour, how it is worn>",
  "facial_hair": "<none, or type and density and where it grows>",
  "skin": "<tone with undertone, texture, evenness>",
  "marks": "<moles, scars, freckles, dimples, and WHERE — or 'none visible'>",
  "eyewear": "<none, or frame shape, thickness, colour, and how it sits>",
  "asymmetry": "<any visible difference between the two sides — say 'none obvious' only if truly none>",
  "apparent_age": "<a range, e.g. '18-22'>",
  "build": "<apparent height impression and body build — slim, athletic, broad, stocky — plus shoulder width relative to hips>"
}

If a field genuinely cannot be seen in the photographs, use the exact string "not visible". Do not guess.`;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

const FIELDS = [
  "face_shape", "jaw", "cheekbones", "eyes", "eyebrows", "nose", "mouth",
  "hair", "facial_hair", "skin", "marks", "eyewear", "asymmetry",
  "apparent_age", "build",
] as const;

/**
 * Keep only real, short, factual strings. A profile of mostly "not visible" is
 * worse than none — it spends prompt budget saying nothing — so a profile that
 * does not describe at least the core bone structure is rejected outright.
 */
function validateProfile(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of FIELDS) {
    const v = r[key];
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (!t || t.toLowerCase() === "not visible") continue;
    out[key] = t.slice(0, 160);
  }
  // The three that carry most of the identity. Without them this is not a
  // description of a person, it is a list of hedges.
  const core = ["face_shape", "eyes", "nose"].filter((k) => out[k]);
  return core.length >= 2 ? out : null;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (request.method !== "POST") return json(405, { error: "POST only" });
  if (!GEMINI_API_KEY) return json(500, { error: "missing_gemini_key" });

  // Owner-only: the caller's own JWT, never a service key.
  const authHeader = request.headers.get("Authorization") ?? "";
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth?.user?.id;
  if (!userId) return json(401, { error: "no user" });

  const body = await request.json().catch(() => ({})) as { photos?: string[] };
  const photos = Array.isArray(body.photos)
    ? body.photos.filter((p) => typeof p === "string" && p).slice(0, MAX_PHOTOS)
    : [];
  if (!photos.length) return json(400, { error: "no_photos" });

  const parts: Array<Record<string, unknown>> = photos.map((data) => ({
    inline_data: { mime_type: "image/jpeg", data },
  }));
  parts.push({ text: QUESTIONNAIRE });

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${FACE_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { responseMimeType: "application/json", temperature: 0 },
      }),
    },
  );
  if (!res.ok) {
    return json(502, { error: "model_failed", detail: (await res.text()).slice(0, 200) });
  }
  const data = await res.json();
  const text = (data?.candidates?.[0]?.content?.parts ?? [])
    .map((p: Record<string, unknown>) => p.text).filter(Boolean).join("");
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }

  const profile = validateProfile(parsed);
  if (!profile) return json(422, { error: "profile_too_thin" });

  const { error } = await supabase
    .from("profiles")
    .update({
      face_profile: profile,
      face_profile_version: PROFILE_VERSION,
      face_profile_at: new Date().toISOString(),
    })
    .eq("id", userId);
  if (error) return json(502, { error: "save_failed", detail: error.message });

  return json(200, { profile, version: PROFILE_VERSION, fields: Object.keys(profile).length });
});
