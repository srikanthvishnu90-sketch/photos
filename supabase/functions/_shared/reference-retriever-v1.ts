import {
  canonicalReferenceManifest,
  REFERENCE_RETRIEVAL_COUNT,
  REFERENCE_RETRIEVAL_DIMENSIONS,
  REFERENCE_RETRIEVAL_MODEL,
  REFERENCE_RETRIEVAL_POOL_SIZE,
  ReferenceRetrievalError,
  selectDiverseReferences,
  type RetrievalCandidate,
  type SelectedReference,
} from "./reference-retrieval-policy-v1.ts";
import { retrievalQueryText } from "./gemini-embedding-rest-v1.ts";

export const MAX_RETRIEVAL_PROMPT_CHARACTERS = 2_000 as const;
export const MAX_CONDITIONING_REFERENCE_BYTES = 4 * 1024 * 1024;
export const MAX_RETRIEVED_REFERENCE_BYTES = 12 * 1024 * 1024;

export interface PromptEmbedding {
  model: typeof REFERENCE_RETRIEVAL_MODEL;
  dimensions: typeof REFERENCE_RETRIEVAL_DIMENSIONS;
  values: readonly number[];
  inputSha256: string;
}

export interface DecodedConditioningImage {
  bytes: Uint8Array;
  mimeType: "image/jpeg" | "image/png";
  width: number;
  height: number;
}

export interface RetrievedConditioningReference {
  selected: SelectedReference;
  image: DecodedConditioningImage;
}

export interface ReferenceRetrievalSnapshot {
  promptHash: string;
  embeddingInputHash: string;
  manifest: string;
  manifestSha256: string;
  references: readonly RetrievedConditioningReference[];
}

export interface ReferenceRetrieverDependencies {
  embedPrompt(prompt: string): Promise<PromptEmbedding>;
  /** Must call the service-only, rights-filtering candidate RPC. */
  queryCandidates(input: {
    profileId: string;
    stylePackId: string | null;
    promptEmbedding: readonly number[];
    embeddingModel: typeof REFERENCE_RETRIEVAL_MODEL;
    poolSize: typeof REFERENCE_RETRIEVAL_POOL_SIZE;
    excludedConditioningHashes: readonly string[];
  }): Promise<readonly RetrievalCandidate[]>;
  /** Re-check rights and scope immediately before bytes leave Storage. */
  revalidateRights(input: {
    profileId: string;
    candidate: RetrievalCandidate;
  }): Promise<boolean>;
  /** Must download once and fully decode the exact returned bytes. */
  downloadAndDecode(
    candidate: RetrievalCandidate,
  ): Promise<DecodedConditioningImage>;
}

function canonicalRetrievalPrompt(prompt: string): string {
  const canonical = prompt.trim().replace(/\s+/g, " ");
  if (
    canonical.length < 3 ||
    canonical.length > MAX_RETRIEVAL_PROMPT_CHARACTERS
  ) {
    throw new ReferenceRetrievalError(
      "invalid_candidate",
      `retrieval prompt must be 3-${MAX_RETRIEVAL_PROMPT_CHARACTERS} characters`,
    );
  }
  return canonical;
}

async function sha256Hex(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function assertDecodedImage(image: DecodedConditioningImage): void {
  if (!(image.bytes instanceof Uint8Array)) {
    throw new ReferenceRetrievalError(
      "invalid_candidate",
      "conditioning decoder returned no bytes",
    );
  }
  if (
    image.bytes.byteLength < 128 ||
    image.bytes.byteLength > MAX_CONDITIONING_REFERENCE_BYTES
  ) {
    throw new ReferenceRetrievalError(
      "invalid_candidate",
      "conditioning image byte length is outside policy bounds",
    );
  }
  if (image.mimeType !== "image/jpeg" && image.mimeType !== "image/png") {
    throw new ReferenceRetrievalError(
      "invalid_candidate",
      "conditioning decoder returned an unsupported MIME type",
    );
  }
  if (
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    image.width < 64 ||
    image.height < 64 ||
    image.width > 1_024 ||
    image.height > 1_024 ||
    image.width * image.height > 1_048_576
  ) {
    throw new ReferenceRetrievalError(
      "invalid_candidate",
      "conditioning image dimensions are outside policy bounds",
    );
  }
}

/**
 * Executes the billable prompt embedding only after the caller has authenticated
 * and reserved generation quota. It never returns private paths to a client;
 * the result is intended to stay inside generate-scene.
 */
export async function retrieveConditioningReferences(
  input: {
    profileId: string;
    prompt: string;
    stylePackId?: string | null;
    excludedConditioningHashes?: readonly string[];
  },
  dependencies: ReferenceRetrieverDependencies,
): Promise<ReferenceRetrievalSnapshot> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.profileId)) {
    throw new ReferenceRetrievalError(
      "invalid_candidate",
      "verified profile ID is required",
    );
  }
  const stylePackId = input.stylePackId?.trim() || null;
  if (stylePackId !== null && !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(stylePackId)) {
    throw new ReferenceRetrievalError(
      "invalid_candidate",
      "style pack ID is invalid",
    );
  }
  const excludedConditioningHashes = [
    ...new Set(input.excludedConditioningHashes ?? []),
  ];
  if (
    excludedConditioningHashes.length > 12 ||
    excludedConditioningHashes.some((value) => !/^[a-f0-9]{64}$/.test(value))
  ) {
    throw new ReferenceRetrievalError(
      "invalid_candidate",
      "retrieval exclusion set is invalid",
    );
  }

  const prompt = canonicalRetrievalPrompt(input.prompt);
  const promptHash = await sha256Hex(prompt);
  const embeddingInput = retrievalQueryText(prompt);
  const embeddingInputHash = await sha256Hex(embeddingInput);
  const embedding = await dependencies.embedPrompt(embeddingInput);
  if (
    embedding.model !== REFERENCE_RETRIEVAL_MODEL ||
    embedding.dimensions !== REFERENCE_RETRIEVAL_DIMENSIONS ||
    embedding.values.length !== REFERENCE_RETRIEVAL_DIMENSIONS ||
    embedding.inputSha256 !== embeddingInputHash
  ) {
    throw new ReferenceRetrievalError(
      "incompatible_embedding",
      "prompt embedding does not match the indexed reference space",
    );
  }

  const candidates = await dependencies.queryCandidates({
    profileId: input.profileId,
    stylePackId,
    promptEmbedding: embedding.values,
    embeddingModel: REFERENCE_RETRIEVAL_MODEL,
    poolSize: REFERENCE_RETRIEVAL_POOL_SIZE,
    excludedConditioningHashes,
  });
  if (candidates.length > REFERENCE_RETRIEVAL_POOL_SIZE) {
    throw new ReferenceRetrievalError(
      "invalid_candidate",
      "candidate RPC exceeded the server-owned pool limit",
    );
  }
  const exclusionSet = new Set(excludedConditioningHashes);
  if (candidates.some((candidate) => exclusionSet.has(candidate.conditioningSha256))) {
    throw new ReferenceRetrievalError(
      "invalid_candidate",
      "candidate RPC returned an explicitly excluded reference",
    );
  }

  const selected = selectDiverseReferences(candidates, {
    k: REFERENCE_RETRIEVAL_COUNT,
  });
  const references: RetrievedConditioningReference[] = [];
  let aggregateBytes = 0;

  for (const reference of selected) {
    const rightsStillValid = await dependencies.revalidateRights({
      profileId: input.profileId,
      candidate: reference,
    });
    if (!rightsStillValid) {
      throw new ReferenceRetrievalError(
        "invalid_candidate",
        "conditioning rights changed after reference selection",
      );
    }

    // downloadAndDecode must return the same in-memory bytes later attached to
    // Gemini. The caller must not re-download after this verification.
    const image = await dependencies.downloadAndDecode(reference);
    assertDecodedImage(image);
    const actualSha256 = await sha256Hex(image.bytes);
    if (actualSha256 !== reference.conditioningSha256) {
      throw new ReferenceRetrievalError(
        "invalid_candidate",
        "conditioning object bytes do not match their indexed embedding",
      );
    }
    aggregateBytes += image.bytes.byteLength;
    if (aggregateBytes > MAX_RETRIEVED_REFERENCE_BYTES) {
      throw new ReferenceRetrievalError(
        "invalid_candidate",
        "retrieved references exceed the aggregate inline-byte budget",
      );
    }
    references.push({ selected: reference, image });
  }

  if (references.length !== REFERENCE_RETRIEVAL_COUNT) {
    throw new ReferenceRetrievalError(
      "insufficient_references",
      `exactly ${REFERENCE_RETRIEVAL_COUNT} verified references are required`,
    );
  }

  const manifest = canonicalReferenceManifest(selected);
  return {
    promptHash,
    embeddingInputHash,
    manifest,
    manifestSha256: await sha256Hex(manifest),
    references,
  };
}
