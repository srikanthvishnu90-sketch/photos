import { appTabBarMarkup, syncActiveTab } from "./app-tabs.js";
import { studioActions } from "./studio-actions.js";
import { getSupabase, getSession } from "./gems-supabase.js";

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

  mount.querySelector("#studioNewProject").addEventListener("click", () => {
    studioActions.createProject();
    void createLiveProject().then((created) => {
      if (!created) status.textContent = "Project creation will open here.";
    });
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
