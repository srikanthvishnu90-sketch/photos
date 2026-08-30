// deno-lint-ignore-file no-import-prefix
// index-references — rights-gated, durable reference indexing.
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  CONDITIONING_BUCKET,
  persistConditioningObject,
} from "../_shared/conditioning-object-v1.ts";
import {
  batchEmbedGeminiContents,
  GEMINI_EMBEDDING_DIMENSIONS,
  GEMINI_EMBEDDING_MAX_IMAGES_PER_CALL,
  GEMINI_EMBEDDING_MODEL,
  GeminiEmbeddingError,
  imageEmbeddingPart,
  retrievalDocumentText,
} from "../_shared/gemini-embedding-rest-v1.ts";
import {
  failClaimedReferenceIndexRunBeforeProviderV1,
  type ReferenceIndexJson,
  ReferenceIndexOrchestratorError,
  type ReferenceIndexProviderFailureV1,
  type ReferenceIndexResponsePayload,
  runReferenceIndexProviderStageV1,
  sha256ReferenceIndexJsonV1,
} from "../_shared/reference-index-orchestrator-v1.ts";
import {
  claimReferenceIndexRun,
  completeReferenceIndexRun,
  getReferenceIndexRunState,
  reapStaleReferenceIndexWork,
  reserveReferenceIndexRun,
  type RpcInvoker,
} from "../_shared/reference-index-state-client-v1.ts";
import {
  attestInspirationAssetRightsV1,
  parseReferenceRightsAttestationsV1,
  ReferenceRightsAttestationError,
} from "../_shared/reference-rights-attestation-v1.ts";
import { priceReferenceVisionUsageV1 } from "../_shared/reference-provider-pricing-v1.ts";

type UntypedDatabase = {
  public: {
    Tables: Record<string, {
      Row: Record<string, unknown>;
      Insert: Record<string, unknown>;
      Update: Record<string, unknown>;
      Relationships: [];
    }>;
    Views: Record<string, {
      Row: Record<string, unknown>;
      Relationships: [];
    }>;
    Functions: Record<string, {
      Args: Record<string, unknown>;
      Returns: unknown;
    }>;
    Enums: Record<string, string>;
    CompositeTypes: Record<string, unknown>;
  };
};

type ServiceClient = ReturnType<typeof createClient<UntypedDatabase>>;

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const VISION_MODEL = Deno.env.get("GEMINI_REFERENCE_VISION_MODEL") ??
  "gemini-2.5-flash";
const INDEX_VERSION = "reference-index-v1";
const MANIFEST_VERSION = "reference-index-request-v1";
const VISION_PROMPT_VERSION = "reference-vision-look-v1";
const RETRIEVAL_DOCUMENT_VERSION = "reference-retrieval-document-v1";
const RIGHTS_POLICY_VERSION = "conditioning-rights-v1";
const MAX_BATCH = 16;
const MAX_SOURCE_BYTES = 15 * 1024 * 1024;
const MAX_CONDITIONING_BYTES = 4 * 1024 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_VISION_REQUEST_BYTES = 18 * 1024 * 1024;
const MAX_VISION_RESPONSE_BYTES = 2 * 1024 * 1024;
const VISION_TIMEOUT_MS = 60_000;
const EMBEDDING_IMAGE_MICRO_USD = 120;
const EMBEDDING_TEXT_MICRO_USD_PER_M_TOKEN = 200_000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[a-f0-9]{64}$/;

type AssetSource = "user_upload" | "style_pack";

type AssetRow = {
  id: string;
  profile_id: string | null;
  storage_path: string;
  label: string;
  mime_type: string | null;
  source: string;
  style_pack_id: string | null;
  rights: string;
  usable_for_conditioning: boolean;
  index_status: string;
  content_sha256: string | null;
  conditioning_sha256: string | null;
  conditioning_storage_bucket: string | null;
  conditioning_storage_path: string | null;
  embedding_model: string | null;
  indexing_version: string | null;
};

type PreparedAsset = AssetRow & {
  source: AssetSource;
  originalSha256: string;
  conditioningSha256: string;
  conditioningMime: "image/jpeg" | "image/png";
  conditioningBytes: Uint8Array;
  conditioningBucket: typeof CONDITIONING_BUCKET;
  conditioningPath: string;
};

type ManifestAsset = {
  assetId: string;
  ownerProfileId: string | null;
  source: AssetSource;
  stylePackId: string | null;
  rights: "owned" | "licensed";
  usableForConditioning: true;
  storagePath: string;
  contentSha256: string;
  conditioningSha256: string;
  conditioningStorageBucket: typeof CONDITIONING_BUCKET;
  conditioningStoragePath: string;
  mimeType: "image/jpeg" | "image/png";
  byteSize: number;
};

type ReferenceManifest = {
  schema: typeof MANIFEST_VERSION;
  requestMode: "asset_ids" | "backfill";
  requestedAssetIds: string[];
  embeddingModel: typeof GEMINI_EMBEDDING_MODEL;
  visionModel: string;
  visionPromptVersion: typeof VISION_PROMPT_VERSION;
  retrievalDocumentVersion: typeof RETRIEVAL_DOCUMENT_VERSION;
  rightsPolicyVersion: typeof RIGHTS_POLICY_VERSION;
  assets: ManifestAsset[];
};

type VisionDescription = {
  asset_id: string;
  description: string;
  scene_type: string;
  time_of_day: string;
  light: string;
  palette: string;
  subject_present: boolean;
  vibe_tags: string[];
  grade_notes: string;
};

type ExistingRun = {
  id: string;
  status: string;
  request_manifest: unknown;
  indexing_version: string;
  asset_count: number;
};

class VisionProviderError extends Error {
  constructor(
    readonly outcome: ReferenceIndexProviderFailureV1["outcome"],
    readonly code: string,
    message: string,
    readonly providerRequestId: string | null = null,
  ) {
    super(message);
    this.name = "VisionProviderError";
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function authenticatedUser(
  request: Request,
  supabase: ServiceClient,
) {
  const match = (request.headers.get("authorization") ?? "").match(
    /^Bearer\s+(.+)$/i,
  );
  if (!match?.[1]) return null;
  const { data, error } = await supabase.auth.getUser(match[1]);
  return error ? null : data.user ?? null;
}

async function readJsonBodyWithinLimit(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  if (request.signal.aborted) throw new Error("client_aborted");
  if (!request.body) return {};
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await request.body.cancel("request_too_large").catch(() => undefined);
    throw new Error("request_too_large");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const cancelOnAbort = () => {
    void reader.cancel("client_aborted").catch(() => undefined);
  };
  request.signal.addEventListener("abort", cancelOnAbort, { once: true });
  if (request.signal.aborted) cancelOnAbort();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel("request_too_large").catch(() => undefined);
        throw new Error("request_too_large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (request.signal.aborted) throw new Error("client_aborted");
    throw error;
  } finally {
    request.signal.removeEventListener("abort", cancelOnAbort);
  }
  if (request.signal.aborted) throw new Error("client_aborted");

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return raw.trim() ? JSON.parse(raw) : {};
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function rpcInvoker(supabase: ServiceClient): RpcInvoker {
  return async (functionName, args) => {
    const result = await supabase.rpc(functionName, args);
    return {
      data: result.data,
      error: result.error
        ? {
          code: result.error.code,
          message: result.error.message,
          details: result.error.details,
          hint: result.error.hint,
        }
        : null,
    };
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer),
  );
  return Array.from(
    digest,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function normalizedMime(
  value: string,
  path: string,
): "image/jpeg" | "image/png" | null {
  const mime = value.toLowerCase().split(";", 1)[0].trim();
  if (mime === "image/jpeg" || mime === "image/jpg") return "image/jpeg";
  if (mime === "image/png") return "image/png";
  const clean = path.toLowerCase().split(/[?#]/, 1)[0];
  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return "image/jpeg";
  if (clean.endsWith(".png")) return "image/png";
  return null;
}

function imageDimensions(
  bytes: Uint8Array,
  mime: string,
): { width: number; height: number } | null {
  if (
    mime === "image/png" && bytes.length >= 45 && bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    String.fromCharCode(...bytes.subarray(12, 16)) === "IHDR"
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (
    mime === "image/jpeg" && bytes.length >= 16 && bytes[0] === 0xff &&
    bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff &&
    bytes[bytes.length - 1] === 0xd9
  ) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1];
      const length = (bytes[offset + 2] << 8) + bytes[offset + 3];
      if (length < 2 || offset + length + 2 > bytes.length) return null;
      if (
        [
          0xc0,
          0xc1,
          0xc2,
          0xc3,
          0xc5,
          0xc6,
          0xc7,
          0xc9,
          0xca,
          0xcb,
          0xcd,
          0xce,
          0xcf,
        ].includes(marker)
      ) {
        return {
          height: (bytes[offset + 5] << 8) + bytes[offset + 6],
          width: (bytes[offset + 7] << 8) + bytes[offset + 8],
        };
      }
      offset += length + 2;
    }
  }
  return null;
}

async function checkedImage(
  blob: Blob,
  path: string,
  maxBytes: number,
  maxEdge: number,
): Promise<{
  bytes: Uint8Array;
  mime: "image/jpeg" | "image/png";
  dimensions: { width: number; height: number };
}> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const mime = normalizedMime(blob.type, path);
  const dimensions = mime ? imageDimensions(bytes, mime) : null;
  if (
    !mime || !bytes.length || bytes.byteLength > maxBytes || !dimensions ||
    dimensions.width < 64 || dimensions.height < 64 ||
    dimensions.width > maxEdge || dimensions.height > maxEdge ||
    dimensions.width * dimensions.height > 50_000_000
  ) {
    throw new Error("reference_image_invalid");
  }
  return { bytes, mime, dimensions };
}

function assetScopeAllowed(
  asset: AssetRow,
  userId: string,
  isAdmin: boolean,
): asset is AssetRow & {
  source: AssetSource;
  rights: "owned" | "licensed";
  usable_for_conditioning: true;
} {
  if (
    !["user_upload", "style_pack"].includes(asset.source) ||
    !["owned", "licensed"].includes(asset.rights) ||
    asset.usable_for_conditioning !== true
  ) return false;
  if (asset.source === "style_pack") {
    if (asset.profile_id !== null || !asset.style_pack_id) return false;
    return isAdmin;
  }
  return isAdmin || asset.profile_id === userId;
}

async function loadOriginal(
  supabase: ServiceClient,
  asset: AssetRow,
) {
  const { data, error } = await supabase.storage.from("inspiration").download(
    asset.storage_path,
  );
  if (error || !(data instanceof Blob)) {
    throw new Error("reference_source_unavailable");
  }
  return await checkedImage(data, asset.storage_path, MAX_SOURCE_BYTES, 12_000);
}

async function prepareAndPersistAsset(
  supabase: ServiceClient,
  asset: AssetRow & { source: AssetSource },
): Promise<PreparedAsset> {
  const original = await loadOriginal(supabase, asset);
  const transformed = await supabase.storage.from("inspiration").download(
    asset.storage_path,
    {
      transform: { width: 1024, height: 1024, resize: "contain", quality: 85 },
    },
  );
  let conditioning = original;
  if (!transformed.error && transformed.data instanceof Blob) {
    try {
      conditioning = await checkedImage(
        transformed.data,
        asset.storage_path,
        MAX_CONDITIONING_BYTES,
        1024,
      );
    } catch {
      conditioning = original;
    }
  }
  if (
    conditioning.dimensions.width > 1024 ||
    conditioning.dimensions.height > 1024 ||
    conditioning.bytes.byteLength > MAX_CONDITIONING_BYTES
  ) throw new Error("reference_downscale_unavailable");

  const persisted = await persistConditioningObject(supabase, {
    assetId: asset.id,
    source: asset.source,
    profileId: asset.profile_id,
    bytes: conditioning.bytes,
    declaredMimeType: conditioning.mime,
  });
  return {
    ...asset,
    originalSha256: await sha256Hex(original.bytes),
    conditioningSha256: persisted.sha256,
    conditioningMime: persisted.mimeType,
    conditioningBytes: conditioning.bytes,
    conditioningBucket: persisted.bucket,
    conditioningPath: persisted.path,
  };
}

function expectedConditioningPath(asset: ManifestAsset): string {
  const extension = asset.mimeType === "image/jpeg" ? "jpg" : "png";
  const prefix = asset.source === "style_pack"
    ? "style-pack"
    : `${asset.ownerProfileId}/reference`;
  return `${prefix}/${asset.assetId}/${asset.conditioningSha256}.${extension}`;
}

async function loadPreparedManifestAsset(
  supabase: ServiceClient,
  asset: AssetRow & { source: AssetSource },
  manifest: ManifestAsset,
): Promise<PreparedAsset> {
  if (
    asset.id !== manifest.assetId ||
    asset.profile_id !== manifest.ownerProfileId ||
    asset.storage_path !== manifest.storagePath ||
    asset.source !== manifest.source ||
    asset.style_pack_id !== manifest.stylePackId ||
    asset.rights !== manifest.rights ||
    asset.usable_for_conditioning !== true ||
    manifest.conditioningStorageBucket !== CONDITIONING_BUCKET ||
    manifest.conditioningStoragePath !== expectedConditioningPath(manifest)
  ) throw new Error(`reference_manifest_asset_drift:${asset.id}`);

  const original = await loadOriginal(supabase, asset);
  if (await sha256Hex(original.bytes) !== manifest.contentSha256) {
    throw new Error(`reference_source_content_changed:${asset.id}`);
  }
  const stored = await supabase.storage.from(CONDITIONING_BUCKET).download(
    manifest.conditioningStoragePath,
  );
  if (stored.error || !(stored.data instanceof Blob)) {
    throw new Error(`reference_conditioning_unavailable:${asset.id}`);
  }
  const conditioning = await checkedImage(
    stored.data,
    manifest.conditioningStoragePath,
    MAX_CONDITIONING_BYTES,
    1024,
  );
  if (
    conditioning.mime !== manifest.mimeType ||
    conditioning.bytes.byteLength !== manifest.byteSize ||
    await sha256Hex(conditioning.bytes) !== manifest.conditioningSha256
  ) throw new Error(`reference_conditioning_content_changed:${asset.id}`);

  return {
    ...asset,
    originalSha256: manifest.contentSha256,
    conditioningSha256: manifest.conditioningSha256,
    conditioningMime: manifest.mimeType,
    conditioningBytes: conditioning.bytes,
    conditioningBucket: CONDITIONING_BUCKET,
    conditioningPath: manifest.conditioningStoragePath,
  };
}

function cleanText(value: unknown, max: number): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);
}

function cleanTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.map((tag) => cleanText(tag, 80).toLowerCase()).filter(Boolean),
    ),
  ].slice(0, 24);
}

async function readJsonResponse(
  response: Response,
): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error("vision_response_missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    total += value.byteLength;
    if (total > MAX_VISION_RESPONSE_BYTES) {
      await reader.cancel("vision_response_too_large").catch(() => undefined);
      throw new Error("vision_response_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const parsed = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("vision_response_invalid");
  }
  return parsed as Record<string, unknown>;
}

function normalizeVisionRows(
  value: unknown,
  expectedIds: readonly string[],
): VisionDescription[] {
  if (!Array.isArray(value) || value.length !== expectedIds.length) {
    throw new Error("reference_vision_count_mismatch");
  }
  const expected = new Set(expectedIds);
  const byId = new Map<string, VisionDescription>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("reference_vision_row_invalid");
    }
    const row = raw as Record<string, unknown>;
    const assetId = cleanText(row.asset_id, 64);
    if (!expected.delete(assetId)) {
      throw new Error("reference_vision_asset_mismatch");
    }
    const description = cleanText(row.description, 4000);
    const gradeNotes = cleanText(row.grade_notes, 2000);
    if (!description || !gradeNotes) {
      throw new Error("reference_vision_description_missing");
    }
    byId.set(assetId, {
      asset_id: assetId,
      description,
      scene_type: cleanText(row.scene_type, 120),
      time_of_day: cleanText(row.time_of_day, 120),
      light: cleanText(row.light, 240),
      palette: cleanText(row.palette, 240),
      subject_present: row.subject_present === true,
      vibe_tags: cleanTags(row.vibe_tags),
      grade_notes: gradeNotes,
    });
  }
  return expectedIds.map((id) => byId.get(id)!);
}

function decodeVisionPayload(
  payload: ReferenceIndexResponsePayload,
  expectedIds: readonly string[],
): VisionDescription[] {
  if (Array.isArray(payload)) {
    throw new Error("reference_vision_payload_invalid");
  }
  const object = payload as Record<string, unknown>;
  if (object.schema !== "reference-vision-result-v1") {
    throw new Error("reference_vision_payload_version_mismatch");
  }
  return normalizeVisionRows(object.rows, expectedIds);
}

async function describeBatchOnce(
  assets: PreparedAsset[],
  signal: AbortSignal,
): Promise<{
  rows: VisionDescription[];
  responseId: string | null;
  usage: Record<string, unknown>;
}> {
  const prompt =
    "Analyze each attached reference photo independently. Describe photographic LOOK only, never identity. Return one JSON array item per ASSET_ID with: asset_id, description, scene_type, time_of_day, light, palette, subject_present, vibe_tags, grade_notes. description must cover setting, framing, light, texture, phone-camera imperfection, and mood. grade_notes must be a concise reusable color/tone recipe. Do not name or infer a person.";
  const parts: Array<Record<string, unknown>> = [{ text: prompt }];
  for (const asset of assets) {
    parts.push({ text: `ASSET_ID: ${asset.id}` });
    parts.push({
      inlineData: {
        mimeType: asset.conditioningMime,
        data: bytesToBase64(asset.conditioningBytes),
      },
    });
  }
  const body = JSON.stringify({
    contents: [{ role: "user", parts }],
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: "array",
        minItems: assets.length,
        maxItems: assets.length,
        items: {
          type: "object",
          required: [
            "asset_id",
            "description",
            "scene_type",
            "time_of_day",
            "light",
            "palette",
            "subject_present",
            "vibe_tags",
            "grade_notes",
          ],
          properties: {
            asset_id: { type: "string" },
            description: { type: "string" },
            scene_type: { type: "string" },
            time_of_day: { type: "string" },
            light: { type: "string" },
            palette: { type: "string" },
            subject_present: { type: "boolean" },
            vibe_tags: {
              type: "array",
              items: { type: "string" },
              maxItems: 16,
            },
            grade_notes: { type: "string" },
          },
        },
      },
    },
  });
  if (new TextEncoder().encode(body).byteLength > MAX_VISION_REQUEST_BYTES) {
    throw new VisionProviderError(
      "rejected",
      "vision_request_too_large",
      "reference vision request exceeds the provider byte policy",
    );
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason ?? "request_aborted");
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  const timer = setTimeout(
    () => controller.abort("vision_timeout"),
    VISION_TIMEOUT_MS,
  );
  try {
    let response: Response;
    try {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1/models/${VISION_MODEL}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": GEMINI_API_KEY,
          },
          body,
          signal: controller.signal,
        },
      );
    } catch (error) {
      throw new VisionProviderError(
        "indeterminate",
        "vision_transport_indeterminate",
        String(error),
      );
    }
    const providerRequestId = response.headers.get("x-request-id") ??
      response.headers.get("x-goog-request-id");
    let data: Record<string, unknown>;
    try {
      data = await readJsonResponse(response);
    } catch (error) {
      throw new VisionProviderError(
        "failed",
        "vision_response_invalid",
        String(error),
        providerRequestId,
      );
    }
    if (!response.ok) {
      throw new VisionProviderError(
        response.status >= 400 && response.status < 500 ? "rejected" : "failed",
        `reference_vision_${response.status}`,
        `reference vision provider returned ${response.status}`,
        providerRequestId,
      );
    }
    const candidates = Array.isArray(data.candidates)
      ? data.candidates as Array<Record<string, unknown>>
      : [];
    const content = candidates[0]?.content as
      | { parts?: Array<{ text?: unknown }> }
      | undefined;
    const text = content?.parts?.find((part) => typeof part.text === "string")
      ?.text;
    let rawRows: unknown;
    try {
      rawRows = typeof text === "string" ? JSON.parse(text) : null;
    } catch (error) {
      throw new VisionProviderError(
        "failed",
        "vision_contract_invalid",
        String(error),
        providerRequestId,
      );
    }
    let rows: VisionDescription[];
    try {
      rows = normalizeVisionRows(rawRows, assets.map((asset) => asset.id));
    } catch (error) {
      throw new VisionProviderError(
        "failed",
        "vision_contract_invalid",
        String(error),
        providerRequestId,
      );
    }
    const usage = data.usageMetadata && typeof data.usageMetadata === "object"
      ? data.usageMetadata as Record<string, unknown>
      : {};
    return {
      rows,
      responseId: typeof data.responseId === "string"
        ? data.responseId
        : providerRequestId,
      usage,
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

function buildRetrievalDocument(
  row: VisionDescription,
): string {
  const description = [
    row.description,
    `scene: ${row.scene_type || "unspecified"}`,
    `time of day: ${row.time_of_day || "unspecified"}`,
    `light: ${row.light || "unspecified"}`,
    `palette: ${row.palette || "unspecified"}`,
    `vibe: ${row.vibe_tags.join(", ") || "unspecified"}`,
    `color grade: ${row.grade_notes}`,
  ].join("\n");
  return retrievalDocumentText(
    description,
    row.scene_type || "reference",
  );
}

function decodeEmbeddingPayload(
  payload: ReferenceIndexResponsePayload,
  schema: string,
  expectedIds: readonly string[],
): number[][] {
  if (Array.isArray(payload)) {
    throw new Error("reference_embedding_payload_invalid");
  }
  const object = payload as Record<string, unknown>;
  if (
    object.schema !== schema || !Array.isArray(object.assetIds) ||
    !Array.isArray(object.vectors) ||
    object.assetIds.length !== expectedIds.length ||
    object.vectors.length !== expectedIds.length
  ) {
    throw new Error("reference_embedding_payload_invalid");
  }
  assertStringArrayEquals(object.assetIds, expectedIds);
  return object.vectors.map((value) => {
    if (!Array.isArray(value) || value.length !== GEMINI_EMBEDDING_DIMENSIONS) {
      throw new Error("reference_embedding_dimensions_invalid");
    }
    const vector = value.map(Number);
    if (vector.some((component) => !Number.isFinite(component))) {
      throw new Error("reference_embedding_vector_invalid");
    }
    return vector;
  });
}

function assertStringArrayEquals(
  value: unknown[],
  expected: readonly string[],
): void {
  if (
    value.length !== expected.length ||
    value.some((item, index) => item !== expected[index])
  ) {
    throw new Error("reference_embedding_asset_order_mismatch");
  }
}

function usageUnits(usage: Record<string, unknown>): number {
  for (const key of ["promptTokenCount", "totalTokenCount"]) {
    const value = Number(usage[key]);
    if (Number.isSafeInteger(value) && value >= 0) return value;
  }
  return 0;
}

function providerFailure(error: unknown): ReferenceIndexProviderFailureV1 {
  if (error instanceof VisionProviderError) {
    return {
      outcome: error.outcome,
      errorCode: cleanText(error.code, 100),
      errorDetail: cleanText(error.message, 1000),
      providerRequestId: error.providerRequestId,
    };
  }
  if (error instanceof GeminiEmbeddingError) {
    const outcome = error.code === "provider_rejected" ||
        error.code === "invalid_input" || error.code === "request_too_large"
      ? "rejected"
      : error.code === "provider_timeout" || error.code === "provider_failed"
      ? "indeterminate"
      : "failed";
    return {
      outcome,
      errorCode: error.code,
      errorDetail: cleanText(error.message, 1000),
    };
  }
  return {
    outcome: "failed",
    errorCode: "reference_provider_failed",
    errorDetail: cleanText(
      error instanceof Error ? error.message : error,
      1000,
    ),
  };
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

function manifestAsset(asset: PreparedAsset): ManifestAsset {
  return {
    assetId: asset.id,
    ownerProfileId: asset.profile_id,
    source: asset.source,
    stylePackId: asset.style_pack_id,
    rights: asset.rights as "owned" | "licensed",
    usableForConditioning: true,
    storagePath: asset.storage_path,
    contentSha256: asset.originalSha256,
    conditioningSha256: asset.conditioningSha256,
    conditioningStorageBucket: asset.conditioningBucket,
    conditioningStoragePath: asset.conditioningPath,
    mimeType: asset.conditioningMime,
    byteSize: asset.conditioningBytes.byteLength,
  };
}

function buildManifest(
  prepared: PreparedAsset[],
  requestedIds: string[],
  backfill: boolean,
): ReferenceManifest {
  return {
    schema: MANIFEST_VERSION,
    requestMode: backfill ? "backfill" : "asset_ids",
    requestedAssetIds: [...requestedIds].sort(),
    embeddingModel: GEMINI_EMBEDDING_MODEL,
    visionModel: VISION_MODEL,
    visionPromptVersion: VISION_PROMPT_VERSION,
    retrievalDocumentVersion: RETRIEVAL_DOCUMENT_VERSION,
    rightsPolicyVersion: RIGHTS_POLICY_VERSION,
    assets: [...prepared].sort((left, right) => left.id.localeCompare(right.id))
      .map(manifestAsset),
  };
}

function parseManifest(
  value: unknown,
  requestedIds: string[],
  backfill: boolean,
): ReferenceManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("reference_manifest_invalid");
  }
  const manifest = value as Record<string, unknown>;
  const requested = Array.isArray(manifest.requestedAssetIds)
    ? manifest.requestedAssetIds.map(String)
    : [];
  if (
    manifest.schema !== MANIFEST_VERSION ||
    manifest.requestMode !== (backfill ? "backfill" : "asset_ids") ||
    manifest.embeddingModel !== GEMINI_EMBEDDING_MODEL ||
    manifest.visionModel !== VISION_MODEL ||
    manifest.visionPromptVersion !== VISION_PROMPT_VERSION ||
    manifest.retrievalDocumentVersion !== RETRIEVAL_DOCUMENT_VERSION ||
    manifest.rightsPolicyVersion !== RIGHTS_POLICY_VERSION ||
    JSON.stringify([...requested].sort()) !==
      JSON.stringify([...requestedIds].sort()) ||
    !Array.isArray(manifest.assets) || manifest.assets.length < 1 ||
    manifest.assets.length > MAX_BATCH
  ) throw new Error("reference_idempotency_conflict");

  const assets = manifest.assets.map((value): ManifestAsset => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("reference_manifest_item_invalid");
    }
    const row = value as Record<string, unknown>;
    const item = {
      assetId: String(row.assetId ?? ""),
      ownerProfileId: row.ownerProfileId == null
        ? null
        : String(row.ownerProfileId),
      source: String(row.source ?? "") as AssetSource,
      stylePackId: row.stylePackId == null ? null : String(row.stylePackId),
      rights: String(row.rights ?? "") as "owned" | "licensed",
      usableForConditioning: row.usableForConditioning as true,
      storagePath: String(row.storagePath ?? ""),
      contentSha256: String(row.contentSha256 ?? ""),
      conditioningSha256: String(row.conditioningSha256 ?? ""),
      conditioningStorageBucket: String(
        row.conditioningStorageBucket ?? "",
      ) as typeof CONDITIONING_BUCKET,
      conditioningStoragePath: String(row.conditioningStoragePath ?? ""),
      mimeType: String(row.mimeType ?? "") as "image/jpeg" | "image/png",
      byteSize: Number(row.byteSize),
    };
    if (
      !UUID_RE.test(item.assetId) ||
      (item.ownerProfileId !== null && !UUID_RE.test(item.ownerProfileId)) ||
      !["user_upload", "style_pack"].includes(item.source) ||
      !["owned", "licensed"].includes(item.rights) ||
      item.usableForConditioning !== true || !item.storagePath ||
      (item.source === "user_upload" &&
        (item.ownerProfileId === null || item.stylePackId !== null)) ||
      (item.source === "style_pack" &&
        (item.ownerProfileId !== null || !item.stylePackId ||
          item.stylePackId.length > 80)) ||
      !SHA256_RE.test(item.contentSha256) ||
      !SHA256_RE.test(item.conditioningSha256) ||
      item.conditioningStorageBucket !== CONDITIONING_BUCKET ||
      !["image/jpeg", "image/png"].includes(item.mimeType) ||
      !Number.isSafeInteger(item.byteSize) || item.byteSize < 1 ||
      item.byteSize > MAX_CONDITIONING_BYTES ||
      item.conditioningStoragePath !== expectedConditioningPath(item)
    ) {
      throw new Error("reference_manifest_item_invalid");
    }
    return item;
  });
  if (new Set(assets.map((asset) => asset.assetId)).size !== assets.length) {
    throw new Error("reference_manifest_item_duplicate");
  }
  if (
    JSON.stringify(assets.map((asset) => asset.assetId)) !==
      JSON.stringify(assets.map((asset) => asset.assetId).sort())
  ) {
    throw new Error("reference_manifest_order_invalid");
  }
  return {
    ...manifest,
    requestedAssetIds: requested,
    assets,
  } as ReferenceManifest;
}

const ASSET_SELECT =
  "id, profile_id, storage_path, label, mime_type, source, style_pack_id, rights, usable_for_conditioning, index_status, content_sha256, conditioning_sha256, conditioning_storage_bucket, conditioning_storage_path, embedding_model, indexing_version";

async function findExistingRun(
  supabase: ServiceClient,
  requestedBy: string,
  batchId: string,
): Promise<ExistingRun | null> {
  const { data, error } = await supabase.from("reference_index_runs")
    .select("id, status, request_manifest, indexing_version, asset_count")
    .eq("requested_by", requestedBy)
    .eq("idempotency_key", batchId)
    .maybeSingle();
  if (error) throw new Error(`reference_run_lookup_failed:${error.message}`);
  return data as ExistingRun | null;
}

async function loadManifestRows(
  supabase: ServiceClient,
  manifest: ReferenceManifest,
): Promise<Map<string, AssetRow>> {
  const ids = manifest.assets.map((asset) => asset.assetId);
  const { data, error } = await supabase.from("inspiration_assets")
    .select(ASSET_SELECT).in("id", ids);
  if (error || data?.length !== ids.length) {
    throw new Error("reference_manifest_assets_unavailable");
  }
  return new Map((data as AssetRow[]).map((asset) => [asset.id, asset]));
}

async function revalidatePreparedRights(
  supabase: ServiceClient,
  prepared: readonly PreparedAsset[],
  userId: string,
  isAdmin: boolean,
): Promise<void> {
  const { data, error } = await supabase.from("inspiration_assets")
    .select(ASSET_SELECT)
    .in("id", prepared.map((asset) => asset.id));
  if (error || data?.length !== prepared.length) {
    throw new Error("reference_rights_revalidation_unavailable");
  }
  const current = new Map(
    (data as AssetRow[]).map((asset) => [asset.id, asset]),
  );
  for (const expected of prepared) {
    const asset = current.get(expected.id);
    if (
      !asset || !assetScopeAllowed(asset, userId, isAdmin) ||
      asset.profile_id !== expected.profile_id ||
      asset.storage_path !== expected.storage_path ||
      asset.source !== expected.source ||
      asset.style_pack_id !== expected.style_pack_id ||
      asset.rights !== expected.rights
    ) {
      throw new Error(`reference_rights_revoked:${expected.id}`);
    }
  }
}

async function claimNewAsset(
  supabase: ServiceClient,
  asset: PreparedAsset,
): Promise<AssetRow | null> {
  let query = supabase.from("inspiration_assets")
    .update({
      index_status: "indexing",
      index_error: null,
      indexing_version: INDEX_VERSION,
    })
    .eq("id", asset.id)
    .eq("storage_path", asset.storage_path)
    .eq("source", asset.source)
    .eq("rights", asset.rights)
    .eq("usable_for_conditioning", true)
    .in("index_status", ["pending", "failed"])
    .is("embedding", null);
  query = asset.profile_id === null
    ? query.is("profile_id", null)
    : query.eq("profile_id", asset.profile_id);
  const { data, error } = await query.select(ASSET_SELECT).maybeSingle();
  if (error) throw new Error(`reference_claim_failed:${error.message}`);
  return data as AssetRow | null;
}

async function ensureManifestAssetClaimed(
  supabase: ServiceClient,
  asset: AssetRow,
): Promise<AssetRow> {
  if (["indexing", "ready"].includes(asset.index_status)) return asset;
  let query = supabase.from("inspiration_assets")
    .update({
      index_status: "indexing",
      index_error: null,
      indexing_version: INDEX_VERSION,
    })
    .eq("id", asset.id)
    .eq("storage_path", asset.storage_path)
    .eq("source", asset.source)
    .eq("rights", asset.rights)
    .eq("usable_for_conditioning", true)
    .in("index_status", ["pending", "failed"]);
  query = asset.profile_id === null
    ? query.is("profile_id", null)
    : query.eq("profile_id", asset.profile_id);
  const { data, error } = await query.select(ASSET_SELECT).maybeSingle();
  if (error || !data) {
    throw new Error(`reference_resume_claim_failed:${asset.id}`);
  }
  return data as AssetRow;
}

async function markAssetsFailed(
  supabase: ServiceClient,
  assetIds: readonly string[],
  errorCode: string,
): Promise<void> {
  if (!assetIds.length) return;
  await supabase.from("inspiration_assets")
    .update({ index_status: "failed", index_error: cleanText(errorCode, 500) })
    .in("id", assetIds)
    .eq("index_status", "indexing");
}

async function persistFinalAsset(
  supabase: ServiceClient,
  asset: PreparedAsset,
  row: VisionDescription,
  textVector: readonly number[],
  visualVector: readonly number[],
): Promise<void> {
  const tags = cleanTags([
    row.scene_type,
    row.time_of_day,
    row.light,
    ...row.vibe_tags,
  ]);
  const values = {
    description: row.description,
    scene_type: row.scene_type,
    time_of_day: row.time_of_day,
    light: row.light,
    palette: row.palette,
    subject_present: row.subject_present,
    tags,
    grade_notes: row.grade_notes,
    embedding: vectorLiteral(textVector),
    visual_embedding: vectorLiteral(visualVector),
    embedding_model: GEMINI_EMBEDDING_MODEL,
    indexing_version: INDEX_VERSION,
    index_status: "ready",
    index_error: null,
    content_sha256: asset.originalSha256,
    conditioning_sha256: asset.conditioningSha256,
    conditioning_storage_bucket: asset.conditioningBucket,
    conditioning_storage_path: asset.conditioningPath,
    mime_type: asset.conditioningMime,
    byte_size: asset.conditioningBytes.byteLength,
    indexed_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from("inspiration_assets")
    .update(values)
    .eq("id", asset.id)
    .eq("index_status", "indexing")
    .eq("rights", asset.rights)
    .eq("usable_for_conditioning", true)
    .select("id")
    .maybeSingle();
  if (error) {
    throw new Error(`reference_update_failed:${asset.id}:${error.message}`);
  }
  if (data) return;

  const { data: existing, error: existingError } = await supabase
    .from("inspiration_assets")
    .select(
      "index_status, content_sha256, conditioning_sha256, conditioning_storage_bucket, conditioning_storage_path, embedding_model, indexing_version",
    )
    .eq("id", asset.id)
    .maybeSingle();
  if (
    existingError || !existing || existing.index_status !== "ready" ||
    existing.content_sha256 !== asset.originalSha256 ||
    existing.conditioning_sha256 !== asset.conditioningSha256 ||
    existing.conditioning_storage_bucket !== asset.conditioningBucket ||
    existing.conditioning_storage_path !== asset.conditioningPath ||
    existing.embedding_model !== GEMINI_EMBEDDING_MODEL ||
    existing.indexing_version !== INDEX_VERSION
  ) {
    throw new Error(`reference_update_conflict:${asset.id}`);
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (request.method !== "POST") return json(405, { error: "POST only" });
  if (
    !GEMINI_API_KEY || !/^gemini-[a-z0-9][a-z0-9.-]{0,79}$/i.test(VISION_MODEL)
  ) {
    return json(503, { error: "server_not_configured" });
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceRoleKey) {
    return json(503, { error: "server_not_configured" });
  }
  const supabase = createClient<UntypedDatabase>(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const rpc = rpcInvoker(supabase);
  const user = await authenticatedUser(request, supabase);
  if (!user) return json(401, { error: "unauthorized" });
  const isAdmin = user.app_metadata?.gems_role === "admin" ||
    user.app_metadata?.role === "admin";

  let body: {
    assetIds?: unknown;
    backfill?: unknown;
    batchId?: unknown;
    rightsAttestations?: unknown;
  };
  let parsedBody: unknown;
  try {
    parsedBody = await readJsonBodyWithinLimit(request, MAX_REQUEST_BYTES);
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error);
    if (code === "request_too_large") return json(413, { error: code });
    if (code === "client_aborted") return json(499, { error: code });
    return json(400, { error: "invalid_json" });
  }
  if (!isPlainJsonObject(parsedBody)) return json(400, { error: "invalid_json" });
  body = parsedBody;
  const requestedIds = Array.isArray(body.assetIds)
    ? [...new Set(body.assetIds.map((value) => String(value).toLowerCase()))]
    : [];
  if (
    requestedIds.length > MAX_BATCH ||
    requestedIds.some((id) => !UUID_RE.test(id))
  ) return json(400, { error: "asset_ids_invalid" });
  const backfill = body.backfill === true;
  if (!requestedIds.length && !backfill) {
    return json(400, { error: "asset_ids_required" });
  }
  if (backfill && !isAdmin) return json(403, { error: "admin_required" });
  const batchIdCandidate = cleanText(body.batchId, 128);
  const hasExplicitBatchId = batchIdCandidate.length >= 8;
  const batchId = hasExplicitBatchId ? batchIdCandidate : crypto.randomUUID();
  const failures: Array<{ id: string; error: string }> = [];

  let rightsAttestations: ReturnType<
    typeof parseReferenceRightsAttestationsV1
  >;
  try {
    rightsAttestations = parseReferenceRightsAttestationsV1(
      body.rightsAttestations,
      requestedIds,
      backfill,
    );
  } catch (error) {
    return json(400, {
      error: error instanceof ReferenceRightsAttestationError
        ? error.message
        : "rights_attestations_invalid",
      batchId,
      rightsAttested: 0,
    });
  }
  if (rightsAttestations.length > 0 && !hasExplicitBatchId) {
    return json(400, {
      error: "rights_attestation_batch_id_required",
      batchId,
      rightsAttested: 0,
    });
  }

  let rightsAttested = 0;
  try {
    rightsAttested = (await attestInspirationAssetRightsV1(rpc, {
      profileId: user.id,
      idempotencyKey: `${batchId}:rights`,
      attestations: rightsAttestations,
    })).length;
  } catch (error) {
    const rpcCode = error instanceof ReferenceRightsAttestationError
      ? error.rpcCause?.code
      : undefined;
    const [status, code] = rpcCode === "42501"
      ? [403, "rights_attestation_forbidden"]
      : rpcCode === "23505"
      ? [409, "rights_attestation_conflict"]
      : rpcCode === "22023"
      ? [400, "rights_attestations_invalid"]
      : [503, "rights_attestation_unavailable"];
    return json(status, { error: code, batchId, rightsAttested: 0 });
  }
  const indexingJson = (status: number, value: Record<string, unknown>) =>
    json(status, { ...value, rightsAttested });

  // Concrete reaper invocation path: every valid authenticated indexing
  // request performs one bounded, best-effort service-role sweep before run
  // lookup. No remote cron or schedule is registered by this function.
  try {
    await reapStaleReferenceIndexWork(rpc, {
      limit: 10,
      reservationGraceSeconds: 900,
    });
  } catch (error) {
    console.warn("reference index reaper unavailable", {
      error: cleanText(error instanceof Error ? error.message : error, 200),
    });
  }

  let existingRun: ExistingRun | null;
  try {
    existingRun = await findExistingRun(supabase, user.id, batchId);
  } catch (error) {
    return indexingJson(503, {
      error: cleanText((error as Error).message, 120),
      batchId,
    });
  }

  let manifest: ReferenceManifest;
  let runId: string;
  let prepared: PreparedAsset[];
  if (existingRun) {
    try {
      if (existingRun.indexing_version !== INDEX_VERSION) {
        throw new Error("reference_index_version_drift");
      }
      manifest = parseManifest(
        existingRun.request_manifest,
        requestedIds,
        backfill,
      );
      if (existingRun.asset_count !== manifest.assets.length) {
        throw new Error("reference_manifest_count_mismatch");
      }
    } catch (error) {
      return indexingJson(409, {
        error: cleanText((error as Error).message, 120),
        batchId,
      });
    }
    if (existingRun.status === "completed") {
      return indexingJson(200, {
        batchId,
        indexed: 0,
        skipped: requestedIds.length || existingRun.asset_count,
      });
    }
    if (["failed", "indeterminate"].includes(existingRun.status)) {
      await markAssetsFailed(
        supabase,
        manifest.assets.map((asset) => asset.assetId),
        `reference_run_${existingRun.status}`,
      );
      return indexingJson(409, {
        error: `reference_run_${existingRun.status}`,
        batchId,
      });
    }
    try {
      const rows = await loadManifestRows(supabase, manifest);
      prepared = [];
      for (const item of manifest.assets) {
        const row = rows.get(item.assetId)!;
        if (!assetScopeAllowed(row, user.id, isAdmin)) {
          throw new Error(`reference_rights_revoked:${row.id}`);
        }
        const claimed = await ensureManifestAssetClaimed(supabase, row);
        prepared.push(
          await loadPreparedManifestAsset(
            supabase,
            claimed as AssetRow & { source: AssetSource },
            item,
          ),
        );
      }
      runId = existingRun.id;
    } catch (error) {
      return indexingJson(403, {
        error: cleanText((error as Error).message, 120),
        batchId,
      });
    }
  } else {
    let query = supabase.from("inspiration_assets")
      .select(ASSET_SELECT)
      .in("source", ["user_upload", "style_pack"])
      .in("rights", ["owned", "licensed"])
      .eq("usable_for_conditioning", true)
      .in("index_status", ["pending", "failed"])
      .is("embedding", null)
      .order("id", { ascending: true })
      .limit(MAX_BATCH);
    if (requestedIds.length) query = query.in("id", requestedIds);
    if (!isAdmin) {
      query = query.eq("profile_id", user.id).eq("source", "user_upload");
    }
    const { data: candidates, error } = await query;
    if (error) {
      return indexingJson(503, {
        error: "reference_state_unavailable",
        batchId,
      });
    }

    const persisted: PreparedAsset[] = [];
    for (const candidate of (candidates ?? []) as AssetRow[]) {
      if (!assetScopeAllowed(candidate, user.id, isAdmin)) continue;
      try {
        persisted.push(await prepareAndPersistAsset(supabase, candidate));
      } catch (error) {
        const code = cleanText((error as Error).message, 120) ||
          "reference_prepare_failed";
        failures.push({ id: candidate.id, error: code });
        await supabase.from("inspiration_assets")
          .update({ index_status: "failed", index_error: code })
          .eq("id", candidate.id)
          .in("index_status", ["pending", "failed"]);
      }
    }

    prepared = [];
    for (const candidate of persisted) {
      try {
        const claimed = await claimNewAsset(supabase, candidate);
        if (claimed) {
          prepared.push({ ...candidate, ...claimed, source: candidate.source });
        }
      } catch (error) {
        failures.push({
          id: candidate.id,
          error: cleanText((error as Error).message, 120) ||
            "reference_claim_failed",
        });
      }
    }
    if (!prepared.length) {
      return indexingJson(200, {
        batchId,
        indexed: 0,
        skipped: requestedIds.length,
        ...(failures.length ? { failures } : {}),
      });
    }
    manifest = buildManifest(prepared, requestedIds, backfill);
    try {
      const reserved = await reserveReferenceIndexRun(rpc, {
        requestedBy: user.id,
        idempotencyKey: batchId,
        requestManifest: manifest as unknown as Record<string, unknown>,
        indexingVersion: INDEX_VERSION,
      });
      runId = reserved.runId;
      if (["failed", "indeterminate"].includes(reserved.status)) {
        throw new Error(`reference_run_${reserved.status}`);
      }
      if (reserved.status === "completed") {
        return indexingJson(200, {
          batchId,
          indexed: 0,
          skipped: prepared.length,
        });
      }
    } catch (error) {
      // The reserve RPC may have committed despite a transport error. Preserve
      // `indexing` if read-back is unknown or finds the run. If authoritative
      // read-back finds no run, release the claims as failed so they can retry.
      let readBack: ExistingRun | null | undefined;
      try {
        readBack = await findExistingRun(supabase, user.id, batchId);
      } catch {
        readBack = undefined;
      }
      if (readBack === null) {
        await markAssetsFailed(
          supabase,
          prepared.map((asset) => asset.id),
          "reference_run_reservation_failed",
        );
      }
      return indexingJson(503, {
        error: cleanText((error as Error).message, 120) ||
          "reference_run_reservation_unknown",
        batchId,
        failures,
      });
    }
  }

  const claim = await claimReferenceIndexRun(rpc, {
    runId,
    requestedBy: user.id,
  }).catch((error) => ({
    claimed: false,
    status: `error:${cleanText((error as Error).message, 100)}`,
    attemptNumber: 0,
    leaseToken: null,
    leaseExpiresAt: null,
  }));
  if (!claim.claimed || !claim.leaseToken) {
    if (claim.status === "completed") {
      return indexingJson(200, {
        batchId,
        indexed: 0,
        skipped: requestedIds.length || prepared.length,
      });
    }
    const terminal = ["completed", "failed", "indeterminate"].includes(
      claim.status,
    );
    if (["failed", "indeterminate"].includes(claim.status)) {
      await markAssetsFailed(
        supabase,
        prepared.map((asset) => asset.id),
        `reference_run_${claim.status}`,
      );
    }
    if (!terminal && claim.status === "processing") {
      return indexingJson(200, {
        batchId,
        indexed: 0,
        skipped: requestedIds.length || prepared.length,
      });
    }
    return indexingJson(terminal ? 409 : 503, {
      error: terminal
        ? `reference_run_${claim.status}`
        : "reference_state_unavailable",
      batchId,
    });
  }

  const stageBase = {
    rpc,
    runId,
    requestedBy: user.id,
    attemptNumber: claim.attemptNumber,
    leaseToken: claim.leaseToken,
    createCallId: () => crypto.randomUUID(),
    classifyFailure: providerFailure,
  };
  const assetIds = prepared.map((asset) => asset.id);

  try {
    await revalidatePreparedRights(supabase, prepared, user.id, isAdmin);
    const visionRequestHash = await sha256ReferenceIndexJsonV1({
      schema: "reference-vision-request-v1",
      modelRef: VISION_MODEL,
      promptVersion: VISION_PROMPT_VERSION,
      assets: prepared.map((asset) => ({
        assetId: asset.id,
        conditioningSha256: asset.conditioningSha256,
        mimeType: asset.conditioningMime,
      })),
    } as ReferenceIndexJson);
    const visionStage = await runReferenceIndexProviderStageV1({
      ...stageBase,
      stage: "vision",
      callOrdinal: 0,
      modelRef: VISION_MODEL,
      requestHash: visionRequestHash,
      decodeResponse: (payload) => decodeVisionPayload(payload, assetIds),
      invokeOnce: async () => {
        const result = await describeBatchOnce(prepared, request.signal);
        const promptTokens = usageUnits(result.usage);
        const outputTokens = Number(result.usage.candidatesTokenCount ?? 0);
        const safeOutputTokens =
          Number.isSafeInteger(outputTokens) && outputTokens >= 0
            ? outputTokens
            : 0;
        const pricing = priceReferenceVisionUsageV1({
          inputUnits: promptTokens,
          outputUnits: safeOutputTokens,
          inputMicroUsdPerMillion: Deno.env.get(
            "REFERENCE_VISION_INPUT_MICROUSD_PER_M_TOKEN",
          ),
          outputMicroUsdPerMillion: Deno.env.get(
            "REFERENCE_VISION_OUTPUT_MICROUSD_PER_M_TOKEN",
          ),
        });
        return {
          value: result.rows,
          ledger: {
            responsePayload: {
              schema: "reference-vision-result-v1",
              rows: result.rows,
            },
            providerRequestId: result.responseId,
            inputUnits: promptTokens,
            outputUnits: safeOutputTokens,
            costMicros: pricing.costMicros,
            providerMeta: {
              usage: result.usage,
              imageCount: prepared.length,
              promptVersion: VISION_PROMPT_VERSION,
              pricingStatus: pricing.pricingStatus,
              pricingVersion: pricing.pricingVersion,
              ...(pricing.pricingStatus === "unpriced"
                ? { unpricedReason: pricing.unpricedReason }
                : {}),
            },
          },
        };
      },
    });
    const rows = visionStage.value;
    const byId = new Map(rows.map((row) => [row.asset_id, row]));
    const documents = prepared.map((asset) =>
      buildRetrievalDocument(byId.get(asset.id)!)
    );

    await revalidatePreparedRights(supabase, prepared, user.id, isAdmin);
    const textRequestHash = await sha256ReferenceIndexJsonV1({
      schema: "reference-text-embedding-request-v1",
      modelRef: GEMINI_EMBEDDING_MODEL,
      taskType: "RETRIEVAL_DOCUMENT",
      documentVersion: RETRIEVAL_DOCUMENT_VERSION,
      documents: prepared.map((asset, index) => ({
        assetId: asset.id,
        document: documents[index],
      })),
    } as ReferenceIndexJson);
    const textStage = await runReferenceIndexProviderStageV1({
      ...stageBase,
      stage: "text_embedding",
      callOrdinal: 0,
      modelRef: GEMINI_EMBEDDING_MODEL,
      requestHash: textRequestHash,
      decodeResponse: (payload) =>
        decodeEmbeddingPayload(
          payload,
          "reference-text-embedding-result-v1",
          assetIds,
        ),
      invokeOnce: async () => {
        const result = await batchEmbedGeminiContents(
          GEMINI_API_KEY,
          documents.map((document) => [{ text: document }]),
          request.signal,
        );
        const vectors = result.embeddings.map((vector) => [...vector]);
        const inputUnits = usageUnits(result.usageMetadata);
        return {
          value: vectors,
          ledger: {
            responsePayload: {
              schema: "reference-text-embedding-result-v1",
              assetIds,
              vectors,
            },
            providerRequestId: result.providerRequestId,
            inputUnits,
            outputUnits: 0,
            costMicros: Math.ceil(
              inputUnits * EMBEDDING_TEXT_MICRO_USD_PER_M_TOKEN / 1_000_000,
            ),
            providerMeta: {
              usage: result.usageMetadata,
              taskType: "RETRIEVAL_DOCUMENT",
              documentVersion: RETRIEVAL_DOCUMENT_VERSION,
              dimensions: result.dimensions,
              pricingStatus: "priced",
              pricingVersion: "google-2026-08",
            },
          },
        };
      },
    });

    const visualById = new Map<string, number[]>();
    for (
      let offset = 0;
      offset < prepared.length;
      offset += GEMINI_EMBEDDING_MAX_IMAGES_PER_CALL
    ) {
      const chunk = prepared.slice(
        offset,
        offset + GEMINI_EMBEDDING_MAX_IMAGES_PER_CALL,
      );
      const chunkIds = chunk.map((asset) => asset.id);
      const ordinal = Math.floor(offset / GEMINI_EMBEDDING_MAX_IMAGES_PER_CALL);
      await revalidatePreparedRights(supabase, chunk, user.id, isAdmin);
      const requestHash = await sha256ReferenceIndexJsonV1({
        schema: "reference-visual-embedding-request-v1",
        modelRef: GEMINI_EMBEDDING_MODEL,
        assets: chunk.map((asset) => ({
          assetId: asset.id,
          conditioningSha256: asset.conditioningSha256,
          mimeType: asset.conditioningMime,
        })),
      } as ReferenceIndexJson);
      const visualStage = await runReferenceIndexProviderStageV1({
        ...stageBase,
        stage: "visual_embedding",
        callOrdinal: ordinal,
        modelRef: GEMINI_EMBEDDING_MODEL,
        requestHash,
        decodeResponse: (payload) =>
          decodeEmbeddingPayload(
            payload,
            "reference-visual-embedding-result-v1",
            chunkIds,
          ),
        invokeOnce: async () => {
          const result = await batchEmbedGeminiContents(
            GEMINI_API_KEY,
            chunk.map((asset) => [
              imageEmbeddingPart(
                asset.conditioningBytes,
                asset.conditioningMime,
              ),
            ]),
            request.signal,
          );
          const vectors = result.embeddings.map((vector) => [...vector]);
          return {
            value: vectors,
            ledger: {
              responsePayload: {
                schema: "reference-visual-embedding-result-v1",
                assetIds: chunkIds,
                vectors,
              },
              providerRequestId: result.providerRequestId,
              inputUnits: chunk.length,
              outputUnits: 0,
              costMicros: chunk.length * EMBEDDING_IMAGE_MICRO_USD,
              providerMeta: {
                usage: result.usageMetadata,
                imageCount: chunk.length,
                dimensions: result.dimensions,
                pricingStatus: "priced",
                pricingVersion: "google-2026-08",
              },
            },
          };
        },
      });
      visualStage.value.forEach((vector, index) => {
        visualById.set(chunkIds[index], vector);
      });
    }

    for (let index = 0; index < prepared.length; index++) {
      const asset = prepared[index];
      await persistFinalAsset(
        supabase,
        asset,
        byId.get(asset.id)!,
        textStage.value[index],
        visualById.get(asset.id)!,
      );
    }
    await completeReferenceIndexRun(rpc, {
      runId,
      requestedBy: user.id,
      attemptNumber: claim.attemptNumber,
      leaseToken: claim.leaseToken,
    });
    return indexingJson(200, {
      batchId,
      indexed: prepared.length,
      failures,
    });
  } catch (error) {
    const code = cleanText(
      error instanceof ReferenceIndexOrchestratorError
        ? error.code
        : error instanceof GeminiEmbeddingError
        ? error.code
        : error instanceof VisionProviderError
        ? error.code
        : (error as Error).message,
      100,
    ) || "reference_index_failed";
    const detail = cleanText(
      error instanceof Error ? error.message : error,
      1_000,
    ) || code;
    let durableStatus: string | null = null;
    try {
      const transition = await failClaimedReferenceIndexRunBeforeProviderV1({
        rpc,
        runId,
        requestedBy: user.id,
        attemptNumber: claim.attemptNumber,
        leaseToken: claim.leaseToken,
        errorCode: code,
        errorDetail: detail,
      });
      durableStatus = transition.status;
    } catch (failureError) {
      // A transport failure may hide a committed idempotent fail transition.
      // Read back once; otherwise preserve indexing for the bounded reaper.
      console.warn("reference pre-provider failure commit unknown", {
        runId,
        error: cleanText(
          failureError instanceof Error ? failureError.message : failureError,
          200,
        ),
      });
      try {
        const state = await getReferenceIndexRunState(rpc, {
          runId,
          requestedBy: user.id,
        });
        durableStatus = String(state.status);
      } catch {
        durableStatus = null;
      }
    }
    if (
      durableStatus !== null &&
      ["failed", "indeterminate"].includes(durableStatus)
    ) {
      await markAssetsFailed(supabase, assetIds, code);
    }
    console.error("reference indexing failed", { runId, batchId, code, error });
    const recoveryRequired = error instanceof ReferenceIndexOrchestratorError;
    return indexingJson(recoveryRequired ? 503 : 502, {
      error: code,
      batchId,
      failures,
    });
  }
});
