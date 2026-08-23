// template-graphics — College-Commitment / Template Graphics (Master Features
// #17) with per-user cost guardrails (#8) enforced BEFORE the model call.
// Source photo + a chosen template → Nano Banana Pro (gemini-3-pro-image, which
// renders crisp, correctly-spelled text) → edits bucket → signed URL out.
// Full-resolution pixels reach this function only for an explicitly requested
// graphic (privacy architecture). verify_jwt gates every call.
import { createClient } from "npm:@supabase/supabase-js@2";
import { buildTemplatePrompt, TEMPLATE_DEFS } from "./prompts.js";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
// Nano Banana Pro. Overridable so the model id can be bumped without a redeploy.
const TEMPLATE_MODEL = Deno.env.get("GEMINI_TEMPLATE_MODEL") ?? "gemini-3-pro-image";
const FREE_TEMPLATES_PER_MONTH = Number(Deno.env.get("FREE_TEMPLATES_PER_MONTH") ?? "5");
const SIGNED_URL_SECONDS = 60 * 60 * 24 * 7;
const MAX_IMAGE_BASE64_BYTES = 14 * 1024 * 1024; // ~14MB inbound payload guard

const KNOWN_SLUGS = new Set(TEMPLATE_DEFS.map((def: { slug: string }) => def.slug));

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

// The gateway verified the JWT signature (verify_jwt); the payload sub is
// trustworthy. We additionally require role=authenticated (never anon).
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
    if (payload.role !== "authenticated") return null;
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
    slug?: string;
    fields?: Record<string, unknown>;
    imageBase64?: string;
    mimeType?: string;
  };
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid JSON body" });
  }

  const slug = String(body.slug ?? "");
  if (!KNOWN_SLUGS.has(slug)) return json(400, { error: "unknown template slug" });
  if (!body.imageBase64) return json(400, { error: "imageBase64 required" });
  if (body.imageBase64.length > MAX_IMAGE_BASE64_BYTES) {
    return json(413, { error: "image too large" });
  }

  const prompt = buildTemplatePrompt(slug, body.fields ?? {});
  if (!prompt) return json(400, { error: "unknown template slug" });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    // ---- Guardrail (#8): enforce the free-tier cap BEFORE the model call.
    // Identical pattern to edit-photo: count this calendar month's generations.
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
        .eq("event_type", "template_generated")
        .gte("created_at", monthStart.toISOString());
      if ((count ?? 0) >= FREE_TEMPLATES_PER_MONTH) {
        return json(402, {
          error: "template_cap_reached",
          paywall: true,
          cap: FREE_TEMPLATES_PER_MONTH,
          used: count,
        });
      }
    }

    // ---- The template call (Nano Banana Pro).
    const modelResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${TEMPLATE_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt.text },
                {
                  inline_data: {
                    mime_type: body.mimeType || "image/jpeg",
                    data: body.imageBase64,
                  },
                },
              ],
            },
          ],
        }),
      },
    );
    if (modelResponse.status === 429) {
      return json(503, {
        error: "image_model_quota",
        detail:
          "Template model quota exceeded — billing may need to be enabled on the Google AI key.",
      });
    }
    if (!modelResponse.ok) {
      const detail = await modelResponse.text();
      console.error("template-graphics model non-ok", modelResponse.status, detail.slice(0, 500));
      return json(502, { error: "image_model_failed" });
    }
    const modelData = await modelResponse.json();
    const parts: Array<{ inlineData?: { mimeType?: string; data?: string } }> =
      modelData?.candidates?.[0]?.content?.parts ?? [];
    const imagePart = parts.find((part) => part.inlineData?.data);
    if (!imagePart?.inlineData?.data) {
      return json(502, { error: "image_model_returned_no_image" });
    }

    // ---- Store the output (edits bucket, owner-scoped templates/ path) + sign.
    const outMime = imagePart.inlineData.mimeType || "image/png";
    const storagePath = `${userId}/templates/${crypto.randomUUID()}.png`;
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
      event_type: "template_generated",
      subject: { slug, model: TEMPLATE_MODEL, storagePath },
    });

    return json(200, {
      url: signed.signedUrl,
      storagePath,
      slug,
      model: TEMPLATE_MODEL,
    });
  } catch (error) {
    console.error("template-graphics failed", error);
    return json(502, { error: String((error as Error).message ?? error) });
  }
});
