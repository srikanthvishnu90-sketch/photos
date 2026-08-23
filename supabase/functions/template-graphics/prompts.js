// template-graphics prompts — canonical, shared between the edge function
// (Deno) and any eval harness. Nano Banana Pro (gemini-3-pro-image) renders
// crisp, correctly-spelled text, so these templates lean on real typography.
//
// Product intent (College-Commitment / Template Graphics, Master Features #17):
// composite the person from the user's source photo into a fan-made graphic
// (a college-commitment announcement, a grad card, a game-day poster) WITHOUT
// altering their face or identity, and WITHOUT ever implying the event is
// real, official, or endorsed. Everything here is a mockup.

// The strict preamble prepended to every template prompt.
export const TEMPLATE_PREAMBLE = `You are the template-graphics compositor inside Gems. You produce a fan-made MOCKUP graphic, not a real document.
Hard rules:
- The person in the source photo is the subject. Keep their face, features, skin tone, hair, body, and identity EXACTLY as in the source. Never swap, beautify, de-age, slim, or restyle the person. Do not invent a different person.
- Composite that same person cleanly into the template layout described below. Match the lighting and edges so the cutout looks intentional, but never change who they are.
- Render every piece of TEXT crisply, legibly, and spelled EXACTLY as given — no gibberish letterforms, no misspellings, no invented words. Keep names, schools, numbers, and years verbatim.
- This is a fan-made / celebratory mockup. Never add real logos, trademarks, official seals, signatures, or wording that implies an actual offer, acceptance, commitment, enrollment, endorsement, or sponsorship is real or official. It is a graphic a fan or family would make.
- Return a single finished graphic image.`;

// Small helpers so a template reads cleanly and never emits "undefined".
function clean(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

// Each template: { slug, label, promptTemplate(fields) -> instruction text }.
// The client mirror lives in gems-templates.js (TEMPLATE_LABELS) — keep the
// slugs, field keys, and option values in sync across the two files.
export const TEMPLATE_DEFS = [
  {
    slug: "college_commitment",
    label: "College Commitment",
    promptTemplate(fields = {}) {
      const schoolName = clean(fields.schoolName, "the university");
      const sport = clean(fields.sport, "their sport");
      const homeOrAway = clean(fields.homeOrAway, "home").toLowerCase();
      const jerseyNumber = clean(fields.jerseyNumber);
      const style = clean(fields.realisticOrGraphic, "graphic").toLowerCase();
      const look =
        style.startsWith("real")
          ? "a photo-realistic sports-photography look, as if shot on the field"
          : "a bold, poster-style graphic-design look with clean vector shapes and flat color fields";
      const kit =
        homeOrAway === "away"
          ? "the away (lighter/road) uniform color scheme"
          : "the home (primary) uniform color scheme";
      const numberLine = jerseyNumber
        ? `Show the jersey number ${jerseyNumber} large and legible on the kit.`
        : "No jersey number is specified; leave the kit number area clean.";
      return `Template: COLLEGE COMMITMENT announcement (fan-made mockup).
Compose a commitment-announcement graphic celebrating that the athlete is committing to ${schoolName} to play ${sport}.
Layout: the athlete from the source photo as the hero, dressed in ${sport} attire styled in ${kit} that reads as ${schoolName}'s colors (do NOT reproduce any official logo or trademark). ${numberLine}
Headline text (render crisply, spelled exactly): "COMMITTED" as the dominant word, with "${schoolName}" and "${sport}" as supporting text. You may add a tasteful "Class of" style tag line, but invent no false facts.
Style: ${look}.
Keep it celebratory and clearly a personal/fan graphic — never an official signing document.`;
    },
  },
  {
    slug: "grad",
    label: "Graduation",
    promptTemplate(fields = {}) {
      const schoolName = clean(fields.schoolName, "their school");
      const year = clean(fields.year, "this year");
      return `Template: GRADUATION card (fan-made mockup).
Compose a celebratory graduation graphic for the person in the source photo.
Layout: the graduate as the hero, with a cap-and-gown feel appropriate to the photo (add a tasteful cap/tassel motif if it fits naturally; do not obscure the face).
Text (render crisply, spelled exactly): "CONGRATS GRAD" or "CLASS OF ${year}" as the headline, with "${schoolName}" as supporting text.
Style: a warm, polished celebratory poster look with clean typography.
This is a personal keepsake graphic — no official crest, seal, or diploma wording.`;
    },
  },
  {
    slug: "game_day",
    label: "Game Day",
    promptTemplate(fields = {}) {
      const teamName = clean(fields.teamName, "the home team");
      const opponent = clean(fields.opponent, "the opponent");
      return `Template: GAME DAY hype poster (fan-made mockup).
Compose an energetic game-day matchup graphic featuring the person in the source photo as the highlighted player.
Text (render crisply, spelled exactly): "GAME DAY" as the dominant word, with the matchup "${teamName} vs ${opponent}" clearly legible.
Style: a high-energy sports-poster look — dynamic angles, motion, bold color blocks, stadium-lighting mood.
Keep it a fan-made hype graphic — no official league logos, marks, or broadcast branding.`;
    },
  },
];

const DEFS_BY_SLUG = new Map(TEMPLATE_DEFS.map((def) => [def.slug, def]));

// Build the full instruction text for a template + user fields.
// Returns { text } for a known slug, or null for an unknown one.
export function buildTemplatePrompt(slug, fields = {}) {
  const def = DEFS_BY_SLUG.get(String(slug ?? ""));
  if (!def) return null;
  const instruction = def.promptTemplate(fields ?? {});
  return { text: `${TEMPLATE_PREAMBLE}\n\n${instruction}` };
}
