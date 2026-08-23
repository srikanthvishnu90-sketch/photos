// rank-photos — the Gems scoring brain (see docs/rank-photos.md).
// Pass A ("describe"): vision call, once per photo, caller caches forever.
// Pass B ("rank"): text-only call on cached descriptions, cheap, per request.
// Requires a signed-in Supabase user (verify_jwt) — model calls cost money.
import { PASS_A_PROMPT, buildPassBPrompt, PURPOSES } from "./prompts.js";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-2.5-flash";
const MAX_BATCH = 16;

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

async function callGemini(parts: unknown[]): Promise<string> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          response_mime_type: "application/json",
          temperature: 0.2,
        },
      }),
    },
  );
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`gemini ${response.status}: ${detail.slice(0, 300)}`);
  }
  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== "string") throw new Error("gemini returned no text");
  return text;
}

// The model is asked for JSON-only output, but harden anyway: strip fences,
// then parse the outermost object.
function parseModelJson(text: string): unknown {
  const cleaned = text.replace(/^```(?:json)?/m, "").replace(/```\s*$/m, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object in model output");
  return JSON.parse(cleaned.slice(start, end + 1));
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (request.method !== "POST") return json(405, { error: "POST only" });
  if (!GEMINI_API_KEY) return json(503, { error: "GEMINI_API_KEY is not configured" });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid JSON body" });
  }

  try {
    if (body.action === "describe") {
      // photos: [{ id, mimeType, base64 }] — thumbnails, 512px max edge.
      const photos = Array.isArray(body.photos) ? body.photos : [];
      if (!photos.length) return json(400, { error: "photos[] required" });
      if (photos.length > MAX_BATCH) {
        return json(400, { error: `max ${MAX_BATCH} photos per call` });
      }
      const parts: unknown[] = [{ text: PASS_A_PROMPT }];
      photos.forEach((photo: { mimeType?: string; base64?: string }, index: number) => {
        parts.push({ text: `Image ${index}:` });
        parts.push({
          inline_data: {
            mime_type: photo.mimeType || "image/jpeg",
            data: photo.base64,
          },
        });
      });
      const raw = await callGemini(parts);
      const parsed = parseModelJson(raw) as { photos?: unknown[] };
      if (!Array.isArray(parsed.photos)) throw new Error("model output missing photos[]");
      // Hand descriptions back paired with the caller's ids — the caller owns caching.
      const described = parsed.photos.map((entry) => {
        const item = entry as { index?: number };
        const id = (photos[item.index ?? -1] as { id?: string } | undefined)?.id ?? null;
        return { id, ...(entry as Record<string, unknown>) };
      });
      return json(200, { photos: described, model: GEMINI_MODEL });
    }

    if (body.action === "rank") {
      const descriptions = Array.isArray(body.descriptions) ? body.descriptions : [];
      if (!descriptions.length) return json(400, { error: "descriptions[] required" });
      const purpose = PURPOSES.includes(body.purpose as string)
        ? (body.purpose as string)
        : "general";
      const raw = await callGemini([
        {
          text: buildPassBPrompt({
            request: String(body.request ?? "my best photos"),
            purpose,
            userAesthetics: Array.isArray(body.userAesthetics) ? body.userAesthetics : [],
            tasteSummary: String(body.tasteSummary ?? ""),
            descriptions,
          }),
        },
      ]);
      const parsed = parseModelJson(raw) as { ranking?: unknown[] };
      if (!Array.isArray(parsed.ranking)) throw new Error("model output missing ranking[]");
      return json(200, { ranking: parsed.ranking, purpose, model: GEMINI_MODEL });
    }

    return json(400, { error: 'action must be "describe" or "rank"' });
  } catch (error) {
    console.error("rank-photos failed", error);
    return json(502, { error: String((error as Error).message ?? error) });
  }
});
