// gems-chat — the chat dock orchestrator (Master Features #4).
// Claude behind a strict JSON contract that drives the UI: find / build /
// edit / inspire, max two clarifying chips, edit asks rewritten to precision.
import Anthropic from "npm:@anthropic-ai/sdk";
import { ORCHESTRATOR_PROMPT, buildChatUserMessage } from "./orchestrator-prompt.js";

const CHAT_MODEL = Deno.env.get("GEMS_CHAT_MODEL") ?? "claude-opus-5";

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

const VALID_INTENTS = new Set(["find", "build", "edit", "inspire", "chat"]);
const VALID_SCREENS = new Set(["Photos", "Studio", "Editor", "Discover"]);

// Harden the model output into the exact contract the UI relies on.
function sanitizeContract(raw: unknown): Record<string, unknown> {
  const value = (raw ?? {}) as Record<string, unknown>;
  const intent = VALID_INTENTS.has(value.intent as string) ? (value.intent as string) : "chat";
  const reply =
    typeof value.reply === "string" && value.reply.trim()
      ? value.reply.trim().slice(0, 240)
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
  return { intent, reply, action, clarify, editInstruction, rankRequest, model: CHAT_MODEL };
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
  if (!userIdFromAuth(request.headers.get("authorization"))) return json(401, { error: "sign in required" });

  let body: { message?: string; userAesthetics?: string[]; screen?: string };
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid JSON body" });
  }
  const message = String(body.message ?? "").trim();
  if (!message) return json(400, { error: "message required" });
  if (message.length > 2000) return json(400, { error: "message too long" });

  try {
    const anthropic = new Anthropic();
    const response = await anthropic.messages.create({
      model: CHAT_MODEL,
      max_tokens: 1024,
      system: ORCHESTRATOR_PROMPT,
      messages: [
        {
          role: "user",
          content: buildChatUserMessage({
            message,
            userAesthetics: Array.isArray(body.userAesthetics) ? body.userAesthetics : [],
            screen: body.screen,
          }),
        },
      ],
    });
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
    return json(200, sanitizeContract(contract));
  } catch (error) {
    console.error("gems-chat failed", error);
    return json(502, { error: String((error as Error).message ?? error) });
  }
});
