import { editorActions } from "./editor-actions.js";

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

  function currentVersion() {
    return versions.find((version) => version.id === activeVersionId) || versions[0];
  }

  function syncCanvas() {
    const version = currentVersion();
    canvas.classList.toggle("has-no-ship", version && !version.ship);
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

  function requestEdit(rawPrompt) {
    const prompt = rawPrompt.trim();
    if (!prompt || processing) return;
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
  reroll.addEventListener("click", () => requestEdit("Try another result"));

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
    },

    focusHeading() {
      title.focus({ preventScroll: true });
    },

    deactivate() {
      window.clearTimeout(processingTimer);
      processing = false;
      syncCanvas();
      syncPrompt();
    },
  });
}
