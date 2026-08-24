import { editorActions } from "./editor-actions.js";
import { getPhoto, getPhotoBlob, listPhotos } from "./gems-photolib.js";
import { getSession } from "./gems-supabase.js";
import { parseEditIntent } from "./gems-edit-intent.js";
import {
  loadBitmap,
  applyAdjust,
  applyCrop,
  applyGrade,
  cssFilterFor,
  FILTER_GRADES,
} from "./gems-canvas.js";

// Deployed editing edge function. The publishable key is client-safe by
// design — the function authorizes every call with the user's session token.
const EDIT_FUNCTION_URL =
  "https://hkwkxacvcgorhthwyslx.supabase.co/functions/v1/edit-photo";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_Z8Fw1dZYiqOGUDITzU929A_i2k9wANc";

const MANUAL_TOOLS = Object.freeze(["Erase", "Add", "Crop", "Adjust", "Filters"]);

const TOOL_HELP = Object.freeze({
  Erase: "Brush over anything to remove it — Gems fills the background.",
  Add: "Tap where you want something added, then describe it.",
  Crop: "Drag the corners. Gems suggests the strongest crop.",
  Adjust: "Light, contrast, warmth, and sharpness — by hand.",
  Filters: "Your aesthetics as one-tap grades: Euro Summer, Dark Gym…",
});

const SUGGESTIONS = Object.freeze([
  "Make it darker",
  "Make it brighter",
  "More contrast",
  "Warmer",
  "Black and white",
  "Remove the ship in the background",
]);

function beachSceneMarkup() {
  return `
    <div class="editor-beach-scene" aria-hidden="true">
      <span class="editor-ship">
        <i class="editor-ship-hull"></i>
        <i class="editor-ship-mast"></i>
        <i class="editor-ship-cabin"></i>
      </span>
      <span class="editor-subject-head"></span>
      <span class="editor-subject-body"></span>
    </div>
  `;
}

function editorMarkup() {
  return `
    <header class="editor-topbar">
      <button id="editorBack" class="editor-icon-button" type="button" aria-label="Back to Photos">
        <svg viewBox="0 0 22 22" aria-hidden="true">
          <path d="M13.5 4.5 7 11l6.5 6.5"></path>
        </svg>
      </button>
      <h1 id="editorTitle" class="editor-title" tabindex="-1">Edit</h1>
      <button id="editorDone" class="editor-done" type="button">Done</button>
    </header>

    <div class="editor-content">
      <div id="editorCanvas" class="editor-canvas">
        ${beachSceneMarkup()}
        <img id="editorPhotoView" class="editor-photo" alt="" decoding="async" hidden />
        <div id="editorProcessing" class="editor-processing" role="status" aria-live="polite" hidden>
          <span class="editor-processing-card" aria-hidden="true"></span>
          <strong>Working on it…</strong>
        </div>
        <button id="editorReroll" class="editor-reroll" type="button" hidden>
          <svg viewBox="0 0 14 14" aria-hidden="true">
            <path d="M11.7 4.7A5 5 0 1 0 12 8M11.7 1.8v2.9H8.8"></path>
          </svg>
          <span>Try again</span>
        </button>
      </div>

      <div id="editorVersions" class="editor-versions home-scroll" aria-label="Edit versions"></div>

      <div class="editor-mode-toggle" role="group" aria-label="Editing mode">
        <button class="editor-mode is-active" type="button" data-editor-mode="describe" aria-pressed="true">
          Describe it
        </button>
        <button class="editor-mode" type="button" data-editor-mode="manual" aria-pressed="false">
          Manual tools
        </button>
      </div>

    <section id="editorDescribePanel" class="editor-panel editor-describe-panel" aria-label="Describe an edit">
      <div class="editor-suggestions home-scroll" aria-label="Suggested edits">
        ${SUGGESTIONS.map(
          (suggestion) => `
            <button class="editor-suggestion" type="button" data-editor-suggestion="${suggestion}">
              ${suggestion}
            </button>
          `,
        ).join("")}
      </div>
      <form id="editorPromptForm" class="editor-prompt-form">
        <label class="sr-only" for="editorPrompt">Describe the change you want</label>
        <input
          id="editorPrompt"
          type="text"
          autocomplete="off"
          enterkeyhint="send"
          placeholder="Describe the change you want…"
        />
        <button id="editorApply" class="editor-apply" type="submit" aria-label="Apply edit" disabled>
          <svg viewBox="0 0 15 15" aria-hidden="true">
            <path d="M7.5 12.5v-10M3.5 6.5l4-4 4 4"></path>
          </svg>
        </button>
      </form>
      <p id="editorStatus" class="sr-only" aria-live="polite"></p>
    </section>

    <section id="editorManualPanel" class="editor-panel editor-manual-panel" aria-label="Manual editing tools" hidden>
      <div id="editorTools" class="editor-tools">
        ${MANUAL_TOOLS.map(
          (tool) => `
            <button
              class="editor-tool${tool === "Erase" ? " is-active" : ""}"
              type="button"
              data-editor-tool="${tool}"
              aria-pressed="${tool === "Erase"}"
            >
              ${tool}
            </button>
          `,
        ).join("")}
      </div>
      <p id="editorToolHelp" class="editor-tool-help">${TOOL_HELP.Erase}</p>
      <div id="editorToolPanel" class="editor-tool-panel" hidden></div>
    </section>
    </div>
  `;
}

const ASPECT_PRESETS = Object.freeze([
  { key: "orig", label: "Original", ratio: null },
  { key: "1x1", label: "1:1", ratio: 1 },
  { key: "4x5", label: "4:5", ratio: 4 / 5 },
  { key: "16x9", label: "16:9", ratio: 16 / 9 },
]);

// HTML-escape interpolated text so labels/instructions can never break markup.
function esc(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[ch],
  );
}

// The letterboxed rectangle a `contain`-fitted image occupies inside its box.
function containRect(boxW, boxH, natW, natH) {
  if (!boxW || !boxH || !natW || !natH) {
    return { left: 0, top: 0, width: boxW || 0, height: boxH || 0 };
  }
  const scale = Math.min(boxW / natW, boxH / natH);
  const width = natW * scale;
  const height = natH * scale;
  return { left: (boxW - width) / 2, top: (boxH - height) / 2, width, height };
}

/**
 * @param {{screen: HTMLElement, mount: HTMLElement, onNavigate?: (tab: string) => void}} options
 */
export function createEditorScreen({ screen, mount, onNavigate = () => {} }) {
  mount.innerHTML = editorMarkup();

  const title = mount.querySelector("#editorTitle");
  const done = mount.querySelector("#editorDone");
  const canvas = mount.querySelector("#editorCanvas");
  const photoView = mount.querySelector("#editorPhotoView");
  const processingOverlay = mount.querySelector("#editorProcessing");
  const reroll = mount.querySelector("#editorReroll");
  const versionsRoot = mount.querySelector("#editorVersions");
  const describePanel = mount.querySelector("#editorDescribePanel");
  const manualPanel = mount.querySelector("#editorManualPanel");
  const promptForm = mount.querySelector("#editorPromptForm");
  const promptInput = mount.querySelector("#editorPrompt");
  const applyButton = mount.querySelector("#editorApply");
  const status = mount.querySelector("#editorStatus");
  const toolHelp = mount.querySelector("#editorToolHelp");
  const toolPanel = mount.querySelector("#editorToolPanel");
  let mode = "describe";
  let tool = "Erase";
  let versions = [];
  let activeVersionId = 0;
  let processing = false;
  let processingTimer = 0;
  // Manual (client-side) editing state — only ever engaged in real-photo mode.
  const versionBlobs = new Map(); // versionId -> committed Blob
  const bitmapCache = new Map(); // versionId -> decoded bitmap
  const createdUrls = []; // object URLs to revoke on teardown
  let cropCleanup = null; // detaches the active crop overlay + listeners
  let manualBusy = false; // guards overlapping client-side commits
  // Real-photo mode: set when the activation payload names a library photo AND
  // a session exists. Null means the simulated demo flow is in charge.
  let photo = null;
  let lastInstruction = "";
  let abortController = null;
  // Bumped on every activate/deactivate so stale async work bails cleanly.
  let activationToken = 0;

  function currentVersion() {
    return versions.find((version) => version.id === activeVersionId) || versions[0];
  }

  function syncCanvas() {
    const version = currentVersion();
    canvas.classList.toggle("is-real", Boolean(photo));
    photoView.hidden = !photo;
    if (photo) {
      const url = version?.url ?? "";
      if (url && photoView.getAttribute("src") !== url) photoView.src = url;
    } else {
      photoView.removeAttribute("src");
      canvas.classList.toggle("has-no-ship", version && !version.ship);
    }
    canvas.classList.toggle("is-processing", processing);
    processingOverlay.hidden = !processing;
    reroll.hidden = processing || activeVersionId === 0;
    done.disabled = processing;
  }

  function renderVersions({ focusActive = false } = {}) {
    versionsRoot.innerHTML = versions
      .map(
        (version) => `
          <button
            class="editor-version${version.id === activeVersionId ? " is-active" : ""}"
            type="button"
            data-editor-version="${version.id}"
            aria-pressed="${version.id === activeVersionId}"
            ${processing ? "disabled" : ""}
          >
            ${version.label}
          </button>
        `,
      )
      .join("");

    versionsRoot.querySelectorAll("[data-editor-version]").forEach((button) => {
      button.addEventListener("click", () => {
        activeVersionId = Number(button.dataset.editorVersion);
        renderVersions();
        syncCanvas();
        // Manual mode: a different base image means the tool must rebuild
        // (crop overlay repositions, sliders reset).
        if (mode === "manual" && photo) renderToolControls(tool);
      });
    });

    if (focusActive) {
      window.requestAnimationFrame(() => {
        versionsRoot
          .querySelector(`[data-editor-version="${activeVersionId}"]`)
          ?.focus({ preventScroll: true });
      });
    }
  }

  function syncPrompt() {
    const hasPrompt = promptInput.value.trim().length > 0;
    promptForm.classList.toggle("has-value", hasPrompt);
    applyButton.disabled = processing || !hasPrompt;
  }

  function setMode(nextMode) {
    mode = nextMode;
    mount.querySelectorAll("[data-editor-mode]").forEach((button) => {
      const active = button.dataset.editorMode === mode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    describePanel.hidden = mode !== "describe";
    manualPanel.hidden = mode !== "manual";
    if (mode === "describe") {
      teardownToolPanel();
      syncPrompt();
    } else {
      renderToolControls(tool);
    }
  }

  function setTool(nextTool) {
    tool = nextTool;
    mount.querySelectorAll("[data-editor-tool]").forEach((button) => {
      const active = button.dataset.editorTool === tool;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    toolHelp.textContent = TOOL_HELP[tool];
    editorActions.selectManualTool(tool);
    renderToolControls(tool);
  }

  // ---- Manual editing: shared plumbing ------------------------------------

  // Drop any live preview: clears the <img> CSS filter and removes the crop
  // overlay + its listeners. Safe to call anytime.
  function resetPreview() {
    photoView.style.filter = "";
    if (cropCleanup) {
      try {
        cropCleanup();
      } catch (error) {
        console.info("Crop cleanup failed", error);
      }
      cropCleanup = null;
    }
  }

  function teardownToolPanel() {
    resetPreview();
    toolPanel.hidden = true;
    toolPanel.innerHTML = "";
  }

  // Revoke every object URL minted for a committed manual version.
  function revokeManualUrls() {
    while (createdUrls.length) {
      const url = createdUrls.pop();
      try {
        URL.revokeObjectURL(url);
      } catch (error) {
        console.info("Object URL revoke failed", error);
      }
    }
  }

  // Decode the currently active version to a drawable bitmap (cached per id).
  async function activeBitmap() {
    const version = currentVersion();
    if (!version || !photo) return null;
    if (bitmapCache.has(version.id)) return bitmapCache.get(version.id);
    let blob = versionBlobs.get(version.id);
    if (!blob && version.id === 0) blob = await getPhotoBlob(photo.id);
    if (!blob) return null;
    const bitmap = await loadBitmap(blob);
    if (bitmap) bitmapCache.set(version.id, bitmap);
    return bitmap;
  }

  // Commit a client-side result (crop/adjust/grade) as a new, non-destructive
  // version and make it active. The Original is never touched.
  function commitManualVersion(label, blob, toolName) {
    if (!blob) {
      status.textContent = "That edit couldn't be applied — try again.";
      return false;
    }
    let url = "";
    try {
      url = URL.createObjectURL(blob);
    } catch (error) {
      console.info("Object URL creation failed", error);
      status.textContent = "That edit couldn't be applied — try again.";
      return false;
    }
    const nextId = versions.length;
    versions.push({ id: nextId, label, url });
    versionBlobs.set(nextId, blob);
    createdUrls.push(url);
    activeVersionId = nextId;
    editorActions.manualEditApplied(toolName);
    resetPreview();
    renderVersions({ focusActive: true });
    syncCanvas();
    renderToolControls(tool);
    status.textContent = `${label} applied — saved as a new version.`;
    return true;
  }

  // Route the tool to its control renderer. Only real-photo mode gets live
  // controls; demo mode keeps the original visual-only manual panel.
  function renderToolControls(toolName) {
    resetPreview();
    if (!photo) {
      toolPanel.hidden = true;
      toolPanel.innerHTML = "";
      return;
    }
    toolPanel.hidden = false;
    if (toolName === "Crop") renderCropTool();
    else if (toolName === "Adjust") renderAdjustTool();
    else if (toolName === "Filters") renderFiltersTool();
    else if (toolName === "Erase") renderAiTool("Erase");
    else if (toolName === "Add") renderAiTool("Add");
    else {
      toolPanel.hidden = true;
      toolPanel.innerHTML = "";
    }
  }

  // ---- Adjust ------------------------------------------------------------

  function renderAdjustTool() {
    const fields = [
      { key: "brightness", label: "Brightness" },
      { key: "contrast", label: "Contrast" },
      { key: "saturation", label: "Saturation" },
      { key: "warmth", label: "Warmth" },
    ];
    const values = { brightness: 0, contrast: 0, saturation: 0, warmth: 0 };
    toolPanel.innerHTML = `
      <div class="editor-adjust">
        ${fields
          .map(
            (field) => `
              <label class="editor-slider">
                <span class="editor-slider-label">${esc(field.label)}</span>
                <input
                  type="range"
                  min="-100"
                  max="100"
                  value="0"
                  step="1"
                  data-adjust="${esc(field.key)}"
                  aria-label="${esc(field.label)}"
                />
                <output data-adjust-out="${esc(field.key)}">0</output>
              </label>
            `,
          )
          .join("")}
        <div class="editor-manual-actions">
          <button type="button" class="editor-manual-reset" data-adjust-reset>Reset</button>
          <button type="button" class="editor-manual-apply" data-adjust-apply>Apply</button>
        </div>
      </div>
    `;

    const preview = () => {
      photoView.style.filter = cssFilterFor(values);
    };
    toolPanel.querySelectorAll("[data-adjust]").forEach((input) => {
      input.addEventListener("input", () => {
        const key = input.dataset.adjust;
        values[key] = Number(input.value) || 0;
        const out = toolPanel.querySelector(`[data-adjust-out="${key}"]`);
        if (out) out.textContent = String(values[key]);
        preview();
      });
    });
    toolPanel.querySelector("[data-adjust-reset]")?.addEventListener("click", () => {
      fields.forEach((field) => {
        values[field.key] = 0;
        const input = toolPanel.querySelector(`[data-adjust="${field.key}"]`);
        const out = toolPanel.querySelector(`[data-adjust-out="${field.key}"]`);
        if (input) input.value = "0";
        if (out) out.textContent = "0";
      });
      photoView.style.filter = "";
    });
    toolPanel.querySelector("[data-adjust-apply]")?.addEventListener("click", async () => {
      if (manualBusy) return;
      const noChange = fields.every((field) => values[field.key] === 0);
      if (noChange) {
        status.textContent = "Move a slider first, then Apply.";
        return;
      }
      manualBusy = true;
      status.textContent = "Applying adjustments…";
      const bitmap = await activeBitmap();
      const blob = bitmap ? applyAdjust(bitmap, values) : null;
      manualBusy = false;
      commitManualVersion("Adjust", blob, "Adjust");
    });
  }

  // ---- Filters (one-tap grades) ------------------------------------------

  function renderFiltersTool() {
    let selected = null;
    toolPanel.innerHTML = `
      <div class="editor-filter-rail home-scroll" role="listbox" aria-label="Filter grades">
        ${FILTER_GRADES.map(
          (grade) => `
            <button
              type="button"
              class="editor-filter-chip"
              role="option"
              aria-selected="false"
              data-grade="${esc(grade.key)}"
            >${esc(grade.label)}</button>
          `,
        ).join("")}
      </div>
      <div class="editor-manual-actions">
        <button type="button" class="editor-manual-reset" data-filter-clear>Clear</button>
        <button type="button" class="editor-manual-apply" data-filter-apply disabled>Apply</button>
      </div>
      <p class="editor-style-hint">
        <button type="button" class="editor-style-link" data-style-open>Make it look like…</button>
        a photo from your library
      </p>
      <div class="editor-style-picker" data-style-picker hidden></div>
    `;
    const applyBtn = toolPanel.querySelector("[data-filter-apply]");
    const markSelected = (key) => {
      selected = key;
      toolPanel.querySelectorAll("[data-grade]").forEach((chip) => {
        const on = chip.dataset.grade === key;
        chip.classList.toggle("is-active", on);
        chip.setAttribute("aria-selected", String(on));
      });
      if (applyBtn) applyBtn.disabled = !key;
    };

    toolPanel.querySelectorAll("[data-grade]").forEach((chip) => {
      chip.addEventListener("click", () => {
        const grade = FILTER_GRADES.find((entry) => entry.key === chip.dataset.grade);
        if (!grade) return;
        markSelected(grade.key);
        photoView.style.filter = cssFilterFor(grade.adjust);
      });
    });
    toolPanel.querySelector("[data-filter-clear]")?.addEventListener("click", () => {
      markSelected(null);
      photoView.style.filter = "";
    });
    applyBtn?.addEventListener("click", async () => {
      if (manualBusy || !selected) return;
      const grade = FILTER_GRADES.find((entry) => entry.key === selected);
      if (!grade) return;
      manualBusy = true;
      status.textContent = `Applying ${grade.label}…`;
      const bitmap = await activeBitmap();
      const blob = bitmap ? applyGrade(bitmap, grade) : null;
      manualBusy = false;
      commitManualVersion(grade.label, blob, "Filters");
    });

    // "Make it look like…" — the only entry point into gems-style. Loaded
    // lazily so a missing sibling module can never break the editor at import.
    toolPanel.querySelector("[data-style-open]")?.addEventListener("click", () => {
      void openStylePicker(toolPanel.querySelector("[data-style-picker]"));
    });
  }

  async function openStylePicker(host) {
    if (!host || !photo) return;
    host.hidden = false;
    host.innerHTML = `<p class="editor-style-loading">Loading your photos…</p>`;
    let others = [];
    try {
      const all = await listPhotos();
      others = (all || []).filter((entry) => entry.id !== photo.id).slice(0, 12);
    } catch (error) {
      console.info("Reference list failed", error);
    }
    if (!others.length) {
      host.innerHTML = `<p class="editor-style-loading">Import more photos to borrow a look.</p>`;
      return;
    }
    host.innerHTML = others
      .map(
        (entry) => `
          <button type="button" class="editor-style-ref" data-ref="${esc(entry.id)}" aria-label="Use this photo's look">
            <img src="${esc(entry.url)}" alt="" loading="lazy" decoding="async" />
          </button>
        `,
      )
      .join("");
    host.querySelectorAll("[data-ref]").forEach((button) => {
      button.addEventListener("click", () => {
        void applyReferenceStyle(button.dataset.ref);
      });
    });
  }

  async function applyReferenceStyle(referencePhotoId) {
    if (manualBusy || !photo || !referencePhotoId) return;
    manualBusy = true;
    status.textContent = "Borrowing that look…";
    try {
      const mod = await import("./gems-style.js");
      const result = await mod.applyStyleFromReference({
        targetPhotoId: photo.id,
        referencePhotoId,
      });
      if (result?.url) {
        const nextId = versions.length;
        versions.push({ id: nextId, label: "Style", url: result.url });
        activeVersionId = nextId;
        editorActions.manualEditApplied("Style");
        resetPreview();
        renderVersions({ focusActive: true });
        syncCanvas();
        renderToolControls(tool);
        status.textContent = "Style applied — saved as a new version.";
      } else if (result?.paywall) {
        status.textContent = "Borrowing looks is a Gems Plus feature.";
      } else if (result?.quota) {
        status.textContent = "The style model is warming up — try again soon.";
      } else {
        status.textContent = "That look couldn't be applied — try again.";
      }
    } catch (error) {
      console.info("applyStyleFromReference unavailable", error);
      status.textContent = "That look couldn't be applied — try again.";
    } finally {
      manualBusy = false;
    }
  }

  // ---- Erase / Add (AI tools, model-gated) -------------------------------

  function renderAiTool(kind) {
    const isErase = kind === "Erase";
    const heading = isErase ? "What should Gems remove?" : "What should Gems add?";
    const placeholder = isErase
      ? "e.g. the trash can on the left"
      : "e.g. a soft sunset glow";
    toolPanel.innerHTML = `
      <form class="editor-ai-form" data-ai-form>
        <span class="editor-ai-badge">AI tool</span>
        <label class="sr-only" for="editorAiInput">${esc(heading)}</label>
        <input
          id="editorAiInput"
          type="text"
          autocomplete="off"
          enterkeyhint="send"
          placeholder="${esc(placeholder)}"
          data-ai-input
        />
        <button type="submit" class="editor-manual-apply" data-ai-apply disabled>Apply</button>
      </form>
      <p class="editor-ai-note">${esc(heading)} Gems generates the result — this needs an online edit.</p>
    `;
    const input = toolPanel.querySelector("[data-ai-input]");
    const applyBtn = toolPanel.querySelector("[data-ai-apply]");
    input?.addEventListener("input", () => {
      if (applyBtn) applyBtn.disabled = input.value.trim().length === 0;
    });
    toolPanel.querySelector("[data-ai-form]")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = (input?.value || "").trim();
      if (!text || processing) return;
      const instruction = isErase
        ? `Erase the ${text}, reconstructing what's naturally behind it.`
        : `Add: ${text}`;
      if (input) input.value = "";
      if (applyBtn) applyBtn.disabled = true;
      void requestRealEdit(instruction, isErase ? "erase" : "add");
    });
  }

  // ---- Crop --------------------------------------------------------------

  function renderCropTool() {
    toolPanel.innerHTML = `
      <div class="editor-crop-presets" role="group" aria-label="Crop aspect ratio">
        ${ASPECT_PRESETS.map(
          (preset, index) => `
            <button
              type="button"
              class="editor-crop-preset${index === 0 ? " is-active" : ""}"
              data-aspect="${esc(preset.key)}"
              aria-pressed="${index === 0}"
            >${esc(preset.label)}</button>
          `,
        ).join("")}
      </div>
      <div class="editor-manual-actions">
        <button type="button" class="editor-manual-apply" data-crop-apply>Apply crop</button>
      </div>
    `;
    void setupCropOverlay();

    toolPanel.querySelectorAll("[data-aspect]").forEach((button) => {
      button.addEventListener("click", () => {
        toolPanel.querySelectorAll("[data-aspect]").forEach((other) => {
          const on = other === button;
          other.classList.toggle("is-active", on);
          other.setAttribute("aria-pressed", String(on));
        });
        const preset = ASPECT_PRESETS.find((entry) => entry.key === button.dataset.aspect);
        cropState.aspect = preset ? preset.ratio : null;
        resetCropSelection();
      });
    });
    toolPanel.querySelector("[data-crop-apply]")?.addEventListener("click", () => {
      void applyCropSelection();
    });
  }

  // Crop selection is stored in overlay-local CSS px; the overlay itself is
  // positioned over the letterboxed image, so overlay px map linearly to the
  // bitmap's natural pixels at apply time.
  const cropState = {
    aspect: null,
    overlay: null,
    frame: null,
    rect: { x: 0, y: 0, w: 0, h: 0 },
    natW: 0,
    natH: 0,
  };

  async function setupCropOverlay() {
    const bitmap = await activeBitmap();
    if (!bitmap || tool !== "Crop" || mode !== "manual") return;
    cropState.natW = bitmap.width || bitmap.naturalWidth || 0;
    cropState.natH = bitmap.height || bitmap.naturalHeight || 0;

    const box = canvas.getBoundingClientRect();
    const fit = containRect(box.width, box.height, cropState.natW, cropState.natH);

    const overlay = document.createElement("div");
    overlay.className = "editor-crop-overlay";
    overlay.style.left = `${fit.left}px`;
    overlay.style.top = `${fit.top}px`;
    overlay.style.width = `${fit.width}px`;
    overlay.style.height = `${fit.height}px`;

    const frame = document.createElement("div");
    frame.className = "editor-crop-frame";
    ["nw", "ne", "sw", "se"].forEach((corner) => {
      const handle = document.createElement("span");
      handle.className = `editor-crop-handle editor-crop-handle--${corner}`;
      handle.dataset.corner = corner;
      frame.appendChild(handle);
    });
    overlay.appendChild(frame);
    canvas.appendChild(overlay);

    cropState.overlay = overlay;
    cropState.frame = frame;
    resetCropSelection();

    const cleanup = attachCropPointer(overlay, frame);
    cropCleanup = () => {
      cleanup();
      overlay.remove();
      cropState.overlay = null;
      cropState.frame = null;
    };
  }

  // Fit the selection to the overlay, honoring the current aspect ratio.
  function resetCropSelection() {
    const overlay = cropState.overlay;
    if (!overlay) return;
    const ow = overlay.clientWidth;
    const oh = overlay.clientHeight;
    let w = ow;
    let h = oh;
    if (cropState.aspect) {
      if (ow / oh > cropState.aspect) {
        h = oh;
        w = h * cropState.aspect;
      } else {
        w = ow;
        h = w / cropState.aspect;
      }
    }
    cropState.rect = { x: (ow - w) / 2, y: (oh - h) / 2, w, h };
    paintCropFrame();
  }

  function paintCropFrame() {
    const frame = cropState.frame;
    const r = cropState.rect;
    if (!frame) return;
    frame.style.left = `${r.x}px`;
    frame.style.top = `${r.y}px`;
    frame.style.width = `${r.w}px`;
    frame.style.height = `${r.h}px`;
  }

  function attachCropPointer(overlay, frame) {
    const MIN = 32; // minimum selection in overlay px
    let dragging = null; // { mode:"move"|corner, startX, startY, start:{...} }

    const onDown = (event) => {
      const corner = event.target?.dataset?.corner;
      const startX = event.clientX;
      const startY = event.clientY;
      dragging = {
        mode: corner || "move",
        startX,
        startY,
        start: { ...cropState.rect },
      };
      try {
        event.target.setPointerCapture?.(event.pointerId);
      } catch {
        /* ignore */
      }
      event.preventDefault();
    };

    const onMove = (event) => {
      if (!dragging) return;
      const ow = overlay.clientWidth;
      const oh = overlay.clientHeight;
      const dx = event.clientX - dragging.startX;
      const dy = event.clientY - dragging.startY;
      const s = dragging.start;

      if (dragging.mode === "move") {
        let x = Math.max(0, Math.min(s.x + dx, ow - s.w));
        let y = Math.max(0, Math.min(s.y + dy, oh - s.h));
        cropState.rect = { x, y, w: s.w, h: s.h };
      } else {
        // Corner resize: opposite corner stays anchored.
        const right = s.x + s.w;
        const bottom = s.y + s.h;
        const west = dragging.mode.includes("w");
        const north = dragging.mode.includes("n");
        let x = west ? Math.min(s.x + dx, right - MIN) : s.x;
        let y = north ? Math.min(s.y + dy, bottom - MIN) : s.y;
        let w = west ? right - x : Math.max(MIN, s.w + dx);
        let h = north ? bottom - y : Math.max(MIN, s.h + dy);

        if (cropState.aspect) {
          // Lock height to width by the ratio, then re-anchor.
          h = w / cropState.aspect;
          if (north) y = bottom - h;
          if (h < MIN) {
            h = MIN;
            w = h * cropState.aspect;
            if (west) x = right - w;
            if (north) y = bottom - h;
          }
        }
        // Clamp into the overlay.
        x = Math.max(0, x);
        y = Math.max(0, y);
        w = Math.min(w, ow - x);
        h = Math.min(h, oh - y);
        if (cropState.aspect) {
          // Re-derive width from the clamped height to keep the ratio exact.
          w = Math.min(w, h * cropState.aspect);
          h = w / cropState.aspect;
        }
        cropState.rect = { x, y, w: Math.max(MIN, w), h: Math.max(MIN, h) };
      }
      paintCropFrame();
      event.preventDefault();
    };

    const onUp = () => {
      dragging = null;
    };

    frame.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      frame.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }

  async function applyCropSelection() {
    if (manualBusy || !cropState.overlay) return;
    manualBusy = true;
    status.textContent = "Cropping…";
    const bitmap = await activeBitmap();
    const overlay = cropState.overlay;
    if (!bitmap || !overlay) {
      manualBusy = false;
      status.textContent = "That crop couldn't be applied — try again.";
      return;
    }
    const scaleX = cropState.natW / overlay.clientWidth;
    const scaleY = cropState.natH / overlay.clientHeight;
    const r = cropState.rect;
    const blob = applyCrop(bitmap, {
      x: r.x * scaleX,
      y: r.y * scaleY,
      w: r.w * scaleX,
      h: r.h * scaleY,
    });
    manualBusy = false;
    commitManualVersion("Crop", blob, "Crop");
  }

  // Try to swap the canvas from the simulated scene to the real library photo.
  // Anything missing — no record, no session, storage failure — leaves the
  // demo flow untouched.
  async function loadRealPhoto(photoId, token) {
    try {
      // Load the real photo whenever it exists — crop/adjust/filters are pure
      // on-device work and need no session. The AI tools (describe/erase/add/
      // style) check for a session themselves at request time and fail gracefully.
      const record = await getPhoto(photoId);
      if (token !== activationToken || !record) return;
      // A simulated edit already started in the gap — don't clobber it.
      if (processing || versions.length > 1) return;
      photo = record;
      photoView.alt = record.name || "Photo being edited";
      versions = [{ id: 0, label: "Original", url: record.url }];
      activeVersionId = 0;
      bitmapCache.clear();
      versionBlobs.clear();
      renderVersions();
      syncCanvas();
      // If Manual mode was opened first, its tools were empty in demo mode —
      // now that a real photo is present, bring the live controls up.
      if (mode === "manual") renderToolControls(tool);
    } catch (error) {
      console.info("Real photo load skipped, staying in demo mode", error);
    }
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result ?? "");
        resolve(result.slice(result.indexOf(",") + 1));
      };
      reader.onerror = () => reject(reader.error ?? new Error("Photo read failed"));
      reader.readAsDataURL(blob);
    });
  }

  // Real edit: sends the instruction and the original photo to the deployed
  // edge function, then appends the signed result URL as a new version.
  async function requestRealEdit(instruction, kind) {
    if (!instruction || processing) return;
    const token = activationToken;
    const sourceVersion = currentVersion();
    editorActions.requestEdit(instruction, sourceVersion);
    if (kind === "describe") lastInstruction = instruction;
    promptInput.value = "";
    processing = true;
    syncPrompt();
    renderVersions();
    syncCanvas();
    status.textContent = `Applying edit: ${instruction}`;
    abortController = new AbortController();
    let succeeded = false;

    try {
      // Full-resolution pixels leave the browser only for an explicitly
      // requested edit — per the privacy architecture, everything else
      // (ranking, metrics, thumbnails) stays fully on-device.
      const blob = await getPhotoBlob(photo.id);
      if (!blob) throw new Error("Original photo unavailable");
      const imageBase64 = await blobToBase64(blob);
      const session = await getSession();
      if (!session) throw new Error("No session for edit");
      if (token !== activationToken) return;

      const response = await fetch(EDIT_FUNCTION_URL, {
        method: "POST",
        signal: abortController.signal,
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          apikey: SUPABASE_PUBLISHABLE_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          instruction,
          kind,
          photoId: photo.id,
          imageBase64,
          mimeType: blob.type || photo.type || "image/jpeg",
        }),
      });
      const data = await response.json().catch(() => null);
      if (token !== activationToken) return;

      if (response.ok && data?.url) {
        const nextId = versions.length;
        versions.push({ id: nextId, label: `V${nextId}`, url: data.url });
        activeVersionId = nextId;
        succeeded = true;
        status.textContent = `Version ${nextId} is ready.`;
        editorActions.editResultShown(data.kind ?? kind, data.model ?? "unknown");
      } else if (response.status === 402) {
        const cap = Number(data?.cap);
        status.textContent = Number.isFinite(cap)
          ? `You've used all ${cap} free edits this month — Gems Plus unlocks more.`
          : "You've used all your free edits this month — Gems Plus unlocks more.";
      } else if (response.status === 503 && data?.error === "image_model_quota") {
        status.textContent = "The editing model is warming up — try again soon.";
      } else {
        status.textContent = "That edit didn't go through — try again.";
      }
    } catch (error) {
      if (error?.name === "AbortError" || token !== activationToken) return;
      console.info("Edit request failed", error);
      status.textContent = "That edit didn't go through — try again.";
    } finally {
      if (token === activationToken) {
        processing = false;
        renderVersions({ focusActive: succeeded });
        syncCanvas();
        syncPrompt();
      }
    }
  }

  // A described edit that is pure tonal math (darker, lighter, more contrast,
  // warmer, black & white, a named grade…) runs INSTANTLY on-device — no model
  // call, no cost, and it always does exactly what was asked. Content edits
  // fall through to the generative model.
  async function applyDescribedAdjustment(intent, prompt) {
    try {
      const bitmap = await activeBitmap();
      if (!bitmap) {
        void requestRealEdit(prompt, "describe");
        return;
      }
      const blob =
        intent.kind === "grade"
          ? applyGrade(bitmap, intent.grade)
          : applyAdjust(bitmap, intent.adjust);
      if (!blob) {
        status.textContent = "That edit couldn't be applied — try again.";
        return;
      }
      promptInput.value = "";
      syncPrompt();
      commitManualVersion(intent.summary, blob, "Describe");
      editorActions.requestEdit(prompt, currentVersion());
    } catch (error) {
      console.info("On-device described edit failed, trying the model", error);
      void requestRealEdit(prompt, "describe");
    }
  }

  function requestEdit(rawPrompt) {
    const prompt = rawPrompt.trim();
    if (!prompt || processing) return;
    if (photo) {
      const intent = parseEditIntent(prompt);
      if (intent.kind !== "ai") {
        void applyDescribedAdjustment(intent, prompt);
        return;
      }
      void requestRealEdit(prompt, "describe");
      return;
    }
    const sourceVersion = currentVersion();
    editorActions.requestEdit(prompt, sourceVersion);
    promptInput.value = "";
    processing = true;
    syncPrompt();
    renderVersions();
    syncCanvas();
    status.textContent = `Applying edit: ${prompt}`;

    processingTimer = window.setTimeout(() => {
      const removesShip = /ship|boat/i.test(prompt);
      const nextId = versions.length;
      versions.push({
        id: nextId,
        label: `V${nextId}`,
        ship: removesShip ? false : sourceVersion.ship,
      });
      activeVersionId = nextId;
      processing = false;
      renderVersions({ focusActive: true });
      syncCanvas();
      syncPrompt();
      status.textContent = removesShip
        ? `Version ${nextId} is ready. The ship was removed.`
        : `Version ${nextId} is ready.`;
    }, 1400);
  }

  mount.querySelector("#editorBack").addEventListener("click", () => onNavigate("Photos"));
  done.addEventListener("click", () => {
    if (processing) return;
    editorActions.completeEdit(currentVersion());
    onNavigate("Photos");
  });
  reroll.addEventListener("click", () => {
    // In real-photo mode a reroll re-sends the LAST instruction with a
    // "reroll" kind; the demo keeps its original simulated behavior.
    if (photo) void requestRealEdit(lastInstruction, "reroll");
    else requestEdit("Try another result");
  });

  mount.querySelectorAll("[data-editor-mode]").forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.editorMode));
  });

  mount.querySelectorAll("[data-editor-suggestion]").forEach((button) => {
    button.addEventListener("click", () => requestEdit(button.dataset.editorSuggestion));
  });

  mount.querySelectorAll("[data-editor-tool]").forEach((button) => {
    button.addEventListener("click", () => setTool(button.dataset.editorTool));
  });

  promptInput.addEventListener("input", syncPrompt);
  promptForm.addEventListener("submit", (event) => {
    event.preventDefault();
    requestEdit(promptInput.value);
  });

  // Keep the describe input visible above the iOS keyboard. The body is pinned
  // to the visual viewport (styles.css) so the page never scrolls; we only need
  // to nudge the editor's own scroll region if the input is actually hidden —
  // and instantly ("nearest", no smooth animation), so it never slides/jitters.
  function keepPromptVisible() {
    if (document.activeElement !== promptInput) return;
    window.requestAnimationFrame(() =>
      promptInput.scrollIntoView({ block: "nearest", behavior: "auto" }),
    );
  }
  promptInput.addEventListener("focus", () => window.setTimeout(keepPromptVisible, 220));
  window.visualViewport?.addEventListener("resize", keepPromptVisible);

  return Object.freeze({
    activate(options = {}) {
      window.clearTimeout(processingTimer);
      abortController?.abort();
      abortController = null;
      activationToken += 1;
      revokeManualUrls();
      teardownToolPanel();
      bitmapCache.clear();
      versionBlobs.clear();
      manualBusy = false;
      photo = null;
      lastInstruction = "";
      versions = [{ id: 0, label: "Original", ship: true }];
      activeVersionId = 0;
      processing = false;
      tool = "Erase";
      promptInput.value = "";
      renderVersions();
      syncCanvas();
      syncPrompt();
      setTool("Erase");
      setMode(options.mode === "manual" ? "manual" : "describe");
      status.textContent = "Original photo loaded.";
      if (options.photoId) void loadRealPhoto(options.photoId, activationToken);
    },

    focusHeading() {
      title.focus({ preventScroll: true });
    },

    deactivate() {
      window.clearTimeout(processingTimer);
      abortController?.abort();
      abortController = null;
      activationToken += 1;
      processing = false;
      manualBusy = false;
      teardownToolPanel();
      revokeManualUrls();
      bitmapCache.clear();
      versionBlobs.clear();
      syncCanvas();
      syncPrompt();
    },
  });
}
