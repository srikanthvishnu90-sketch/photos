import { appTabBarMarkup, syncActiveTab } from "./app-tabs.js";
import { photosActions } from "./photos-actions.js";
import { describePhoto, importPhotoFiles, listPhotos } from "./gems-photolib.js";

const SEARCH_HINTS = Object.freeze([
  "best of me last summer",
  "everyone smiling",
  "photos I never posted",
  "clear jersey shots",
]);

const PHOTOS = Object.freeze([
  {
    id: 1,
    scene: "portrait",
    label: "Golden-hour portrait",
    gem: true,
    keywords: "best me summer golden cover portrait never posted dating",
  },
  {
    id: 2,
    scene: "flash",
    label: "Nightlife flash",
    gem: false,
    keywords: "everyone smiling friends nightlife flash party",
  },
  {
    id: 3,
    scene: "beach",
    label: "Beach day",
    gem: false,
    keywords: "best me summer everyone smiling friends beach euro travel",
  },
  {
    id: 4,
    scene: "gym",
    label: "Dark gym portrait",
    gem: true,
    keywords: "clear jersey shots gym sport worth editing best",
  },
  {
    id: 5,
    scene: "city",
    label: "City candid",
    gem: false,
    keywords: "never posted city candid dating street",
  },
  {
    id: 6,
    scene: "sunset",
    label: "Sunset silhouette",
    gem: true,
    keywords: "best me summer sunset dating travel golden",
  },
  {
    id: 7,
    scene: "cafe",
    label: "Café with friends",
    gem: false,
    keywords: "everyone smiling friends cafe candid",
  },
  {
    id: 8,
    scene: "y2k",
    label: "Y2K portrait",
    gem: false,
    keywords: "never posted worth editing y2k portrait",
  },
  {
    id: 9,
    scene: "country",
    label: "Field portrait",
    gem: false,
    keywords: "best me last summer clear jersey shots country outside",
  },
]);

const COLLECTIONS = Object.freeze([
  { name: "Hidden gems", count: 16, scene: "flash", photoIds: [1, 4, 6] },
  { name: "Best of August", count: 9, scene: "gym", photoIds: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
  { name: "Never posted", count: 41, scene: "sunset", photoIds: [1, 5, 8] },
  { name: "With friends", count: 58, scene: "y2k", photoIds: [2, 3, 7] },
  { name: "Dating picks", count: 6, scene: "portrait", photoIds: [1, 5, 6] },
  { name: "Worth editing", count: 12, scene: "beach", photoIds: [3, 4, 8] },
]);

const PHOTO_ACTIONS = Object.freeze([
  {
    label: "Describe an edit",
    sublabel: "“Remove the ship in the background”",
    primary: true,
  },
  { label: "Edit manually", sublabel: "Erase, add, crop, and adjust by hand" },
  { label: "Make it look like…", sublabel: "Match a reference or an aesthetic" },
  { label: "Use in chat", sublabel: "Build a post or dump around it" },
]);

const WHY =
  "Strong expression, clean background, natural light — and enough negative space to crop for a cover.";

const STOP_WORDS = new Set(["a", "and", "for", "i", "in", "last", "my", "of", "the"]);

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function gemBadgeMarkup() {
  return `
    <span class="photos-gem-badge" aria-label="Ranked gem">
      <svg viewBox="0 0 10 10" aria-hidden="true">
        <path d="M5 .8c.6 1.6 1.8 2.8 3.4 3.4C6.8 4.8 5.6 6 5 7.6 4.4 6 3.2 4.8 1.6 4.2 3.2 3.6 4.4 2.4 5 .8Z"></path>
      </svg>
    </span>
  `;
}

function sceneMarkup(scene, large = false) {
  return `
    <span class="photos-scene photos-scene-${scene}${large ? " is-large" : ""}" aria-hidden="true">
      <i class="photos-figure-head"></i>
      <i class="photos-figure-body"></i>
      ${scene === "portrait" || scene === "sunset" ? '<i class="photos-scene-sun"></i>' : ""}
      ${scene === "gym" ? '<i class="photos-gym-bar"></i>' : ""}
      ${scene === "cafe" ? '<i class="photos-cafe-table"></i><i class="photos-cafe-cup"></i>' : ""}
    </span>
  `;
}

function collectionMarkup(activeCollection) {
  return COLLECTIONS.map(
    (collection, index) => `
      <button
        class="photos-collection photos-entrance${collection.name === activeCollection ? " is-active" : ""}"
        type="button"
        data-photo-collection="${collection.name}"
        aria-pressed="${collection.name === activeCollection}"
        style="--photos-delay: ${220 + index * 35}ms"
      >
        ${sceneMarkup(collection.scene)}
        <span class="photos-collection-overlay">
          <strong>${collection.name}</strong>
          <small>${collection.count} photos</small>
        </span>
      </button>
    `,
  ).join("");
}

function photoMarkup(photo, index) {
  return `
    <button
      class="photos-grid-item photos-entrance"
      type="button"
      data-photo-id="${photo.id}"
      aria-label="Open ${photo.label}"
      style="--photos-delay: ${380 + index * 25}ms"
    >
      ${sceneMarkup(photo.scene)}
      ${photo.gem ? gemBadgeMarkup() : ""}
    </button>
  `;
}

function photosMarkup() {
  return `
    <div id="photosContent" class="photos-content home-scroll">
      <header class="photos-header">
        <h1 id="photosTitle" class="photos-title photos-entrance" tabindex="-1">Photos</h1>
        <button id="photosImport" class="photos-import photos-entrance" type="button">
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M6 1v10M1 6h10"></path>
          </svg>
          <span>Import</span>
        </button>
      </header>

      <section class="photos-search-section" aria-label="Search your photos">
        <label class="photos-search photos-entrance" for="photosSearch">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="5"></circle>
            <path d="M11 11l3.5 3.5"></path>
          </svg>
          <span class="sr-only">Search your life</span>
          <input
            id="photosSearch"
            type="search"
            autocomplete="off"
            enterkeyhint="search"
            placeholder="Search your life…"
          />
        </label>
        <div class="photos-hints home-scroll" aria-label="Example searches">
          ${SEARCH_HINTS.map(
            (hint, index) => `
              <button
                class="photos-hint photos-entrance"
                type="button"
                data-photo-hint="${hint}"
                style="--photos-delay: ${150 + index * 30}ms"
              >
                “${hint}”
              </button>
            `,
          ).join("")}
        </div>
      </section>

      <section class="photos-collections-section" aria-labelledby="photosCollectionsTitle">
        <h2 id="photosCollectionsTitle" class="photos-section-title photos-entrance">
          Collections Gems keeps for you
        </h2>
        <div id="photosCollections" class="photos-collections home-scroll">
          ${collectionMarkup(null)}
        </div>
      </section>

      <section class="photos-library-section" aria-labelledby="photosLibraryTitle">
        <h2 id="photosLibraryTitle" class="photos-section-title photos-entrance">August</h2>
        <div id="photosGrid" class="photos-grid"></div>
        <p id="photosEmpty" class="photos-empty" hidden>
          <strong>No photos match that yet.</strong>
          <span>Try a broader description.</span>
        </p>
        <p id="photosStatus" class="sr-only" aria-live="polite"></p>
      </section>
    </div>

    <div id="photosBottomChrome" class="photos-bottom-chrome">
      ${appTabBarMarkup("Photos")}
    </div>

    <div id="photoSheetRoot"></div>
  `;
}

/**
 * @param {{screen: HTMLElement, mount: HTMLElement, onNavigate?: (tab: string) => void}} options
 */
export function createPhotosScreen({ screen, mount, onNavigate = () => {} }) {
  mount.innerHTML = photosMarkup();

  const content = mount.querySelector("#photosContent");
  const title = mount.querySelector("#photosTitle");
  const search = mount.querySelector("#photosSearch");
  const searchShell = mount.querySelector(".photos-search");
  const hintsRow = mount.querySelector(".photos-hints");
  const collectionsSection = mount.querySelector(".photos-collections-section");
  const collectionsRoot = mount.querySelector("#photosCollections");
  const libraryTitle = mount.querySelector("#photosLibraryTitle");
  const grid = mount.querySelector("#photosGrid");
  const empty = mount.querySelector("#photosEmpty");
  const status = mount.querySelector("#photosStatus");
  const bottomChrome = mount.querySelector("#photosBottomChrome");
  const sheetRoot = mount.querySelector("#photoSheetRoot");
  let query = "";
  let activeCollection = null;
  let selectedPhotoId = null;
  let activated = false;
  let libraryPhotos = [];

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/*";
  fileInput.multiple = true;
  fileInput.hidden = true;
  fileInput.tabIndex = -1;
  fileInput.setAttribute("aria-hidden", "true");
  mount.append(fileInput);

  function isRealMode() {
    return libraryPhotos.length > 0;
  }

  function syncMode() {
    const real = isRealMode();
    if (real) activeCollection = null;
    hintsRow.hidden = real;
    collectionsSection.hidden = real;
  }

  function visiblePhotos() {
    if (isRealMode()) {
      const normalized = query.trim().toLocaleLowerCase();
      if (!normalized) return libraryPhotos;
      return libraryPhotos.filter((photo) =>
        String(photo.name ?? "").toLocaleLowerCase().includes(normalized),
      );
    }

    if (activeCollection) {
      const collection = COLLECTIONS.find((item) => item.name === activeCollection);
      return collection
        ? PHOTOS.filter((photo) => collection.photoIds.includes(photo.id))
        : PHOTOS;
    }

    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return PHOTOS;
    const terms = normalized
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length > 1 && !STOP_WORDS.has(term));
    if (terms.length === 0) return PHOTOS;
    return PHOTOS.filter((photo) => terms.some((term) => photo.keywords.includes(term)));
  }

  function realPhotoTile(photo, index) {
    const button = document.createElement("button");
    button.className = "photos-grid-item photos-entrance";
    button.type = "button";
    button.dataset.photoId = String(photo.id);
    button.setAttribute("aria-label", `Open ${photo.name}`);
    button.style.setProperty("--photos-delay", `${380 + index * 25}ms`);

    const img = document.createElement("img");
    img.src = photo.url;
    img.alt = photo.name;
    img.loading = "lazy";
    img.decoding = "async";
    button.append(img);

    if (photo.gem) button.insertAdjacentHTML("beforeend", gemBadgeMarkup());
    button.addEventListener("click", () => openSheet(photo.id));
    return button;
  }

  function renderGrid() {
    const photos = visiblePhotos();
    if (isRealMode()) {
      grid.replaceChildren(...photos.map(realPhotoTile));
    } else {
      grid.innerHTML = photos.map(photoMarkup).join("");
      grid.querySelectorAll("[data-photo-id]").forEach((button) => {
        button.addEventListener("click", () => openSheet(Number(button.dataset.photoId)));
      });
    }
    grid.hidden = photos.length === 0;
    empty.hidden = photos.length !== 0;
    if (isRealMode()) {
      libraryTitle.textContent = query.trim() ? "Search results" : "Your library";
      status.textContent = query.trim()
        ? `${photos.length} of ${libraryPhotos.length} photos match`
        : `${photos.length} photo${photos.length === 1 ? "" : "s"} in your library`;
    } else {
      libraryTitle.textContent = activeCollection
        ? activeCollection
        : query.trim()
          ? "Search results"
          : "August";
      status.textContent = `${photos.length} photo${photos.length === 1 ? "" : "s"} shown`;
    }
  }

  function syncCollections() {
    collectionsRoot.querySelectorAll("[data-photo-collection]").forEach((button) => {
      const active = button.dataset.photoCollection === activeCollection;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }

  function closeSheet() {
    if (selectedPhotoId === null) return;
    const returnToPhoto = selectedPhotoId;
    selectedPhotoId = null;
    sheetRoot.replaceChildren();
    content.inert = false;
    bottomChrome.inert = false;
    content.removeAttribute("aria-hidden");
    bottomChrome.removeAttribute("aria-hidden");
    grid
      .querySelector(`[data-photo-id="${CSS.escape(String(returnToPhoto))}"]`)
      ?.focus({ preventScroll: true });
  }

  function openSheet(photoId) {
    const real = isRealMode();
    const photo = real
      ? libraryPhotos.find((item) => item.id === photoId)
      : PHOTOS.find((item) => item.id === photoId);
    if (!photo) return;
    const previewMarkup = real
      ? `
          <img
            class="photos-sheet-photo"
            src="${escapeHtml(photo.url)}"
            alt="${escapeHtml(photo.name)}"
            decoding="async"
          />
        `
      : `<div class="photos-sheet-preview">${sceneMarkup(photo.scene, true)}</div>`;
    const why = real ? describePhoto(photo.metrics) : WHY;
    selectedPhotoId = photoId;
    content.inert = true;
    bottomChrome.inert = true;
    content.setAttribute("aria-hidden", "true");
    bottomChrome.setAttribute("aria-hidden", "true");
    sheetRoot.innerHTML = `
      <button class="photos-sheet-scrim" type="button" aria-label="Close photo details"></button>
      <section
        class="photos-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="photoSheetTitle"
        aria-describedby="photoSheetWhy"
      >
        <span class="photos-sheet-handle" aria-hidden="true"></span>
        <div class="photos-sheet-summary${real ? " is-real" : ""}">
          ${previewMarkup}
          <div class="photos-sheet-copy">
            <h2 id="photoSheetTitle">Why this works</h2>
            <p id="photoSheetWhy">${escapeHtml(why)}</p>
          </div>
        </div>
        <div class="photos-sheet-actions">
          ${PHOTO_ACTIONS.map(
            (action) => `
              <button
                class="photos-sheet-action${action.primary ? " is-primary" : ""}"
                type="button"
                data-photo-action="${action.label}"
              >
                <strong>${action.label}</strong>
                <span>${action.sublabel}</span>
              </button>
            `,
          ).join("")}
        </div>
      </section>
    `;

    sheetRoot.querySelector(".photos-sheet-scrim").addEventListener("click", closeSheet);
    sheetRoot.querySelectorAll("[data-photo-action]").forEach((button) => {
      button.addEventListener("click", () => {
        const action = button.dataset.photoAction;
        photosActions.runPhotoAction(action, photoId);
        if (action === "Describe an edit" || action === "Make it look like…") {
          closeSheet();
          onNavigate("Editor", { mode: "describe", photoId });
        } else if (action === "Edit manually") {
          closeSheet();
          onNavigate("Editor", { mode: "manual", photoId });
        }
      });
    });

    const dialog = sheetRoot.querySelector(".photos-sheet");
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSheet();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll("button")];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });

    window.requestAnimationFrame(() => {
      dialog.querySelector("button")?.focus({ preventScroll: true });
    });
  }

  async function refreshLibrary() {
    const records = await listPhotos();
    const changed = records.length !== libraryPhotos.length;
    libraryPhotos = records;
    if (changed) {
      syncMode();
      renderGrid();
    }
  }

  mount.querySelector("#photosImport").addEventListener("click", () => {
    photosActions.importPhotos();
    fileInput.click();
  });

  fileInput.addEventListener("change", async () => {
    if (!fileInput.files || fileInput.files.length === 0) return;
    const added = await importPhotoFiles(fileInput.files);
    fileInput.value = "";
    libraryPhotos = await listPhotos();
    syncMode();
    renderGrid();
    if (added.length === 0) return;
    const addedIds = new Set(added.map((record) => record.id));
    const gemCount = libraryPhotos.filter(
      (photo) => addedIds.has(photo.id) && photo.gem,
    ).length;
    status.textContent = `Added ${added.length} photos. ${gemCount} ranked as gems.`;
    photosActions.importCompleted(added.length, gemCount);
  });

  search.addEventListener("input", () => {
    query = search.value;
    activeCollection = null;
    searchShell.classList.toggle("has-value", query.length > 0);
    syncCollections();
    renderGrid();
  });

  search.addEventListener("search", () => photosActions.search(query.trim()));

  mount.querySelectorAll("[data-photo-hint]").forEach((button) => {
    button.addEventListener("click", () => {
      query = button.dataset.photoHint;
      search.value = query;
      activeCollection = null;
      searchShell.classList.add("has-value");
      syncCollections();
      renderGrid();
      photosActions.search(query);
      search.focus({ preventScroll: true });
    });
  });

  collectionsRoot.querySelectorAll("[data-photo-collection]").forEach((button) => {
    button.addEventListener("click", () => {
      const collection = button.dataset.photoCollection;
      activeCollection = activeCollection === collection ? null : collection;
      query = "";
      search.value = "";
      searchShell.classList.remove("has-value");
      syncCollections();
      renderGrid();
      if (activeCollection) photosActions.openCollection(activeCollection);
    });
  });

  mount.querySelectorAll("[data-app-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      const tab = button.dataset.appTab;
      if (tab === "Home" || tab === "Discover" || tab === "Studio" || tab === "Profile") {
        closeSheet();
        onNavigate(tab);
        return;
      }
      if (tab === "Photos") {
        syncActiveTab(mount, "Photos");
        return;
      }
      photosActions.selectTab(tab);
    });
  });

  renderGrid();

  return Object.freeze({
    activate() {
      syncActiveTab(mount, "Photos");
      void refreshLibrary();
      if (activated) return;
      activated = true;
      content.scrollTo({ top: 0, behavior: "auto" });
      screen.classList.remove("is-entering");
      void screen.offsetWidth;
      screen.classList.add("is-entering");
      window.setTimeout(() => screen.classList.remove("is-entering"), 900);
    },

    resume() {
      syncActiveTab(mount, "Photos");
    },

    focusHeading() {
      title.focus({ preventScroll: true });
    },
  });
}
