// gems-scene-view.js — the Scene Studio overlay ("put me in a scene", e.g. Euro
// Summer). Pick your selfie + a style pack + optional inspiration references,
// then Gems generates you in that scene. Self-contained overlay; never throws.
import { listPhotos, importPhotoFiles } from "./gems-photolib.js";
import {
  STYLE_PACKS, ASPECTS, generateScene, uploadInspiration, listInspiration, deleteInspiration,
} from "./gems-scenes.js";

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const PROMPT_HINTS = {
  "euro-summer": "walking through a sunlit European old town",
  "after-dark": "on a rooftop at night, city lights behind me",
};

export async function openSceneStudio(defaultPack = "euro-summer") {
  if (typeof document === "undefined") return;
  document.querySelector(".scene-overlay")?.remove();

  const state = {
    photoId: null, pack: defaultPack, prompt: "", aspect: "4:5",
    refs: [], inspiration: [], busy: false, resultUrl: "",
  };

  const overlay = document.createElement("div");
  overlay.className = "scene-overlay commit-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  document.body.append(overlay);
  const close = () => overlay.remove();

  let photos = [];
  try { photos = await listPhotos(); } catch { photos = []; }
  try { state.inspiration = await listInspiration(); } catch { state.inspiration = []; }

  const inspFileInput = document.createElement("input");
  inspFileInput.type = "file";
  inspFileInput.accept = "image/*";
  inspFileInput.multiple = true;
  inspFileInput.hidden = true;
  overlay.append(inspFileInput);

  const render = () => {
    overlay.innerHTML = `
      <header class="commit-topbar">
        <h2 class="commit-title">Put me in a scene</h2>
        <button class="commit-close" type="button" aria-label="Close">✕</button>
      </header>
      <div class="commit-body">
        ${
          state.resultUrl
            ? `<div class="commit-result">
                 <img class="commit-result-img" src="${esc(state.resultUrl)}" alt="Your generated scene" />
                 <div class="commit-actions">
                   <button class="commit-btn" data-again type="button">Try again</button>
                   <button class="commit-btn commit-btn--primary" data-save type="button">Save to my photos</button>
                 </div>
               </div>`
            : `
        <label class="commit-label">1 · A photo of you</label>
        ${
          photos.length
            ? `<div class="commit-photos">${photos.slice(0, 24).map((p) => `<button type="button" class="commit-photo${state.photoId === p.id ? " is-active" : ""}" data-photo="${esc(p.id)}"><img src="${esc(p.url)}" alt="" loading="lazy"></button>`).join("")}</div>`
            : `<p class="commit-hint">Import a photo of yourself first (Home → Import), then come back.</p>`
        }

        <label class="commit-label">2 · Vibe</label>
        <div class="commit-headlines">
          ${STYLE_PACKS.map((s) => `<button type="button" class="commit-chip${state.pack === s.id ? " is-active" : ""}" data-pack="${s.id}">${esc(s.label)}</button>`).join("")}
        </div>

        <label class="commit-label">3 · What are you doing? <span style="font-weight:400;color:var(--color-mauve)">(optional)</span></label>
        <input class="commit-input" data-prompt type="text" maxlength="200" placeholder="${esc(PROMPT_HINTS[state.pack] || "describe the scene")}" value="${esc(state.prompt)}" />

        <label class="commit-label">4 · Inspiration references <span style="font-weight:400;color:var(--color-mauve)">(optional · pick up to 3)</span></label>
        <div class="commit-photos">
          <button type="button" class="commit-photo scene-insp-add" data-add-insp aria-label="Upload inspiration">＋</button>
          ${state.inspiration.map((i) => `<button type="button" class="commit-photo${state.refs.includes(i.id) ? " is-active" : ""}" data-insp="${esc(i.id)}">${i.url ? `<img src="${esc(i.url)}" alt="" loading="lazy">` : ""}</button>`).join("")}
        </div>

        <label class="commit-label">5 · Shape</label>
        <div class="commit-headlines">
          ${ASPECTS.map((a) => `<button type="button" class="commit-chip${state.aspect === a.id ? " is-active" : ""}" data-aspect="${a.id}">${esc(a.label)}</button>`).join("")}
        </div>

        <button class="commit-btn commit-btn--primary commit-generate" data-generate type="button" ${state.photoId && !state.busy ? "" : "disabled"}>
          ${state.busy ? "Generating…" : "Generate my scene"}
        </button>
        <p class="commit-note">Puts YOU in the scene · keeps your face · uses AI. Sign in required.</p>
        <p class="commit-status" data-status></p>`
        }
      </div>
    `;
    wire();
  };

  function wire() {
    overlay.querySelector(".commit-close")?.addEventListener("click", close);
    overlay.querySelectorAll("[data-photo]").forEach((b) =>
      b.addEventListener("click", () => { state.photoId = b.dataset.photo; render(); }),
    );
    overlay.querySelectorAll("[data-pack]").forEach((b) =>
      b.addEventListener("click", () => { state.pack = b.dataset.pack; render(); }),
    );
    overlay.querySelector("[data-prompt]")?.addEventListener("input", (e) => { state.prompt = e.target.value; });
    overlay.querySelectorAll("[data-aspect]").forEach((b) =>
      b.addEventListener("click", () => { state.aspect = b.dataset.aspect; render(); }),
    );
    overlay.querySelectorAll("[data-insp]").forEach((b) =>
      b.addEventListener("click", () => {
        const id = b.dataset.insp;
        if (state.refs.includes(id)) state.refs = state.refs.filter((x) => x !== id);
        else if (state.refs.length < 3) state.refs.push(id);
        render();
      }),
    );
    overlay.querySelector("[data-add-insp]")?.addEventListener("click", () => inspFileInput.click());
    overlay.querySelector("[data-generate]")?.addEventListener("click", () => void generate());
    overlay.querySelector("[data-again]")?.addEventListener("click", () => { state.resultUrl = ""; render(); });
    overlay.querySelector("[data-save]")?.addEventListener("click", () => void saveResult());
  }

  inspFileInput.addEventListener("change", async () => {
    const files = [...(inspFileInput.files ?? [])];
    inspFileInput.value = "";
    if (!files.length) return;
    const status = overlay.querySelector("[data-status]");
    if (status) status.textContent = `Uploading ${files.length} reference${files.length === 1 ? "" : "s"}…`;
    for (const f of files.slice(0, 20)) {
      const r = await uploadInspiration(f, state.pack);
      if (r?.error === "signin") { if (status) status.textContent = "Sign in to upload inspiration."; return; }
    }
    state.inspiration = await listInspiration();
    render();
  });

  async function generate() {
    if (state.busy || !state.photoId) return;
    state.busy = true;
    render();
    const result = await generateScene({
      subjectPhotoId: state.photoId,
      prompt: state.prompt || PROMPT_HINTS[state.pack] || "a photo of me",
      stylePackId: state.pack,
      referenceAssetIds: state.refs,
      aspect: state.aspect,
      quality: "standard",
    });
    state.busy = false;
    if (result?.url) { state.resultUrl = result.url; render(); return; }
    render();
    const msg = overlay.querySelector("[data-status]");
    if (msg) {
      msg.textContent =
        result?.error === "signin" ? "Sign in to generate a scene."
        : result?.error === "paywall" ? "You've used your free generations this month — Gems Plus unlocks more."
        : result?.error === "refused" ? (result.reply || "Try a different prompt.")
        : "That didn't generate — try again.";
    }
  }

  async function saveResult() {
    if (!state.resultUrl) return;
    try {
      const res = await fetch(state.resultUrl);
      const blob = await res.blob();
      await importPhotoFiles([new File([blob], "scene.jpg", { type: blob.type || "image/jpeg" })]);
      const btn = overlay.querySelector("[data-save]");
      if (btn) btn.textContent = "Saved ✓";
    } catch (error) {
      console.info("save scene failed", error);
    }
  }

  render();
  window.addEventListener("keydown", function onKey(e) {
    if (e.key === "Escape") { close(); window.removeEventListener("keydown", onKey); }
  });
}
