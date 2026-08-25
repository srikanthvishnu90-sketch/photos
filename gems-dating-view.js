// gems-dating-view.js — the Dating Profile lineup ("select + fill gaps").
// Builds a 6-slot dating profile from the user's OWN library (ranking + face),
// shows which slots are filled and which are missing, and offers to generate ONLY
// the missing slots via the dating scene studio. Self-contained overlay; never throws.
import { buildDatingProfile } from "./gems-ranker.js";
import { getPhotoBlob } from "./gems-photolib.js";

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export async function openDatingProfile() {
  if (typeof document === "undefined") return;
  document.querySelector(".scene-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.className = "scene-overlay commit-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  document.body.append(overlay);
  const close = () => { revoke(); overlay.remove(); };

  const thumbUrls = [];
  const revoke = () => { for (const u of thumbUrls) { try { URL.revokeObjectURL(u); } catch { /* ignore */ } } };

  overlay.innerHTML = `
    <header class="commit-topbar">
      <h2 class="commit-title">Your dating profile</h2>
      <button class="commit-close" type="button" aria-label="Close">✕</button>
    </header>
    <div class="commit-body">
      <div class="commit-result"><div class="scene-generating"><span class="scene-spinner" aria-hidden="true"></span></div>
      <p class="commit-note">Looking through your photos…</p></div>
    </div>`;
  overlay.querySelector(".commit-close").addEventListener("click", close);

  let data = { lineup: [], gaps: [] };
  try { data = await buildDatingProfile(); } catch { data = { lineup: [], gaps: [] }; }

  // Thumbnails for filled slots.
  const thumbFor = async (id) => {
    try {
      const blob = await getPhotoBlob(id);
      if (!blob) return null;
      const url = URL.createObjectURL(blob);
      thumbUrls.push(url);
      return url;
    } catch { return null; }
  };
  for (const s of data.lineup) {
    if (s.record?.id) s.thumb = await thumbFor(s.record.id);
  }

  const filled = data.lineup.filter((s) => s.record);
  const gapSlots = data.lineup.filter((s) => !s.record);
  const gapRecipes = gapSlots.map((s) => s.recipe);
  // Best subject photo for generation = the filled "face" slot, else any filled solo.
  const subjectId =
    data.lineup.find((s) => s.slot === "face" && s.record)?.record?.id ||
    filled.find((s) => s.slot !== "social" && s.slot !== "standout")?.record?.id ||
    filled[0]?.record?.id ||
    null;

  const body = overlay.querySelector(".commit-body");
  if (!data.lineup.length) {
    body.innerHTML = `<p class="commit-hint">Import some photos first, then I can build your dating profile.</p>`;
    return;
  }

  body.innerHTML = `
    <p class="commit-note">A strong profile is a mix of 6. Here's what your library covers — I can generate the missing ones.</p>
    <div class="dating-grid">
      ${data.lineup.map((s) => s.record
        ? `<div class="dating-slot is-filled">
             ${s.thumb ? `<img src="${esc(s.thumb)}" alt="${esc(s.label)}">` : ""}
             <span class="dating-slot-tag">${esc(s.label)}</span>
           </div>`
        : `<div class="dating-slot is-gap">
             <span class="dating-slot-plus">＋</span>
             <span class="dating-slot-tag">${esc(s.label)}</span>
             <span class="dating-slot-missing">Missing</span>
           </div>`).join("")}
    </div>
    <div class="commit-actions">
      ${gapSlots.length
        ? `<button class="commit-btn commit-btn--primary" data-fill type="button">Generate the ${gapSlots.length} missing</button>`
        : `<button class="commit-btn commit-btn--primary" data-all type="button">Looks complete · make a fresh set</button>`}
      ${gapSlots.length ? `<button class="commit-btn" data-all type="button">Make all 6 fresh</button>` : ""}
    </div>
    <p class="commit-note">${filled.length} of 6 slots from your own photos${gapSlots.length ? ` · ${gapSlots.length} to generate` : ""}.</p>`;

  overlay.querySelector(".commit-close").addEventListener("click", close);
  overlay.querySelector("[data-fill]")?.addEventListener("click", async () => {
    close();
    const { openSceneStudio } = await import("./gems-scene-view.js");
    openSceneStudio("dating", { datingRecipes: gapRecipes, photoId: subjectId });
  });
  overlay.querySelector("[data-all]")?.addEventListener("click", async () => {
    close();
    const { openSceneStudio } = await import("./gems-scene-view.js");
    openSceneStudio("dating", { photoId: subjectId });
  });

  window.addEventListener("keydown", function onKey(e) {
    if (e.key === "Escape") { close(); window.removeEventListener("keydown", onKey); }
  });
}
