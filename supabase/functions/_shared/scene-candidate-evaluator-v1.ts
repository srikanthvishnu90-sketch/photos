import {
  embedGeminiContent,
  imageEmbeddingPart,
  type GeminiEmbeddingResult,
} from "./gemini-embedding-rest-v1.ts";
import type { RetrievedConditioningReference } from "./reference-retriever-v1.ts";
import {
  evaluateSceneCandidateSimilarity,
  type AntiCopyReference,
  type AntiCopyDecision,
} from "./scene-anti-copy-v1.ts";

export interface EvaluatedSceneCandidate {
  decision: AntiCopyDecision;
  outputEmbeddingDigest: string;
  providerRequestId: string | null;
  usageMetadata: Record<string, unknown>;
}

async function digestEmbedding(values: readonly number[]): Promise<string> {
  // Fixed precision makes the audit digest stable across JSON serializers while
  // preserving far more precision than the copy threshold needs.
  const canonical = values.map((value) => value.toPrecision(12)).join(",");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function evaluateGeneratedSceneCandidate(
  input: {
    apiKey: string;
    bytes: Uint8Array;
    mimeType: "image/jpeg" | "image/png" | "image/webp";
    references: readonly RetrievedConditioningReference[];
    additionalReferences?: readonly AntiCopyReference[];
    signal?: AbortSignal;
    embed?: typeof embedGeminiContent;
  },
): Promise<EvaluatedSceneCandidate> {
  if (input.references.length !== 3) {
    throw new Error("anti_copy_requires_three_retrieved_references");
  }
  const retrievedReferences = input.references.map((reference) => ({
    kind: "retrieved_style" as const,
    sha256: reference.selected.conditioningSha256,
    embeddingModel: reference.selected.embeddingModel,
    visualEmbedding: reference.selected.visualEmbedding,
  }));
  const additionalReferences = input.additionalReferences ?? [];
  if (additionalReferences.some((reference) => ![
    "user_inspiration",
    "realism",
    "environment",
  ].includes(reference.kind))) {
    throw new Error("anti_copy_fixed_reference_kind_invalid");
  }
  const hashes = new Set<string>();
  for (const reference of [...retrievedReferences, ...additionalReferences]) {
    if (hashes.has(reference.sha256)) {
      throw new Error("anti_copy_reference_hash_duplicated");
    }
    hashes.add(reference.sha256);
  }
  const embed = input.embed ?? embedGeminiContent;
  const embedding: GeminiEmbeddingResult = await embed(
    input.apiKey,
    [imageEmbeddingPart(input.bytes, input.mimeType)],
    input.signal,
  );
  const decision = evaluateSceneCandidateSimilarity(
    embedding.values,
    [...retrievedReferences, ...additionalReferences],
  );
  return {
    decision,
    outputEmbeddingDigest: await digestEmbedding(embedding.values),
    providerRequestId: embedding.providerRequestId,
    usageMetadata: embedding.usageMetadata,
  };
}
