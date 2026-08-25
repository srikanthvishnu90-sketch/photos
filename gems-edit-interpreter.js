// gems-edit-interpreter.js — the Edit Interpreter (v2) client boundary.
//
// interpretEdit() turns a human instruction into a PLAN of typed ops. It resolves
// the clearly-deterministic cases LOCALLY (crop / rotate / slider adjusts / simple
// session follow-ups) so they NEVER touch a generative model — instant, free, and
// exactly what was asked. Only the genuinely-generative asks (scenario placement,
// expand/uncrop, content edits, ambiguous phrasing) fall through to the
// interpret-edit edge function, and if that's unreachable we degrade to a single
// generative_edit so the ask still runs. Never throws.
import { getSession } from "./gems-supabase.js";

const SUPABASE_URL = "https://hkwkxacvcgorhthwyslx.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_Z8Fw1dZYiqOGUDITzU929A_i2k9wANc";
const FN_URL = `${SUPABASE_URL}/functions/v1/interpret-edit`;

// ---- Quantifier calibration (the nuance vocabulary). Returns a magnitude 0..1.
// Order matters: check the most specific/strongest phrases first.
const QUANTIFIERS = [
  { re: /\b(max(imum)?|as much as possible|completely|all the way|totally)\b/i, mag: 0.9 },
  { re: /\b(way more|way|a lot|much|really|super|extremely|tons?)\b/i, mag: 0.5 },
  { re: /\b(tiny bit|just a little|slightly|a touch|barely|a hair|a smidge)\b/i, mag: 0.08 },
  { re: /\b(noticeably|make it pop|more)\b/i, mag: 0.35 },
  { re: /\b(a bit|somewhat|a little|kinda|kind of)\b/i, mag: 0.2 },
];
const DEFAULT_MAG = 0.3;

/** Magnitude 0..1 for a vague amount phrase; DEFAULT_MAG when nothing matches. */
export function magnitudeFor(text) {
  const t = String(text || "");
  for (const q of QUANTIFIERS) if (q.re.test(t)) return q.mag;
  return DEFAULT_MAG;
}

/** Fraction of the frame a "zoom in" keeps (smaller = tighter). */
export function zoomInRetain(text) {
  const t = String(text || "").toLowerCase();
  if (/\b(way in|all the way|really (close|tight)|on my face|face)\b/.test(t)) return 0.5;
  const mag = magnitudeFor(t);
  if (mag <= 0.1) return 0.9; // "just a little" → keep ~90%
  if (mag <= 0.25) return 0.8; // "a bit" → keep ~80%
  return 0.77; // unqualified / "more"
}

/** Canvas growth fraction for a "zoom out" / uncrop. */
export function zoomOutGrow(text) {
  const t = String(text || "").toLowerCase();
  if (/\b(whole room|everything|all of it|way out|show more of)\b/.test(t)) return 0.7;
  const mag = magnitudeFor(t);
  if (mag <= 0.1) return 0.15;
  if (mag <= 0.25) return 0.2;
  return 0.3;
}

// ---- Adjust vocabulary → which slider(s) move, and the sign.
// Each entry: match, then a builder(magnitude) -> partial adjust map (-100..100).
const ADJUST_RULES = [
  { re: /\bbright(er|en)?\b|lighter|brighten it/i, build: (m) => ({ brightness: Math.round(m * 100) }) },
  { re: /\bdark(er|en)?\b|dim(mer)?\b/i, build: (m) => ({ brightness: -Math.round(m * 100) }) },
  { re: /\bmore contrast|punch(ier)?|contrast(y|ier)?\b/i, build: (m) => ({ contrast: Math.round(m * 100) }) },
  { re: /\bless contrast|flat(ter)?\b|fade(d)?\b/i, build: (m) => ({ contrast: -Math.round(m * 100) }) },
  { re: /\bwarm(er|th)?\b|cozy|golden/i, build: (m) => ({ warmth: Math.round(m * 100) }) },
  { re: /\bcool(er)?\b|colder|bluer overall/i, build: (m) => ({ warmth: -Math.round(m * 100) }) },
  { re: /\bvibran\w+|more colou?rful|punchy colou?r/i, build: (m) => ({ vibrance: Math.round(m * 100) }) },
  { re: /\bsaturat\w+\b/i, build: (m) => ({ saturation: Math.round(m * 100) }) },
  { re: /\bdesaturat\w+|less colou?r|muted?\b/i, build: (m) => ({ saturation: -Math.round(m * 100) }) },
  { re: /\bsharp(er|en)?\b|crisp(er)?\b/i, build: (m) => ({ sharpness: Math.round(m * 100) }) },
  { re: /\b(soft(er)?|less sharp)\b/i, build: (m) => ({ sharpness: -Math.round(m * 100) }) },
  { re: /\blift shadows|open (up )?the shadows|brighter shadows\b/i, build: (m) => ({ shadows: Math.round(m * 100) }) },
  { re: /\brecover highlights|tame highlights|less blown\b/i, build: (m) => ({ highlights: -Math.round(m * 100) }) },
];
// "black and white" / "b&w" → a full desaturate (a grade would also work).
const BW_RE = /\b(black\s*(and|&)?\s*white|b&w|grayscale|greyscale|monochrome)\b/i;
// "make it pop" → contrast + vibrance together.
const POP_RE = /\bmake it pop\b/i;

function absoluteRotate(text) {
  const m = String(text).match(/\brotate\b[^0-9-]*(-?\d{1,3})\s*(?:deg\w*|°)?\s*(left|right|ccw|cw|clockwise|counter)?/i);
  if (!m) return null;
  let deg = Number(m[1]);
  const dir = (m[2] || "").toLowerCase();
  if (/left|ccw|counter/.test(dir)) deg = -Math.abs(deg);
  else if (/right|cw|clockwise/.test(dir)) deg = Math.abs(deg);
  return deg;
}
function absoluteAspect(text) {
  const m = String(text).match(/\b(?:crop|reframe|make it|aspect)\b[^0-9]*(\d{1,2})\s*[:x]\s*(\d{1,2})\b/i);
  if (m) return `${m[1]}:${m[2]}`;
  if (/\bsquare\b/i.test(text)) return "1:1";
  if (/\bportrait\b/i.test(text)) return "4:5";
  if (/\bstory\b/i.test(text)) return "9:16";
  return null;
}
function absolutePercent(text) {
  const m = String(text).match(/(\d{1,3})\s*%/);
  return m ? Math.min(100, Number(m[1])) : null;
}

const ZOOM_IN_RE = /\b(zoom in|tighten|crop in|closer|zoom into|punch in)\b/i;
const ZOOM_OUT_RE = /\b(zoom out|pull back|wider|show more|uncrop|expand out|back up)\b/i;
const CROP_RE = /\b(crop|reframe|aspect)\b/i;
const ROTATE_RE = /\brotate|straighten|tilt\b/i;
const SCENARIO_RE = /\b(put|place|make) me (in|at|on|inside|standing|sitting|at the top of|next to|in front of)\b|\bme (in|at) the\b/i;
const RELATIVE_MORE_RE = /^\s*(a little more|a bit more|more|again|even more)\s*$/i;
const RELATIVE_LESS_RE = /\b(less|too much|dial it back|go back a bit|not so much|tone it down|back a bit)\b/i;
const SKY_RE = /\bsky\b/i;
const FACE_TARGET_RE = /\b(face|her face|his face|my face|their face)\b/i;

// Does this instruction clearly name a global adjust? Returns a merged adjust map or null.
function buildAdjust(text) {
  if (POP_RE.test(text)) {
    const m = magnitudeFor(text) || 0.35;
    return { contrast: Math.round(m * 100), vibrance: Math.round(m * 100) };
  }
  if (BW_RE.test(text)) return { saturation: -100 };
  let adjust = null;
  const mag = magnitudeFor(text);
  const pct = absolutePercent(text);
  const usedMag = pct != null ? pct / 100 : mag;
  for (const rule of ADJUST_RULES) {
    if (rule.re.test(text)) adjust = { ...(adjust || {}), ...rule.build(usedMag) };
  }
  return adjust;
}

/**
 * Resolve locally when the instruction is clearly deterministic. Returns a plan
 * object { plan:[...], source:"local" } or null to defer to the model.
 * sessionState = { ops:[{op,params,...} newest last], lastTarget }.
 */
export function localInterpret(instruction, sessionState = {}) {
  const text = String(instruction || "").trim();
  if (!text) return null;
  const ops = Array.isArray(sessionState.ops) ? sessionState.ops : [];
  const last = ops[ops.length - 1] || null;

  // Scenario / content edits / anything with an explicit person placement → model.
  if (SCENARIO_RE.test(text)) return null;

  // ---- Relative follow-ups (session memory).
  if (RELATIVE_MORE_RE.test(text) && last) {
    if (last.op === "crop") {
      const prevRetain = Number(last.params?.retain ?? 0.85);
      const retain = Math.max(0.3, 1 - 0.5 * (1 - prevRetain)); // ~half the previous reduction again
      return plan([{ op: "crop", engine: "client", params: { retain, center: last.params?.center ?? "subject" }, say: `Tightening a little more` }]);
    }
    if (last.op === "adjust") {
      const half = scaleAdjust(last.params, 0.5);
      return plan([{ op: "adjust", engine: "client", params: half, say: `A bit more` }]);
    }
    if (last.op === "expand") {
      const grow = Number(last.params?.grow ?? 0.3) * 0.5;
      return plan([{ op: "expand", engine: "generative", params: { grow }, say: `Pulling back a little more` }]);
    }
  }
  if (RELATIVE_LESS_RE.test(text) && last) {
    // Dial back the last op: revert it, then re-apply at reduced magnitude.
    if (last.op === "adjust") {
      const inv = scaleAdjust(last.params, -0.4); // apply 40% in the opposite direction
      return plan([{ op: "adjust", engine: "client", params: inv, say: `Dialing that back` }]);
    }
    // For crop/expand/generative: undo then a gentler re-apply.
    if (last.op === "crop") {
      const prevRetain = Number(last.params?.retain ?? 0.85);
      const retain = Math.min(0.98, prevRetain + 0.4 * (1 - prevRetain));
      return plan([{ op: "undo", engine: "client", params: {}, say: `Backing off` }, { op: "crop", engine: "client", params: { retain, center: last.params?.center ?? "subject" }, say: `A gentler crop` }]);
    }
    if (last.op === "expand") {
      const grow = Number(last.params?.grow ?? 0.3) * 0.5;
      return plan([{ op: "undo", engine: "client", params: {}, say: `Backing off` }, { op: "expand", engine: "generative", params: { grow }, say: `Less zoom-out` }]);
    }
    return plan([{ op: "undo", engine: "client", params: {}, say: `Undoing the last change` }]);
  }

  // ---- Compound / single deterministic ops.
  const steps = [];

  // Rotate (absolute).
  if (ROTATE_RE.test(text)) {
    const deg = absoluteRotate(text);
    if (deg != null) steps.push({ op: "rotate", engine: "client", params: { degrees: deg }, say: `Rotating ${deg}°` });
    else if (/straighten/i.test(text)) steps.push({ op: "rotate", engine: "client", params: { degrees: 0, straighten: true }, say: `Straightening` });
  }

  // Crop: explicit aspect, or zoom-in.
  const aspect = absoluteAspect(text);
  if (ZOOM_IN_RE.test(text)) {
    steps.push({ op: "crop", engine: "client", params: { retain: zoomInRetain(text), aspect, center: "subject" }, say: `Tightening the frame` });
  } else if (aspect && CROP_RE.test(text)) {
    steps.push({ op: "crop", engine: "client", params: { retain: 1, aspect, center: "subject" }, say: `Cropping to ${aspect}` });
  }

  // Zoom-out → generative expand.
  if (ZOOM_OUT_RE.test(text)) {
    steps.push({ op: "expand", engine: "generative", params: { grow: zoomOutGrow(text) }, say: `Showing more of the scene` });
  }

  // Local adjust on the sky ("make the sky bluer", "brighten the sky").
  if (SKY_RE.test(text) && !ZOOM_IN_RE.test(text)) {
    const adj = buildAdjust(text) || (/blue/i.test(text) ? { saturation: Math.round(magnitudeFor(text) * 100) } : null);
    if (adj) steps.push({ op: "local_adjust", engine: "client", params: { target: "sky", adjust: adj }, say: `Bluing the sky` });
  } else if (FACE_TARGET_RE.test(text) && /(bright|light|even|glow)/i.test(text) && !SCENARIO_RE.test(text)) {
    const adj = buildAdjust(text) || { brightness: Math.round(magnitudeFor(text) * 100) };
    steps.push({ op: "local_adjust", engine: "client", params: { target: "face", adjust: adj }, say: `Brightening the face` });
  } else {
    // Global adjust (only if we didn't already make it a crop-only or sky op).
    const adj = buildAdjust(text);
    if (adj) steps.push({ op: "adjust", engine: "client", params: adj, say: adjustSay(adj) });
  }

  if (!steps.length) return null; // nothing clearly deterministic → defer to model
  // If ANY step is generative-only content we didn't recognize, we'd have deferred;
  // here every step is a recognized deterministic-or-expand op.
  return plan(steps);
}

function plan(steps) {
  return { plan: steps, source: "local" };
}

// Scale an adjust map by a factor (for session "more"/"less"), clamped -100..100.
function scaleAdjust(params, factor) {
  const out = {};
  for (const [k, v] of Object.entries(params || {})) {
    if (typeof v === "number") out[k] = Math.max(-100, Math.min(100, Math.round(v * factor)));
  }
  return out;
}

function adjustSay(adj) {
  const keys = Object.keys(adj);
  if (keys.length === 1) {
    const k = keys[0];
    const dir = adj[k] >= 0 ? "+" : "";
    return `${k[0].toUpperCase()}${k.slice(1)} ${dir}${adj[k]}`;
  }
  return "Adjusting";
}

/**
 * The full interpreter: local-first, then the edge function, then a generative
 * fallback. opts = { instruction, sessionState, photoMeta }. Never throws.
 * Returns { plan:[...], source:"local"|"model"|"fallback", clarify?, refused? }.
 */
export async function interpretEdit(opts) {
  const instruction = String(opts?.instruction ?? "").trim();
  if (!instruction) return { plan: [], source: "local" };

  const local = localInterpret(instruction, opts?.sessionState);
  if (local) return local;

  try {
    const session = await getSession();
    if (!session) return fallback(instruction, "signin");
    const res = await fetch(FN_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: SUPABASE_PUBLISHABLE_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        instruction,
        sessionState: opts?.sessionState ?? {},
        photoMeta: opts?.photoMeta ?? {},
      }),
    });
    if (res.status === 402) return { plan: [], source: "model", paywall: true };
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) return fallback(instruction, "error");
    if (Array.isArray(data.plan) || data.clarify) {
      return { plan: data.plan ?? [], clarify: data.clarify ?? null, refused: !!data.refused, source: "model" };
    }
    return fallback(instruction, "empty");
  } catch (error) {
    console.info("interpretEdit fell back", error);
    return fallback(instruction, "offline");
  }
}

// When the model is unreachable, still run the ask as one generative edit.
function fallback(instruction, reason) {
  return {
    plan: [{ op: "generative_edit", engine: "generative", params: { instruction }, say: "Applying your edit…" }],
    source: "fallback",
    reason,
  };
}

// ---- Session state helpers (the client persists this per photo).
export function pushSessionOp(sessionState, op) {
  const state = sessionState && typeof sessionState === "object" ? { ...sessionState } : {};
  const ops = Array.isArray(state.ops) ? state.ops.slice() : [];
  ops.push(op);
  state.ops = ops.slice(-5); // keep last 5
  if (op?.params?.target) state.lastTarget = op.params.target;
  return state;
}

/**
 * Compute the pixel crop rect for a crop op. Pure. retain = fraction of frame
 * kept; aspect optionally re-shapes; center "subject" uses the saliency box if
 * provided (photoMeta.derived.saliency = {x,y,w,h} in 0..1), else the image center.
 */
export function cropRectFor(params, width, height, saliency = null) {
  const W = Math.max(1, width | 0);
  const H = Math.max(1, height | 0);
  const retain = clamp(Number(params?.retain ?? 1), 0.2, 1);
  let cw = Math.round(W * retain);
  let ch = Math.round(H * retain);
  // Re-shape to an explicit aspect (fit within the retained box).
  const aspect = parseAspect(params?.aspect);
  if (aspect) {
    if (cw / ch > aspect) cw = Math.round(ch * aspect);
    else ch = Math.round(cw / aspect);
  }
  cw = Math.min(cw, W);
  ch = Math.min(ch, H);
  // Center on the subject saliency box centroid when asked and available.
  let cx = W / 2;
  let cy = H / 2;
  if ((params?.center ?? "subject") === "subject" && saliency && typeof saliency.x === "number") {
    cx = (saliency.x + (saliency.w ?? 0) / 2) * W;
    cy = (saliency.y + (saliency.h ?? 0) / 2) * H;
  }
  let x = Math.round(cx - cw / 2);
  let y = Math.round(cy - ch / 2);
  x = clamp(x, 0, W - cw);
  y = clamp(y, 0, H - ch);
  return { x, y, w: cw, h: ch };
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
function parseAspect(a) {
  if (!a) return null;
  const m = String(a).match(/^(\d{1,2})\s*[:x]\s*(\d{1,2})$/);
  if (!m) return null;
  const r = Number(m[1]) / Number(m[2]);
  return Number.isFinite(r) && r > 0 ? r : null;
}
