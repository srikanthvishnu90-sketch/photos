import { inspectConditioningImage } from "./strict-conditioning-image-v1.ts";

export const CONDITIONING_BUCKET = "inspiration-conditioning" as const;

interface StorageErrorLike {
  message: string;
  statusCode?: string | number;
}

interface StorageResultLike {
  data: unknown;
  error: StorageErrorLike | null;
}

interface ConditioningStorageClient {
  storage: {
    from(bucket: string): {
      upload(
        path: string,
        body: Uint8Array,
        options: {
          contentType: string;
          cacheControl: string;
          upsert: boolean;
        },
      ): PromiseLike<StorageResultLike>;
      download(path: string): PromiseLike<StorageResultLike>;
    };
  };
}

export interface PersistedConditioningObject {
  bucket: typeof CONDITIONING_BUCKET;
  path: string;
  sha256: string;
  mimeType: "image/jpeg" | "image/png";
  width: number;
  height: number;
  byteLength: number;
  created: boolean;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into an ArrayBuffer-backed view: Deno's WebCrypto BufferSource type
  // rejects the wider Uint8Array<ArrayBufferLike> shape (which may wrap a
  // SharedArrayBuffer) even though ordinary callers provide safe bytes.
  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", digestInput);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function duplicateObjectError(error: StorageErrorLike): boolean {
  const status = Number(error.statusCode);
  return status === 409 || /already exists|duplicate/i.test(error.message);
}

export async function persistConditioningObject(
  client: ConditioningStorageClient,
  input: {
    assetId: string;
    source: "user_upload" | "style_pack";
    profileId: string | null;
    bytes: Uint8Array;
    declaredMimeType?: string | null;
  },
): Promise<PersistedConditioningObject> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.assetId)) {
    throw new Error("conditioning_asset_id_invalid");
  }
  if (input.source === "user_upload" && !input.profileId) {
    throw new Error("conditioning_profile_id_required");
  }
  const inspected = inspectConditioningImage(
    input.bytes,
    input.declaredMimeType ?? null,
  );
  const sha256 = await sha256Hex(input.bytes);
  const extension = inspected.mimeType === "image/jpeg" ? "jpg" : "png";
  const prefix = input.source === "style_pack"
    ? "style-pack"
    : `${input.profileId}/reference`;
  const path = `${prefix}/${input.assetId}/${sha256}.${extension}`;
  const bucket = client.storage.from(CONDITIONING_BUCKET);
  const upload = await bucket.upload(path, input.bytes, {
    contentType: inspected.mimeType,
    cacheControl: "31536000, immutable",
    upsert: false,
  });
  if (!upload.error) {
    return {
      bucket: CONDITIONING_BUCKET,
      path,
      sha256,
      mimeType: inspected.mimeType,
      width: inspected.width,
      height: inspected.height,
      byteLength: input.bytes.byteLength,
      created: true,
    };
  }
  if (!duplicateObjectError(upload.error)) {
    throw new Error(`conditioning_upload_failed:${upload.error.message}`);
  }

  // A deterministic-path replay is safe only if the existing object contains
  // the exact same bytes. Never overwrite a conflicting object.
  const existing = await bucket.download(path);
  if (existing.error || !(existing.data instanceof Blob)) {
    throw new Error(
      `conditioning_replay_download_failed:${existing.error?.message ?? "no blob"}`,
    );
  }
  const existingBytes = new Uint8Array(await existing.data.arrayBuffer());
  if (await sha256Hex(existingBytes) !== sha256) {
    throw new Error("conditioning_storage_hash_conflict");
  }
  return {
    bucket: CONDITIONING_BUCKET,
    path,
    sha256,
    mimeType: inspected.mimeType,
    width: inspected.width,
    height: inspected.height,
    byteLength: input.bytes.byteLength,
    created: false,
  };
}
