# Calibration pair — QUEUED realism/ranker patches (apply after chat-vision)

Two golden calibration specimens from the founder:
- `45.png` — **Colosseum balcony dinner**: FAKE that almost reads real. Tells:
  uniform amber glow through 60+ arches (no light physics / averaging), symmetric
  flanking olive trees + zero clutter (too-on-theme staging), breakfast food under
  night sky (time-of-day incoherence), detail smear at street level, "famous vantage
  regurgitation" (paraphrasing a real heavily-photographed terrace).
- `44.png` — **Parga harbor, Greece**: REAL that almost reads fake. Correct rare
  optics (floating boat = displaced refracted shadow on seabed, NOT a reflection),
  full entropy (mismatched shutters, antennas, mooring lines, out-of-theme junk),
  true geometry. "Looks fake" only because of an over-saturated 2010s HDR grade.

## QUEUED PATCH 1 — generate-scene REALISM_LAYER (add ban lines):
1. Architectural illumination must be UNEVEN: in any lit building/ruin, some openings
   brighter, some dim, some dark — never uniform glow through many openings.
2. Foreground staging must be IMPERFECT: props asymmetric, ≥1 mundane out-of-theme
   object present; never symmetric flanking decor / art-directed perfection.
3. Time-of-day COHERENCE: food, activity, crowd density, sky, and lighting must all
   agree on ONE hour (no breakfast under night light).
4. Saturation CEILING: no radioactive teal / candy HDR / oversaturated tone-compression
   — the over-edited uncanny valley. Keep grades muted and controlled (Euro Summer et al).

## QUEUED PATCH 2 — rank-photos Pass A (authenticity counter-principle):
- Over-processing / oversaturation / HDR is a FIXABLE grade choice, NOT a flaw and NOT
  a sign of low intentionality or authenticity. An over-edited REAL photo is gradeable
  (maybe great), never "fake" or "failure". Processing intensity must not feed the
  intentionality/authenticity judgment.
- Add these two images to the ranker + generation evals as calibration cases.
