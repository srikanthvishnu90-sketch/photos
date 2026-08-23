import { appTabBarMarkup, syncActiveTab } from "./app-tabs.js";
import { studioActions } from "./studio-actions.js";
import { getSupabase, getSession } from "./gems-supabase.js";
import { fetchMoodboardCounts } from "./gems-moodboards.js";
import { DUMP_STYLES, buildDumpOptions, reviseDump } from "./gems-dump.js";

// Small HTML escaper for user-controlled text (requests, revision notes) that
// lands in innerHTML template strings.
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) =>
    char === "&"
      ? "&amp;"
      : char === "<"
        ? "&lt;"
        : char === ">"
          ? "&gt;"
          : char === '"'
            ? "&quot;"
            : "&#39;",
  );
}

// The two visual questions that precede a build. Vibe chips fall back to the
// DUMP_STYLES labels when the user has no saved aesthetics.
const DUMP_RANGES = Object.freeze([
  { key: "all", label: "All time" },
  { key: "month", label: "This month" },
  { key: "summer", label: "This summer" },
  { key: "year", label: "This year" },
]);

// Resolve a range key to {startMs,endMs} (or null for "all"), computed from the
// current clock so the chips stay honest as time passes.
function dumpDateRange(key) {
  const now = new Date();
  const endMs = Date.now();
  if (key === "month") {
    return { startMs: new Date(now.getFullYear(), now.getMonth(), 1).getTime(), endMs };
  }
  if (key === "year") {
    return { startMs: new Date(now.getFullYear(), 0, 1).getTime(), endMs };
  }
  if (key === "summer") {
    // Northern-hemisphere summer: June 1 → Aug 31 of the current year.
    return {
      startMs: new Date(now.getFullYear(), 5, 1).getTime(),
      endMs: new Date(now.getFullYear(), 8, 1).getTime() - 1,
    };
  }
  return null;
}

const KIND_TO_TYPE = Object.freeze({
  dump: "Dumps",
  edit: "Edits",
  template: "Dumps",
  moodboard: "Moodboards",
});

const STATUS_LABEL = Object.freeze({
  draft: "Draft",
  exported: "Exported",
  archived: "Archived",
});

function sceneForProject(row) {
  const hint = `${row.aesthetic ?? ""} ${row.kind}`.toLowerCase();
  if (hint.includes("gym")) return "gym";
  if (hint.includes("night") || hint.includes("concert")) return "night";
  if (hint.includes("golden")) return "golden";
  if (hint.includes("city") || hint.includes("downtown")) return "city";
  if (hint.includes("euro") || hint.includes("beach") || hint.includes("summer") || hint.includes("coastal"))
    return "beach";
  return "cafe";
}

function projectFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    meta: row.aesthetic ?? KIND_TO_TYPE[row.kind] ?? "Project",
    status: STATUS_LABEL[row.status] ?? "Draft",
    type: KIND_TO_TYPE[row.kind] ?? "Dumps",
    scenes: [sceneForProject(row)],
  };
}

const FILTERS = Object.freeze(["All", "Dumps", "Edits", "Templates", "Moodboards"]);

const PROJECTS = Object.freeze([
  {
    id: 1,
    name: "Summer Dump",
    meta: "12 photos · Euro Summer",
    status: "Draft",
    type: "Dumps",
    scenes: ["beach", "golden", "cafe"],
  },
  {
    id: 2,
    name: "Ship Removed",
    meta: "1 photo · 3 versions",
    status: "Exported",
    type: "Edits",
    scenes: ["beach"],
  },
  {
    id: 3,
    name: "Saturday Night",
    meta: "9 photos · Nightlife Flash",
    status: "Exported",
    type: "Dumps",
    scenes: ["night", "city"],
  },
  {
    id: 4,
    name: "Gym Arc",
    meta: "6 photos · Dark Gym",
    status: "Draft",
    type: "Dumps",
    scenes: ["gym", "city"],
  },
]);

const TEMPLATES = Object.freeze([
  {
    name: "College Commitment",
    sublabel: "Your photo + school colors",
    scene: "gym",
    tone: "dark",
  },
  {
    name: "Grad Carousel",
    sublabel: "Cap, gown, four years",
    scene: "golden",
    tone: "dark",
  },
  {
    name: "Dating Profile Set",
    sublabel: "Six photos, right order",
    scene: "cafe",
    tone: "light",
  },
  {
    name: "Travel Recap",
    sublabel: "One trip, one story",
    scene: "beach",
    tone: "light",
  },
  {
    name: "Game Day",
    sublabel: "Action shot graphic",
    scene: "night",
    tone: "dark",
  },
]);

function stackMarkup(scenes) {
  return `
    <span class="studio-stack${scenes.length === 1 ? " is-single" : ""}" aria-hidden="true">
      ${scenes
        .slice(0, 3)
        .map((scene) => `<i class="studio-stack-card studio-scene-${scene}"></i>`)
        .join("")}
    </span>
  `;
}

function projectMarkup(project, index) {
  return `
    <button
      class="studio-project studio-entrance"
      type="button"
      data-studio-project="${project.id}"
      aria-label="Open ${project.name}, ${project.status}"
      style="--studio-delay: ${350 + index * 45}ms"
    >
      <span class="studio-project-topline">
        ${stackMarkup(project.scenes)}
        <span class="studio-status${project.status === "Draft" ? " is-draft" : ""}">${project.status}</span>
      </span>
      <span class="studio-project-copy">
        <strong>${project.name}</strong>
        <small>${project.meta}</small>
      </span>
    </button>
  `;
}

function templateMarkup(template, index) {
  return `
    <button
      class="studio-template studio-scene-${template.scene} is-${template.tone} studio-entrance"
      type="button"
      data-studio-template="${template.name}"
      style="--studio-delay: ${520 + index * 40}ms"
    >
      <span class="studio-template-overlay">
        <strong>${template.name}</strong>
        <small>${template.sublabel}</small>
      </span>
    </button>
  `;
}

function studioMarkup() {
  return `
    <div id="studioContent" class="studio-content home-scroll">
      <header class="studio-header">
        <h1 id="studioTitle" class="studio-title studio-entrance" tabindex="-1">Studio</h1>
        <button id="studioNewProject" class="studio-new-project studio-entrance" type="button">
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M6 1v10M1 6h10"></path>
          </svg>
          <span>New project</span>
        </button>
      </header>

      <div id="studioFilters" class="studio-filters home-scroll" aria-label="Filter Studio projects">
        ${FILTERS.map(
          (filter, index) => `
            <button
              class="studio-filter studio-entrance${filter === "All" ? " is-active" : ""}"
              type="button"
              data-studio-filter="${filter}"
              aria-pressed="${filter === "All"}"
              style="--studio-delay: ${120 + index * 30}ms"
            >
              ${filter}
            </button>
          `,
        ).join("")}
      </div>

      <section id="studioHero" class="studio-hero-section" aria-label="Continue your latest draft">
        <button id="studioContinueDraft" class="studio-hero studio-scene-beach studio-entrance" type="button">
          <span class="studio-hero-overlay">
            <span class="studio-hero-kicker">Draft · picks up where you left off</span>
            <span class="studio-hero-row">
              <span class="studio-hero-copy">
                <strong>Summer Dump</strong>
                <small>8 of 12 photos · Euro Summer · edited today</small>
              </span>
              <span class="studio-hero-action">Continue</span>
            </span>
          </span>
        </button>
      </section>

      <section id="studioProjectsSection" class="studio-section" aria-labelledby="studioProjectsTitle">
        <h2 id="studioProjectsTitle" class="studio-section-title studio-entrance">Your projects</h2>
        <div id="studioProjectsGrid" class="studio-projects"></div>
        <div id="studioEmpty" class="studio-empty" hidden>
          <span class="studio-empty-mark" aria-hidden="true">
            <svg viewBox="0 0 22 22">
              <rect x="3" y="3" width="7" height="9" rx="2"></rect>
              <rect x="12" y="3" width="7" height="5.5" rx="2"></rect>
              <rect x="12" y="10.5" width="7" height="8.5" rx="2"></rect>
              <rect x="3" y="14" width="7" height="5" rx="2"></rect>
            </svg>
          </span>
          <strong>No moodboards yet</strong>
          <span>Save inspiration from Discover to start one.</span>
        </div>
      </section>

      <section id="studioTemplatesSection" class="studio-templates-section" aria-labelledby="studioTemplatesTitle">
        <h2 id="studioTemplatesTitle" class="studio-section-title studio-entrance">Start from a template</h2>
        <div class="studio-templates home-scroll">
          ${TEMPLATES.map(templateMarkup).join("")}
        </div>
      </section>
      <div class="studio-scroll-tail" aria-hidden="true"></div>
    </div>

    <div class="studio-bottom-chrome">
      ${appTabBarMarkup("Studio")}
    </div>
    <p id="studioStatus" class="sr-only" aria-live="polite"></p>

    <div id="studioDump" class="studio-dump" hidden>
      <div class="studio-dump-scrim" data-dump-close></div>
      <section
        class="studio-dump-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="studioDumpTitle"
      >
        <header class="studio-dump-head">
          <div class="studio-dump-head-copy">
            <h2 id="studioDumpTitle" class="studio-dump-title" tabindex="-1">Make a photo dump</h2>
            <p id="studioDumpRequest" class="studio-dump-sub"></p>
          </div>
          <button class="studio-dump-close" type="button" data-dump-close aria-label="Close">
            <svg viewBox="0 0 14 14" aria-hidden="true">
              <path d="M1 1l12 12M13 1L1 13"></path>
            </svg>
          </button>
        </header>
        <div id="studioDumpBody" class="studio-dump-body"></div>
      </section>
    </div>
  `;
}

/**
 * @param {{screen: HTMLElement, mount: HTMLElement, onNavigate?: (tab: string, payload?: object) => void}} options
 */
export function createStudioScreen({ screen, mount, onNavigate = () => {} }) {
  mount.innerHTML = studioMarkup();

  const content = mount.querySelector("#studioContent");
  const title = mount.querySelector("#studioTitle");
  const filters = mount.querySelector("#studioFilters");
  const hero = mount.querySelector("#studioHero");
  const projectsSection = mount.querySelector("#studioProjectsSection");
  const projectsTitle = mount.querySelector("#studioProjectsTitle");
  const projectsGrid = mount.querySelector("#studioProjectsGrid");
  const empty = mount.querySelector("#studioEmpty");
  const templatesSection = mount.querySelector("#studioTemplatesSection");
  const status = mount.querySelector("#studioStatus");
  const dump = mount.querySelector("#studioDump");
  const dumpTitle = mount.querySelector("#studioDumpTitle");
  const dumpRequestEl = mount.querySelector("#studioDumpRequest");
  const dumpBody = mount.querySelector("#studioDumpBody");
  let activeFilter = "All";
  let activated = false;
  // Demo projects until a signed-in user's real rows load from Supabase.
  let projects = [...PROJECTS];
  let usingLive = false;

  function visibleProjects() {
    if (activeFilter === "All") return projects;
    return projects.filter((project) => project.type === activeFilter);
  }

  function bindProjectButtons() {
    projectsGrid.querySelectorAll("[data-studio-project]").forEach((button) => {
      button.addEventListener("click", () => {
        const project = projects.find(
          (item) => String(item.id) === button.dataset.studioProject,
        );
        if (!project) return;
        studioActions.openProject(project);
        status.textContent = `${project.name} is ready to open when project storage is connected.`;
      });
    });
  }

  async function loadProjects() {
    try {
      const supabase = await getSupabase();
      const session = await getSession();
      if (!supabase || !session) return;
      const { data, error } = await supabase
        .from("projects")
        .select("id, kind, name, status, aesthetic, updated_at")
        .eq("profile_id", session.user.id)
        .neq("status", "archived")
        .order("updated_at", { ascending: false })
        .limit(40);
      if (error || !data?.length) return;
      projects = data.map(projectFromRow);
      try {
        const counts = await fetchMoodboardCounts();
        data.forEach((row, index) => {
          if (row.kind !== "moodboard") return;
          const count =
            (counts instanceof Map ? counts.get(row.id) : counts?.[row.id]) ?? 0;
          projects[index].meta = `${count} saved`;
        });
      } catch (error) {
        console.info("Moodboard counts stayed unavailable", error);
      }
      usingLive = true;
      renderFilter();
    } catch (error) {
      console.info("Studio stayed in demo mode", error);
    }
  }

  async function createLiveProject() {
    try {
      const supabase = await getSupabase();
      const session = await getSession();
      if (!supabase || !session) return false;
      const { error } = await supabase
        .from("projects")
        .insert({ profile_id: session.user.id, kind: "dump", name: "Untitled" });
      if (error) return false;
      status.textContent = "Untitled draft created.";
      await loadProjects();
      return true;
    } catch (error) {
      console.info("Project creation stayed in demo mode", error);
      return false;
    }
  }

  function renderFilter() {
    const projects = visibleProjects();
    const templateOnly = activeFilter === "Templates";
    const moodboards = activeFilter === "Moodboards";

    filters.querySelectorAll("[data-studio-filter]").forEach((button) => {
      const active = button.dataset.studioFilter === activeFilter;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });

    // The hero card narrates the hardcoded demo draft; hide it once real rows load.
    hero.hidden = usingLive || (activeFilter !== "All" && activeFilter !== "Dumps");
    projectsSection.hidden = templateOnly;
    templatesSection.hidden = activeFilter !== "All" && !templateOnly;
    projectsTitle.textContent =
      activeFilter === "Edits"
        ? "Your edits"
        : moodboards
          ? "Moodboards"
          : "Your projects";
    projectsGrid.innerHTML = projects.map(projectMarkup).join("");
    projectsGrid.hidden = projects.length === 0;
    empty.hidden = !moodboards || projects.length > 0;
    bindProjectButtons();

    const resultLabel = templateOnly
      ? `${TEMPLATES.length} templates`
      : moodboards
        ? "No moodboards yet"
        : `${projects.length} ${projects.length === 1 ? "project" : "projects"}`;
    status.textContent = `${activeFilter}: ${resultLabel}.`;
  }

  filters.querySelectorAll("[data-studio-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      activeFilter = button.dataset.studioFilter;
      studioActions.chooseFilter(activeFilter);
      renderFilter();
    });
  });

  // -------------------------------------------------------------------------
  // Make-me-a-photo-dump flow (docs/MASTER-FEATURES.md #10)
  // -------------------------------------------------------------------------
  let dumpRequest = "a photo dump";
  let dumpVibe = null; // chip label or null (skipped)
  let dumpRangeKey = "all";
  let dumpOptionsData = []; // built options
  let dumpSelected = null; // currently open option
  let dumpLastFocus = null;

  async function loadDumpVibes() {
    try {
      const supabase = await getSupabase();
      const session = await getSession();
      if (!supabase || !session) return [];
      const { data } = await supabase
        .from("profile_aesthetics")
        .select("label")
        .eq("profile_id", session.user.id)
        .order("position")
        .limit(5);
      return (data ?? []).map((row) => row?.label).filter(Boolean);
    } catch (error) {
      console.info("Dump vibe chips fell back to presets", error);
      return [];
    }
  }

  function photoStack(photos, limit) {
    const shown = photos.slice(0, limit);
    if (!shown.length) {
      return `<span class="studio-dump-stack is-empty" aria-hidden="true"></span>`;
    }
    return `
      <span class="studio-dump-stack" aria-hidden="true">
        ${shown
          .map((photo, index) =>
            photo?.url
              ? `<i class="studio-dump-chip" style="--i:${index}; background-image:url('${encodeURI(photo.url)}')"></i>`
              : `<i class="studio-dump-chip is-blank" style="--i:${index}"></i>`,
          )
          .join("")}
      </span>
    `;
  }

  function renderDumpQuestions(vibes) {
    const vibeChips = vibes.length ? vibes : DUMP_STYLES.map((style) => style.label);
    dumpBody.innerHTML = `
      <div class="studio-dump-questions">
        <div class="studio-dump-q">
          <span class="studio-dump-q-label">What's the vibe?</span>
          <div class="studio-dump-chips" data-dump-vibes>
            ${vibeChips
              .slice(0, 5)
              .map(
                (label) => `
                  <button class="studio-dump-pick${dumpVibe === label ? " is-active" : ""}" type="button"
                    data-dump-vibe="${escapeHtml(label)}" aria-pressed="${dumpVibe === label}">
                    ${escapeHtml(label)}
                  </button>
                `,
              )
              .join("")}
          </div>
        </div>
        <div class="studio-dump-q">
          <span class="studio-dump-q-label">From when?</span>
          <div class="studio-dump-chips" data-dump-ranges>
            ${DUMP_RANGES.map(
              (range) => `
                <button class="studio-dump-pick${dumpRangeKey === range.key ? " is-active" : ""}" type="button"
                  data-dump-range="${range.key}" aria-pressed="${dumpRangeKey === range.key}">
                  ${escapeHtml(range.label)}
                </button>
              `,
            ).join("")}
          </div>
        </div>
        <button id="studioDumpBuild" class="studio-dump-build" type="button">Build my dump</button>
        <p class="studio-dump-hint">Both are optional — skip and I'll read the whole library.</p>
      </div>
    `;

    dumpBody.querySelectorAll("[data-dump-vibe]").forEach((button) => {
      button.addEventListener("click", () => {
        const label = button.dataset.dumpVibe;
        dumpVibe = dumpVibe === label ? null : label;
        renderDumpQuestions(vibes);
      });
    });
    dumpBody.querySelectorAll("[data-dump-range]").forEach((button) => {
      button.addEventListener("click", () => {
        dumpRangeKey = button.dataset.dumpRange;
        renderDumpQuestions(vibes);
      });
    });
    dumpBody.querySelector("#studioDumpBuild").addEventListener("click", () => {
      void runDumpBuild();
    });
  }

  function renderDumpLoading() {
    dumpBody.innerHTML = `
      <div class="studio-dump-loading">
        <span class="studio-dump-spinner" aria-hidden="true"></span>
        <span>Reading your library and assembling three sets…</span>
      </div>
    `;
    status.textContent = "Building your photo dump.";
  }

  function renderDumpEmpty() {
    dumpBody.innerHTML = `
      <div class="studio-dump-empty">
        <strong>No photos to pull from yet</strong>
        <span>Import photos first to build a dump.</span>
      </div>
    `;
    status.textContent = "Import photos first to build a dump.";
  }

  function renderDumpOptions() {
    dumpBody.innerHTML = `
      <div class="studio-dump-options">
        <p class="studio-dump-step">Three complete sets. Pick the one that feels like you.</p>
        <div class="studio-dump-cards">
          ${dumpOptionsData
            .map(
              (option, index) => `
                <button class="studio-dump-card" type="button" data-dump-option="${index}">
                  ${photoStack(option.photos, 4)}
                  <span class="studio-dump-card-copy">
                    <strong>${escapeHtml(option.label)}</strong>
                    <small>${escapeHtml(option.sublabel)}</small>
                    <em>${option.count} photos</em>
                  </span>
                </button>
              `,
            )
            .join("")}
        </div>
      </div>
    `;
    dumpBody.querySelectorAll("[data-dump-option]").forEach((button) => {
      button.addEventListener("click", () => {
        const option = dumpOptionsData[Number(button.dataset.dumpOption)];
        if (!option) return;
        dumpSelected = option;
        renderDumpSet();
      });
    });
    status.textContent = `Three dumps ready for "${dumpRequest}".`;
  }

  function renderDumpSet(note) {
    const option = dumpSelected;
    if (!option) return;
    dumpBody.innerHTML = `
      <div class="studio-dump-set">
        <div class="studio-dump-set-head">
          <button class="studio-dump-back" type="button" data-dump-back>‹ Options</button>
          <span class="studio-dump-set-label">${escapeHtml(option.label)} · ${option.count} photos</span>
        </div>
        <div class="studio-dump-grid">
          ${option.photos
            .map(
              (photo, index) => `
                <span class="studio-dump-slot">
                  <span class="studio-dump-slot-frame">
                    ${
                      photo?.url
                        ? `<img src="${encodeURI(photo.url)}" alt="" loading="lazy" />`
                        : `<span class="studio-dump-slot-blank" aria-hidden="true"></span>`
                    }
                  </span>
                  <span class="studio-dump-slot-no">${String(index + 1).padStart(2, "0")}</span>
                </span>
              `,
            )
            .join("")}
        </div>
        ${note ? `<p class="studio-dump-note">${escapeHtml(note)}</p>` : ""}
        <form class="studio-dump-revise" data-dump-revise>
          <input class="studio-dump-input" type="text" name="revision"
            placeholder="more friends · replace slide 6" autocomplete="off" />
          <button class="studio-dump-revise-go" type="submit">Revise</button>
        </form>
        <button id="studioDumpSave" class="studio-dump-build" type="button">Save to Studio</button>
      </div>
    `;

    dumpBody.querySelector("[data-dump-back]").addEventListener("click", () => {
      renderDumpOptions();
    });
    dumpBody.querySelector("[data-dump-revise]").addEventListener("submit", (event) => {
      event.preventDefault();
      const input = event.currentTarget.querySelector("input[name='revision']");
      const instruction = input?.value ?? "";
      if (!instruction.trim()) return;
      void applyDumpRevision(instruction);
    });
    dumpBody.querySelector("#studioDumpSave").addEventListener("click", () => {
      void saveDumpSet();
    });
    if (note) status.textContent = note;
  }

  async function applyDumpRevision(instruction) {
    if (!dumpSelected) return;
    try {
      const revised = await reviseDump(dumpSelected, instruction);
      // Keep the revised option in the options list so "Options" stays in sync.
      const index = dumpOptionsData.findIndex((option) => option.key === revised.key);
      if (index !== -1) dumpOptionsData[index] = revised;
      dumpSelected = revised;
      renderDumpSet(revised.note);
    } catch (error) {
      console.info("Dump revision skipped", error);
    }
  }

  async function saveDumpSet() {
    const option = dumpSelected;
    if (!option) return;
    try {
      const supabase = await getSupabase();
      const session = await getSession();
      if (!supabase || !session) {
        status.textContent = "Sign in to save this dump to Studio.";
        return;
      }
      const { error } = await supabase.from("projects").insert({
        profile_id: session.user.id,
        kind: "dump",
        name: dumpRequest.slice(0, 80),
        aesthetic: dumpVibe ?? option.label,
        meta: { style: option.key, count: option.count },
      });
      if (error) {
        status.textContent = "Couldn't save the dump just now.";
        return;
      }
      studioActions.createProject();
      status.textContent = `Saved "${dumpRequest}" to Studio.`;
      closeDumpFlow();
      await loadProjects();
    } catch (error) {
      console.info("Dump save stayed local", error);
      status.textContent = "Couldn't save the dump just now.";
    }
  }

  async function runDumpBuild() {
    renderDumpLoading();
    try {
      const dateRange = dumpDateRange(dumpRangeKey);
      const request = dumpVibe ? `${dumpRequest} — ${dumpVibe}` : dumpRequest;
      const result = await buildDumpOptions({ request, dateRange });
      dumpOptionsData = result.options ?? [];
      if (!dumpOptionsData.length) {
        renderDumpEmpty();
        return;
      }
      renderDumpOptions();
    } catch (error) {
      console.info("Dump build failed", error);
      renderDumpEmpty();
    }
  }

  async function openDumpFlow(request) {
    dumpRequest = String(request ?? "").trim() || "a photo dump";
    dumpVibe = null;
    dumpRangeKey = "all";
    dumpOptionsData = [];
    dumpSelected = null;
    dumpLastFocus = document.activeElement;
    dumpRequestEl.textContent = `“${dumpRequest}”`;
    dump.hidden = false;
    document.body.classList.add("studio-dump-open");
    renderDumpLoading();
    const vibes = await loadDumpVibes();
    renderDumpQuestions(vibes);
    dumpTitle.focus({ preventScroll: true });
    studioActions.createProject();
  }

  function closeDumpFlow() {
    if (dump.hidden) return;
    dump.hidden = true;
    document.body.classList.remove("studio-dump-open");
    dumpBody.innerHTML = "";
    if (dumpLastFocus && typeof dumpLastFocus.focus === "function") {
      try {
        dumpLastFocus.focus({ preventScroll: true });
      } catch {
        // ignore
      }
    }
  }

  dump.querySelectorAll("[data-dump-close]").forEach((element) => {
    element.addEventListener("click", closeDumpFlow);
  });
  dump.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDumpFlow();
  });

  mount.querySelector("#studioNewProject").addEventListener("click", () => {
    void openDumpFlow("a photo dump");
  });

  mount.querySelector("#studioContinueDraft").addEventListener("click", () => {
    const project = projects[0];
    if (!project) return;
    studioActions.openProject(project);
    status.textContent = `${project.name} is ready to open when project storage is connected.`;
  });

  mount.querySelectorAll("[data-studio-template]").forEach((button) => {
    button.addEventListener("click", () => {
      const template = TEMPLATES.find((item) => item.name === button.dataset.studioTemplate);
      if (!template) return;
      studioActions.startTemplate(template);
      status.textContent = `${template.name} will start a new project.`;
    });
  });

  mount.querySelectorAll("[data-app-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      const tab = button.dataset.appTab;
      studioActions.selectTab(tab);
      if (tab === "Home" || tab === "Discover" || tab === "Photos" || tab === "Profile") {
        onNavigate(tab);
        return;
      }
      if (tab === "Studio") syncActiveTab(mount, "Studio");
    });
  });

  renderFilter();

  return Object.freeze({
    activate(payload = {}) {
      syncActiveTab(mount, "Studio");
      void loadProjects();
      if (payload.projectId) {
        const project = projects.find(
          (item) => String(item.id) === String(payload.projectId),
        );
        if (project) status.textContent = `${project.name} is your most recent draft.`;
      }
      // Chat "build a dump" hand-off arrives as payload.request → open the flow
      // pre-filled with that request.
      if (payload.request) {
        void openDumpFlow(payload.request);
      }
      if (activated) return;
      activated = true;
      content.scrollTo({ top: 0, behavior: "auto" });
      screen.classList.remove("is-entering");
      void screen.offsetWidth;
      screen.classList.add("is-entering");
      window.setTimeout(() => screen.classList.remove("is-entering"), 900);
    },

    focusHeading() {
      title.focus({ preventScroll: true });
    },

    deactivate() {},
  });
}
