# Aspirational aesthetics — what makes each setting work, and its LIGHTING

Founder-supplied set (2026-08-25). The instruction: **understand what makes each
photo setting work, and why — especially the lighting** — so that when a user imports
a photo and says "edit this for me," Gems can find the CLOSEST aesthetic and grade
their photo to match it. This file is the source of truth for those recipes.

Two different jobs, kept separate on purpose:
- **authentic-real/** = CAPTURE QUALITY target (real phone imperfection: grain,
  underexposure, haze). Wired as the global realism reference set.
- **aspirational/** (this folder) = COMPOSITION + LIGHTING/GRADE target (the look people
  actually want). Feeds generation composition AND the "edit this to the nearest vibe"
  auto-grade. NOTE: 90–93 are AI-RENDERS (too-perfect) — use them for composition/mood
  ONLY, never in the realism-quality set (they'd teach the fake look).

---

## Cross-cutting: why these settings work (composition)
1. **Outfit ↔ environment tonal contrast.** White/cream/neutral outfits against warm
   stone, colorful walls, or blue sea. The clean outfit reads as a block against a
   textured/colorful ground, so the subject pops without any studio lighting.
2. **The setting is the flex, legible in one glance.** A converging Italian alley, a
   monument, a yacht wake, clear reef water, a famous bay full of yachts, a Rolex
   facade, a Monaco harbor. Instant "somewhere aspirational."
3. **Layered depth / framing devices.** Archways, alley one-point perspective, tunnels,
   foreground styling. Framing the shot THROUGH an arch or tunnel is a recurring power
   move — it signals a real place and leads the eye to the subject.
4. **Candid, turned-away poses.** Walking, leaning, over-the-shoulder, looking down,
   hand in hair/pocket. Weight on one leg (contrapposto), motion implied. Never a
   stiff straight-on smile.
5. **Environmental full-body framing**, not a tight portrait — the setting is half the
   subject, so the person usually occupies a third and the place gets the rest.
6. **A grounding prop / gesture.** Iced drink, sunglasses on chest, bag on shoulder,
   binoculars on a table. Small human lifestyle details.
7. **Restrained, coordinated palette** — 3–4 harmonious colors per frame.

---

## LIGHTING / GRADE recipes (the engine for auto-edit + generation)
Each recipe = the setting cues that identify it + the light + the color grade. For an
imported photo, "edit this for me" classifies to the nearest recipe and applies its
LIGHT + GRADE only (composition/subject unchanged).

### 1. euro-golden — Mediterranean village, golden hour  (refs 81)
- **Cues:** old stone/plaster walls, wooden shutters, cobblestones, bougainvillea, alley.
- **Light:** warm low golden-hour SIDE light; long soft shadows; dappled leaf-shadow on
  walls; sun rimming hair. Subject often in soft shade with warm bounce off stone.
- **Grade:** Kodak Portra warmth, gentle grain, lifted warm shadows, soft highlight
  rolloff, teal-and-tan, NOT oversaturated. Amber/honey midtones.

### 2. euro-midday — colorful Italian street, bright day  (refs 82, 88)
- **Cues:** yellow/ochre/coral buildings, narrow lane, converging perspective, arch/tunnel.
- **Light:** bright Mediterranean midday, but the tall buildings SHADE the lane, so the
  subject sits in soft even light while the background pops bright. Tunnel/arch = natural
  vignette that frames and brightens the exit.
- **Grade:** warm and clean, saturated-but-controlled ochre/yellow, clear blue sky slice,
  slight film warmth. Higher key than golden hour but still warm.

### 3. riviera-vista — elevated view over a bay/coast  (refs 85, and 90/91 mood)
- **Cues:** high vantage, vast sea, distant headland, yachts dotting the water, warm stone.
- **Light:** bright hazy daylight; strong sun on the foreground stone; the DISTANCE goes
  hazy and slightly cooler (atmospheric perspective) — this haze is the signature.
- **Grade:** warm foreground + cool hazy blue distance; slightly desaturated far field;
  elegant and muted, never punchy. Soft contrast.

### 4. boat-bright — on a yacht/boat, open sea, midday  (refs 83, 87)
- **Cues:** teak deck, chrome rails, bimini top, deep blue open water, wake, clear sky.
- **Light:** hard bright overhead midday sun; strong natural contrast; the SEA acts as a
  giant reflector filling shadows; real sun flare and sparkle on water.
- **Grade:** vivid but true blues (navy sea, azure sky), warm teak brown, clean whites;
  crisp, high-clarity, a little contrast. Sun-glitter kept.

### 5. clear-water — in/entering crystal water over reef  (refs 84)
- **Cues:** shot from above/behind, transparent teal-green water, rocks/reef visible,
  wet tanned skin, swim ladder.
- **Light:** high sun making the water GLOW aqua; caustic sun-dapple on the seabed; wet
  skin catches specular highlights.
- **Grade:** saturated teal-to-emerald water, warm protected skin, high-key bright,
  luminous. The water clarity is the whole image — push its glow, keep skin natural.

### 6. luxe-signifier — a wealth signifier object/place  (refs 89, and 90/91 cars)
- **Cues:** ornate architecture, a luxury sign/logo (Rolex, Galleria), a classic car,
  a grand facade. Often no person (b-roll) or the object is the hero.
- **Light:** warm interior/architectural glow; low angle for grandeur; soft directional
  daylight; hazy warm air on Riviera streets.
- **Grade:** warm gold, muted elegant, film-like low saturation, gentle contrast —
  "quiet wealth," never neon or HDR.

### 7. villa-lake — framed interior→lake vista  (refs 92, 93 — RENDERS, mood only)
- **Cues:** shot THROUGH a stone/modern arch, cream sofa + marble/wood table styled with
  flowers/books/binoculars, lake + yacht + green mountains + village beyond.
- **Light:** soft diffused daylight; bright lake beyond a shaded interior foreground
  (interior slightly darker → the view glows).
- **Grade:** warm creams + lush greens + lake blue; serene, rich but soft. (Composition
  reference for backgrounds; do NOT copy its over-perfect render quality.)

### 8. night-luxe — warm night / dim interior  (from authentic-real 77–79 + dark packs)
- **Cues:** string lights, tungsten lamps, lit facades, dim marble lobby.
- **Light:** warm practical lights + deep unlit shadow; subjects NOT hero-lit; real
  low-light noise; mixed white balance.
- **Grade:** warm amber highlights, crushed-but-noisy blacks, protected skin, muted.

---

## How the auto-edit uses this
`edit-photo` (auto-aesthetic mode): the model looks at the imported photo, matches it to
the nearest recipe by its setting cues, and applies THAT recipe's light + grade —
changing only lighting/color/mood, never the subject, framing, or content. If nothing
matches well, it falls back to a tasteful natural grade rather than forcing a look.
