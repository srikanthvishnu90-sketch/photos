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
- Return the edited image.`;

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
    return typeof payload.sub === "string" ? payload.sub : null;
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
    let promptText = `${EDIT_PREAMBLE}\n\nInstruction: ${instruction}`;
    if (kind === "reroll") {
      promptText += `\nThis is a re-roll: produce a noticeably different interpretation of the same instruction.`;
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
    const parts: Array<{ inlineData?: { mimeType?: string; data?: string } }> =
      modelData?.candidates?.[0]?.content?.parts ?? [];
    const imagePart = parts.find((part) => part.inlineData?.data);
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
