// gems-zip.js — store-only (no compression) ZIP writer in pure JS.
// Zero dependencies; browser + Node compatible (uses TextEncoder/DataView/Uint8Array only).
// Produces archives that standard tools (`unzip -t`) accept.

// ---------------------------------------------------------------------------
// CRC-32 (IEEE 802.3 polynomial, reflected: 0xEDB88320) with a lazily-built
// 256-entry lookup table.
// ---------------------------------------------------------------------------

let CRC_TABLE = null;

function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  CRC_TABLE = table;
  return table;
}

export function crc32(bytes) {
  const table = crcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// DOS date/time (current date; ZIP stores seconds in 2-second granularity).
// ---------------------------------------------------------------------------

function dosDateTime() {
  try {
    const d = new Date();
    const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
    const dosTime =
      (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate =
      ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { dosTime: dosTime & 0xffff, dosDate: dosDate & 0xffff };
  } catch {
    // Fixed epoch fallback: 1980-01-01 00:00:00.
    return { dosTime: 0, dosDate: (0 << 9) | (1 << 5) | 1 };
  }
}

// ---------------------------------------------------------------------------
// buildZip(entries) -> Blob
// entries: [{ name: string, data: Uint8Array }]
// Store-only (method 0): bytes pass through untouched.
// ---------------------------------------------------------------------------

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const VERSION = 20; // 2.0 — deflate/stored support baseline
const FLAG_UTF8 = 0x0800; // general-purpose bit 11: UTF-8 names

export function buildZip(entries) {
  const encoder = new TextEncoder();
  const { dosTime, dosDate } = dosDateTime();
  const parts = []; // Uint8Array chunks, in file order
  const central = []; // central-directory chunks
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(String(entry.name));
    const data =
      entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data || 0);
    const crc = crc32(data);
    const size = data.length;

    // Local file header (30 bytes fixed + name)
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, SIG_LOCAL, true);
    lv.setUint16(4, VERSION, true); // version needed to extract
    lv.setUint16(6, FLAG_UTF8, true); // general-purpose bit flags
    lv.setUint16(8, 0, true); // method 0 = stored
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true); // compressed size (== uncompressed, stored)
    lv.setUint32(22, size, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra field length
    local.set(nameBytes, 30);

    parts.push(local, data);

    // Central directory header (46 bytes fixed + name)
    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, SIG_CENTRAL, true);
    cv.setUint16(4, VERSION, true); // version made by
    cv.setUint16(6, VERSION, true); // version needed to extract
    cv.setUint16(8, FLAG_UTF8, true);
    cv.setUint16(10, 0, true); // method 0 = stored
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra field length
    cv.setUint16(32, 0, true); // file comment length
    cv.setUint16(34, 0, true); // disk number start
    cv.setUint16(36, 0, true); // internal file attributes
    cv.setUint32(38, 0, true); // external file attributes
    cv.setUint32(42, offset, true); // relative offset of local header
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + data.length;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const cd of central) {
    parts.push(cd);
    cdSize += cd.length;
  }

  // End of central directory record (22 bytes, no comment)
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, SIG_END, true);
  ev.setUint16(4, 0, true); // this disk
  ev.setUint16(6, 0, true); // disk with central directory
  ev.setUint16(8, central.length, true); // entries on this disk
  ev.setUint16(10, central.length, true); // total entries
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdStart, true);
  ev.setUint16(20, 0, true); // comment length
  parts.push(end);

  return new Blob(parts, { type: "application/zip" });
}
