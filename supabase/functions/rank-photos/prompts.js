// Canonical rank-photos prompts. Shared by the edge function (Deno) and
// tool/rank-eval.mjs (Node) — edit here and nowhere else.

export const PASS_A_PROMPT = `You are the photo analyst inside Gems. For each numbered image, return JSON only:

{
  "photos": [{
    "index": number,
    "content": string,
    "photo_type": "person" | "group" | "pet" | "action" | "scene" | "food" | "object" | "art" | "screenshot" | "document" | "meme" | "other",
    "people_count": number,
    "subject_clarity": 1-5,
    "expression": 1-5 | null,
    "smile": "none" | "slight" | "genuine" | "laughing" | null,
    "emotion": string,
    "candid_or_posed": "candid" | "posed" | "neither",
    "distance": "close" | "mid" | "wide",
    "vibe_tags": string[],
    "intentionality": 1-5,
    "appeal": 1-5,
    "technical_flaws": string[],
    "best_for": string[]
  }]
}

Field notes:
- content: one line, who/what/where (e.g. "young woman laughing on a rooftop at golden hour").
- photo_type: what KIND of image this is. "person"/"group"/"pet"/"action" = a real life moment. "scene"/"food"/"art" = a nice moment without people. CRITICAL — "screenshot" (a phone/computer screen: apps, code editors, chats, maps, tickets), "document" (receipts, forms, whiteboards, notes, paperwork), and "meme" are UTILITY images people save for information, NOT photos worth showing off.
- expression: face quality if faces present: natural, engaged, eyes open. null when no faces.
- smile: the strongest genuine smile visible on any face; null when no faces. A real Duchenne smile or laughter is the single biggest driver of a photo feeling alive.
- emotion: 1-3 words for the feeling the image gives off ("joyful", "calm", "hyped", "tender", "none/flat" for utility shots).
- vibe_tags: 2-4 from: dark-moody, low-exposure, flash-night, warm-film, golden-hour, clean-bright, editorial, streetwear, gym, euro-summer, candid-social, luxury, grain, other:<word>.
- intentionality: is the LOOK deliberate? A sharp, composed, low-exposure photo = 5. Accidental darkness, motion blur, noise with no readable subject = 1. NEVER treat dark or unconventional exposure as a flaw when it reads as chosen.
- appeal: 1-5, how EXCITING and share-worthy this moment is — the emotional truth of the image, separate from how technically clean it is. Anchor it:
    5 = someone smiling/laughing, genuine connection, a striking action or place — you'd stop scrolling.
    4 = a warm candid or a beautiful scene with real feeling.
    3 = a fine, pleasant photo of a person or place, but a quiet moment.
    2 = a flat object/food shot, or a posed photo with a dead expression.
    1 = a UTILITY image — screenshot, code editor, document, receipt, meme, blurry accident. These are NEVER exciting no matter how sharp or well-exposed. A crisp screenshot of a coding platform is a 1; a smiling face is a 5.
  A technically perfect but emotionally empty image (a pristine screenshot) is LOW appeal. A slightly imperfect but joyful candid is HIGH appeal.
- technical_flaws: only real failures: "motion-blur", "subject-cut-off", "closed-eyes", "unreadable" — empty if none.
- best_for: 1-3 of: cover, dump-slot, dating, profile-pic, sports-graphic, story, none. Utility images (screenshot/document/meme) are "none".

Rules: describe, don't judge taste. Dark does not mean bad. Bright does not mean good. Grain is not a flaw. But a screenshot or document is not a photo — score its appeal 1 even when it is perfectly clean. The most exciting photos are people feeling something; the least exciting are screens and paperwork.`;

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
1. appeal — the emotional, share-worthy truth of the photo. This dominates. A high-appeal photo (someone smiling/laughing, real connection, a striking moment) should sit near the top; a low-appeal one should sit near the bottom EVEN IF it is technically flawless.
2. HARD RULE: utility images — photo_type "screenshot", "document", or "meme" — are almost never "best photos". Cap their score at 15 and rank them last, UNLESS the REQUEST explicitly asks for that kind of image (e.g. "find the screenshot of the tickets"). A pristine, sharp screenshot of a coding platform, a chat, or a spreadsheet still loses to an ordinary snapshot of a real moment.
3. intentionality and absence of technical_flaws (a flawed photo can't win among real photos)
4. fit to PURPOSE (a 5-expression close-up beats a wide shot for dating; reverse for an establishing dump slot)
5. vibe_tags match to USER TASTE and RECENT BEHAVIOR
6. subject_clarity, expression, and a genuine smile (a real smile or laughter is a strong positive)

"because" is ONE short user-facing line explaining what the photo is good for (e.g. "strong side light, clean silhouette — cover material"), never a number, never negative about the person in the photo. Be honest: never rebrand a real flaw as a feature — do NOT call motion-blur "soft motion", closed-eyes "candid", or an unreadable frame "atmospheric". For a low-scoring photo, plain neutral photo-level language is fine ("a little soft — better as a filler than a cover"); praise only what is genuinely there.

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
