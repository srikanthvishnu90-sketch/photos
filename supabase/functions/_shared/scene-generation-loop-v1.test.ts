import {
  generateSceneWithAntiCopy,
  SceneGenerationLoopError,
  type GeneratedSceneCandidate,
} from "./scene-generation-loop-v1.ts";
import type { RetrievedConditioningReference } from "./reference-retriever-v1.ts";
import type { AntiCopyDecision } from "./scene-anti-copy-v1.ts";
import { REFERENCE_RETRIEVAL_DIMENSIONS } from "./reference-retrieval-policy-v1.ts";

function digest(character: string): string {
  return character.repeat(64);
}

function references(): RetrievedConditioningReference[] {
  return [0, 1, 2].map((index) => {
    const vector = new Array<number>(REFERENCE_RETRIEVAL_DIMENSIONS).fill(0);
    vector[index] = 1;
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
        contentSha256: digest(["a", "b", "c"][index]),
        conditioningSha256: digest(["d", "e", "f"][index]),
        embeddingModel: "gemini-embedding-2",
        indexingVersion: "reference-index-v1",
        relevance: 0.9,
        visualEmbedding: vector,
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
  });
}

function decision(rejected: boolean): AntiCopyDecision {
  return {
    policyVersion: "scene-anti-copy-v1",
    embeddingModel: "gemini-embedding-2",
    dimensions: REFERENCE_RETRIEVAL_DIMENSIONS,
    metric: "cosine",
    threshold: 0.95,
    rejected,
    maximumSimilarity: rejected ? 0.99 : 0.7,
    matchedReferenceKind: "retrieved_style",
    matchedReferenceSha256: digest("d"),
  };
}

function generated(seed: number): GeneratedSceneCandidate {
  const bytes = new Uint8Array(256);
  bytes.fill(seed);
  return {
    bytes,
    mimeType: "image/png",
    width: 1024,
    height: 1280,
    contentSha256: digest(seed === 1 ? "a" : "b"),
    providerRequestId: `request-${seed}`,
    providerResponseId: `response-${seed}`,
    inputUnits: 1,
    outputUnits: 1,
    costMicros: 1,
    providerMeta: {},
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("first passing candidate uses one provider call", async () => {
  let calls = 0;
  const result = await generateSceneWithAntiCopy({
    prepareCandidate: async ({ candidateIndex }) => ({
      candidateIndex,
      providerCallId: `call-${candidateIndex}`,
      invokeAllowed: true,
      existingStatus: "prepared",
      fundingSource: candidateIndex === 0 ? "user_reserved" : "system_anti_copy",
      referenceManifestHash: digest(candidateIndex === 0 ? "a" : "b"),
      references: references(),
      providerRequestBody: "{}",
    }),
    invokeProvider: async () => {
      calls += 1;
      return generated(calls);
    },
    evaluateCandidate: async () => ({
      decision: decision(false),
      outputEmbeddingDigest: digest("c"),
    }),
    recordCandidate: async () => ({ decision: "accepted", rerollAllowed: false }),
  });
  assert(calls === 1, "passing candidate must not reroll");
  assert(!result.rerollUsed, "first candidate should be accepted");
});

Deno.test("copy rejection discards candidate and performs exactly one reroll", async () => {
  const generatedCandidates: GeneratedSceneCandidate[] = [];
  let calls = 0;
  const result = await generateSceneWithAntiCopy({
    prepareCandidate: async ({ candidateIndex }) => ({
      candidateIndex,
      providerCallId: `call-${candidateIndex}`,
      invokeAllowed: true,
      existingStatus: "prepared",
      fundingSource: candidateIndex === 0 ? "user_reserved" : "system_anti_copy",
      referenceManifestHash: digest(candidateIndex === 0 ? "a" : "b"),
      references: references(),
      providerRequestBody: "{}",
    }),
    invokeProvider: async () => {
      calls += 1;
      const value = generated(calls);
      generatedCandidates.push(value);
      return value;
    },
    evaluateCandidate: async () => ({
      decision: decision(calls === 1),
      outputEmbeddingDigest: digest("c"),
    }),
    recordCandidate: async ({ evaluated }) => ({
      decision: evaluated.decision.rejected ? "copy_rejected" : "accepted",
      rerollAllowed: evaluated.decision.rejected,
    }),
  });

  assert(calls === 2, "one rejection must produce exactly one reroll");
  assert(result.rerollUsed, "second candidate should be accepted");
  assert(
    generatedCandidates[0].bytes.every((byte) => byte === 0),
    "rejected candidate bytes must be erased",
  );
  assert(
    generatedCandidates[1].bytes.some((byte) => byte !== 0),
    "accepted candidate bytes must remain available for upload",
  );
});

Deno.test("two copy rejections terminate without a third provider call", async () => {
  let calls = 0;
  let error: unknown;
  try {
    await generateSceneWithAntiCopy({
      prepareCandidate: async ({ candidateIndex }) => ({
        candidateIndex,
        providerCallId: `call-${candidateIndex}`,
        invokeAllowed: true,
        existingStatus: "prepared",
        fundingSource: candidateIndex === 0 ? "user_reserved" : "system_anti_copy",
        referenceManifestHash: digest(candidateIndex === 0 ? "a" : "b"),
        references: references(),
        providerRequestBody: "{}",
      }),
      invokeProvider: async () => {
        calls += 1;
        return generated(calls);
      },
      evaluateCandidate: async () => ({
        decision: decision(true),
        outputEmbeddingDigest: digest("c"),
      }),
      recordCandidate: async () => ({
        decision: "copy_rejected",
        rerollAllowed: true,
      }),
    });
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof SceneGenerationLoopError, "expected terminal rejection");
  assert(error.code === "anti_copy_reroll_rejected", "expected copy failure code");
  assert(calls === 2, "anti-copy guard must never make a third provider call");
});
