export const GEMINI_EMBEDDING_MODEL = "gemini-embedding-2" as const;
export const GEMINI_EMBEDDING_DIMENSIONS = 768 as const;
export const GEMINI_EMBEDDING_MAX_IMAGES_PER_CALL = 6 as const;
export const GEMINI_EMBEDDING_MAX_TEXT_BATCH = 100 as const;

const EMBEDDING_TIMEOUT_MS = 30_000;
const MAX_EMBEDDING_REQUEST_BYTES = 18 * 1024 * 1024;
const MAX_EMBEDDING_RESPONSE_BYTES = 512 * 1024;

export type GeminiEmbeddingPart =
  | { text: string }
  | {
    inline_data: {
      mime_type: "image/jpeg" | "image/png" | "image/webp";
      data: string;
    };
  };

export interface GeminiEmbeddingResult {
  values: readonly number[];
  model: typeof GEMINI_EMBEDDING_MODEL;
  dimensions: typeof GEMINI_EMBEDDING_DIMENSIONS;
  providerRequestId: string | null;
  usageMetadata: Record<string, unknown>;
}

export function base64EncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.byteLength)),
    );
  }
  return btoa(binary);
}

export function imageEmbeddingPart(
  bytes: Uint8Array,
  mimeType: "image/jpeg" | "image/png" | "image/webp",
): GeminiEmbeddingPart {
  if (bytes.byteLength < 128 || bytes.byteLength > 5 * 1024 * 1024) {
    throw new GeminiEmbeddingError(
      "invalid_input",
      "embedding image byte length is outside policy bounds",
    );
  }
  return {
    inline_data: {
      mime_type: mimeType,
      data: base64EncodeBytes(bytes),
    },
  };
}

export class GeminiEmbeddingError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "request_too_large"
      | "provider_rejected"
      | "provider_failed"
      | "provider_timeout"
      | "provider_response_too_large"
      | "provider_contract_invalid",
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "GeminiEmbeddingError";
  }
}

function validateVector(value: unknown): number[] {
  if (!Array.isArray(value) || value.length !== GEMINI_EMBEDDING_DIMENSIONS) {
    throw new GeminiEmbeddingError(
      "provider_contract_invalid",
      `embedding must contain ${GEMINI_EMBEDDING_DIMENSIONS} values`,
    );
  }

  let magnitudeSquared = 0;
  const vector = new Array<number>(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const component = value[index];
    if (typeof component !== "number" || !Number.isFinite(component)) {
      throw new GeminiEmbeddingError(
        "provider_contract_invalid",
        "embedding contains a non-finite value",
      );
    }
    vector[index] = component;
    magnitudeSquared += component * component;
  }
  if (!Number.isFinite(magnitudeSquared) || magnitudeSquared <= 1e-18) {
    throw new GeminiEmbeddingError(
      "provider_contract_invalid",
      "embedding magnitude is zero",
    );
  }

  // Gemini Embedding 2 normalizes 768-dimensional outputs. Normalize again to
  // make the storage invariant explicit and protect against provider drift.
  const magnitude = Math.sqrt(magnitudeSquared);
  return vector.map((component) => component / magnitude);
}

function assertParts(parts: readonly GeminiEmbeddingPart[]): void {
  if (parts.length < 1 || parts.length > GEMINI_EMBEDDING_MAX_IMAGES_PER_CALL) {
    throw new GeminiEmbeddingError(
      "invalid_input",
      "embedding call contains an invalid part count",
    );
  }
  for (const part of parts) {
    if ("text" in part) {
      if (part.text.length < 1 || part.text.length > 16_000) {
        throw new GeminiEmbeddingError(
          "invalid_input",
          "embedding text length is outside policy bounds",
        );
      }
      continue;
    }
    if (
      !part.inline_data.data ||
      (part.inline_data.mime_type !== "image/jpeg" &&
        part.inline_data.mime_type !== "image/png" &&
        part.inline_data.mime_type !== "image/webp")
    ) {
      throw new GeminiEmbeddingError(
        "invalid_input",
        "embedding image part is invalid",
      );
    }
  }
}

async function responseTextWithinLimit(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  if (!response.body) return "";
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new GeminiEmbeddingError(
      "provider_response_too_large",
      "embedding response exceeds the byte limit",
    );
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("embedding_response_too_large").catch(() => undefined);
        throw new GeminiEmbeddingError(
          "provider_response_too_large",
          "embedding response exceeds the byte limit",
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function linkedAbortController(
  parentSignal?: AbortSignal,
): { controller: AbortController; dispose: () => void } {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(
    () => controller.abort("embedding_timeout"),
    EMBEDDING_TIMEOUT_MS,
  );
  return {
    controller,
    dispose: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

function providerRequestId(response: Response): string | null {
  return response.headers.get("x-request-id")
    ?? response.headers.get("x-goog-request-id")
    ?? null;
}

function providerFailureCode(status: number): GeminiEmbeddingError["code"] {
  return [400, 401, 403, 404, 413, 422, 429].includes(status)
    ? "provider_rejected"
    : "provider_failed";
}

async function postEmbeddingRequest(
  apiKey: string,
  method: "embedContent" | "batchEmbedContents",
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ payload: Record<string, unknown>; requestId: string | null }> {
  if (!apiKey) {
    throw new GeminiEmbeddingError("invalid_input", "Gemini API key is missing");
  }
  const serialized = JSON.stringify(body);
  if (new TextEncoder().encode(serialized).byteLength > MAX_EMBEDDING_REQUEST_BYTES) {
    throw new GeminiEmbeddingError(
      "request_too_large",
      "embedding request exceeds the inline provider byte limit",
    );
  }

  const linked = linkedAbortController(signal);
  let response: Response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBEDDING_MODEL}:${method}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: serialized,
        signal: linked.controller.signal,
      },
    );
    const requestId = providerRequestId(response);
    const text = await responseTextWithinLimit(
      response,
      response.ok ? MAX_EMBEDDING_RESPONSE_BYTES : 64 * 1024,
    );
    if (!response.ok) {
      throw new GeminiEmbeddingError(
        providerFailureCode(response.status),
        `embedding provider returned ${response.status}: ${text.slice(0, 500)}`,
        response.status,
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new GeminiEmbeddingError(
        "provider_contract_invalid",
        "embedding provider returned invalid JSON",
      );
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new GeminiEmbeddingError(
        "provider_contract_invalid",
        "embedding provider returned an invalid object",
      );
    }
    return { payload: payload as Record<string, unknown>, requestId };
  } catch (error) {
    if (error instanceof GeminiEmbeddingError) throw error;
    if (linked.controller.signal.aborted) {
      throw new GeminiEmbeddingError(
        "provider_timeout",
        "embedding provider call was aborted or timed out",
      );
    }
    throw new GeminiEmbeddingError(
      "provider_failed",
      `embedding provider request failed: ${String(error)}`,
    );
  } finally {
    linked.dispose();
  }
}

export function retrievalQueryText(prompt: string): string {
  const value = prompt.trim().replace(/\s+/g, " ");
  if (value.length < 3 || value.length > 2_000) {
    throw new GeminiEmbeddingError(
      "invalid_input",
      "retrieval query length is outside policy bounds",
    );
  }
  return `task: search result | query: ${value}`;
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function retrievalDocumentText(
  description: string,
  title = "none",
): string {
  const value = description.trim().replace(/\s+/g, " ");
  const safeTitle = title.trim().replace(/\s+/g, " ").slice(0, 200) || "none";
  if (value.length < 3 || value.length > 12_000) {
    throw new GeminiEmbeddingError(
      "invalid_input",
      "retrieval document length is outside policy bounds",
    );
  }
  return `title: ${safeTitle} | text: ${value}`;
}

export async function embedGeminiContent(
  apiKey: string,
  parts: readonly GeminiEmbeddingPart[],
  signal?: AbortSignal,
): Promise<GeminiEmbeddingResult> {
  assertParts(parts);
  const { payload, requestId } = await postEmbeddingRequest(
    apiKey,
    "embedContent",
    {
      model: `models/${GEMINI_EMBEDDING_MODEL}`,
      content: { parts },
      output_dimensionality: GEMINI_EMBEDDING_DIMENSIONS,
    },
    signal,
  );
  const embedding = payload.embedding as Record<string, unknown> | undefined;
  return {
    values: validateVector(embedding?.values),
    model: GEMINI_EMBEDDING_MODEL,
    dimensions: GEMINI_EMBEDDING_DIMENSIONS,
    providerRequestId: requestId,
    usageMetadata:
      payload.usageMetadata && typeof payload.usageMetadata === "object"
        ? payload.usageMetadata as Record<string, unknown>
        : {},
  };
}

export async function embedGeminiRetrievalQuery(
  apiKey: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<GeminiEmbeddingResult & { inputSha256: string }> {
  const input = retrievalQueryText(prompt);
  const [result, inputSha256] = await Promise.all([
    embedGeminiContent(apiKey, [{ text: input }], signal),
    sha256Text(input),
  ]);
  return { ...result, inputSha256 };
}

export async function batchEmbedGeminiContents(
  apiKey: string,
  contents: readonly (readonly GeminiEmbeddingPart[])[],
  signal?: AbortSignal,
): Promise<{
  embeddings: readonly (readonly number[])[];
  model: typeof GEMINI_EMBEDDING_MODEL;
  dimensions: typeof GEMINI_EMBEDDING_DIMENSIONS;
  providerRequestId: string | null;
  usageMetadata: Record<string, unknown>;
}> {
  if (contents.length < 1 || contents.length > GEMINI_EMBEDDING_MAX_TEXT_BATCH) {
    throw new GeminiEmbeddingError(
      "invalid_input",
      `batch embedding requires 1-${GEMINI_EMBEDDING_MAX_TEXT_BATCH} contents`,
    );
  }
  for (const parts of contents) assertParts(parts);
  const imageCount = contents.reduce(
    (total, parts) =>
      total + parts.filter((part) => "inline_data" in part).length,
    0,
  );
  if (imageCount > GEMINI_EMBEDDING_MAX_IMAGES_PER_CALL) {
    throw new GeminiEmbeddingError(
      "invalid_input",
      `batch embedding accepts at most ${GEMINI_EMBEDDING_MAX_IMAGES_PER_CALL} images`,
    );
  }
  const { payload, requestId } = await postEmbeddingRequest(
    apiKey,
    "batchEmbedContents",
    {
      requests: contents.map((parts) => ({
        model: `models/${GEMINI_EMBEDDING_MODEL}`,
        content: { parts },
        output_dimensionality: GEMINI_EMBEDDING_DIMENSIONS,
      })),
    },
    signal,
  );
  if (!Array.isArray(payload.embeddings) || payload.embeddings.length !== contents.length) {
    throw new GeminiEmbeddingError(
      "provider_contract_invalid",
      "batch embedding provider returned the wrong result count",
    );
  }
  return {
    embeddings: payload.embeddings.map((embedding) =>
      validateVector((embedding as Record<string, unknown>)?.values)
    ),
    model: GEMINI_EMBEDDING_MODEL,
    dimensions: GEMINI_EMBEDDING_DIMENSIONS,
    providerRequestId: requestId,
    usageMetadata:
      payload.usageMetadata && typeof payload.usageMetadata === "object"
        ? payload.usageMetadata as Record<string, unknown>
        : {},
  };
}
