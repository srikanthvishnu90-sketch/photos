export const APP_TABS = Object.freeze(["Home", "Discover", "Photos", "Studio"]);

function tabIconMarkup(tab) {
  if (tab === "Home") {
    return `
      <svg class="home-tab-icon" viewBox="0 0 22 22" aria-hidden="true">
        <path class="home-tab-home-fill" d="M3.5 9.5 11 3l7.5 6.5V18a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18V9.5Z"></path>
      </svg>
    `;
  }

  if (tab === "Discover") {
    return `
      <svg class="home-tab-icon" viewBox="0 0 22 22" aria-hidden="true">
        <circle cx="11" cy="11" r="8"></circle>
        <path d="m14 8-1.7 4.3L8 14l1.7-4.3L14 8Z"></path>
      </svg>
    `;
  }

  if (tab === "Photos") {
    return `
      <svg class="home-tab-icon" viewBox="0 0 22 22" aria-hidden="true">
        <rect x="3" y="3" width="16" height="16" rx="3"></rect>
        <circle cx="8" cy="8.2" r="1.6"></circle>
        <path d="m3.5 15 4.5-4 4 3.5 3-2.5 3.5 3"></path>
      </svg>
    `;
  }

  return `
    <svg class="home-tab-icon" viewBox="0 0 22 22" aria-hidden="true">
      <rect x="3" y="3" width="7" height="9" rx="2"></rect>
      <rect x="12" y="3" width="7" height="5.5" rx="2"></rect>
      <rect x="12" y="10.5" width="7" height="8.5" rx="2"></rect>
      <rect x="3" y="14" width="7" height="5" rx="2"></rect>
    </svg>
  `;
}

export function appTabBarMarkup(activeTab) {
  return `
    <nav class="home-tabs" aria-label="Primary navigation">
      ${APP_TABS.map(
        (tab) => `
          <button
            class="home-tab${tab === activeTab ? " is-active" : ""}"
            type="button"
            data-app-tab="${tab}"
            aria-current="${tab === activeTab ? "page" : "false"}"
          >
            ${tabIconMarkup(tab)}
            <span>${tab}</span>
          </button>
        `,
      ).join("")}
    </nav>
  `;
}

export function syncActiveTab(root, activeTab) {
  root.querySelectorAll("[data-app-tab]").forEach((button) => {
    const active = button.dataset.appTab === activeTab;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  });
}
