// gems-scene-view.js — the Scene Studio overlay ("put me in a scene", e.g. Euro
// Summer). Pick your selfie + a style pack + optional inspiration references,
// then Gems generates you in that scene. Self-contained overlay; never throws.
import { listPhotos, importPhotoFiles } from "./gems-photolib.js";
import { inertBackdrop, releaseBackdrop } from "./gems-modal-a11y.js";
import {
  STYLE_PACKS, ASPECTS, generateScene, uploadInspiration, listInspiration, deleteInspiration,
  poseOptionsFor, outfitOptionsFor, settingOptionsFor, datingShots, editStyles,
} from "./gems-scenes.js";
import { hasMeIdentity, getMeReferences, faceDistanceToMe } from "./gems-faces.js";
import { createGenProgress } from "./gems-gen-progress.js";

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
  "campus": "walking across the quad with the old library behind me",
  "game-day": "in the student section under the stadium lights",
  "alpine": "on a chalet terrace with the peaks behind me",
  "tokyo-neon": "on a narrow neon-lit street after rain",
  "marrakech": "in a riad courtyard with tilework and palms",
  "wellness": "by a sunlit window with a matcha, linen and oak around me",
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
  "campus": "an ivy-covered brick quad in early autumn, long light through old trees",
  "game-day": "a packed stadium bowl under floodlights, school colours everywhere",
  "alpine": "a timber chalet terrace above the pistes, granite peaks behind",
  "tokyo-neon": "a narrow Tokyo street at night, stacked neon signage reflected in wet asphalt",
  "marrakech": "a riad courtyard with zellige tilework, palms and a still plunge pool in hard sun",
  "wellness": "a bright neutral room in soft diffuse daylight, linen, oak and ceramics",
};

export async function openSceneStudio(defaultPack = "euro-summer", prefill = {}) {
  if (typeof document === "undefined") return;
  // Tearing down a previous studio must also undo its inerting.
  releaseBackdrop();
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
    count: Number.isFinite(prefill.count) && prefill.count > 0 ? Math.min(10, Math.round(prefill.count)) : 1,
    refs: [], inspiration: [], busy: false,
    // Generated images live here as { url, faceNote }. Multiple images are made
    // as SEPARATE generations and swiped through; each has its own export.
    results: [], resultIndex: 0, progress: "",
    // "describe → image" animation: revealing = the one-time reveal of the first
    // result; revealText = the words that dissolve into it.
    revealing: false, revealText: "",
    // Staged lifecycle overlay (gems-gen-progress) + how many the batch will make.
    gen: null, batchTotal: 0,
  };

  const overlay = document.createElement("div");
  overlay.className = "scene-overlay commit-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  document.body.append(overlay);
  // aria-modal alone is a promise, not a mechanism: Tab still walked out of the
  // overlay into the screen behind it (measured: 14 of 25 tab stops landed on
  // the Discover card buttons underneath). Make the rest of the app genuinely
  // inert while this is open, the way the Photos sheet already does.
  inertBackdrop(overlay);
  const close = () => {
    releaseBackdrop();
    overlay.remove();
  };

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
        const total = Math.max(state.batchTotal, state.results.length);
        const many = total > 1;
        const pending = state.busy ? Math.max(0, total - state.results.length) : 0;
        const packLabel = (STYLE_PACKS.find((s) => s.id === state.pack) || {}).label
          || (state.pack ? state.pack.replace(/-/g, " ") : "Your scene");
        // Result page, styled like an Instagram post: header → the image → an
        // icon action row (Edit / Chat / Export / Save) → the other images from
        // the batch as thumbnails (each its own scene + editing style) → refine.
        return `<div class="commit-result scene-post">
                 <div class="scene-post-head">
                   <div class="scene-post-id">
                     <span class="scene-post-mark" aria-hidden="true">G</span>
                     <div>
                       <b>${esc(packLabel)}</b>
                       <span>AI SCENE${many ? ` · ${state.resultIndex + 1} of ${total}` : ""}${cur.styleName ? ` · ${esc(cur.styleName)}` : ""}</span>
                     </div>
                   </div>
                 </div>
                 <div class="scene-carousel">
                   <div class="scene-carousel-view" data-carousel>
                     <img class="commit-result-img" src="${esc(cur.url)}" alt="Generated scene ${state.resultIndex + 1}" />
                   </div>
                   ${many ? `<button class="scene-nav scene-nav--prev" data-prev type="button" aria-label="Previous"${state.resultIndex === 0 ? " disabled" : ""}>‹</button>
                   <button class="scene-nav scene-nav--next" data-next type="button" aria-label="Next"${state.resultIndex === state.results.length - 1 ? " disabled" : ""}>›</button>` : ""}
                 </div>
                 <div class="scene-actionrow">
                   <button class="scene-icon" data-edit type="button">
                     <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 14.2 13.6 4.1a1.9 1.9 0 0 1 2.7 2.7L6.2 16.9l-3.6.9.9-3.6Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
                     Edit
                   </button>
                   <button class="scene-icon" data-chat type="button">
                     <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.2c4 0 7 2.6 7 5.9s-3 5.9-7 5.9c-.8 0-1.6-.1-2.3-.3L4 16.4l.8-2.9C3.7 12.4 3 10.9 3 9.1c0-3.3 3-5.9 7-5.9Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
                     Chat
                   </button>
                   <button class="scene-icon" data-export type="button">
                     <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 12.5V3.6m0 0L6.6 7m3.4-3.4L13.4 7M4.5 12.5v2.6a1.6 1.6 0 0 0 1.6 1.6h7.8a1.6 1.6 0 0 0 1.6-1.6v-2.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
                     Export
                   </button>
                   <button class="scene-icon is-primary" data-save type="button">
                     <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.4 3.5h9.2a1 1 0 0 1 1 1v12l-5.6-3.4L4.4 16.5v-12a1 1 0 0 1 1-1Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
                     Save
                   </button>
                 </div>
                 ${
                   many || pending
                     ? `<div class="scene-thumbs" role="tablist" aria-label="Generated images">
                          ${state.results.map((r, i) => `<button type="button" role="tab" aria-selected="${i === state.resultIndex}" class="scene-thumb${i === state.resultIndex ? " is-active" : ""}" data-thumb="${i}"><img src="${esc(r.url)}" alt="" loading="lazy"><span>${esc(r.styleName || `Photo ${i + 1}`)}</span></button>`).join("")}
                          ${Array.from({ length: pending }, () => `<div class="scene-thumb is-pending"><i></i><span>Making…</span></div>`).join("")}
                        </div>`
                     : ""
                 }
                 ${state.busy ? `<p class="commit-note">${esc(state.progress || "Creating…")}</p>` : cur.faceNote ? `<p class="commit-note">${esc(cur.faceNote)}</p>` : ""}
                 <form class="scene-refine" data-refine>
                   <input class="commit-input" data-refine-input type="text" maxlength="200" placeholder="Change something… e.g. make it sunset, change my outfit" />
                   <button class="scene-refine-send" type="submit" aria-label="Regenerate"${state.busy ? " disabled" : ""}>↑</button>
                 </form>
                 <button class="scene-newbatch" data-again type="button">Start over</button>
               </div>`;
      })()
            : state.busy
            ? // ── The generation lifecycle: a scene developing underneath, with the
              // staged narration overlay (read → plan → match references → generate).
              `<div class="commit-result">
                 <div class="gen-stage">
                   <div class="gen-pic"></div>
                   ${GEN_GRAIN}
                   <span class="gen-tag">AI SCENE${state.pack ? " · " + esc(state.pack.replace(/-/g, " ")) : ""}</span>
                   <div class="gen-words">${genWords(state.revealText)}</div>
                   ${state.gen ? state.gen.html() : ""}
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
            : `<label class="commit-label">${inMe ? "7" : "5"} · How many <span style="font-weight:400;color:var(--color-mauve)">(each in a different editing style)</span></label>
        <div class="commit-headlines">
          ${[1, 5, 10].map((n) => `<button type="button" class="commit-chip${state.count === n ? " is-active" : ""}" data-count="${n}">${n === 1 ? "Just one" : n + " styles"}</button>`).join("")}
        </div>`
        }

        <button class="commit-btn commit-btn--primary commit-generate" data-generate type="button" ${canGenerate ? "" : "disabled"}>
          ${state.busy ? "Generating…" : isDating ? (state.datingRecipes ? `Fill ${state.datingRecipes.length} gap${state.datingRecipes.length === 1 ? "" : "s"}` : "Make my dating set (6)") : state.count > 1 ? `Generate ${state.count} styles` : inMe ? "Generate my scene" : "Generate scene"}
        </button>
        <p class="commit-note">${isDating ? (state.datingRecipes ? `Generates the ${state.datingRecipes.length} missing shot${state.datingRecipes.length === 1 ? "" : "s"} · keeps your face` : "6 varied dating photos — a real mix, tailored to you · keeps your face") : inMe ? "Puts YOU in the scene · keeps your face" : "An aesthetic background · no people"} · uses AI. Sign in required.</p>
        <p class="commit-status" data-status></p>`;
      })()
        }
      </div>
    `;
    wire();
    // Re-bind the staged lifecycle overlay after every innerHTML rebuild.
    if (state.busy && state.gen) state.gen.attach(overlay);
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
      state.results = []; state.resultIndex = 0; state.batchTotal = 0; render();
    });
    overlay.querySelector("[data-export]")?.addEventListener("click", () => {
      const cur = state.results[state.resultIndex];
      if (cur?.url) void exportImage(cur.url);
    });
    overlay.querySelector("[data-save]")?.addEventListener("click", () => void saveResult());
    // Result-page small chatbox: describe a change → regenerate.
    overlay.querySelector("[data-refine]")?.addEventListener("submit", (e) => {
      e.preventDefault();
      if (state.busy) return;
      const val = overlay.querySelector("[data-refine-input]")?.value?.trim();
      if (!val) return;
      state.prompt = val;
      state.setting = "";
      void generate();
    });
    // Edit: save this image to the library and open it in the editor.
    overlay.querySelector("[data-edit]")?.addEventListener("click", () => void editResult());
    // Chat: hand this image to the Home chatbox (build a post/edit around it).
    overlay.querySelector("[data-chat]")?.addEventListener("click", () => void chatResult());
    // Thumbnail strip: jump straight to any image in the batch.
    overlay.querySelectorAll("[data-thumb]").forEach((b) =>
      b.addEventListener("click", () => {
        const i = Number(b.dataset.thumb);
        if (Number.isFinite(i) && state.results[i]) { state.resultIndex = i; render(); }
      }),
    );
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
      : err?.error === "paywall" ? "That was your one free creation — subscribe to Gems Plus to make more."
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
    // Staged lifecycle overlay: read → plan → match real references → generate.
    state.gen = createGenProgress({
      request: state.revealText,
      packLabel: (STYLE_PACKS.find((s) => s.id === state.pack) || {}).label || state.pack,
      count: state.pack === "dating" ? 6 : state.questionnaire ? 1 : state.count,
    });
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

    // One id for the whole batch — the free tier allows ONE request (any number
    // of images), then paywalls. Every image in this batch shares this id.
    let batchRequestId;
    try { batchRequestId = crypto.randomUUID(); }
    catch { batchRequestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`; }

    const baseOpts = {
      mode: state.mode,
      subjectPhotoId: inMe ? state.photoId : undefined,
      identityPhotoIds,
      stylePackId: state.pack,
      referenceAssetIds: state.refs,
      matchReference,
      build: inMe ? state.build : undefined,
      quality: matchReference ? "pro" : "standard",
      requestId: batchRequestId,
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
    // Each image in a batch recreates a DIFFERENT real reference photo of the
    // place (the server's pack environment library) — a random start index so a
    // new batch sees new places, then +1 per image so no two images share one.
    const envStart = Math.floor(Math.random() * 1000);
    const jobs = isDating
      ? shots.map((s, i) => ({
          ...baseOpts,
          prompt: s.prompt,
          pose: s.pose,
          // A per-shot outfit unless the user typed their own.
          wardrobe: state.wardrobe || s.wardrobe,
          aspect: s.aspect || state.aspect,
          environmentRef: envStart + i,
        }))
      : (() => {
          const N = state.questionnaire ? 1 : Math.max(1, Math.min(10, state.count | 0));
          const base =
            state.prompt ||
            state.setting ||
            (inMe ? PROMPT_HINTS[state.pack] || "a photo of me" : BG_HINTS[state.pack] || "an aesthetic scene");
          // Multiple images → each is INDIVIDUAL: its own real environment
          // reference (above), its own candid pose, and its own editing style —
          // varied "templates" to choose from and edit, never near-duplicates.
          const styles = N > 1 ? editStyles(N) : [null];
          const poses = poseOptionsFor(state.pack);
          return styles.map((style, i) => ({
            ...baseOpts,
            prompt: base + (style ? ` Color/edit style: ${style.grade}.` : ""),
            styleName: style?.name || null,
            wardrobe: inMe ? state.wardrobe : undefined,
            // The user's chosen pose everywhere, else rotate through the pack's
            // candid poses so each image is a different moment.
            pose: inMe ? state.pose || (N > 1 && poses.length ? poses[i % poses.length].value : "") : undefined,
            aspect: state.aspect,
            environmentRef: envStart + i,
          }));
        })();

    const N = jobs.length;
    state.batchTotal = N;
    let lastError = null;
    for (let n = 0; n < N; n++) {
      state.progress = N > 1 ? `Generating ${n + 1} of ${N}…` : "Creating your photo…";
      state.gen?.setImage(n + 1, N);
      if (!state.revealing) render(); // don't disturb the reveal mid-animation
      const r = await generateOne(jobs[n], verify);
      if (r?.url) {
        state.results.push({ url: r.url, faceNote: r.faceNote, styleName: jobs[n].styleName || null });
        // Don't yank the view — later images land in the thumb strip; the user
        // stays on whichever image they're looking at.
        if (state.results.length === 1) {
          state.resultIndex = 0;
          state.gen?.finish(); // the lifecycle overlay hands off to the reveal
          startReveal(); // first image → play the reveal
        } else if (!state.revealing) render();
      } else {
        lastError = r;
      }
    }

    state.busy = false;
    state.progress = "";
    state.gen?.stop();
    state.gen = null;
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

  // Chat: save this generated image to the library, attach it to the Home
  // chatbox, and land on Home so the conversation continues around it.
  async function chatResult() {
    const cur = state.results[state.resultIndex];
    if (!cur?.url) return;
    try {
      const res = await fetch(cur.url);
      const blob = await res.blob();
      const imported = await importPhotoFiles([new File([blob], "scene.jpg", { type: blob.type || "image/jpeg" })]);
      const record = imported?.[0];
      close();
      if (record?.id && typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("gems:attach-to-chat", { detail: { id: record.id, url: record.url || cur.url } }));
        window.dispatchEvent(new CustomEvent("gems:go-home"));
      }
    } catch (error) {
      console.info("chat result failed", error);
    }
  }

  // Edit: save this generated image to the library, close, and open it in the
  // editor (via a global event the app listens for).
  async function editResult() {
    const cur = state.results[state.resultIndex];
    if (!cur?.url) return;
    try {
      const res = await fetch(cur.url);
      const blob = await res.blob();
      const imported = await importPhotoFiles([new File([blob], "scene.jpg", { type: blob.type || "image/jpeg" })]);
      const id = imported?.[0]?.id;
      close();
      if (id && typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("gems:open-editor", { detail: { photoId: id } }));
      }
    } catch (error) {
      console.info("edit result failed", error);
    }
  }

  render();
  window.addEventListener("keydown", function onKey(e) {
    if (e.key === "Escape") { close(); window.removeEventListener("keydown", onKey); }
  });
}
