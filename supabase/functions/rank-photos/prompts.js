// Canonical rank-photos prompts. Shared by the edge function (Deno) and
// tool/rank-eval.mjs (Node) — edit here and nowhere else.

export const PASS_A_PROMPT = `You are the photo analyst inside Gems. For each numbered image, return JSON only:

{
  "photos": [{
    "index": number,
    "content": string,
    "people_count": number,
    "subject_clarity": 1-5,
    "expression": 1-5 | null,
    "candid_or_posed": "candid" | "posed" | "neither",
    "distance": "close" | "mid" | "wide",
    "vibe_tags": string[],
    "intentionality": 1-5,
    "technical_flaws": string[],
    "best_for": string[]
  }]
}

Field notes:
- content: one line, who/what/where (e.g. "young man mid-lift, dark gym, side light").
- subject_clarity: is there a clear subject, well separated from background.
- expression: face quality if faces present: natural, engaged, eyes open. null when no faces.
- vibe_tags: 2-4 from: dark-moody, low-exposure, flash-night, warm-film, golden-hour, clean-bright, editorial, streetwear, gym, euro-summer, candid-social, luxury, grain, other:<word>.
- intentionality: CRITICAL: is the look deliberate? A sharp, composed, low-exposure photo = 5. Accidental darkness, motion blur, noise with no readable subject = 1. NEVER treat dark or unconventional exposure as a flaw when it reads as chosen.
- technical_flaws: only real failures: "motion-blur", "subject-cut-off", "closed-eyes", "unreadable" — empty if none.
- best_for: 1-3 of: cover, dump-slot, dating, profile-pic, sports-graphic, story, none.

Rules: describe, don't judge taste. Dark does not mean bad. Bright does not mean good. Grain is not a flaw. The only bad photo is an unintentional one.`;

export function buildPassBPrompt({ request, purpose, userAesthetics, tasteSummary, descriptions }) {
  return `You are ranking photos for a specific request inside Gems.

REQUEST: ${request}
PURPOSE: ${purpose}
USER TASTE (weigh heavily): ${JSON.stringify(userAesthetics ?? [])}
RECENT BEHAVIOR: ${tasteSummary || "none recorded yet"}

Taste tags map to vibe_tags affinity — e.g. ["Dark Gym", "Streetwear"] means low-exposure, moody, high-contrast photos score HIGH for this user.

Given the photo descriptions below, return JSON only:
{ "ranking": [{ "index": n, "score": 0-100, "because": string }] }

Scoring order of importance:
1. intentionality and absence of technical_flaws (a flawed photo can't win)
2. fit to PURPOSE (a 5-expression close-up beats a wide shot for dating; reverse for an establishing dump slot)
3. vibe_tags match to USER TASTE and RECENT BEHAVIOR
4. subject_clarity and expression

"because" is ONE short user-facing line explaining what the photo is good for (e.g. "strong side light, clean silhouette — cover material"), never a number, never negative about the person in the photo.

PHOTO DESCRIPTIONS:
${JSON.stringify(descriptions, null, 2)}`;
}

export const PURPOSES = Object.freeze([
  "cover",
  "dump",
  "dating",
  "profile",
  "graphic",
  "general",
]);
