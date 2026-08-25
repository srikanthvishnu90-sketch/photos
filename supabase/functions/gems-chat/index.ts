// gems-chat — the chat dock orchestrator (Master Features #4).
// Claude behind a strict JSON contract that drives the UI: find / build /
// edit / inspire, max two clarifying chips, edit asks rewritten to precision.
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";
import { ORCHESTRATOR_PROMPT, buildChatUserMessage } from "./orchestrator-prompt.js";

const CHAT_MODEL = Deno.env.get("GEMS_CHAT_MODEL") ?? "claude-opus-5";
// Per-user monthly cap (free tier) so Claude spend can't run away at scale.
const FREE_CHATS_PER_MONTH = Number(Deno.env.get("FREE_CHATS_PER_MONTH") ?? "250");

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

// Require a real signed-in user — the public apikey alone (which ships in the
// client JS) must not be able to spend Claude budget.
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

const VALID_INTENTS = new Set(["find", "build", "edit", "inspire", "chat", "generate"]);
const VALID_PACKS = new Set(["euro-summer", "dubai", "old-money", "luxury-cars", "boat", "dark-luxe", "after-dark"]);
const VALID_SCREENS = new Set(["Photos", "Studio", "Editor", "Discover"]);

// Harden the model output into the exact contract the UI relies on.
function sanitizeContract(raw: unknown): Record<string, unknown> {
  const value = (raw ?? {}) as Record<string, unknown>;
  const intent = VALID_INTENTS.has(value.intent as string) ? (value.intent as string) : "chat";
  const reply =
    typeof value.reply === "string" && value.reply.trim()
      ? value.reply.trim().slice(0, 400)
      : "I'm here — ask me anything about your photos.";
  let action: Record<string, unknown> | null = null;
  const rawAction = value.action as Record<string, unknown> | null;
  if (rawAction && VALID_SCREENS.has(rawAction.navigate as string)) {
    action = {
      navigate: rawAction.navigate,
      payload: typeof rawAction.payload === "object" && rawAction.payload ? rawAction.payload : {},
    };
  }
  let clarify: Array<{ label: string; value: string }> | null = null;
  if (Array.isArray(value.clarify)) {
    clarify = value.clarify
      .filter((chip) => chip && typeof chip.label === "string" && typeof chip.value === "string")
      .slice(0, 2)
      .map((chip) => ({ label: chip.label.slice(0, 40), value: chip.value.slice(0, 120) }));
    if (!clarify.length) clarify = null;
  }
  const editInstruction =
    typeof value.editInstruction === "string" && value.editInstruction.trim()
      ? value.editInstruction.trim().slice(0, 600)
      : null;
  let rankRequest: Record<string, unknown> | null = null;
  const rawRank = value.rankRequest as Record<string, unknown> | null;
  if (rawRank && typeof rawRank.request === "string") {
    rankRequest = {
      request: rawRank.request.slice(0, 200),
      purpose: ["cover", "dump", "dating", "profile", "graphic", "general"].includes(
        rawRank.purpose as string,
      )
        ? rawRank.purpose
        : "general",
    };
  }
  let photos: string[] | null = null;
  if (Array.isArray(value.photos)) {
    photos = value.photos.filter((x) => typeof x === "string" && x).slice(0, 8);
    if (!photos.length) photos = null;
  }
  let generate: Record<string, unknown> | null = null;
  const rawGen = value.generate as Record<string, unknown> | null;
  if (rawGen && (rawGen.kind === "scene" || rawGen.kind === "commitment")) {
    generate = {
      kind: rawGen.kind,
      stylePack: VALID_PACKS.has(rawGen.stylePack as string) ? rawGen.stylePack : null,
      mode: rawGen.mode === "background" ? "background" : "me",
      prompt: typeof rawGen.prompt === "string" ? rawGen.prompt.slice(0, 300) : null,
    };
  }
  return { intent, reply, action, clarify, editInstruction, rankRequest, photos, generate, model: CHAT_MODEL };
}

function parseModelJson(text: string): unknown {
  const cleaned = text.replace(/^```(?:json)?/m, "").replace(/```\s*$/m, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON in model output");
  return JSON.parse(cleaned.slice(start, end + 1));
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (request.method !== "POST") return json(405, { error: "POST only" });
  if (!Deno.env.get("ANTHROPIC_API_KEY")) {
    return json(503, { error: "ANTHROPIC_API_KEY is not configured" });
  }
  const userId = userIdFromAuth(request.headers.get("authorization"));
  if (!userId) return json(401, { error: "sign in required" });

  let body: {
    message?: string;
    userAesthetics?: string[];
    screen?: string;
    history?: Array<{ role?: string; text?: string }>;
    context?: {
      library?: Record<string, unknown> | null;
      relevantPhotos?: Array<{ id?: string; caption?: string }>;
      taste?: Record<string, unknown> | null;
    };
    images?: Array<{ base64?: string; mimeType?: string }>;
  };
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid JSON body" });
  }
  const message = String(body.message ?? "").trim();
  if (!message) return json(400, { error: "message required" });
  if (message.length > 2000) return json(400, { error: "message too long" });

  // Prior turns → a clean alternating user/assistant transcript (most recent 8),
  // so the model can hold a back-and-forth without re-asking. Assistant turns
  // carry only the plain reply text; the JSON contract stays server-side.
  const priorMessages: Array<{ role: "user" | "assistant"; content: string }> = [];
  if (Array.isArray(body.history)) {
    for (const turn of body.history.slice(-8)) {
      const role = turn?.role === "assistant" ? "assistant" : "user";
      const text = String(turn?.text ?? "").trim().slice(0, 1000);
      if (!text) continue;
      // Enforce strict alternation, starting with a user turn.
      const last = priorMessages[priorMessages.length - 1];
      if (!last && role !== "user") continue;
      if (last && last.role === role) { last.content = text; continue; }
      priorMessages.push({ role, content: text });
    }
  }
  // The new user message must follow an assistant turn (or start the thread).
  if (priorMessages[priorMessages.length - 1]?.role === "user") priorMessages.pop();

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    // ---- Free-tier guardrail BEFORE the model call (fails open on DB error).
    try {
      const { data: profile } = await supabase
        .from("profiles").select("plan").eq("id", userId).maybeSingle();
      if ((profile?.plan ?? "free") === "free") {
        const monthStart = new Date();
        monthStart.setUTCDate(1);
        monthStart.setUTCHours(0, 0, 0, 0);
        const { count } = await supabase
          .from("taste_events")
          .select("id", { count: "exact", head: true })
          .eq("profile_id", userId)
          .eq("event_type", "chat_message")
          .gte("created_at", monthStart.toISOString());
        if ((count ?? 0) >= FREE_CHATS_PER_MONTH) {
          return json(402, { error: "chat_cap_reached", paywall: true, cap: FREE_CHATS_PER_MONTH });
        }
      }
    } catch (error) {
      console.error("chat cap check failed (allowing)", error);
    }

    // Attached photos → Claude sees them (vision critique/comparison). Cap count
    // and total size so a runaway payload can't blow the request up.
    const rawImages = Array.isArray(body.images) ? body.images.slice(0, 4) : [];
    const imageBlocks = rawImages
      .filter((im) => typeof im?.base64 === "string" && im.base64.length > 0 && im.base64.length < 7_000_000)
      .map((im) => ({
        type: "image" as const,
        source: { type: "base64" as const, media_type: (im.mimeType || "image/jpeg"), data: im.base64 as string },
      }));

    const userText = buildChatUserMessage({
      message,
      userAesthetics: Array.isArray(body.userAesthetics) ? body.userAesthetics : [],
      screen: body.screen,
      context: body.context ?? null,
    });
    const userContent = imageBlocks.length
      ? [...imageBlocks, { type: "text" as const, text: userText }]
      : userText;

    const anthropic = new Anthropic();
    const response = await anthropic.messages.create({
      model: CHAT_MODEL,
      max_tokens: 1024,
      system: ORCHESTRATOR_PROMPT,
      messages: [...priorMessages, { role: "user", content: userContent }],
    });
    // Meter the model call (counts toward the monthly cap; ignore insert errors).
    try {
      await supabase.from("taste_events").insert({
        profile_id: userId,
        event_type: "chat_message",
        subject: { model: CHAT_MODEL, screen: body.screen ?? null },
      });
    } catch (error) {
      console.error("chat meter insert failed", error);
    }
    if (response.stop_reason === "refusal") {
      return json(200, sanitizeContract({ intent: "chat", reply: "Let's keep it about your photos — what would you like to make?" }));
    }
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => (block as { text: string }).text)
      .join("");
    let contract: unknown;
    try {
      contract = parseModelJson(text);
    } catch {
      contract = { intent: "chat", reply: text.slice(0, 200) };
    }
    const result = sanitizeContract(contract);
    // Only surface photo ids we actually provided (never hallucinated ones).
    if (Array.isArray(result.photos)) {
      const allowed = new Set(
        (body.context?.relevantPhotos ?? [])
          .map((p) => p?.id)
          .filter((id): id is string => typeof id === "string"),
      );
      const filtered = (result.photos as string[]).filter((id) => allowed.has(id));
      result.photos = filtered.length ? filtered : null;
    }
    return json(200, result);
  } catch (error) {
    console.error("gems-chat failed", error);
    return json(502, { error: String((error as Error).message ?? error) });
  }
});
