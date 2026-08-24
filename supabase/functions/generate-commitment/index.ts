// generate-commitment — college commitment / signing-day announcement GRAPHIC.
// Takes the athlete's photo + a school from the directory (public.schools) and
// composes the produced poster with Nano Banana Pro: athlete hero + full body,
// the school's real logo + team colors + mascot, a stadium, and a big stylized
// headline. The athlete's face/identity is preserved; the school's logo is a
// reference image (not hallucinated). Same guardrails as edit-photo/scene.
import { createClient } from "npm:@supabase/supabase-js@2";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const PRO_MODEL = Deno.env.get("GEMINI_PRO_IMAGE_MODEL") ?? "gemini-3-pro-image";
const STANDARD_MODEL = Deno.env.get("GEMINI_IMAGE_MODEL") ?? "gemini-3.1-flash-image";
const FREE_SCENE_UNITS_PER_MONTH = Number(Deno.env.get("FREE_SCENE_UNITS_PER_MONTH") ?? "30");
const SIGNED_URL_SECONDS = 60 * 60 * 24 * 7;

// The athlete's face must read as a real photo of a real person even inside the
// stylized poster — the #1 thing that makes these look AI is a beautified face.
const FACE_FIDELITY = `FACE FIDELITY — CRITICAL. The athlete's face must be the EXACT face from the first attached photo, kept photoreal, not a lookalike or a beautified version:
- Copy their real facial geometry exactly (eyes, nose, mouth, jawline, cheekbones, brow, hairline, ears) and keep every mole, freckle, scar, facial hair and natural asymmetry.
- KEEP REAL SKIN TEXTURE: pores, fine lines, subtle blemishes, uneven tone, stubble, under-eye shadows. Do NOT smooth, airbrush, slim, whiten, de-age or beautify the face. No beauty filter.
- The face is a real photograph composited into the graphic — the poster's lighting and effects wrap around it, they do NOT repaint or stylize the face itself.
BANNED (AI tells): waxy/plastic/porcelain skin, over-smoothed skin, doll or glassy eyes, over-symmetric face, airbrushed influencer look, teeth too white/even, a prettier or different face than the photo.`;

const HEADLINES = new Set(["COMMITTED", "NEXT CHAPTER", "SIGNED", "COMMITTED."]);
const ASPECTS = new Set(["4:5", "1:1", "9:16"]);
// Never generate a specific real person other than the athlete's own photo.
const REFUSE_RE = /\b(as (a )?celebrity|deepfake|(taylor swift|lebron|messi|ronaldo|kardashian|elon musk|trump|biden|drake))\b/i;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

function userIdFromAuth(header: string | null): string | null {
  try {
    const token = header?.replace(/^Bearer\s+/i, "") ?? "";
    const payload = JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
    ));
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
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

const SPORT_LABEL: Record<string, string> = {
  football: "football", mbb: "basketball", wbb: "basketball", baseball: "baseball",
  softball: "softball", msoc: "soccer", wsoc: "soccer", hockey: "hockey", wvb: "volleyball",
  lax: "lacrosse", golf: "golf", track: "track",
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (request.method !== "POST") return json(405, { error: "POST only" });
  if (!GEMINI_API_KEY) return json(503, { error: "GEMINI_API_KEY is not configured" });

  const userId = userIdFromAuth(request.headers.get("authorization"));
  if (!userId) return json(401, { error: "no user" });

  let body: {
    athleteBase64?: string;
    mimeType?: string;
    schoolId?: string;
    sport?: string;
    athleteName?: string;
    headline?: string;
    aspect?: string;
    quality?: string;
  };
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid JSON body" });
  }
  if (!body.athleteBase64) return json(400, { error: "athleteBase64 required" });
  if (!body.schoolId) return json(400, { error: "schoolId required" });
  const athleteName = String(body.athleteName ?? "").trim().slice(0, 60);
  if (REFUSE_RE.test(athleteName)) return json(200, { refused: true, reply: "Use your own name and photo for a commitment post." });
  const headline = HEADLINES.has((body.headline ?? "").toUpperCase()) ? (body.headline as string).toUpperCase() : "COMMITTED";
  const aspect = ASPECTS.has(body.aspect ?? "") ? (body.aspect as string) : "4:5";
  const quality = body.quality === "standard" ? "standard" : "pro";
  const model = quality === "pro" ? PRO_MODEL : STANDARD_MODEL;
  const units = quality === "pro" ? 3 : 1;

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    // ---- Cost cap (units-based, fails open).
    try {
      const { data: profile } = await supabase.from("profiles").select("plan").eq("id", userId).maybeSingle();
      if ((profile?.plan ?? "free") === "free") {
        const monthStart = new Date();
        monthStart.setUTCDate(1);
        monthStart.setUTCHours(0, 0, 0, 0);
        const { data: rows } = await supabase.from("taste_events").select("subject")
          .eq("profile_id", userId).eq("event_type", "scene_generated").gte("created_at", monthStart.toISOString());
        const used = (rows ?? []).reduce((s: number, r: { subject?: { units?: number } }) => s + (r.subject?.units ?? 1), 0);
        if (used + units > FREE_SCENE_UNITS_PER_MONTH) {
          return json(402, { error: "scene_cap_reached", paywall: true, cap: FREE_SCENE_UNITS_PER_MONTH, used });
        }
      }
    } catch (error) {
      console.error("commitment cap check failed (allowing)", error);
    }

    // ---- School branding from the directory.
    const { data: school } = await supabase.from("schools")
      .select("display, mascot, color, alt_color, logo").eq("id", body.schoolId).maybeSingle();
    if (!school) return json(400, { error: "unknown school" });
    const sportLabel = SPORT_LABEL[body.sport ?? ""] ?? "sports";
    const color = school.color ? `#${school.color}` : "team color";
    const altColor = school.alt_color ? `#${school.alt_color}` : "a complementary accent";

    // ---- Parts: athlete photo FIRST (identity), then the school logo (branding).
    const parts: Array<Record<string, unknown>> = [
      { inline_data: { mime_type: body.mimeType || "image/jpeg", data: body.athleteBase64 } },
    ];
    if (school.logo) {
      try {
        const res = await fetch(school.logo);
        if (res.ok) {
          const b64 = await bytesToBase64(new Uint8Array(await res.arrayBuffer()));
          parts.push({ inline_data: { mime_type: res.headers.get("content-type") || "image/png", data: b64 } });
        }
      } catch (error) {
        console.info("logo fetch skipped", error);
      }
    }

    const prompt =
      `Create a professional, high-energy COLLEGE SPORTS COMMITMENT announcement graphic poster — the kind an athlete posts when they commit to a college — in ${aspect} portrait orientation.\n\n` +
      `ATHLETE: the person in the FIRST attached image. Preserve their EXACT face and identity — it must be recognizably them. Feature them prominently: a large dramatic hero cutout from the chest up near the top, and again as a full-body figure standing confidently in the center, wearing a ${sportLabel} uniform.\n\n` +
      `SCHOOL: ${school.display} (the "${school.mascot ?? "team"}"). Use the school's official logo (the SECOND attached image) as a large emblem behind the athlete, and design the entire poster around the team colors ${color} and ${altColor}. Add the ${school.mascot ?? "team"} mascot and a packed ${sportLabel} stadium or arena in the background.\n\n` +
      `HEADLINE: a big bold 3D metallic "${headline}" across the middle in the team colors with a beveled chrome shine.` +
      (athleteName ? ` At the bottom, the athlete's name "${athleteName}" in bold block letters and "${school.display}" underneath in elegant script.` : ` At the bottom, "${school.display}" in elegant script.`) +
      `\n\nSTYLE: hyper-detailed sports-edit / recruiting poster, dramatic stadium lighting, lightning and energy glow in the team colors, cinematic and celebratory, with sharp clean legible text. No extra people.\n\n${FACE_FIDELITY}`;
    parts.push({ text: prompt });

    // ---- Generate.
    const modelResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts }] }) },
    );
    if (modelResponse.status === 429) return json(503, { error: "image_model_quota", detail: "quota exceeded — check Google AI billing." });
    if (!modelResponse.ok) return json(502, { error: "image_model_failed", detail: (await modelResponse.text()).slice(0, 300) });
    const modelData = await modelResponse.json();
    const responseParts: Array<{ inlineData?: { mimeType?: string; data?: string } }> = modelData?.candidates?.[0]?.content?.parts ?? [];
    const imagePart = responseParts.find((p) => p.inlineData?.data);
    if (!imagePart?.inlineData?.data) return json(502, { error: "image_model_returned_no_image" });

    // ---- Store + provenance + meter.
    const outMime = imagePart.inlineData.mimeType || "image/png";
    const ext = outMime.includes("jpeg") ? "jpg" : outMime.includes("webp") ? "webp" : "png";
    const storagePath = `${userId}/commitment/${crypto.randomUUID()}.${ext}`;
    const bytes = base64ToBytes(imagePart.inlineData.data);
    const { error: uploadError } = await supabase.storage.from("edits").upload(storagePath, bytes, { contentType: outMime });
    if (uploadError) return json(502, { error: "storage_upload_failed", detail: uploadError.message });
    const { data: signed, error: signError } = await supabase.storage.from("edits").createSignedUrl(storagePath, SIGNED_URL_SECONDS);
    if (signError || !signed?.signedUrl) return json(502, { error: "sign_failed", detail: signError?.message });

    const { data: project } = await supabase.from("projects").insert({
      profile_id: userId,
      kind: "scene",
      name: `${athleteName || "Athlete"} — ${school.display}`,
      status: "ready",
      meta: {
        ai_generated: true, commitment: true, model_ref: model, storage_path: storagePath,
        school: school.display, sport: body.sport ?? null, headline, aspect, quality,
      },
    }).select("id").maybeSingle();

    await supabase.from("taste_events").insert({
      profile_id: userId, event_type: "scene_generated",
      subject: { units, quality, kind: "commitment", school: school.display, model },
    });

    return json(200, { url: signed.signedUrl, projectId: project?.id ?? null, storagePath, model, aspect, quality, aiGenerated: true });
  } catch (error) {
    console.error("generate-commitment failed", error);
    return json(502, { error: String((error as Error).message ?? error) });
  }
});
