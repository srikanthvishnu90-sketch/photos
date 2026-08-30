/**
 * Versioned acceptance fixtures for reference retrieval.
 *
 * These are deliberately product-level expectations rather than exact asset IDs.
 * A changing library can satisfy the same contract as long as the returned set is
 * relevant, diverse, rights-cleared, and made from the immutable derivatives that
 * were snapshotted before generation.
 */

export const REFERENCE_RETRIEVAL_ACCEPTANCE_VERSION =
  "reference-retrieval-acceptance-v1" as const;

export type ReferenceRetrievalFixture = Readonly<{
  id: string;
  prompt: string;
  stylePackId?: string;
  expectedAnyTags: readonly string[];
  expectedAllTags?: readonly string[];
  forbiddenTags: readonly string[];
  rationale: string;
}>;

export const REFERENCE_RETRIEVAL_FIXTURES: readonly ReferenceRetrievalFixture[] = [
  {
    id: "moody-rooftop-dusk",
    prompt: "moody rooftop at dusk, casual iPhone photo, deep navy shadows",
    expectedAnyTags: ["rooftop", "city", "dusk", "night", "dark-moody"],
    forbiddenTags: ["beach", "tropical", "high-key-studio"],
    rationale: "The launch acceptance prompt must retrieve urban low-light references, never beach imagery.",
  },
  {
    id: "euro-summer-cafe",
    prompt: "sunlit European sidewalk cafe in summer, linen and warm film color",
    expectedAnyTags: ["cafe", "euro-summer", "warm-film", "daylight"],
    forbiddenTags: ["gym", "nightclub", "dark-gym"],
    rationale: "Tests setting and grade together without requiring one exact landmark.",
  },
  {
    id: "nightlife-flash",
    prompt: "messy candid nightlife photo with direct flash and real sensor noise",
    expectedAnyTags: ["nightlife", "direct-flash", "flash-night", "candid"],
    forbiddenTags: ["golden-hour", "clean-studio", "landscape"],
    rationale: "Tests photographic character rather than subject-object matching alone.",
  },
  {
    id: "dark-gym",
    prompt: "dark gym locker-room mirror photo, directional overhead light",
    expectedAnyTags: ["gym", "locker-room", "dark-gym", "mirror"],
    forbiddenTags: ["coastline", "cafe", "quiet-luxury"],
    rationale: "Tests an interior location with a strongly defined lighting recipe.",
  },
  {
    id: "golden-hour-field",
    prompt: "unposed golden-hour photo in an open field, soft flare",
    expectedAnyTags: ["golden-hour", "field", "backlit", "warm"],
    forbiddenTags: ["night", "direct-flash", "studio"],
    rationale: "Tests time-of-day and natural-light retrieval.",
  },
  {
    id: "clean-editorial-interior",
    prompt: "minimal clean editorial interior with soft window light",
    expectedAnyTags: ["clean-editorial", "interior", "window-light", "minimal"],
    forbiddenTags: ["nightclub", "grain-heavy", "streetwear"],
    rationale: "Tests a restrained palette and controlled framing habit.",
  },
  {
    id: "rainy-tokyo-street",
    prompt: "rainy Tokyo side street at night, reflections, handheld phone realism",
    expectedAnyTags: ["rain", "street", "night", "neon", "city"],
    forbiddenTags: ["beach", "studio", "desert"],
    rationale: "Tests weather, city context, and low-light texture together.",
  },
  {
    id: "quiet-luxury-hotel",
    prompt: "quiet luxury hotel lobby, understated stone, soft ambient light",
    expectedAnyTags: ["quiet-luxury", "hotel", "interior", "ambient-light"],
    forbiddenTags: ["streetwear", "direct-flash", "sports"],
    rationale: "Tests material palette and understated composition.",
  },
  {
    id: "streetwear-parking-garage",
    prompt: "streetwear photo in a concrete parking garage, wide phone lens",
    expectedAnyTags: ["streetwear", "parking-garage", "concrete", "wide-angle"],
    forbiddenTags: ["coastline", "clean-studio", "garden"],
    rationale: "Tests fashion-adjacent scene retrieval without conditioning on a specific outfit.",
  },
  {
    id: "film-nostalgia-road-trip",
    prompt: "imperfect road-trip snapshot through a car window, faded film color",
    expectedAnyTags: ["road-trip", "car", "film-nostalgia", "faded", "snapshot"],
    forbiddenTags: ["clean-editorial", "studio", "nightclub"],
    rationale: "Tests everyday imperfection and analog texture as first-class retrieval signals.",
  },
] as const;

export type RetrievedReferenceObservation = Readonly<{
  id: string;
  rights: "owned" | "licensed" | string;
  usableForConditioning: boolean;
  conditioningSha256: string;
  tags: readonly string[];
  similarity: number;
}>;

export type FixtureEvaluation = Readonly<{
  fixtureId: string;
  passed: boolean;
  failures: readonly string[];
}>;

// Keep this evaluator identical to the SQL conditioning gate. `pack` is a
// source/category label, not a sufficient rights basis; shared pack assets must
// still carry an owned or licensed rights decision before retrieval.
const ALLOWED_RIGHTS = new Set(["owned", "licensed"]);

export function evaluateReferenceRetrievalFixture(
  fixture: ReferenceRetrievalFixture,
  references: readonly RetrievedReferenceObservation[],
): FixtureEvaluation {
  const failures: string[] = [];
  if (references.length !== 3) failures.push("expected_exactly_three_references");

  const ids = new Set<string>();
  const hashes = new Set<string>();
  const normalizedTags = new Set<string>();
  for (const reference of references) {
    if (ids.has(reference.id)) failures.push("duplicate_reference_id");
    if (hashes.has(reference.conditioningSha256)) failures.push("duplicate_reference_bytes");
    ids.add(reference.id);
    hashes.add(reference.conditioningSha256);

    if (!ALLOWED_RIGHTS.has(reference.rights)) failures.push("reference_without_rights");
    if (!reference.usableForConditioning) failures.push("reference_not_usable");
    if (!Number.isFinite(reference.similarity)) failures.push("invalid_similarity");
    for (const tag of reference.tags) normalizedTags.add(tag.trim().toLowerCase());
  }

  const hasExpectedTag = fixture.expectedAnyTags.some((tag) =>
    normalizedTags.has(tag.toLowerCase())
  );
  if (!hasExpectedTag) failures.push("missing_expected_relevance_tag");

  for (const tag of fixture.expectedAllTags ?? []) {
    if (!normalizedTags.has(tag.toLowerCase())) failures.push(`missing_required_tag:${tag}`);
  }
  for (const tag of fixture.forbiddenTags) {
    if (normalizedTags.has(tag.toLowerCase())) failures.push(`forbidden_tag:${tag}`);
  }

  return {
    fixtureId: fixture.id,
    passed: failures.length === 0,
    failures,
  };
}

export type BlindComparisonVote = "retrieval" | "control" | "tie";

export function retrievalBlindWinRate(votes: readonly BlindComparisonVote[]): number {
  if (votes.length === 0) throw new Error("At least one blind comparison vote is required");
  const wins = votes.filter((vote) => vote === "retrieval").length;
  const ties = votes.filter((vote) => vote === "tie").length;
  return (wins + ties * 0.5) / votes.length;
}
