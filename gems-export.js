// gems-export.js — full-quality photo export: originals zipped byte-for-byte.
// Bytes pass through untouched — never re-encoded, never resized.
// Zero dependencies; safe to import in Node (browser APIs are guarded).

import { buildZip } from "./gems-zip.js";
import { listPhotos, getPhotoBlob, updatePhotoDerived } from "./gems-photolib.js";
import { recordTasteEvent } from "./gems-supabase.js";

const IS_BROWSER =
  typeof document !== "undefined" && typeof URL !== "undefined";

// Strip path separators and control characters; keep the extension.
// Falls back to photo-N.jpg when nothing usable remains.
function sanitizeName(raw, index) {
  try {
    let name = String(raw || "")
      .replace(/[/\\]/g, "-")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim();
    name = name.replace(/^\.+/, ""); // no hidden/relative-looking names
    if (!name) name = `photo-${index + 1}.jpg`;
    return name;
  } catch {
    return `photo-${index + 1}.jpg`;
  }
}

function triggerDownload(blob, filename) {
  if (!IS_BROWSER) {
    console.info("[gems-export] not in a browser; skipping download trigger");
    return false;
  }
  let url = null;
  try {
    url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  } catch (err) {
    console.info("[gems-export] download trigger failed:", err);
    return false;
  } finally {
    if (url) {
      try {
        // Revoke after the click has been handed to the browser.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Export the given photo records (in presentation order) as a ZIP of
 * full-quality originals. Returns { count, skipped } — skipped is the list
 * of ids whose blob was missing. Never throws.
 */
export async function exportPhotos(records, { setName = "gems-export" } = {}) {
  const result = { count: 0, skipped: [] };
  try {
    const list = Array.isArray(records) ? records : [];
    const entries = [];

    for (let i = 0; i < list.length; i++) {
      const rec = list[i] || {};
      let blob = null;
      try {
        blob = await getPhotoBlob(rec.id);
      } catch (err) {
        console.info("[gems-export] getPhotoBlob failed for", rec.id, err);
      }
      if (!blob) {
        result.skipped.push(rec.id);
        continue;
      }
      try {
        const buf = await blob.arrayBuffer();
        const prefix = String(entries.length + 1).padStart(2, "0");
        entries.push({
          name: `${prefix}-${sanitizeName(rec.name, i)}`,
          data: new Uint8Array(buf), // untouched original bytes
        });
      } catch (err) {
        console.info("[gems-export] could not read blob for", rec.id, err);
        result.skipped.push(rec.id);
      }
    }

    result.count = entries.length;
    if (entries.length === 0) {
      console.info("[gems-export] nothing to export for", setName);
      return result;
    }

    const zip = buildZip(entries);
    const downloaded = triggerDownload(zip, `${setName}.zip`);

    if (downloaded) {
      // Mark exported photos so the "Never posted" smart collection becomes
      // real (it excludes derived.exported === true). Best-effort per photo.
      for (const entry of entries.length ? list : []) {
        if (entry && entry.id && !result.skipped.includes(entry.id)) {
          try {
            await updatePhotoDerived(entry.id, { exported: true });
          } catch (err) {
            console.info("[gems-export] exported-flag write failed:", entry.id, err);
          }
        }
      }
      try {
        // North-star instrumentation: this event is the "kept" scoreboard write.
        recordTasteEvent("export_completed", {
          setName,
          count: result.count,
          photoIds: list.map((r) => r && r.id).slice(0, 30),
        });
      } catch (err) {
        console.info("[gems-export] recordTasteEvent failed:", err);
      }
    }

    return result;
  } catch (err) {
    console.info("[gems-export] exportPhotos failed:", err);
    return result;
  }
}

/**
 * Convenience: export every photo in the library, in library order.
 */
export async function exportAll(setName) {
  try {
    const all = await listPhotos();
    return exportPhotos(Array.isArray(all) ? all : [], {
      setName: setName || "gems-export",
    });
  } catch (err) {
    console.info("[gems-export] exportAll failed:", err);
    return { count: 0, skipped: [] };
  }
}
