export type ConditioningImageMime = "image/jpeg" | "image/png";

export interface InspectedConditioningImage {
  mimeType: ConditioningImageMime;
  width: number;
  height: number;
}

export class ConditioningImageError extends Error {
  constructor(
    readonly code:
      | "unsupported_mime"
      | "invalid_container"
      | "invalid_dimensions",
    message: string,
  ) {
    super(message);
    this.name = "ConditioningImageError";
  }
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const MAX_EDGE = 1_024;
const MIN_EDGE = 64;
const MAX_PIXELS = 1_048_576;

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000 +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  ) >>> 0;
}

function assertDimensions(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < MIN_EDGE ||
    height < MIN_EDGE ||
    width > MAX_EDGE ||
    height > MAX_EDGE ||
    width * height > MAX_PIXELS
  ) {
    throw new ConditioningImageError(
      "invalid_dimensions",
      "conditioning image dimensions are outside policy bounds",
    );
  }
}

let crcTable: Uint32Array | null = null;
function pngCrc32(bytes: Uint8Array, start: number, end: number): number {
  if (crcTable === null) {
    crcTable = new Uint32Array(256);
    for (let value = 0; value < 256; value += 1) {
      let current = value;
      for (let bit = 0; bit < 8; bit += 1) {
        current = (current & 1) !== 0
          ? 0xedb88320 ^ (current >>> 1)
          : current >>> 1;
      }
      crcTable[value] = current >>> 0;
    }
  }
  const table = crcTable;
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc = table[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunkType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3],
  );
}

function validPngColorDepth(colorType: number, bitDepth: number): boolean {
  const allowed = new Map<number, readonly number[]>([
    [0, [1, 2, 4, 8, 16]],
    [2, [8, 16]],
    [3, [1, 2, 4, 8]],
    [4, [8, 16]],
    [6, [8, 16]],
  ]);
  return allowed.get(colorType)?.includes(bitDepth) === true;
}

function inspectPng(bytes: Uint8Array): InspectedConditioningImage {
  if (
    bytes.byteLength < 57 ||
    !PNG_SIGNATURE.every((value, index) => bytes[index] === value)
  ) {
    throw new ConditioningImageError("invalid_container", "invalid PNG signature");
  }

  let offset: number = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let sawHeader = false;
  let sawPalette = false;
  let sawImageData = false;
  let imageDataEnded = false;
  let sawEnd = false;

  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) {
      throw new ConditioningImageError("invalid_container", "truncated PNG chunk");
    }
    const length = readUint32(bytes, offset);
    const typeOffset = offset + 4;
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataOffset || chunkEnd > bytes.byteLength) {
      throw new ConditioningImageError("invalid_container", "invalid PNG chunk length");
    }
    const type = pngChunkType(bytes, typeOffset);
    if (!/^[A-Za-z]{4}$/.test(type)) {
      throw new ConditioningImageError("invalid_container", "invalid PNG chunk type");
    }
    const expectedCrc = readUint32(bytes, dataEnd);
    const actualCrc = pngCrc32(bytes, typeOffset, dataEnd);
    if (expectedCrc !== actualCrc) {
      throw new ConditioningImageError("invalid_container", `PNG ${type} CRC mismatch`);
    }

    if (!sawHeader && type !== "IHDR") {
      throw new ConditioningImageError("invalid_container", "PNG IHDR must be first");
    }
    if (type === "IHDR") {
      if (sawHeader || length !== 13) {
        throw new ConditioningImageError("invalid_container", "invalid PNG IHDR");
      }
      width = readUint32(bytes, dataOffset);
      height = readUint32(bytes, dataOffset + 4);
      const bitDepth = bytes[dataOffset + 8];
      colorType = bytes[dataOffset + 9];
      if (
        !validPngColorDepth(colorType, bitDepth) ||
        bytes[dataOffset + 10] !== 0 ||
        bytes[dataOffset + 11] !== 0 ||
        ![0, 1].includes(bytes[dataOffset + 12])
      ) {
        throw new ConditioningImageError("invalid_container", "unsupported PNG IHDR");
      }
      assertDimensions(width, height);
      sawHeader = true;
    } else if (type === "PLTE") {
      if (sawPalette || sawImageData || length < 3 || length > 768 || length % 3 !== 0) {
        throw new ConditioningImageError("invalid_container", "invalid PNG palette");
      }
      sawPalette = true;
    } else if (type === "IDAT") {
      if (imageDataEnded || length === 0) {
        throw new ConditioningImageError("invalid_container", "invalid PNG IDAT sequence");
      }
      sawImageData = true;
    } else {
      if (sawImageData) imageDataEnded = true;
      const isCritical = type.charCodeAt(0) >= 65 && type.charCodeAt(0) <= 90;
      if (isCritical && type !== "IEND") {
        throw new ConditioningImageError(
          "invalid_container",
          `unknown critical PNG chunk ${type}`,
        );
      }
    }

    if (type === "IEND") {
      if (length !== 0 || !sawImageData || chunkEnd !== bytes.byteLength) {
        throw new ConditioningImageError("invalid_container", "invalid PNG IEND");
      }
      sawEnd = true;
      offset = chunkEnd;
      break;
    }
    offset = chunkEnd;
  }

  if (!sawHeader || !sawImageData || !sawEnd || (colorType === 3 && !sawPalette)) {
    throw new ConditioningImageError("invalid_container", "incomplete PNG container");
  }
  return { mimeType: "image/png", width, height };
}

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function inspectJpeg(bytes: Uint8Array): InspectedConditioningImage {
  if (bytes.byteLength < 128 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new ConditioningImageError("invalid_container", "invalid JPEG SOI");
  }

  let offset = 2;
  let inEntropyScan = false;
  let sawFrame = false;
  let sawScan = false;
  let width = 0;
  let height = 0;

  while (offset < bytes.byteLength) {
    let marker: number;
    if (inEntropyScan) {
      while (offset < bytes.byteLength && bytes[offset] !== 0xff) offset += 1;
      if (offset >= bytes.byteLength) break;
      while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.byteLength) break;
      marker = bytes[offset];
      offset += 1;
      if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      inEntropyScan = false;
    } else {
      if (bytes[offset] !== 0xff) {
        throw new ConditioningImageError("invalid_container", "invalid JPEG marker prefix");
      }
      while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.byteLength) break;
      marker = bytes[offset];
      offset += 1;
    }

    if (marker === 0xd9) {
      if (!sawFrame || !sawScan || offset !== bytes.byteLength) {
        throw new ConditioningImageError("invalid_container", "invalid JPEG EOI");
      }
      return { mimeType: "image/jpeg", width, height };
    }
    if (marker === 0xd8 || marker === 0x00 || marker === 0xff) {
      throw new ConditioningImageError("invalid_container", "unexpected JPEG marker");
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.byteLength) {
      throw new ConditioningImageError("invalid_container", "truncated JPEG segment");
    }
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) {
      throw new ConditioningImageError("invalid_container", "invalid JPEG segment length");
    }
    const dataOffset = offset + 2;

    if (JPEG_SOF_MARKERS.has(marker)) {
      if (sawFrame || segmentLength < 11) {
        throw new ConditioningImageError("invalid_container", "invalid JPEG frame");
      }
      const precision = bytes[dataOffset];
      height = (bytes[dataOffset + 1] << 8) | bytes[dataOffset + 2];
      width = (bytes[dataOffset + 3] << 8) | bytes[dataOffset + 4];
      const components = bytes[dataOffset + 5];
      if (
        ![8, 12].includes(precision) ||
        components < 1 ||
        components > 4 ||
        segmentLength !== 8 + 3 * components
      ) {
        throw new ConditioningImageError("invalid_container", "unsupported JPEG frame");
      }
      assertDimensions(width, height);
      sawFrame = true;
    }
    if (marker === 0xda) {
      const scanComponents = bytes[dataOffset];
      if (
        !sawFrame ||
        scanComponents < 1 ||
        scanComponents > 4 ||
        segmentLength !== 6 + 2 * scanComponents
      ) {
        throw new ConditioningImageError("invalid_container", "invalid JPEG scan");
      }
      sawScan = true;
      inEntropyScan = true;
    }
    offset += segmentLength;
  }

  throw new ConditioningImageError("invalid_container", "JPEG is missing a valid EOI");
}

export function inspectConditioningImage(
  bytes: Uint8Array,
  declaredMimeType?: string | null,
): InspectedConditioningImage {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 4 * 1024 * 1024) {
    throw new ConditioningImageError(
      "invalid_container",
      "conditioning image byte length is invalid",
    );
  }
  const detected = bytes[0] === 0xff && bytes[1] === 0xd8
    ? "image/jpeg"
    : PNG_SIGNATURE.every((value, index) => bytes[index] === value)
    ? "image/png"
    : null;
  if (detected === null) {
    throw new ConditioningImageError("unsupported_mime", "unsupported image signature");
  }
  if (declaredMimeType && declaredMimeType !== detected) {
    throw new ConditioningImageError(
      "unsupported_mime",
      "declared and detected image MIME types differ",
    );
  }
  return detected === "image/png" ? inspectPng(bytes) : inspectJpeg(bytes);
}
