// gems-scene-view.js — the Scene Studio overlay ("put me in a scene", e.g. Euro
// Summer). Pick your selfie + a style pack + optional inspiration references,
// then Gems generates you in that scene. Self-contained overlay; never throws.
import { listPhotos, importPhotoFiles } from "./gems-photolib.js";
import {
  STYLE_PACKS, ASPECTS, generateScene, uploadInspiration, listInspiration, deleteInspiration,
  poseOptionsFor, outfitOptionsFor,
} from "./gems-scenes.js";
import { hasMeIdentity, getMeReferences, faceDistanceToMe } from "./gems-faces.js";

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const PROMPT_HINTS = {
  "euro-summer": "walking through a sunlit European old town",
  "dubai": "by a rooftop infinity pool at sunset, Burj Khalifa behind me",
  "boat": "on a boat in turquoise water, coastline behind me",
  "dark-luxe": "in a penthouse at dusk, city skyline through the glass",
  "after-dark": "on a rooftop at night, city lights behind me",
};

const BG_HINTS = {
  "euro-summer": "a sunlit cobblestone alley in an Italian old town",
  "dubai": "a rooftop infinity pool at sunset over the Dubai skyline",
  "boat": "a day-yacht on clear turquoise water, coastline in the distance",
  "dark-luxe": "a dark infinity pool at dusk framed by tropical foliage",
  "after-dark": "a moody city skyline at blue hour from a high window",
};

export async function openSceneStudio(defaultPack = "euro-summer", prefill = {}) {
  if (typeof document === "undefined") return;
  document.querySelector(".scene-overlay")?.remove();

  const state = {
    // Pre-filled from a chat "generate" request when provided.
    mode: prefill.mode === "background" ? "background" : "me",
    matchReference: false, wardrobe: "", pose: "",
    photoId: null, pack: defaultPack,
    prompt: typeof prefill.prompt === "string" ? prefill.prompt : "",
    aspect: "4:5",
    refs: [], inspiration: [], busy: false, resultUrl: "", faceNote: "",
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
                 ${state.faceNote ? `<p class="commit-note">${esc(state.faceNote)}</p>` : ""}
                 <div class="commit-actions">
                   <button class="commit-btn" data-again type="button">Try again</button>
                   <button class="commit-btn commit-btn--primary" data-save type="button">Save to my photos</button>
                 </div>
               </div>`
            : (() => {
        const inMe = state.mode !== "background";
        const canGenerate = !state.busy && (inMe ? !!state.photoId : true);
        const oneRefSelected = state.refs.length === 1;
        return `
        <div class="commit-headlines scene-mode">
          <button type="button" class="commit-chip${inMe ? " is-active" : ""}" data-mode="me">Put me in it</button>
          <button type="button" class="commit-chip${!inMe ? " is-active" : ""}" data-mode="background">Just the scene</button>
        </div>

        ${
          inMe
            ? `<label class="commit-label">1 · A photo of you</label>
        ${
          photos.length
            ? `<div class="commit-photos">${photos.slice(0, 24).map((p) => `<button type="button" class="commit-photo${state.photoId === p.id ? " is-active" : ""}" data-photo="${esc(p.id)}"><img src="${esc(p.url)}" alt="" loading="lazy"></button>`).join("")}</div>`
            : `<p class="commit-hint">Import a photo of yourself first (Home → Import), then come back.</p>`
        }`
            : ""
        }

        <label class="commit-label">${inMe ? "2 · Vibe" : "1 · Vibe"}</label>
        <div class="commit-headlines">
          ${STYLE_PACKS.map((s) => `<button type="button" class="commit-chip${state.pack === s.id ? " is-active" : ""}" data-pack="${s.id}">${esc(s.label)}</button>`).join("")}
        </div>

        <label class="commit-label">${inMe ? "3 · What are you doing?" : "2 · What's the scene?"} <span style="font-weight:400;color:var(--color-mauve)">(optional)</span></label>
        <input class="commit-input" data-prompt type="text" maxlength="200" placeholder="${esc((inMe ? PROMPT_HINTS : BG_HINTS)[state.pack] || "describe the scene")}" value="${esc(state.prompt)}" />
        ${
          inMe
            ? `<div class="commit-headlines scene-poses">
                 ${poseOptionsFor(state.pack).map((p) => `<button type="button" class="commit-chip${state.pose === p.value ? " is-active" : ""}" data-pose="${esc(p.value)}">${esc(p.label)}</button>`).join("")}
               </div>`
            : ""
        }

        <label class="commit-label">${inMe ? "4" : "3"} · ${inMe ? "Inspiration references" : "Match a look"} <span style="font-weight:400;color:var(--color-mauve)">(optional · pick up to 3)</span></label>
        <div class="commit-photos">
          <button type="button" class="commit-photo scene-insp-add" data-add-insp aria-label="Upload inspiration">＋</button>
          ${state.inspiration.map((i) => `<button type="button" class="commit-photo${state.refs.includes(i.id) ? " is-active" : ""}" data-insp="${esc(i.id)}">${i.url ? `<img src="${esc(i.url)}" alt="" loading="lazy">` : ""}</button>`).join("")}
        </div>
        ${
          inMe && oneRefSelected
            ? `<label class="scene-swap"><input type="checkbox" data-match ${state.matchReference ? "checked" : ""}> Recreate this exact photo — just swap my face in</label>`
            : ""
        }

        ${
          inMe
            ? `<label class="commit-label">5 · Change my fit <span style="font-weight:400;color:var(--color-mauve)">(optional · tap one or type your own)</span></label>
        <div class="commit-headlines scene-outfits">
          ${outfitOptionsFor(state.pack).map((o) => `<button type="button" class="commit-chip${state.wardrobe === o.value ? " is-active" : ""}" data-outfit="${esc(o.value)}">${esc(o.label)}</button>`).join("")}
        </div>
        <input class="commit-input" data-wardrobe type="text" maxlength="200" placeholder="e.g. black linen shirt & cream trousers" value="${esc(state.wardrobe)}" />`
            : ""
        }

        <label class="commit-label">${inMe ? "6" : "4"} · Shape</label>
        <div class="commit-headlines">
          ${ASPECTS.map((a) => `<button type="button" class="commit-chip${state.aspect === a.id ? " is-active" : ""}" data-aspect="${a.id}">${esc(a.label)}</button>`).join("")}
        </div>

        <button class="commit-btn commit-btn--primary commit-generate" data-generate type="button" ${canGenerate ? "" : "disabled"}>
          ${state.busy ? "Generating…" : inMe ? "Generate my scene" : "Generate scene"}
        </button>
        <p class="commit-note">${inMe ? "Puts YOU in the scene · keeps your face" : "An aesthetic background · no people"} · uses AI. Sign in required.</p>
        <p class="commit-status" data-status></p>`;
      })()
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
      b.addEventListener("click", () => {
        if (state.pack !== b.dataset.pack) state.pose = ""; // poses are pack-specific
        state.pack = b.dataset.pack;
        render();
      }),
    );
    overlay.querySelectorAll("[data-pose]").forEach((b) =>
      b.addEventListener("click", () => {
        state.pose = state.pose === b.dataset.pose ? "" : b.dataset.pose; // toggle
        render();
      }),
    );
    overlay.querySelectorAll("[data-outfit]").forEach((b) =>
      b.addEventListener("click", () => {
        state.wardrobe = state.wardrobe === b.dataset.outfit ? "" : b.dataset.outfit; // toggle
        render();
      }),
    );
    overlay.querySelectorAll("[data-mode]").forEach((b) =>
      b.addEventListener("click", () => {
        state.mode = b.dataset.mode === "background" ? "background" : "me";
        if (state.mode === "background") state.matchReference = false;
        render();
      }),
    );
    overlay.querySelector("[data-prompt]")?.addEventListener("input", (e) => { state.prompt = e.target.value; });
    overlay.querySelector("[data-wardrobe]")?.addEventListener("input", (e) => { state.wardrobe = e.target.value; });
    overlay.querySelector("[data-match]")?.addEventListener("change", (e) => { state.matchReference = e.target.checked; });
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

  // Score a generated image against the user's real face (on-device). Returns a
  // euclidean distance (lower = more like them) or null if it can't be checked.
  async function scoreFace(url) {
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const bmp = await createImageBitmap(blob);
      const d = await faceDistanceToMe(bmp);
      bmp.close?.();
      return d;
    } catch (error) {
      console.info("face verify skipped", error);
      return null;
    }
  }

  async function generate() {
    const inMe = state.mode !== "background";
    if (state.busy || (inMe && !state.photoId)) return;
    state.busy = true;
    state.faceNote = "";
    render();
    const matchReference = inMe && state.refs.length === 1 && state.matchReference;

    // Identity-lock: if the user has tagged their face, attach several real
    // reference photos AND verify the output likeness (auto-reroll if it drifts).
    let identityPhotoIds = [];
    let verify = false;
    if (inMe) {
      try {
        if (await hasMeIdentity()) {
          verify = true;
          identityPhotoIds = (await getMeReferences(4)).map((r) => r.photoId);
        }
      } catch { /* no identity → skip */ }
    }

    const opts = {
      mode: state.mode,
      subjectPhotoId: inMe ? state.photoId : undefined,
      identityPhotoIds,
      prompt:
        state.prompt ||
        (inMe ? PROMPT_HINTS[state.pack] || "a photo of me" : BG_HINTS[state.pack] || "an aesthetic scene"),
      stylePackId: state.pack,
      referenceAssetIds: state.refs,
      matchReference,
      wardrobe: inMe ? state.wardrobe : undefined,
      pose: inMe ? state.pose : undefined,
      aspect: state.aspect,
      quality: matchReference ? "pro" : "standard",
    };

    const MAX_ATTEMPTS = verify ? 2 : 1; // only reroll when we can measure likeness
    const GOOD_DIST = 0.55; // < ~0.6 reads as "recognizably them"
    let best = null;
    let bestDist = Infinity;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const statusEl = overlay.querySelector("[data-status]");
      if (statusEl && attempt > 0) statusEl.textContent = "Improving the likeness…";
      const result = await generateScene(opts);
      if (!result?.url) { best = best || result; break; }
      if (!verify) { best = result; break; }
      const dist = await scoreFace(result.url);
      if (dist == null) { best = result; break; } // couldn't verify → accept
      if (dist < bestDist) { bestDist = dist; best = result; }
      if (dist <= GOOD_DIST) break; // good enough, stop early
    }

    state.busy = false;
    if (best?.url) {
      state.resultUrl = best.url;
      state.faceNote =
        verify && bestDist < Infinity
          ? bestDist <= GOOD_DIST
            ? "Matched to your face ✓"
            : "Closest match — hit Try again if the face is off"
          : "";
      render();
      return;
    }
    render();
    const msg = overlay.querySelector("[data-status]");
    if (msg) {
      msg.textContent =
        best?.error === "signin" ? "Sign in to generate a scene."
        : best?.error === "paywall" ? "You've used your free generations this month — Gems Plus unlocks more."
        : best?.error === "refused" ? (best.reply || "Try a different prompt.")
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
