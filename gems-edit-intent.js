// Describe-it intent router. The editing science (correct vs. grade; tonal
// operations vs. content operations) says darker/lighter/contrast/warmth/
// saturation are DETERMINISTIC tonal math — they run instantly on-device, for
// free, and always do exactly what's asked. Only genuine CONTENT edits (remove,
// add, replace, background, expand) need the generative model.
//
// parseEditIntent(instruction) → one of:
//   { kind: "adjust",    adjust: {...}, summary }   // client-side, instant
//   { kind: "grade",     grade: {...},  summary }   // client-side, instant
//   { kind: "ai",        summary }                  // send to edit-photo model
import { FILTER_GRADES } from "./gems-canvas.js";

// applyAdjust values are deltas in roughly -100..100 (0 = no change). These are
// the "medium" steps; intensity words scale them.
const STEP = Object.freeze({ small: 0.5, medium: 1, large: 1.9 });

function intensity(text) {
  if (/\b(a little|slightly|a bit|a touch|subtle|barely|somewhat|kinda)\b/.test(text)) return STEP.small;
  if (/\b(much|a lot|way|really|very|super|way too|far|drastically|heavily|a ton)\b/.test(text)) return STEP.large;
  return STEP.medium;
}

// Content edits that genuinely need the generative model.
const CONTENT_RE =
  /\b(remove|erase|delete|get rid of|take out|add|insert|put|place|replace|swap|change the background|background|backdrop|expand|extend|uncrop|outpaint|cut out|cutout|generate|turn (?:me|it|this) into|make (?:me|him|her) (?:a|an)|wearing|clothes|outfit|hair(?:cut|style)?|sky|clouds|person|people|object|text|caption|logo)\b/;

// Named aesthetic grades ("make it dark gym", "golden hour", …).
function matchGrade(text) {
  return FILTER_GRADES.find((grade) => {
    const label = grade.label.toLowerCase();
    return text.includes(label) || (grade.key && text.includes(grade.key.toLowerCase()));
  });
}

export function parseEditIntent(instruction) {
  const text = String(instruction || "").toLowerCase().trim();
  if (!text) return { kind: "ai", summary: instruction };

  // A named grade wins (it's the most specific tonal ask).
  const grade = matchGrade(text);
  if (grade) return { kind: "grade", grade, summary: grade.label };

  // Content edit → generative model.
  if (CONTENT_RE.test(text)) return { kind: "ai", summary: instruction };

  const k = intensity(text);
  const adjust = {};
  let label = "";

  // Brightness / exposure — the "darker / lighter" the founder called out.
  if (/\b(darker|darken|dark|dimmer|dim|underexpose|less bright|shadow(?:ier|y)?|moodier)\b/.test(text)) {
    adjust.brightness = -28 * k;
    label = "Darker";
  } else if (/\b(lighter|lighten|brighter|brighten|bright|overexpose|more (?:light|exposure)|expose more)\b/.test(text)) {
    adjust.brightness = 28 * k;
    label = "Lighter";
  }

  // Contrast.
  if (/\b(more contrast|contrasty|punchy|punchier|more punch|deeper|crisp(?:er)?)\b/.test(text)) {
    adjust.contrast = (adjust.contrast || 0) + 26 * k;
    label = label || "More contrast";
  } else if (/\b(less contrast|flatter|flat|softer|soft|matte look|low contrast|muted contrast)\b/.test(text)) {
    adjust.contrast = (adjust.contrast || 0) - 22 * k;
    label = label || "Softer";
  }

  // Warmth / temperature.
  if (/\b(warmer|warm(?: it up)?|golden|cozy|amber|sunset|toasty)\b/.test(text)) {
    adjust.warmth = (adjust.warmth || 0) + 30 * k;
    label = label || "Warmer";
  } else if (/\b(cooler|cool(?: it down)?|colder|bluer|icy|teal)\b/.test(text)) {
    adjust.warmth = (adjust.warmth || 0) - 30 * k;
    label = label || "Cooler";
  }

  // Saturation / color.
  if (/\b(black and white|black-and-white|b&w|b and w|\bbw\b|monochrome|grayscale|greyscale|no colou?r)\b/.test(text)) {
    adjust.saturation = -100;
    label = "Black & white";
  } else if (/\b(more (?:saturat|colou?r|vibran)|vibrant|colou?rful|pop|punch(?:ier)? colou?r|richer|saturate)\b/.test(text)) {
    adjust.saturation = (adjust.saturation || 0) + 30 * k;
    label = label || "More vibrant";
  } else if (/\b(less (?:saturat\w*|colou?r)|desaturat\w*|muted|mute|washed|faded colou?r|dull(?:er)?)\b/.test(text)) {
    adjust.saturation = (adjust.saturation || 0) - 30 * k;
    label = label || "Muted";
  }

  // Faded / matte / film look → the Film grade (lifted blacks) if we have it.
  if (!label && /\b(fade|faded|matte|film(?: ?look)?|vintage|retro|nostalg)/.test(text)) {
    const film = FILTER_GRADES.find((g) => g.key === "film" || g.label.toLowerCase() === "film");
    if (film) return { kind: "grade", grade: film, summary: "Film" };
  }

  if (Object.keys(adjust).length) return { kind: "adjust", adjust, summary: label };

  // Nothing tonal matched — treat as a content edit for the model.
  return { kind: "ai", summary: instruction };
}
