import { editorActions } from "./editor-actions.js";
import { getPhoto, getPhotoBlob, listPhotos } from "./gems-photolib.js";
import { getSession } from "./gems-supabase.js";
import {
  loadBitmap,
  applyAdjust,
  applyCrop,
  applyGrade,
  applyGeometry,
  applyPerspective,
  applyOverlay,
  applyCurve,
  applyLevels,
  applyHsl,
  applyChannelGains,
  applyMaskedAdjust,
  applyPortraitBlur,
  buildAutoMask,
  applyRecipe,
  HSL_BANDS,
  cssFilterFor,
  FILTER_GRADES,
  matchNamedGrade,
} from "./gems-canvas.js";

import { loadPresets, savePresetsList } from "./gems-presets.js";
import { segmentPerson } from "./gems-segment.js";
import { interpretEdit, pushSessionOp, cropRectFor, prewarmInterpreter, hasEditOp } from "./gems-edit-interpreter.js";
import { createGenProgress } from "./gems-gen-progress.js";
import { generateScene, matchPackForText } from "./gems-scenes.js";
import { hasMeIdentity, getMeReferences, faceDistanceToMe } from "./gems-faces.js";

// Deployed editing edge function. The publishable key is client-safe by
// design — the function authorizes every call with the user's session token.
const EDIT_FUNCTION_URL =
  "https://hkwkxacvcgorhthwyslx.supabase.co/functions/v1/edit-photo";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_Z8Fw1dZYiqOGUDITzU929A_i2k9wANc";

const MANUAL_TOOLS = Object.freeze([
  "Presets", "Adjust", "Filters", "Curves", "Levels", "HSL", "White Balance",
  "Selective", "Crop", "Rotate", "Perspective", "Draw", "Text", "Dodge & Burn",
  "Clone", "Blur & Sharpen", "Portrait Blur", "Whiten", "Stickers", "Looks",
  "Retouch", "Erase", "Add",
]);

// Transformative one-tap AI "Looks" — reimagine the photo as a professional shot
// while keeping the exact person. Built for the athlete commitment/agency use case.
const LOOK_OPS = Object.freeze([
  { key: "commitment", label: "Commitment", instruction: "Turn this into a hero athlete portrait for a college commitment / signing-day announcement." },
  { key: "agency", label: "Agency headshot", instruction: "Make this a clean professional agency headshot." },
  { key: "editorial", label: "Editorial", instruction: "Make this a dramatic editorial sports portrait, magazine-cover quality." },
  { key: "studio", label: "Studio portrait", instruction: "Make this a polished studio portrait." },
  { key: "linkedin", label: "LinkedIn pro", instruction: "Make this a professional corporate LinkedIn headshot." },
  { key: "model", label: "Model portfolio", instruction: "Make this a high-fashion model portfolio shot." },
]);

// Representative swatch color per HSL band.
const HSL_SWATCH = Object.freeze({
  red: "#ff3b3b", orange: "#ff9f1c", yellow: "#ffd60a", green: "#3ac57a",
  aqua: "#2ec4c4", blue: "#3a86ff", purple: "#9b5cff", magenta: "#ff5cc0",
});

const TOOL_HELP = Object.freeze({
  Presets: "Save your edits as a reusable look, or apply a saved one.",
  Adjust: "Exposure, contrast, highlights, shadows, color, sharpness — by hand.",
  Filters: "Your aesthetics as one-tap grades: Euro Summer, Dark Gym…",
  Curves: "Drag the tone curve — shape shadows, midtones, and highlights.",
  Levels: "Set the black point, white point, and midtone gamma.",
  HSL: "Tune each color's hue, saturation, and brightness on its own.",
  "White Balance": "Tap something that should be white or gray to neutralize the color.",
  Selective: "Brush an area, then adjust only that part of the photo.",
  Crop: "Drag the corners. Gems suggests the strongest crop.",
  Rotate: "Rotate, flip, and mirror the frame.",
  Perspective: "Straighten converging lines — fix keystone on buildings.",
  Draw: "Draw on the photo freehand — pick a color and brush size.",
  Text: "Add text, drag it into place, pick a color and size.",
  Looks: "One-tap pro restyle: commitment post, agency headshot, editorial — keeps your face.",
  "Dodge & Burn": "Brush to lighten (dodge) or darken (burn) areas by hand.",
  Clone: "Set a source spot, then brush to copy it — or heal a blemish.",
  "Blur & Sharpen": "Brush to blur or sharpen just the areas you paint.",
  "Portrait Blur": "Brush the subject to keep it sharp and blur the background.",
  Whiten: "Brush teeth or eyes to brighten and whiten them.",
  Stickers: "Tap emoji and shapes, drag them into place, then apply.",
  Retouch: "One-tap AI: remove background, enhance, restore, and more.",
  Erase: "Brush over anything to remove it — Gems fills the background.",
  Add: "Describe something to add to the photo.",
});

// Sticker/shape palette.
const STICKER_EMOJI = Object.freeze([
  "😀", "😍", "🔥", "💯", "✨", "❤️", "😎", "🎉", "👀", "💀", "🌟", "📍",
]);
const STICKER_SHAPES = Object.freeze([
  { key: "box", glyph: "▭" },
  { key: "circle", glyph: "◯" },
  { key: "arrow", glyph: "➤" },
]);

// Shared palette for the Draw and Text tools.
const PAINT_COLORS = Object.freeze([
  "#ffffff", "#170b10", "#ff3b6b", "#ff9f1c", "#ffd60a",
  "#2ec4b6", "#3a86ff", "#8338ec", "#ff70a6", "#06d6a0",
]);

// The full camera-app / Photoshop adjustment set, grouped like a real editor.
// Every key maps to gems-canvas.applyAdjust (all -100..100, 0 = neutral).
const ADJUST_GROUPS = Object.freeze([
  {
    name: "Light",
    fields: [
      { key: "exposure", label: "Exposure" },
      { key: "brightness", label: "Brightness" },
      { key: "contrast", label: "Contrast" },
      { key: "highlights", label: "Highlights" },
      { key: "shadows", label: "Shadows" },
      { key: "whites", label: "Whites" },
      { key: "blacks", label: "Blacks" },
    ],
  },
  {
    name: "Color",
    fields: [
      { key: "saturation", label: "Saturation" },
      { key: "vibrance", label: "Vibrance" },
      { key: "warmth", label: "Warmth" },
      { key: "tint", label: "Tint" },
    ],
  },
  {
    name: "Effects",
    fields: [
      { key: "sharpness", label: "Sharpness" },
      { key: "clarity", label: "Clarity" },
      { key: "dehaze", label: "Dehaze" },
      { key: "vignette", label: "Vignette" },
      { key: "grain", label: "Grain" },
    ],
  },
]);

const ADJUST_FIELDS = Object.freeze(ADJUST_GROUPS.flatMap((group) => group.fields));

// One-tap AI retouch operations. Each is a plain-language instruction sent to
// the edit-photo model (the same generative path as descriptive edits).
const RETOUCH_OPS = Object.freeze([
  { key: "remove-bg", label: "Remove background", instruction: "Remove the background completely, keeping only the main subject on a clean transparent-looking white background. Keep the subject's edges clean and natural." },
  { key: "blur-bg", label: "Blur background", instruction: "Keep the main subject perfectly sharp and apply a smooth, natural depth-of-field blur to the background only." },
  { key: "enhance", label: "Auto-enhance", instruction: "Enhance this photo: balance the exposure, recover highlight and shadow detail, improve color and white balance, and add gentle sharpness — while keeping it natural and realistic." },
  { key: "restore", label: "Restore & sharpen", instruction: "Restore this photo: reduce noise and blur, repair compression artifacts, and sharpen detail so it looks clean and high quality, without changing the content." },
  { key: "colorize", label: "Colorize", instruction: "Add realistic, natural color to this photo if it is black and white or faded, keeping skin tones and materials believable." },
  { key: "portrait", label: "Portrait cleanup", instruction: "Gently retouch the person: even out skin and reduce blemishes and under-eye shadows naturally, keep skin texture, and do not change their identity or features." },
  { key: "declutter", label: "Remove distractions", instruction: "Remove small distracting objects and clutter from the background, reconstructing what is naturally behind them, while keeping the main subject untouched." },
  { key: "brighten-face", label: "Brighten subject", instruction: "Brighten and add flattering light to the main subject so they stand out from the background, keeping it natural." },
]);

const SUGGESTIONS = Object.freeze([
  "✨ Edit this for me",
  "Make it darker",
  "Make it brighter",
  "More contrast",
  "Warmer",
  "Black and white",
  "Remove the ship in the background",
]);

// "Edit this for me" — the auto-aesthetic grade: the server looks at the photo,
// matches it to the nearest founder aesthetic, and applies that light + grade.
// Routed to edit-photo with kind "auto-aesthetic" (deterministic), bypassing the
// per-instruction interpreter.
const AUTO_AESTHETIC_RE =
  /\b(edit this for me|edit it for me|match the vibe|match the look|make it (look )?(good|aesthetic|better)|fix the (lighting|colou?rs?|grade)|give it the vibe)\b/i;

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
  // Model edits show the shared staged generation lifecycle inside the
  // processing overlay; instant on-device ops keep the plain "Working on it…".
  const defaultProcessingHTML = processingOverlay.innerHTML;
  let genDriver = null;
  // Each run owns its overlay: a late finisher must not stop or replace the
  // overlay a NEWER run already put up, so teardown is keyed on the run id.
  let genRunId = 0;
  function showGenLifecycle(request) {
    genDriver?.stop();
    genRunId += 1;
    genDriver = createGenProgress({ request, packLabel: "Gems", count: 1 });
    processingOverlay.innerHTML = genDriver.html();
    genDriver.attach(processingOverlay);
    return genRunId;
  }
  function endGenLifecycle(runId) {
    if (!genDriver) return;
    if (runId != null && runId !== genRunId) return; // a newer run owns it now
    genDriver.stop();
    genDriver = null;
    processingOverlay.innerHTML = defaultProcessingHTML;
  }
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
  let overlayCleanup = null; // detaches the active erase-brush overlay + listeners
  let toolPreviewUrl = ""; // object URL of the current live tool preview (revoked on reset)
  let filterThumbUrls = []; // object URLs of the graded filter-chip thumbnails
  // The parametric edits applied this session, in order — the recipe a preset
  // saves. Only look-transferable ops (adjust/grade/curve/levels/hsl/gains),
  // never brush/position ops.
  let recipeOps = [];
  function recordOp(op, params) {
    try {
      recipeOps.push({ op, params: JSON.parse(JSON.stringify(params)) });
    } catch {
      /* ignore un-serializable params */
    }
  }
  let manualBusy = false; // guards overlapping client-side commits
  // Real-photo mode: set when the activation payload names a library photo AND
  // a session exists. Null means the simulated demo flow is in charge.
  let photo = null;
  let lastInstruction = "";
  // Edit Interpreter (v2) per-photo session memory (last ops + last target),
  // persisted to localStorage so relative follow-ups survive a draft reopen.
  let editSession = { ops: [], lastTarget: null };
  let abortController = null;
  // Bumped on every activate/deactivate so stale async work bails cleanly.
  let activationToken = 0;

  function currentVersion() {
    return versions.find((version) => version.id === activeVersionId) || versions[0];
  }

  function syncCanvas() {
    const version = currentVersion();
    canvas.classList.toggle("is-real", Boolean(photo));
    // Whole-image (contain) only while manually editing; describe view stays the
    // consistent cover frame with no black bars.
    canvas.classList.toggle("is-fitcontain", mode === "manual" && Boolean(photo));
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
    // Describe view = the consistent cover frame (no bars); Manual tools show the
    // whole image (contain) so crop/erase overlays map 1:1 to the pixels.
    canvas.classList.toggle("is-fitcontain", mode === "manual" && Boolean(photo));
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
  // Swap the photo view to a rendered blob for a true-to-result live preview,
  // revoking the previous one. resetPreview() restores the canonical version.
  function showToolPreview(blob) {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    photoView.style.filter = "";
    photoView.src = url;
    if (toolPreviewUrl) {
      try {
        URL.revokeObjectURL(toolPreviewUrl);
      } catch {
        /* ignore */
      }
    }
    toolPreviewUrl = url;
  }

  function resetPreview() {
    // Undo any live-preview mutation (adjust filter/src swap, rotate transform).
    photoView.style.filter = "";
    photoView.style.transform = "";
    if (toolPreviewUrl) {
      try {
        URL.revokeObjectURL(toolPreviewUrl);
      } catch {
        /* ignore */
      }
      toolPreviewUrl = "";
    }
    const version = currentVersion();
    if (photo && version?.url && photoView.getAttribute("src") !== version.url) {
      photoView.src = version.url;
    }
    if (cropCleanup) {
      try {
        cropCleanup();
      } catch (error) {
        console.info("Crop cleanup failed", error);
      }
      cropCleanup = null;
    }
    if (overlayCleanup) {
      try {
        overlayCleanup();
      } catch (error) {
        console.info("Erase cleanup failed", error);
      }
      overlayCleanup = null;
    }
  }

  function teardownToolPanel() {
    resetPreview();
    if (filterThumbUrls.length) {
      filterThumbUrls.forEach((u) => {
        try {
          URL.revokeObjectURL(u);
        } catch {
          /* ignore */
        }
      });
      filterThumbUrls = [];
    }
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
    // A model-made version (an AI edit or a generated scenario) arrives as a
    // signed URL with no local blob. Fetch it once so the on-device toolset —
    // crop, rotate, adjust, named looks — keeps working ON TOP of an AI edit
    // instead of dead-ending (or paying for a model call to redo a grade).
    if (!blob && version.url) {
      try {
        const res = await fetch(version.url);
        if (res.ok) {
          blob = await res.blob();
          versionBlobs.set(version.id, blob);
        }
      } catch (error) {
        console.info("version fetch failed", error);
      }
    }
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
    if (toolName === "Presets") renderPresetsTool();
    else if (toolName === "Crop") renderCropTool();
    else if (toolName === "Rotate") renderRotateTool();
    else if (toolName === "Perspective") renderPerspectiveTool();
    else if (toolName === "Adjust") renderAdjustTool();
    else if (toolName === "Filters") renderFiltersTool();
    else if (toolName === "Curves") renderCurvesTool();
    else if (toolName === "Levels") renderLevelsTool();
    else if (toolName === "HSL") renderHslTool();
    else if (toolName === "White Balance") renderWhiteBalanceTool();
    else if (toolName === "Selective") renderSelectiveTool();
    else if (toolName === "Portrait Blur") renderPortraitBlurTool();
    else if (toolName === "Whiten") renderWhitenTool();
    else if (toolName === "Draw") renderDrawTool();
    else if (toolName === "Text") renderTextTool();
    else if (toolName === "Dodge & Burn") renderDodgeBurnTool();
    else if (toolName === "Clone") renderCloneTool();
    else if (toolName === "Blur & Sharpen") renderBlurTool();
    else if (toolName === "Stickers") renderStickersTool();
    else if (toolName === "Looks") renderLooksTool();
    else if (toolName === "Retouch") renderRetouchTool();
    else if (toolName === "Erase") renderEraseTool();
    else if (toolName === "Add") renderAiTool("Add");
    else {
      toolPanel.hidden = true;
      toolPanel.innerHTML = "";
    }
  }

  // ---- Adjust ------------------------------------------------------------

  function renderAdjustTool() {
    const values = {};
    ADJUST_FIELDS.forEach((field) => {
      values[field.key] = 0;
    });
    let previewUrl = "";
    let previewTimer = 0;

    toolPanel.innerHTML = `
      <div class="editor-adjust">
        ${ADJUST_GROUPS.map(
          (group) => `
            <div class="editor-adjust-group">
              <span class="editor-adjust-group-name">${esc(group.name)}</span>
              ${group.fields
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
            </div>
          `,
        ).join("")}
        <div class="editor-manual-actions">
          <button type="button" class="editor-manual-reset" data-adjust-reset>Reset</button>
          <button type="button" class="editor-manual-apply" data-adjust-apply>Apply</button>
        </div>
      </div>
    `;

    const clearPreviewUrl = () => {
      if (previewUrl) {
        try {
          URL.revokeObjectURL(previewUrl);
        } catch {
          /* ignore */
        }
        previewUrl = "";
      }
    };

    // Cheap, instant preview via the compositor filter for the values CSS can
    // express (light/contrast/saturation/warmth); the full render below then
    // layers in highlights/shadows/vibrance/sharpen/vignette/grain.
    const cheapPreview = () => {
      photoView.style.filter = cssFilterFor(values);
    };

    // Debounced true-to-result preview: render the complete pipeline to a blob
    // and show it, so every slider — not just the CSS-expressible ones — is
    // visible before Apply.
    const fullPreview = () => {
      window.clearTimeout(previewTimer);
      previewTimer = window.setTimeout(async () => {
        const bitmap = await activeBitmap();
        if (!bitmap || tool !== "Adjust") return;
        const blob = applyAdjust(bitmap, values);
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        photoView.style.filter = "";
        photoView.src = url;
        clearPreviewUrl();
        previewUrl = url;
      }, 140);
    };

    toolPanel.querySelectorAll("[data-adjust]").forEach((input) => {
      input.addEventListener("input", () => {
        const key = input.dataset.adjust;
        values[key] = Number(input.value) || 0;
        const out = toolPanel.querySelector(`[data-adjust-out="${key}"]`);
        if (out) out.textContent = String(values[key]);
        cheapPreview();
      });
      input.addEventListener("change", fullPreview);
    });

    toolPanel.querySelector("[data-adjust-reset]")?.addEventListener("click", () => {
      ADJUST_FIELDS.forEach((field) => {
        values[field.key] = 0;
        const input = toolPanel.querySelector(`[data-adjust="${field.key}"]`);
        const out = toolPanel.querySelector(`[data-adjust-out="${field.key}"]`);
        if (input) input.value = "0";
        if (out) out.textContent = "0";
      });
      window.clearTimeout(previewTimer);
      clearPreviewUrl();
      resetPreview();
    });

    toolPanel.querySelector("[data-adjust-apply]")?.addEventListener("click", async () => {
      if (manualBusy) return;
      const noChange = ADJUST_FIELDS.every((field) => values[field.key] === 0);
      if (noChange) {
        status.textContent = "Move a slider first, then Apply.";
        return;
      }
      window.clearTimeout(previewTimer);
      manualBusy = true;
      status.textContent = "Applying adjustments…";
      const bitmap = await activeBitmap();
      const blob = bitmap ? applyAdjust(bitmap, values) : null;
      clearPreviewUrl();
      manualBusy = false;
      if (blob) recordOp("adjust", values);
      commitManualVersion("Adjust", blob, "Adjust");
    });
  }

  // ---- Rotate / Flip -----------------------------------------------------

  function renderRotateTool() {
    // Rotation/flip accumulate so repeated taps compose, then Apply commits.
    const geo = { rotate: 0, flipH: false, flipV: false };
    toolPanel.innerHTML = `
      <div class="editor-rotate">
        <div class="editor-rotate-row">
          <button type="button" class="editor-rotate-btn" data-geo="rot-left">⟲ Left</button>
          <button type="button" class="editor-rotate-btn" data-geo="rot-right">⟳ Right</button>
          <button type="button" class="editor-rotate-btn" data-geo="flip-h">⇋ Flip</button>
          <button type="button" class="editor-rotate-btn" data-geo="flip-v">⇅ Mirror</button>
        </div>
        <div class="editor-manual-actions">
          <button type="button" class="editor-manual-reset" data-geo-reset>Reset</button>
          <button type="button" class="editor-manual-apply" data-geo-apply disabled>Apply</button>
        </div>
      </div>
    `;
    const applyBtn = toolPanel.querySelector("[data-geo-apply]");
    const touched = () => {
      if (applyBtn) applyBtn.disabled = geo.rotate === 0 && !geo.flipH && !geo.flipV;
    };
    // Live CSS preview of the pending transform (no re-encode until Apply).
    const preview = () => {
      const sx = geo.flipH ? -1 : 1;
      const sy = geo.flipV ? -1 : 1;
      photoView.style.transform = `rotate(${geo.rotate}deg) scale(${sx}, ${sy})`;
    };
    toolPanel.querySelectorAll("[data-geo]").forEach((button) => {
      button.addEventListener("click", () => {
        const op = button.dataset.geo;
        if (op === "rot-left") geo.rotate -= 90;
        else if (op === "rot-right") geo.rotate += 90;
        else if (op === "flip-h") geo.flipH = !geo.flipH;
        else if (op === "flip-v") geo.flipV = !geo.flipV;
        preview();
        touched();
      });
    });
    toolPanel.querySelector("[data-geo-reset]")?.addEventListener("click", () => {
      geo.rotate = 0;
      geo.flipH = false;
      geo.flipV = false;
      photoView.style.transform = "";
      touched();
    });
    applyBtn?.addEventListener("click", async () => {
      if (manualBusy) return;
      manualBusy = true;
      status.textContent = "Applying…";
      const bitmap = await activeBitmap();
      const blob = bitmap ? applyGeometry(bitmap, geo) : null;
      photoView.style.transform = "";
      manualBusy = false;
      commitManualVersion("Rotate", blob, "Rotate");
    });
  }

  // ---- Perspective / Keystone --------------------------------------------

  function renderPerspectiveTool() {
    const state = { vertical: 0, horizontal: 0 };
    let timer = 0;
    toolPanel.innerHTML = `
      <div class="editor-adjust">
        <label class="editor-slider">
          <span class="editor-slider-label">Vertical</span>
          <input type="range" min="-100" max="100" value="0" step="1" data-persp="vertical" aria-label="Vertical keystone" />
          <output data-persp-out="vertical">0</output>
        </label>
        <label class="editor-slider">
          <span class="editor-slider-label">Horizontal</span>
          <input type="range" min="-100" max="100" value="0" step="1" data-persp="horizontal" aria-label="Horizontal keystone" />
          <output data-persp-out="horizontal">0</output>
        </label>
        <div class="editor-manual-actions">
          <button type="button" class="editor-manual-reset" data-persp-reset>Reset</button>
          <button type="button" class="editor-manual-apply" data-persp-apply>Apply</button>
        </div>
      </div>
    `;
    const preview = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        const bitmap = await activeBitmap();
        if (!bitmap || tool !== "Perspective") return;
        showToolPreview(applyPerspective(bitmap, state));
      }, 140);
    };
    toolPanel.querySelectorAll("[data-persp]").forEach((input) => {
      input.addEventListener("input", () => {
        const k = input.dataset.persp;
        state[k] = Number(input.value) || 0;
        const out = toolPanel.querySelector(`[data-persp-out="${k}"]`);
        if (out) out.textContent = String(state[k]);
      });
      input.addEventListener("change", preview);
    });
    toolPanel.querySelector("[data-persp-reset]")?.addEventListener("click", () => {
      state.vertical = 0;
      state.horizontal = 0;
      toolPanel.querySelectorAll("[data-persp]").forEach((i) => {
        i.value = "0";
      });
      toolPanel.querySelectorAll("[data-persp-out]").forEach((o) => {
        o.textContent = "0";
      });
      window.clearTimeout(timer);
      resetPreview();
    });
    toolPanel.querySelector("[data-persp-apply]")?.addEventListener("click", async () => {
      if (manualBusy) return;
      if (!state.vertical && !state.horizontal) {
        status.textContent = "Move a slider first, then Apply.";
        return;
      }
      window.clearTimeout(timer);
      manualBusy = true;
      status.textContent = "Applying perspective…";
      const bitmap = await activeBitmap();
      const blob = bitmap ? applyPerspective(bitmap, state) : null;
      manualBusy = false;
      commitManualVersion("Perspective", blob, "Perspective");
    });
  }

  // ---- Looks (one-tap transformative AI restyle) -------------------------

  function renderLooksTool() {
    toolPanel.innerHTML = `
      <div class="editor-retouch">
        <div class="editor-retouch-grid">
          ${LOOK_OPS.map(
            (op) => `
              <button type="button" class="editor-retouch-op" data-look="${esc(op.key)}">
                ${esc(op.label)}
              </button>`,
          ).join("")}
        </div>
        <p class="editor-ai-note">Reimagines your photo as a pro shot — same face, elevated. Needs an online edit.</p>
      </div>
    `;
    toolPanel.querySelectorAll("[data-look]").forEach((button) => {
      button.addEventListener("click", () => {
        if (processing) return;
        const op = LOOK_OPS.find((entry) => entry.key === button.dataset.look);
        if (!op) return;
        void requestRealEdit(op.instruction, `look:${op.key}`);
      });
    });
  }

  // ---- Retouch (one-tap AI operations) -----------------------------------

  function renderRetouchTool() {
    toolPanel.innerHTML = `
      <div class="editor-retouch">
        <div class="editor-retouch-grid">
          ${RETOUCH_OPS.map(
            (op) => `
              <button type="button" class="editor-retouch-op" data-retouch="${esc(op.key)}">
                ${esc(op.label)}
              </button>
            `,
          ).join("")}
        </div>
        <p class="editor-ai-note">One-tap AI edits. Each creates a new version — this needs an online edit.</p>
      </div>
    `;
    toolPanel.querySelectorAll("[data-retouch]").forEach((button) => {
      button.addEventListener("click", () => {
        if (processing) return;
        const op = RETOUCH_OPS.find((entry) => entry.key === button.dataset.retouch);
        if (!op) return;
        // Remove background runs the on-device matting model first — instant,
        // free, private, and cleaner edges than a generative round-trip. Falls
        // back to the model only if segmentation isn't available.
        if (op.key === "remove-bg") {
          void removeBackgroundOnDevice(op.instruction);
          return;
        }
        void requestRealEdit(op.instruction, op.key);
      });
    });
  }

  // On-device background removal: segment the person and composite them onto a
  // clean white background. Commits a new version with no model call. Falls back
  // to the generative path if the segmenter can't run.
  async function removeBackgroundOnDevice(fallbackInstruction) {
    if (manualBusy || processing) return;
    manualBusy = true;
    status.textContent = "Removing background…";
    try {
      const bitmap = await activeBitmap();
      if (!bitmap) {
        manualBusy = false;
        return;
      }
      const mask = await segmentPerson(bitmap);
      if (!mask) {
        // No on-device matting available — fall back to the model.
        manualBusy = false;
        void requestRealEdit(fallbackInstruction, "remove-bg");
        return;
      }
      const w = bitmap.width || bitmap.naturalWidth;
      const h = bitmap.height || bitmap.naturalHeight;
      const out = document.createElement("canvas");
      out.width = w;
      out.height = h;
      const octx = out.getContext("2d");
      if (!octx) {
        manualBusy = false;
        return;
      }
      // White backdrop, then the subject masked in on top.
      octx.fillStyle = "#ffffff";
      octx.fillRect(0, 0, w, h);
      const cut = document.createElement("canvas");
      cut.width = w;
      cut.height = h;
      const cctx = cut.getContext("2d");
      if (!cctx) {
        manualBusy = false;
        return;
      }
      cctx.drawImage(bitmap, 0, 0, w, h);
      cctx.globalCompositeOperation = "destination-in";
      cctx.drawImage(mask, 0, 0, w, h);
      octx.drawImage(cut, 0, 0);
      const blob = dataURLToBlob(out.toDataURL("image/jpeg", 0.92));
      manualBusy = false;
      commitManualVersion("Background removed", blob, "Remove background");
    } catch (error) {
      console.info("on-device remove-bg failed, using model", error);
      manualBusy = false;
      void requestRealEdit(fallbackInstruction, "remove-bg");
    }
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
            ><span class="editor-filter-thumb" data-grade-thumb></span><span class="editor-filter-name">${esc(grade.label)}</span></button>
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
      chip.addEventListener("click", async () => {
        const grade = FILTER_GRADES.find((entry) => entry.key === chip.dataset.grade);
        if (!grade) return;
        markSelected(grade.key);
        // Cheap instant preview, then a true full-render (so HSL/tint show too).
        photoView.style.filter = cssFilterFor(grade.adjust);
        const bitmap = await activeBitmap();
        if (bitmap && tool === "Filters" && selected === grade.key) {
          showToolPreview(applyGrade(bitmap, grade));
        }
      });
    });
    toolPanel.querySelector("[data-filter-clear]")?.addEventListener("click", () => {
      markSelected(null);
      resetPreview();
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
      if (blob) recordOp("grade", { key: grade.key });
      commitManualVersion(grade.label, blob, "Filters");
    });

    // "Make it look like…" — the only entry point into gems-style. Loaded
    // lazily so a missing sibling module can never break the editor at import.
    toolPanel.querySelector("[data-style-open]")?.addEventListener("click", () => {
      void openStylePicker(toolPanel.querySelector("[data-style-picker]"));
    });

    // Render each grade onto a tiny copy of the current photo so the chips read
    // like a filter strip (each shows the actual result on THIS image).
    async function paintFilterThumbs() {
      const bitmap = await activeBitmap();
      if (!bitmap || tool !== "Filters") return;
      const bw = bitmap.width || bitmap.naturalWidth || 1;
      const bh = bitmap.height || bitmap.naturalHeight || 1;
      const tw = 132;
      const th = Math.max(1, Math.round((tw * bh) / bw));
      const thumb = document.createElement("canvas");
      thumb.width = tw;
      thumb.height = th;
      thumb.getContext("2d")?.drawImage(bitmap, 0, 0, tw, th);
      for (const grade of FILTER_GRADES) {
        if (tool !== "Filters") return; // user switched tools mid-render
        const blob = applyGrade(thumb, grade);
        if (!blob) continue;
        const url = URL.createObjectURL(blob);
        filterThumbUrls.push(url);
        const el = toolPanel.querySelector(`[data-grade="${grade.key}"] [data-grade-thumb]`);
        if (el) el.style.backgroundImage = `url(${url})`;
        await new Promise((r) => window.setTimeout(r, 0)); // yield so the UI stays smooth
      }
    }
    void paintFilterThumbs();
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

  // ---- Erase (manual brush → mask → AI inpaint) --------------------------

  function renderEraseTool() {
    toolPanel.innerHTML = `
      <div class="editor-erase">
        <p class="editor-erase-hint">Brush over anything you want gone — Gems fills in what's behind it.</p>
        <label class="editor-slider editor-erase-size">
          <span class="editor-slider-label">Brush</span>
          <input type="range" min="8" max="80" value="34" step="1" data-brush-size aria-label="Brush size" />
        </label>
        <div class="editor-manual-actions">
          <button type="button" class="editor-manual-reset" data-erase-clear>Clear</button>
          <button type="button" class="editor-manual-apply" data-erase-apply disabled>Erase</button>
        </div>
        <form class="editor-ai-form editor-erase-describe" data-ai-form>
          <input type="text" autocomplete="off" enterkeyhint="send"
            placeholder="…or describe what to remove" data-ai-input />
          <button type="submit" class="editor-manual-apply" data-ai-apply disabled>Remove</button>
        </form>
      </div>
    `;
    // Descriptive fallback: type what to remove.
    const input = toolPanel.querySelector("[data-ai-input]");
    const aiApply = toolPanel.querySelector("[data-ai-apply]");
    input?.addEventListener("input", () => {
      if (aiApply) aiApply.disabled = input.value.trim().length === 0;
    });
    toolPanel.querySelector("[data-ai-form]")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = (input?.value || "").trim();
      if (!text || processing) return;
      input.value = "";
      if (aiApply) aiApply.disabled = true;
      void requestRealEdit(
        `Erase the ${text}, reconstructing what's naturally behind it.`,
        "erase",
      );
    });

    // The brush: paint a mask over the image, then inpaint the marked region.
    void setupEraseOverlay(Number(toolPanel.querySelector("[data-brush-size]")?.value) || 34);
    toolPanel.querySelector("[data-brush-size]")?.addEventListener("input", (event) => {
      eraseState.brush = Number(event.target.value) || 34;
    });
    toolPanel.querySelector("[data-erase-clear]")?.addEventListener("click", () => {
      clearEraseStrokes();
    });
    toolPanel.querySelector("[data-erase-apply]")?.addEventListener("click", () => {
      void applyEraseBrush();
    });
  }

  // Erase-brush state: two canvases at the source's natural resolution — a
  // visible tinted overlay for the user, and a black/white mask for the model.
  const eraseState = {
    overlay: null,
    display: null, // visible canvas (tinted strokes)
    mask: null, // export canvas (white strokes on black)
    natW: 0,
    natH: 0,
    brush: 34, // brush diameter in display px
    painted: false,
    scale: 1, // natural px per display px
  };

  async function setupEraseOverlay(initialBrush) {
    const bitmap = await activeBitmap();
    if (!bitmap || tool !== "Erase" || mode !== "manual") return;
    eraseState.natW = bitmap.width || bitmap.naturalWidth || 0;
    eraseState.natH = bitmap.height || bitmap.naturalHeight || 0;
    eraseState.brush = initialBrush;
    eraseState.painted = false;

    const box = canvas.getBoundingClientRect();
    const fit = containRect(box.width, box.height, eraseState.natW, eraseState.natH);
    eraseState.scale = eraseState.natW / fit.width;

    const overlay = document.createElement("div");
    overlay.className = "editor-erase-overlay";
    overlay.style.left = `${fit.left}px`;
    overlay.style.top = `${fit.top}px`;
    overlay.style.width = `${fit.width}px`;
    overlay.style.height = `${fit.height}px`;

    const display = document.createElement("canvas");
    display.width = eraseState.natW;
    display.height = eraseState.natH;
    display.className = "editor-erase-canvas";
    overlay.appendChild(display);
    canvas.appendChild(overlay);

    const mask = makeMaskCanvas(eraseState.natW, eraseState.natH);

    eraseState.overlay = overlay;
    eraseState.display = display;
    eraseState.mask = mask;

    const cleanup = attachErasePointer(overlay, display);
    overlayCleanup = () => {
      cleanup();
      overlay.remove();
      eraseState.overlay = null;
      eraseState.display = null;
      eraseState.mask = null;
    };
  }

  function makeMaskCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, w, h);
    }
    return c;
  }

  function clearEraseStrokes() {
    if (eraseState.display) {
      eraseState.display.getContext("2d")?.clearRect(0, 0, eraseState.natW, eraseState.natH);
    }
    if (eraseState.mask) {
      const ctx = eraseState.mask.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, eraseState.natW, eraseState.natH);
      }
    }
    eraseState.painted = false;
    const applyBtn = toolPanel.querySelector("[data-erase-apply]");
    if (applyBtn) applyBtn.disabled = true;
  }

  function attachErasePointer(overlay, display) {
    const dctx = display.getContext("2d");
    const mctx = eraseState.mask?.getContext("2d");
    let drawing = false;
    let last = null;

    const toNatural = (event) => {
      const rect = overlay.getBoundingClientRect();
      const x = (event.clientX - rect.left) * eraseState.scale;
      const y = (event.clientY - rect.top) * eraseState.scale;
      return { x, y };
    };
    const dab = (p) => {
      const radius = (eraseState.brush * eraseState.scale) / 2;
      if (dctx) {
        dctx.fillStyle = "rgba(39,74,134,0.5)";
        dctx.beginPath();
        dctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        dctx.fill();
      }
      if (mctx) {
        mctx.fillStyle = "#fff";
        mctx.beginPath();
        mctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        mctx.fill();
      }
    };
    const stroke = (a, b) => {
      // Connect dabs so fast drags stay continuous.
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const step = Math.max(1, (eraseState.brush * eraseState.scale) / 4);
      const n = Math.ceil(dist / step);
      for (let i = 1; i <= n; i += 1) {
        dab({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n });
      }
    };

    const onDown = (event) => {
      drawing = true;
      last = toNatural(event);
      dab(last);
      eraseState.painted = true;
      const applyBtn = toolPanel.querySelector("[data-erase-apply]");
      if (applyBtn) applyBtn.disabled = false;
      try {
        overlay.setPointerCapture?.(event.pointerId);
      } catch {
        /* ignore */
      }
      event.preventDefault();
    };
    const onMove = (event) => {
      if (!drawing) return;
      const p = toNatural(event);
      if (last) stroke(last, p);
      last = p;
      event.preventDefault();
    };
    const onUp = () => {
      drawing = false;
      last = null;
    };

    overlay.addEventListener("pointerdown", onDown);
    overlay.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      overlay.removeEventListener("pointerdown", onDown);
      overlay.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }

  async function applyEraseBrush() {
    if (processing || !eraseState.mask) return;
    if (!eraseState.painted) {
      status.textContent = "Brush over something first, then Erase.";
      return;
    }
    let maskBase64 = "";
    try {
      const dataUrl = eraseState.mask.toDataURL("image/png");
      maskBase64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    } catch (error) {
      console.info("Mask export failed", error);
      status.textContent = "That erase couldn't be sent — try again.";
      return;
    }
    void requestRealEdit(
      "Remove the object(s) covered by the white mask region and realistically reconstruct what is naturally behind them.",
      "erase-brush",
      maskBase64,
    );
  }

  // ---- Draw / Text: shared image-overlay plumbing ------------------------

  // Position an overlay div exactly over the letterboxed photo inside the
  // canvas, and return its geometry. Callers append their own surface + wire
  // pointer handling, and set overlayCleanup to remove it.
  function buildImageOverlay(bitmap, className) {
    const natW = bitmap.width || bitmap.naturalWidth || 0;
    const natH = bitmap.height || bitmap.naturalHeight || 0;
    const box = canvas.getBoundingClientRect();
    const fit = containRect(box.width, box.height, natW, natH);
    const overlay = document.createElement("div");
    overlay.className = className;
    overlay.style.left = `${fit.left}px`;
    overlay.style.top = `${fit.top}px`;
    overlay.style.width = `${fit.width}px`;
    overlay.style.height = `${fit.height}px`;
    canvas.appendChild(overlay);
    return { overlay, natW, natH, scale: natW / fit.width };
  }

  function colorSwatchesMarkup(attr, active) {
    return PAINT_COLORS.map(
      (color) => `
        <button type="button" class="editor-swatch${color === active ? " is-active" : ""}"
          data-${attr}="${color}" aria-label="Color ${color}"
          style="--swatch:${color}"></button>`,
    ).join("");
  }

  // ---- Draw (freehand brush, on-device) ----------------------------------

  function renderDrawTool() {
    const state = { color: PAINT_COLORS[2], size: 8, painted: false, surface: null, scale: 1 };
    toolPanel.innerHTML = `
      <div class="editor-draw">
        <div class="editor-swatches" role="group" aria-label="Brush color">
          ${colorSwatchesMarkup("draw-color", state.color)}
        </div>
        <label class="editor-slider editor-draw-size">
          <span class="editor-slider-label">Brush</span>
          <input type="range" min="2" max="40" value="8" step="1" data-draw-size aria-label="Brush size" />
        </label>
        <div class="editor-manual-actions">
          <button type="button" class="editor-manual-reset" data-draw-clear>Clear</button>
          <button type="button" class="editor-manual-apply" data-draw-apply disabled>Apply</button>
        </div>
      </div>
    `;
    toolPanel.querySelectorAll("[data-draw-color]").forEach((swatch) => {
      swatch.addEventListener("click", () => {
        state.color = swatch.dataset.drawColor;
        toolPanel.querySelectorAll("[data-draw-color]").forEach((s) =>
          s.classList.toggle("is-active", s === swatch),
        );
      });
    });
    toolPanel.querySelector("[data-draw-size]")?.addEventListener("input", (event) => {
      state.size = Number(event.target.value) || 8;
    });
    toolPanel.querySelector("[data-draw-clear]")?.addEventListener("click", () => {
      state.surface?.getContext("2d")?.clearRect(0, 0, state.surface.width, state.surface.height);
      state.painted = false;
      const btn = toolPanel.querySelector("[data-draw-apply]");
      if (btn) btn.disabled = true;
    });
    toolPanel.querySelector("[data-draw-apply]")?.addEventListener("click", async () => {
      if (manualBusy || !state.surface || !state.painted) {
        if (!state.painted) status.textContent = "Draw something first, then Apply.";
        return;
      }
      manualBusy = true;
      status.textContent = "Applying…";
      const bitmap = await activeBitmap();
      const blob = bitmap ? applyOverlay(bitmap, state.surface) : null;
      manualBusy = false;
      commitManualVersion("Draw", blob, "Draw");
    });

    void setupDrawSurface(state);
  }

  async function setupDrawSurface(state) {
    const bitmap = await activeBitmap();
    if (!bitmap || tool !== "Draw" || mode !== "manual") return;
    const { overlay, natW, natH, scale } = buildImageOverlay(bitmap, "editor-paint-overlay");
    const surface = document.createElement("canvas");
    surface.width = natW;
    surface.height = natH;
    surface.className = "editor-paint-canvas";
    overlay.appendChild(surface);
    state.surface = surface;
    state.scale = scale;
    const ctx = surface.getContext("2d");
    if (ctx) {
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
    }
    let drawing = false;
    let last = null;
    const at = (event) => {
      const rect = overlay.getBoundingClientRect();
      return { x: (event.clientX - rect.left) * scale, y: (event.clientY - rect.top) * scale };
    };
    const down = (event) => {
      drawing = true;
      last = at(event);
      // A dot on tap.
      if (ctx) {
        ctx.fillStyle = state.color;
        ctx.beginPath();
        ctx.arc(last.x, last.y, (state.size * scale) / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      state.painted = true;
      const btn = toolPanel.querySelector("[data-draw-apply]");
      if (btn) btn.disabled = false;
      try {
        overlay.setPointerCapture?.(event.pointerId);
      } catch {
        /* ignore */
      }
      event.preventDefault();
    };
    const move = (event) => {
      if (!drawing || !ctx) return;
      const p = at(event);
      ctx.strokeStyle = state.color;
      ctx.lineWidth = state.size * scale;
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      last = p;
      event.preventDefault();
    };
    const up = () => {
      drawing = false;
      last = null;
    };
    overlay.addEventListener("pointerdown", down);
    overlay.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    overlayCleanup = () => {
      overlay.removeEventListener("pointerdown", down);
      overlay.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      overlay.remove();
    };
  }

  // ---- Text (add a caption, drag to place, on-device) --------------------

  function renderTextTool() {
    const state = { color: "#ffffff", size: 42, text: "", el: null, overlay: null, scale: 1, pos: { x: 0.5, y: 0.5 } };
    toolPanel.innerHTML = `
      <div class="editor-text">
        <input type="text" class="editor-text-input" data-text-input maxlength="80"
          autocomplete="off" enterkeyhint="done" placeholder="Type your text…" />
        <div class="editor-swatches" role="group" aria-label="Text color">
          ${colorSwatchesMarkup("text-color", state.color)}
        </div>
        <label class="editor-slider editor-text-size">
          <span class="editor-slider-label">Size</span>
          <input type="range" min="18" max="120" value="42" step="1" data-text-size aria-label="Text size" />
        </label>
        <div class="editor-manual-actions">
          <button type="button" class="editor-manual-reset" data-text-clear>Clear</button>
          <button type="button" class="editor-manual-apply" data-text-apply disabled>Apply</button>
        </div>
      </div>
    `;
    const input = toolPanel.querySelector("[data-text-input]");
    const applyBtn = toolPanel.querySelector("[data-text-apply]");
    const sync = () => {
      state.text = input.value;
      if (state.el) state.el.textContent = state.text || "Type your text…";
      if (applyBtn) applyBtn.disabled = state.text.trim().length === 0;
    };
    input?.addEventListener("input", sync);
    toolPanel.querySelectorAll("[data-text-color]").forEach((swatch) => {
      swatch.addEventListener("click", () => {
        state.color = swatch.dataset.textColor;
        if (state.el) state.el.style.color = state.color;
        toolPanel.querySelectorAll("[data-text-color]").forEach((s) =>
          s.classList.toggle("is-active", s === swatch),
        );
      });
    });
    toolPanel.querySelector("[data-text-size]")?.addEventListener("input", (event) => {
      state.size = Number(event.target.value) || 42;
      if (state.el) state.el.style.fontSize = `${state.size / state.scale}px`;
    });
    toolPanel.querySelector("[data-text-clear]")?.addEventListener("click", () => {
      input.value = "";
      sync();
    });
    applyBtn?.addEventListener("click", async () => {
      if (manualBusy || !state.text.trim()) return;
      manualBusy = true;
      status.textContent = "Applying…";
      const bitmap = await activeBitmap();
      const blob = bitmap ? renderTextToImage(bitmap, state) : null;
      manualBusy = false;
      commitManualVersion("Text", blob, "Text");
    });

    void setupTextOverlay(state, sync);
  }

  async function setupTextOverlay(state, sync) {
    const bitmap = await activeBitmap();
    if (!bitmap || tool !== "Text" || mode !== "manual") return;
    const { overlay, natW, natH, scale } = buildImageOverlay(bitmap, "editor-text-overlay");
    state.overlay = overlay;
    state.scale = scale;
    state.natW = natW;
    state.natH = natH;
    const el = document.createElement("div");
    el.className = "editor-text-draggable";
    el.textContent = "Type your text…";
    el.style.color = state.color;
    el.style.fontSize = `${state.size / scale}px`;
    el.style.left = "50%";
    el.style.top = "50%";
    overlay.appendChild(el);
    state.el = el;

    let dragging = false;
    let start = null;
    const down = (event) => {
      dragging = true;
      const rect = overlay.getBoundingClientRect();
      start = { x: event.clientX, y: event.clientY, px: state.pos.x * rect.width, py: state.pos.y * rect.height, w: rect.width, h: rect.height };
      try {
        el.setPointerCapture?.(event.pointerId);
      } catch {
        /* ignore */
      }
      event.preventDefault();
    };
    const move = (event) => {
      if (!dragging || !start) return;
      const nx = Math.max(0, Math.min(1, (start.px + (event.clientX - start.x)) / start.w));
      const ny = Math.max(0, Math.min(1, (start.py + (event.clientY - start.y)) / start.h));
      state.pos = { x: nx, y: ny };
      el.style.left = `${nx * 100}%`;
      el.style.top = `${ny * 100}%`;
      event.preventDefault();
    };
    const up = () => {
      dragging = false;
      start = null;
    };
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    overlayCleanup = () => {
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      overlay.remove();
    };
  }

  // Rasterize the text overlay onto a natural-res canvas, positioned to match
  // what the user placed, and composite it over the photo.
  function renderTextToImage(bitmap, state) {
    try {
      const natW = state.natW || bitmap.width || bitmap.naturalWidth || 0;
      const natH = state.natH || bitmap.height || bitmap.naturalHeight || 0;
      const surface = document.createElement("canvas");
      surface.width = natW;
      surface.height = natH;
      const ctx = surface.getContext("2d");
      if (!ctx) return null;
      const fontPx = state.size;
      ctx.font = `700 ${fontPx}px "Instrument Sans", -apple-system, sans-serif`;
      ctx.fillStyle = state.color;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      // A soft shadow so light text stays legible on light photos.
      ctx.shadowColor = "rgba(0,0,0,0.35)";
      ctx.shadowBlur = Math.max(2, fontPx * 0.08);
      ctx.fillText(state.text, state.pos.x * natW, state.pos.y * natH);
      return applyOverlay(bitmap, surface);
    } catch (error) {
      console.info("renderTextToImage failed", error);
      return null;
    }
  }

  // ---- Levels ------------------------------------------------------------

  function renderLevelsTool() {
    const state = { black: 0, white: 255, gamma: 1 };
    let timer = 0;
    toolPanel.innerHTML = `
      <div class="editor-adjust">
        <label class="editor-slider">
          <span class="editor-slider-label">Black</span>
          <input type="range" min="0" max="254" value="0" step="1" data-lv="black" aria-label="Black point" />
          <output data-lv-out="black">0</output>
        </label>
        <label class="editor-slider">
          <span class="editor-slider-label">White</span>
          <input type="range" min="1" max="255" value="255" step="1" data-lv="white" aria-label="White point" />
          <output data-lv-out="white">255</output>
        </label>
        <label class="editor-slider">
          <span class="editor-slider-label">Gamma</span>
          <input type="range" min="30" max="300" value="100" step="1" data-lv="gamma" aria-label="Gamma" />
          <output data-lv-out="gamma">1.00</output>
        </label>
        <div class="editor-manual-actions">
          <button type="button" class="editor-manual-reset" data-lv-reset>Reset</button>
          <button type="button" class="editor-manual-apply" data-lv-apply>Apply</button>
        </div>
      </div>
    `;
    const preview = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        const bitmap = await activeBitmap();
        if (!bitmap || tool !== "Levels") return;
        showToolPreview(applyLevels(bitmap, state));
      }, 130);
    };
    toolPanel.querySelectorAll("[data-lv]").forEach((input) => {
      input.addEventListener("input", () => {
        const key = input.dataset.lv;
        const raw = Number(input.value);
        state[key] = key === "gamma" ? raw / 100 : raw;
        const out = toolPanel.querySelector(`[data-lv-out="${key}"]`);
        if (out) out.textContent = key === "gamma" ? state[key].toFixed(2) : String(state[key]);
      });
      input.addEventListener("change", preview);
    });
    toolPanel.querySelector("[data-lv-reset]")?.addEventListener("click", () => {
      state.black = 0;
      state.white = 255;
      state.gamma = 1;
      toolPanel.querySelector('[data-lv="black"]').value = "0";
      toolPanel.querySelector('[data-lv="white"]').value = "255";
      toolPanel.querySelector('[data-lv="gamma"]').value = "100";
      toolPanel.querySelector('[data-lv-out="black"]').textContent = "0";
      toolPanel.querySelector('[data-lv-out="white"]').textContent = "255";
      toolPanel.querySelector('[data-lv-out="gamma"]').textContent = "1.00";
      window.clearTimeout(timer);
      resetPreview();
    });
    toolPanel.querySelector("[data-lv-apply]")?.addEventListener("click", async () => {
      if (manualBusy) return;
      if (state.black === 0 && state.white === 255 && state.gamma === 1) {
        status.textContent = "Move a slider first, then Apply.";
        return;
      }
      window.clearTimeout(timer);
      manualBusy = true;
      status.textContent = "Applying levels…";
      const bitmap = await activeBitmap();
      const blob = bitmap ? applyLevels(bitmap, state) : null;
      manualBusy = false;
      if (blob) recordOp("levels", { black: state.black, white: state.white, gamma: state.gamma });
      commitManualVersion("Levels", blob, "Levels");
    });
  }

  // ---- HSL / Color Mix ---------------------------------------------------

  function renderHslTool() {
    const bands = {};
    HSL_BANDS.forEach((b) => {
      bands[b.key] = { h: 0, s: 0, l: 0 };
    });
    let selected = HSL_BANDS[0].key;
    let timer = 0;
    const channels = [
      { key: "h", label: "Hue" },
      { key: "s", label: "Saturation" },
      { key: "l", label: "Luminance" },
    ];
    toolPanel.innerHTML = `
      <div class="editor-adjust">
        <div class="editor-swatches editor-hsl-bands" role="group" aria-label="Color range">
          ${HSL_BANDS.map(
            (b) => `<button type="button" class="editor-swatch${b.key === selected ? " is-active" : ""}"
              data-hsl-band="${b.key}" aria-label="${esc(b.label)}" style="--swatch:${HSL_SWATCH[b.key]}"></button>`,
          ).join("")}
        </div>
        ${channels
          .map(
            (ch) => `
              <label class="editor-slider">
                <span class="editor-slider-label">${ch.label}</span>
                <input type="range" min="-100" max="100" value="0" step="1" data-hsl="${ch.key}" aria-label="${ch.label}" />
                <output data-hsl-out="${ch.key}">0</output>
              </label>`,
          )
          .join("")}
        <div class="editor-manual-actions">
          <button type="button" class="editor-manual-reset" data-hsl-reset>Reset</button>
          <button type="button" class="editor-manual-apply" data-hsl-apply>Apply</button>
        </div>
      </div>
    `;
    const loadBand = () => {
      channels.forEach((ch) => {
        const input = toolPanel.querySelector(`[data-hsl="${ch.key}"]`);
        const out = toolPanel.querySelector(`[data-hsl-out="${ch.key}"]`);
        const v = bands[selected][ch.key];
        if (input) input.value = String(v);
        if (out) out.textContent = String(v);
      });
    };
    const preview = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        const bitmap = await activeBitmap();
        if (!bitmap || tool !== "HSL") return;
        showToolPreview(applyHsl(bitmap, bands));
      }, 150);
    };
    toolPanel.querySelectorAll("[data-hsl-band]").forEach((sw) => {
      sw.addEventListener("click", () => {
        selected = sw.dataset.hslBand;
        toolPanel.querySelectorAll("[data-hsl-band]").forEach((s) => s.classList.toggle("is-active", s === sw));
        loadBand();
      });
    });
    toolPanel.querySelectorAll("[data-hsl]").forEach((input) => {
      input.addEventListener("input", () => {
        const ch = input.dataset.hsl;
        bands[selected][ch] = Number(input.value) || 0;
        const out = toolPanel.querySelector(`[data-hsl-out="${ch}"]`);
        if (out) out.textContent = String(bands[selected][ch]);
      });
      input.addEventListener("change", preview);
    });
    toolPanel.querySelector("[data-hsl-reset]")?.addEventListener("click", () => {
      HSL_BANDS.forEach((b) => {
        bands[b.key] = { h: 0, s: 0, l: 0 };
      });
      loadBand();
      window.clearTimeout(timer);
      resetPreview();
    });
    toolPanel.querySelector("[data-hsl-apply]")?.addEventListener("click", async () => {
      if (manualBusy) return;
      const changed = HSL_BANDS.some((b) => bands[b.key].h || bands[b.key].s || bands[b.key].l);
      if (!changed) {
        status.textContent = "Pick a color and move a slider, then Apply.";
        return;
      }
      window.clearTimeout(timer);
      manualBusy = true;
      status.textContent = "Applying color mix…";
      const bitmap = await activeBitmap();
      const blob = bitmap ? applyHsl(bitmap, bands) : null;
      manualBusy = false;
      if (blob) recordOp("hsl", bands);
      commitManualVersion("Color Mix", blob, "HSL");
    });
  }

  // ---- White Balance (eyedropper) ----------------------------------------

  function renderWhiteBalanceTool() {
    const state = { gains: null, snapshot: null, scale: 1, overlayEl: null, marker: null, natW: 0, natH: 0 };
    toolPanel.innerHTML = `
      <div class="editor-draw">
        <p class="editor-erase-hint">Tap something in the photo that should be white or neutral gray — Gems removes the color cast.</p>
        <div class="editor-manual-actions">
          <button type="button" class="editor-manual-reset" data-wb-reset>Reset</button>
          <button type="button" class="editor-manual-apply" data-wb-apply disabled>Apply</button>
        </div>
      </div>
    `;
    toolPanel.querySelector("[data-wb-reset]")?.addEventListener("click", () => {
      state.gains = null;
      if (state.marker) state.marker.hidden = true;
      resetPreview();
      const btn = toolPanel.querySelector("[data-wb-apply]");
      if (btn) btn.disabled = true;
    });
    toolPanel.querySelector("[data-wb-apply]")?.addEventListener("click", async () => {
      if (manualBusy || !state.gains) {
        if (!state.gains) status.textContent = "Tap a neutral spot first, then Apply.";
        return;
      }
      manualBusy = true;
      status.textContent = "Applying white balance…";
      const bitmap = await activeBitmap();
      const blob = bitmap ? applyChannelGains(bitmap, state.gains) : null;
      manualBusy = false;
      if (blob) recordOp("gains", state.gains);
      commitManualVersion("White balance", blob, "White Balance");
    });
    void setupWhiteBalance(state);
  }

  async function setupWhiteBalance(state) {
    const bitmap = await activeBitmap();
    if (!bitmap || tool !== "White Balance" || mode !== "manual") return;
    const { overlay, natW, natH, scale } = buildImageOverlay(bitmap, "editor-paint-overlay");
    state.snapshot = makeCopyCanvas(bitmap, natW, natH);
    state.scale = scale;
    state.overlayEl = overlay;
    state.natW = natW;
    state.natH = natH;
    const marker = document.createElement("div");
    marker.className = "editor-clone-source";
    marker.hidden = true;
    overlay.appendChild(marker);
    state.marker = marker;

    const pick = (event) => {
      const rect = overlay.getBoundingClientRect();
      const x = Math.round((event.clientX - rect.left) * scale);
      const y = Math.round((event.clientY - rect.top) * scale);
      const sctx = state.snapshot.getContext("2d");
      if (!sctx) return;
      let px;
      try {
        // Average a small patch so a single noisy pixel doesn't skew it.
        const rr = 3;
        const sx = Math.max(0, Math.min(natW - 1, x - rr));
        const sy = Math.max(0, Math.min(natH - 1, y - rr));
        const d = sctx.getImageData(sx, sy, Math.min(rr * 2, natW - sx), Math.min(rr * 2, natH - sy)).data;
        let r = 0;
        let g = 0;
        let b = 0;
        const n = d.length / 4;
        for (let i = 0; i < d.length; i += 4) {
          r += d[i];
          g += d[i + 1];
          b += d[i + 2];
        }
        px = { r: r / n, g: g / n, b: b / n };
      } catch (error) {
        console.info("WB sample failed", error);
        return;
      }
      const gray = (px.r + px.g + px.b) / 3;
      const clampGain = (v) => Math.max(0.4, Math.min(2.5, v));
      state.gains = [
        clampGain(gray / (px.r || 1)),
        clampGain(gray / (px.g || 1)),
        clampGain(gray / (px.b || 1)),
      ];
      marker.hidden = false;
      marker.style.left = `${(x / natW) * 100}%`;
      marker.style.top = `${(y / natH) * 100}%`;
      showToolPreview(applyChannelGains(bitmap, state.gains));
      const btn = toolPanel.querySelector("[data-wb-apply]");
      if (btn) btn.disabled = false;
      event.preventDefault();
    };
    overlay.addEventListener("pointerdown", pick);
    overlayCleanup = () => {
      overlay.removeEventListener("pointerdown", pick);
      overlay.remove();
    };
  }

  // ---- Curves ------------------------------------------------------------

  function renderCurvesTool() {
    // Five control points along the input axis; y is draggable (output tone).
    const points = [
      [0, 0],
      [64, 64],
      [128, 128],
      [192, 192],
      [255, 255],
    ];
    let timer = 0;
    const SIZE = 240;
    toolPanel.innerHTML = `
      <div class="editor-curves">
        <canvas class="editor-curve-pad" width="${SIZE}" height="${SIZE}"
          aria-label="Tone curve — drag the points"></canvas>
        <div class="editor-manual-actions">
          <button type="button" class="editor-manual-reset" data-curve-reset>Reset</button>
          <button type="button" class="editor-manual-apply" data-curve-apply>Apply</button>
        </div>
      </div>
    `;
    const pad = toolPanel.querySelector(".editor-curve-pad");
    const ctx = pad.getContext("2d");
    const toPad = (x, y) => ({ px: (x / 255) * SIZE, py: SIZE - (y / 255) * SIZE });
    const draw = () => {
      if (!ctx) return;
      ctx.clearRect(0, 0, SIZE, SIZE);
      // grid
      ctx.strokeStyle = "rgba(120,109,112,0.25)";
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i += 1) {
        const g = (i / 4) * SIZE;
        ctx.beginPath();
        ctx.moveTo(g, 0);
        ctx.lineTo(g, SIZE);
        ctx.moveTo(0, g);
        ctx.lineTo(SIZE, g);
        ctx.stroke();
      }
      // curve (piecewise linear through the points)
      ctx.strokeStyle = "#170b10";
      ctx.lineWidth = 2;
      ctx.beginPath();
      points.forEach((pt, i) => {
        const { px, py } = toPad(pt[0], pt[1]);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
      // handles
      points.forEach((pt) => {
        const { px, py } = toPad(pt[0], pt[1]);
        ctx.fillStyle = "#274a86";
        ctx.beginPath();
        ctx.arc(px, py, 6, 0, Math.PI * 2);
        ctx.fill();
      });
    };
    const preview = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        const bitmap = await activeBitmap();
        if (!bitmap || tool !== "Curves") return;
        showToolPreview(applyCurve(bitmap, points));
      }, 130);
    };
    draw();

    let active = -1;
    const at = (event) => {
      const rect = pad.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) * 255;
      const y = 255 - ((event.clientY - rect.top) / rect.height) * 255;
      return { x: Math.max(0, Math.min(255, x)), y: Math.max(0, Math.min(255, y)) };
    };
    pad.addEventListener("pointerdown", (event) => {
      const { x } = at(event);
      // nearest point by input position
      let best = 0;
      let bestD = Infinity;
      points.forEach((pt, i) => {
        const d = Math.abs(pt[0] - x);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      active = best;
      try {
        pad.setPointerCapture?.(event.pointerId);
      } catch {
        /* ignore */
      }
    });
    pad.addEventListener("pointermove", (event) => {
      if (active < 0) return;
      const { y } = at(event);
      points[active][1] = Math.round(y); // x stays fixed; drag output tone
      draw();
      event.preventDefault();
    });
    const end = () => {
      if (active < 0) return;
      active = -1;
      preview();
    };
    pad.addEventListener("pointerup", end);
    pad.addEventListener("pointercancel", end);

    toolPanel.querySelector("[data-curve-reset]")?.addEventListener("click", () => {
      points.forEach((pt) => {
        pt[1] = pt[0];
      });
      draw();
      window.clearTimeout(timer);
      resetPreview();
    });
    toolPanel.querySelector("[data-curve-apply]")?.addEventListener("click", async () => {
      if (manualBusy) return;
      const changed = points.some((pt) => pt[1] !== pt[0]);
      if (!changed) {
        status.textContent = "Drag the curve first, then Apply.";
        return;
      }
      window.clearTimeout(timer);
      manualBusy = true;
      status.textContent = "Applying curve…";
      const bitmap = await activeBitmap();
      const blob = bitmap ? applyCurve(bitmap, points) : null;
      manualBusy = false;
      if (blob) recordOp("curve", points.map((pt) => [pt[0], pt[1]]));
      commitManualVersion("Curves", blob, "Curves");
    });
  }

  // ---- Dodge & Burn (brush lighten / darken) -----------------------------

  function renderDodgeBurnTool() {
    const state = { mode: "dodge", size: 40, painted: false, surface: null, scale: 1 };
    toolPanel.innerHTML = `
      <div class="editor-draw">
        <div class="editor-db-modes" role="group" aria-label="Dodge or burn">
          <button type="button" class="editor-db-mode is-active" data-db="dodge">☀ Dodge (lighten)</button>
          <button type="button" class="editor-db-mode" data-db="burn">◐ Burn (darken)</button>
        </div>
        <label class="editor-slider editor-draw-size">
          <span class="editor-slider-label">Brush</span>
          <input type="range" min="10" max="120" value="40" step="1" data-db-size aria-label="Brush size" />
        </label>
        <div class="editor-manual-actions">
          <button type="button" class="editor-manual-reset" data-db-clear>Clear</button>
          <button type="button" class="editor-manual-apply" data-db-apply disabled>Apply</button>
        </div>
      </div>
    `;
    toolPanel.querySelectorAll("[data-db]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.mode = btn.dataset.db;
        toolPanel.querySelectorAll("[data-db]").forEach((b) => b.classList.toggle("is-active", b === btn));
      });
    });
    toolPanel.querySelector("[data-db-size]")?.addEventListener("input", (event) => {
      state.size = Number(event.target.value) || 40;
    });
    toolPanel.querySelector("[data-db-clear]")?.addEventListener("click", () => {
      state.surface?.getContext("2d")?.clearRect(0, 0, state.surface.width, state.surface.height);
      state.painted = false;
      const btn = toolPanel.querySelector("[data-db-apply]");
      if (btn) btn.disabled = true;
    });
    toolPanel.querySelector("[data-db-apply]")?.addEventListener("click", async () => {
      if (manualBusy || !state.surface || !state.painted) {
        if (!state.painted) status.textContent = "Brush an area first, then Apply.";
        return;
      }
      manualBusy = true;
      status.textContent = "Applying…";
      const bitmap = await activeBitmap();
      // soft-light with a white layer lightens (dodge); black darkens (burn).
      const blob = bitmap ? applyOverlay(bitmap, state.surface, "soft-light") : null;
      manualBusy = false;
      commitManualVersion(state.mode === "dodge" ? "Dodge" : "Burn", blob, "Dodge & Burn");
    });
    void setupDodgeBurnSurface(state);
  }

  async function setupDodgeBurnSurface(state) {
    const bitmap = await activeBitmap();
    if (!bitmap || tool !== "Dodge & Burn" || mode !== "manual") return;
    const { overlay, natW, natH, scale } = buildImageOverlay(bitmap, "editor-paint-overlay");
    const surface = document.createElement("canvas");
    surface.width = natW;
    surface.height = natH;
    surface.className = "editor-paint-canvas";
    overlay.appendChild(surface);
    state.surface = surface;
    state.scale = scale;
    const ctx = surface.getContext("2d");
    let drawing = false;
    let last = null;
    const at = (event) => {
      const rect = overlay.getBoundingClientRect();
      return { x: (event.clientX - rect.left) * scale, y: (event.clientY - rect.top) * scale };
    };
    // Low-alpha accumulation so repeated strokes deepen the effect gradually.
    const dab = (p) => {
      if (!ctx) return;
      const r = (state.size * scale) / 2;
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      const tone = state.mode === "dodge" ? "255,255,255" : "0,0,0";
      g.addColorStop(0, `rgba(${tone},0.5)`);
      g.addColorStop(1, `rgba(${tone},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    };
    const down = (event) => {
      drawing = true;
      last = at(event);
      dab(last);
      state.painted = true;
      const btn = toolPanel.querySelector("[data-db-apply]");
      if (btn) btn.disabled = false;
      try {
        overlay.setPointerCapture?.(event.pointerId);
      } catch {
        /* ignore */
      }
      event.preventDefault();
    };
    const move = (event) => {
      if (!drawing) return;
      const p = at(event);
      const dist = Math.hypot(p.x - last.x, p.y - last.y);
      const step = Math.max(1, (state.size * scale) / 6);
      const n = Math.ceil(dist / step);
      for (let i = 1; i <= n; i += 1) {
        dab({ x: last.x + ((p.x - last.x) * i) / n, y: last.y + ((p.y - last.y) * i) / n });
      }
      last = p;
      event.preventDefault();
    };
    const up = () => {
      drawing = false;
      last = null;
    };
    overlay.addEventListener("pointerdown", down);
    overlay.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    overlayCleanup = () => {
      overlay.removeEventListener("pointerdown", down);
      overlay.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      overlay.remove();
    };
  }

  // ---- Clone / Blur / Stickers: shared work-canvas plumbing --------------

  function canvasToBlob(cnv) {
    return new Promise((resolve) => {
      try {
        if (cnv.toBlob) cnv.toBlob((b) => resolve(b), "image/jpeg", 0.92);
        else resolve(null);
      } catch (error) {
        console.info("canvasToBlob failed", error);
        resolve(null);
      }
    });
  }

  // An overlay whose canvas starts as an OPAQUE copy of the photo (the work
  // surface). Clone and Blur paint onto it directly; on Apply we encode it.
  function buildWorkOverlay(bitmap, className) {
    const { overlay, natW, natH, scale } = buildImageOverlay(bitmap, className);
    const work = document.createElement("canvas");
    work.width = natW;
    work.height = natH;
    work.className = "editor-paint-canvas";
    work.getContext("2d")?.drawImage(bitmap, 0, 0, natW, natH);
    overlay.appendChild(work);
    return { overlay, work, natW, natH, scale };
  }

  function makeCopyCanvas(bitmap, w, h) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d")?.drawImage(bitmap, 0, 0, w, h);
    return c;
  }

  // ---- Clone / Heal (copy from a source spot, on-device) -----------------

  function renderCloneTool() {
    const state = {
      mode: "clone", size: 44, source: null, offset: null, painted: false,
      work: null, wctx: null, snapshot: null, scale: 1, overlayEl: null, marker: null, natW: 0, natH: 0,
    };
    toolPanel.innerHTML = `
      <div class="editor-draw">
        <div class="editor-db-modes" role="group" aria-label="Clone or heal">
          <button type="button" class="editor-db-mode is-active" data-cl="clone">⎘ Clone</button>
          <button type="button" class="editor-db-mode" data-cl="heal">✦ Heal</button>
        </div>
        <p class="editor-erase-hint" data-cl-hint>Tap the photo to set a source spot, then brush where you want it copied.</p>
        <label class="editor-slider editor-draw-size">
          <span class="editor-slider-label">Brush</span>
          <input type="range" min="12" max="120" value="44" step="1" data-cl-size aria-label="Brush size" />
        </label>
        <div class="editor-manual-actions">
          <button type="button" class="editor-manual-reset" data-cl-source>New source</button>
          <button type="button" class="editor-manual-apply" data-cl-apply disabled>Apply</button>
        </div>
      </div>
    `;
    toolPanel.querySelectorAll("[data-cl]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.mode = btn.dataset.cl;
        toolPanel.querySelectorAll("[data-cl]").forEach((b) => b.classList.toggle("is-active", b === btn));
      });
    });
    toolPanel.querySelector("[data-cl-size]")?.addEventListener("input", (e) => {
      state.size = Number(e.target.value) || 44;
    });
    toolPanel.querySelector("[data-cl-source]")?.addEventListener("click", () => {
      state.source = null;
      state.offset = null;
      if (state.marker) state.marker.hidden = true;
      const hint = toolPanel.querySelector("[data-cl-hint]");
      if (hint) hint.textContent = "Tap the photo to set a new source spot.";
    });
    toolPanel.querySelector("[data-cl-apply]")?.addEventListener("click", async () => {
      if (manualBusy || !state.work || !state.painted) {
        if (!state.painted) status.textContent = "Set a source and brush first, then Apply.";
        return;
      }
      manualBusy = true;
      status.textContent = "Applying…";
      const blob = await canvasToBlob(state.work);
      manualBusy = false;
      commitManualVersion(state.mode === "heal" ? "Heal" : "Clone", blob, "Clone");
    });
    void setupCloneSurface(state);
  }

  async function setupCloneSurface(state) {
    const bitmap = await activeBitmap();
    if (!bitmap || tool !== "Clone" || mode !== "manual") return;
    const { overlay, work, natW, natH, scale } = buildWorkOverlay(bitmap, "editor-paint-overlay");
    state.work = work;
    state.wctx = work.getContext("2d");
    state.snapshot = makeCopyCanvas(bitmap, natW, natH);
    state.scale = scale;
    state.overlayEl = overlay;
    state.natW = natW;
    state.natH = natH;
    const marker = document.createElement("div");
    marker.className = "editor-clone-source";
    marker.hidden = true;
    overlay.appendChild(marker);
    state.marker = marker;

    const at = (event) => {
      const rect = overlay.getBoundingClientRect();
      return { x: (event.clientX - rect.left) * scale, y: (event.clientY - rect.top) * scale };
    };
    const showMarker = (p) => {
      if (!state.marker) return;
      state.marker.hidden = false;
      state.marker.style.left = `${(p.x / natW) * 100}%`;
      state.marker.style.top = `${(p.y / natH) * 100}%`;
    };
    const stamp = (p) => {
      const wctx = state.wctx;
      const snap = state.snapshot;
      if (!wctx || !snap || !state.offset) return;
      const r = (state.size * scale) / 2;
      if (state.mode === "heal") {
        // Feathered patch so the copy blends into its surroundings.
        const d = Math.max(2, Math.round(r * 2));
        const patch = document.createElement("canvas");
        patch.width = d;
        patch.height = d;
        const pctx = patch.getContext("2d");
        if (!pctx) return;
        pctx.drawImage(snap, p.x - state.offset.x - r, p.y - state.offset.y - r, d, d, 0, 0, d, d);
        pctx.globalCompositeOperation = "destination-in";
        const g = pctx.createRadialGradient(r, r, 0, r, r, r);
        g.addColorStop(0, "rgba(0,0,0,1)");
        g.addColorStop(0.65, "rgba(0,0,0,1)");
        g.addColorStop(1, "rgba(0,0,0,0)");
        pctx.fillStyle = g;
        pctx.fillRect(0, 0, d, d);
        wctx.drawImage(patch, p.x - r, p.y - r);
      } else {
        wctx.save();
        wctx.beginPath();
        wctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        wctx.clip();
        // snapshot shifted by offset so snapshot[P-offset] lands at P.
        wctx.drawImage(snap, state.offset.x, state.offset.y);
        wctx.restore();
      }
      state.painted = true;
      const btn = toolPanel.querySelector("[data-cl-apply]");
      if (btn) btn.disabled = false;
    };

    let drawing = false;
    let last = null;
    const down = (event) => {
      const p = at(event);
      if (!state.source) {
        state.source = p;
        state.offset = null;
        showMarker(p);
        const hint = toolPanel.querySelector("[data-cl-hint]");
        if (hint) hint.textContent = "Now brush where you want the source copied.";
        event.preventDefault();
        return;
      }
      drawing = true;
      if (!state.offset) state.offset = { x: p.x - state.source.x, y: p.y - state.source.y };
      last = p;
      stamp(p);
      try {
        overlay.setPointerCapture?.(event.pointerId);
      } catch {
        /* ignore */
      }
      event.preventDefault();
    };
    const move = (event) => {
      if (!drawing) return;
      const p = at(event);
      const dist = Math.hypot(p.x - last.x, p.y - last.y);
      const step = Math.max(1, (state.size * scale) / 5);
      const n = Math.ceil(dist / step);
      for (let i = 1; i <= n; i += 1) {
        stamp({ x: last.x + ((p.x - last.x) * i) / n, y: last.y + ((p.y - last.y) * i) / n });
      }
      last = p;
      event.preventDefault();
    };
    const up = () => {
      drawing = false;
      last = null;
    };
    overlay.addEventListener("pointerdown", down);
    overlay.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    overlayCleanup = () => {
      overlay.removeEventListener("pointerdown", down);
      overlay.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      overlay.remove();
    };
  }

  // ---- Blur & Sharpen (local, on-device) ---------------------------------

  function renderBlurTool() {
    const state = { mode: "blur", size: 60, painted: false, work: null, wctx: null, processed: {}, scale: 1 };
    toolPanel.innerHTML = `
      <div class="editor-draw">
        <div class="editor-db-modes" role="group" aria-label="Blur or sharpen">
          <button type="button" class="editor-db-mode is-active" data-bs="blur">◍ Blur</button>
          <button type="button" class="editor-db-mode" data-bs="sharpen">◆ Sharpen</button>
        </div>
        <label class="editor-slider editor-draw-size">
          <span class="editor-slider-label">Brush</span>
          <input type="range" min="20" max="140" value="60" step="1" data-bs-size aria-label="Brush size" />
        </label>
        <div class="editor-manual-actions">
          <button type="button" class="editor-manual-reset" data-bs-reset>Reset</button>
          <button type="button" class="editor-manual-apply" data-bs-apply disabled>Apply</button>
        </div>
      </div>
    `;
    toolPanel.querySelectorAll("[data-bs]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.mode = btn.dataset.bs;
        toolPanel.querySelectorAll("[data-bs]").forEach((b) => b.classList.toggle("is-active", b === btn));
      });
    });
    toolPanel.querySelector("[data-bs-size]")?.addEventListener("input", (e) => {
      state.size = Number(e.target.value) || 60;
    });
    toolPanel.querySelector("[data-bs-reset]")?.addEventListener("click", async () => {
      const bitmap = await activeBitmap();
      if (bitmap && state.wctx) {
        state.wctx.clearRect(0, 0, state.work.width, state.work.height);
        state.wctx.drawImage(bitmap, 0, 0, state.work.width, state.work.height);
      }
      state.painted = false;
      const btn = toolPanel.querySelector("[data-bs-apply]");
      if (btn) btn.disabled = true;
    });
    toolPanel.querySelector("[data-bs-apply]")?.addEventListener("click", async () => {
      if (manualBusy || !state.work || !state.painted) {
        if (!state.painted) status.textContent = "Brush an area first, then Apply.";
        return;
      }
      manualBusy = true;
      status.textContent = "Applying…";
      const blob = await canvasToBlob(state.work);
      manualBusy = false;
      commitManualVersion(state.mode === "sharpen" ? "Sharpen" : "Blur", blob, "Blur & Sharpen");
    });
    void setupBlurSurface(state);
  }

  async function setupBlurSurface(state) {
    const bitmap = await activeBitmap();
    if (!bitmap || tool !== "Blur & Sharpen" || mode !== "manual") return;
    const { overlay, work, natW, natH, scale } = buildWorkOverlay(bitmap, "editor-paint-overlay");
    state.work = work;
    state.wctx = work.getContext("2d");
    state.scale = scale;
    // Precompute fully blurred + sharpened versions via the engine; paint copies
    // the matching one into the brushed region.
    try {
      const blurBlob = applyAdjust(bitmap, { sharpness: -90 });
      const sharpBlob = applyAdjust(bitmap, { sharpness: 85 });
      state.processed.blur = blurBlob ? await loadBitmap(blurBlob) : null;
      state.processed.sharpen = sharpBlob ? await loadBitmap(sharpBlob) : null;
    } catch (error) {
      console.info("Blur/sharpen precompute failed", error);
    }
    const at = (event) => {
      const rect = overlay.getBoundingClientRect();
      return { x: (event.clientX - rect.left) * scale, y: (event.clientY - rect.top) * scale };
    };
    const stamp = (p) => {
      const src = state.processed[state.mode];
      const wctx = state.wctx;
      if (!src || !wctx) return;
      const r = (state.size * scale) / 2;
      wctx.save();
      wctx.beginPath();
      wctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      wctx.clip();
      wctx.drawImage(src, 0, 0, natW, natH);
      wctx.restore();
      state.painted = true;
      const btn = toolPanel.querySelector("[data-bs-apply]");
      if (btn) btn.disabled = false;
    };
    let drawing = false;
    let last = null;
    const down = (event) => {
      drawing = true;
      last = at(event);
      stamp(last);
      try {
        overlay.setPointerCapture?.(event.pointerId);
      } catch {
        /* ignore */
      }
      event.preventDefault();
    };
    const move = (event) => {
      if (!drawing) return;
      const p = at(event);
      const dist = Math.hypot(p.x - last.x, p.y - last.y);
      const step = Math.max(1, (state.size * scale) / 5);
      const n = Math.ceil(dist / step);
      for (let i = 1; i <= n; i += 1) {
        stamp({ x: last.x + ((p.x - last.x) * i) / n, y: last.y + ((p.y - last.y) * i) / n });
      }
      last = p;
      event.preventDefault();
    };
    const up = () => {
      drawing = false;
      last = null;
    };
    overlay.addEventListener("pointerdown", down);
    overlay.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    overlayCleanup = () => {
      overlay.removeEventListener("pointerdown", down);
      overlay.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      overlay.remove();
    };
  }

  // ---- Stickers & Shapes -------------------------------------------------

  function renderStickersTool() {
    const state = { items: [], color: "#274a86", size: 90, overlay: null, scale: 1, natW: 0, natH: 0 };
    toolPanel.innerHTML = `
      <div class="editor-stickers">
        <div class="editor-sticker-grid" aria-label="Stickers">
          ${STICKER_EMOJI.map((e) => `<button type="button" class="editor-sticker" data-emoji="${e}">${e}</button>`).join("")}
          ${STICKER_SHAPES.map((s) => `<button type="button" class="editor-sticker" data-shape="${s.key}">${s.glyph}</button>`).join("")}
        </div>
        <div class="editor-swatches" role="group" aria-label="Shape color">
          ${colorSwatchesMarkup("sticker-color", state.color)}
        </div>
        <label class="editor-slider editor-draw-size">
          <span class="editor-slider-label">Size</span>
          <input type="range" min="40" max="220" value="90" step="1" data-sticker-size aria-label="Sticker size" />
        </label>
        <div class="editor-manual-actions">
          <button type="button" class="editor-manual-reset" data-sticker-clear>Clear</button>
          <button type="button" class="editor-manual-apply" data-sticker-apply disabled>Apply</button>
        </div>
      </div>
    `;
    const applyBtn = toolPanel.querySelector("[data-sticker-apply]");
    const refresh = () => {
      if (applyBtn) applyBtn.disabled = state.items.length === 0;
    };
    toolPanel.querySelectorAll("[data-emoji]").forEach((b) =>
      b.addEventListener("click", () => addSticker(state, { type: "emoji", value: b.dataset.emoji }, refresh)),
    );
    toolPanel.querySelectorAll("[data-shape]").forEach((b) =>
      b.addEventListener("click", () => addSticker(state, { type: "shape", value: b.dataset.shape }, refresh)),
    );
    toolPanel.querySelectorAll("[data-sticker-color]").forEach((sw) =>
      sw.addEventListener("click", () => {
        state.color = sw.dataset.stickerColor;
        toolPanel.querySelectorAll("[data-sticker-color]").forEach((s) => s.classList.toggle("is-active", s === sw));
      }),
    );
    toolPanel.querySelector("[data-sticker-size]")?.addEventListener("input", (e) => {
      state.size = Number(e.target.value) || 90;
    });
    toolPanel.querySelector("[data-sticker-clear]")?.addEventListener("click", () => {
      state.items.forEach((it) => it.el?.remove());
      state.items = [];
      refresh();
    });
    applyBtn?.addEventListener("click", async () => {
      if (manualBusy || !state.items.length) return;
      manualBusy = true;
      status.textContent = "Applying…";
      const bitmap = await activeBitmap();
      const blob = bitmap ? rasterizeStickers(bitmap, state) : null;
      manualBusy = false;
      commitManualVersion("Stickers", blob, "Stickers");
    });
    void setupStickersOverlay(state);
  }

  async function setupStickersOverlay(state) {
    const bitmap = await activeBitmap();
    if (!bitmap || tool !== "Stickers" || mode !== "manual") return;
    const { overlay, natW, natH, scale } = buildImageOverlay(bitmap, "editor-text-overlay");
    state.overlay = overlay;
    state.scale = scale;
    state.natW = natW;
    state.natH = natH;
    overlayCleanup = () => overlay.remove();
  }

  function addSticker(state, def, refresh) {
    if (!state.overlay) return;
    const item = {
      type: def.type,
      value: def.value,
      color: state.color,
      size: state.size,
      x: 0.5,
      y: 0.5,
      el: null,
    };
    const el = document.createElement("div");
    el.className = "editor-sticker-el";
    el.style.left = "50%";
    el.style.top = "50%";
    el.style.fontSize = `${item.size / state.scale}px`;
    if (def.type === "emoji") {
      el.textContent = def.value;
    } else {
      el.textContent = STICKER_SHAPES.find((s) => s.key === def.value)?.glyph || "▭";
      el.style.color = item.color;
    }
    state.overlay.appendChild(el);
    item.el = el;
    state.items.push(item);
    refresh();

    let dragging = false;
    let start = null;
    el.addEventListener("pointerdown", (event) => {
      dragging = true;
      const rect = state.overlay.getBoundingClientRect();
      start = { x: event.clientX, y: event.clientY, px: item.x * rect.width, py: item.y * rect.height, w: rect.width, h: rect.height };
      try {
        el.setPointerCapture?.(event.pointerId);
      } catch {
        /* ignore */
      }
      event.preventDefault();
    });
    el.addEventListener("pointermove", (event) => {
      if (!dragging || !start) return;
      item.x = Math.max(0, Math.min(1, (start.px + (event.clientX - start.x)) / start.w));
      item.y = Math.max(0, Math.min(1, (start.py + (event.clientY - start.y)) / start.h));
      el.style.left = `${item.x * 100}%`;
      el.style.top = `${item.y * 100}%`;
      event.preventDefault();
    });
    const up = () => {
      dragging = false;
      start = null;
    };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }

  function rasterizeStickers(bitmap, state) {
    try {
      const natW = state.natW || bitmap.width || bitmap.naturalWidth || 0;
      const natH = state.natH || bitmap.height || bitmap.naturalHeight || 0;
      const surface = document.createElement("canvas");
      surface.width = natW;
      surface.height = natH;
      const ctx = surface.getContext("2d");
      if (!ctx) return null;
      for (const item of state.items) {
        const cx = item.x * natW;
        const cy = item.y * natH;
        const s = item.size; // natural px (slider is already natural-scaled on export)
        if (item.type === "emoji") {
          ctx.font = `${s}px "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(item.value, cx, cy);
        } else {
          ctx.strokeStyle = item.color;
          ctx.fillStyle = item.color;
          ctx.lineWidth = Math.max(3, s * 0.09);
          ctx.lineJoin = "round";
          ctx.lineCap = "round";
          const h = s / 2;
          if (item.value === "box") {
            ctx.strokeRect(cx - h, cy - h * 0.7, s, s * 0.7);
          } else if (item.value === "circle") {
            ctx.beginPath();
            ctx.arc(cx, cy, h, 0, Math.PI * 2);
            ctx.stroke();
          } else if (item.value === "arrow") {
            ctx.beginPath();
            ctx.moveTo(cx - h, cy);
            ctx.lineTo(cx + h, cy);
            ctx.moveTo(cx + h, cy);
            ctx.lineTo(cx + h - s * 0.28, cy - s * 0.2);
            ctx.moveTo(cx + h, cy);
            ctx.lineTo(cx + h - s * 0.28, cy + s * 0.2);
            ctx.stroke();
          }
        }
      }
      return applyOverlay(bitmap, surface);
    } catch (error) {
      console.info("rasterizeStickers failed", error);
      return null;
    }
  }

  // ---- Selective / Portrait Blur / Whiten: shared mask-brush -------------

  // Paints a FEATHERED white alpha mask (state.mask) over the photo, shows the
  // painted region as a blue tint, and calls onPaint() after each stroke. The
  // masked engine ops (applyMaskedAdjust / applyPortraitBlur) read state.mask.
  async function setupMaskBrush(state, onPaint) {
    const bitmap = await activeBitmap();
    if (!bitmap || mode !== "manual") return;
    const { overlay, natW, natH, scale } = buildImageOverlay(bitmap, "editor-paint-overlay");
    const display = document.createElement("canvas");
    display.width = natW;
    display.height = natH;
    display.className = "editor-paint-canvas";
    overlay.appendChild(display);
    const mask = document.createElement("canvas");
    mask.width = natW;
    mask.height = natH;
    const dctx = display.getContext("2d");
    const mctx = mask.getContext("2d");
    state.mask = mask;
    state.display = display;
    state.scale = scale;
    state.natW = natW;
    state.natH = natH;
    state.painted = false;
    state.clear = () => {
      dctx?.clearRect(0, 0, natW, natH);
      mctx?.clearRect(0, 0, natW, natH);
      state.painted = false;
    };

    const at = (event) => {
      const rect = overlay.getBoundingClientRect();
      return { x: (event.clientX - rect.left) * scale, y: (event.clientY - rect.top) * scale };
    };
    const dab = (p) => {
      const rad = (state.size * scale) / 2;
      if (dctx) {
        const gd = dctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad);
        gd.addColorStop(0, "rgba(74,134,255,0.5)");
        gd.addColorStop(1, "rgba(74,134,255,0)");
        dctx.fillStyle = gd;
        dctx.beginPath();
        dctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
        dctx.fill();
      }
      if (mctx) {
        const gm = mctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad);
        gm.addColorStop(0, "rgba(255,255,255,1)");
        gm.addColorStop(0.55, "rgba(255,255,255,1)");
        gm.addColorStop(1, "rgba(255,255,255,0)");
        mctx.fillStyle = gm;
        mctx.beginPath();
        mctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
        mctx.fill();
      }
    };
    let drawing = false;
    let last = null;
    const down = (event) => {
      drawing = true;
      last = at(event);
      dab(last);
      state.painted = true;
      try {
        overlay.setPointerCapture?.(event.pointerId);
      } catch {
        /* ignore */
      }
      event.preventDefault();
    };
    const move = (event) => {
      if (!drawing) return;
      const p = at(event);
      const dist = Math.hypot(p.x - last.x, p.y - last.y);
      const step = Math.max(1, (state.size * scale) / 5);
      const n = Math.ceil(dist / step);
      for (let i = 1; i <= n; i += 1) {
        dab({ x: last.x + ((p.x - last.x) * i) / n, y: last.y + ((p.y - last.y) * i) / n });
      }
      last = p;
      event.preventDefault();
    };
    const up = () => {
      if (!drawing) return;
      drawing = false;
      last = null;
      onPaint?.();
    };
    overlay.addEventListener("pointerdown", down);
    overlay.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    overlayCleanup = () => {
      overlay.removeEventListener("pointerdown", down);
      overlay.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      overlay.remove();
    };
  }

  // ---- Presets / Recipes -------------------------------------------------

  function renderPresetsTool() {
    const presets = loadPresets();
    const canSave = recipeOps.length > 0;
    toolPanel.innerHTML = `
      <div class="editor-presets">
        <div class="editor-presets-save">
          <input type="text" class="editor-text-input" data-preset-name maxlength="40"
            placeholder="Name this look…" ${canSave ? "" : "disabled"} />
          <button type="button" class="editor-manual-apply" data-preset-save ${canSave ? "" : "disabled"}>Save</button>
        </div>
        <p class="editor-erase-hint">${
          canSave
            ? `Save the ${recipeOps.length} tonal/color edit${recipeOps.length === 1 ? "" : "s"} you've made as a reusable look.`
            : "Make some tonal or color edits (Adjust, Filters, Curves, Levels, HSL, White Balance), then come back to save them as a preset."
        }</p>
        <div class="editor-presets-list">
          ${
            presets.length
              ? presets
                  .map(
                    (pr) => `
                      <div class="editor-preset-row" data-preset-id="${esc(pr.id)}">
                        <button type="button" class="editor-preset-apply">${esc(pr.name)} <small>${pr.ops.length} step${pr.ops.length === 1 ? "" : "s"}</small></button>
                        <button type="button" class="editor-preset-del" aria-label="Delete preset">✕</button>
                      </div>`,
                  )
                  .join("")
              : `<p class="editor-erase-hint">No saved presets yet.</p>`
          }
        </div>
      </div>
    `;
    const nameInput = toolPanel.querySelector("[data-preset-name]");
    toolPanel.querySelector("[data-preset-save]")?.addEventListener("click", () => {
      if (!recipeOps.length) return;
      const list = loadPresets();
      const name = (nameInput?.value || "").trim() || `Look ${list.length + 1}`;
      list.unshift({ id: `p${Date.now().toString(36)}`, name, ops: recipeOps.map((o) => ({ ...o })) });
      savePresetsList(list.slice(0, 40));
      status.textContent = `Saved "${name}".`;
      renderPresetsTool();
    });
    toolPanel.querySelectorAll(".editor-preset-apply").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (manualBusy) return;
        const id = btn.closest("[data-preset-id]")?.dataset.presetId;
        const pr = loadPresets().find((x) => x.id === id);
        if (!pr) return;
        manualBusy = true;
        status.textContent = `Applying "${pr.name}"…`;
        const bitmap = await activeBitmap();
        const blob = bitmap ? await applyRecipe(bitmap, pr.ops) : null;
        manualBusy = false;
        commitManualVersion(pr.name, blob, "Presets");
      });
    });
    toolPanel.querySelectorAll(".editor-preset-del").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.closest("[data-preset-id]")?.dataset.presetId;
        savePresetsList(loadPresets().filter((x) => x.id !== id));
        renderPresetsTool();
      });
    });
  }

  // ---- Selective (local adjustment within a brushed mask) ----------------

  function renderSelectiveTool() {
    const state = { size: 60, invert: false, mask: null, painted: false, scale: 1, clear: null };
    const values = { exposure: 0, contrast: 0, saturation: 0, warmth: 0 };
    const fields = [
      { key: "exposure", label: "Exposure" },
      { key: "contrast", label: "Contrast" },
      { key: "saturation", label: "Saturation" },
      { key: "warmth", label: "Warmth" },
    ];
    let timer = 0;
    toolPanel.innerHTML = `
      <div class="editor-adjust">
        <p class="editor-erase-hint">Auto-select a region, or brush one — then move the sliders.</p>
        <div class="editor-db-modes editor-automask" role="group" aria-label="Auto select">
          <button type="button" class="editor-db-mode" data-auto="person">Person</button>
          <button type="button" class="editor-db-mode" data-auto="sky">Sky</button>
          <button type="button" class="editor-db-mode" data-auto="foreground">Subject</button>
          <button type="button" class="editor-db-mode" data-auto="bright">Bright</button>
          <button type="button" class="editor-db-mode" data-auto="dark">Dark</button>
        </div>
        <label class="editor-slider editor-draw-size">
          <span class="editor-slider-label">Brush</span>
          <input type="range" min="16" max="140" value="60" step="1" data-sel-size aria-label="Brush size" />
        </label>
        ${fields
          .map(
            (f) => `
              <label class="editor-slider">
                <span class="editor-slider-label">${f.label}</span>
                <input type="range" min="-100" max="100" value="0" step="1" data-sel="${f.key}" aria-label="${f.label}" />
                <output data-sel-out="${f.key}">0</output>
              </label>`,
          )
          .join("")}
        <button type="button" class="editor-db-mode" data-sel-invert>Affect outside the brush instead</button>
        <div class="editor-manual-actions">
          <button type="button" class="editor-manual-reset" data-sel-clear>Clear</button>
          <button type="button" class="editor-manual-apply" data-sel-apply disabled>Apply</button>
        </div>
      </div>
    `;
    const applyBtn = toolPanel.querySelector("[data-sel-apply]");
    const preview = () => {
      window.clearTimeout(timer);
      if (state.painted && applyBtn) applyBtn.disabled = false; // usable the instant a stroke lands
      timer = window.setTimeout(async () => {
        if (!state.mask || !state.painted || tool !== "Selective") return;
        const bitmap = await activeBitmap();
        if (!bitmap) return;
        showToolPreview(applyMaskedAdjust(bitmap, values, state.mask, state.invert));
        if (applyBtn) applyBtn.disabled = false;
      }, 140);
    };
    // One-tap auto-selection (Sky / Subject / Bright / Dark) → fills the mask.
    toolPanel.querySelectorAll("[data-auto]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const bitmap = await activeBitmap();
        if (!bitmap || !state.mask || !state.display) return;
        const type = btn.dataset.auto;
        let auto;
        if (type === "person") {
          // True on-device segmentation, with a graceful fall back to the
          // heuristic subject mask if the model can't load.
          status.textContent = "Selecting the person…";
          auto = await segmentPerson(bitmap);
          if (tool !== "Selective") return;
          if (auto) status.textContent = "Person selected.";
          else {
            auto = buildAutoMask(bitmap, "foreground");
            status.textContent = "Selected the subject (approximate).";
          }
        } else {
          auto = buildAutoMask(bitmap, type);
        }
        if (!auto) return;
        const mctx = state.mask.getContext("2d");
        const dctx = state.display.getContext("2d");
        if (mctx) {
          mctx.clearRect(0, 0, state.natW, state.natH);
          mctx.drawImage(auto, 0, 0);
        }
        if (dctx) {
          // Tint the selected region blue so the user sees what's selected.
          dctx.clearRect(0, 0, state.natW, state.natH);
          dctx.globalAlpha = 0.5;
          dctx.drawImage(auto, 0, 0);
          dctx.globalCompositeOperation = "source-in";
          dctx.fillStyle = "#4a86ff";
          dctx.fillRect(0, 0, state.natW, state.natH);
          dctx.globalCompositeOperation = "source-over";
          dctx.globalAlpha = 1;
        }
        state.painted = true;
        toolPanel.querySelectorAll("[data-auto]").forEach((b) => b.classList.toggle("is-active", b === btn));
        preview();
      });
    });
    toolPanel.querySelector("[data-sel-size]")?.addEventListener("input", (e) => {
      state.size = Number(e.target.value) || 60;
    });
    toolPanel.querySelectorAll("[data-sel]").forEach((input) => {
      input.addEventListener("input", () => {
        const k = input.dataset.sel;
        values[k] = Number(input.value) || 0;
        const out = toolPanel.querySelector(`[data-sel-out="${k}"]`);
        if (out) out.textContent = String(values[k]);
      });
      input.addEventListener("change", preview);
    });
    toolPanel.querySelector("[data-sel-invert]")?.addEventListener("click", (e) => {
      state.invert = !state.invert;
      e.target.classList.toggle("is-active", state.invert);
      e.target.textContent = state.invert ? "Affecting outside the brush" : "Affect outside the brush instead";
      preview();
    });
    toolPanel.querySelector("[data-sel-clear]")?.addEventListener("click", () => {
      state.clear?.();
      window.clearTimeout(timer);
      resetPreview();
      if (applyBtn) applyBtn.disabled = true;
    });
    applyBtn?.addEventListener("click", async () => {
      if (manualBusy || !state.mask || !state.painted) {
        if (!state.painted) status.textContent = "Brush an area first, then Apply.";
        return;
      }
      const changed = fields.some((f) => values[f.key] !== 0);
      if (!changed) {
        status.textContent = "Move a slider first, then Apply.";
        return;
      }
      window.clearTimeout(timer);
      manualBusy = true;
      status.textContent = "Applying local edit…";
      const bitmap = await activeBitmap();
      const blob = bitmap ? applyMaskedAdjust(bitmap, values, state.mask, state.invert) : null;
      manualBusy = false;
      commitManualVersion("Selective", blob, "Selective");
    });
    void setupMaskBrush(state, preview);
  }

  // ---- Portrait Blur (keep subject sharp, blur the rest) -----------------

  function renderPortraitBlurTool() {
    const state = { size: 70, mode: "focus", amount: 10, mask: null, painted: false, scale: 1, clear: null };
    let timer = 0;
    toolPanel.innerHTML = `
      <div class="editor-adjust">
        <div class="editor-db-modes" role="group" aria-label="Focus or blur">
          <button type="button" class="editor-db-mode is-active" data-pb="focus">◉ Keep sharp</button>
          <button type="button" class="editor-db-mode" data-pb="blur">◌ Blur this</button>
        </div>
        <p class="editor-erase-hint" data-pb-hint>Brush the subject to keep it sharp — everything else blurs.</p>
        <label class="editor-slider editor-draw-size">
          <span class="editor-slider-label">Brush</span>
          <input type="range" min="20" max="160" value="70" step="1" data-pb-size aria-label="Brush size" />
        </label>
        <label class="editor-slider">
          <span class="editor-slider-label">Blur</span>
          <input type="range" min="2" max="40" value="10" step="1" data-pb-amount aria-label="Blur amount" />
          <output data-pb-out>10</output>
        </label>
        <div class="editor-manual-actions">
          <button type="button" class="editor-manual-reset" data-pb-clear>Clear</button>
          <button type="button" class="editor-manual-apply" data-pb-apply disabled>Apply</button>
        </div>
      </div>
    `;
    const applyBtn = toolPanel.querySelector("[data-pb-apply]");
    const scaledRadius = async () => {
      const bitmap = await activeBitmap();
      const natW = bitmap?.width || bitmap?.naturalWidth || 1000;
      // amount is display-ish; scale to image pixels so blur looks the same on big images.
      return (state.amount / 1000) * natW;
    };
    const preview = () => {
      window.clearTimeout(timer);
      if (state.painted && applyBtn) applyBtn.disabled = false;
      timer = window.setTimeout(async () => {
        if (!state.mask || !state.painted || tool !== "Portrait Blur") return;
        const bitmap = await activeBitmap();
        if (!bitmap) return;
        const r = await scaledRadius();
        showToolPreview(applyPortraitBlur(bitmap, state.mask, r, state.mode === "blur"));
        if (applyBtn) applyBtn.disabled = false;
      }, 160);
    };
    toolPanel.querySelectorAll("[data-pb]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.mode = btn.dataset.pb;
        toolPanel.querySelectorAll("[data-pb]").forEach((b) => b.classList.toggle("is-active", b === btn));
        const hint = toolPanel.querySelector("[data-pb-hint]");
        if (hint) {
          hint.textContent = state.mode === "focus"
            ? "Brush the subject to keep it sharp — everything else blurs."
            : "Brush the area you want blurred.";
        }
        preview();
      });
    });
    toolPanel.querySelector("[data-pb-size]")?.addEventListener("input", (e) => {
      state.size = Number(e.target.value) || 70;
    });
    toolPanel.querySelector("[data-pb-amount]")?.addEventListener("input", (e) => {
      state.amount = Number(e.target.value) || 10;
      const out = toolPanel.querySelector("[data-pb-out]");
      if (out) out.textContent = String(state.amount);
    });
    toolPanel.querySelector("[data-pb-amount]")?.addEventListener("change", preview);
    toolPanel.querySelector("[data-pb-clear]")?.addEventListener("click", () => {
      state.clear?.();
      window.clearTimeout(timer);
      resetPreview();
      if (applyBtn) applyBtn.disabled = true;
    });
    applyBtn?.addEventListener("click", async () => {
      if (manualBusy || !state.mask || !state.painted) {
        if (!state.painted) status.textContent = "Brush the subject first, then Apply.";
        return;
      }
      window.clearTimeout(timer);
      manualBusy = true;
      status.textContent = "Applying blur…";
      const bitmap = await activeBitmap();
      const r = await scaledRadius();
      const blob = bitmap ? applyPortraitBlur(bitmap, state.mask, r, state.mode === "blur") : null;
      manualBusy = false;
      commitManualVersion("Portrait blur", blob, "Portrait Blur");
    });
    void setupMaskBrush(state, preview);
  }

  // ---- Whiten (teeth / eyes brush) ---------------------------------------

  function renderWhitenTool() {
    const state = { size: 40, intensity: 60, mask: null, painted: false, scale: 1, clear: null };
    let timer = 0;
    const adjustFor = () => {
      const k = state.intensity / 100;
      return { brightness: 18 * k, saturation: -34 * k, warmth: -14 * k };
    };
    toolPanel.innerHTML = `
      <div class="editor-adjust">
        <p class="editor-erase-hint">Brush over teeth or the whites of the eyes to brighten and whiten them.</p>
        <label class="editor-slider editor-draw-size">
          <span class="editor-slider-label">Brush</span>
          <input type="range" min="8" max="70" value="40" step="1" data-wh-size aria-label="Brush size" />
        </label>
        <label class="editor-slider">
          <span class="editor-slider-label">Strength</span>
          <input type="range" min="10" max="100" value="60" step="1" data-wh-amount aria-label="Strength" />
          <output data-wh-out>60</output>
        </label>
        <div class="editor-manual-actions">
          <button type="button" class="editor-manual-reset" data-wh-clear>Clear</button>
          <button type="button" class="editor-manual-apply" data-wh-apply disabled>Apply</button>
        </div>
      </div>
    `;
    const applyBtn = toolPanel.querySelector("[data-wh-apply]");
    const preview = () => {
      window.clearTimeout(timer);
      if (state.painted && applyBtn) applyBtn.disabled = false;
      timer = window.setTimeout(async () => {
        if (!state.mask || !state.painted || tool !== "Whiten") return;
        const bitmap = await activeBitmap();
        if (!bitmap) return;
        showToolPreview(applyMaskedAdjust(bitmap, adjustFor(), state.mask, false));
        if (applyBtn) applyBtn.disabled = false;
      }, 140);
    };
    toolPanel.querySelector("[data-wh-size]")?.addEventListener("input", (e) => {
      state.size = Number(e.target.value) || 40;
    });
    toolPanel.querySelector("[data-wh-amount]")?.addEventListener("input", (e) => {
      state.intensity = Number(e.target.value) || 60;
      const out = toolPanel.querySelector("[data-wh-out]");
      if (out) out.textContent = String(state.intensity);
    });
    toolPanel.querySelector("[data-wh-amount]")?.addEventListener("change", preview);
    toolPanel.querySelector("[data-wh-clear]")?.addEventListener("click", () => {
      state.clear?.();
      window.clearTimeout(timer);
      resetPreview();
      if (applyBtn) applyBtn.disabled = true;
    });
    applyBtn?.addEventListener("click", async () => {
      if (manualBusy || !state.mask || !state.painted) {
        if (!state.painted) status.textContent = "Brush the teeth or eyes first, then Apply.";
        return;
      }
      window.clearTimeout(timer);
      manualBusy = true;
      status.textContent = "Whitening…";
      const bitmap = await activeBitmap();
      const blob = bitmap ? applyMaskedAdjust(bitmap, adjustFor(), state.mask, false) : null;
      manualBusy = false;
      commitManualVersion("Whiten", blob, "Whiten");
    });
    void setupMaskBrush(state, preview);
  }

  // ---- Add (AI tool, model-gated) ----------------------------------------

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
  async function loadRealPhoto(photoId, token, autoInstruction = "") {
    try {
      // Load the real photo whenever it exists — crop/adjust/filters are pure
      // on-device work and need no session. The AI tools (describe/erase/add/
      // style) check for a session themselves at request time and fail gracefully.
      const record = await getPhoto(photoId);
      if (token !== activationToken || !record) return;
      // A simulated edit already started in the gap — don't clobber it.
      if (processing || versions.length > 1) return;
      photo = record;
      loadEditSession();
      // Warm the edit endpoints (TLS + edge cold start) so the FIRST described
      // edit doesn't pay them. Fire-and-forget, free.
      prewarmInterpreter();
      try { void fetch(EDIT_FUNCTION_URL, { method: "OPTIONS" }).catch(() => {}); } catch { /* ignore */ }
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
      // An instruction handed over from the Home chat box: prefill it and run
      // the edit now that the photo is here (tonal edits apply instantly on
      // device; content edits go to the model).
      const instruction = String(autoInstruction || "").trim();
      if (instruction && !processing) {
        promptInput.value = instruction;
        syncPrompt();
        requestEdit(instruction);
      }
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
  async function requestRealEdit(instruction, kind, maskBase64 = null) {
    if (!instruction || processing) return;
    const token = activationToken;
    const sourceVersion = currentVersion();
    editorActions.requestEdit(instruction, sourceVersion);
    if (kind === "describe") lastInstruction = instruction;
    promptInput.value = "";
    processing = true;
    reroll.classList.remove("is-attention");
    syncPrompt();
    renderVersions();
    syncCanvas();
    const genRun = showGenLifecycle(instruction);
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
          ...(maskBase64 ? { maskBase64 } : {}),
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
        void verifyEditIdentity(data.url, token, nextId);
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
      endGenLifecycle(genRun);
      if (token === activationToken) {
        processing = false;
        renderVersions({ focusActive: succeeded });
        syncCanvas();
        syncPrompt();
      }
    }
  }

  // After a generative edit lands, quietly check the face against the user's
  // tagged identity (on-device, same check scenes use). A drifted face gets a
  // warning + the Reroll hint instead of silently shipping a stranger. Never
  // blocks, never spends another credit on its own.
  async function verifyEditIdentity(url, token, versionId) {
    try {
      if (!(await hasMeIdentity())) return;
      const res = await fetch(url);
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);
      const dist = await faceDistanceToMe(bitmap);
      bitmap.close?.();
      // A slow check must not speak for a version the user has already moved
      // past — it would warn about (and point Reroll at) the wrong edit.
      if (token !== activationToken || versionId !== activeVersionId || dist == null) return;
      if (dist > 0.62) {
        status.textContent = "Heads up — the face drifted from you in that edit. Tap Reroll to try again.";
        reroll.classList.add("is-attention");
      }
    } catch (error) {
      console.info("edit identity check skipped", error);
    }
  }

  // ---- Edit Interpreter (v2) --------------------------------------------
  // Every Describe-It input flows through the interpreter first. It returns a
  // PLAN of typed ops; deterministic ops (crop/rotate/adjust/local_adjust/style)
  // run on-device with ZERO generative calls, and only expand/generative_edit/
  // scenario reach a model. Session memory persists per photo.

  function editSessionKey() {
    return photo ? `gems.editsession.${photo.id}` : null;
  }
  function loadEditSession() {
    editSession = { ops: [], lastTarget: null };
    try {
      const key = editSessionKey();
      const raw = key ? window.localStorage.getItem(key) : null;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.ops)) editSession = { ops: parsed.ops.slice(-5), lastTarget: parsed.lastTarget ?? null };
      }
    } catch (error) {
      console.info("edit session load skipped", error);
    }
  }
  function persistEditSession() {
    try {
      const key = editSessionKey();
      if (key) window.localStorage.setItem(key, JSON.stringify(editSession));
    } catch (error) {
      console.info("edit session persist skipped", error);
    }
  }
  function recordSessionOp(op) {
    editSession = pushSessionOp(editSession, op);
    persistEditSession();
  }

  // Arbitrary-angle client rotate (applyGeometry only does 90° steps). Rotates
  // the bitmap and crops back to the largest centered axis-aligned rectangle so
  // there are no empty corners. Returns a Blob or null.
  function rotateBitmapArbitrary(bitmap, degrees) {
    try {
      const deg = Number(degrees) || 0;
      if (deg % 90 === 0) return applyGeometry(bitmap, { rotate: deg });
      const w = bitmap.width || bitmap.naturalWidth || 0;
      const h = bitmap.height || bitmap.naturalHeight || 0;
      if (!w || !h) return null;
      const rad = (deg * Math.PI) / 180;
      const cos = Math.abs(Math.cos(rad));
      const sin = Math.abs(Math.sin(rad));
      const bw = Math.ceil(w * cos + h * sin);
      const bh = Math.ceil(w * sin + h * cos);
      const canvas = document.createElement("canvas");
      canvas.width = bw;
      canvas.height = bh;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.translate(bw / 2, bh / 2);
      ctx.rotate(rad);
      ctx.drawImage(bitmap, -w / 2, -h / 2);
      // Largest inscribed rectangle of the ORIGINAL aspect within the rotation.
      const ar = w / h;
      const absCos = Math.abs(Math.cos(rad));
      const absSin = Math.abs(Math.sin(rad));
      let cw;
      let ch;
      if (ar >= 1) {
        ch = Math.min(h, (w) / (ar * absSin + absCos) * 1); // conservative
        cw = ch * ar;
      } else {
        cw = Math.min(w, (h) / (absSin + absCos / ar));
        ch = cw / ar;
      }
      cw = Math.min(cw, w * 0.98);
      ch = Math.min(ch, h * 0.98);
      const out = document.createElement("canvas");
      out.width = Math.round(cw);
      out.height = Math.round(ch);
      const octx = out.getContext("2d");
      if (!octx) return null;
      octx.drawImage(canvas, (bw - cw) / 2, (bh - ch) / 2, cw, ch, 0, 0, cw, ch);
      return dataURLToBlob(out.toDataURL("image/jpeg", 0.92));
    } catch (error) {
      console.info("arbitrary rotate failed", error);
      return null;
    }
  }
  function dataURLToBlob(dataUrl) {
    const comma = dataUrl.indexOf(",");
    const bytes = atob(dataUrl.slice(comma + 1));
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    return new Blob([arr], { type: "image/jpeg" });
  }

  // Build the mask for a local_adjust target. Subject/face/background use the
  // real on-device person segmenter (MediaPipe); sky uses the color heuristic.
  // Returns { mask, invert } — invert flips the mask so "background" hits
  // everything EXCEPT the person. Falls back to a heuristic mask, never a no-op.
  async function localMaskFor(bitmap, target) {
    if (target === "sky") return { mask: buildAutoMask(bitmap, "sky"), invert: false };
    if (target === "bright") return { mask: buildAutoMask(bitmap, "bright"), invert: false };
    if (target === "dark") return { mask: buildAutoMask(bitmap, "dark"), invert: false };
    if (target === "background") {
      const person = await segmentPerson(bitmap);
      if (person) return { mask: person, invert: true };
      return { mask: buildAutoMask(bitmap, "sky"), invert: false };
    }
    // subject / face
    const person = await segmentPerson(bitmap);
    if (person) return { mask: person, invert: false };
    return { mask: buildAutoMask(bitmap, "bright"), invert: false };
  }

  // Show a clarify question with up to 4 tappable options in the status strip.
  function showClarify(clarify) {
    const q = clarify?.question || "Which did you mean?";
    status.textContent = q;
    const options = Array.isArray(clarify?.options) ? clarify.options.slice(0, 4) : [];
    // Reuse the describe suggestions row if present, else drop chips under status.
    let strip = mount.querySelector("#editorClarify");
    if (!strip) {
      strip = document.createElement("div");
      strip.id = "editorClarify";
      strip.className = "editor-clarify";
      status.insertAdjacentElement("afterend", strip);
    }
    strip.innerHTML = options
      .map(
        (o) =>
          `<button type="button" class="editor-clarify-chip" data-clarify="${esc(o.value)}">${esc(o.label)}</button>`,
      )
      .join("");
    strip.hidden = options.length === 0;
    strip.querySelectorAll("[data-clarify]").forEach((b) =>
      b.addEventListener("click", () => {
        strip.hidden = true;
        strip.innerHTML = "";
        requestEdit(b.dataset.clarify);
      }),
    );
  }
  function clearClarify() {
    const strip = mount.querySelector("#editorClarify");
    if (strip) {
      strip.hidden = true;
      strip.innerHTML = "";
    }
  }

  // Run one plan op. Deterministic ops commit a manual version on-device;
  // generative/scenario ops go to the right edge function. Returns true if it
  // produced (or kicked off) a result.
  async function executeOp(op) {
    const p = op?.params || {};
    if (op.engine === "generative" || op.op === "generative_edit") {
      const instruction =
        op.op === "expand"
          ? `Zoom out and uncrop: extend the scene naturally outward by about ${Math.round((Number(p.grow) || 0.3) * 100)}%, keeping the existing subject and content unchanged and continuing the surroundings realistically.`
          : String(p.instruction || lastInstruction || "").trim();
      recordSessionOp({ op: op.op, params: p });
      await requestRealEdit(instruction, op.op === "expand" ? "expand" : "describe");
      return true;
    }
    if (op.op === "scenario") {
      recordSessionOp({ op: "scenario", params: { place: p.place ?? null } });
      await applyScenario(p);
      return true;
    }
    if (op.op === "undo") {
      if (activeVersionId > 0) {
        activeVersionId -= 1;
        renderVersions({ focusActive: true });
        syncCanvas();
        status.textContent = "Backed off the last change.";
      }
      return true;
    }
    // ---- Deterministic, on-device ops (no model call).
    const bitmap = await activeBitmap();
    if (!bitmap) {
      // Say so. Returning quietly leaves the user on "Reading your edit…" with
      // nothing having happened and no way to tell that it failed.
      status.textContent = "That edit couldn't be applied — try again.";
      return false;
    }
    let blob = null;
    let label = op.say || "Edit";
    if (op.op === "crop") {
      const saliency = photoMetaForInterpreter().derived?.saliency ?? null;
      const rect = cropRectFor(p, bitmap.width || bitmap.naturalWidth, bitmap.height || bitmap.naturalHeight, saliency);
      blob = applyCrop(bitmap, rect);
      label = op.say || "Crop";
    } else if (op.op === "rotate") {
      blob = rotateBitmapArbitrary(bitmap, p.degrees);
      label = op.say || "Rotate";
    } else if (op.op === "adjust") {
      blob = applyAdjust(bitmap, p);
      label = op.say || "Adjust";
    } else if (op.op === "local_adjust") {
      const { mask, invert } = await localMaskFor(bitmap, p.target);
      blob = mask ? applyMaskedAdjust(bitmap, p.adjust || {}, mask, invert) : applyAdjust(bitmap, p.adjust || {});
      label = op.say || "Local adjust";
    } else if (op.op === "style") {
      const grade = FILTER_GRADES.find((g) => g.key === p.grade || g.id === p.grade);
      if (grade) blob = applyGrade(bitmap, grade);
      else {
        await requestRealEdit(String(p.instruction || label), "describe");
        return true;
      }
      label = op.say || "Style";
    } else {
      return false;
    }
    if (!blob) {
      status.textContent = "That edit couldn't be applied — try again.";
      return false;
    }
    recordSessionOp({ op: op.op, params: p });
    commitManualVersion(label, blob, "Describe");
    return true;
  }

  // Scenario placement: put the user into a generated scene via generate-scene.
  async function applyScenario(params) {
    const token = activationToken;
    let scenarioGenRun = null;
    processing = true;
    syncPrompt();
    renderVersions();
    syncCanvas();
    status.textContent = "Placing you in the scene…";
    try {
      const specParts = [params.scene_spec, params.camera, params.pose].filter(Boolean);
      const scenePrompt = specParts.join(". ").slice(0, 780) || "a photo of me in the scene";
      scenarioGenRun = showGenLifecycle(scenePrompt);
      // Route the scenario into the nearest style pack so it inherits that
      // pack's REAL environment-reference conditioning (the anti-AI anchor),
      // and attach the user's tagged face cluster for identity fidelity.
      let identityPhotoIds = [];
      try {
        if (await hasMeIdentity()) identityPhotoIds = (await getMeReferences(4)).map((r) => r.photoId);
      } catch { /* no identity → single reference */ }
      const result = await generateScene({
        mode: "me",
        subjectPhotoId: photo.id,
        identityPhotoIds,
        stylePackId: matchPackForText(scenePrompt) || undefined,
        environmentRef: Math.floor(Math.random() * 1000),
        prompt: scenePrompt,
        quality: "pro",
        aspect: "4:5",
      });
      if (token !== activationToken) return;
      if (result?.url) {
        const nextId = versions.length;
        versions.push({ id: nextId, label: `V${nextId}`, url: result.url });
        activeVersionId = nextId;
        status.textContent = `Version ${nextId} is ready.`;
      } else if (result?.error === "paywall") {
        status.textContent = "You've used your free generations this month — Gems Plus unlocks more.";
      } else {
        status.textContent = "That scene didn't generate — try again.";
      }
    } catch (error) {
      console.info("scenario generation failed", error);
      status.textContent = "That scene didn't generate — try again.";
    } finally {
      endGenLifecycle(scenarioGenRun);
      if (token === activationToken) {
        processing = false;
        renderVersions({ focusActive: true });
        syncCanvas();
        syncPrompt();
      }
    }
  }

  // Light photo meta for the interpreter (dims + any derived saliency box).
  function photoMetaForInterpreter() {
    const meta = { kind: photo?.kind ?? "photo" };
    if (photo?.width && photo?.height) meta.width = photo.width;
    if (photo?.derived?.saliency) meta.derived = { saliency: photo.derived.saliency };
    else meta.derived = {};
    return meta;
  }

  // The Describe-It entrypoint (real-photo mode): interpret, then execute the plan.
  // A described NAMED LOOK ("make it moodier", "after dark", "golden hour") is a
  // grade we already own, so matchNamedGrade() (over FILTER_GRADES, the single
  // source of truth) applies it on-device: instant, free, offline, and always
  // exactly the look asked for.
  async function runInterpretedEdit(prompt) {
    if (processing) return;
    clearClarify();
    promptInput.value = "";
    syncPrompt();
    lastInstruction = prompt;
    status.textContent = "Reading your edit…";

    // Named-look fast path — no network at all. When the instruction asks for
    // ANYTHING besides the look ("remove the guy and make it moodier", "crop it
    // square and make it after dark"), the grade is only half the ask: apply it
    // here, then carry the REST on to the interpreter. Stopping at the grade
    // would silently drop the part the user probably cared about most.
    let instruction = prompt;
    const named = matchNamedGrade(prompt);
    if (named) {
      try {
        const bitmap = await activeBitmap();
        const blob = bitmap ? applyGrade(bitmap, named.grade) : null;
        if (blob) {
          const rest = hasEditOp(named.rest) ? named.rest.trim() : "";
          recordSessionOp({ op: "style", params: { grade: named.grade.key } });
          commitManualVersion(named.grade.label, blob, "Describe");
          editorActions.requestEdit(prompt, currentVersion());
          if (!rest) {
            status.textContent = `${named.grade.label} applied.`;
            return;
          }
          instruction = rest;
          status.textContent = `${named.grade.label} applied — now: ${rest}`;
        }
      } catch (error) {
        console.info("named grade failed, falling through to the interpreter", error);
      }
    }
    let result;
    try {
      result = await interpretEdit({
        instruction,
        sessionState: editSession,
        photoMeta: photoMetaForInterpreter(),
      });
    } catch (error) {
      console.info("interpret failed, using generative fallback", error);
      void requestRealEdit(instruction, "describe");
      return;
    }
    if (result?.clarify && (!result.plan || !result.plan.length)) {
      showClarify(result.clarify);
      return;
    }
    const plan = Array.isArray(result?.plan) ? result.plan : [];
    if (!plan.length) {
      // The model sees only what's LEFT to do — the grade is already applied,
      // and re-sending its name would have the model grade it a second time.
      void requestRealEdit(instruction, "describe");
      return;
    }
    // Execute ops in order. Generative/scenario ops manage their own status.
    for (const op of plan) {
      const done = await executeOp(op);
      if (!done) break;
    }
  }

  function requestEdit(rawPrompt) {
    const prompt = rawPrompt.trim();
    if (!prompt || processing) return;
    if (photo) {
      // "Edit this for me" → auto-aesthetic grade (nearest-look match), server-side.
      if (AUTO_AESTHETIC_RE.test(prompt)) {
        void requestRealEdit(prompt, "auto-aesthetic");
        return;
      }
      void runInterpretedEdit(prompt);
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

  // The app resizes to the visual viewport (styles.css + app.js), so the
  // describe composer already sits flush above the keyboard — no scrollIntoView,
  // which is what used to make the editor "jump" when the box was tapped.

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
      recipeOps = [];
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
      const instruction =
        typeof options.instruction === "string" ? options.instruction.trim() : "";
      if (options.photoId) {
        void loadRealPhoto(options.photoId, activationToken, instruction);
      } else if (instruction) {
        // No photo to target — at least surface the instruction in the box.
        promptInput.value = instruction;
        syncPrompt();
      }
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
      // Leaving the editor stops the lifecycle overlay's interval — an
      // unabortable scenario request must not leave it ticking.
      genRunId += 1;
      endGenLifecycle(genRunId);
      reroll.classList.remove("is-attention");
      teardownToolPanel();
      revokeManualUrls();
      bitmapCache.clear();
      versionBlobs.clear();
      syncCanvas();
      syncPrompt();
    },
  });
}
