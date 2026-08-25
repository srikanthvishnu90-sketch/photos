// gems-memories-view.js — the Memories studio. Reads capture time + GPS from
// your photos on-device, clusters them into real events (trips, weekends, days),
// and surfaces them as auto-albums with a strongest-photo cover. All on-device;
// nothing leaves the phone. Self-contained overlay; never throws.
import { listPhotos, getPhotoBlob } from "./gems-photolib.js";
import { ensureCaptureMeta, buildMemories } from "./gems-memories.js";

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const META_LIMIT = 150; // EXIF reads per open (on-device, best-effort)

export async function openMemories() {
  if (typeof document === "undefined") return;
  document.querySelector(".memories-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.className = "memories-overlay commit-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  document.body.append(overlay);
  const close = () => overlay.remove();

  const state = { photos: [], memories: [], building: true, open: null };
  const urlFor = (id) => state.photos.find((p) => p.id === id)?.url ?? "";

  try { state.photos = await listPhotos(); } catch { state.photos = []; }

  function render() {
    const detail = state.open ? state.memories.find((m) => m.id === state.open) : null;
    overlay.innerHTML = `
      <header class="commit-topbar">
        ${detail ? `<button class="commit-close" data-back type="button" aria-label="Back">‹ Memories</button>` : `<h2 class="commit-title">Memories</h2>`}
        <button class="commit-close" type="button" aria-label="Close">✕</button>
      </header>
      <div class="commit-body">
        ${
          detail
            ? `<h2 class="commit-title" style="margin:0 0 4px">${esc(detail.title)}</h2>
               <p class="commit-hint">${detail.size} photos</p>
               <div class="mem-photos">
                 ${detail.photoIds.map((id) => `<button class="mem-photo" type="button" data-photo="${esc(id)}"><img src="${esc(urlFor(id))}" alt="" loading="lazy"></button>`).join("")}
               </div>`
            : `<p class="commit-hint">Gems groups your photos into real moments — trips, weekends, days out — from when and where they were taken, <strong>all on your device</strong>.</p>
               ${
                 state.building
                   ? `<p class="commit-status" data-mem-status>Building your memories…</p>`
                   : state.memories.length
                     ? `<div class="mem-grid">
                          ${state.memories.map((m) => `
                            <button class="mem-card" type="button" data-mem="${esc(m.id)}">
                              <div class="mem-cover">${m.coverId ? `<img src="${esc(urlFor(m.coverId))}" alt="" loading="lazy">` : ""}</div>
                              <div class="mem-title">${esc(m.title)}</div>
                              <div class="mem-count">${m.size} photos${m.hasGeo ? " · 📍" : ""}</div>
                            </button>`).join("")}
                        </div>`
                     : `<p class="commit-hint">No multi-photo moments found yet. Import more of your camera roll (with its original photos, so capture dates come through) and check back.</p>`
               }`
        }
      </div>
    `;
    overlay.querySelectorAll(".commit-close").forEach((b) => b.addEventListener("click", close));
    overlay.querySelector("[data-back]")?.addEventListener("click", (e) => {
      e.stopPropagation();
      state.open = null;
      render();
    });
    overlay.querySelectorAll("[data-mem]").forEach((b) =>
      b.addEventListener("click", () => { state.open = b.dataset.mem; render(); }),
    );
    // (photo tap could open the editor later; kept read-only here.)
  }

  render();

  // Build in the background: read EXIF for photos missing it, then cluster.
  (async () => {
    try {
      await ensureCaptureMeta(state.photos, (id) => getPhotoBlob(id), META_LIMIT);
      state.memories = buildMemories(state.photos);
    } catch (error) {
      console.info("memories build failed", error);
      state.memories = [];
    }
    state.building = false;
    if (!state.open) render();
  })();

  window.addEventListener("keydown", function onKey(e) {
    if (e.key === "Escape") { close(); window.removeEventListener("keydown", onKey); }
  });
}
