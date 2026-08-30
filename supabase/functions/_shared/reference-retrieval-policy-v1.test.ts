import {
  REFERENCE_RETRIEVAL_DIMENSIONS,
  ReferenceRetrievalError,
  selectDiverseReferences,
  type RetrievalCandidate,
} from "./reference-retrieval-policy-v1.ts";

function unitVector(index: number, secondIndex?: number): number[] {
  const vector = new Array<number>(REFERENCE_RETRIEVAL_DIMENSIONS).fill(0);
  vector[index] = secondIndex === undefined ? 1 : Math.SQRT1_2;
  if (secondIndex !== undefined) vector[secondIndex] = Math.SQRT1_2;
  return vector;
}

function digest(character: string): string {
  return character.repeat(64);
}

function candidate(
  id: string,
  relevance: number,
  vector: number[],
  overrides: Partial<RetrievalCandidate> = {},
): RetrievalCandidate {
  const digestAlphabet = ["a", "b", "c", "d", "e", "f"] as const;
  const idNumber = Number(id.replace(/\D/g, ""));
  const contentCharacter = digestAlphabet[idNumber % digestAlphabet.length];
  const conditioningCharacter =
    digestAlphabet[(idNumber + 3) % digestAlphabet.length];
  return {
    assetId: `00000000-0000-4000-8000-00000000000${id}`,
    bucket: "inspiration",
    storagePath: `style-pack/${id}.jpg`,
    source: "style_pack",
    stylePackId: "dark-batman",
    description: `reference ${id}`,
    gradeNotes: "deep shadows and restrained highlights",
    tags: ["dark", "night"],
    rights: "licensed",
    usableForConditioning: true,
    contentSha256: digest(contentCharacter),
    conditioningSha256: digest(conditioningCharacter),
    embeddingModel: "gemini-embedding-2",
    indexingVersion: "reference-index-v1",
    relevance,
    visualEmbedding: vector,
    sourcePriority: 0,
    ...overrides,
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("MMR chooses a diverse third reference instead of a near twin", () => {
  const references = selectDiverseReferences([
    candidate("1", 0.92, unitVector(0)),
    candidate("2", 0.91, unitVector(0, 1)),
    candidate("3", 0.86, unitVector(2)),
    candidate("4", 0.85, unitVector(3)),
  ]);

  assert(references.length === 3, "expected exactly three references");
  assert(references[0].assetId.endsWith("1"), "top relevance must lead");
  assert(
    references.some((reference) => reference.assetId.endsWith("3")),
    "a visually distinct reference should beat the near twin",
  );
});

Deno.test("source priority is lexicographic before relevance", () => {
  const references = selectDiverseReferences([
    candidate("1", 0.51, unitVector(0)),
    candidate("2", 0.50, unitVector(1)),
    candidate("3", 0.99, unitVector(2), {
      source: "user_upload",
      stylePackId: null,
      sourcePriority: 1,
    }),
  ]);

  assert(
    references[0].sourcePriority === 0 && references[1].sourcePriority === 0,
    "selected pack references must fill before fallback references",
  );
});

Deno.test("duplicate bytes cannot satisfy exact-k retrieval", () => {
  const sharedHash = digest("f");
  let error: unknown;
  try {
    selectDiverseReferences([
      candidate("1", 0.9, unitVector(0), {
        conditioningSha256: sharedHash,
      }),
      candidate("2", 0.8, unitVector(1), {
        conditioningSha256: sharedHash,
      }),
      candidate("3", 0.7, unitVector(2)),
    ]);
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof ReferenceRetrievalError, "expected policy error");
  assert(error.code === "insufficient_references", "expected exact-k failure");
});

Deno.test("unlicensed or disabled rows fail closed", () => {
  let error: unknown;
  try {
    selectDiverseReferences([
      candidate("1", 0.9, unitVector(0), {
        rights: "unverified" as RetrievalCandidate["rights"],
      }),
      candidate("2", 0.8, unitVector(1)),
      candidate("3", 0.7, unitVector(2)),
    ]);
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof ReferenceRetrievalError, "expected policy error");
  assert(error.code === "invalid_candidate", "expected rights failure");
});

Deno.test("wrong-size embeddings never enter MMR", () => {
  let error: unknown;
  try {
    selectDiverseReferences([
      candidate("1", 0.9, [1, 0]),
      candidate("2", 0.8, unitVector(1)),
      candidate("3", 0.7, unitVector(2)),
    ]);
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof ReferenceRetrievalError, "expected policy error");
  assert(
    error.code === "incompatible_embedding",
    "expected embedding-space failure",
  );
});
