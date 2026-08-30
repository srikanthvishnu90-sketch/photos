// Scene prompt contract v1.
// Pure and environment-free so the exact provider prompt can be snapshot-tested
// without Deno, Supabase, credentials, storage, or model calls.
//
// Compatibility rule: changing any emitted wording, block order, style entry,
// or safety matcher requires a new prompt version and a new module/snapshot.

export const SCENE_PROMPT_VERSION = "scene-server-v1" as const;
export const SCENE_PROMPT_REGISTRY_VERSION = 1 as const;

const REALISM_LAYER = `REALISM REQUIREMENTS — this must read as a real, casual iPhone photograph, NOT AI art and NOT a professional/editorial/stock shoot.
NORTH STAR: it should look like a good photo a friend snapped on their phone — authentic, not impressive. If the result looks too perfect, too clean, too evenly lit, too well-composed, or too "premium," it reads as AI. Aim for AUTHENTIC over BEAUTIFUL every single time. A slightly worse-looking but real photo beats a gorgeous fake one.

EMBRACE IMPERFECTION — DELIBERATELY MAKE THE IMAGE "WORSE" (this is the #1 realism lever). A real phone photo is TECHNICALLY WORSE than a polished render, and that is exactly why it reads as real. Do NOT optimize image quality — do the opposite:
- DO NOT "fix" the image into a polished render, but DO render it through the iPhone pipeline: shadows are LIFTED and OPEN (few true blacks) yet still noisy; highlights are gently COMPRESSED/rolled off (rarely pure-white clipped); the midtones read slightly FLAT and washed-out — the "everything visible, low-contrast HDR" look people call over-processed. Dim scenes stay dim-but-open-and-noisy, not crushed to black.
- HARSH, UNEVEN, UNFLATTERING LIGHT is good: hard midday sun with hard-edged shadows and blown highlights, or dim warm indoor tungsten with deep shadow across the frame and mixed white balance. Avoid the even, soft, flattering, everywhere-lit look — that is the giveaway.
- HAZY ATMOSPHERIC DISTANCE: render distant backgrounds (skylines, hills, far buildings) LOW-contrast, desaturated and softened by haze/atmospheric perspective — never crisp and hyper-detailed to the horizon.
- MUNDANE CONTENT & BACKGROUND PEOPLE: fill it with incidental strangers mid-errand, a passing dog, a bird, ordinary clutter — not everything is a hero subject cleanly framed.
- MUTED, SLIGHTLY-OFF COLOR + real sensor noise and light JPEG compression. Never vivid, never spotless.
- RAKING LIGHT + GENUINE WEAR: favor low, raking side-light that skims and reveals texture; include real everyday wear — a scuffed shoe, creased linen, a wrinkle, a smudge, a stray hair. Nothing pristine or freshly-pressed.
- Often a LANDSCAPE or loosely-framed grab-shot rather than a perfectly composed portrait.

CAPTURE MODEL — reproduce a modern iPhone's computational pipeline, not a DSLR:
- Small-sensor smartphone, ~24mm-equivalent main lens at ƒ/1.8. DEEP depth of field: the subject AND the background are both essentially in focus. Do NOT add creamy/dreamy background blur unless Portrait mode is explicitly requested — shallow optical bokeh is a top AI/DSLR tell.
- Casual handheld framing: a real person's grab-shot, never a tripod, drone, or art-directed composition. Slight tilt, imperfect horizon, subject a little off-center, natural (not golden-ratio) placement are all GOOD.

SENSOR & OPTICS — the exact iPhone fingerprints (multi-frame fusion of ~9 stacked frames):
- NOISE: near-zero chroma noise, but a TRACE of fine, tight LUMINANCE noise surviving in shadows and mid-dark skin. NOT film grain — fine and tight. Flat areas (skies, walls, cheeks) read slightly "plasticky" from aggressive denoise.
- SHARPENING: strong local edge micro-contrast — the "etched / over-sharpened" iPhone look. High-frequency detail (hair strands, fabric weave, foliage, distant brick) is crunchy and accentuated, with FAINT BRIGHT HALOS along high-contrast edges. Never soft or painterly.
- LENS (24mm-equiv ƒ/1.78): mild corner softness and light vignetting; occasional green/magenta chromatic aberration on backlit edges; and — against any point light (streetlight, sun) — a distinctive multi-point LENS FLARE with small colored ghost blobs (a strong iPhone tell).
- MOTION: static subjects are crisp with no blur, but MOVING edges (hands, hair, leaves, water) can show faint ghosting/doubling from the frame stacking.

TONE & COLOR — Apple's exact processed look:
- SEGMENTED EXPOSURE (the key iPhone tell): the pipeline exposes sky, skin, and background INDEPENDENTLY, so you get a bright, cleanly-exposed FACE against a still-detailed BRIGHT SKY — neither blown. Faces are lifted/brightened relative to the scene.
- Very wide DR with a FLAT, low-contrast HDR midtone; lifted OPEN shadows (few true blacks), soft highlight roll-off (no clipped white) — milky, not punchy.
- WHITE BALANCE slightly cool-accurate to warm; skin rendered WARM and slightly brightened. PROTECTED skin tones with visible pores, fine lines and a little T-zone sheen — never whitened, waxy, or beauty-filtered.
- Punchy-but-not-lurid color, with characteristically OVER-SATURATED blue skies and vivid greens. Never candy-HDR / radioactive-teal.

PHYSICAL CONSISTENCY: one coherent light logic; shadows all agree in direction, length and softness; reflections geometrically correct and matched between both eyes and in glass/mirrors; parallel lines converge to consistent vanishing points; materials obey physics (cloth drape, hair strands, liquid, fabric weave, fingerprints on glass, wear on surfaces).

PORTRAIT MODE (ONLY when explicitly requested): synthetic-style background blur with a believable focal plane, and TOLERATE slightly imperfect subject-edge separation (a little haloing at the hairline) rather than a flawless cutout — real Portrait mode is imperfect.

FAILURE-DERIVED RULES (these are the tells that survive even excellent generation — obey them):
- UNEVEN ARCHITECTURAL LIGHT: in any lit building, ruin, or facade, illumination through multiple openings must be UNEVEN — some windows/arches bright, some dim, some fully dark where real interior structure would block the light. Never a uniform glow of equal intensity through many openings (the averaging signature).
- IMPERFECT STAGING: real scenes are not art-directed. Foreground props must be asymmetric; include at least one mundane, slightly out-of-theme object (a stray napkin, a cord, a neighbor's clutter, a sign). NEVER symmetric flanking decor (matched potted trees on each side), never a perfectly centered, spotless composition.
- TIME-OF-DAY COHERENCE: food, activity, crowd density, sky state, streetlights, and shadow direction must all agree on ONE hour of day. Never breakfast food under night lighting, or a bright midday sky with lit interior lamps.
- ENTROPY: fill the world with hundreds of small uncurated real-world decisions — mismatched shutters, antennas, laundry, worn edges, people mid-errand rather than posed. Sterile perfection reads as fake.
- SATURATION CEILING: keep color controlled and muted; NEVER the radioactive-teal / candy-HDR / over-saturated tone-compressed look. Over-editing is its own uncanny valley — restrained grade over punchy every time.

BANNED AI TELLS: plastic/waxy/poreless skin, perfect facial or scene symmetry, over-smooth gradients, hyper-saturated HDR flatness, shadowless studio-everywhere lighting, warped/gibberish text, impossible or mismatched reflections, extra or fused fingers, melted object boundaries, dreamy optically-perfect bokeh, floating/pasted-on subjects, and the overall "too polished to be real" look.`;

const MODESTY = `WARDROBE MODESTY (required): the user is always fully and tastefully clothed in real, on-theme outfits. NEVER depict them shirtless, in a bikini/swim trunks/swimwear, or in any revealing state — even in pool, boat, or beach scenes (in those, dress them in linen, resortwear, or a cover-up over clothing). Keep it modest and realistic.`;
const FRAMING = `FRAMING & DISTANCE (critical for realism): shoot the user from a NATURAL DISTANCE — a medium-to-wide candid photo where they occupy only about a third to a half of the frame and the SETTING is clearly visible around and behind them. Their FACE must NOT be close to the camera and must NOT fill the frame — absolutely no tight selfie or head-and-shoulders portrait crop. Frame it like a friend a few steps away taking a full-body or half-body travel photo, so the person AND the place both read. A face too close to the camera instantly looks AI-generated — keep the distance.`;
const FACE_REALISM = `FACE REALISM — kill the AI-person tells (obey all):
- EYES: natural moisture and a SOFT single catchlight that is IDENTICAL in BOTH eyes and matches the scene's light direction; gaze slightly soft and often off-camera. NEVER glassy, doll-like, dead, or hyper-focused razor-sharp irises.
- ASYMMETRY: a real, ordinary, NON-symmetric face — features not averaged into "influencer" perfection; allow a slightly uneven eye, a natural nose, distinctive imperfections. Perfect symmetry and model-beauty read as AI.
- SKIN under this light: visible pores, peach-fuzz, minor blemishes/redness, uneven tone, under-eye texture, a little T-zone shine — never airbrushed, poreless, or glowing.
- TEETH: natural, slightly uneven, not brilliant-white or a perfect grin.
- HAIR: individual flyaway strands and a slightly messy, natural hairline that does NOT melt into the skin.
- FACE LIGHT: directional — one side of the face a little brighter, soft shadow under the nose/chin. Never flat, even, everywhere-flattering studio light on the face.
- EXPRESSION: candid, caught mid-moment, a neutral or asymmetric micro-expression — never a posed, straight-to-camera "trustworthy" smile (the uncanny tell).
- HANDS if visible: correct five fingers, relaxed and natural — or kept partly out of frame.`;
const IDENTITY = `The attached photo(s) at the START are all the SAME person — the user. Study them together to lock their exact facial identity, then render that same person in the scene with their skin tone, hair, and build preserved — recognizably them, naturally integrated into the scene's lighting and perspective. Do not beautify, restyle, or alter their face or body.`;
const FACE_FIDELITY = `FACE FIDELITY — THE SINGLE MOST IMPORTANT REQUIREMENT. The face in the output must be the EXACT face from the user's attached reference photo(s) — not a lookalike, not an "improved" version:
- Copy their real facial geometry precisely: eye shape and spacing, nose, mouth, lips, jawline, cheekbones, brow, hairline, ears, and every mole, freckle, scar, facial hair and natural asymmetry.
- KEEP REAL SKIN: visible pores, fine lines, natural texture, subtle blemishes, uneven tone, stubble, under-eye shadows. Do NOT smooth, airbrush, slim, whiten, de-age, or beautify. Apply NO beauty filter.
- Match their real skin tone and complexion exactly, including any redness or unevenness.
- Expression and gaze stay natural and candid — never posed-perfect or model-like.
BANNED AI TELLS (these ruin it): waxy / plastic / porcelain / rubbery skin, over-smoothed or blurred skin, doll-like or glassy eyes, perfectly symmetric face, airbrushed "influencer" look, mannequin sheen, over-sharpened HDR, teeth too white or too even, or any face that looks prettier or different than the real photo.`;
const ENVIRONMENT_MATCH = `ENVIRONMENT REFERENCE — the LAST attached image is a REAL photograph of the exact kind of place this photo is taken. RECREATE THAT ENVIRONMENT AT ROUGHLY 90% FIDELITY: the same location and layout, the same perspective and depth, the same light direction and time of day, the same palette, materials and texture — as if this new photo were taken standing in the same spot a few minutes later. You may vary small details (exact crop, incidental people far in the background, minor weather) but NEVER swap to a different-looking place. If a person appears in the reference, IGNORE their identity completely — the person in the output is ONLY the user from the identity photo(s), placed naturally into that environment; their stance may echo the reference person's if it fits the requested pose. Match the reference's CAPTURE QUALITY too — its real phone-photo light, contrast, and imperfection are the quality target.`;
const ENVIRONMENT_MATCH_BACKGROUND = `ENVIRONMENT REFERENCE — the LAST attached image is a REAL photograph of the place. RECREATE THAT ENVIRONMENT AT ROUGHLY 90% FIDELITY as an EMPTY scene: same location, layout, perspective, light, palette and texture, with NO people in it. Remove any people present in the reference. Match its real phone-photo capture quality.`;
const MATCH_REFERENCE = `RECREATE THE ATTACHED REFERENCE PHOTO, but the person in it is the user from the first attached image. Match the reference's composition, camera angle, framing, pose, distance, setting, lighting, color grade and overall mood as closely as possible — it should look like the same photograph, simply taken of the user instead. Keep the user's exact face and identity (this is a face/identity swap, not a lookalike). Preserve realistic body proportions consistent with the user.`;
const BACKGROUND = `Generate an ATMOSPHERIC SCENE with NO people in it — an empty, aspirational location photograph (an "aesthetic background"). No human figures, no faces, no silhouettes of people. Focus entirely on the environment, light, and mood.`;
const NEGATIVE = "No watermark-style text, no captions, no borders.";

export const SCENE_PROMPT_BLOCKS = Object.freeze({
  realism: REALISM_LAYER,
  safetyModesty: MODESTY,
  realismFraming: FRAMING,
  identityFaceRealism: FACE_REALISM,
  identity: IDENTITY,
  identityFaceFidelity: FACE_FIDELITY,
  environmentReference: ENVIRONMENT_MATCH,
  environmentReferenceBackground: ENVIRONMENT_MATCH_BACKGROUND,
  identityMatchReference: MATCH_REFERENCE,
  safetyBackgroundNoPeople: BACKGROUND,
  safetyNegative: NEGATIVE,
});

export const SCENE_STYLE_PACK_IDS = Object.freeze(["dating","euro-summer","dubai","old-money","luxury-cars","beach-club","boat","dark-luxe","after-dark"] as const);
export type SceneStylePackId = (typeof SCENE_STYLE_PACK_IDS)[number];

const STYLE_PACK_DEFINITIONS = {
  "dating": {
    "prompt": null,
    "wardrobe": null
  },
  "euro-summer": {
    "prompt": "STYLE — Euro Summer (men): a warm, film-like European summer travel photograph. WARDROBE: a relaxed linen button-down shirt (white, cream, olive, or terracotta/rust), loose tailored trousers or chinos in cream/stone/olive/grey, leather sandals or espadrilles, optionally a canvas tote and a simple watch — effortless old-money Mediterranean menswear, never flashy, no big logos. SETTING (draw from these real Mediterranean scenes, pick what fits): an Amalfi/Positano cliffside town tumbling to a turquoise sea at golden hour with warm window-lights and cascading bougainvillea; the colorful stacked houses of Cinque Terre / Portofino / Manarola perched over clear teal water; a lemon-draped café terrace (Capri/Amalfi) with wrought-iron bistro tables, majolica-tiled tabletops and iron lanterns; a narrow cobblestone alley of ochre, coral and butter-yellow buildings with green and teal shutters, geraniums in terracotta pots, and laundry strung overhead; a French-Riviera cove with cypress trees, honey-stone houses and moored wooden boats. Recurring notes: magenta bougainvillea, wisteria, lemon trees, marble café tables, worn stone stairs, whitewashed walls and terracotta roofs. LIGHT: warm golden-hour or bright Mediterranean midday with long soft shadows and clear teal water. LOOK: shot on 35mm film (Kodak Portra warmth, gentle grain, soft highlight rolloff) — warm and analog, NEVER the oversaturated candy-HDR Pinterest look. Candid and relaxed — walking, leaning, mid-stride, glancing off-camera — an editorial travel snapshot, never a stiff studio pose.",
    "wardrobe": "PREFERRED for a man — FIT 1: a well-fitted linen button-down (long- or short-sleeve) in beige, white, cream or olive, worn with matching linen trousers and leather sandals or clean minimal sneakers; OR FIT 2: a tight, good-fitting plain tee in a warm neutral (white/beige/olive) with well-fitted tailored trousers or clean stone chinos. For a woman: a white halter or ribbed linen top with white wide-leg linen trousers or a cream silky maxi skirt, or an oversized white linen shirt with tailored white shorts and a slim brown belt — gold jewelry, a small leather bag, sunglasses"
  },
  "dubai": {
    "prompt": "STYLE — Dubai Luxe (aspirational Gulf luxury): the look of Dubai's finest hotels and residences. SETTINGS (pick what fits the request): a rooftop INFINITY POOL on a high floor at blue-hour/sunset overlooking the Burj Khalifa and the lit Downtown skyline, with teak sun-loungers, cabanas and date palms, warm path-lights glowing along the pool; a marble-and-warm-wood penthouse living room with a floor-to-ceiling window framing the Burj Khalifa at dusk, warm cove lighting, a brass lantern and a low travertine coffee table; a chic BEACH CLUB with rows of striped umbrellas and day-beds on raked sand, palms and red bougainvillea, calm Gulf water; a golden-hour rooftop TERRACE with a low modern cream sofa, lanterns and a folded throw, overlooking Dubai Marina and the sea; the Burj Al Arab or Madinat Jumeirah waterways framed by date palms and Arabesque lamps; Atlantis The Palm glowing across still water at dusk; the Dubai Fountain boardwalk and curved Address-hotel terraces lit warm at night. LIGHT: warm sunset / blue-hour with a peach-to-navy gradient sky, glowing city lights and warm practical lamps; or bright hazy Gulf daylight. COLOR: warm gold + teal water + navy dusk — rich but CONTROLLED, never garish or candy-HDR. MOOD: serene, expensive, aspirational — quiet wealth with a skyline.",
    "wardrobe": "PREFERRED for a man — FIT 1: a crisp well-fitted linen button-down (long- or short-sleeve) in white, beige, light blue or navy, with matching linen or tailored trousers and a good watch; OR FIT 2: a tight, good-fitting plain tee in white, beige or navy with sharp tailored trousers. For a woman: a flowing cream/white maxi dress, a linen co-ord (fitted top and wide-leg trousers), or a chic white shirt with tailored trousers — elegant resort luxury"
  },
  "old-money": {
    "prompt": "STYLE — Old Money (Riviera / Monaco quiet wealth): the real aesthetic of Monaco and the Côte d'Azur old-money elite. SETTINGS (pick what fits the request): the Place du Casino outside the Belle-Époque Casino de Monte-Carlo with a row of parked supercars (a red Ferrari, a classic car) and the Hôtel de Paris, warm-lit and grand; the Monaco Grand-Prix hairpin by the Fairmont with its red-and-white kerbs and a Ferrari mid-corner; a cobbled Belle-Époque street of cream and pastel-yellow facades with ornate wrought-iron balconies, red-and-white Monaco flags, palms and the grey Tête-de-Chien cliff behind; the Fontvieille harbour seen from above — rows of white yachts on deep teal water ringed by terracotta apartment blocks and a green headland; a luxury-boutique frontage (Tiffany, Ferragamo, Graff) with a Rolls-Royce and a Porsche parked outside; a classic cream Rolls-Royce or vintage convertible parked at the Casino at night; the Casino exotic-garden terraces with palms and cascading stone staircases; a hillside villa balustrade or an iron gate framing the harbour and green mountains. LIGHT: for DAY, bright hazy Mediterranean sun, warm and clear, deep-blue sky, soft haze on the distant headland (atmospheric perspective), hard clean shadows; for NIGHT, warm glowing Belle-Époque facade lights and lanterns against a deep blue-hour sky, reflections on car paint. COLOR: warm cream stone + terracotta + deep-green foliage + Mediterranean teal sea, plus the odd bold supercar red/yellow — muted and elegant overall, never candy-HDR. MOOD: effortless, moneyed, unhurried.",
    "wardrobe": "PREFERRED for a man — the signature Monaco look: a pale-blue or white linen shirt (or a fitted polo) worn with WHITE or cream wide-leg pleated linen trousers and leather loafers, plus a good watch and sunglasses; grey tailored trousers with a blue polo also works by day. For NIGHT: a black silky shirt with white pleated trousers (elegant, cinematic). Otherwise FIT 1: a well-fitted linen/fine-cotton button-down in white, cream, pale blue or navy with tailored trousers; or a navy blazer over a white shirt. For a woman: a tailored white shirt with cream wide-leg trousers, an elegant linen co-ord, or a refined summer dress with delicate gold jewelry — understated old-money elegance"
  },
  "luxury-cars": {
    "prompt": "STYLE — Luxury Cars (supercar flex, tasteful): a candid photo with a high-end car as the hero. SETTINGS (pick what fits the request): a gleaming supercar — a red or yellow Ferrari, a Lamborghini, a matte-black or silver Porsche 911, or a classic Rolls-Royce / vintage convertible — parked at the valet forecourt of a grand Belle-Époque hotel, on a cobbled European street, at a marina beside white yachts, in a clean minimalist private garage/showroom, or on a coastal mountain road; the subject standing beside or leaning on the car, or seated in the driver's seat with a hand on the wheel. LIGHT: for DAY, bright clean sun with crisp reflections and highlights sliding along the car's paint and chrome, deep-blue sky, hard clean shadows; for NIGHT, warm street/garage lights and neon glinting off the bodywork against a dark surround, wet-look reflections. COLOR: sleek and controlled — muted elegant surroundings with the car's bold paint (red / yellow / silver / black) as the one strong accent; deep clean blacks, real metallic reflections. MOOD: effortless wealth, quietly confident, never gaudy.",
    "wardrobe": "PREFERRED for a man — FIT 1: a well-fitted linen or fine-cotton button-down (long- or short-sleeve) in white, black, navy or stone with tailored trousers and clean minimal sneakers or loafers; OR FIT 2: a tight, good-fitting plain tee in white, black or grey with sharp tailored trousers or dark jeans; a fitted polo or a light bomber jacket also works — sharp smart-casual with a good watch and sunglasses. For a woman: a fitted top with tailored trousers, a sleek co-ord, or a chic dress — refined, never flashy. Always fully clothed"
  },
  "beach-club": {
    "prompt": "STYLE — Beach Club (chic Mediterranean / Gulf beach club): a bright, upscale beach-club day. SETTINGS (pick what fits the request): rows of striped umbrellas and teak day-beds on raked white sand, cream-and-blue parasols, cabanas and a wooden boardwalk, calm turquoise water and moored boats beyond; a beachfront pool bar with rattan stools and a cocktail on a side table; a shaded cabana with billowing white curtains and cushions; palms and bougainvillea framing the sand. LIGHT: bright hot midday Mediterranean/Gulf sun, high-key and sparkling on the water, strong natural contrast with sea-reflected fill and real sun flare; or warm late-afternoon gold. COLOR: crisp white + turquoise water + warm sand + the parasols' stripes — sunny but controlled, never candy-HDR. MOOD: relaxed, moneyed, sun-soaked.",
    "wardrobe": "IMPORTANT — fully-clothed RESORTWEAR only, NEVER swimwear even at the beach. PREFERRED for a man — FIT 1: an open-but-buttoned or short-sleeve linen shirt in white, cream, blue or a soft stripe with linen shorts or trousers, leather sandals and sunglasses; OR FIT 2: a fitted plain tee or polo in white or navy with tailored linen shorts. For a woman: a breezy sundress, a linen shirt-dress, or a linen co-ord / cover-up worn over the outfit, with sunglasses and a straw hat — chic beach-club resortwear, always modestly and fully clothed"
  },
  "boat": {
    "prompt": "STYLE — On the Water (boat day): a candid summer boat-day photograph, film-like and effortless. SETTING: a small motorboat or day-yacht on clear turquoise/teal Mediterranean or lake water — teak deck, a bimini top, chrome grab-rails, cream upholstery; a Greek/Italian coastline, a whitewashed hillside village or a pine-covered shore in the background, a bright wake trailing behind at speed. SUBJECT (the user): FULLY CLOTHED in relaxed resortwear (linen shirt and linen trousers or tailored shorts, or a breezy sundress) — driving the boat shot from behind over the shoulder, sitting on the bow looking out at the coast, leaning forearms on the gunwale, or seated on the deck taking in the view. Never shirtless, never in swimwear. FRAMING mid or wide, candid, never a posed studio shot. LIGHT: bright hard midday sun, sparkling water, strong natural contrast and real sun flare; or warm late-afternoon gold. LOOK: shot on a phone / 35mm — natural skin with real sheen, gentle grain, salt-and-sun realism, never glossy or airbrushed.",
    "wardrobe": "PREFERRED for a man — FIT 1: a well-fitted linen button-down (long- or short-sleeve) in white, light blue or navy, with white or stone linen trousers and sunglasses; OR FIT 2: a tight, good-fitting plain tee in white or navy with tailored linen trousers. For a woman: a white or striped linen shirt with tailored trousers, or a breezy cream sundress — FULLY-CLOTHED boat-day resortwear (never swimwear)"
  },
  "dark-luxe": {
    "prompt": "STYLE — Dark Luxe (quiet-wealth, cinematic): the aesthetic of a high-floor luxury penthouse and moody five-star resort. SETTINGS (pick what fits the request): a modern penthouse with floor-to-ceiling glass over a hazy city skyline (Dubai/Gulf-tower energy — distant towers, warm dusk or bright daytime haze); a dim, expensively-furnished suite with a single warm lamp glowing against a blue-hour cityscape; a dark infinity or resort pool at dusk framed by deep-green tropical foliage and teak decking; a palm-lined boulevard shot from a car; marble, brushed metal, boucle and cream upholstery, a laptop and espresso on a low table. LIGHT: low-key and directional — deep protected shadows, one believable warm source (lamp/window), cool blue ambient; underexposed rather than bright, highlights gently rolled off, never blown. COLOR: muted and desaturated (~-20%), greens pushed dark, blues toward steel/navy, warm accents only from practical lights, clean neutral blacks. MOOD: calm, solitary, aspirational — 'a quiet morning at the top of the world', shot candidly on a phone, never staged or glossy-HDR.",
    "wardrobe": "PREFERRED for a man — FIT 1: a well-fitted linen or fine button-down in navy, black or charcoal with dark tailored trousers; OR FIT 2: a tight, good-fitting plain tee in black, navy or charcoal with dark tailored trousers; a navy/charcoal suit with an open collar and no tie also works. For a woman: an elegant black slip dress, a silk co-ord, or a white shirt with black tailored trousers — quiet, expensive eveningwear"
  },
  "after-dark": {
    "prompt": "STYLE — After Dark (moody luxury, low-exposure): dusk-like underexposure even in daylight; steel-blue/navy skies with retained detail, never blown; deep clean blacks, muted color (~-25% saturation), greens toward dark emerald and blues toward navy, protected skin tones; slightly cool temperature; no added grain, subtle vignette at most. Quiet, expensive, cinematic.",
    "wardrobe": "PREFERRED for a man — FIT 1: a well-fitted button-down in black or navy with dark trousers; OR FIT 2: a tight, good-fitting plain tee in black or navy with dark tailored trousers, optionally a matte black overshirt on top. For a woman: a sleek black slip dress, or a fitted top with tailored trousers — sharp, understated night-out"
  }
} as const;

export const SCENE_STYLE_PACKS = Object.freeze(
  Object.fromEntries(
    SCENE_STYLE_PACK_IDS.map((id) => [
      id,
      Object.freeze({
        prompt: STYLE_PACK_DEFINITIONS[id].prompt,
        wardrobe: STYLE_PACK_DEFINITIONS[id].wardrobe,
      }),
    ]),
  ) as Readonly<Record<SceneStylePackId, {
    readonly prompt: string | null;
    readonly wardrobe: string | null;
  }>>,
);

const STYLE_PACK_ID_SET: ReadonlySet<string> = new Set(SCENE_STYLE_PACK_IDS);

export function isSceneStylePackId(value: unknown): value is SceneStylePackId {
  return typeof value === "string" && STYLE_PACK_ID_SET.has(value);
}

export function resolveSceneStylePackId(value: unknown): SceneStylePackId | null {
  return isSceneStylePackId(value) ? value : null;
}

export const SCENE_SAFETY_REFUSAL_PATTERN = new RegExp(
  "\\b(logo of|brand logo|the [a-z]+ logo|nike swoosh|as (a )?celebrity|deepfake|(taylor swift|lebron|kardashian|elon musk|trump|biden|drake|beyonce|messi|ronaldo))\\b",
  "i",
);

export function sceneRequestViolatesSafety(text: string): boolean {
  return SCENE_SAFETY_REFUSAL_PATTERN.test(text);
}

export const SCENE_PROMPT_REGISTRY_V1 = Object.freeze({
  registryVersion: SCENE_PROMPT_REGISTRY_VERSION,
  promptVersion: SCENE_PROMPT_VERSION,
  stylePackIds: SCENE_STYLE_PACK_IDS,
  stylePacks: SCENE_STYLE_PACKS,
  blocks: SCENE_PROMPT_BLOCKS,
  refusalPatternSource: SCENE_SAFETY_REFUSAL_PATTERN.source,
});

export type ScenePromptMode = "me" | "background";

export type ScenePromptBuildInput = {
  prompt: string;
  stylePackId?: unknown;
  aspect: string;
  mode: ScenePromptMode;
  hasSubject: boolean;
  matchReference?: boolean;
  resolvedReferenceCount?: number;
  environmentReferenceAttached?: boolean;
  realismReferenceCount?: number;
  wardrobe?: string;
  pose?: string;
  build?: string;
};

export type ScenePromptBlockId =
  | "request"
  | "style"
  | "realism"
  | "realism_references"
  | "environment_reference"
  | "environment_reference_background"
  | "identity"
  | "match_reference"
  | "background_no_people"
  | "face_fidelity"
  | "face_realism"
  | "safety_modesty"
  | "realism_framing"
  | "body_type"
  | "wardrobe_custom"
  | "wardrobe_auto"
  | "pose_custom"
  | "pose_candid_default"
  | "output_contract";

export type BuiltScenePrompt = Readonly<{
  version: typeof SCENE_PROMPT_VERSION;
  text: string;
  blockIds: readonly ScenePromptBlockId[];
  stylePackId: SceneStylePackId | null;
}>;

type PromptBlock = { id: ScenePromptBlockId; text: string };

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function photographicReferenceBlock(count: number): string {
  return "PHOTOGRAPHIC-QUALITY REFERENCES: the FINAL " + count +
    " attached photo(s) are REAL amateur iPhone snapshots, included ONLY as the target for PHOTOGRAPHIC QUALITY and REALISM. Study their imperfect exposure, grain and sensor noise, haze, harsh or dim natural light, muted color, and casual amateur feel, and make THIS image look like it was captured the same way — same real, slightly-worse phone-photo quality. Do NOT copy their people, faces, clothing, locations, objects, text, or composition; they are quality/texture references only. The subject and scene come solely from the instructions above.";
}

function bodyTypeBlock(build: string): string {
  return "BODY TYPE (keep it honest): render the user's REAL body type and proportions exactly as in their reference photos" +
    (build ? " (" + build + ")" : "") +
    ". Do NOT make them more muscular, taller, broader, leaner, or more chiselled than they are, and do NOT exaggerate their facial structure or jawline. Their true frame and natural build — never an idealized or \"gym-bro\" version.";
}

function customWardrobeBlock(wardrobe: string): string {
  return "WARDROBE: dress the user in " + wardrobe +
    ". This replaces whatever they are wearing in the reference photo — restyle the clothing to match, but keep their exact face, body, and identity unchanged.";
}

function automaticWardrobeBlock(packWardrobe: string | null): string {
  return "WARDROBE (choose one that suits the subject): dress the user in a tasteful, fully-clothed, on-theme outfit" +
    (packWardrobe ? " — " + packWardrobe : " appropriate to the setting") +
    ". Pick the option that best fits the person you see; keep their face and identity unchanged.";
}

function customPoseBlock(pose: string): string {
  return "POSE & ACTION: the user is " + pose +
    ". Make it look candid and natural — caught mid-moment, not stiffly posed for the camera.";
}

const CANDID_DEFAULT =
  "POSE (candid, NON-NEGOTIABLE — never a stiff straight-on smile to camera): put them in a real between-takes moment — looking down at their phone, glancing off to the side, adjusting a watch or shirt cuff, a hand in a pocket, mid-stride walking, or looking out at the view. Relaxed, weight on one leg, unposed and natural.";

function add(blocks: PromptBlock[], id: ScenePromptBlockId, block: string | null | undefined): void {
  if (block) blocks.push({ id, text: block });
}

export function buildScenePrompt(input: ScenePromptBuildInput): BuiltScenePrompt {
  const blocks: PromptBlock[] = [];
  const stylePackId = resolveSceneStylePackId(input.stylePackId);
  const style = stylePackId ? SCENE_STYLE_PACKS[stylePackId] : null;
  const hasSubject = input.mode !== "background" && input.hasSubject;
  const referenceCount = positiveInteger(input.resolvedReferenceCount);
  const realismReferenceCount = positiveInteger(input.realismReferenceCount);
  const wardrobe = input.wardrobe ?? "";
  const pose = input.pose ?? "";
  const build = input.build ?? "";

  add(blocks, "request", "SCENE REQUEST: " + input.prompt);
  add(blocks, "style", style?.prompt);
  add(blocks, "realism", SCENE_PROMPT_BLOCKS.realism);

  if (realismReferenceCount > 0) {
    add(blocks, "realism_references", photographicReferenceBlock(realismReferenceCount));
  }

  if (input.environmentReferenceAttached) {
    add(
      blocks,
      input.mode === "background"
        ? "environment_reference_background"
        : "environment_reference",
      input.mode === "background"
        ? SCENE_PROMPT_BLOCKS.environmentReferenceBackground
        : SCENE_PROMPT_BLOCKS.environmentReference,
    );
  }

  if (input.mode === "background") {
    add(blocks, "background_no_people", SCENE_PROMPT_BLOCKS.safetyBackgroundNoPeople);
  } else if (input.matchReference && referenceCount > 0) {
    add(blocks, "match_reference", SCENE_PROMPT_BLOCKS.identityMatchReference);
  } else if (hasSubject) {
    add(blocks, "identity", SCENE_PROMPT_BLOCKS.identity);
  }

  if (hasSubject) {
    add(blocks, "face_fidelity", SCENE_PROMPT_BLOCKS.identityFaceFidelity);
    add(blocks, "face_realism", SCENE_PROMPT_BLOCKS.identityFaceRealism);
    add(blocks, "safety_modesty", SCENE_PROMPT_BLOCKS.safetyModesty);
    add(blocks, "realism_framing", SCENE_PROMPT_BLOCKS.realismFraming);
    add(blocks, "body_type", bodyTypeBlock(build));

    if (wardrobe) {
      add(blocks, "wardrobe_custom", customWardrobeBlock(wardrobe));
    } else {
      add(blocks, "wardrobe_auto", automaticWardrobeBlock(style?.wardrobe ?? null));
    }

    if (pose) {
      add(blocks, "pose_custom", customPoseBlock(pose));
    } else {
      add(blocks, "pose_candid_default", CANDID_DEFAULT);
    }
  }

  add(
    blocks,
    "output_contract",
    "Render as a " + input.aspect + " vertical-friendly aspect ratio. " +
      SCENE_PROMPT_BLOCKS.safetyNegative,
  );

  return Object.freeze({
    version: SCENE_PROMPT_VERSION,
    text: blocks.map((block) => block.text).join("\n\n"),
    blockIds: Object.freeze(blocks.map((block) => block.id)),
    stylePackId,
  });
}
