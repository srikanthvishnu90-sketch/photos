import { evaluateGeneratedSceneCandidate } from "./scene-candidate-evaluator-v1.ts";
import type { RetrievedConditioningReference } from "./reference-retriever-v1.ts";
import { REFERENCE_RETRIEVAL_DIMENSIONS } from "./reference-retrieval-policy-v1.ts";

function vector(index: number): number[] {
  const result = new Array<number>(REFERENCE_RETRIEVAL_DIMENSIONS).fill(0);
  result[index] = 1;
  return result;
}

function reference(index: number): RetrievedConditioningReference {
  const hex = ["a", "b", "c"][index];
  return {
    selected: {
      assetId: `00000000-0000-4000-8000-00000000000${index + 1}`,
      bucket: "inspiration",
      storagePath: `pack/${index}.jpg`,
      source: "style_pack",
      stylePackId: "dark-batman",
      description: `reference ${index}`,
      gradeNotes: "deep shadows",
      tags: ["dark"],
      rights: "licensed",
      usableForConditioning: true,
      contentSha256: hex.repeat(64),
      conditioningSha256: ["d", "e", "f"][index].repeat(64),
      embeddingModel: "gemini-embedding-2",
      indexingVersion: "reference-index-v1",
      relevance: 0.9 - index * 0.1,
      visualEmbedding: vector(index),
      sourcePriority: 0,
      mmrScore: 0.6,
      selectionRank: index + 1,
      maximumRedundancy: 0,
    },
    image: {
      bytes: new Uint8Array(256),
      mimeType: "image/jpeg",
      width: 256,
      height: 256,
    },
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("candidate evaluator rejects an embedding matching a retrieved image", async () => {
  const result = await evaluateGeneratedSceneCandidate({
    apiKey: "test-key",
    bytes: new Uint8Array(256),
    mimeType: "image/png",
    references: [reference(0), reference(1), reference(2)],
    embed: async () => ({
      values: vector(0),
      model: "gemini-embedding-2",
      dimensions: REFERENCE_RETRIEVAL_DIMENSIONS,
      providerRequestId: "embedding-request-1",
      usageMetadata: { promptTokenCount: 1 },
    }),
  });

  assert(result.decision.rejected, "matching candidate must be rejected");
  assert(
    result.decision.matchedReferenceSha256 === "d".repeat(64),
    "highest-similarity reference must be recorded",
  );
  assert(
    /^[a-f0-9]{64}$/.test(result.outputEmbeddingDigest),
    "raw vector must be reduced to an audit digest",
  );
});

Deno.test("candidate evaluator fails closed without exactly three references", async () => {
  let error: unknown;
  try {
    await evaluateGeneratedSceneCandidate({
      apiKey: "test-key",
      bytes: new Uint8Array(256),
      mimeType: "image/png",
      references: [reference(0)],
      embed: async () => {
        throw new Error("must not be called");
      },
    });
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof Error, "expected exact-three policy failure");
});

Deno.test("candidate evaluator compares the output to attached fixed non-identity references", async () => {
  const fixedHash = "9".repeat(64);
  const result = await evaluateGeneratedSceneCandidate({
    apiKey: "test-key",
    bytes: new Uint8Array(256),
    mimeType: "image/png",
    references: [reference(0), reference(1), reference(2)],
    additionalReferences: [{
      kind: "user_inspiration",
      sha256: fixedHash,
      embeddingModel: "gemini-embedding-2",
      visualEmbedding: vector(3),
    }],
    embed: async () => ({
      values: vector(3),
      model: "gemini-embedding-2",
      dimensions: REFERENCE_RETRIEVAL_DIMENSIONS,
      providerRequestId: "embedding-request-fixed",
      usageMetadata: { promptTokenCount: 1 },
    }),
  });

  assert(result.decision.rejected, "matching fixed reference must reject");
  assert(
    result.decision.matchedReferenceKind === "user_inspiration",
    "fixed reference kind must be persisted",
  );
  assert(
    result.decision.matchedReferenceSha256 === fixedHash,
    "fixed reference hash must be persisted",
  );
});

Deno.test("candidate evaluator excludes identity before a billable embedding call", async () => {
  let embedded = false;
  let error: unknown;
  try {
    await evaluateGeneratedSceneCandidate({
      apiKey: "test-key",
      bytes: new Uint8Array(256),
      mimeType: "image/png",
      references: [reference(0), reference(1), reference(2)],
      additionalReferences: [{
        kind: "identity",
        sha256: "8".repeat(64),
        embeddingModel: "gemini-embedding-2",
        visualEmbedding: vector(4),
      }],
      embed: async () => {
        embedded = true;
        throw new Error("must not be called");
      },
    });
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof Error, "identity reference must fail closed");
  assert(!embedded, "identity must be rejected before embedding output");
});
