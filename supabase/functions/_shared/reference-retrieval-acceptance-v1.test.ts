import {
  evaluateReferenceRetrievalFixture,
  REFERENCE_RETRIEVAL_FIXTURES,
  retrievalBlindWinRate,
} from "./reference-retrieval-acceptance-v1.ts";

Deno.test("acceptance catalog contains ten distinct prompts", () => {
  if (REFERENCE_RETRIEVAL_FIXTURES.length !== 10) {
    throw new Error("Expected exactly ten acceptance fixtures");
  }
  const ids = new Set(REFERENCE_RETRIEVAL_FIXTURES.map((fixture) => fixture.id));
  const prompts = new Set(REFERENCE_RETRIEVAL_FIXTURES.map((fixture) => fixture.prompt));
  if (ids.size !== 10 || prompts.size !== 10) throw new Error("Fixtures must be distinct");
});

Deno.test("fixture evaluation rejects rights violations even when tags match", () => {
  const fixture = REFERENCE_RETRIEVAL_FIXTURES[0];
  const result = evaluateReferenceRetrievalFixture(fixture, [
    {
      id: "one",
      rights: "scraped",
      usableForConditioning: true,
      conditioningSha256: "a".repeat(64),
      tags: ["rooftop", "night"],
      similarity: 0.8,
    },
    {
      id: "two",
      rights: "licensed",
      usableForConditioning: true,
      conditioningSha256: "b".repeat(64),
      tags: ["city"],
      similarity: 0.75,
    },
    {
      id: "three",
      rights: "owned",
      usableForConditioning: true,
      conditioningSha256: "c".repeat(64),
      tags: ["dusk"],
      similarity: 0.7,
    },
  ]);
  if (result.passed || !result.failures.includes("reference_without_rights")) {
    throw new Error("Rights must be a hard retrieval gate");
  }
});

Deno.test("pack source labels do not substitute for owned or licensed rights", () => {
  const fixture = REFERENCE_RETRIEVAL_FIXTURES[0];
  const result = evaluateReferenceRetrievalFixture(fixture, [
    {
      id: "one",
      rights: "pack",
      usableForConditioning: true,
      conditioningSha256: "a".repeat(64),
      tags: ["rooftop"],
      similarity: 0.8,
    },
    {
      id: "two",
      rights: "licensed",
      usableForConditioning: true,
      conditioningSha256: "b".repeat(64),
      tags: ["city"],
      similarity: 0.75,
    },
    {
      id: "three",
      rights: "owned",
      usableForConditioning: true,
      conditioningSha256: "c".repeat(64),
      tags: ["dusk"],
      similarity: 0.7,
    },
  ]);
  if (result.passed || !result.failures.includes("reference_without_rights")) {
    throw new Error("Pack membership must not replace an owned or licensed rights basis");
  }
});

Deno.test("blind A/B scoring treats a tie as half a win", () => {
  const score = retrievalBlindWinRate(["retrieval", "retrieval", "control", "tie"]);
  if (score !== 0.625) throw new Error(`Unexpected blind win rate: ${score}`);
});
