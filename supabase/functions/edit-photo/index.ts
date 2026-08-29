// edit-photo — describe-it editing (Master Features #2) with per-user cost
// guardrails (#8) enforced BEFORE the model call.
// Instruction in → Nano Banana 2 edit → edits bucket → signed URL out.
// Full-resolution pixels reach this function only for an explicitly
// requested edit (privacy architecture). verify_jwt gates every call.
import { createClient } from "npm:@supabase/supabase-js@2";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const IMAGE_MODEL = Deno.env.get("GEMINI_IMAGE_MODEL") ?? "gemini-3.1-flash-image";
const FREE_EDITS_PER_MONTH = Number(Deno.env.get("FREE_EDITS_PER_MONTH") ?? "10");
const SIGNED_URL_SECONDS = 60 * 60 * 24 * 7;

// The edit-preamble: constrains single-change behavior (Master Features #2).
const EDIT_PREAMBLE = `You are the photo editor inside Gems. Apply EXACTLY the requested change to the photo and nothing else.
Rules:
- One change: the user's instruction. Every other aspect — people, faces, identity, pose, framing, lighting, color grade, grain, background — stays identical.
- Never beautify, relight, denoise, or "improve" anything that wasn't asked for.
- Dark, moody, grainy, or unconventional looks are deliberate; preserve them.
- If the instruction asks to remove something, reconstruct what is naturally behind it.
- When the requested change IS a lighting or color adjustment (warmer, brighter, more contrast, a grade), execute it like a skilled colorist: intentional and SUBTLE, skin tones protected and natural, never overcooked into crushed blacks, radioactive saturation, or HDR flatness.
- Return the edited image.`;

// The "After Dark" style block — mirrors the canonical definition in
// gems-canvas.js FILTER_GRADES (key "after-dark"). Appended when the user asks
// for this vibe by name or trigger word, so AI re-grades match the filter.
const AFTER_DARK_TRIGGERS =
  /\b(after dark|quiet money|dark batman|batman vibe|moody luxury|dark aesthetic|moody)\b/i;
const AFTER_DARK_STYLE = `

STYLE — After Dark (moody luxury, low-exposure): Re-grade the photo, do not regenerate it. Pull overall exposure down roughly one stop so the scene reads dusk-like even if shot in daylight. Compress highlights: skies become steel-blue or navy with retained gradient detail, never white and never clipped. Deepen shadows and blacks but keep them CLEAN and keep the subject's silhouette readable — deliberate low-key, not underexposure. Desaturate globally about 25%, pushing greens toward dark emerald and blues toward navy; protect skin tones, muting them only slightly. Slightly cool color temperature. No added grain, no matte/faded lift, no vignette heavier than subtle. Preserve the subject's exact facial identity, pose, clothing, and composition. Mood: quiet, expensive, cinematic — a lone figure against light, wealth in shadow. Do not crush shadow detail into pure black. Do not add film grain. Do not blow or tint highlights orange. Do not brighten the sky.`;

// Auto-aesthetic ("edit this for me"): the model looks at the imported photo,
// matches it to the CLOSEST founder-defined setting, and applies ONLY that
// setting's light + color grade — never changing the subject, framing, or content.
// The recipes mirror eval/references/aspirational/NOTES.md.
const AUTO_AESTHETIC_TRIGGERS =
  /\b(edit this for me|edit it for me|match the vibe|match the look|make it (look )?(good|aesthetic|better)|make this look good|auto[- ]?edit|best edit|fix the (lighting|colors?|grade)|give it the vibe)\b/i;

// The craft of brilliant editing — a colorist's method + taste. Shared by the
// auto-aesthetic grade and any color/light edit, so edits READ as intentional and
// subtle, not one-tap filters.
const EDITING_CRAFT = `BRILLIANT EDITING — work like a world-class photo colorist, not a one-tap filter. A brilliant edit is INTENTIONAL and SUBTLE: it makes the photo feel like the best, most real version of itself — the viewer should FEEL it, not spot it.
METHOD (reason through this before you touch the grade):
1. READ the photo: its current exposure, white balance and any color cast, contrast, where the shadows and highlights actually sit, skin-tone accuracy, and what is genuinely holding the image back.
2. DIAGNOSE what THIS specific photo needs — a real judgment, not a preset (e.g. "shadows are muddy and slightly green → lift a touch and warm them; highlights are already clipped → protect them, don't chase them back; skin reads a little pale → add gentle warmth and a hint of vibrance").
3. GRADE with a colorist's tools: white balance (temperature + tint), a gentle tone curve for contrast, HSL per colour (deepen foliage greens, hold a true-blue sky, keep skin clean), split-toning (usually warm highlights / cooler shadows), VIBRANCE before saturation, clarity/texture in moderation, and selective skin protection.
TASTE (non-negotiable):
- SUBTLE beats heavy every time — under-grade rather than overcook. Crushed blacks, radioactive saturation, HDR flatness, heavy vignette and plastic skin are amateur tells; avoid them.
- PROTECT SKIN: natural, healthy, true-to-them tones with real texture — never orange, waxy, or grey.
- Keep it filmic and believable — a beautifully-shot real photo, not a filter.
- Respect the photo's own intent: a moody, dim, or grainy shot is a deliberate look — enhance it, don't "fix" it into bright-and-clean.`;

const AUTO_AESTHETIC_PREAMBLE = `${EDITING_CRAFT}

Now apply that craft as an AUTO GRADE. RE-GRADE this photo — do NOT regenerate it. Keep the subject, faces, identity, pose, framing, background, and every object EXACTLY as-is; change ONLY lighting, color, contrast, and mood.

STEP 1 — READ the photo and identify which of these real-world settings it is CLOSEST to (by its content and existing light). STEP 2 — apply that setting's LIGHT + GRADE recipe, executed with the craft and taste above. If it clearly matches none, apply a tasteful, natural, true-to-life grade (gentle contrast, honest color, protected skin) rather than forcing a look.

RECIPES:
- MEDITERRANEAN VILLAGE, GOLDEN HOUR (stone/plaster walls, shutters, cobbles, alley, warm low sun): warm golden side-light, long soft shadows, Kodak Portra warmth, lifted warm shadows, soft highlight rolloff, teal-and-tan, honey midtones, gentle grain. Never oversaturated.
- COLORFUL ITALIAN STREET, BRIGHT DAY (yellow/ochre buildings, narrow lane, arch/tunnel): keep the subject in soft even light while the background stays bright; warm clean ochre/yellow, a clear blue-sky slice, mild film warmth, controlled saturation, natural vignette from any arch.
- ELEVATED COAST/BAY VISTA (high vantage, vast sea, distant headland, yachts): warm foreground with a COOL, slightly-hazy, desaturated blue distance (atmospheric perspective); soft contrast, elegant and muted, never punchy.
- BOAT / OPEN SEA, MIDDAY (teak deck, chrome, deep blue water, wake, clear sky): bright hard sun with sea-reflected fill, true vivid blues (navy sea, azure sky), warm teak brown, clean whites, crisp high-clarity, keep sun-sparkle on water.
- CRYSTAL WATER / SWIM (transparent teal-green water over reef, wet tanned skin): make the water GLOW aqua-to-emerald with caustic sun-dapple, high-key and luminous, warm protected skin, specular sheen on wet skin.
- CHIC BEACH CLUB (striped umbrellas, day-beds, cabanas, white sand, turquoise water): high-key and bright with true turquoise water, warm sand and crisp whites; sunny but controlled saturation, protected skin, keep the sun-sparkle — never blown-out or candy-HDR.
- LUXURY SIGNIFIER / GRAND ARCHITECTURE or CLASSIC CAR (ornate facade, boutique, Riviera street): warm gold, muted elegant film-like grade, low saturation, gentle contrast, hazy warm air — "quiet wealth," never neon or HDR.
- FRAMED LAKE / VILLA VISTA (arch or window onto lake, mountains, styled interior foreground): keep the interior foreground a touch darker so the view beyond GLOWS; warm creams, lush greens, lake blue, serene and soft.
- WARM NIGHT / DIM INTERIOR (string lights, tungsten lamps, lit facade, dim lobby): warm amber highlights, deep shadows kept clean, protected skin, muted — do NOT brighten it into daylight; embrace the low-key mood.

HARD RULES: this is a GRADE, not a new image. Preserve exact facial identity, pose, clothing, composition, and all content. Do not add or remove anything, do not relight the geometry, do not beautify or reshape the face, do not add heavy grain or vignette. Return the re-graded image at the same dimensions.`;

// Transformative "Looks" — unlike a precise edit, these reimagine the photo as a
// polished professional shot (relight, retouch, restyle) while keeping the exact
// person. Built for the athlete "college commitment / signing-day" use case.
const TRANSFORM_PREAMBLE =
  `You are a professional photo studio inside Gems. Reimagine this photo as the requested professional look. Unlike a precise edit, here you MAY relight, retouch, and restyle to reach a polished, believable, high-end result.
CRITICAL — identity is sacred: keep the person's EXACT face, facial features, bone structure, skin tone, age, hair, and body proportions. It must unmistakably be the SAME person — never swap to a different face, never beautify them into someone else, never slim or reshape them, and never change their ethnicity or age.
You MAY: apply flattering studio/editorial lighting, natural skin retouch that KEEPS real skin texture, clean up or tastefully replace the background, and refine wardrobe/styling to fit the look. Keep it natural and magazine-quality — never plastic, waxy, or over-processed. Do not add or remove other people. Return the edited image.`;

const LOOKS: Record<string, string> = {
  "agency headshot":
    "A clean professional agency/modeling headshot: soft key light, seamless neutral studio background, tack-sharp focus on the face, confident natural expression — crisp and high-end.",
  "editorial":
    "A dramatic editorial sports portrait with magazine-cover quality: bold directional lighting, rich contrast, cinematic mood; the athlete looks powerful and iconic.",
  "studio portrait":
    "A polished studio portrait: soft flattering lighting, gentle shallow depth of field, clean backdrop, warm and premium.",
  "commitment":
    "A hero athlete portrait for a college-commitment / signing-day announcement: strong flattering light, a clean or tasteful stadium-appropriate background, confident heroic framing, sharp and celebratory — the standout image an athlete posts announcing their college commitment.",
  "linkedin":
    "A professional corporate headshot: business-appropriate, approachable, evenly lit, neutral office or seamless background.",
  "model portfolio":
    "A high-fashion model portfolio shot: editorial styling, striking lighting, elevated and aspirational while still natural and believable.",
};

const LOOK_ALIASES: Record<string, string[]> = {
  "agency headshot": ["agency headshot", "agency photo", "agency look", "professional headshot", "professional photo"],
  editorial: ["editorial", "magazine", "cover shot", "sports editorial"],
  "studio portrait": ["studio portrait", "studio shot", "studio photo"],
  commitment: ["commitment", "signing day", "committed", "college commit", "signing-day"],
  linkedin: ["linkedin", "corporate headshot", "business headshot"],
  "model portfolio": ["model portfolio", "modeling shot", "fashion editorial", "portfolio shot"],
};

function detectLook(instruction: string): string | null {
  const t = instruction.toLowerCase();
  for (const [key, aliases] of Object.entries(LOOK_ALIASES)) {
    if (aliases.some((a) => t.includes(a))) return key;
  }
  return null;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// The gateway verified the JWT signature (verify_jwt); the payload sub is trustworthy.
function userIdFromAuth(header: string | null): string | null {
  try {
    const token = header?.replace(/^Bearer\s+/i, "") ?? "";
    const payload = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")), (c) =>
          c.charCodeAt(0),
        ),
      ),
    );
    // Require role=authenticated, matching every other function. The anon/
    // service tokens carry a different role, so a token that isn't a real
    // signed-in user's is rejected here rather than only at the gateway.
    return typeof payload.sub === "string" && payload.role === "authenticated" ? payload.sub : null;
  } catch {
    return null;
  }
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (request.method !== "POST") return json(405, { error: "POST only" });
  if (!GEMINI_API_KEY) return json(503, { error: "GEMINI_API_KEY is not configured" });

  const userId = userIdFromAuth(request.headers.get("authorization"));
  if (!userId) return json(401, { error: "no user" });

  let body: {
    instruction?: string;
    kind?: string;
    photoId?: string;
    imageBase64?: string;
    mimeType?: string;
    maskBase64?: string; // optional: white = the region to edit (manual eraser/brush)
    style?: string; // optional named style, e.g. "after-dark"
  };
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid JSON body" });
  }
  const instruction = String(body.instruction ?? "").trim();
  if (!instruction) return json(400, { error: "instruction required" });
  if (instruction.length > 600) return json(400, { error: "instruction too long (600 max)" });
  if (!body.imageBase64) return json(400, { error: "imageBase64 required" });
  const kind = String(body.kind ?? "describe").slice(0, 40) || "describe";
  const hasMask = typeof body.maskBase64 === "string" && body.maskBase64.length > 0;

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    // ---- Guardrail (#8): enforce the free-tier cap BEFORE the model call.
    const { data: profile } = await supabase
      .from("profiles")
      .select("plan")
      .eq("id", userId)
      .maybeSingle();
    const plan = profile?.plan ?? "free";
    if (plan === "free") {
      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      const { count } = await supabase
        .from("taste_events")
        .select("id", { count: "exact", head: true })
        .eq("profile_id", userId)
        .eq("event_type", "edit_generated")
        .gte("created_at", monthStart.toISOString());
      if ((count ?? 0) >= FREE_EDITS_PER_MONTH) {
        return json(402, {
          error: "edit_cap_reached",
          paywall: true,
          cap: FREE_EDITS_PER_MONTH,
          used: count,
        });
      }
    }

    // ---- The edit call (Nano Banana 2).
    // With a mask, the SECOND image scopes the edit to the painted region — the
    // manual eraser/brush. Without one, it's a whole-image instruction edit.
    // A transformative "Look" (agency headshot, commitment/signing-day, editorial…)
    // uses the permissive, identity-preserving studio prompt; everything else
    // stays a precise single-change edit.
    // Auto-aesthetic ("edit this for me"): classify the photo to the nearest
    // founder aesthetic and apply only its light + grade. Takes priority over the
    // precise-edit / Look paths. Triggered by phrase or by kind "auto-aesthetic".
    const auto = kind === "auto-aesthetic" || AUTO_AESTHETIC_TRIGGERS.test(instruction);
    const look = auto ? null : detectLook(instruction);
    let promptText = auto
      ? AUTO_AESTHETIC_PREAMBLE
      : look
      ? `${TRANSFORM_PREAMBLE}\n\nTarget look: ${LOOKS[look]}\n\nUser request: ${instruction}`
      : `${EDIT_PREAMBLE}\n\nInstruction: ${instruction}`;
    if (kind === "reroll") {
      promptText += `\nThis is a re-roll: produce a noticeably different interpretation of the same instruction.`;
    }
    // Named-style conditioning: if the ask invokes the After Dark aesthetic,
    // append its grade block so the AI matches the one-tap filter.
    if (AFTER_DARK_TRIGGERS.test(instruction) || body.style === "after-dark") {
      promptText += AFTER_DARK_STYLE;
    }
    if (hasMask) {
      promptText +=
        `\n\nA second image is provided as a MASK. The bright/white areas of the mask mark the ONLY region of the first image you may change. ` +
        `Apply the instruction strictly inside that region and reconstruct what is naturally behind it; every pixel outside the white region must remain byte-for-byte identical. Return the full edited image at the same dimensions.`;
    }

    const parts: Array<Record<string, unknown>> = [
      { text: promptText },
      { inline_data: { mime_type: body.mimeType || "image/jpeg", data: body.imageBase64 } },
    ];
    if (hasMask) {
      parts.push({ inline_data: { mime_type: "image/png", data: body.maskBase64 } });
    }

    const modelResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts }],
        }),
      },
    );
    if (modelResponse.status === 429) {
      return json(503, { error: "image_model_quota", detail: "Editing model quota exceeded — billing may need to be enabled on the Google AI key." });
    }
    if (!modelResponse.ok) {
      const detail = await modelResponse.text();
      return json(502, { error: "image_model_failed", detail: detail.slice(0, 300) });
    }
    const modelData = await modelResponse.json();
    const responseParts: Array<{ inlineData?: { mimeType?: string; data?: string } }> =
      modelData?.candidates?.[0]?.content?.parts ?? [];
    const imagePart = responseParts.find((part) => part.inlineData?.data);
    if (!imagePart?.inlineData?.data) {
      return json(502, { error: "image_model_returned_no_image" });
    }

    // ---- Store the edited output (edits bucket, owner-scoped path) + sign.
    const outMime = imagePart.inlineData.mimeType || "image/png";
    const extension = outMime.includes("jpeg") ? "jpg" : outMime.includes("webp") ? "webp" : "png";
    const storagePath = `${userId}/${body.photoId || "adhoc"}/${crypto.randomUUID()}.${extension}`;
    const bytes = base64ToBytes(imagePart.inlineData.data);
    const { error: uploadError } = await supabase.storage
      .from("edits")
      .upload(storagePath, bytes, { contentType: outMime });
    if (uploadError) return json(502, { error: "storage_upload_failed", detail: uploadError.message });
    const { data: signed, error: signError } = await supabase.storage
      .from("edits")
      .createSignedUrl(storagePath, SIGNED_URL_SECONDS);
    if (signError || !signed?.signedUrl) {
      return json(502, { error: "sign_failed", detail: signError?.message });
    }

    // ---- Metering write: this row is what the guardrail counts.
    await supabase.from("taste_events").insert({
      profile_id: userId,
      event_type: "edit_generated",
      subject: { kind, instruction: instruction.slice(0, 200), model: IMAGE_MODEL, storagePath },
    });

    return json(200, {
      url: signed.signedUrl,
      storagePath,
      model: IMAGE_MODEL,
      kind,
      width: null,
      height: null,
    });
  } catch (error) {
    console.error("edit-photo failed", error);
    return json(502, { error: String((error as Error).message ?? error) });
  }
});
