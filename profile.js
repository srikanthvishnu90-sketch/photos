import { appTabBarMarkup, syncActiveTab } from "./app-tabs.js";
import { profileActions } from "./profile-actions.js";

const TASTE = Object.freeze([
  { name: "Euro Summer", percent: 46, key: "euro" },
  { name: "Dark Gym", percent: 31, key: "gym" },
  { name: "Golden Hour", percent: 23, key: "golden" },
]);

const STATS = Object.freeze([
  { value: "16", label: "gems found" },
  { value: "3", label: "dumps made" },
  { value: "27", label: "edits" },
]);

const SETTINGS = Object.freeze([
  { label: "Camera roll access", sublabel: "Full library · analyzed on your device" },
  { label: "Privacy & data", sublabel: "What Gems keeps, and what it never sees" },
  {
    label: "Improve Gems with my photos",
    sublabel: "Off — opt-in only, always your call",
  },
  { label: "Help & feedback", sublabel: "" },
]);

const PLUS_FEATURES = Object.freeze([
  "Unlimited photo dumps and carousels",
  "Full camera-roll intelligence, refreshed daily",
  "Describe-it edits with priority processing",
  "Every aesthetic pack, including creator packs",
  "High-res exports without watermarks",
]);

function profileMarkup() {
  return `
    <div id="profileContent" class="profile-content home-scroll">
      <header class="profile-identity profile-entrance" style="--profile-delay: 80ms">
        <div id="profileAvatar" class="profile-avatar" aria-hidden="true">V</div>
        <div class="profile-identity-copy">
          <h1 id="profileName" class="profile-name" tabindex="-1">Vish</h1>
          <p>Free plan · joined August 2026</p>
        </div>
      </header>

      <section class="profile-stats" aria-label="Your Gems activity">
        ${STATS.map(
          (stat, index) => `
            <div class="profile-stat profile-entrance" style="--profile-delay: ${220 + index * 60}ms">
              <strong>${stat.value}</strong>
              <span>${stat.label}</span>
            </div>
          `,
        ).join("")}
      </section>

      <section class="profile-section profile-taste-section">
        <div class="profile-section-heading profile-entrance" style="--profile-delay: 360ms">
          <h2>Your taste profile</h2>
          <button id="profileShare" class="profile-link" type="button">Share</button>
        </div>
        <div
          class="profile-taste-card profile-entrance"
          style="--profile-delay: 440ms"
          role="img"
          aria-label="Taste profile: 46 percent Euro Summer, 31 percent Dark Gym, and 23 percent Golden Hour"
        >
          <div class="profile-taste-bar" aria-hidden="true">
            <span class="profile-taste-fill taste-euro"></span>
            <span class="profile-taste-fill taste-gym"></span>
            <span class="profile-taste-fill taste-golden"></span>
          </div>
          <div class="profile-taste-legend" aria-hidden="true">
            ${TASTE.map(
              (taste) => `
                <div class="profile-taste-row">
                  <span class="profile-taste-dot taste-${taste.key}"></span>
                  <strong>${taste.percent}%</strong>
                  <span>${taste.name}</span>
                </div>
              `,
            ).join("")}
          </div>
          <p>Learned from 27 choices you've made — it sharpens every time you pick.</p>
        </div>
      </section>

      <section class="profile-section profile-plus-section">
        <button id="profilePlus" class="profile-plus-card profile-entrance" style="--profile-delay: 520ms" type="button">
          <span class="profile-plus-title">Gems Plus</span>
          <span class="profile-plus-copy">Unlimited dumps, every aesthetic, priority edits.</span>
          <span class="profile-plus-cta">Try free for 7 days · then $9.99/mo</span>
        </button>
      </section>

      <section class="profile-section profile-settings-section">
        <h2 class="profile-entrance" style="--profile-delay: 600ms">Settings</h2>
        <div class="profile-settings">
          ${SETTINGS.map(
            (setting, index) => `
              <button
                class="profile-setting profile-entrance"
                style="--profile-delay: ${640 + index * 50}ms"
                type="button"
                data-profile-setting="${setting.label}"
              >
                <span class="profile-setting-copy">
                  <strong>${setting.label}</strong>
                  ${setting.sublabel ? `<small>${setting.sublabel}</small>` : ""}
                </span>
                <svg viewBox="0 0 8 14" aria-hidden="true">
                  <path d="m1.5 1.5 5 5.5-5 5.5"></path>
                </svg>
              </button>
            `,
          ).join("")}
        </div>
      </section>
    </div>

    <div id="profileBottomChrome" class="profile-bottom-chrome">
      ${appTabBarMarkup("Profile")}
    </div>
    <div id="profileSheetRoot"></div>
    <p id="profileStatus" class="sr-only" aria-live="polite"></p>
  `;
}

function paywallMarkup() {
  return `
    <button class="profile-sheet-scrim" type="button" aria-label="Close Gems Plus"></button>
    <section
      class="profile-sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="plusTitle"
      aria-describedby="plusDescription"
    >
      <span class="profile-sheet-handle" aria-hidden="true"></span>
      <button class="profile-sheet-close" type="button" aria-label="Close Gems Plus">
        <svg viewBox="0 0 14 14" aria-hidden="true">
          <path d="M2 2l10 10M12 2 2 12"></path>
        </svg>
      </button>
      <h2 id="plusTitle">Gems Plus</h2>
      <p id="plusDescription">Everything your camera roll is capable of.</p>
      <ul class="profile-plus-features">
        ${PLUS_FEATURES.map(
          (feature) => `
            <li>
              <span class="profile-feature-check" aria-hidden="true">
                <svg viewBox="0 0 11 9">
                  <path d="M1 4.5 4 7.5 10 1.5"></path>
                </svg>
              </span>
              <span>${feature}</span>
            </li>
          `,
        ).join("")}
      </ul>
      <button id="profileStartTrial" class="profile-trial" type="button">Start 7-day free trial</button>
      <p class="profile-trial-note">$9.99/month after trial · cancel anytime in Settings</p>
    </section>
  `;
}

/**
 * @param {{screen: HTMLElement, mount: HTMLElement, onNavigate?: (tab: string) => void}} options
 */
export function createProfileScreen({ screen, mount, onNavigate = () => {} }) {
  mount.innerHTML = profileMarkup();

  const content = mount.querySelector("#profileContent");
  const bottomChrome = mount.querySelector("#profileBottomChrome");
  const sheetRoot = mount.querySelector("#profileSheetRoot");
  const name = mount.querySelector("#profileName");
  const avatar = mount.querySelector("#profileAvatar");
  const plusButton = mount.querySelector("#profilePlus");
  const status = mount.querySelector("#profileStatus");
  let profileState = {};
  let activated = false;
  let paywallOpen = false;

  function closePaywall({ restoreFocus = true } = {}) {
    if (!paywallOpen) return;
    paywallOpen = false;
    sheetRoot.replaceChildren();
    content.inert = false;
    bottomChrome.inert = false;
    content.removeAttribute("aria-hidden");
    bottomChrome.removeAttribute("aria-hidden");
    if (restoreFocus) plusButton.focus({ preventScroll: true });
  }

  function openPaywall() {
    if (paywallOpen) return;
    paywallOpen = true;
    profileActions.openPlus();
    content.inert = true;
    bottomChrome.inert = true;
    content.setAttribute("aria-hidden", "true");
    bottomChrome.setAttribute("aria-hidden", "true");
    sheetRoot.innerHTML = paywallMarkup();

    const scrim = sheetRoot.querySelector(".profile-sheet-scrim");
    const dialog = sheetRoot.querySelector(".profile-sheet");
    const closeButton = sheetRoot.querySelector(".profile-sheet-close");
    const trialButton = sheetRoot.querySelector("#profileStartTrial");

    scrim.addEventListener("click", () => closePaywall());
    closeButton.addEventListener("click", () => closePaywall());
    trialButton.addEventListener("click", () => {
      profileActions.startTrial();
      status.textContent = "The App Store subscription flow will open here.";
    });

    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePaywall();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll("button:not(:disabled)")];
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

    window.requestAnimationFrame(() => closeButton.focus({ preventScroll: true }));
  }

  plusButton.addEventListener("click", openPaywall);
  mount.querySelector("#profileShare").addEventListener("click", () => {
    profileActions.shareTasteProfile({ ...profileState, taste: TASTE });
  });

  mount.querySelectorAll("[data-profile-setting]").forEach((button) => {
    button.addEventListener("click", () => {
      profileActions.openSetting(button.dataset.profileSetting);
    });
  });

  mount.querySelectorAll("[data-app-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      const tab = button.dataset.appTab;
      if (tab === "Home" || tab === "Discover" || tab === "Photos" || tab === "Studio") {
        closePaywall({ restoreFocus: false });
        onNavigate(tab);
        return;
      }
      if (tab === "Profile") {
        syncActiveTab(mount, "Profile");
        return;
      }
      profileActions.selectTab(tab);
    });
  });

  return Object.freeze({
    activate(nextProfileState = {}) {
      profileState = { ...nextProfileState };
      const firstName = profileState.name?.trim().split(/\s+/)[0] || "Vish";
      name.textContent = firstName;
      avatar.textContent = firstName.charAt(0).toLocaleUpperCase();
      syncActiveTab(mount, "Profile");
      if (activated) return;
      activated = true;
      content.scrollTo({ top: 0, behavior: "auto" });
      screen.classList.remove("is-entering");
      void screen.offsetWidth;
      screen.classList.add("is-entering");
      window.setTimeout(() => screen.classList.remove("is-entering"), 1000);
    },

    focusHeading() {
      name.focus({ preventScroll: true });
    },

    closePaywall,

    deactivate() {
      closePaywall({ restoreFocus: false });
    },
  });
}
