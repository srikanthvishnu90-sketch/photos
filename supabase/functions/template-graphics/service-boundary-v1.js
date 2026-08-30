// Pure service-boundary helpers for template-graphics. This module deliberately
// has no Deno or Supabase dependency so its byte/abort behavior can be exercised
// offline with the standard Web APIs.

export function isJsonRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizedMimeType(value) {
  const mimeType = String(value ?? "").toLowerCase().split(";", 1)[0].trim();
  return mimeType === "image/jpg" ? "image/jpeg" : mimeType;
}

export function base64DecodedLength(base64) {
  if (typeof base64 !== "string") throw new Error("image_base64_invalid");
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  if (
    !base64 || base64.length % 4 === 1 ||
    (padding > 0 && base64.length % 4 !== 0) ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)
  ) {
    throw new Error("image_base64_invalid");
  }
  return Math.floor((base64.length * 3) / 4) - padding;
}

export function assertBase64WithinLimit(base64, maxBytes, tooLargeCode) {
  const decodedLength = base64DecodedLength(base64);
  if (decodedLength > maxBytes) throw new Error(tooLargeCode);
  return decodedLength;
}

export function base64ToBytes(base64, maxBytes, tooLargeCode) {
  assertBase64WithinLimit(base64, maxBytes, tooLargeCode);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function readJsonBodyWithinLimit(request, maxBytes, tooLargeCode) {
  if (!request.body) throw new Error("invalid_json_body");
  const reader = request.body.getReader();
  const chunks = [];
  let byteLength = 0;
  const onAbort = () => {
    void reader.cancel("client_aborted").catch(() => undefined);
  };
  request.signal.addEventListener("abort", onAbort, { once: true });
  if (request.signal.aborted) onAbort();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel(tooLargeCode).catch(() => undefined);
        throw new Error(tooLargeCode);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (request.signal.aborted) throw new Error("client_aborted");
    throw error;
  } finally {
    request.signal.removeEventListener("abort", onAbort);
  }
  if (request.signal.aborted) throw new Error("client_aborted");
  const bytes = joinChunks(chunks, byteLength);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export async function responseTextWithinLimit(response, maxBytes, signal) {
  if (!response.body) throw new Error("provider_response_body_missing");
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body.cancel("provider_response_too_large").catch(() => undefined);
    throw new Error("provider_response_too_large");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;
  const onAbort = () => {
    void reader.cancel(signal.reason ?? "provider_aborted").catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel("provider_response_too_large").catch(() => undefined);
        throw new Error("provider_response_too_large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (signal.aborted) throw new Error(String(signal.reason ?? "provider_aborted"));
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  if (signal.aborted) throw new Error(String(signal.reason ?? "provider_aborted"));
  const bytes = joinChunks(chunks, byteLength);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function createLinkedProviderAbort(clientSignal, timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("provider_timeout_invalid");
  }
  const controller = new AbortController();
  const abortFromClient = () => {
    if (!controller.signal.aborted) controller.abort("client_aborted");
  };
  clientSignal.addEventListener("abort", abortFromClient, { once: true });
  if (clientSignal.aborted) abortFromClient();
  const timeoutId = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort("provider_timeout");
  }, timeoutMs);
  return {
    controller,
    dispose() {
      clearTimeout(timeoutId);
      clientSignal.removeEventListener("abort", abortFromClient);
    },
  };
}

function joinChunks(chunks, byteLength) {
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
