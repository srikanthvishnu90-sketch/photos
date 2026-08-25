# Authentic-real calibration set (founder-supplied, 2026-08-25)

Six real iPhone photos the founder gave as the **realism target**. The point he made:
> "the quality does not look AI generated, the quality of the image if anything is
> honestly worse."

That is the whole insight. Real photos are TECHNICALLY WORSE than AI output —
underexposed, hazy, harsh-lit, noisy, uncomposed — and that is exactly why they read
as real. The model's instinct is to maximize quality; realism requires the opposite.
These are the concrete tells, per image, that drove the REALISM_LAYER rewrite in
`supabase/functions/generate-scene/index.ts`.

## 75 / 76 — Chicago lakefront, wide daytime grab-shot
- **Hazy atmospheric distance:** the skyline is LOW-contrast, desaturated, softened by
  haze — atmospheric perspective. AI renders distant buildings too crisp and detailed.
- **Flat blown-ish sky**, cool muted palette, slightly soft overall.
- **Entropy / mundane crowd:** dozens of random strangers mid-errand, a pelican in
  flight, a dog on a leash, uneven spacing — nobody is a "hero subject."
- Landscape, uncomposed, tilted; the subject is the scene, not a person.

## 77 — Night, 5 guys in front of a lit hotel facade (Piaget / Roger Dubuis)
- **Uneven exposure:** bright warm facade + string-light bloom, but the pavement and
  some faces fall into shadow. Faces are NOT hero-lit; a couple are soft/underexposed.
- **Real low-light noise** in the darks; mild motion softness; warm mixed white balance.

## 78 — Dark hotel lobby, two men at a marble table, big floral arrangement
- **Underexposed and moody:** warm tungsten, crushed but NOISY blacks (not clean),
  deep shadow across most of the frame. Subjects are dim, not lit for the camera.

## 79 — A framed painting on a dim hotel wall
- The **shadow-noise / warm-cast / underexposure** tell in pure form. Mundane subject,
  no person. Visible wall texture, grain in the dark, a single warm pool of light.

## 80 — Three guys in suits, HARSH direct midday sun, brick wall
- **Harsh, unflattering, directional light:** hard-edged shadows, blown highlights on
  the brick, deep shadow on frame-left, high contrast. Faces partly in shadow.
- This is the opposite of the even, soft, flattering light AI defaults to.

## The rules these produce (now in REALISM_LAYER)
1. **Do NOT improve exposure or quality.** Embrace underexposure, crushed-but-noisy
   blacks, blown highlights. Real photos are dim/harsh; AI over-brightens everything.
2. **Hazy atmospheric distance** — distant backgrounds low-contrast, desaturated, soft.
3. **Harsh / uneven / mixed light** — hard sun shadows + blown highlights outdoors;
   dim warm tungsten with deep shadow indoors. Subjects may be partly in shadow.
4. **Mundane subjects & background humans** — strangers mid-errand, a dog, a bird, a
   painting on a wall. Not everything is a hero shot.
5. **Muted, slightly-off color + real sensor noise/compression.** Never vivid/clean.
6. **Often landscape / uncomposed grab-shots**, not always a posed portrait.
