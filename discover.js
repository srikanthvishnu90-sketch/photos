import { appTabBarMarkup, syncActiveTab } from "./app-tabs.js";
import { discoverActions } from "./discover-actions.js";
import { saveCardToMoodboard } from "./gems-moodboards.js";
import { pinToBoard } from "./gems-board.js";
import { listPhotos } from "./gems-photolib.js";
import { getSession } from "./gems-supabase.js";
import { applyAestheticGrade } from "./gems-style.js";

const CATEGORIES = Object.freeze([
  "For you",
  "Poses",
  "Photo dumps",
  "Euro Summer",
  "Dark Gym",
  "Nightlife",
  "Travel",
  "Fits",
  "Dating",
]);

const CARDS = Object.freeze([
  {
    id: 1,
    height: 200,
    scene: "steps",
    title: "City steps",
    credit: "@marcusfilm",
    categories: ["Poses", "Travel", "Fits"],
  },
  {
    id: 2,
    height: 156,
    scene: "flash",
    title: "Flash at night",
    credit: "@sofia.shoots",
    categories: ["Nightlife", "Photo dumps", "Dating"],
  },
  {
    id: 3,
    height: 168,
    scene: "cafe",
    title: "Café candid",
    credit: "@lena.jpgs",
    categories: ["Photo dumps", "Fits", "Dating"],
  },
  {
    id: 4,
    height: 204,
    scene: "gym",
    title: "Dark gym pump",
    credit: "@dre.lifts",
    categories: ["Dark Gym", "Poses", "Fits"],
  },
  {
    id: 5,
    height: 190,
    scene: "beach",
    title: "Euro coastline",
    credit: "@nikoabroad",
    categories: ["Euro Summer", "Travel", "Photo dumps"],
  },
  {
    id: 6,
    height: 158,
    scene: "sunset",
    title: "Golden silhouette",
    credit: "@ava.golden",
    categories: ["Travel", "Poses", "Dating"],
  },
]);

const CARD_ACTIONS = Object.freeze([
  "Recreate this",
  "Find photos like this in my library",
  "Apply this aesthetic",
  "Save to moodboard",
]);

// Categories that read as a distinct visual GRADE (a "look"), as opposed to
// content/use tags like "Poses" or "Dating". When a card carries one of these
// it becomes the aesthetic we transfer; otherwise the card's own title is a
// perfectly good look descriptor ("Golden silhouette", "Café candid").
const AESTHETIC_LOOKS = Object.freeze([
  "Dark Gym",
  "Euro Summer",
  "Nightlife",
  "Golden Hour",
  "Travel",
]);

// The dominant aesthetic to apply for a card — the first look-category it
// carries, else its human title. Always a non-empty string for a valid card.
function dominantAesthetic(card) {
  try {
    const categories = Array.isArray(card?.categories) ? card.categories : [];
    const look = AESTHETIC_LOOKS.find((label) => categories.includes(label));
    return look || (typeof card?.title === "string" && card.title.trim()) || "this";
  } catch {
    return "this";
  }
}

function sceneMarkup(scene) {
  if (scene === "steps") {
    return `
      <span class="discover-scene discover-scene-steps" aria-hidden="true">
        <i class="steps-line steps-line-one"></i>
        <i class="steps-line steps-line-two"></i>
        <i class="steps-line steps-line-three"></i>
        <i class="steps-head"></i>
        <i class="steps-body"></i>
      </span>
    `;
  }

  if (scene === "flash") {
    return `
      <span class="discover-scene discover-scene-flash" aria-hidden="true">
        <i class="flash-head"></i>
        <i class="flash-body"></i>
      </span>
    `;
  }

  if (scene === "beach") {
    return `
      <span class="discover-scene discover-scene-beach" aria-hidden="true">
        <i class="discover-beach-head"></i>
        <i class="discover-beach-body"></i>
      </span>
    `;
  }

  if (scene === "gym") {
    return `
      <span class="discover-scene discover-scene-gym" aria-hidden="true">
        <i class="discover-gym-bar"></i>
        <i class="discover-gym-head"></i>
        <i class="discover-gym-body"></i>
      </span>
    `;
  }

  if (scene === "cafe") {
    return `
      <span class="discover-scene discover-scene-cafe" aria-hidden="true">
        <i class="cafe-table"></i>
        <i class="cafe-cup"></i>
        <i class="cafe-head"></i>
        <i class="cafe-body"></i>
      </span>
    `;
  }

  return `
    <span class="discover-scene discover-scene-sunset" aria-hidden="true">
      <i class="sunset-sun"></i>
      <i class="sunset-head"></i>
      <i class="sunset-body"></i>
    </span>
  `;
}

function categoryMarkup(activeCategory) {
  return CATEGORIES.map(
    (category, index) => `
      <button
        class="discover-category discover-entrance${category === activeCategory ? " is-active" : ""}"
        type="button"
        data-discover-category="${category}"
        aria-pressed="${category === activeCategory}"
        style="--discover-delay: ${160 + index * 24}ms"
      >
        ${category}
      </button>
    `,
  ).join("");
}

function cardMarkup(card, openCard, index) {
  const open = card.id === openCard;
  return `
    <article
      class="discover-card-item discover-entrance"
      style="--discover-delay: ${230 + index * 45}ms"
    >
      <button
        class="discover-card${open ? " is-open" : ""}"
        type="button"
        data-discover-card="${card.id}"
        aria-expanded="${open}"
        aria-controls="discoverActions${card.id}"
        style="--discover-card-height: ${card.height}px"
      >
        ${sceneMarkup(card.scene)}
        <span class="discover-card-caption">
          <strong>${card.title}</strong>
          <small>${card.credit} · real photo</small>
        </span>
      </button>
      <div
        id="discoverActions${card.id}"
        class="discover-card-actions${open ? " is-visible" : ""}"
        ${open ? "" : "hidden"}
      >
        ${CARD_ACTIONS.map(
          (action, actionIndex) => `
            <button
              class="discover-card-action${actionIndex === 0 ? " is-primary" : ""}"
              type="button"
              data-discover-action="${action}"
              data-discover-card-id="${card.id}"
            >
              ${action}
            </button>
          `,
        ).join("")}
      </div>
    </article>
  `;
}

function discoverMarkup() {
  return `
    <div id="discoverContent" class="discover-content home-scroll">
      <header class="discover-header">
        <h1 id="discoverTitle" class="discover-title discover-entrance" tabindex="-1">Discover</h1>
        <p class="discover-subtitle discover-entrance">Looks to recreate with your own photos.</p>

        <label class="discover-search discover-entrance" for="discoverSearch">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="5"></circle>
            <path d="M11 11l3.5 3.5"></path>
          </svg>
          <span class="sr-only">Search Discover</span>
          <input
            id="discoverSearch"
            type="search"
            autocomplete="off"
            enterkeyhint="search"
            placeholder="What do you want inspiration for?"
          />
        </label>
      </header>

      <div id="discoverCategories" class="discover-categories home-scroll" aria-label="Discover categories">
        ${categoryMarkup("For you")}
      </div>

      <div id="discoverGrid" class="discover-grid" aria-live="polite"></div>
      <p id="discoverStatus" class="sr-only" aria-live="polite"></p>
    </div>

    <div class="discover-bottom-chrome">
      ${appTabBarMarkup("Discover")}
    </div>
  `;
}

/**
 * @param {{screen: HTMLElement, mount: HTMLElement, onNavigate?: (tab: string) => void}} options
 */
export function createDiscoverScreen({ screen, mount, onNavigate = () => {} }) {
  mount.innerHTML = discoverMarkup();

  const content = mount.querySelector("#discoverContent");
  const title = mount.querySelector("#discoverTitle");
  const search = mount.querySelector("#discoverSearch");
  const searchShell = mount.querySelector(".discover-search");
  const categories = mount.querySelector("#discoverCategories");
  const grid = mount.querySelector("#discoverGrid");
  const status = mount.querySelector("#discoverStatus");
  let query = "";
  let activeCategory = "For you";
  let openCard = null;
  let activated = false;

  function matchingCards() {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return CARDS.filter((card) => {
      const matchesCategory =
        activeCategory === "For you" || card.categories.includes(activeCategory);
      const searchable = [card.title, card.credit, ...card.categories]
        .join(" ")
        .toLocaleLowerCase();
      return matchesCategory && (!normalizedQuery || searchable.includes(normalizedQuery));
    });
  }

  function renderGrid({ focusCard = null } = {}) {
    const matches = matchingCards();
    if (openCard && !matches.some((card) => card.id === openCard)) openCard = null;

    if (matches.length === 0) {
      grid.innerHTML = `
        <div class="discover-empty">
          <strong>No gems here yet.</strong>
          <span>Try another search or category.</span>
        </div>
      `;
    } else {
      const left = matches.filter((card) => card.id % 2 === 1);
      const right = matches.filter((card) => card.id % 2 === 0);
      grid.innerHTML = `
        <div class="discover-column">
          ${left.map((card, index) => cardMarkup(card, openCard, index * 2)).join("")}
        </div>
        <div class="discover-column discover-column-offset">
          ${right.map((card, index) => cardMarkup(card, openCard, index * 2 + 1)).join("")}
        </div>
      `;
    }

    status.textContent = `${matches.length} inspiration photo${matches.length === 1 ? "" : "s"} shown`;

    grid.querySelectorAll("[data-discover-card]").forEach((button) => {
      button.addEventListener("click", () => {
        const cardId = Number(button.dataset.discoverCard);
        openCard = openCard === cardId ? null : cardId;
        renderGrid({ focusCard: cardId });
      });
    });

    grid.querySelectorAll("[data-discover-action]").forEach((button) => {
      button.addEventListener("click", () => {
        const card = CARDS.find(
          (candidate) => candidate.id === Number(button.dataset.discoverCardId),
        );
        if (!card) return;
        discoverActions.runCardAction(button.dataset.discoverAction, card);
        if (button.dataset.discoverAction === "Apply this aesthetic") {
          applyAestheticToBestPhoto(card);
        }
        if (button.dataset.discoverAction === "Save to moodboard") {
          // Pin to the on-device board (works signed-out) AND sync to Supabase.
          void pinToBoard({
            cardId: card.id,
            scene: card.scene,
            title: card.title ?? card.name ?? null,
            credit: card.credit ?? null,
            categories: card.categories ?? [],
          });
          saveCardToMoodboard(card).then((result) => {
            if (result?.saved || result?.duplicate) {
              status.textContent = "Saved to your board.";
            } else {
              // Local pin still succeeded even when signed out.
              status.textContent = "Saved to your board.";
            }
          });
        }
      });
    });

    if (focusCard !== null) {
      window.requestAnimationFrame(() => {
        grid
          .querySelector(`[data-discover-card="${focusCard}"]`)
          ?.focus({ preventScroll: true });
      });
    }
  }

  // "Apply this aesthetic" = take THIS card's look and regrade one of MY
  // photos with it. Real flow: require a signed-in session and a library, pick
  // the user's top-quality photo as the target, and run the style edit. Status
  // is narrated in the #discoverStatus aria-live region (textContent, so any
  // interpolated label is inherently escaped).
  let applyingAesthetic = false;
  async function applyAestheticToBestPhoto(card) {
    if (applyingAesthetic) return;
    applyingAesthetic = true;
    const aesthetic = dominantAesthetic(card);
    try {
      const [session, library] = await Promise.all([getSession(), listPhotos()]);
      const photos = Array.isArray(library) ? library : [];
      if (!session || photos.length === 0) {
        status.textContent = "Sign in and import photos to apply aesthetics.";
        return;
      }
      const best = [...photos].sort(
        (a, b) => (b.metrics?.quality ?? 0) - (a.metrics?.quality ?? 0),
      )[0];
      if (!best?.id) {
        status.textContent = "Sign in and import photos to apply aesthetics.";
        return;
      }

      status.textContent = `Applying ${aesthetic} to your best photo…`;
      const result = await applyAestheticGrade({
        targetPhotoId: best.id,
        aesthetic,
      });

      if (result?.url) {
        status.textContent = "Your styled photo is ready.";
      } else if (result?.paywall || result?.error === "cap") {
        status.textContent = "You've hit your free edit limit — Gems Plus unlocks more.";
      } else if (result?.quota || result?.error === "quota") {
        status.textContent = "The styling model is warming up — try again soon.";
      } else {
        status.textContent = "That styling didn't go through — try again.";
      }
    } catch (error) {
      console.info("Apply aesthetic failed", error);
      status.textContent = "That styling didn't go through — try again.";
    } finally {
      applyingAesthetic = false;
    }
  }

  function selectCategory(category) {
    activeCategory = category;
    openCard = null;
    categories.querySelectorAll("[data-discover-category]").forEach((button) => {
      const active = button.dataset.discoverCategory === category;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    discoverActions.chooseCategory(category);
    renderGrid();
  }

  categories.querySelectorAll("[data-discover-category]").forEach((button) => {
    button.addEventListener("click", () => selectCategory(button.dataset.discoverCategory));
  });

  search.addEventListener("input", () => {
    query = search.value;
    openCard = null;
    searchShell.classList.toggle("has-value", query.length > 0);
    renderGrid();
  });

  search.addEventListener("search", () => {
    query = search.value;
    searchShell.classList.toggle("has-value", query.length > 0);
    discoverActions.search(query.trim());
    renderGrid();
  });

  mount.querySelectorAll("[data-app-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      const tab = button.dataset.appTab;
      if (tab === "Home" || tab === "Photos" || tab === "Studio" || tab === "Profile") {
        onNavigate(tab);
        return;
      }
      if (tab === "Discover") {
        syncActiveTab(mount, "Discover");
        return;
      }
      discoverActions.selectTab(tab);
    });
  });

  renderGrid();

  return Object.freeze({
    activate() {
      syncActiveTab(mount, "Discover");
      if (activated) return;
      activated = true;
      content.scrollTo({ top: 0, behavior: "auto" });
      screen.classList.remove("is-entering");
      void screen.offsetWidth;
      screen.classList.add("is-entering");
      window.setTimeout(() => screen.classList.remove("is-entering"), 900);
    },

    resume() {
      syncActiveTab(mount, "Discover");
    },

    focusHeading() {
      title.focus({ preventScroll: true });
    },
  });
}
