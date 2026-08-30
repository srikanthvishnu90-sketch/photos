// gems-batch-view.js — the batch "photo dump" flow. One generation produces N
// SCENES (a mix of places for a pack), each rendered in 5 lighting LOOKS the
// user picks between to assemble a dump. Cost is one model call per SCENE — the
// 5 looks per scene are instant on-device regrades (see gems-lighting.js), so a
// 6-scene dump is 6 generations, not 30.
//
// Self-contained full-screen overlay; never throws. Reuses the scene generator,
// the staged progress overlay, identity-lock, and the library save path.
import { listPhotos, importPhotoFiles, getPhotoBlob } from "./gems-photolib.js";
import {
  STYLE_PACKS, generateScene, settingOptionsFor, poseOptionsFor, outfitOptionsFor, matchPackForText,
} from "./gems-scenes.js";
import { hasMeIdentity, getMeReferences, faceDistanceToMe } from "./gems-faces.js";
import { createGenProgress } from "./gems-gen-progress.js";
import { lightingVariants, revokeVariants, BATCH_LIGHTS, DEFAULT_LIGHT_INDEX, BATCH_MAX_SCENES } from "./gems-lighting.js";

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Build N scene recipes for a pack from the existing catalogs — no new content.
// Each scene gets a distinct real place (environmentRef) and its own candid pose.
function planBatch(pack, request, n) {
  const settings = settingOptionsFor(pack);
  const poses = poseOptionsFor(pack);
  const outfit = (outfitOptionsFor(pack)[0] || {}).value || "";
  const envStart = Math.floor(Math.random() * 1000);
  const count = Math.max(1, Math.min(BATCH_MAX_SCENES, n | 0 || BATCH_MAX_SCENES));
  const base = String(request || "").trim();
  const scenes = [];
  for (let i = 0; i < count; i++) {
    const setting = settings.length ? settings[i % settings.length] : null;
    const pose = poses.length ? poses[i % poses.length] : null;
    // Neutral daylight base so the 5 regrades read cleanly.
    const prompt = [base, setting?.value]
      .filter(Boolean)
      .join(". ")
      .slice(0, 700) + " Bright natural daylight, neutral even color, no strong color cast.";
    scenes.push({
      key: `s${i}`,
      label: setting?.label || `Scene ${i + 1}`,
      prompt,
      pose: pose?.value || "",
      wardrobe: outfit,
      environmentRef: envStart + i,
      status: "pending", // pending | done | error
      baseUrl: "",
      variants: [],       // [{key,label,url,revocable}]
      chosen: DEFAULT_LIGHT_INDEX,
      faceNote: "",
    });
  }
  return scenes;
}

export async function openBatchStudio(defaultPack = "euro-summer", prefill = {}) {
  if (typeof document === "undefined") return;
  document.querySelector(".batch-overlay")?.remove();

  const pack = matchPackForText(prefill.prompt) || defaultPack || "euro-summer";
  const state = {
    pack,
    request: (typeof prefill.prompt === "string" && prefill.prompt.trim())
      ? prefill.prompt.trim()
      : `a photo dump of me`,
    photoId: typeof prefill.photoId === "string" ? prefill.photoId : null,
    stage: "setup", // setup | generating | results | variant
    scenes: [],
    openScene: 0,
    selected: new Set(),
    requestId: null,
    busy: false,
    gen: null,
    progress: "",
    error: "",
  };

  const overlay = document.createElement("div");
  overlay.className = "batch-overlay commit-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Make a photo dump");
  document.body.append(overlay);

  const cleanup = () => {
    for (const s of state.scenes) revokeVariants(s.variants);
    state.gen?.stop();
  };
  const close = () => { cleanup(); overlay.remove(); };

  let photos = [];
  try { photos = await listPhotos(); } catch { photos = []; }

  const packLabel = (STYLE_PACKS.find((s) => s.id === state.pack) || {}).label || state.pack.replace(/-/g, " ");

  const render = () => {
    overlay.innerHTML = `
      <header class="commit-topbar">
        ${state.stage === "variant"
          ? `<button class="commit-close" data-back type="button" aria-label="Back">‹</button>`
          : state.stage === "results"
            ? `<span style="width:36px"></span>`
            : `<span style="width:36px"></span>`}
        <h2 class="commit-title">${
          state.stage === "variant" ? esc(`${state.openScene + 1} · ${state.scenes[state.openScene]?.label || "Scene"}`)
          : state.stage === "results" ? esc(`Your ${packLabel} dump`)
          : state.stage === "generating" ? "Creating"
          : esc(`${packLabel} photo dump`)
        }</h2>
        <button class="commit-close" data-close type="button" aria-label="Close">✕</button>
      </header>
      <div class="commit-body">${bodyFor()}</div>
    `;
    wire();
    if (state.stage === "generating" && state.gen) state.gen.attach(overlay);
  };

  function bodyFor() {
    if (state.stage === "setup") return setupBody();
    if (state.stage === "generating") return generatingBody();
    if (state.stage === "results") return resultsBody();
    if (state.stage === "variant") return variantBody();
    return "";
  }

  function setupBody() {
    return `
      <p class="commit-note">A dump of <b>${BATCH_MAX_SCENES} scenes</b> in ${esc(packLabel)}, each in <b>5 lighting looks</b> you pick from — the looks are instant, so it's ${BATCH_MAX_SCENES} generations, not 30. Pick a clear photo of yourself; I keep your face.</p>
      <label class="commit-label">A photo of you</label>
      ${
        photos.length
          ? `<div class="commit-photos">${photos.slice(0, 24).map((p) => `<button type="button" class="commit-photo${state.photoId === p.id ? " is-active" : ""}" data-photo="${esc(p.id)}"><img src="${esc(p.url)}" alt="" loading="lazy"></button>`).join("")}</div>`
          : `<p class="commit-hint">Import a photo of yourself first (Home → Import), then come back.</p>`
      }
      <button class="commit-btn commit-btn--primary commit-generate" data-generate type="button" ${state.photoId && !state.busy ? "" : "disabled"}>
        ${state.busy ? "Generating…" : `Make my dump (${BATCH_MAX_SCENES} scenes)`}
      </button>
      <p class="commit-note">Keeps your face · uses AI. Sign in required.</p>
      <p class="commit-status" data-status>${esc(state.error)}</p>`;
  }

  function generatingBody() {
    const done = state.scenes.filter((s) => s.status === "done").length;
    return `
      <div class="batch-genhero">
        <div class="batch-genq">“${esc(state.request)}”</div>
        <div class="batch-gensub">${BATCH_MAX_SCENES} scenes · 5 instant looks each</div>
      </div>
      ${state.gen ? state.gen.html() : ""}
      <div class="batch-skelgrid">
        ${state.scenes.map((s) => `
          <div class="batch-skel${s.status === "done" ? " done" : ""}">
            ${s.status === "done" && s.baseUrl ? `<img src="${esc(s.baseUrl)}" alt="" loading="lazy">` : `<span class="batch-shim"></span>`}
            <span class="batch-vcount">5 looks</span>
          </div>`).join("")}
      </div>
      <p class="commit-note" data-status>${esc(state.progress || `Generated ${done} of ${state.scenes.length}…`)}</p>`;
  }

  function resultsBody() {
    const n = state.selected.size;
    return `
      <p class="batch-rsum"><b>${state.scenes.length} scenes · 5 looks each</b> — tap a scene to pick its lighting. The looks are instant on-device recolors.</p>
      <div class="batch-grid">
        ${state.scenes.map((s, i) => {
          const cur = s.variants[s.chosen] || s.variants[0];
          const sel = state.selected.has(i);
          return `<button class="batch-tile${sel ? " sel" : ""}" data-scene="${i}" type="button">
            ${cur?.url ? `<img src="${esc(cur.url)}" alt="${esc(s.label)}">` : ""}
            <span class="batch-idx">${i + 1} · ${esc(s.label)}</span>
            <span class="batch-chk" data-sel="${i}">✓</span>
            <span class="batch-vc">▦ 5</span>
          </button>`;
        }).join("")}
      </div>
      <div class="batch-dock">
        <button class="commit-btn" data-regen type="button" ${state.busy ? "disabled" : ""}>↻ Regenerate</button>
        <button class="commit-btn commit-btn--primary" data-use type="button" ${n && !state.busy ? "" : "disabled"}>Use ${n} selected</button>
      </div>
      <p class="commit-status" data-status>${esc(state.error)}</p>`;
  }

  function variantBody() {
    const s = state.scenes[state.openScene];
    if (!s) return "";
    const hero = s.variants[s.chosen] || s.variants[0];
    return `
      <div class="batch-hero">
        ${hero?.url ? `<img src="${esc(hero.url)}" alt="">` : ""}
        <span class="batch-hero-lbl">${esc(hero?.label || "")}</span>
      </div>
      <div class="batch-vrow">
        ${s.variants.map((v, k) => `
          <button class="batch-vthumb${k === s.chosen ? " on" : ""}" data-light="${k}" type="button">
            ${v?.url ? `<img src="${esc(v.url)}" alt="">` : ""}
            <span>${esc(v?.label || BATCH_LIGHTS[k]?.label || "")}</span>
          </button>`).join("")}
      </div>
      <div class="batch-vacts">
        <button class="commit-btn" data-redo type="button" ${state.busy ? "disabled" : ""}>↻ Redo scene</button>
        <button class="commit-btn commit-btn--primary" data-back type="button">Use this lighting</button>
      </div>
      <p class="commit-note">All 5 are the same scene — only the colour/mood changes. Your pick becomes the one in the dump.</p>
      <p class="commit-status" data-status>${esc(state.error)}</p>`;
  }

  function wire() {
    overlay.querySelector("[data-close]")?.addEventListener("click", close);
    overlay.querySelector("[data-back]")?.addEventListener("click", () => {
      if (state.stage === "variant") { state.stage = "results"; render(); }
      else close();
    });
    overlay.querySelectorAll("[data-photo]").forEach((b) =>
      b.addEventListener("click", () => { state.photoId = b.dataset.photo; render(); }),
    );
    overlay.querySelector("[data-generate]")?.addEventListener("click", () => void generateBatch());
    overlay.querySelector("[data-regen]")?.addEventListener("click", () => void generateBatch());
    overlay.querySelector("[data-use]")?.addEventListener("click", () => void useSelected());
    overlay.querySelectorAll("[data-scene]").forEach((b) =>
      b.addEventListener("click", (e) => {
        // The check toggles selection; the rest of the tile opens the picker.
        if (e.target.closest("[data-sel]")) return;
        state.openScene = Number(b.dataset.scene);
        state.stage = "variant";
        render();
      }),
    );
    overlay.querySelectorAll("[data-sel]").forEach((b) =>
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        const i = Number(b.dataset.sel);
        if (state.selected.has(i)) state.selected.delete(i);
        else state.selected.add(i);
        render();
      }),
    );
    overlay.querySelectorAll("[data-light]").forEach((b) =>
      b.addEventListener("click", () => {
        const s = state.scenes[state.openScene];
        if (s) { s.chosen = Number(b.dataset.light); render(); }
      }),
    );
    overlay.querySelector("[data-redo]")?.addEventListener("click", () => void redoScene());
  }

  // Score a generated image against the user's real face (on-device).
  async function scoreFace(url) {
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const bmp = await createImageBitmap(blob);
      const d = await faceDistanceToMe(bmp);
      bmp.close?.();
      return d;
    } catch { return null; }
  }

  // Generate one scene's base (with identity verify + one reroll), then derive
  // its 5 on-device looks. Returns true on success.
  async function generateSceneBase(scene, verify, identityPhotoIds) {
    const opts = {
      mode: "me",
      subjectPhotoId: state.photoId,
      identityPhotoIds,
      stylePackId: state.pack,
      prompt: scene.prompt,
      pose: scene.pose || undefined,
      wardrobe: scene.wardrobe || undefined,
      environmentRef: scene.environmentRef,
      aspect: "4:5",
      quality: "pro",
      requestId: state.requestId,
    };
    const MAX_ATTEMPTS = verify ? 2 : 1;
    const GOOD = 0.55;
    let best = null, bestDist = Infinity;
    for (let a = 0; a < MAX_ATTEMPTS; a++) {
      const r = await generateScene(opts);
      if (r?.error) { if (!best) best = r; break; }
      if (!r?.url) break;
      if (!verify) { best = r; break; }
      const d = await scoreFace(r.url);
      if (d == null) { best = r; break; }
      if (d < bestDist) { bestDist = d; best = r; }
      if (d <= GOOD) break;
    }
    if (best?.error) return best; // {error:...}
    if (!best?.url) return { error: "failed" };
    revokeVariants(scene.variants);
    scene.baseUrl = best.url;
    scene.variants = await lightingVariants(best.url);
    scene.status = "done";
    scene.faceNote = verify && bestDist < Infinity ? (bestDist <= GOOD ? "Matched ✓" : "Closest match") : "";
    return { ok: true };
  }

  async function ensureIdentity() {
    let identityPhotoIds = [], verify = false;
    try {
      if (await hasMeIdentity()) {
        verify = true;
        identityPhotoIds = (await getMeReferences(4)).map((r) => r.photoId);
      }
    } catch { /* no identity */ }
    return { identityPhotoIds, verify };
  }

  async function generateBatch() {
    if (state.busy || !state.photoId) return;
    state.busy = true;
    state.error = "";
    // A fresh batch = a fresh free request id (server meters per requestId).
    try { state.requestId = crypto.randomUUID(); }
    catch { state.requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
    state.scenes = planBatch(state.pack, state.request, BATCH_MAX_SCENES);
    state.selected = new Set(state.scenes.map((_, i) => i));
    state.stage = "generating";
    state.progress = "";
    state.gen = createGenProgress({ request: state.request, packLabel, count: state.scenes.length });
    render();

    const { identityPhotoIds, verify } = await ensureIdentity();
    let lastError = null;
    for (let i = 0; i < state.scenes.length; i++) {
      state.progress = `Generating scene ${i + 1} of ${state.scenes.length}…`;
      state.gen?.setImage(i + 1, state.scenes.length);
      render();
      const r = await generateSceneBase(state.scenes[i], verify, identityPhotoIds);
      if (r?.error) {
        state.scenes[i].status = "error";
        lastError = r;
        // A paywall/sign-in error stops the batch — the free request is spent.
        if (r.error === "paywall" || r.error === "signin") break;
      }
      render();
    }
    state.gen?.finish();
    state.gen?.stop();
    state.gen = null;
    state.busy = false;

    const anyDone = state.scenes.some((s) => s.status === "done");
    if (anyDone) {
      // Keep only successfully-generated scenes in the results.
      state.scenes = state.scenes.filter((s) => s.status === "done");
      state.selected = new Set(state.scenes.map((_, i) => i));
      state.stage = "results";
    } else {
      state.stage = "setup";
      state.error = errorText(lastError);
    }
    render();
  }

  async function redoScene() {
    const s = state.scenes[state.openScene];
    if (state.busy || !s) return;
    state.busy = true;
    state.error = "";
    render();
    const { identityPhotoIds, verify } = await ensureIdentity();
    const r = await generateSceneBase(s, verify, identityPhotoIds);
    state.busy = false;
    if (r?.error) state.error = errorText(r);
    else s.chosen = DEFAULT_LIGHT_INDEX;
    render();
  }

  async function useSelected() {
    if (state.busy || !state.selected.size) return;
    state.busy = true;
    render();
    let saved = 0;
    for (const i of state.selected) {
      const s = state.scenes[i];
      const cur = s?.variants[s.chosen] || s?.variants[0];
      if (!cur?.url) continue;
      try {
        const res = await fetch(cur.url);
        const blob = await res.blob();
        await importPhotoFiles([new File([blob], `dump-${i + 1}.jpg`, { type: blob.type || "image/jpeg" })]);
        saved++;
      } catch (error) {
        console.info("save dump image failed", error);
      }
    }
    state.busy = false;
    const btn = overlay.querySelector("[data-use]");
    if (btn) btn.textContent = `Saved ${saved} ✓`;
    window.setTimeout(close, 900);
  }

  function errorText(err) {
    return err?.error === "signin" ? "Sign in to generate a dump."
      : err?.error === "paywall" ? "That was your free creation — subscribe to Gems Plus for more."
      : err?.error === "refused" ? (err.reply || "Try a different prompt.")
      : "That didn't generate — try again.";
  }

  render();
  window.addEventListener("keydown", function onKey(e) {
    if (e.key === "Escape") { close(); window.removeEventListener("keydown", onKey); }
  });
}
