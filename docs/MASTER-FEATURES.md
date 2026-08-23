# Gems — Master Feature Document

*Every feature named across our work, plus the ones that were missing, each with how it gets built, what it depends on, and when. This is the build bible: phases are dependency-ordered, and nothing in Phase N starts before its Phase N−1 dependencies exist. Status key: ✅ shipped · 🔨 designed/coded, not wired · 📋 specified · 💡 new in this document.*

## The spine (already real)

Auth with Google + email OTP on custom SMTP ✅, the full nine-screen design system ✅, Supabase schema with RLS, taste_events, consents ✅, moodboards loop ✅, and the three AI-layer artifacts 🔨 — the edit-photo edge function, the chat orchestrator prompt, and the two-pass ranking rubric. Everything below builds on this spine.

## Phase 1 — The core loop becomes real

1. **Photo import (web File API)** 📋 — Multi-file picker, client-side downscaling to 512px thumbnails for analysis, EXIF date extraction, originals held client-side (IndexedDB); full-resolution pixels only leave the browser for an explicitly requested edit. Depends on: nothing. Blocks: everything.
2. **Describe-it editing** 🔨 — edit-photo edge function against Nano Banana 2, wired to the Editor's describe mode: instruction in, version out, signed URL displayed, re-roll with kind=reroll. Edit-preamble constrains single-change behavior. Depends on: import, Gemini key.
3. **Photo ranking / "find my best photos"** 🔨 — Two-pass rubric as rank-photos: Pass A describes thumbnails once and caches; Pass B scores cached descriptions per request with the user's aesthetics injected. Intentionality protects dark/moody photos. Depends on: import. Blocks: gems reveal, dumps, collections, dating mode.
4. **Chat dock (find / build / edit / inspire)** 🔨 — Claude behind a chat edge function using the orchestrator prompt: strict JSON contract drives the UI, max two clarifying questions as visual chips, edit instructions rewritten to precision, stored aesthetics as defaults. Depends on: 2 and 3.
5. **Manual editing (erase, add, crop, adjust, filters)** 📋 — Crop/adjust client-side canvas; erase = brush mask + Gemini call with mask-described instruction; filters = the eight onboarding aesthetics as one-tap grades. Depends on: 2's pipeline.
6. **Version history + re-roll everywhere** 🔨 — edit_versions schema, Original/V1/V2 pills; every generative output non-destructive. Ships inside 2 and 5.
7. 💡 **Export to camera roll / device at full quality** — Web v1: original-resolution downloads (never upscale silently), filename ordering 01–12, one-tap "download all" zip. iOS later: PhotoKit "Gems" album. **The export event writes the north-star metric (photos kept vs. swapped).**
8. 💡 **Per-user cost guardrails** — Free tier hard cap (10 generative edits/month) enforced in the edge function before the Gemini call, paywall as the graceful wall. Blocks: safely inviting the 30 payers.

## Phase 2 — The magic moments

9. **Hidden-gems reveal** 📋 — Post-import analysis grouped by category, card-fan reveal, "pick the three most you" seeds the taste profile. The most important retention moment. Depends on: 1+3.
10. **Make-me-a-photo-dump (set-level assembly)** 📋 — Request → two visual questions → three complete options (clean/casual/editorial) → conversational revision. Deterministic assembly over Pass B scores. Depends on: 3+4.
11. **Style-match / "make it look like this"** 📋 — Pass A describes the reference's grade; Gemini applies it as an edit instruction. Powers "apply this aesthetic" from Discover. Depends on: 2.
12. **Moodboard analysis** ✅→📋 — Board screenshots in, visual recipe extracted, library matched or recreation guidance out. Depends on: 3, 11.
13. **Pose & style inspiration (Discover content)** 📋 — Sourcing pipeline (seed sprint → creator packs → user flywheel) + Pass B matching against reference descriptions.
14. **Natural-language photo search** 📋 — Query → filter/match over cached Pass A descriptions + metadata. Depends on: 3's cache.
15. **Smart collections** 📋 — Standing queries over the cache, refreshed on import; "never posted" joins an is-exported flag. Depends on: 3, 7.
16. 💡 **"Why this works" everywhere** — Pass B's `because` line on every ranked photo. Explanation, never scores. Falls out of 3.

## Phase 3 — Modes, templates, growth

17. **College commitment / template graphics** 📋 — Segmentation + template compositing + Nano Banana Pro for text-clean graphics; mockup framing enforced. Depends on: 2, 3.
18. **Dating Profile Director** 📋 — Six-photo profile with ordering + gap analysis; Pass B purpose=dating. Depends on: 3, 10.
19. **Travel recap + event modes** 📋 — Dump assembly scoped to date/location clusters; configuration over 10.
20. **Hidden gem of the day** 📋 — Daily forgotten high-scorer. Depends on: 3, 15.
21. **Taste profile (shareable)** 📋 — Computed from aesthetics + taste_events; Profile card + exportable share image.
22. 💡 **Direct-to-Instagram export** — Web Share API into the IG share sheet (two taps), exact-order export + paste-ready caption; Business publishing later. Never promise "posts for you."
23. **Creator aesthetic packs** 📋 — Licensed recipes + reference sets with creator names.
24. 💡 **Onboarding aesthetic analytics dashboard** — Weekly query over custom_aesthetic_events decides tag promotions. Monthly.

## Phase 4 — Platform maturity

25. **Subscription + credits (Stripe)** 📋 — $9.99 Plus, 7-day trial, metered by Phase-1 guardrails. Deliberately late: charge founding members via payment link first. NOTE: Stripe secrets enter Supabase only by the owner's own hand — never through chat or any agent.
26. **Apple sign-in** 🅿️ — Unblocks on Developer Program enrollment.
27. **iOS app (Expo + PhotoKit + on-device indexing)** 📋 — Edge functions, schema, rubrics carry over unchanged.
28. **Discover user flywheel** 📋 — Opt-in at export with credit + one-tap removal; ToS display license ships in v1.0.
29. 💡 **Data deletion + privacy surface** — Cascading delete, training opt-in wired to consents, plain-language privacy page. Do in Phase 2.
30. **Fine-tuned taste model** 💤 — Sleeps until taste_events volume + a demonstrated prompting ceiling. Until then: add eval cases, tune the rubric.

## The order, compressed

Import → editing wired → ranking → chat → export + cost caps *(the loop works)* → reveal → dumps → search/collections *(the magic works)* → modes, templates, sharing, IG two-tap *(the growth works)* → Stripe, iOS, flywheel *(the business works)*. Each phase ends with the same question: **did users keep what the AI made?** The `kept` column is the company's scoreboard.
