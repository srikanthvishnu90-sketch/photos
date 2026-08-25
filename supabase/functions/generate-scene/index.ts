// generate-scene — photoreal, reference-conditioned AI image generation for Gems
// "Scenes" (and optional identity-preserving "me in a scene"). Same guardrails as
// edit-photo: JWT auth, per-user monthly generative cap (pro = 3 units), owner-
// scoped storage, provenance on every output, metered to taste_events. Outputs
// are projects of kind 'scene' — they never enter Discover / carousel / ranking
// (those read the on-device photo library, a separate store).
import { createClient } from "npm:@supabase/supabase-js@2";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const STANDARD_MODEL = Deno.env.get("GEMINI_IMAGE_MODEL") ?? "gemini-3.1-flash-image";
const PRO_MODEL = Deno.env.get("GEMINI_PRO_IMAGE_MODEL") ?? "gemini-3-pro-image";
const FREE_SCENE_UNITS_PER_MONTH = Number(Deno.env.get("FREE_SCENE_UNITS_PER_MONTH") ?? "30");
const SIGNED_URL_SECONDS = 60 * 60 * 24 * 7;
const MAX_REFS = 3;

// Always appended so output reads as a real smartphone photo, not AI art.
const REALISM_LAYER = `REALISM REQUIREMENTS — this must read as a real smartphone photograph, not AI art:
Rendered as if shot on a recent iPhone: natural sensor behavior, believable dynamic range, slight highlight rolloff. Composition slightly imperfect and casual — a real person's framing, not a tripod or drone-perfect shot; small amounts of tilt or off-center placement are good. Natural micro-imperfections: subtle lens softness toward edges, faint noise in shadows, real-world clutter and asymmetry in the environment (cords, smudges, uneven objects). Physically consistent lighting with one believable light logic and correct shadows and reflections. Materials must have true texture: fabric weave, skin pores, fingerprints on glass, wear on surfaces. ABSOLUTELY AVOID the AI tells: plastic or waxy skin, perfect symmetry, over-smooth gradients, hyper-saturated HDR look, warped or gibberish text, impossible reflections, extra fingers, melted object boundaries, dreamlike depth of field.
FAILURE-DERIVED RULES (these are the tells that survive even excellent generation — obey them):
- UNEVEN ARCHITECTURAL LIGHT: in any lit building, ruin, or facade, illumination through multiple openings must be UNEVEN — some windows/arches bright, some dim, some fully dark where real interior structure would block the light. Never render a uniform glow of equal intensity through many openings (the averaging signature).
- IMPERFECT STAGING: real scenes are not art-directed. Foreground props must be asymmetric; include at least one mundane, slightly out-of-theme object (a stray napkin, a cord, a neighbor's clutter, a sign). NEVER symmetric flanking decor (matched potted trees on each side), never a perfectly centered, spotless composition.
- TIME-OF-DAY COHERENCE: food, activity, crowd density, sky state, streetlights, and shadow direction must all agree on ONE hour of day. Never breakfast food under night lighting, or a bright midday sky with lit interior lamps.
- ENTROPY: fill the world with hundreds of small uncurated real-world decisions — mismatched shutters, antennas, laundry, worn edges, people mid-errand rather than posed. Sterile perfection reads as fake.
- SATURATION CEILING: keep color controlled and muted; NEVER the radioactive-teal / candy-HDR / over-saturated tone-compressed look. Over-editing is its own uncanny valley — restrained grade over punchy every time.`;

const IDENTITY_BLOCK = `The attached photo(s) at the START are all the SAME person — the user. Study them together to lock their exact facial identity, then render that same person in the scene with their skin tone, hair, and build preserved — recognizably them, naturally integrated into the scene's lighting and perspective. Do not beautify, restyle, or alter their face or body.`;

// The single most important block for "don't make me look AI". Appended whenever a
// real person is in the output. Stops the model from beautifying/airbrushing the
// face — the #1 cause of the synthetic look.
const FACE_FIDELITY = `FACE FIDELITY — THE SINGLE MOST IMPORTANT REQUIREMENT. The face in the output must be the EXACT face from the user's attached reference photo(s) — not a lookalike, not an "improved" version:
- Copy their real facial geometry precisely: eye shape and spacing, nose, mouth, lips, jawline, cheekbones, brow, hairline, ears, and every mole, freckle, scar, facial hair and natural asymmetry.
- KEEP REAL SKIN: visible pores, fine lines, natural texture, subtle blemishes, uneven tone, stubble, under-eye shadows. Do NOT smooth, airbrush, slim, whiten, de-age, or beautify. Apply NO beauty filter.
- Match their real skin tone and complexion exactly, including any redness or unevenness.
- Expression and gaze stay natural and candid — never posed-perfect or model-like.
BANNED AI TELLS (these ruin it): waxy / plastic / porcelain / rubbery skin, over-smoothed or blurred skin, doll-like or glassy eyes, perfectly symmetric face, airbrushed "influencer" look, mannequin sheen, over-sharpened HDR, teeth too white or too even, or any face that looks prettier or different than the real photo.`;

// When the caller wants to recreate a specific reference photo AS themselves
// ("put me in this exact shot" / face-swap): reproduce the reference composition
// but the subject is the user. The FIRST attached image is the user's face; the
// LAST attached image is the reference to match.
const MATCH_REFERENCE_BLOCK = `RECREATE THE ATTACHED REFERENCE PHOTO, but the person in it is the user from the first attached image. Match the reference's composition, camera angle, framing, pose, distance, setting, lighting, color grade and overall mood as closely as possible — it should look like the same photograph, simply taken of the user instead. Keep the user's exact face and identity (this is a face/identity swap, not a lookalike). Preserve realistic body proportions consistent with the user.`;

// Aesthetic-background mode: no person at all — just the place/scene.
const BACKGROUND_BLOCK = `Generate an ATMOSPHERIC SCENE with NO people in it — an empty, aspirational location photograph (an "aesthetic background"). No human figures, no faces, no silhouettes of people. Focus entirely on the environment, light, and mood.`;

const NEGATIVE = "No watermark-style text, no captions, no borders.";

// Named style packs mirror the canonical client definitions (gems-canvas.js).
const STYLE_PACKS: Record<string, string> = {
  "after-dark":
    "STYLE — After Dark (moody luxury, low-exposure): dusk-like underexposure even in daylight; steel-blue/navy skies with retained detail, never blown; deep clean blacks, muted color (~-25% saturation), greens toward dark emerald and blues toward navy, protected skin tones; slightly cool temperature; no added grain, subtle vignette at most. Quiet, expensive, cinematic.",
  "dark-luxe":
    "STYLE — Dark Luxe (quiet-wealth, cinematic): the aesthetic of a high-floor luxury penthouse and moody five-star resort. SETTINGS (pick what fits the request): a modern penthouse with floor-to-ceiling glass over a hazy city skyline (Dubai/Gulf-tower energy — distant towers, warm dusk or bright daytime haze); a dim, expensively-furnished suite with a single warm lamp glowing against a blue-hour cityscape; a dark infinity or resort pool at dusk framed by deep-green tropical foliage and teak decking; a palm-lined boulevard shot from a car; marble, brushed metal, boucle and cream upholstery, a laptop and espresso on a low table. LIGHT: low-key and directional — deep protected shadows, one believable warm source (lamp/window), cool blue ambient; underexposed rather than bright, highlights gently rolled off, never blown. COLOR: muted and desaturated (~-20%), greens pushed dark, blues toward steel/navy, warm accents only from practical lights, clean neutral blacks. MOOD: calm, solitary, aspirational — 'a quiet morning at the top of the world', shot candidly on a phone, never staged or glossy-HDR.",
  "euro-summer":
    "STYLE — Euro Summer (men): a warm, film-like European summer travel photograph. WARDROBE: a relaxed linen button-down shirt (white, cream, olive, or terracotta/rust), loose tailored trousers or chinos in cream/stone/olive/grey, leather sandals or espadrilles, optionally a canvas tote and a simple watch — effortless old-money Mediterranean menswear, never flashy, no big logos. SETTING (draw from these real Mediterranean scenes, pick what fits): an Amalfi/Positano cliffside town tumbling to a turquoise sea at golden hour with warm window-lights and cascading bougainvillea; the colorful stacked houses of Cinque Terre / Portofino / Manarola perched over clear teal water; a lemon-draped café terrace (Capri/Amalfi) with wrought-iron bistro tables, majolica-tiled tabletops and iron lanterns; a narrow cobblestone alley of ochre, coral and butter-yellow buildings with green and teal shutters, geraniums in terracotta pots, and laundry strung overhead; a French-Riviera cove with cypress trees, honey-stone houses and moored wooden boats. Recurring notes: magenta bougainvillea, wisteria, lemon trees, marble café tables, worn stone stairs, whitewashed walls and terracotta roofs. LIGHT: warm golden-hour or bright Mediterranean midday with long soft shadows and clear teal water. LOOK: shot on 35mm film (Kodak Portra warmth, gentle grain, soft highlight rolloff) — warm and analog, NEVER the oversaturated candy-HDR Pinterest look. Candid and relaxed — walking, leaning, mid-stride, glancing off-camera — an editorial travel snapshot, never a stiff studio pose.",
};

// Light refusal guard: never generate a specific real person other than the user,
// or an explicitly-requested brand logo. (Incidental logos are allowed.)
const REFUSE_RE =
  /\b(logo of|brand logo|the [a-z]+ logo|nike swoosh|as (a )?celebrity|deepfake|(taylor swift|lebron|kardashian|elon musk|trump|biden|drake|beyonce|messi|ronaldo))\b/i;

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
    return typeof payload.sub === "string" && payload.role === "authenticated" ? payload.sub : null;
  } catch {
    return null;
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function bytesToBase64(bytes: Uint8Array): Promise<string> {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

const ASPECTS = new Set(["4:5", "1:1", "9:16"]);

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (request.method !== "POST") return json(405, { error: "POST only" });
  if (!GEMINI_API_KEY) return json(503, { error: "GEMINI_API_KEY is not configured" });

  const userId = userIdFromAuth(request.headers.get("authorization"));
  if (!userId) return json(401, { error: "no user" });

  let body: {
    prompt?: string;
    referenceAssetIds?: string[];
    stylePackId?: string;
    subjectBase64?: string;
    subjectImages?: string[]; // extra identity reference photos of the SAME user
    aspect?: string;
    quality?: string;
    mode?: string;          // "me" (default) | "background"
    matchReference?: boolean; // recreate the reference photo AS the user (face swap)
    wardrobe?: string;      // optional: change the user's outfit
  };
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid JSON body" });
  }
  const prompt = String(body.prompt ?? "").trim();
  if (!prompt) return json(400, { error: "prompt required" });
  if (prompt.length > 800) return json(400, { error: "prompt too long (800 max)" });
  if (REFUSE_RE.test(prompt)) {
    return json(200, {
      refused: true,
      reply:
        "I can't generate a specific real person or a brand logo. Try describing the scene and vibe — I'll put you in it if you add your own photo.",
    });
  }
  const aspect = ASPECTS.has(body.aspect ?? "") ? (body.aspect as string) : "4:5";
  const mode = body.mode === "background" ? "background" : "me";
  const matchReference = body.mode !== "background" && body.matchReference === true;
  // Identity images = the primary subject photo plus any extra reference photos
  // of the SAME user (from their tagged face cluster). More angles → far stronger
  // identity fidelity than a single selfie.
  const identityImages =
    mode === "background"
      ? []
      : [
          ...(typeof body.subjectBase64 === "string" && body.subjectBase64 ? [body.subjectBase64] : []),
          ...(Array.isArray(body.subjectImages) ? body.subjectImages.filter((s) => typeof s === "string" && s) : []),
        ].slice(0, 5);
  const hasSubjectInput = identityImages.length > 0;
  // Anything with a REAL PERSON in it uses Pro — flash models beautify faces into
  // the AI look, and identity/skin fidelity is the whole point here. Empty
  // aesthetic backgrounds (no face to get wrong) stay on the cheaper standard model.
  const quality = matchReference || hasSubjectInput || body.quality === "pro" ? "pro" : "standard";
  const model = quality === "pro" ? PRO_MODEL : STANDARD_MODEL;
  const units = quality === "pro" ? 3 : 1;
  const refIds = Array.isArray(body.referenceAssetIds)
    ? body.referenceAssetIds.slice(0, MAX_REFS)
    : [];

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    // ---- Cost cap (units-based; pro counts as 3). Fails OPEN on DB error.
    try {
      const { data: profile } = await supabase
        .from("profiles").select("plan").eq("id", userId).maybeSingle();
      if ((profile?.plan ?? "free") === "free") {
        const monthStart = new Date();
        monthStart.setUTCDate(1);
        monthStart.setUTCHours(0, 0, 0, 0);
        const { data: rows } = await supabase
          .from("taste_events")
          .select("subject")
          .eq("profile_id", userId)
          .eq("event_type", "scene_generated")
          .gte("created_at", monthStart.toISOString());
        const usedUnits = (rows ?? []).reduce(
          (sum: number, r: { subject?: { units?: number } }) => sum + (r.subject?.units ?? 1),
          0,
        );
        if (usedUnits + units > FREE_SCENE_UNITS_PER_MONTH) {
          return json(402, {
            error: "scene_cap_reached",
            paywall: true,
            cap: FREE_SCENE_UNITS_PER_MONTH,
            used: usedUnits,
          });
        }
      }
    } catch (error) {
      console.error("scene cap check failed (allowing)", error);
    }

    // ---- Assemble the model parts: subject first (me-in-scene), then refs,
    // then the text prompt (references BEFORE text per the spec).
    const parts: Array<Record<string, unknown>> = [];
    // Background mode is an empty scene — ignore any subject photo entirely.
    const hasSubject = identityImages.length > 0;
    for (const img of identityImages) {
      parts.push({ inline_data: { mime_type: "image/jpeg", data: img } });
    }
    if (refIds.length) {
      // Only the caller's own inspiration assets, downloaded from the private bucket.
      const { data: assets } = await supabase
        .from("inspiration_assets")
        .select("id, storage_path")
        .eq("profile_id", userId)
        .in("id", refIds);
      for (const asset of assets ?? []) {
        try {
          const { data: file } = await supabase.storage.from("inspiration").download(asset.storage_path);
          if (!file) continue;
          const b64 = await bytesToBase64(new Uint8Array(await file.arrayBuffer()));
          parts.push({ inline_data: { mime_type: file.type || "image/jpeg", data: b64 } });
        } catch (error) {
          console.info("ref download skipped", asset.id, error);
        }
      }
    }

    const styleBlock = body.stylePackId && STYLE_PACKS[body.stylePackId]
      ? `\n\n${STYLE_PACKS[body.stylePackId]}`
      : "";
    const wardrobe = String(body.wardrobe ?? "").trim().slice(0, 200);
    const wardrobeBlock =
      hasSubject && wardrobe
        ? `\n\nWARDROBE: dress the user in ${wardrobe}. Keep their face and identity unchanged.`
        : "";
    // Identity handling: face-swap-a-reference > put-me-in-scene > empty scene.
    const identityBlock =
      mode === "background"
        ? `\n\n${BACKGROUND_BLOCK}`
        : matchReference && refIds.length
          ? `\n\n${MATCH_REFERENCE_BLOCK}`
          : hasSubject
            ? `\n\n${IDENTITY_BLOCK}`
            : "";
    const promptText =
      `SCENE REQUEST: ${prompt}` +
      styleBlock +
      `\n\n${REALISM_LAYER}` +
      identityBlock +
      (hasSubject ? `\n\n${FACE_FIDELITY}` : "") +
      wardrobeBlock +
      `\n\nRender as a ${aspect} vertical-friendly aspect ratio. ${NEGATIVE}`;
    parts.push({ text: promptText });

    // ---- Generate.
    const modelResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts }] }),
      },
    );
    if (modelResponse.status === 429) {
      return json(503, { error: "image_model_quota", detail: "quota exceeded — billing may need enabling on the Google AI key." });
    }
    if (!modelResponse.ok) {
      const detail = await modelResponse.text();
      return json(502, { error: "image_model_failed", detail: detail.slice(0, 300) });
    }
    const modelData = await modelResponse.json();
    const responseParts: Array<{ inlineData?: { mimeType?: string; data?: string } }> =
      modelData?.candidates?.[0]?.content?.parts ?? [];
    const imagePart = responseParts.find((part) => part.inlineData?.data);
    if (!imagePart?.inlineData?.data) return json(502, { error: "image_model_returned_no_image" });

    // ---- Store (edits bucket, owner-scoped path) + sign. Preserve returned bytes
    // (incl. any embedded provenance) — no re-encode.
    const outMime = imagePart.inlineData.mimeType || "image/png";
    const ext = outMime.includes("jpeg") ? "jpg" : outMime.includes("webp") ? "webp" : "png";
    const storagePath = `${userId}/scene/${crypto.randomUUID()}.${ext}`;
    const bytes = base64ToBytes(imagePart.inlineData.data);
    const { error: uploadError } = await supabase.storage.from("edits").upload(storagePath, bytes, { contentType: outMime });
    if (uploadError) return json(502, { error: "storage_upload_failed", detail: uploadError.message });
    const { data: signed, error: signError } = await supabase.storage.from("edits").createSignedUrl(storagePath, SIGNED_URL_SECONDS);
    if (signError || !signed?.signedUrl) return json(502, { error: "sign_failed", detail: signError?.message });

    // ---- Provenance: a projects row of kind 'scene', ai_generated flagged.
    const { data: project } = await supabase
      .from("projects")
      .insert({
        profile_id: userId,
        kind: "scene",
        name: prompt.slice(0, 60),
        status: "ready",
        meta: {
          ai_generated: true,
          model_ref: model,
          storage_path: storagePath,
          prompt: prompt.slice(0, 400),
          aspect,
          quality,
          refs: refIds.length,
          style_pack: body.stylePackId ?? null,
          me_in_scene: hasSubject,
          mode,
          match_reference: matchReference,
        },
      })
      .select("id")
      .maybeSingle();

    // ---- Meter (counts toward the monthly cap).
    await supabase.from("taste_events").insert({
      profile_id: userId,
      event_type: "scene_generated",
      subject: { units, quality, refs: refIds.length, style_pack: body.stylePackId ?? null, model },
    });

    return json(200, {
      url: signed.signedUrl,
      projectId: project?.id ?? null,
      storagePath,
      model,
      aspect,
      quality,
      aiGenerated: true,
    });
  } catch (error) {
    console.error("generate-scene failed", error);
    return json(502, { error: String((error as Error).message ?? error) });
  }
});
