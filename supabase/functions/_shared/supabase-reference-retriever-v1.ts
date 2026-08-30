import {
  retrieveConditioningReferences,
  type PromptEmbedding,
  type ReferenceRetrievalSnapshot,
} from "./reference-retriever-v1.ts";
import {
  REFERENCE_RETRIEVAL_MODEL,
  ReferenceRetrievalError,
  type RetrievalCandidate,
} from "./reference-retrieval-policy-v1.ts";
import { inspectConditioningImage } from "./strict-conditioning-image-v1.ts";

interface SupabaseErrorLike {
  message: string;
  code?: string;
}

interface SupabaseResultLike {
  data: unknown;
  error: SupabaseErrorLike | null;
}

interface SupabaseReferenceClient {
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<SupabaseResultLike>;
  storage: {
    from(bucket: string): {
      download(path: string): PromiseLike<SupabaseResultLike>;
    };
  };
}

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (row): row is Record<string, unknown> =>
      Boolean(row) && typeof row === "object" && !Array.isArray(row),
  );
}

function parseVector(value: unknown): number[] {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new ReferenceRetrievalError(
        "incompatible_embedding",
        "database returned an invalid pgvector value",
      );
    }
  }
  if (!Array.isArray(parsed)) {
    throw new ReferenceRetrievalError(
      "incompatible_embedding",
      "database returned no visual embedding",
    );
  }
  return parsed.map((component) => {
    const number = Number(component);
    if (!Number.isFinite(number)) {
      throw new ReferenceRetrievalError(
        "incompatible_embedding",
        "database embedding contains a non-finite value",
      );
    }
    return number;
  });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function mapCandidate(row: Record<string, unknown>): RetrievalCandidate {
  const source = String(row.source ?? "");
  const rights = String(row.rights ?? "");
  if (source !== "style_pack" && source !== "user_upload") {
    throw new ReferenceRetrievalError(
      "invalid_candidate",
      "database returned a disallowed reference source",
    );
  }
  if (rights !== "owned" && rights !== "licensed") {
    throw new ReferenceRetrievalError(
      "invalid_candidate",
      "database returned a reference without conditioning rights",
    );
  }
  return {
    assetId: String(row.asset_id ?? ""),
    bucket: String(row.storage_bucket ?? ""),
    storagePath: String(row.storage_path ?? ""),
    source,
    stylePackId: row.style_pack_id ? String(row.style_pack_id) : null,
    description: String(row.description ?? ""),
    gradeNotes: String(row.grade_notes ?? ""),
    tags: stringArray(row.tags),
    rights,
    usableForConditioning: row.usable_for_conditioning === true,
    contentSha256: String(row.content_sha256 ?? ""),
    conditioningSha256: String(row.conditioning_sha256 ?? ""),
    embeddingModel: String(row.embedding_model ?? "") as typeof REFERENCE_RETRIEVAL_MODEL,
    indexingVersion: String(row.indexing_version ?? ""),
    relevance: Number(row.relevance),
    visualEmbedding: parseVector(row.visual_embedding),
    sourcePriority: Number(row.source_priority),
  };
}

/**
 * Storage/RPC adapter for the pure retrieval policy. The caller owns the
 * billable prompt-embedding call so it can prepare and ledger that HTTP call
 * before passing the result here.
 */
export async function retrieveSceneReferencesFromSupabase(
  input: {
    supabase: SupabaseReferenceClient;
    profileId: string;
    prompt: string;
    stylePackId?: string | null;
    excludedConditioningHashes?: readonly string[];
    promptEmbedding: PromptEmbedding;
  },
): Promise<ReferenceRetrievalSnapshot> {
  return await retrieveConditioningReferences(
    {
      profileId: input.profileId,
      prompt: input.prompt,
      stylePackId: input.stylePackId,
      excludedConditioningHashes: input.excludedConditioningHashes,
    },
    {
      embedPrompt: async () => input.promptEmbedding,
      queryCandidates: async ({
        profileId,
        stylePackId,
        promptEmbedding,
        embeddingModel,
        poolSize,
        excludedConditioningHashes,
      }) => {
        const result = await input.supabase.rpc(
          "retrieve_conditioning_candidates_v1",
          {
            p_profile_id: profileId,
            p_query_embedding: promptEmbedding,
            p_embedding_model: embeddingModel,
            p_style_pack_id: stylePackId,
            p_pool_size: poolSize,
            p_excluded_conditioning_hashes: [...excludedConditioningHashes],
          },
        );
        if (result.error) {
          throw new ReferenceRetrievalError(
            "invalid_candidate",
            `reference candidate query failed: ${result.error.message}`,
          );
        }
        return rows(result.data).map(mapCandidate);
      },
      revalidateRights: async ({ profileId, candidate }) => {
        const result = await input.supabase.rpc(
          "revalidate_conditioning_reference_v1",
          {
            p_profile_id: profileId,
            p_asset_id: candidate.assetId,
            p_conditioning_sha256: candidate.conditioningSha256,
            p_embedding_model: candidate.embeddingModel,
          },
        );
        if (result.error) return false;
        const [row] = rows(result.data);
        return Boolean(
          row &&
            row.storage_bucket === candidate.bucket &&
            row.storage_path === candidate.storagePath &&
            row.conditioning_sha256 === candidate.conditioningSha256 &&
            row.rights === candidate.rights &&
            row.source === candidate.source,
        );
      },
      downloadAndDecode: async (candidate) => {
        const result = await input.supabase.storage
          .from(candidate.bucket)
          .download(candidate.storagePath);
        if (result.error || !(result.data instanceof Blob)) {
          throw new ReferenceRetrievalError(
            "invalid_candidate",
            `conditioning download failed: ${result.error?.message ?? "no blob"}`,
          );
        }
        const bytes = new Uint8Array(await result.data.arrayBuffer());
        const inspected = inspectConditioningImage(bytes, result.data.type || null);
        return {
          bytes,
          mimeType: inspected.mimeType,
          width: inspected.width,
          height: inspected.height,
        };
      },
    },
  );
}
