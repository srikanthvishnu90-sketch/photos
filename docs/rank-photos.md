# Gems — Photo Ranking Rubric (rank-photos)

The scoring brain. Implemented as the `rank-photos` Supabase Edge Function with
a vision model (Gemini Flash for cost; batched 12–16 downscaled thumbnails per
call). Two-pass design:

- **Pass A — Describe** runs once per photo and is **cached forever**
  (client: IndexedDB record `derived`; server: `project_photos.derived` once
  the photo joins a project, keyed by asset id).
- **Pass B — Score** runs on cached Pass A JSON against a specific request,
  text-only, nearly free. This separation is what makes re-ranking instant.

The canonical prompt text lives in `supabase/functions/rank-photos/prompts.js`
— shared verbatim by the edge function and the eval harness so they can never
drift.

## Pass A output schema (per photo)

| field | type | meaning |
|---|---|---|
| index | number | position in the submitted batch |
| content | string | one line: who/what/where |
| people_count | number | |
| subject_clarity | 1–5 | clear subject, separated from background |
| expression | 1–5 or null | face quality if faces present |
| candid_or_posed | candid \| posed \| neither | |
| distance | close \| mid \| wide | |
| vibe_tags | string[] | 2–4 from the controlled vocabulary |
| intentionality | 1–5 | **CRITICAL**: is the look deliberate? Dark ≠ bad. |
| technical_flaws | string[] | only real failures; empty if none |
| best_for | string[] | 1–3 of cover, dump-slot, dating, profile-pic, sports-graphic, story, none |

Rules: describe, don't judge taste. Dark ≠ bad. Bright ≠ good. Grain ≠ flaw.
The only bad photo is an unintentional one.

## Pass B

Inputs: `request`, `purpose` (cover|dump|dating|profile|graphic|general),
`user_aesthetics` (weighed heavily — taste tags map to vibe_tags affinity),
`taste_summary` (recent kept/swapped behavior), and the cached Pass A
descriptions. Output: `{ ranking: [{ index, score 0–100, because }] }`.

Scoring order of importance:
1. intentionality and absence of technical_flaws (a flawed photo can't win)
2. fit to PURPOSE
3. vibe_tags match to USER TASTE and RECENT BEHAVIOR
4. subject_clarity and expression

`because` is ONE short user-facing line, never a number, never negative about
the person in the photo.

## Set assembly (deterministic code, not a model)

For dumps, applied AFTER Pass B — `gems-rank-assembly.js`:
top ~30 by score → slot 1 = highest-scoring `best_for: cover` → greedy fill
with constraints: ≥1 candid, ≥1 wide, ≥1 close; reject candidates too similar
to an already-picked photo (embedding similarity in Phase B; description
similarity fallback until then); final slot prefers expression ≥ 4 or a scenic
close. **The set is the product** — twelve top scores that all look alike is a
failure even though every individual pick was "right".

## Wiring notes

- Thumbnails at 512px max edge; batch 12–16 per Pass A call.
- Pass A cached per asset — a photo is described once, ever.
- Pass B text-only, run on every new request.
- Log each ranking request to `taste_events`
  (`event_type: "rank_requested"`, subject: purpose + top-5 indices).
  Kept/swapped events later close the loop.
- Edge function requires a signed-in user (JWT) — model calls cost money.

## Eval (acceptance test for this entire document)

`tool/rank-eval.mjs` + `eval/expected.json`: a ~30-photo personal test set
(include dark aesthetic photos deliberately), expected top-5 for three
purposes, overlap@5 measured after every rubric change. **Dark aesthetic
photos ranking HIGH for "my best photos" and blurry accidents ranking LAST is
the acceptance test.**
