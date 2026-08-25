# Realism research — Apple camera signature + AI tells (2026-08-25)

Two research streams, to encode into the generation realism prompt. The core finding:
**the iPhone computational pipeline explains the "real phone photo" look** — encode the
pipeline precisely and the output stops reading as AI.

---

## APPLE CAMERA SIGNATURE — replicate these (iPhone 14–17 era)

**Pipeline → pixels**
- Multi-frame fusion (~9 bracketed frames merged): clean, low-noise, "already-averaged"
  look; NO motion blur on static subjects, but faint ghosting/doubling on MOVING edges
  (hands, hair, leaves).
- Semantic segmentation: sky, skin, hair, foliage each exposed independently → a bright,
  clean face against a still-detailed bright sky (neither blown) — subtly "unreal," and
  the iPhone tell.
- Global local-tone-mapping: shadows lifted, highlights compressed toward mid-gray.

**Output look**
- Tone/DR: very wide DR, FLAT low-contrast "HDR" midtones; lifted OPEN shadows (few true
  blacks), soft highlight roll-off (no clipped white); milky, not punchy — the "washed
  out / everything visible" look critics hate = the tell.
- Color: slightly cool-accurate-to-warm WB; punchy-but-not-lurid saturation; over-
  saturated blue skies + vivid greens; skin rendered WARM and BRIGHTENED (faces lifted
  relative to scene).
- Noise: near-zero chroma noise; only a TRACE of fine, tight LUMINANCE noise in shadows
  and mid-dark skin — never large film grain; flat areas (skies, walls, cheeks) slightly
  "plasticky" from denoise.
- Sharpening: strong edge micro-contrast / local sharpening — the "etched / over-
  sharpened" look; crunchy high-frequency detail (hair, fabric, foliage, distant brick),
  faint bright halos along high-contrast edges, slightly "processed" skin-pore texture.
- Lens (main 1x): 24mm-equiv f/1.78, DEEP depth of field (fg + bg both sharp); mild
  corner softness + light vignetting; occasional green/magenta CA on backlit edges;
  distinctive multi-point lens flare + colored ghost blobs against point lights
  (streetlights, sun) — a strong iPhone tell.
- DoF: deep-focus by default (tiny sensor). Shallow blur ONLY in Portrait mode, and it's
  computational — uniform gaussian with edge errors around hair/glasses/gaps, sometimes a
  stray strand left sharp against a blurred field.

**Distance for people**: casual photo = main 24mm at ~1.5–3m, head-to-waist or full body,
NOT face-filling. Selfie = front cam ~25mm at ~30–50cm → mild distortion (nose/forehead
enlarged). Flattering portrait = 2x/5x tele at ~2–3m → undistorted. Default casual person
shot = 24mm, conversational distance, everything in focus.

Sources: DPReview iPhone 15 imaging; Lux/Halide "Process Zero" + 16 Pro review; MKBHD
post-processing critique (9to5Mac); Digital Trends; DXOMARK 16 Pro Max; Apple 16 Pro specs.

---

## AI TELLS TO KILL — images + people

**Why:** diffusion denoises toward the statistical AVERAGE (most-likely face/lighting);
the VAE drops high-frequency detail → over-smooth; RLHF pushes toward polished stock/
influencer bias. Every fix reintroduces variance the model wants to smooth away.

**Image**: over-smooth VAE mush (→ grain + micro-texture); hyper-saturation / HDR flatness
(→ muted, flat contrast); lighting/shadow inconsistency (→ single directional source, one
shadow direction); reflection & vanishing-point errors (→ avoid mirrors/water or make them
accurate); garbled text (→ no text/signage); material physics (→ gravity-plausible fabric).

**Face (most important)**: waxy/poreless/airbrushed skin — the #1 tell (→ visible pores,
peach-fuzz, T-zone shine, blemishes, redness, uneven tone, under-eye texture; BAN flawless/
smooth/glowing/poreless); glassy dead over-focused eyes (→ moisture, soft catchlight,
slightly unfocused, off-camera); **corneal-reflection mismatch** — both eyes must show the
SAME single catchlight matching the light; over-symmetry / averaged influencer beauty (→
asymmetric, ordinary, distinctive imperfections); teeth too even/white (→ natural uneven);
hair-boundary melting (→ flyaways, messy hairline); ears asymmetric-natural; flat everywhere-
face-light (→ directional, one side in shadow, shadow under nose/chin); too-posed straight-
to-camera "trustworthy uncanny" (→ candid mid-motion, asymmetric micro-expression).

**Body**: hands/fingers (#1 anatomy fail) → correct 5 fingers, relaxed, or partly out of
frame; natural proportions (no elongated necks/limbs).

**Composition**: too-perfect centered/symmetric (→ off-center, rule-of-thirds broken,
subject partially cropped); neck-up GAN crop (→ waist-up+ with environment); background
incoherence (→ cluttered ordinary real background).

**Global ban**: professional/DSLR/8k/ultra-detailed/masterpiece/cinematic/studio/HDR/
oversaturated/3D-render/CGI/bokeh-portrait/plastic-skin/symmetric-face/glassy-eyes/text/
watermark.

Sources: CHI 2025 diffusion-artifact taxonomy (arXiv 2502.11989); Hany Farid / Content
Authenticity Initiative face-forensics (eye alignment, lighting/reflection/vanishing-point,
corneal-reflection mismatch, neck-up framing); practitioner prompt guides.

---

## iPhone pipeline (deep systems report, founder-supplied 2026-08-25) — validation + borrows

Confirms and extends the Apple-signature spec already encoded. Its own key rule matches
ours: **encode OUTPUT descriptors, not process verbs** — a prompt can evoke the signature
(24mm framing, deep DoF, lifted-shadow/HDR-flat tone, warm protected skin, mild oversharpen,
low-light NR smoothness, synthetic bokeh w/ imperfect edges) but cannot run the physics
(multi-frame fusion, LiDAR/phase depth, per-pixel frequency-band selection, instance-accurate
segmentation). What the current REALISM_LAYER already captures: segmented exposure (sky+skin
exposed independently), flat lifted-shadow HDR, protected warm skin, over-sharpen halos,
deep DoF, trace luminance noise, 24mm distance.

New architectural borrows (not yet built — future levers, not prompt lines):
- **Semantic per-region grading** as the filter engine: segment sky/skin/hair/subject/bg,
  grade each differently, protect skin tone + an undertone axis. (Apple's biggest tell.)
- **Multi-variant generate → learned selection** as a "fusion/ranking" analog — we have batch
  generation; wiring the photo-ranker as the "best-of-N selector" is the next step.
- **Deferred-processing UX**: instant low-cost proxy, finish the heavy render in background.
- **"Process Zero" toggle**: an optional minimal-processing, natural-grain mode for authenticity.
Caveat from the report: only iPhone 7 / A13 / A16 have Apple-confirmed "ops per photo"
figures; don't cite a per-photo number for iPhone 16/17.
