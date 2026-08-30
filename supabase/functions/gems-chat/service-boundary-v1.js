// Pure, dependency-free guards used by gems-chat. Keeping these helpers on Web
// APIs only lets the byte, abort, and untrusted-JSON behavior run offline.

const VALID_INTENTS = new Set(["find", "build", "edit", "inspire", "chat", "generate"]);
const VALID_SCREENS = new Set(["Photos", "Studio", "Editor", "Discover"]);
const VALID_PURPOSES = new Set(["cover", "dump", "dating", "profile", "graphic", "general"]);
const VALID_PACKS = new Set([
  "dating", "euro-summer", "dubai", "old-money", "luxury-cars", "beach-club",
  "boat", "dark-luxe", "after-dark",
]);
const REQUIRED_CONTRACT_KEYS = [
  "intent", "reply", "action", "clarify", "editInstruction", "rankRequest", "photos", "generate",
];

export function isJsonRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizedMimeType(value) {
  const mimeType = String(value ?? "").toLowerCase().split(";", 1)[0].trim();
  return mimeType === "image/jpg" ? "image/jpeg" : mimeType;
}

export function isJsonMediaType(value) {
  const mimeType = normalizedMimeType(value);
  return mimeType === "application/json" || mimeType.endsWith("+json");
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

export function imageMimeMatchesBase64(mimeType, base64) {
  let prefix;
  try {
    prefix = Uint8Array.from(atob(base64.slice(0, 24)), (char) => char.charCodeAt(0));
  } catch {
    return false;
  }
  const ascii = (...values) => values.every((value, index) => prefix[index] === value);
  if (mimeType === "image/jpeg") return ascii(0xff, 0xd8, 0xff);
  if (mimeType === "image/png") return ascii(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (mimeType === "image/gif") {
    return ascii(0x47, 0x49, 0x46, 0x38, 0x37, 0x61) ||
      ascii(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);
  }
  if (mimeType === "image/webp") {
    return ascii(0x52, 0x49, 0x46, 0x46) &&
      prefix[8] === 0x57 && prefix[9] === 0x45 && prefix[10] === 0x42 && prefix[11] === 0x50;
  }
  return false;
}

export function jsonUtf8ByteLength(value) {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string") throw new Error("json_value_invalid");
  return new TextEncoder().encode(serialized).byteLength;
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
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joinChunks(chunks, byteLength)));
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
  return new TextDecoder("utf-8", { fatal: true }).decode(joinChunks(chunks, byteLength));
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

export function normalizeConversationHistory(raw, limits) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("history_invalid");
  if (raw.length > limits.maxTurns) throw new Error("history_too_many_turns");
  const messages = [];
  let totalText = 0;
  for (const turn of raw) {
    if (!isJsonRecord(turn) || (turn.role !== "user" && turn.role !== "assistant")) {
      throw new Error("history_invalid");
    }
    if (typeof turn.text !== "string") throw new Error("history_invalid");
    const text = turn.text.trim();
    if (!text) throw new Error("history_invalid");
    if (text.length > limits.maxTextChars) throw new Error("history_turn_too_long");
    totalText += text.length;
    if (totalText > limits.maxTotalTextChars) throw new Error("history_text_too_large");
    const last = messages[messages.length - 1];
    // The rolling client window can begin with the assistant after trimming an
    // older user turn. Drop that orphan rather than forwarding invalid ordering.
    if (!last && turn.role !== "user") continue;
    if (last?.role === turn.role) {
      last.content = text;
    } else {
      messages.push({ role: turn.role, content: text });
    }
  }
  // A previous failed request can leave the client transcript ending in a user
  // turn. Drop that incomplete turn so the new message remains well ordered.
  if (messages[messages.length - 1]?.role === "user") messages.pop();
  return messages;
}

export function parseStrictJsonRecord(text, errorCode = "json_object_invalid") {
  let value;
  try {
    value = JSON.parse(String(text).trim());
  } catch {
    throw new Error(errorCode);
  }
  if (!isJsonRecord(value)) throw new Error(errorCode);
  return value;
}

export function parseAnthropicMessageResponse(text, maxTextChars) {
  const value = parseStrictJsonRecord(text, "anthropic_response_invalid");
  if (value.type !== "message" || value.role !== "assistant" || typeof value.stop_reason !== "string") {
    throw new Error("anthropic_response_invalid");
  }
  if (!Array.isArray(value.content) || !value.content.length || value.content.length > 8) {
    throw new Error("anthropic_response_invalid");
  }
  const textParts = [];
  let textLength = 0;
  for (const block of value.content) {
    if (!isJsonRecord(block) || block.type !== "text" || typeof block.text !== "string") {
      throw new Error("anthropic_response_invalid");
    }
    textLength += block.text.length;
    if (textLength > maxTextChars) throw new Error("anthropic_text_too_large");
    textParts.push(block.text);
  }
  const joined = textParts.join("").trim();
  if (!joined) throw new Error("anthropic_response_invalid");
  return { stopReason: value.stop_reason, text: joined };
}

export function assertChatContractShape(value) {
  if (!isJsonRecord(value) || REQUIRED_CONTRACT_KEYS.some((key) => !Object.hasOwn(value, key))) {
    throw new Error("chat_contract_invalid");
  }
  if (!VALID_INTENTS.has(value.intent) || typeof value.reply !== "string") {
    throw new Error("chat_contract_invalid");
  }
  const reply = value.reply.trim();
  if (!reply || reply.length > 2_000) throw new Error("chat_contract_invalid");
  if (value.action !== null) {
    if (!isJsonRecord(value.action) || !VALID_SCREENS.has(value.action.navigate) ||
      !isJsonRecord(value.action.payload) || jsonUtf8ByteLength(value.action.payload) > 4_096) {
      throw new Error("chat_contract_invalid");
    }
  }
  if (value.clarify !== null) {
    if (!Array.isArray(value.clarify) || value.clarify.length > 2 || value.clarify.some((chip) =>
      !isJsonRecord(chip) || typeof chip.label !== "string" || !chip.label.trim() ||
      chip.label.length > 160 || typeof chip.value !== "string" || !chip.value.trim() ||
      chip.value.length > 400
    )) throw new Error("chat_contract_invalid");
  }
  if (value.editInstruction !== null &&
    (typeof value.editInstruction !== "string" || value.editInstruction.length > 2_000)) {
    throw new Error("chat_contract_invalid");
  }
  if (value.rankRequest !== null) {
    if (!isJsonRecord(value.rankRequest) || typeof value.rankRequest.request !== "string" ||
      !value.rankRequest.request.trim() || value.rankRequest.request.length > 1_000 ||
      !VALID_PURPOSES.has(value.rankRequest.purpose)) {
      throw new Error("chat_contract_invalid");
    }
  }
  if (value.photos !== null &&
    (!Array.isArray(value.photos) || value.photos.length > 8 || value.photos.some((id) =>
      typeof id !== "string" || !id.trim() || id.length > 200
    ))) throw new Error("chat_contract_invalid");
  if (value.generate !== null) {
    if (!isJsonRecord(value.generate) ||
      (value.generate.kind !== "scene" && value.generate.kind !== "commitment") ||
      (value.generate.stylePack !== null && !VALID_PACKS.has(value.generate.stylePack)) ||
      (value.generate.mode !== "me" && value.generate.mode !== "background") ||
      (value.generate.prompt !== null &&
        (typeof value.generate.prompt !== "string" || value.generate.prompt.length > 1_000))) {
      throw new Error("chat_contract_invalid");
    }
  }
  return value;
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
