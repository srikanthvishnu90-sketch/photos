// interpret-edit — the Edit Interpreter (v2). Turns nuanced human phrasing into a
// precise JSON PLAN of typed operations, so the client can run each op against the
// right engine. The core rule: deterministic engines (crop/rotate/slider adjusts)
// NEVER go to the generative model. Only expand/generative_edit/scenario do.
//
// The CLIENT resolves most simple cases locally (see gems-edit-interpreter.js) and
// only calls this function for the hard ones (scenario placement, ambiguous asks,
// compound content edits). Same guardrails as the other functions: JWT auth, a
// light per-user monthly cap on the text call, metered to taste_events.
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL = Deno.env.get("GEMS_INTERPRET_MODEL") ?? "claude-opus-5";
// A small, fast text call — the cap is generous. Fails open on DB error.
const FREE_INTERPRETS_PER_MONTH = Number(Deno.env.get("FREE_INTERPRETS_PER_MONTH") ?? "800");

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

// Never place a real person other than the user; never a dangerous/self-harm
// placement (handled with a safe substitution downstream, not a hard block).
const REFUSE_REAL_PERSON =
  /\b(put|add|place|insert)\b.{0,40}\b(my (ex|friend|girlfriend|boyfriend|mom|dad|sister|brother|teacher|boss)|him|her|them|celebrity|taylor swift|lebron|messi|ronaldo|drake|kardashian|elon musk|trump|biden)\b/i;

const VALID_OPS = new Set([
  "crop", "expand", "adjust", "local_adjust", "generative_edit", "scenario", "style", "rotate",
]);
const GENERATIVE_OPS = new Set(["expand", "generative_edit", "scenario"]);

// ---- The interpreter system prompt (embedded verbatim from the spec, extended).
const SYSTEM_PROMPT = `You are the Edit Interpreter for Gems. Convert the user's instruction into a
JSON plan of typed operations. You are precise about magnitude, target, and
engine. Rules:
1. Deterministic before generative: crops, rotations, and slider adjustments
   are client-side ops with numeric parameters — never generative.
2. Use the quantifier table for vague amounts; never guess wildly. "Just a
   little" is small. When the user gives numbers, use them exactly.
3. Resolve relative instructions against sessionState per the memory rules.
4. Decompose compound instructions into ordered ops ("zoom in a bit and warm
   it up" = crop op + adjust op).
5. Scenario requests ("put me in/at/on X") produce the 4-step scenario plan
   with a fully-written scene_spec: accurate place, correct viewpoint for the
   requested vantage, explicit pose/gaze, lighting from the user's aesthetic.
6. Ask a clarifying question ONLY when execution would differ materially
   between readings; offer 2–4 options; never more than one question.
7. Output JSON only, schema: { "plan": [ { "op": ..., "params": {...},
   "engine": ..., "say": one-short-line } ], "clarify"?: {...} }.
   "say" lines are user-facing and confident ("Tightening the frame ~10%").

OPERATION TYPES and their engine (use these exact op names and engines):
- "crop"     engine "client"      — zoom-in, tighten, reframe, aspect change. NEVER generative.
                                     params: { retain: 0..1 (fraction of frame kept), aspect?: "4:5"|"1:1"|"9:16"|"16:9"|null, center: "subject"|"center" }
- "rotate"   engine "client"      — params: { degrees: number (negative = counter-clockwise) }
- "adjust"   engine "client"      — global sliders. params is a map of any of:
                                     brightness, contrast, saturation, warmth, vibrance, sharpness, shadows, highlights, structure (each -100..100)
- "local_adjust" engine "client"  — a masked region. params: { target: "sky"|"subject"|"background"|"face"|"bright"|"dark", adjust: { ...sliders } } ("bright" = the brightest areas e.g. highlights/windows/sky glare, "dark" = the darkest areas e.g. shadows — use these for "tone down the highlights over there" / "lift just the shadows" style asks that name a REGION, not a global slider)
- "expand"   engine "generative"  — zoom-out / uncrop / show more. params: { grow: 0..1 (canvas growth fraction) }
- "generative_edit" engine "generative" — remove/add/replace/restyle content. params: { instruction: precise single-change instruction }
- "style"    engine "client"      — named vibe / grade. params: { grade: "after-dark"|"euro-summer"|... , amount?: 0..1 } or { instruction } if it needs the model
- "scenario" engine "scenario"    — put the USER into a new scene. params: { scene_spec: string, pose: string, camera: string, place: string, matchAesthetic: true }

QUANTIFIER TABLE (map vague amounts to a magnitude 0..1, then scale the relevant range):
- "a tiny bit" / "just a little" / "slightly" / "a touch" / "barely" -> 0.05–0.10
- "a bit" / "somewhat" / "a little more" (no prior op) -> 0.15–0.25
- "more" / "noticeably" / "make it pop" -> 0.30–0.40
- "a lot" / "way more" / "much" / "really" -> 0.45–0.60
- "max" / "as much as possible" / "completely" -> 0.85–1.00
- Absolute values ("crop to 4:5", "rotate 90", "50% darker") -> use verbatim.
ZOOM MAPPING: zoom-in "just a little" = crop retain 0.88–0.92; unqualified "zoom in" = 0.75–0.80;
"zoom way in on my face" = subject-tight crop retain ~0.45 with center "subject".
Zoom-out "a little" = expand grow 0.15; unqualified = 0.30; "show the whole room" = 0.60–0.80.

SESSION MEMORY (sessionState.ops = last 5 ops with params, newest last):
- "a little more" / "again" -> repeat the LAST op at 50% of its previous magnitude.
- "less" / "too much" / "dial it back" / "go back a bit" -> invert/reduce the last op:
  for client ops, apply ~40% of the last delta in the opposite direction; for generative,
  re-run from the pre-op version at reduced magnitude.
- "undo that but keep the <x>" -> revert last op, re-apply the named sub-adjustment.
- Pronouns ("make IT bluer") resolve to the last-referenced target/mask.

SCENARIO scene_spec must resolve: PLACE (name the real landmark and the CORRECT viewpoint for the
requested vantage — e.g. "the open-air observation deck near the top of the Burj Khalifa, extreme
aerial perspective, Sheikh Zayed Road and the fountain lake ~800m below, downtown grid receding into
haze"), CAMERA (angle implied by the words — "staring down" = high angle from behind/over the shoulder
emphasizing the drop), TIME/LIGHT (default to the user's dominant aesthetic), and POSE/GAZE as an
EXPLICIT instruction ("staring down" = head tilted downward, gaze at the drop, contemplative stance).

SAFETY:
- Refuse (op "clarify" with a friendly one-line "say", no plan) any request to place a REAL person
  other than the user in the photo.
- For dangerous/self-harm placements on real landmarks (hanging off a spire, beyond a safety barrier,
  standing on the edge/ledge), DO NOT depict the danger — substitute the safe real vantage (the actual
  observation deck / viewing platform) and note it in "say". Never refuse the whole request; give the safe version.
- Keep it about editing the user's own photo.

Output ONLY the JSON object.`;

function parseModelJson(text: string): unknown {
  const cleaned = text.replace(/^```(?:json)?/m, "").replace(/```\s*$/m, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON in model output");
  return JSON.parse(cleaned.slice(start, end + 1));
}

// Harden the model plan into the exact contract the client executes.
function sanitizePlan(raw: unknown): Record<string, unknown> {
  const value = (raw ?? {}) as Record<string, unknown>;
  const rawPlan = Array.isArray(value.plan) ? value.plan : [];
  const plan = rawPlan
    .filter((step) => step && VALID_OPS.has((step as Record<string, unknown>).op as string))
    .slice(0, 6)
    .map((step) => {
      const s = step as Record<string, unknown>;
      const op = s.op as string;
      const engine = GENERATIVE_OPS.has(op)
        ? op === "scenario" ? "scenario" : "generative"
        : "client";
      return {
        op,
        engine,
        params: typeof s.params === "object" && s.params ? s.params : {},
        say: typeof s.say === "string" ? s.say.slice(0, 120) : "",
      };
    });
  let clarify: Record<string, unknown> | null = null;
  const rawClarify = value.clarify as Record<string, unknown> | null;
  if (rawClarify && (typeof rawClarify.question === "string" || typeof rawClarify.say === "string")) {
    const options = Array.isArray(rawClarify.options)
      ? rawClarify.options
          .filter((o) => o && (typeof o === "string" || typeof (o as Record<string, unknown>).label === "string"))
          .slice(0, 4)
          .map((o) =>
            typeof o === "string"
              ? { label: o.slice(0, 40), value: o.slice(0, 120) }
              : {
                  label: String((o as Record<string, unknown>).label).slice(0, 40),
                  value: String((o as Record<string, unknown>).value ?? (o as Record<string, unknown>).label).slice(0, 120),
                },
          )
      : [];
    clarify = {
      question: String(rawClarify.question ?? rawClarify.say ?? "Which did you mean?").slice(0, 160),
      options,
    };
  }
  return { plan, clarify, model: MODEL };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (request.method !== "POST") return json(405, { error: "POST only" });
  if (!Deno.env.get("ANTHROPIC_API_KEY")) return json(503, { error: "ANTHROPIC_API_KEY is not configured" });

  const userId = userIdFromAuth(request.headers.get("authorization"));
  if (!userId) return json(401, { error: "sign in required" });

  let body: {
    instruction?: string;
    sessionState?: { ops?: Array<Record<string, unknown>>; lastTarget?: string };
    photoMeta?: Record<string, unknown>;
  };
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid JSON body" });
  }
  const instruction = String(body.instruction ?? "").trim();
  if (!instruction) return json(400, { error: "instruction required" });
  if (instruction.length > 600) return json(400, { error: "instruction too long" });

  // Hard refusal only for a real OTHER person; dangerous-placement is softened
  // by the prompt into a safe substitution, so it flows through to the model.
  if (REFUSE_REAL_PERSON.test(instruction)) {
    return json(200, {
      plan: [],
      clarify: {
        question: "I can only put YOU in a scene — not other real people. Want me to place you there instead?",
        options: [{ label: "Yes, put me there", value: "put me there" }],
      },
      refused: true,
      model: MODEL,
    });
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    // ---- Light cap (fails open).
    try {
      const { data: profile } = await supabase.from("profiles").select("plan").eq("id", userId).maybeSingle();
      if ((profile?.plan ?? "free") === "free") {
        const monthStart = new Date();
        monthStart.setUTCDate(1);
        monthStart.setUTCHours(0, 0, 0, 0);
        const { count } = await supabase
          .from("taste_events")
          .select("id", { count: "exact", head: true })
          .eq("profile_id", userId)
          .eq("event_type", "edit_interpret")
          .gte("created_at", monthStart.toISOString());
        if ((count ?? 0) >= FREE_INTERPRETS_PER_MONTH) {
          return json(402, { error: "interpret_cap_reached", paywall: true, cap: FREE_INTERPRETS_PER_MONTH });
        }
      }
    } catch (error) {
      console.error("interpret cap check failed (allowing)", error);
    }

    const userMessage =
      `INSTRUCTION: ${instruction}\n\n` +
      `SESSION STATE (last ops, newest last): ${JSON.stringify(body.sessionState?.ops ?? [])}\n` +
      `LAST TARGET: ${body.sessionState?.lastTarget ?? "none"}\n` +
      `PHOTO META: ${JSON.stringify(body.photoMeta ?? {})}`;

    const anthropic = new Anthropic();
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 900,
      temperature: 0.2,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    try {
      await supabase.from("taste_events").insert({
        profile_id: userId,
        event_type: "edit_interpret",
        subject: { model: MODEL },
      });
    } catch (error) {
      console.error("interpret meter insert failed", error);
    }

    if (response.stop_reason === "refusal") {
      return json(200, { plan: [], clarify: { question: "Let's keep it to editing your own photo — what would you like to change?", options: [] }, model: MODEL });
    }
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => (block as { text: string }).text)
      .join("");
    let parsed: unknown;
    try {
      parsed = parseModelJson(text);
    } catch {
      // Fallback: treat as a single generative edit so the ask still runs.
      return json(200, {
        plan: [{ op: "generative_edit", engine: "generative", params: { instruction }, say: "Applying your edit…" }],
        clarify: null,
        model: MODEL,
      });
    }
    return json(200, sanitizePlan(parsed));
  } catch (error) {
    console.error("interpret-edit failed", error);
    return json(502, { error: String((error as Error).message ?? error) });
  }
});
