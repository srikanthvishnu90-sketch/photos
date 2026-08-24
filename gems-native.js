// The single device-photo boundary. Web and native both enter here so the rest
// of the app never has to know how the photos arrived.
//
//  - WEB (today's launchable product): a normal multi-file <input>. iOS Safari
//    has no Select-All, so this is user-picked — honest and functional.
//  - NATIVE (Capacitor iOS shell, built in parallel): a custom PhotoKit plugin,
//    `GemsPhotos`, enumerates the WHOLE library automatically in batches. It is
//    reached purely through the runtime global `window.Capacitor` — this file
//    imports NO npm package, so the web app stays dependency-free and unbroken
//    whether or not the native shell is present.
//
// The native contract (implemented by ios/.../GemsPhotosPlugin.swift):
//   Capacitor.Plugins.GemsPhotos.requestAccess()      -> { status: "granted" | "limited" | "denied" }
//   Capacitor.Plugins.GemsPhotos.count()              -> { count: number }
//   Capacitor.Plugins.GemsPhotos.getBatch({ offset, limit, maxEdge })
//                                                     -> { photos: [{ id, mimeType, base64 }] }
// getBatch returns downscaled JPEGs (maxEdge px) so a 10k-photo roll streams in
// without loading full-res originals into the WebView.

const NATIVE_BATCH = 40; // photos per native getBatch call — streams large rolls smoothly
const NATIVE_MAX_EDGE = 1600; // downscale on the native side; still plenty for analysis + edits

/** Is the custom PhotoKit plugin actually present (i.e. we're in the iOS shell)? */
export function hasNativeLibrary() {
  try {
    const cap = globalThis.Capacitor;
    return Boolean(cap?.isNativePlatform?.() && cap?.Plugins?.GemsPhotos);
  } catch {
    return false;
  }
}

function base64ToFile(id, mimeType, base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const type = mimeType || "image/jpeg";
  const ext = type.includes("png") ? "png" : "jpg";
  // A stable, library-derived name so re-imports dedupe against the same asset.
  return new File([bytes], `photo-${id}.${ext}`, { type });
}

// Full-library enumeration through the native plugin. Streams every asset in
// batches, converting each to a File and reporting progress. Returns File[].
async function enumerateNativeLibrary({ onProgress } = {}) {
  const GemsPhotos = globalThis.Capacitor.Plugins.GemsPhotos;
  const access = await GemsPhotos.requestAccess();
  if (access?.status === "denied") {
    const error = new Error("photo access denied");
    error.code = "denied";
    throw error;
  }
  const { count = 0 } = (await GemsPhotos.count()) ?? {};
  const files = [];
  for (let offset = 0; offset < count; offset += NATIVE_BATCH) {
    const { photos = [] } = await GemsPhotos.getBatch({
      offset,
      limit: NATIVE_BATCH,
      maxEdge: NATIVE_MAX_EDGE,
    });
    for (const photo of photos) {
      if (!photo?.base64) continue;
      try {
        files.push(base64ToFile(photo.id, photo.mimeType, photo.base64));
      } catch (error) {
        console.info("Skipped one native photo", error);
      }
    }
    onProgress?.({ done: Math.min(offset + NATIVE_BATCH, count), total: count });
  }
  return files;
}

// The web path: a transient multi-file picker. Resolves to the chosen File[]
// (empty if the user cancels). We create the input on demand so no dead node
// lingers in the DOM.
function pickWebFiles() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.hidden = true;
    input.tabIndex = -1;
    input.setAttribute("aria-hidden", "true");
    let settled = false;
    const finish = (files) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () => finish([...(input.files ?? [])]));
    // If the picker is dismissed without a selection, resolve empty so callers
    // aren't left hanging. `cancel` is supported on modern iOS/Chrome; the
    // focus fallback covers the rest.
    input.addEventListener("cancel", () => finish([]));
    window.addEventListener(
      "focus",
      () => window.setTimeout(() => finish([...(input.files ?? [])]), 400),
      { once: true },
    );
    document.body.append(input);
    input.click();
  });
}

/**
 * Bring photos in from the device. On the native iOS shell this scans the whole
 * camera roll automatically; on the web it opens the multi-file picker.
 * @param {{ onProgress?: (p: {done:number,total:number}) => void }} [options]
 * @returns {Promise<File[]>}
 */
export async function importFromDevice({ onProgress } = {}) {
  if (hasNativeLibrary()) {
    try {
      return await enumerateNativeLibrary({ onProgress });
    } catch (error) {
      if (error?.code === "denied") throw error; // let the UI explain permissions
      console.info("Native enumeration failed, falling back to picker", error);
    }
  }
  return pickWebFiles();
}
