// Gemini Embedding 2 contract for Gems reference retrieval and anti-copy checks.
// Text and image inputs share one 768-dimensional space. No retries: callers
// must attach their own durable idempotency/cost event before invoking again.

export const REFERENCE_EMBEDDING_MODEL = "gemini-embedding-2" as const;
export const REFERENCE_EMBEDDING_DIMENSIONS = 768 as const;
export const REFERENCE_EMBEDDING_VERSION = "reference-embedding-v1" as const;
const MAX_EMBED_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_BATCH_ITEMS = 16;

export type GeminiEmbeddingPart =
  | { text: string }
  | { inlineData: { mimeType: "image/jpeg" | "image/png"; data: string } };

export type EmbeddingResult = Readonly<{
  vector: readonly number[];
  model: string;
  responseId: string | null;
  usage: Readonly<Record<string, number>>;
}>;

function usageSummary(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  const result: Record<string, number> = {};
  for (const key of ["promptTokenCount", "totalTokenCount", "cachedContentTokenCount"]) {
    if (Number.isFinite(source[key])) result[key] = Number(source[key]);
  }
  return result;
}

function normalizeVector(value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length !== REFERENCE_EMBEDDING_DIMENSIONS) {
    throw new Error("embedding_dimensions_invalid");
  }
  const vector = value.map(Number);
  if (vector.some((entry) => !Number.isFinite(entry))) throw new Error("embedding_values_invalid");
  const norm = Math.sqrt(vector.reduce((sum, entry) => sum + entry * entry, 0));
  if (!Number.isFinite(norm) || norm <= 0) throw new Error("embedding_norm_invalid");
  return Object.freeze(vector.map((entry) => entry / norm));
}

async function responseJsonWithinLimit(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error("embedding_response_missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    total += value.byteLength;
    if (total > MAX_EMBED_RESPONSE_BYTES) {
      await reader.cancel("embedding_response_too_large").catch(() => undefined);
      throw new Error("embedding_response_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("embedding_response_invalid");
  }
  return parsed as Record<string, unknown>;
}

function linkedAbortController(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason ?? "request_aborted");
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const timer = setTimeout(() => controller.abort("embedding_timeout"), timeoutMs);
  return {
    controller,
    close() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

function embeddingFromResponse(data: Record<string, unknown>): readonly number[] {
  const direct = data.embedding as { values?: unknown } | undefined;
  const list = Array.isArray(data.embeddings) ? data.embeddings : [];
  const first = list[0] as { values?: unknown } | undefined;
  return normalizeVector(direct?.values ?? first?.values);
}

export async function embedReferenceContent(args: {
  apiKey: string;
  parts: GeminiEmbeddingPart[];
  model?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<EmbeddingResult> {
  const model = args.model || REFERENCE_EMBEDDING_MODEL;
  if (!args.apiKey || !/^gemini-[a-z0-9][a-z0-9.-]{0,79}$/i.test(model)) {
    throw new Error("embedding_configuration_invalid");
  }
  if (!Array.isArray(args.parts) || !args.parts.length || args.parts.length > 6) {
    throw new Error("embedding_parts_invalid");
  }
  const watchdog = linkedAbortController(args.signal, args.timeoutMs ?? 30_000);
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": args.apiKey,
        },
        body: JSON.stringify({
          model: `models/${model}`,
          content: { parts: args.parts },
    output_dimensionality: REFERENCE_EMBEDDING_DIMENSIONS,
        }),
        signal: watchdog.controller.signal,
      },
    );
    const data = await responseJsonWithinLimit(response);
    if (!response.ok) {
      throw new Error(`embedding_provider_${response.status}`);
    }
    return Object.freeze({
      vector: embeddingFromResponse(data),
      model,
      responseId: typeof data.responseId === "string" ? data.responseId : null,
      usage: Object.freeze(usageSummary(data.usageMetadata)),
    });
  } finally {
    watchdog.close();
  }
}

export async function batchEmbedReferenceContent(args: {
  apiKey: string;
  items: GeminiEmbeddingPart[][];
  model?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<readonly EmbeddingResult[]> {
  const model = args.model || REFERENCE_EMBEDDING_MODEL;
  if (!args.apiKey || !/^gemini-[a-z0-9][a-z0-9.-]{0,79}$/i.test(model)) {
    throw new Error("embedding_configuration_invalid");
  }
  if (!Array.isArray(args.items) || !args.items.length || args.items.length > MAX_BATCH_ITEMS
    || args.items.some((parts) => !parts.length || parts.length > 6)) {
    throw new Error("embedding_batch_invalid");
  }
  const watchdog = linkedAbortController(args.signal, args.timeoutMs ?? 45_000);
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": args.apiKey,
        },
        body: JSON.stringify({
          requests: args.items.map((parts) => ({
            model: `models/${model}`,
            content: { parts },
    output_dimensionality: REFERENCE_EMBEDDING_DIMENSIONS,
          })),
        }),
        signal: watchdog.controller.signal,
      },
    );
    const data = await responseJsonWithinLimit(response);
    if (!response.ok) throw new Error(`embedding_provider_${response.status}`);
    const embeddings = Array.isArray(data.embeddings) ? data.embeddings : [];
    if (embeddings.length !== args.items.length) throw new Error("embedding_batch_count_mismatch");
    const usage = Object.freeze(usageSummary(data.usageMetadata));
    return Object.freeze(embeddings.map((embedding) => Object.freeze({
      vector: normalizeVector((embedding as { values?: unknown })?.values),
      model,
      responseId: typeof data.responseId === "string" ? data.responseId : null,
      usage,
    })));
  } finally {
    watchdog.close();
  }
}
