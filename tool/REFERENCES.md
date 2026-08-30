# Reference libraries — the generation-quality strategy

Generations stop looking AI when the model recreates a **real photograph ~90%**
and inserts the user's face, instead of imagining the scene from a prompt. That
requires a **library of real reference photos per style pack** — the more (and
the more real/varied) the better. Goal: hundreds per pack.

## Where they live
Private `inspiration` storage bucket:
- `_global/packs/<packId>/` — per-pack ENVIRONMENT references. `generate-scene`
  lists up to 1000 and picks one per generated image (`environmentRef`), then
  recreates it ~90%.
- `_global/realism/` — the GLOBAL capture-quality set (real amateur iPhone
  photos: grain, harsh light, haze). Attached as quality-only conditioning so
  every generation inherits real-photo imperfection.

Valid pack ids: `euro-summer`, `dubai`, `old-money`, `luxury-cars`,
`beach-club`, `boat`, `dark-luxe`, `after-dark`.

## Current counts (2026-08-30)
| pack | refs |
|---|---|
| euro-summer | 4 |
| dubai | 7 |
| old-money | 16 |
| boat | 13 |
| luxury-cars | **0** |
| beach-club | **0** |
| dark-luxe | **0** |
| after-dark | **0** |
| realism (global) | 6 |

The four zero packs generate from the prompt alone today — they need real
references most.

## Bulk-import hundreds
`tool/import-pack-references.sh` — resizes, dedups, skips AI renders (any file
with "render" in the name), skips already-uploaded (resumable), uploads in
parallel.

```bash
# a folder of real Dubai photos → the dubai pack
tool/import-pack-references.sh dubai ~/refs/dubai-luxe

# the global capture-quality set (real imperfect iPhone photos)
tool/import-pack-references.sh _ ~/refs/real-iphone-photos --realism
```

Re-run any time after adding more images — existing ones are skipped. Tunables:
`GEMS_REF_MAX_DIM` (default 1600), `GEMS_REF_JPEG_Q` (82), `GEMS_REF_PARALLEL` (6).

## What makes a good reference
- REAL photos, not AI renders (renders teach the fake look — excluded by name).
- The place/composition/light people actually want for that pack.
- Variety within the pack (different spots, times of day, framings) so a batch
  of N images recreates N different real scenes.
- For `--realism`: deliberately imperfect phone photos (grain, underexposure,
  haze) — the capture-quality target, not polished shots.
