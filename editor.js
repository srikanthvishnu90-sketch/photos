import { editorActions } from "./editor-actions.js";
import { getPhoto, getPhotoBlob } from "./gems-photolib.js";
import { getSession } from "./gems-supabase.js";

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
  "Remove the ship in the background",
  "Make it golden hour",
  "Fix the lighting on my face",
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

    <div class="editor-canvas-region">
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
    </div>

    <div class="editor-mode-region">
      <div class="editor-mode-toggle" role="group" aria-label="Editing mode">
        <button class="editor-mode is-active" type="button" data-editor-mode="describe" aria-pressed="true">
          Describe it
        </button>
        <button class="editor-mode" type="button" data-editor-mode="manual" aria-pressed="false">
          Manual tools
        </button>
      </div>
    </div>

    <div class="editor-panel-spacer" aria-hidden="true"></div>

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
    </section>
  `;
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
  let mode = "describe";
  let tool = "Erase";
  let versions = [];
  let activeVersionId = 0;
  let processing = false;
  let processingTimer = 0;
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
    if (mode === "describe") syncPrompt();
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
  }

  // Try to swap the canvas from the simulated scene to the real library photo.
  // Anything missing — no record, no session, storage failure — leaves the
  // demo flow untouched.
  async function loadRealPhoto(photoId, token) {
    try {
      const [record, session] = await Promise.all([getPhoto(photoId), getSession()]);
      if (token !== activationToken || !record || !session) return;
      // A simulated edit already started in the gap — don't clobber it.
      if (processing || versions.length > 1) return;
      photo = record;
      photoView.alt = record.name || "Photo being edited";
      versions = [{ id: 0, label: "Original", url: record.url }];
      activeVersionId = 0;
      renderVersions();
      syncCanvas();
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

  function requestEdit(rawPrompt) {
    const prompt = rawPrompt.trim();
    if (!prompt || processing) return;
    if (photo) {
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

  return Object.freeze({
    activate(options = {}) {
      window.clearTimeout(processingTimer);
      abortController?.abort();
      abortController = null;
      activationToken += 1;
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
      syncCanvas();
      syncPrompt();
    },
  });
}
