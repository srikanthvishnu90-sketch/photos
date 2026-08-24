import { logCustomAesthetic, submitOnboarding } from "./onboarding-api.js";

const AESTHETIC_TAGS = Object.freeze([
  "Dark Gym",
  "Euro Summer",
  "Nightlife Flash",
  "Film Nostalgia",
  "Clean Editorial",
  "Streetwear",
  "Quiet Luxury",
  "Golden Hour",
  "Old Money",
  "Y2K",
  "Coquette",
  "Grunge",
  "Indie Sleaze",
  "Minimalist",
  "Coastal",
  "Downtown",
  "Athleisure",
  "Preppy",
  "Cottagecore",
  "Vintage Film",
  "Alt",
  "Scandi",
  "Beach Day",
  "City Lights",
  "Motorsport",
  "Country",
  "Soft Glam",
  "Concert",
]);

const AGE_RANGES = Object.freeze(["Under 18", "18–21", "22–29", "30+"]);
const MAX_AESTHETICS = 5;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function firstName(name) {
  return name.trim().split(/\s+/)[0] || "friend";
}

function checkmark() {
  return `
    <svg viewBox="0 0 11 9" aria-hidden="true">
      <path d="M1 4.5 4 7.5 10 1.5"></path>
    </svg>
  `;
}

function selectionRow(label, selected, delay) {
  const safeLabel = escapeHtml(label);
  return `
    <button
      class="select-row step-entrance${selected ? " is-selected" : ""}"
      type="button"
      data-selection="${safeLabel}"
      aria-pressed="${selected}"
      style="animation-delay: ${delay}ms"
    >
      <span>${safeLabel}</span>
      <span class="select-radio" aria-hidden="true">${selected ? checkmark() : ""}</span>
    </button>
  `;
}

function primaryButton(id, enabled, label) {
  return `
    <button id="${id}" class="primary-button" type="button"${enabled ? "" : " disabled"}>
      ${escapeHtml(label)}
    </button>
  `;
}

function headline(id, content) {
  return `<h1 id="${id}" class="step-headline step-entrance" tabindex="-1">${content}</h1>`;
}

function subhead(content) {
  return `<p class="step-subhead step-entrance">${content}</p>`;
}

function plusIcon() {
  return `
    <svg class="chip-icon chip-icon-plus" viewBox="0 0 11 11" aria-hidden="true">
      <path d="M5.5 1v9M1 5.5h9"></path>
    </svg>
  `;
}

function removeIcon() {
  return `
    <svg class="chip-icon chip-icon-remove" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M1.5 1.5l7 7M8.5 1.5l-7 7"></path>
    </svg>
  `;
}

/**
 * @param {{
 *   screen: HTMLElement,
 *   stepRoot: HTMLElement,
 *   scrollRoot: HTMLElement,
 *   backButton: HTMLButtonElement,
 *   progress: HTMLElement,
 *   onComplete: (state: import("./onboarding-api.js").OnboardingState) => void
 * }} options
 */
export function createOnboardingFlow(options) {
  const { screen, stepRoot, scrollRoot, backButton, progress, onComplete } = options;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  /** @type {import("./onboarding-api.js").OnboardingState} */
  const state = {
    name: "",
    gender: null,
    ageRange: null,
    minorConfirmed: false,
    aesthetics: [],
  };

  let step = 0;
  let query = "";
  let started = false;
  let submitting = false;

  function snapshot() {
    return {
      name: state.name.trim(),
      gender: state.gender,
      ageRange: state.ageRange,
      minorConfirmed: state.minorConfirmed,
      aesthetics: [...state.aesthetics],
    };
  }

  function updateChrome() {
    const humanStep = step + 1;
    backButton.disabled = step === 0;
    backButton.setAttribute("aria-hidden", step === 0 ? "true" : "false");
    backButton.tabIndex = step === 0 ? -1 : 0;

    progress.setAttribute("aria-valuenow", String(humanStep));
    progress.setAttribute("aria-label", `Onboarding step ${humanStep} of 4`);
    progress.querySelectorAll(".progress-segment").forEach((segment, index) => {
      segment.classList.toggle("is-filled", index <= step);
    });

    screen.classList.toggle("is-aesthetic", step === 3);
  }

  // No-op: the app resizes to the visual viewport, so a focused field is already
  // above the keyboard. Scrolling it into view is what made the step "jump".
  function keepControlVisible() {}

  function focusStep() {
    window.requestAnimationFrame(() => {
      if (step === 0) {
        const input = stepRoot.querySelector("#nameInput");
        input?.focus({ preventScroll: true });
        if (input) keepControlVisible(input);
        return;
      }

      stepRoot.querySelector(".step-headline")?.focus({ preventScroll: true });
    });
  }

  function refreshAnimation() {
    stepRoot.classList.remove("is-refreshing");
    void stepRoot.offsetWidth;
    stepRoot.classList.add("is-refreshing");
  }

  function renderName() {
    const valid = state.name.trim().length >= 2;
    stepRoot.innerHTML = `
      <div class="step-view name-step">
        ${headline("nameHeadline", "What should we call you?")}
        ${subhead("This is how Gems talks to you. First name is perfect.")}
        <input
          id="nameInput"
          class="name-input step-entrance${state.name ? " has-value" : ""}"
          style="animation-delay: 300ms"
          type="text"
          autocomplete="given-name"
          enterkeyhint="next"
          maxlength="80"
          placeholder="Your name"
          value="${escapeHtml(state.name)}"
          aria-describedby="nameHint"
        />
        <span id="nameHint" class="sr-only">Enter at least two characters.</span>
        <div class="step-spacer" aria-hidden="true"></div>
        ${primaryButton("nameContinue", valid, "Continue")}
      </div>
    `;

    const input = stepRoot.querySelector("#nameInput");
    const button = stepRoot.querySelector("#nameContinue");

    function sync() {
      state.name = input.value;
      const nowValid = state.name.trim().length >= 2;
      input.classList.toggle("has-value", state.name.length > 0);
      button.disabled = !nowValid;
    }

    input.addEventListener("input", sync);
    input.addEventListener("focus", () => keepControlVisible(input));
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || state.name.trim().length < 2) return;
      event.preventDefault();
      goToStep(1);
    });
    button.addEventListener("click", () => goToStep(1));
  }

  function renderGender() {
    const canContinue = state.gender === "female" || state.gender === "male";
    stepRoot.innerHTML = `
      <div class="step-view gender-step">
        ${headline(
          "genderHeadline",
          `Nice to meet you, ${escapeHtml(firstName(state.name))}.<br />Who are you?`,
        )}
        ${subhead(
          'This shapes your recommendations — poses, aesthetics, and what “your best photo” means for you.',
        )}
        <div class="selection-list">
          ${selectionRow("Female", state.gender === "female", 300)}
          ${selectionRow("Male", state.gender === "male", 380)}
        </div>
        <button
          id="skipGender"
          class="skip-button step-entrance step-fade-only"
          style="animation-delay: 500ms"
          type="button"
        >
          Prefer to skip this
        </button>
        <div class="step-spacer" aria-hidden="true"></div>
        ${primaryButton("genderContinue", canContinue, "Continue")}
      </div>
    `;

    stepRoot.querySelectorAll("[data-selection]").forEach((button) => {
      button.addEventListener("click", () => {
        state.gender = button.dataset.selection.toLowerCase();
        syncGenderSelection();
      });
    });

    stepRoot.querySelector("#skipGender").addEventListener("click", () => {
      state.gender = "unspecified";
      goToStep(2);
    });

    stepRoot.querySelector("#genderContinue").addEventListener("click", () => goToStep(2));

    function syncGenderSelection() {
      stepRoot.querySelectorAll("[data-selection]").forEach((button) => {
        const selected = state.gender === button.dataset.selection.toLowerCase();
        button.classList.toggle("is-selected", selected);
        button.setAttribute("aria-pressed", String(selected));
        button.querySelector(".select-radio").innerHTML = selected ? checkmark() : "";
      });
      stepRoot.querySelector("#genderContinue").disabled = !(
        state.gender === "female" || state.gender === "male"
      );
    }
  }

  function renderAge() {
    stepRoot.innerHTML = `
      <div class="step-view age-step">
        ${headline("ageHeadline", "How old are you?")}
        ${subhead("A range is all we need — no exact birthday.")}
        <div class="selection-list">
          ${AGE_RANGES.map((range, index) =>
            selectionRow(range, state.ageRange === range, 300 + index * 70),
          ).join("")}
        </div>
        <div id="minorGate" class="minor-gate" ${state.ageRange === "Under 18" ? "" : "hidden"}>
          <button
            id="minorConfirm"
            class="select-row minor-confirm${state.minorConfirmed ? " is-selected" : ""}"
            type="button"
            aria-pressed="${state.minorConfirmed}"
          >
            <span>I confirm I'm 13 or older</span>
            <span class="select-radio" aria-hidden="true">${state.minorConfirmed ? checkmark() : ""}</span>
          </button>
          <p class="minor-note">
            Gems is for ages 13 and up. On under-18 accounts we keep extra
            personal details — like your gender pick — off our servers.
          </p>
        </div>
        <div class="step-spacer" aria-hidden="true"></div>
        ${primaryButton("ageContinue", canLeaveAgeStep(), "Continue")}
      </div>
    `;

    // Minors policy: "Under 18" requires an explicit 13+ confirmation, and
    // onboarding-api strips gender (and skips aesthetic analytics) for
    // under-18 accounts (COPPA / app-store rating).
    function canLeaveAgeStep() {
      if (!state.ageRange) return false;
      return state.ageRange !== "Under 18" || state.minorConfirmed;
    }

    stepRoot.querySelectorAll("[data-selection]").forEach((button) => {
      button.addEventListener("click", () => {
        const selectedRange = button.dataset.selection;
        if (state.ageRange !== selectedRange) state.minorConfirmed = false;
        state.ageRange = selectedRange;
        syncAgeSelection();
      });
    });

    stepRoot.querySelector("#minorConfirm").addEventListener("click", () => {
      state.minorConfirmed = !state.minorConfirmed;
      syncAgeSelection();
    });

    stepRoot.querySelector("#ageContinue").addEventListener("click", () => {
      if (canLeaveAgeStep()) goToStep(3);
    });

    function syncAgeSelection() {
      stepRoot.querySelectorAll("[data-selection]").forEach((button) => {
        const selected = state.ageRange === button.dataset.selection;
        button.classList.toggle("is-selected", selected);
        button.setAttribute("aria-pressed", String(selected));
        button.querySelector(".select-radio").innerHTML = selected ? checkmark() : "";
      });
      const gate = stepRoot.querySelector("#minorGate");
      const confirm = stepRoot.querySelector("#minorConfirm");
      gate.hidden = state.ageRange !== "Under 18";
      confirm.classList.toggle("is-selected", state.minorConfirmed);
      confirm.setAttribute("aria-pressed", String(state.minorConfirmed));
      confirm.querySelector(".select-radio").innerHTML = state.minorConfirmed
        ? checkmark()
        : "";
      stepRoot.querySelector("#ageContinue").disabled = !canLeaveAgeStep();
    }
  }

  function getAestheticViewState() {
    const rawQuery = query.trim();
    const normalizedQuery = rawQuery.toLocaleLowerCase();
    const exactLibraryMatch = AESTHETIC_TAGS.some(
      (tag) => tag.toLocaleLowerCase() === normalizedQuery,
    );
    const alreadySelected = state.aesthetics.some(
      (tag) => tag.toLocaleLowerCase() === normalizedQuery,
    );
    const matches = AESTHETIC_TAGS.filter((tag) =>
      tag.toLocaleLowerCase().includes(normalizedQuery),
    );

    return {
      rawQuery,
      matches,
      full: state.aesthetics.length >= MAX_AESTHETICS,
      showAdd: rawQuery.length >= 2 && !exactLibraryMatch && !alreadySelected,
      customPicks: state.aesthetics.filter((tag) => !AESTHETIC_TAGS.includes(tag)),
    };
  }

  function chipMarkup(label, { selected = false, dimmed = false, customAdd = false } = {}) {
    const safeLabel = escapeHtml(label);
    const classes = [
      "vibe-chip",
      selected ? "is-selected" : "",
      dimmed ? "is-dimmed" : "",
      customAdd ? "add-chip" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const dataAttribute = customAdd
      ? "data-add-custom"
      : `data-vibe="${safeLabel}"`;

    return `
      <button
        class="${classes}"
        type="button"
        ${dataAttribute}
        aria-pressed="${selected}"
        aria-disabled="${dimmed}"
      >
        ${customAdd ? plusIcon() : ""}
        <span>${customAdd ? `Add &quot;${safeLabel}&quot;` : safeLabel}</span>
        ${selected ? removeIcon() : ""}
      </button>
    `;
  }

  function renderTagCloud() {
    const view = getAestheticViewState();
    const pieces = [];

    if (view.showAdd) {
      pieces.push(
        chipMarkup(view.rawQuery, {
          customAdd: true,
          dimmed: view.full,
        }),
      );
    }

    view.customPicks.forEach((pick) => {
      pieces.push(chipMarkup(pick, { selected: true }));
    });

    view.matches.forEach((tag) => {
      const selected = state.aesthetics.includes(tag);
      pieces.push(
        chipMarkup(tag, {
          selected,
          dimmed: view.full && !selected,
        }),
      );
    });

    if (view.matches.length === 0 && !view.showAdd) {
      pieces.push(
        '<div class="tag-empty">Nothing matches — keep typing to add it as your own.</div>',
      );
    }

    return pieces.join("");
  }

  function updateAestheticUI() {
    const view = getAestheticViewState();
    const search = stepRoot.querySelector("#aestheticSearch");
    const input = stepRoot.querySelector("#aestheticSearchInput");
    const clear = stepRoot.querySelector("#clearAestheticSearch");
    const counter = stepRoot.querySelector("#aestheticCounter");
    const cloud = stepRoot.querySelector("#tagCloud");
    const continueButton = stepRoot.querySelector("#aestheticContinue");

    search.classList.toggle("has-value", view.rawQuery.length > 0);
    clear.hidden = view.rawQuery.length === 0;
    input.value = query;

    counter.textContent = state.aesthetics.length
      ? `${state.aesthetics.length} of ${MAX_AESTHETICS} picked${
          view.full ? " — that's the max" : ""
        }`
      : "";
    counter.classList.toggle("is-full", view.full);

    cloud.innerHTML = renderTagCloud();
    continueButton.disabled = state.aesthetics.length === 0;
    continueButton.textContent = state.aesthetics.length
      ? `Create my account · ${state.aesthetics.length} picked`
      : "Create my account";

    cloud.querySelectorAll("[data-vibe]").forEach((chip) => {
      chip.addEventListener("click", () => toggleAesthetic(chip.dataset.vibe));
    });

    cloud.querySelector("[data-add-custom]")?.addEventListener("click", addCustomAesthetic);
  }

  function toggleAesthetic(label) {
    if (state.aesthetics.includes(label)) {
      state.aesthetics = state.aesthetics.filter((item) => item !== label);
    } else if (state.aesthetics.length < MAX_AESTHETICS) {
      state.aesthetics = [...state.aesthetics, label];
    }
    updateAestheticUI();
  }

  function addCustomAesthetic() {
    const view = getAestheticViewState();
    if (!view.showAdd || view.full) return;

    const nextSelections = [...state.aesthetics, view.rawQuery];
    state.aesthetics = nextSelections;
    logCustomAesthetic(
      view.rawQuery,
      state.gender,
      state.ageRange,
      [...nextSelections],
    );
    query = "";
    updateAestheticUI();
    stepRoot.querySelector("#aestheticSearchInput")?.focus({ preventScroll: true });
  }

  async function completeOnboarding() {
    if (submitting || state.aesthetics.length === 0) return;
    submitting = true;
    const button = stepRoot.querySelector("#aestheticContinue");
    button.disabled = true;

    try {
      await submitOnboarding(snapshot());
      onComplete(snapshot());
      // The app shell continues from the handoff into authenticated Home.
    } finally {
      submitting = false;
    }
  }

  function renderAesthetic() {
    stepRoot.innerHTML = `
      <div class="step-view aesthetic-step">
        ${headline("aestheticHeadline", "What's your aesthetic?")}
        ${subhead(
          'Pick up to 5, or type your own — Gems learns what “your best photo” looks like from here.',
        )}

        <form id="aestheticSearch" class="aesthetic-search step-entrance" style="animation-delay: 260ms">
          <svg class="search-mark" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="5"></circle>
            <path d="M11 11l3.5 3.5"></path>
          </svg>
          <label class="sr-only" for="aestheticSearchInput">Search aesthetics or add your own</label>
          <input
            id="aestheticSearchInput"
            class="aesthetic-search-input"
            type="search"
            autocomplete="off"
            autocapitalize="words"
            enterkeyhint="done"
            placeholder="Search vibes, or type your own…"
            value="${escapeHtml(query)}"
          />
          <button id="clearAestheticSearch" class="clear-search" type="button" aria-label="Clear search">
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="M2 2l8 8M10 2l-8 8"></path>
            </svg>
          </button>
        </form>

        <div id="aestheticCounter" class="aesthetic-counter" aria-live="polite"></div>
        <div id="tagCloud" class="tag-cloud step-entrance step-fade-only" style="animation-delay: 340ms"></div>
        ${primaryButton("aestheticContinue", state.aesthetics.length > 0, "Create my account")}
      </div>
    `;

    const form = stepRoot.querySelector("#aestheticSearch");
    const input = stepRoot.querySelector("#aestheticSearchInput");

    input.addEventListener("input", () => {
      query = input.value;
      updateAestheticUI();
    });
    input.addEventListener("focus", () => keepControlVisible(input));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      addCustomAesthetic();
    });
    stepRoot.querySelector("#clearAestheticSearch").addEventListener("click", () => {
      query = "";
      updateAestheticUI();
      input.focus({ preventScroll: true });
    });
    stepRoot.querySelector("#aestheticContinue").addEventListener("click", completeOnboarding);

    updateAestheticUI();
  }

  function renderStep({ focus = true } = {}) {
    updateChrome();

    if (step === 0) renderName();
    if (step === 1) renderGender();
    if (step === 2) renderAge();
    if (step === 3) renderAesthetic();

    refreshAnimation();
    if (focus) focusStep();
  }

  function goToStep(nextStep) {
    if (nextStep < 0 || nextStep > 3 || nextStep === step) return;
    step = nextStep;
    scrollRoot.scrollTo({ top: 0, behavior: "auto" });
    renderStep();
  }

  backButton.addEventListener("click", () => {
    if (step > 0) goToStep(step - 1);
  });

  window.visualViewport?.addEventListener("resize", () => {
    const focused = stepRoot.querySelector("input:focus");
    if (focused) keepControlVisible(focused);
  });

  return Object.freeze({
    start(prefill = {}) {
      if (started) return;
      started = true;
      // Prefill the name from an OAuth profile (e.g. Google) so signup is
      // one tap shorter for new users.
      if (typeof prefill.name === "string" && prefill.name.trim()) {
        state.name = prefill.name.trim().slice(0, 80);
      }
      renderStep();
    },
    getState: snapshot,
  });
}
