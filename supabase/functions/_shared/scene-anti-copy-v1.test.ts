import {
  assertRerollReferencesChanged,
  candidateAction,
  evaluateSceneCandidateSimilarity,
  exceedsAntiCopyThreshold,
  SceneAntiCopyError,
  type AntiCopyReference,
} from "./scene-anti-copy-v1.ts";
import { REFERENCE_RETRIEVAL_DIMENSIONS } from "./reference-retrieval-policy-v1.ts";

function vector(...components: number[]): number[] {
  return [
    ...components,
    ...new Array<number>(
      REFERENCE_RETRIEVAL_DIMENSIONS - components.length,
    ).fill(0),
  ];
}

function digest(character: string): string {
  return character.repeat(64);
}

function reference(
  sha256: string,
  visualEmbedding: number[],
  kind: AntiCopyReference["kind"] = "retrieved_style",
): AntiCopyReference {
  return {
    kind,
    sha256,
    embeddingModel: "gemini-embedding-2",
    visualEmbedding,
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("anti-copy threshold is strictly greater than 0.95", () => {
  assert(!exceedsAntiCopyThreshold(0.95), "exact threshold must pass");
  assert(exceedsAntiCopyThreshold(0.950001), "value above threshold must reject");
});

Deno.test("first copy-like candidate rerolls and second fails terminally", () => {
  const output = vector(1, 0);
  const decision = evaluateSceneCandidateSimilarity(output, [
    reference(digest("a"), vector(1, 0)),
    reference(digest("b"), vector(0, 1)),
  ]);

  assert(decision.rejected, "identical embedding must be rejected");
  assert(candidateAction(0, decision) === "reroll", "first rejection rerolls");
  assert(
    candidateAction(1, decision) === "reject_terminal",
    "second rejection must be terminal",
  );
});

Deno.test("dissimilar candidate is accepted", () => {
  const decision = evaluateSceneCandidateSimilarity(vector(1, 0), [
    reference(digest("a"), vector(0, 1)),
  ]);
  assert(!decision.rejected, "orthogonal candidate should pass");
  assert(candidateAction(0, decision) === "accept", "passing candidate accepts");
});

Deno.test("reroll must replace every non-identity reference", () => {
  assertRerollReferencesChanged(
    digest("a"),
    digest("b"),
    [
      { kind: "retrieved_style", sha256: digest("c") },
      { kind: "identity", sha256: digest("d") },
    ],
    [
      { kind: "retrieved_style", sha256: digest("e") },
      { kind: "identity", sha256: digest("d") },
    ],
    digest("c"),
  );
});

Deno.test("reroll rejects reuse of the offending aesthetic bytes", () => {
  let error: unknown;
  try {
    assertRerollReferencesChanged(
      digest("a"),
      digest("b"),
      [{ kind: "retrieved_style", sha256: digest("c") }],
      [{ kind: "retrieved_style", sha256: digest("c") }],
      digest("c"),
    );
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof SceneAntiCopyError, "expected anti-copy policy error");
  assert(
    error.code === "reroll_manifest_reused",
    "expected manifest-reuse failure",
  );
});
