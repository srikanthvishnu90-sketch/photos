import {
  retrieveConditioningReferences,
  type DecodedConditioningImage,
  type ReferenceRetrieverDependencies,
} from "./reference-retriever-v1.ts";
import {
  REFERENCE_RETRIEVAL_DIMENSIONS,
  ReferenceRetrievalError,
  type RetrievalCandidate,
} from "./reference-retrieval-policy-v1.ts";

async function sha256(bytes: Uint8Array | string): Promise<string> {
  const input = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function image(seed: number): DecodedConditioningImage {
  const bytes = new Uint8Array(256);
  bytes.fill(seed);
  return { bytes, mimeType: "image/jpeg", width: 256, height: 256 };
}

function vector(index: number): number[] {
  const result = new Array<number>(REFERENCE_RETRIEVAL_DIMENSIONS).fill(0);
  result[index] = 1;
  return result;
}

async function candidates(
  images: readonly DecodedConditioningImage[],
): Promise<RetrievalCandidate[]> {
  return await Promise.all(images.map(async (value, index) => ({
    assetId: `00000000-0000-4000-8000-00000000000${index + 1}`,
    bucket: "inspiration",
    storagePath: `style-pack/${index + 1}.jpg`,
    source: "style_pack" as const,
    stylePackId: "dark-batman",
    description: `dark rooftop reference ${index + 1}`,
    gradeNotes: "restrained highlights, deep neutral shadows",
    tags: ["dark", "rooftop"],
    rights: "licensed" as const,
    usableForConditioning: true as const,
    contentSha256: (index + 1).toString(16).repeat(64),
    conditioningSha256: await sha256(value.bytes),
    embeddingModel: "gemini-embedding-2" as const,
    indexingVersion: "reference-index-v1",
    relevance: 0.9 - index * 0.05,
    visualEmbedding: vector(index),
    sourcePriority: 0,
  })));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("retriever returns exactly three rights-valid hash-bound images", async () => {
  const decoded = [image(1), image(2), image(3)];
  const rows = await candidates(decoded);
  const dependencies: ReferenceRetrieverDependencies = {
    embedPrompt: async (embeddingInput) => ({
      model: "gemini-embedding-2",
      dimensions: REFERENCE_RETRIEVAL_DIMENSIONS,
      values: vector(0),
      inputSha256: await sha256(embeddingInput),
    }),
    queryCandidates: async () => rows,
    revalidateRights: async () => true,
    downloadAndDecode: async (row) =>
      decoded[rows.findIndex((candidate) => candidate.assetId === row.assetId)],
  };

  const result = await retrieveConditioningReferences(
    {
      profileId: "00000000-0000-4000-8000-000000000001",
      prompt: "  moody   rooftop at dusk  ",
      stylePackId: "dark-batman",
    },
    dependencies,
  );

  assert(result.references.length === 3, "expected exactly three references");
  assert(/^[a-f0-9]{64}$/.test(result.promptHash), "expected prompt digest");
  assert(/^[a-f0-9]{64}$/.test(result.manifestSha256), "expected manifest digest");
});

Deno.test("retriever stops before download when rights are revoked", async () => {
  const decoded = [image(1), image(2), image(3)];
  const rows = await candidates(decoded);
  let downloadCount = 0;
  let error: unknown;
  try {
    await retrieveConditioningReferences(
      {
        profileId: "00000000-0000-4000-8000-000000000001",
        prompt: "moody rooftop at dusk",
      },
      {
        embedPrompt: async (embeddingInput) => ({
          model: "gemini-embedding-2",
          dimensions: REFERENCE_RETRIEVAL_DIMENSIONS,
          values: vector(0),
          inputSha256: await sha256(embeddingInput),
        }),
        queryCandidates: async () => rows,
        revalidateRights: async () => false,
        downloadAndDecode: async () => {
          downloadCount += 1;
          return decoded[0];
        },
      },
    );
  } catch (caught) {
    error = caught;
  }

  assert(error instanceof ReferenceRetrievalError, "expected retrieval failure");
  assert(downloadCount === 0, "revoked reference must never be downloaded");
});

Deno.test("retriever fails closed when Storage bytes changed", async () => {
  const decoded = [image(1), image(2), image(3)];
  const rows = await candidates(decoded);
  let error: unknown;
  try {
    await retrieveConditioningReferences(
      {
        profileId: "00000000-0000-4000-8000-000000000001",
        prompt: "moody rooftop at dusk",
      },
      {
        embedPrompt: async (embeddingInput) => ({
          model: "gemini-embedding-2",
          dimensions: REFERENCE_RETRIEVAL_DIMENSIONS,
          values: vector(0),
          inputSha256: await sha256(embeddingInput),
        }),
        queryCandidates: async () => rows,
        revalidateRights: async () => true,
        downloadAndDecode: async (row) => {
          if (row.assetId === rows[0].assetId) return image(9);
          return decoded[rows.findIndex((candidate) => candidate.assetId === row.assetId)];
        },
      },
    );
  } catch (caught) {
    error = caught;
  }

  assert(error instanceof ReferenceRetrievalError, "expected hash mismatch failure");
});
