// generate-scene — photoreal, reference-conditioned AI image generation for Gems
// "Scenes" (and optional identity-preserving "me in a scene"). Same guardrails as
// edit-photo: JWT auth, per-user monthly generative cap (pro = 3 units), owner-
// scoped storage, provenance on every output, metered to taste_events. Outputs
// are projects of kind 'scene' — they never enter Discover / carousel / ranking
// (those read the on-device photo library, a separate store).
import { createClient } from "npm:@supabase/supabase-js@2";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const STANDARD_MODEL = Deno.env.get("GEMINI_IMAGE_MODEL") ?? "gemini-3.1-flash-image";
const PRO_MODEL = Deno.env.get("GEMINI_PRO_IMAGE_MODEL") ?? "gemini-3-pro-image";
const FREE_SCENE_UNITS_PER_MONTH = Number(Deno.env.get("FREE_SCENE_UNITS_PER_MONTH") ?? "30");
// Free tier = ONE generation request, capped to this many images total so reusing
// a requestId can't mint unlimited free images.
const MAX_FREE_IMAGES = Number(Deno.env.get("MAX_FREE_IMAGES") ?? "10");
const SIGNED_URL_SECONDS = 60 * 60 * 24 * 7;
const MAX_REFS = 3;

// Global realism reference set: real amateur iPhone photos stored under a reserved
// prefix in the `inspiration` bucket (managed out-of-band, shared across all users).
// Attached as QUALITY-ONLY conditioning so generations inherit real-photo
// imperfection (grain, exposure, haze) — pixel-anchored realism beyond the prompt.
const REALISM_REFS_ENABLED = (Deno.env.get("REALISM_REFS_ENABLED") ?? "true") !== "false";
const REALISM_REFS_PREFIX = Deno.env.get("REALISM_REFS_PREFIX") ?? "_global/realism";
const REALISM_REF_COUNT = Number(Deno.env.get("REALISM_REF_COUNT") ?? "3");
// Per-pack ENVIRONMENT reference libraries: real photographs of each style pack's
// places, stored under `inspiration/_global/packs/<packId>/` (managed out-of-band).
// Every pack generation recreates ONE of these real photos ~90% and inserts the
// user into it — pixel-anchored scenes instead of prompt-imagined ones. The
// caller's `environmentRef` index picks which photo, so a batch of N images gets
// N DIFFERENT real environments.
const PACK_REFS_ENABLED = (Deno.env.get("PACK_REFS_ENABLED") ?? "true") !== "false";
const PACK_REFS_PREFIX = Deno.env.get("PACK_REFS_PREFIX") ?? "_global/packs";

// Always appended so output reads as a real smartphone photo, not AI art.
// This is the single most load-bearing block for "it looks too AI". The core
// insight: a real iPhone photo is NOT a polished, superior-looking image — it
// carries a SPECIFIC computational-photography signature (deep depth of field,
// warm protected skin, luminance shadow noise, casual framing, entropy). The AI
// tell is that the output looks TOO good — too clean, too composed, too lit. We
// reproduce Apple's processed look, not optical perfection.
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

// The subject is ALWAYS fully and tastefully clothed — never swimwear or shirtless,
// in any setting. Appended whenever a real person is in the output.
const MODESTY = `WARDROBE MODESTY (required): the user is always fully and tastefully clothed in real, on-theme outfits. NEVER depict them shirtless, in a bikini/swim trunks/swimwear, or in any revealing state — even in pool, boat, or beach scenes (in those, dress them in linen, resortwear, or a cover-up over clothing). Keep it modest and realistic.`;

// Framing distance — a close-up face filling the frame is one of the strongest AI
// tells; real lifestyle photos are shot from a few steps back so you see the PLACE.
const FRAMING = `FRAMING & DISTANCE (critical for realism): shoot the user from a NATURAL DISTANCE — a medium-to-wide candid photo where they occupy only about a third to a half of the frame and the SETTING is clearly visible around and behind them. Their FACE must NOT be close to the camera and must NOT fill the frame — absolutely no tight selfie or head-and-shoulders portrait crop. Frame it like a friend a few steps away taking a full-body or half-body travel photo, so the person AND the place both read. A face too close to the camera instantly looks AI-generated — keep the distance.`;

// Face-realism — the specific tells that make an AI PERSON read as fake even at
// SOTA (from forensic research). Complements FACE_FIDELITY (identity + skin texture).
const FACE_REALISM = `FACE REALISM — kill the AI-person tells (obey all):
- EYES: natural moisture and a SOFT single catchlight that is IDENTICAL in BOTH eyes and matches the scene's light direction; gaze slightly soft and often off-camera. NEVER glassy, doll-like, dead, or hyper-focused razor-sharp irises.
- ASYMMETRY: a real, ordinary, NON-symmetric face — features not averaged into "influencer" perfection; allow a slightly uneven eye, a natural nose, distinctive imperfections. Perfect symmetry and model-beauty read as AI.
- SKIN under this light: visible pores, peach-fuzz, minor blemishes/redness, uneven tone, under-eye texture, a little T-zone shine — never airbrushed, poreless, or glowing.
- TEETH: natural, slightly uneven, not brilliant-white or a perfect grin.
- HAIR: individual flyaway strands and a slightly messy, natural hairline that does NOT melt into the skin.
- FACE LIGHT: directional — one side of the face a little brighter, soft shadow under the nose/chin. Never flat, even, everywhere-flattering studio light on the face.
- EXPRESSION: candid, caught mid-moment, a neutral or asymmetric micro-expression — never a posed, straight-to-camera "trustworthy" smile (the uncanny tell).
- HANDS if visible: correct five fingers, relaxed and natural — or kept partly out of frame.`;

// Curated, fully-clothed outfit vocabulary per style pack (analyzed from the
// aspirational references, swimwear/shirtless excluded). Used to auto-dress the
// subject when the user names a scene but no outfit. The model sees the person and
// picks a gender-appropriate option.
// Two go-to fits (founder's recommendation), with colors chosen by the location,
// plus the analyzed women's options. FIT 1 = a well-fitted linen button-down
// (long- OR short-sleeve) in a location-appropriate color with linen trousers.
// FIT 2 = a tight, good-fitting plain tee with good pants. NEVER swimwear/shirtless.
const PACK_WARDROBE: Record<string, string> = {
  "beach-club":
    "IMPORTANT — fully-clothed RESORTWEAR only, NEVER swimwear even at the beach. PREFERRED for a man — FIT 1: an open-but-buttoned or short-sleeve linen shirt in white, cream, blue or a soft stripe with linen shorts or trousers, leather sandals and sunglasses; OR FIT 2: a fitted plain tee or polo in white or navy with tailored linen shorts. For a woman: a breezy sundress, a linen shirt-dress, or a linen co-ord / cover-up worn over the outfit, with sunglasses and a straw hat — chic beach-club resortwear, always modestly and fully clothed",
  "luxury-cars":
    "PREFERRED for a man — FIT 1: a well-fitted linen or fine-cotton button-down (long- or short-sleeve) in white, black, navy or stone with tailored trousers and clean minimal sneakers or loafers; OR FIT 2: a tight, good-fitting plain tee in white, black or grey with sharp tailored trousers or dark jeans; a fitted polo or a light bomber jacket also works — sharp smart-casual with a good watch and sunglasses. For a woman: a fitted top with tailored trousers, a sleek co-ord, or a chic dress — refined, never flashy. Always fully clothed",
  "old-money":
    "PREFERRED for a man — the signature Monaco look: a pale-blue or white linen shirt (or a fitted polo) worn with WHITE or cream wide-leg pleated linen trousers and leather loafers, plus a good watch and sunglasses; grey tailored trousers with a blue polo also works by day. For NIGHT: a black silky shirt with white pleated trousers (elegant, cinematic). Otherwise FIT 1: a well-fitted linen/fine-cotton button-down in white, cream, pale blue or navy with tailored trousers; or a navy blazer over a white shirt. For a woman: a tailored white shirt with cream wide-leg trousers, an elegant linen co-ord, or a refined summer dress with delicate gold jewelry — understated old-money elegance",
  "euro-summer":
    "PREFERRED for a man — FIT 1: a well-fitted linen button-down (long- or short-sleeve) in beige, white, cream or olive, worn with matching linen trousers and leather sandals or clean minimal sneakers; OR FIT 2: a tight, good-fitting plain tee in a warm neutral (white/beige/olive) with well-fitted tailored trousers or clean stone chinos. For a woman: a white halter or ribbed linen top with white wide-leg linen trousers or a cream silky maxi skirt, or an oversized white linen shirt with tailored white shorts and a slim brown belt — gold jewelry, a small leather bag, sunglasses",
  "dubai":
    "PREFERRED for a man — FIT 1: a crisp well-fitted linen button-down (long- or short-sleeve) in white, beige, light blue or navy, with matching linen or tailored trousers and a good watch; OR FIT 2: a tight, good-fitting plain tee in white, beige or navy with sharp tailored trousers. For a woman: a flowing cream/white maxi dress, a linen co-ord (fitted top and wide-leg trousers), or a chic white shirt with tailored trousers — elegant resort luxury",
  "boat":
    "PREFERRED for a man — FIT 1: a well-fitted linen button-down (long- or short-sleeve) in white, light blue or navy, with white or stone linen trousers and sunglasses; OR FIT 2: a tight, good-fitting plain tee in white or navy with tailored linen trousers. For a woman: a white or striped linen shirt with tailored trousers, or a breezy cream sundress — FULLY-CLOTHED boat-day resortwear (never swimwear)",
  "dark-luxe":
    "PREFERRED for a man — FIT 1: a well-fitted linen or fine button-down in navy, black or charcoal with dark tailored trousers; OR FIT 2: a tight, good-fitting plain tee in black, navy or charcoal with dark tailored trousers; a navy/charcoal suit with an open collar and no tie also works. For a woman: an elegant black slip dress, a silk co-ord, or a white shirt with black tailored trousers — quiet, expensive eveningwear",
  "after-dark":
    "PREFERRED for a man — FIT 1: a well-fitted button-down in black or navy with dark trousers; OR FIT 2: a tight, good-fitting plain tee in black or navy with dark tailored trousers, optionally a matte black overshirt on top. For a woman: a sleek black slip dress, or a fitted top with tailored trousers — sharp, understated night-out",
};

const IDENTITY_BLOCK = `The attached photo(s) at the START are all the SAME person — the user. Study them together to lock their exact facial identity, then render that same person in the scene with their skin tone, hair, and build preserved — recognizably them, naturally integrated into the scene's lighting and perspective. Do not beautify, restyle, or alter their face or body.`;

// The single most important block for "don't make me look AI". Appended whenever a
// real person is in the output. Stops the model from beautifying/airbrushing the
// face — the #1 cause of the synthetic look.
const FACE_FIDELITY = `FACE FIDELITY — THE SINGLE MOST IMPORTANT REQUIREMENT. The face in the output must be the EXACT face from the user's attached reference photo(s) — not a lookalike, not an "improved" version:
- Copy their real facial geometry precisely: eye shape and spacing, nose, mouth, lips, jawline, cheekbones, brow, hairline, ears, and every mole, freckle, scar, facial hair and natural asymmetry.
- KEEP REAL SKIN: visible pores, fine lines, natural texture, subtle blemishes, uneven tone, stubble, under-eye shadows. Do NOT smooth, airbrush, slim, whiten, de-age, or beautify. Apply NO beauty filter.
- Match their real skin tone and complexion exactly, including any redness or unevenness.
- Expression and gaze stay natural and candid — never posed-perfect or model-like.
BANNED AI TELLS (these ruin it): waxy / plastic / porcelain / rubbery skin, over-smoothed or blurred skin, doll-like or glassy eyes, perfectly symmetric face, airbrushed "influencer" look, mannequin sheen, over-sharpened HDR, teeth too white or too even, or any face that looks prettier or different than the real photo.`;

// When the caller wants to recreate a specific reference photo AS themselves
// ("put me in this exact shot" / face-swap): reproduce the reference composition
// but the subject is the user. The FIRST attached image is the user's face; the
// LAST attached image is the reference to match.
// Pack environment conditioning: the LAST attached image is a REAL photo of the
// place. Recreate that environment ~90% and place the user into it — this is the
// core anti-AI mechanism (a real scene anchors everything the prompt can't).
const ENVIRONMENT_MATCH_BLOCK = `ENVIRONMENT REFERENCE — the LAST attached image is a REAL photograph of the exact kind of place this photo is taken. RECREATE THAT ENVIRONMENT AT ROUGHLY 90% FIDELITY: the same location and layout, the same perspective and depth, the same light direction and time of day, the same palette, materials and texture — as if this new photo were taken standing in the same spot a few minutes later. You may vary small details (exact crop, incidental people far in the background, minor weather) but NEVER swap to a different-looking place. If a person appears in the reference, IGNORE their identity completely — the person in the output is ONLY the user from the identity photo(s), placed naturally into that environment; their stance may echo the reference person's if it fits the requested pose. Match the reference's CAPTURE QUALITY too — its real phone-photo light, contrast, and imperfection are the quality target.`;
const ENVIRONMENT_MATCH_BG_BLOCK = `ENVIRONMENT REFERENCE — the LAST attached image is a REAL photograph of the place. RECREATE THAT ENVIRONMENT AT ROUGHLY 90% FIDELITY as an EMPTY scene: same location, layout, perspective, light, palette and texture, with NO people in it. Remove any people present in the reference. Match its real phone-photo capture quality.`;

const MATCH_REFERENCE_BLOCK = `RECREATE THE ATTACHED REFERENCE PHOTO, but the person in it is the user from the first attached image. Match the reference's composition, camera angle, framing, pose, distance, setting, lighting, color grade and overall mood as closely as possible — it should look like the same photograph, simply taken of the user instead. Keep the user's exact face and identity (this is a face/identity swap, not a lookalike). Preserve realistic body proportions consistent with the user.`;

// Aesthetic-background mode: no person at all — just the place/scene.
const BACKGROUND_BLOCK = `Generate an ATMOSPHERIC SCENE with NO people in it — an empty, aspirational location photograph (an "aesthetic background"). No human figures, no faces, no silhouettes of people. Focus entirely on the environment, light, and mood.`;

const NEGATIVE = "No watermark-style text, no captions, no borders.";

// Named style packs mirror the canonical client definitions (gems-canvas.js).
const STYLE_PACKS: Record<string, string> = {
  "after-dark":
    "STYLE — After Dark (moody luxury, low-exposure): dusk-like underexposure even in daylight; steel-blue/navy skies with retained detail, never blown; deep clean blacks, muted color (~-25% saturation), greens toward dark emerald and blues toward navy, protected skin tones; slightly cool temperature; no added grain, subtle vignette at most. Quiet, expensive, cinematic.",
  "dark-luxe":
    "STYLE — Dark Luxe (quiet-wealth, cinematic): the aesthetic of a high-floor luxury penthouse and moody five-star resort. SETTINGS (pick what fits the request): a modern penthouse with floor-to-ceiling glass over a hazy city skyline (Dubai/Gulf-tower energy — distant towers, warm dusk or bright daytime haze); a dim, expensively-furnished suite with a single warm lamp glowing against a blue-hour cityscape; a dark infinity or resort pool at dusk framed by deep-green tropical foliage and teak decking; a palm-lined boulevard shot from a car; marble, brushed metal, boucle and cream upholstery, a laptop and espresso on a low table. LIGHT: low-key and directional — deep protected shadows, one believable warm source (lamp/window), cool blue ambient; underexposed rather than bright, highlights gently rolled off, never blown. COLOR: muted and desaturated (~-20%), greens pushed dark, blues toward steel/navy, warm accents only from practical lights, clean neutral blacks. MOOD: calm, solitary, aspirational — 'a quiet morning at the top of the world', shot candidly on a phone, never staged or glossy-HDR.",
  "dubai":
    "STYLE — Dubai Luxe (aspirational Gulf luxury): the look of Dubai's finest hotels and residences. SETTINGS (pick what fits the request): a rooftop INFINITY POOL on a high floor at blue-hour/sunset overlooking the Burj Khalifa and the lit Downtown skyline, with teak sun-loungers, cabanas and date palms, warm path-lights glowing along the pool; a marble-and-warm-wood penthouse living room with a floor-to-ceiling window framing the Burj Khalifa at dusk, warm cove lighting, a brass lantern and a low travertine coffee table; a chic BEACH CLUB with rows of striped umbrellas and day-beds on raked sand, palms and red bougainvillea, calm Gulf water; a golden-hour rooftop TERRACE with a low modern cream sofa, lanterns and a folded throw, overlooking Dubai Marina and the sea; the Burj Al Arab or Madinat Jumeirah waterways framed by date palms and Arabesque lamps; Atlantis The Palm glowing across still water at dusk; the Dubai Fountain boardwalk and curved Address-hotel terraces lit warm at night. LIGHT: warm sunset / blue-hour with a peach-to-navy gradient sky, glowing city lights and warm practical lamps; or bright hazy Gulf daylight. COLOR: warm gold + teal water + navy dusk — rich but CONTROLLED, never garish or candy-HDR. MOOD: serene, expensive, aspirational — quiet wealth with a skyline.",
  "boat":
    "STYLE — On the Water (boat day): a candid summer boat-day photograph, film-like and effortless. SETTING: a small motorboat or day-yacht on clear turquoise/teal Mediterranean or lake water — teak deck, a bimini top, chrome grab-rails, cream upholstery; a Greek/Italian coastline, a whitewashed hillside village or a pine-covered shore in the background, a bright wake trailing behind at speed. SUBJECT (the user): FULLY CLOTHED in relaxed resortwear (linen shirt and linen trousers or tailored shorts, or a breezy sundress) — driving the boat shot from behind over the shoulder, sitting on the bow looking out at the coast, leaning forearms on the gunwale, or seated on the deck taking in the view. Never shirtless, never in swimwear. FRAMING mid or wide, candid, never a posed studio shot. LIGHT: bright hard midday sun, sparkling water, strong natural contrast and real sun flare; or warm late-afternoon gold. LOOK: shot on a phone / 35mm — natural skin with real sheen, gentle grain, salt-and-sun realism, never glossy or airbrushed.",
  "beach-club":
    "STYLE — Beach Club (chic Mediterranean / Gulf beach club): a bright, upscale beach-club day. SETTINGS (pick what fits the request): rows of striped umbrellas and teak day-beds on raked white sand, cream-and-blue parasols, cabanas and a wooden boardwalk, calm turquoise water and moored boats beyond; a beachfront pool bar with rattan stools and a cocktail on a side table; a shaded cabana with billowing white curtains and cushions; palms and bougainvillea framing the sand. LIGHT: bright hot midday Mediterranean/Gulf sun, high-key and sparkling on the water, strong natural contrast with sea-reflected fill and real sun flare; or warm late-afternoon gold. COLOR: crisp white + turquoise water + warm sand + the parasols' stripes — sunny but controlled, never candy-HDR. MOOD: relaxed, moneyed, sun-soaked.",
  "luxury-cars":
    "STYLE — Luxury Cars (supercar flex, tasteful): a candid photo with a high-end car as the hero. SETTINGS (pick what fits the request): a gleaming supercar — a red or yellow Ferrari, a Lamborghini, a matte-black or silver Porsche 911, or a classic Rolls-Royce / vintage convertible — parked at the valet forecourt of a grand Belle-Époque hotel, on a cobbled European street, at a marina beside white yachts, in a clean minimalist private garage/showroom, or on a coastal mountain road; the subject standing beside or leaning on the car, or seated in the driver's seat with a hand on the wheel. LIGHT: for DAY, bright clean sun with crisp reflections and highlights sliding along the car's paint and chrome, deep-blue sky, hard clean shadows; for NIGHT, warm street/garage lights and neon glinting off the bodywork against a dark surround, wet-look reflections. COLOR: sleek and controlled — muted elegant surroundings with the car's bold paint (red / yellow / silver / black) as the one strong accent; deep clean blacks, real metallic reflections. MOOD: effortless wealth, quietly confident, never gaudy.",
  "old-money":
    "STYLE — Old Money (Riviera / Monaco quiet wealth): the real aesthetic of Monaco and the Côte d'Azur old-money elite. SETTINGS (pick what fits the request): the Place du Casino outside the Belle-Époque Casino de Monte-Carlo with a row of parked supercars (a red Ferrari, a classic car) and the Hôtel de Paris, warm-lit and grand; the Monaco Grand-Prix hairpin by the Fairmont with its red-and-white kerbs and a Ferrari mid-corner; a cobbled Belle-Époque street of cream and pastel-yellow facades with ornate wrought-iron balconies, red-and-white Monaco flags, palms and the grey Tête-de-Chien cliff behind; the Fontvieille harbour seen from above — rows of white yachts on deep teal water ringed by terracotta apartment blocks and a green headland; a luxury-boutique frontage (Tiffany, Ferragamo, Graff) with a Rolls-Royce and a Porsche parked outside; a classic cream Rolls-Royce or vintage convertible parked at the Casino at night; the Casino exotic-garden terraces with palms and cascading stone staircases; a hillside villa balustrade or an iron gate framing the harbour and green mountains. LIGHT: for DAY, bright hazy Mediterranean sun, warm and clear, deep-blue sky, soft haze on the distant headland (atmospheric perspective), hard clean shadows; for NIGHT, warm glowing Belle-Époque facade lights and lanterns against a deep blue-hour sky, reflections on car paint. COLOR: warm cream stone + terracotta + deep-green foliage + Mediterranean teal sea, plus the odd bold supercar red/yellow — muted and elegant overall, never candy-HDR. MOOD: effortless, moneyed, unhurried.",
  "euro-summer":
    "STYLE — Euro Summer (men): a warm, film-like European summer travel photograph. WARDROBE: a relaxed linen button-down shirt (white, cream, olive, or terracotta/rust), loose tailored trousers or chinos in cream/stone/olive/grey, leather sandals or espadrilles, optionally a canvas tote and a simple watch — effortless old-money Mediterranean menswear, never flashy, no big logos. SETTING (draw from these real Mediterranean scenes, pick what fits): an Amalfi/Positano cliffside town tumbling to a turquoise sea at golden hour with warm window-lights and cascading bougainvillea; the colorful stacked houses of Cinque Terre / Portofino / Manarola perched over clear teal water; a lemon-draped café terrace (Capri/Amalfi) with wrought-iron bistro tables, majolica-tiled tabletops and iron lanterns; a narrow cobblestone alley of ochre, coral and butter-yellow buildings with green and teal shutters, geraniums in terracotta pots, and laundry strung overhead; a French-Riviera cove with cypress trees, honey-stone houses and moored wooden boats. Recurring notes: magenta bougainvillea, wisteria, lemon trees, marble café tables, worn stone stairs, whitewashed walls and terracotta roofs. LIGHT: warm golden-hour or bright Mediterranean midday with long soft shadows and clear teal water. LOOK: shot on 35mm film (Kodak Portra warmth, gentle grain, soft highlight rolloff) — warm and analog, NEVER the oversaturated candy-HDR Pinterest look. Candid and relaxed — walking, leaning, mid-stride, glancing off-camera — an editorial travel snapshot, never a stiff studio pose.",
};

// Light refusal guard: never generate a specific real person other than the user,
// or an explicitly-requested brand logo. (Incidental logos are allowed.)
const REFUSE_RE =
  /\b(logo of|brand logo|the [a-z]+ logo|nike swoosh|as (a )?celebrity|deepfake|(taylor swift|lebron|kardashian|elon musk|trump|biden|drake|beyonce|messi|ronaldo))\b/i;

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

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function bytesToBase64(bytes: Uint8Array): Promise<string> {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

const ASPECTS = new Set(["4:5", "1:1", "9:16"]);

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (request.method !== "POST") return json(405, { error: "POST only" });
  if (!GEMINI_API_KEY) return json(503, { error: "GEMINI_API_KEY is not configured" });

  const userId = userIdFromAuth(request.headers.get("authorization"));
  if (!userId) return json(401, { error: "no user" });

  let body: {
    prompt?: string;
    referenceAssetIds?: string[];
    stylePackId?: string;
    subjectBase64?: string;
    subjectImages?: string[]; // extra identity reference photos of the SAME user
    aspect?: string;
    quality?: string;
    mode?: string;          // "me" (default) | "background"
    matchReference?: boolean; // recreate the reference photo AS the user (face swap)
    environmentRef?: number;  // which pack environment reference to recreate (index into the library)
    wardrobe?: string;      // optional: change the user's outfit
    pose?: string;          // optional: how the user is posed / what they're doing
    build?: string;         // optional: real body type (e.g. "5'10, 150lbs, slim")
    requestId?: string;     // one id per batch — a "prompt" = one request (free tier)
  };
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid JSON body" });
  }
  const prompt = String(body.prompt ?? "").trim();
  if (!prompt) return json(400, { error: "prompt required" });
  if (prompt.length > 800) return json(400, { error: "prompt too long (800 max)" });
  if (REFUSE_RE.test(prompt)) {
    return json(200, {
      refused: true,
      reply:
        "I can't generate a specific real person or a brand logo. Try describing the scene and vibe — I'll put you in it if you add your own photo.",
    });
  }
  const aspect = ASPECTS.has(body.aspect ?? "") ? (body.aspect as string) : "4:5";
  const mode = body.mode === "background" ? "background" : "me";
  const matchReference = body.mode !== "background" && body.matchReference === true;
  // Identity images = the primary subject photo plus any extra reference photos
  // of the SAME user (from their tagged face cluster). More angles → far stronger
  // identity fidelity than a single selfie.
  const identityImages =
    mode === "background"
      ? []
      : [
          ...(typeof body.subjectBase64 === "string" && body.subjectBase64 ? [body.subjectBase64] : []),
          ...(Array.isArray(body.subjectImages) ? body.subjectImages.filter((s) => typeof s === "string" && s) : []),
        ].slice(0, 5);
  const hasSubjectInput = identityImages.length > 0;
  // Anything with a REAL PERSON in it uses Pro — flash models beautify faces into
  // the AI look, and identity/skin fidelity is the whole point here. Empty
  // aesthetic backgrounds (no face to get wrong) stay on the cheaper standard model.
  const quality = matchReference || hasSubjectInput || body.quality === "pro" ? "pro" : "standard";
  const model = quality === "pro" ? PRO_MODEL : STANDARD_MODEL;
  const units = quality === "pro" ? 3 : 1;
  const refIds = Array.isArray(body.referenceAssetIds)
    ? body.referenceAssetIds.slice(0, MAX_REFS)
    : [];

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Free-tier reservation state, hoisted so the outer catch can release it too.
  let reservationId: string | null = null;
  const releaseSlot = async () => {
    if (!reservationId) return;
    const id = reservationId;
    reservationId = null;
    try { await supabase.from("taste_events").delete().eq("id", id); }
    catch (e) { console.error("reservation release failed", e); }
  };

  try {
    const requestId = String(body.requestId ?? "").slice(0, 64);
    // ---- Free-tier meter, now ATOMIC (fixes the TOCTOU race). One RPC does the
    // cap CHECK and the RESERVATION together under a per-profile advisory lock,
    // so two concurrent requests with the same fresh requestId can no longer both
    // slip under the cap. The reserved row IS the meter event: it is finalized on
    // success or released (deleted) on any failure below, so a failed generation
    // never consumes the free request. Fails OPEN on an infra hiccup.
    try {
      const { data: slot } = await supabase.rpc("reserve_free_scene_slot", {
        p_profile_id: userId,
        p_request_id: requestId,
        p_max_images: MAX_FREE_IMAGES,
      });
      if (slot && slot.allow === false) {
        return json(402, { error: slot.reason ?? "free_prompt_used", paywall: true, cap: MAX_FREE_IMAGES });
      }
      reservationId = slot && typeof slot.reservation_id === "string" ? slot.reservation_id : null;
    } catch (error) {
      console.error("scene reservation failed (allowing)", error);
    }

    // ---- Assemble the model parts: subject first (me-in-scene), then refs,
    // then the text prompt (references BEFORE text per the spec).
    const parts: Array<Record<string, unknown>> = [];
    // Background mode is an empty scene — ignore any subject photo entirely.
    const hasSubject = identityImages.length > 0;
    for (const img of identityImages) {
      parts.push({ inline_data: { mime_type: "image/jpeg", data: img } });
    }
    if (refIds.length) {
      // Only the caller's own inspiration assets, downloaded from the private bucket.
      const { data: assets } = await supabase
        .from("inspiration_assets")
        .select("id, storage_path")
        .eq("profile_id", userId)
        .in("id", refIds);
      for (const asset of assets ?? []) {
        try {
          const { data: file } = await supabase.storage.from("inspiration").download(asset.storage_path);
          if (!file) continue;
          const b64 = await bytesToBase64(new Uint8Array(await file.arrayBuffer()));
          parts.push({ inline_data: { mime_type: file.type || "image/jpeg", data: b64 } });
        } catch (error) {
          console.info("ref download skipped", asset.id, error);
        }
      }
    }

    // ---- Pack ENVIRONMENT reference: pick ONE real photo from the pack's
    // library to recreate ~90% (attached LAST, below). Skipped when the user
    // supplied their own inspiration refs or asked for an exact match — their
    // reference wins. Fails OPEN — packs without a library just skip this.
    let envRefB64: string | null = null;
    let envRefMime = "image/jpeg";
    let envRefName: string | null = null;
    if (PACK_REFS_ENABLED && !matchReference && !refIds.length && body.stylePackId) {
      try {
        const prefix = `${PACK_REFS_PREFIX}/${body.stylePackId}`;
        const { data: files } = await supabase.storage
          .from("inspiration").list(prefix, { limit: 1000, sortBy: { column: "name", order: "asc" } });
        const imgs = (files ?? [])
          // Environment refs must be REAL photos — files marked RENDER are AI
          // renders kept only for composition study, never pixel conditioning.
          .filter((f) => f.name && /\.(jpe?g|png|webp)$/i.test(f.name) && !/render/i.test(f.name))
          .sort((a, b) => a.name.localeCompare(b.name));
        if (imgs.length) {
          const idx = Number.isFinite(body.environmentRef)
            ? Math.abs(Math.trunc(body.environmentRef as number)) % imgs.length
            : Math.floor(Math.random() * imgs.length);
          const pick = imgs[idx];
          const { data: file } = await supabase.storage
            .from("inspiration").download(`${prefix}/${pick.name}`);
          if (file) {
            envRefB64 = await bytesToBase64(new Uint8Array(await file.arrayBuffer()));
            envRefMime = file.type || "image/jpeg";
            envRefName = pick.name;
          }
        }
      } catch (error) {
        console.info("pack environment ref unavailable", error);
      }
    }

    // ---- Global realism references (quality-only conditioning). Attached AFTER
    // identity + inspiration refs so they are the FINAL images the model sees.
    // Skipped for match-reference mode (its last image must stay the photo being
    // recreated) and when a pack environment ref is attached (that real photo is
    // already the pixel anchor for both scene and capture quality), and capped
    // to 1 when a subject is present (so identity isn't diluted). Fails OPEN —
    // realism refs are an enhancement, never a hard dep.
    let realismRefCount = 0;
    if (REALISM_REFS_ENABLED && !matchReference && !envRefB64) {
      try {
        const wanted = Math.max(0, Math.min(REALISM_REF_COUNT, hasSubject ? 2 : 3));
        if (wanted > 0) {
          const { data: files } = await supabase.storage
            .from("inspiration").list(REALISM_REFS_PREFIX, { limit: 100 });
          const imgs = (files ?? []).filter((f) => f.name && /\.(jpe?g|png|webp)$/i.test(f.name));
          // Shuffle so repeated generations rotate through the set.
          for (let i = imgs.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [imgs[i], imgs[j]] = [imgs[j], imgs[i]];
          }
          for (const f of imgs.slice(0, wanted)) {
            try {
              const { data: file } = await supabase.storage
                .from("inspiration").download(`${REALISM_REFS_PREFIX}/${f.name}`);
              if (!file) continue;
              const b64 = await bytesToBase64(new Uint8Array(await file.arrayBuffer()));
              parts.push({ inline_data: { mime_type: file.type || "image/jpeg", data: b64 } });
              realismRefCount++;
            } catch (error) {
              console.info("realism ref skipped", f.name, error);
            }
          }
        }
      } catch (error) {
        console.info("realism refs unavailable", error);
      }
    }
    // Attach the environment reference LAST so "the LAST attached image" in its
    // prompt block is unambiguous.
    if (envRefB64) {
      parts.push({ inline_data: { mime_type: envRefMime, data: envRefB64 } });
    }
    const envRefBlock = envRefB64
      ? `\n\n${mode === "background" ? ENVIRONMENT_MATCH_BG_BLOCK : ENVIRONMENT_MATCH_BLOCK}`
      : "";
    const realismRefBlock =
      realismRefCount > 0
        ? `\n\nPHOTOGRAPHIC-QUALITY REFERENCES: the FINAL ${realismRefCount} attached photo(s) are REAL amateur iPhone snapshots, included ONLY as the target for PHOTOGRAPHIC QUALITY and REALISM. Study their imperfect exposure, grain and sensor noise, haze, harsh or dim natural light, muted color, and casual amateur feel, and make THIS image look like it was captured the same way — same real, slightly-worse phone-photo quality. Do NOT copy their people, faces, clothing, locations, objects, text, or composition; they are quality/texture references only. The subject and scene come solely from the instructions above.`
        : "";

    const styleBlock = body.stylePackId && STYLE_PACKS[body.stylePackId]
      ? `\n\n${STYLE_PACKS[body.stylePackId]}`
      : "";
    const wardrobe = String(body.wardrobe ?? "").trim().slice(0, 200);
    const wardrobeBlock =
      hasSubject && wardrobe
        ? `\n\nWARDROBE: dress the user in ${wardrobe}. This replaces whatever they are wearing in the reference photo — restyle the clothing to match, but keep their exact face, body, and identity unchanged.`
        : "";
    // Auto-wardrobe: when the user names a scene but no outfit, dress them in a
    // tasteful, fully-clothed, on-theme outfit from the analyzed pack vocabulary —
    // the model sees the person and picks a gender-appropriate option.
    const packWardrobe = body.stylePackId ? PACK_WARDROBE[body.stylePackId] : undefined;
    const autoWardrobeBlock =
      hasSubject && !wardrobe
        ? `\n\nWARDROBE (choose one that suits the subject): dress the user in a tasteful, fully-clothed, on-theme outfit${packWardrobe ? ` — ${packWardrobe}` : " appropriate to the setting"}. Pick the option that best fits the person you see; keep their face and identity unchanged.`
        : "";
    // Body-type honesty: AI loves to make people taller, broader and more
    // chiselled than they are. Keep the user's REAL frame from their photos, and
    // apply any stated build. Appended for all person shots.
    const build = String(body.build ?? "").trim().slice(0, 120);
    const buildBlock =
      hasSubject
        ? `\n\nBODY TYPE (keep it honest): render the user's REAL body type and proportions exactly as in their reference photos${build ? ` (${build})` : ""}. Do NOT make them more muscular, taller, broader, leaner, or more chiselled than they are, and do NOT exaggerate their facial structure or jawline. Their true frame and natural build — never an idealized or "gym-bro" version.`
        : "";
    const pose = String(body.pose ?? "").trim().slice(0, 200);
    const poseBlock =
      hasSubject && pose
        ? `\n\nPOSE & ACTION: the user is ${pose}. Make it look candid and natural — caught mid-moment, not stiffly posed for the camera.`
        : "";
    // Non-negotiable candid pose when none was chosen — the "between-takes" look
    // that reads as a real photo, never a stiff straight-on smile.
    const candidDefaultBlock =
      hasSubject && !pose
        ? `\n\nPOSE (candid, NON-NEGOTIABLE — never a stiff straight-on smile to camera): put them in a real between-takes moment — looking down at their phone, glancing off to the side, adjusting a watch or shirt cuff, a hand in a pocket, mid-stride walking, or looking out at the view. Relaxed, weight on one leg, unposed and natural.`
        : "";
    // Identity handling: face-swap-a-reference > put-me-in-scene > empty scene.
    const identityBlock =
      mode === "background"
        ? `\n\n${BACKGROUND_BLOCK}`
        : matchReference && refIds.length
          ? `\n\n${MATCH_REFERENCE_BLOCK}`
          : hasSubject
            ? `\n\n${IDENTITY_BLOCK}`
            : "";
    const promptText =
      `SCENE REQUEST: ${prompt}` +
      styleBlock +
      `\n\n${REALISM_LAYER}` +
      realismRefBlock +
      envRefBlock +
      identityBlock +
      (hasSubject ? `\n\n${FACE_FIDELITY}` : "") +
      (hasSubject ? `\n\n${FACE_REALISM}` : "") +
      (hasSubject ? `\n\n${MODESTY}` : "") +
      (hasSubject ? `\n\n${FRAMING}` : "") +
      buildBlock +
      wardrobeBlock +
      autoWardrobeBlock +
      poseBlock +
      candidDefaultBlock +
      `\n\nRender as a ${aspect} vertical-friendly aspect ratio. ${NEGATIVE}`;
    parts.push({ text: promptText });

    // ---- Generate.
    const modelResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts }] }),
      },
    );
    if (modelResponse.status === 429) {
      await releaseSlot();
      return json(503, { error: "image_model_quota", detail: "quota exceeded — billing may need enabling on the Google AI key." });
    }
    if (!modelResponse.ok) {
      await releaseSlot();
      const detail = await modelResponse.text();
      return json(502, { error: "image_model_failed", detail: detail.slice(0, 300) });
    }
    const modelData = await modelResponse.json();
    const responseParts: Array<{ inlineData?: { mimeType?: string; data?: string } }> =
      modelData?.candidates?.[0]?.content?.parts ?? [];
    const imagePart = responseParts.find((part) => part.inlineData?.data);
    if (!imagePart?.inlineData?.data) { await releaseSlot(); return json(502, { error: "image_model_returned_no_image" }); }

    // ---- Store (edits bucket, owner-scoped path) + sign. Preserve returned bytes
    // (incl. any embedded provenance) — no re-encode.
    const outMime = imagePart.inlineData.mimeType || "image/png";
    const ext = outMime.includes("jpeg") ? "jpg" : outMime.includes("webp") ? "webp" : "png";
    const storagePath = `${userId}/scene/${crypto.randomUUID()}.${ext}`;
    const bytes = base64ToBytes(imagePart.inlineData.data);
    const { error: uploadError } = await supabase.storage.from("edits").upload(storagePath, bytes, { contentType: outMime });
    if (uploadError) { await releaseSlot(); return json(502, { error: "storage_upload_failed", detail: uploadError.message }); }
    const { data: signed, error: signError } = await supabase.storage.from("edits").createSignedUrl(storagePath, SIGNED_URL_SECONDS);
    if (signError || !signed?.signedUrl) { await releaseSlot(); return json(502, { error: "sign_failed", detail: signError?.message }); }

    // ---- Provenance: a projects row of kind 'scene', ai_generated flagged.
    const { data: project } = await supabase
      .from("projects")
      .insert({
        profile_id: userId,
        kind: "scene",
        name: prompt.slice(0, 60),
        status: "ready",
        meta: {
          ai_generated: true,
          model_ref: model,
          storage_path: storagePath,
          prompt: prompt.slice(0, 400),
          aspect,
          quality,
          refs: refIds.length,
          style_pack: body.stylePackId ?? null,
          me_in_scene: hasSubject,
          mode,
          match_reference: matchReference,
          pose: pose || null,
          wardrobe: wardrobe || null,
          build: build || null,
          realism_refs: realismRefCount,
          environment_ref: envRefName,
        },
      })
      .select("id")
      .maybeSingle();

    // ---- Meter: finalize the reservation with the full subject (free tier), or
    // insert a fresh meter row (plus tier, which reserves nothing). Exactly one
    // metering row per completed generation, either way.
    const meterSubject = { units, quality, refs: refIds.length, style_pack: body.stylePackId ?? null, model, request_id: requestId || null };
    if (reservationId) {
      const id = reservationId;
      reservationId = null; // finalized — do NOT release in the catch
      await supabase.from("taste_events").update({ subject: meterSubject }).eq("id", id);
    } else {
      await supabase.from("taste_events").insert({
        profile_id: userId,
        event_type: "scene_generated",
        subject: meterSubject,
      });
    }

    return json(200, {
      url: signed.signedUrl,
      projectId: project?.id ?? null,
      storagePath,
      model,
      aspect,
      quality,
      aiGenerated: true,
    });
  } catch (error) {
    console.error("generate-scene failed", error);
    await releaseSlot();
    return json(502, { error: String((error as Error).message ?? error) });
  }
});
