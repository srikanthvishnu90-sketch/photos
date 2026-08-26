// gems-scene-view.js — the Scene Studio overlay ("put me in a scene", e.g. Euro
// Summer). Pick your selfie + a style pack + optional inspiration references,
// then Gems generates you in that scene. Self-contained overlay; never throws.
import { listPhotos, importPhotoFiles } from "./gems-photolib.js";
import {
  STYLE_PACKS, ASPECTS, generateScene, uploadInspiration, listInspiration, deleteInspiration,
  poseOptionsFor, outfitOptionsFor, settingOptionsFor, datingShots,
} from "./gems-scenes.js";
import { hasMeIdentity, getMeReferences, faceDistanceToMe } from "./gems-faces.js";

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// The prompt split into per-word spans so they can drift/dissolve into the image.
function genWords(text) {
  const parts = String(text || "your scene").trim().split(/\s+/);
  return `<p>${parts.map((w, i) => `<span class="gen-w">${esc(w)}${i < parts.length - 1 ? " " : ""}</span>`).join("")}</p>`;
}
const GEN_GRAIN = `<div class="gen-grain"></div>`;

const PROMPT_HINTS = {
  "dating": "makes 6 varied dating photos — no need to describe a scene",
  "euro-summer": "walking through a sunlit European old town",
  "dubai": "by a rooftop infinity pool at sunset, Burj Khalifa behind me",
  "old-money": "on a cobbled Monaco street with the yacht harbor behind me",
  "luxury-cars": "leaning on a supercar at a grand hotel forecourt",
  "beach-club": "on a day-bed at a chic beach club, turquoise water behind me",
  "boat": "on a boat in turquoise water, coastline behind me",
  "dark-luxe": "in a penthouse at dusk, city skyline through the glass",
  "after-dark": "on a rooftop at night, city lights behind me",
};

const BG_HINTS = {
  "euro-summer": "a sunlit cobblestone alley in an Italian old town",
  "dubai": "a rooftop infinity pool at sunset over the Dubai skyline",
  "old-money": "a cobbled Monaco hillside street with Belle-Époque buildings and a yacht harbor below",
  "luxury-cars": "a gleaming supercar parked at a grand hotel forecourt at golden hour",
  "beach-club": "a chic beach club with striped umbrellas and day-beds on white sand by turquoise water",
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
    matchReference: false, wardrobe: "", pose: "", build: "",
    // Fill-gaps: only generate these dating recipe labels (else the full set of 6).
    datingRecipes: Array.isArray(prefill.datingRecipes) && prefill.datingRecipes.length ? prefill.datingRecipes : null,
    // Quick questionnaire mode (from a homepage pack button): a clean stepped
    // "which kind of photo?" flow + a describe box. `setting` = the chosen scene.
    questionnaire: prefill.questionnaire === true,
    setting: "",
    photoId: typeof prefill.photoId === "string" ? prefill.photoId : null, pack: defaultPack,
    prompt: typeof prefill.prompt === "string" ? prefill.prompt : "",
    aspect: "4:5",
    count: 1,
    refs: [], inspiration: [], busy: false,
    // Generated images live here as { url, faceNote }. Multiple images are made
    // as SEPARATE generations and swiped through; each has its own export.
    results: [], resultIndex: 0, progress: "",
    // "describe → image" animation: revealing = the one-time reveal of the first
    // result; revealText = the words that dissolve into it.
    revealing: false, revealText: "",
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
        <h2 class="commit-title">${state.pack === "dating" ? "Your dating photos" : state.questionnaire ? esc((STYLE_PACKS.find((s) => s.id === state.pack) || {}).label || "Make a photo") : "Put me in a scene"}</h2>
        <button class="commit-close" type="button" aria-label="Close">✕</button>
      </header>
      <div class="commit-body">
        ${
          state.revealing && state.results.length
            ? // ── The reveal: the words dissolve INTO the first generated image.
              `<div class="commit-result">
                 <div class="gen-stage is-revealing">
                   <img class="gen-img is-revealing" src="${esc(state.results[0].url)}" alt="Your generated image" />
                   ${GEN_GRAIN}
                   <div class="gen-sweep"></div>
                   <span class="gen-tag">AI SCENE${state.pack ? " · " + esc(state.pack.replace(/-/g, " ")) : ""}</span>
                   <div class="gen-words">${genWords(state.revealText)}</div>
                 </div>
                 <p class="gen-caption" data-caption></p>
               </div>`
            : state.results.length
            ? (() => {
        const cur = state.results[state.resultIndex] || state.results[0];
        const many = state.results.length > 1;
        return `<div class="commit-result">
                 <div class="scene-carousel">
                   <div class="scene-carousel-view" data-carousel>
                     <img class="commit-result-img" src="${esc(cur.url)}" alt="Generated scene ${state.resultIndex + 1}" />
                   </div>
                   ${many ? `<button class="scene-nav scene-nav--prev" data-prev type="button" aria-label="Previous"${state.resultIndex === 0 ? " disabled" : ""}>‹</button>
                   <button class="scene-nav scene-nav--next" data-next type="button" aria-label="Next"${state.resultIndex === state.results.length - 1 ? " disabled" : ""}>›</button>` : ""}
                 </div>
                 ${many ? `<div class="scene-dots">${state.results.map((_, i) => `<span class="scene-dot${i === state.resultIndex ? " is-active" : ""}"></span>`).join("")}</div>` : ""}
                 ${state.busy ? `<p class="commit-note">${esc(state.progress || "Creating…")}</p>` : cur.faceNote ? `<p class="commit-note">${esc(cur.faceNote)}</p>` : ""}
                 <div class="commit-actions">
                   <button class="commit-btn" data-again type="button">New batch</button>
                   <button class="commit-btn" data-export type="button">Export</button>
                   <button class="commit-btn commit-btn--primary" data-save type="button">Save</button>
                 </div>
               </div>`;
      })()
            : state.busy
            ? // ── The "describe" stage: words over a scene developing underneath.
              `<div class="commit-result">
                 <div class="gen-stage">
                   <div class="gen-pic"></div>
                   ${GEN_GRAIN}
                   <span class="gen-tag">AI SCENE${state.pack ? " · " + esc(state.pack.replace(/-/g, " ")) : ""}</span>
                   <div class="gen-words">${genWords(state.revealText)}</div>
                 </div>
                 <p class="commit-note">${esc(state.progress || "Painting your scene…")}</p>
               </div>`
            : (() => {
        const inMe = state.mode !== "background";
        const isDating = inMe && state.pack === "dating";
        const canGenerate = !state.busy && (inMe ? !!state.photoId : true);
        const oneRefSelected = state.refs.length === 1;
        // Dating gets a CLEAN, dedicated mobile screen: photo → build → generate.
        // None of the scene controls (vibe/prompt/pose/inspiration/outfit/aspect)
        // apply, so they're hidden to keep it simple on a phone.
        if (isDating) {
          const subset = state.datingRecipes;
          return `
        <p class="commit-note">6 varied dating photos — a real mix, tailored to you. Pick a clear photo of yourself; I keep your face and your real build.</p>
        <label class="commit-label">A photo of you</label>
        ${
          photos.length
            ? `<div class="commit-photos">${photos.slice(0, 24).map((p) => `<button type="button" class="commit-photo${state.photoId === p.id ? " is-active" : ""}" data-photo="${esc(p.id)}"><img src="${esc(p.url)}" alt="" loading="lazy"></button>`).join("")}</div>`
            : `<p class="commit-hint">Import a photo of yourself first (Home → Import), then come back.</p>`
        }
        <label class="commit-label">Your build <span style="font-weight:400;color:var(--color-mauve)">(optional · gets your proportions right)</span></label>
        <input class="commit-input" data-build type="text" maxlength="120" placeholder="e.g. 5'10, 150 lbs, slim build" value="${esc(state.build)}" />
        <button class="commit-btn commit-btn--primary commit-generate" data-generate type="button" ${canGenerate ? "" : "disabled"}>
          ${state.busy ? "Generating…" : subset ? `Fill ${subset.length} gap${subset.length === 1 ? "" : "s"}` : "Make my dating set (6)"}
        </button>
        <p class="commit-note">${subset ? `Generates the ${subset.length} missing shot${subset.length === 1 ? "" : "s"}` : "6 varied dating photos, one at a time"} · keeps your face · uses AI. Sign in required.</p>
        <p class="commit-status" data-status></p>`;
        }
        // Quick questionnaire mode (homepage pack button): a clean stepped flow —
        // your photo → which kind → doing what → wearing → or describe your own.
        if (inMe && state.questionnaire) {
          const settings = settingOptionsFor(state.pack);
          const packLabel = (STYLE_PACKS.find((s) => s.id === state.pack) || {}).label || "scene";
          return `
        <p class="commit-note">A few quick picks and I'll make your ${esc(packLabel)} photo — or just describe your own below.</p>
        <label class="commit-label">A photo of you</label>
        ${
          photos.length
            ? `<div class="commit-photos">${photos.slice(0, 24).map((p) => `<button type="button" class="commit-photo${state.photoId === p.id ? " is-active" : ""}" data-photo="${esc(p.id)}"><img src="${esc(p.url)}" alt="" loading="lazy"></button>`).join("")}</div>`
            : `<p class="commit-hint">Import a photo of yourself first (Home → Import), then come back.</p>`
        }
        ${
          settings.length
            ? `<label class="commit-label">Which kind?</label>
        <div class="commit-headlines scene-settings">
          ${settings.map((s) => `<button type="button" class="commit-chip${state.setting === s.value ? " is-active" : ""}" data-setting="${esc(s.value)}">${esc(s.label)}</button>`).join("")}
        </div>`
            : ""
        }
        <label class="commit-label">Doing what?</label>
        <div class="commit-headlines scene-poses">
          ${poseOptionsFor(state.pack).map((p) => `<button type="button" class="commit-chip${state.pose === p.value ? " is-active" : ""}" data-pose="${esc(p.value)}">${esc(p.label)}</button>`).join("")}
        </div>
        <label class="commit-label">Wearing?</label>
        <div class="commit-headlines scene-outfits">
          ${outfitOptionsFor(state.pack).map((o) => `<button type="button" class="commit-chip${state.wardrobe === o.value ? " is-active" : ""}" data-outfit="${esc(o.value)}">${esc(o.label)}</button>`).join("")}
        </div>
        <label class="commit-label">Or describe your own</label>
        <div class="scene-describe-row">
          <input class="commit-input" data-prompt type="text" maxlength="200" placeholder="${esc(PROMPT_HINTS[state.pack] || "describe your photo")}" value="${esc(state.prompt)}" />
          <button type="button" class="scene-insert-btn" data-add-insp aria-label="Insert a reference image">
            <svg viewBox="0 0 18 18" aria-hidden="true"><path d="M12.8 5.2 6.6 11.4a1.9 1.9 0 1 0 2.7 2.7l6-6a3.6 3.6 0 0 0-5.1-5.1L4 9.2a5.3 5.3 0 0 0 7.5 7.5l5-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path></svg>
          </button>
        </div>
        ${
          state.refs.length
            ? `<div class="commit-photos scene-insert-thumbs">${state.refs.map((id) => { const insp = state.inspiration.find((i) => i.id === id); return `<button type="button" class="commit-photo is-active" data-insp="${esc(id)}">${insp?.url ? `<img src="${esc(insp.url)}" alt="">` : ""}</button>`; }).join("")}</div>`
            : ""
        }
        <button class="commit-btn commit-btn--primary commit-generate" data-generate type="button" ${canGenerate ? "" : "disabled"}>
          ${state.busy ? "Generating…" : "Make my photo"}
        </button>
        <p class="commit-note">Keeps your face · uses AI. Or type in the chat on Home to generate. Sign in required.</p>
        <p class="commit-status" data-status></p>`;
        }
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

        ${
          isDating
            ? `<label class="commit-label">Your build <span style="font-weight:400;color:var(--color-mauve)">(optional · gets your proportions right)</span></label>
        <input class="commit-input" data-build type="text" maxlength="120" placeholder="e.g. 5'10, 150 lbs, slim build" value="${esc(state.build)}" />`
            : `<label class="commit-label">${inMe ? "7" : "5"} · How many</label>
        <div class="commit-headlines">
          ${[1, 4].map((n) => `<button type="button" class="commit-chip${state.count === n ? " is-active" : ""}" data-count="${n}">${n === 1 ? "Just one" : n + " photos"}</button>`).join("")}
        </div>`
        }

        <button class="commit-btn commit-btn--primary commit-generate" data-generate type="button" ${canGenerate ? "" : "disabled"}>
          ${state.busy ? "Generating…" : isDating ? (state.datingRecipes ? `Fill ${state.datingRecipes.length} gap${state.datingRecipes.length === 1 ? "" : "s"}` : "Make my dating set (6)") : state.count > 1 ? `Generate ${state.count} photos` : inMe ? "Generate my scene" : "Generate scene"}
        </button>
        <p class="commit-note">${isDating ? (state.datingRecipes ? `Generates the ${state.datingRecipes.length} missing shot${state.datingRecipes.length === 1 ? "" : "s"} · keeps your face` : "6 varied dating photos — a real mix, tailored to you · keeps your face") : inMe ? "Puts YOU in the scene · keeps your face" : "An aesthetic background · no people"} · uses AI. Sign in required.</p>
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
    overlay.querySelectorAll("[data-setting]").forEach((b) =>
      b.addEventListener("click", () => {
        state.setting = state.setting === b.dataset.setting ? "" : b.dataset.setting; // toggle
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
    overlay.querySelector("[data-build]")?.addEventListener("input", (e) => { state.build = e.target.value; });
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
    overlay.querySelectorAll("[data-count]").forEach((b) =>
      b.addEventListener("click", () => { state.count = Number(b.dataset.count) || 1; render(); }),
    );
    overlay.querySelector("[data-generate]")?.addEventListener("click", () => void generate());
    overlay.querySelector("[data-again]")?.addEventListener("click", () => {
      if (state.busy) return;
      state.results = []; state.resultIndex = 0; render();
    });
    overlay.querySelector("[data-export]")?.addEventListener("click", () => {
      const cur = state.results[state.resultIndex];
      if (cur?.url) void exportImage(cur.url);
    });
    overlay.querySelector("[data-save]")?.addEventListener("click", () => void saveResult());
    overlay.querySelector("[data-prev]")?.addEventListener("click", () => {
      if (state.resultIndex > 0) { state.resultIndex -= 1; render(); }
    });
    overlay.querySelector("[data-next]")?.addEventListener("click", () => {
      if (state.resultIndex < state.results.length - 1) { state.resultIndex += 1; render(); }
    });
    // Swipe the carousel to move between generated images.
    const carousel = overlay.querySelector("[data-carousel]");
    if (carousel) {
      let startX = null;
      carousel.addEventListener("touchstart", (e) => { startX = e.touches[0]?.clientX ?? null; }, { passive: true });
      carousel.addEventListener("touchend", (e) => {
        if (startX == null) return;
        const dx = (e.changedTouches[0]?.clientX ?? startX) - startX;
        startX = null;
        if (Math.abs(dx) < 40) return;
        if (dx < 0 && state.resultIndex < state.results.length - 1) { state.resultIndex += 1; render(); }
        else if (dx > 0 && state.resultIndex > 0) { state.resultIndex -= 1; render(); }
      }, { passive: true });
    }
  }

  inspFileInput.addEventListener("change", async () => {
    const files = [...(inspFileInput.files ?? [])];
    inspFileInput.value = "";
    if (!files.length) return;
    const status = overlay.querySelector("[data-status]");
    if (status) status.textContent = `Adding ${files.length} image${files.length === 1 ? "" : "s"}…`;
    const newIds = [];
    for (const f of files.slice(0, 20)) {
      const r = await uploadInspiration(f, state.pack);
      if (r?.error === "signin") { if (status) status.textContent = "Sign in to insert an image."; return; }
      if (r?.id) newIds.push(r.id);
    }
    state.inspiration = await listInspiration();
    // Auto-select the just-inserted images so they're actually USED as references.
    for (const id of newIds) {
      if (state.refs.length < 3 && !state.refs.includes(id)) state.refs.push(id);
    }
    if (status) status.textContent = "";
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

  function errorText(err) {
    return err?.error === "signin" ? "Sign in to generate a scene."
      : err?.error === "paywall" ? "You've used your free generations this month — Gems Plus unlocks more."
      : err?.error === "refused" ? (err.reply || "Try a different prompt.")
      : "That didn't generate — try again.";
  }

  // One image: generate + (if we can measure likeness) verify and reroll once.
  // Returns { url, faceNote } on success, or the error object.
  async function generateOne(opts, verify) {
    const MAX_ATTEMPTS = verify ? 2 : 1;
    const GOOD_DIST = 0.55; // < ~0.6 reads as "recognizably them"
    let best = null;
    let bestDist = Infinity;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const result = await generateScene(opts);
      if (!result?.url) { best = best || result; break; }
      if (!verify) { best = result; break; }
      const dist = await scoreFace(result.url);
      if (dist == null) { best = result; break; }
      if (dist < bestDist) { bestDist = dist; best = result; }
      if (dist <= GOOD_DIST) break;
    }
    if (best?.url) {
      return {
        url: best.url,
        faceNote:
          verify && bestDist < Infinity
            ? bestDist <= GOOD_DIST
              ? "Matched to your face ✓"
              : "Closest match — swipe, or make a new batch if the face is off"
            : "",
      };
    }
    return best;
  }

  async function generate() {
    const inMe = state.mode !== "background";
    if (state.busy || (inMe && !state.photoId)) return;
    state.busy = true;
    state.results = [];
    state.resultIndex = 0;
    state.progress = "";
    state.revealing = false;
    // The words that will dissolve into the image — the user's own description.
    state.revealText =
      inMe && state.pack === "dating"
        ? "your dating photos"
        : state.prompt ||
          state.setting ||
          (inMe ? PROMPT_HINTS[state.pack] || "a photo of me" : BG_HINTS[state.pack] || "an aesthetic scene");
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

    const baseOpts = {
      mode: state.mode,
      subjectPhotoId: inMe ? state.photoId : undefined,
      identityPhotoIds,
      stylePackId: state.pack,
      referenceAssetIds: state.refs,
      matchReference,
      build: inMe ? state.build : undefined,
      quality: matchReference ? "pro" : "standard",
    };

    // A dating profile is a VARIED SET: one call per recipe (different setting,
    // pose, framing, camera-direction), not the same shot N times. Otherwise a
    // batch is N separate calls of the SAME request. Each result is pushed in as
    // it arrives so the user can start swiping before the batch finishes.
    const isDating = inMe && state.pack === "dating";
    // Fill-gaps: restrict to the requested recipe labels when provided.
    const shots = state.datingRecipes
      ? datingShots().filter((s) => state.datingRecipes.includes(s.label))
      : datingShots();
    const jobs = isDating
      ? shots.map((s) => ({
          ...baseOpts,
          prompt: s.prompt,
          pose: s.pose,
          // A per-shot outfit unless the user typed their own.
          wardrobe: state.wardrobe || s.wardrobe,
          aspect: s.aspect || state.aspect,
        }))
      : Array.from({ length: state.questionnaire ? 1 : Math.max(1, Math.min(8, state.count | 0)) }, () => ({
          ...baseOpts,
          prompt:
            state.prompt ||
            state.setting ||
            (inMe ? PROMPT_HINTS[state.pack] || "a photo of me" : BG_HINTS[state.pack] || "an aesthetic scene"),
          wardrobe: inMe ? state.wardrobe : undefined,
          pose: inMe ? state.pose : undefined,
          aspect: state.aspect,
        }));

    const N = jobs.length;
    let lastError = null;
    for (let n = 0; n < N; n++) {
      state.progress = N > 1 ? `Generating ${n + 1} of ${N}…` : "Creating your photo…";
      if (!state.revealing) render(); // don't disturb the reveal mid-animation
      const r = await generateOne(jobs[n], verify);
      if (r?.url) {
        state.results.push({ url: r.url, faceNote: r.faceNote });
        state.resultIndex = state.results.length - 1;
        if (state.results.length === 1) startReveal(); // first image → play the reveal
        else if (!state.revealing) render();
      } else {
        lastError = r;
      }
    }

    state.busy = false;
    state.progress = "";
    if (!state.revealing) render(); // if still revealing, its timeout renders the carousel
    if (!state.results.length) {
      const msg = overlay.querySelector("[data-status]");
      if (msg) msg.textContent = errorText(lastError);
    }
  }

  // Play the one-time "words dissolve into the image" reveal for the first result.
  function startReveal() {
    state.revealing = true;
    render();
    const words = [...overlay.querySelectorAll(".gen-words .gen-w")];
    words.forEach((w, i) => {
      window.setTimeout(() => {
        const dx = Math.random() * 60 - 30;
        const dy = 40 + Math.random() * 90; // drift down into the scene
        const rot = Math.random() * 14 - 7;
        const sc = 0.6 + Math.random() * 0.25;
        w.style.transform = `translate(${dx}px, ${dy}px) rotate(${rot}deg) scale(${sc})`;
        w.classList.add("gone");
      }, 300 + i * 90);
    });
    const cap = overlay.querySelector("[data-caption]");
    if (cap) {
      window.setTimeout(() => {
        const pack = state.pack ? state.pack.replace(/-/g, " ") : "scene";
        cap.textContent = `“${state.revealText}” · ${pack} · swipe or make more`;
        cap.classList.add("in");
      }, 300 + words.length * 90 + 200);
    }
    // Settle into the carousel with everything generated by then.
    window.setTimeout(() => {
      state.revealing = false;
      state.resultIndex = 0;
      render();
    }, 2700);
  }

  // Export (share/download) any generated image — always available per image.
  async function exportImage(url) {
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const file = new File([blob], `gems-scene-${state.resultIndex + 1}.jpg`, { type: blob.type || "image/jpeg" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: "My Gems scene" });
        return;
      }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = file.name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (error) {
      console.info("export failed", error);
    }
  }

  async function saveResult() {
    const cur = state.results[state.resultIndex];
    if (!cur?.url) return;
    try {
      const res = await fetch(cur.url);
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
