import { appTabBarMarkup, syncActiveTab } from "./app-tabs.js";
import { profileActions } from "./profile-actions.js";
import { getSupabase, getSession } from "./gems-supabase.js";
import { shareTasteProfile } from "./gems-share.js";
import {
  getConsents,
  setConsent,
  exportMyData,
  deleteMyAccount,
} from "./gems-privacy.js";

// The training-consent row + sheet share these labels so the two toggles never
// drift. Copy is deliberately plain and opt-in-forward.
const TRAINING_ON_SUBLABEL = "On — thank you; turn it off anytime";
const TRAINING_OFF_SUBLABEL = "Off — opt-in only, always your call";

const TASTE = Object.freeze([
  { name: "Euro Summer", percent: 46, key: "euro" },
  { name: "Dark Gym", percent: 31, key: "gym" },
  { name: "Golden Hour", percent: 23, key: "golden" },
]);

// The three chart colors act as ranked slots when live data replaces the
// demo aesthetics.
const TASTE_SLOT_KEYS = Object.freeze(["euro", "gym", "golden"]);

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const STATS = Object.freeze([
  { value: "16", label: "gems found" },
  { value: "3", label: "dumps made" },
  { value: "27", label: "edits" },
]);

const SETTINGS = Object.freeze([
  {
    label: "Camera roll access",
    sublabel: "Full library · analyzed on your device",
    action: "camera",
  },
  {
    label: "People",
    sublabel: "Recognize faces · find photos of you · on your device",
    action: "people",
  },
  {
    label: "Memories",
    sublabel: "Auto-albums from your trips & moments · on your device",
    action: "memories",
  },
  {
    label: "Privacy & data",
    sublabel: "What Gems keeps, and what it never sees",
    action: "privacy",
  },
  {
    label: "Improve Gems with my photos",
    sublabel: TRAINING_OFF_SUBLABEL,
    action: "training",
  },
  { label: "Help & feedback", sublabel: "", action: "help" },
]);

// The pill switch used by the training-consent row and the privacy sheet.
function toggleMarkup() {
  return `
    <span class="profile-toggle" aria-hidden="true">
      <span class="profile-toggle-thumb"></span>
    </span>
  `;
}

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
          ${SETTINGS.map((setting, index) => {
            const isToggle = setting.action === "training";
            return `
              <button
                class="profile-setting${isToggle ? " profile-setting-toggle" : ""} profile-entrance"
                style="--profile-delay: ${640 + index * 50}ms"
                type="button"
                data-profile-action="${escapeHtml(setting.action)}"
                ${isToggle ? 'role="switch" aria-checked="false"' : ""}
              >
                <span class="profile-setting-copy">
                  <strong>${escapeHtml(setting.label)}</strong>
                  ${setting.sublabel ? `<small data-setting-sublabel>${escapeHtml(setting.sublabel)}</small>` : ""}
                </span>
                ${
                  isToggle
                    ? toggleMarkup()
                    : `<svg viewBox="0 0 8 14" aria-hidden="true">
                  <path d="m1.5 1.5 5 5.5-5 5.5"></path>
                </svg>`
                }
              </button>
            `;
          }).join("")}
        </div>
        <button
          id="profileSignOut"
          class="profile-setting profile-signout profile-entrance"
          style="--profile-delay: 860ms"
          type="button"
        >
          <span class="profile-setting-copy">
            <strong>Sign out</strong>
          </span>
        </button>
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

function privacyMarkup() {
  return `
    <button class="profile-sheet-scrim" type="button" aria-label="Close privacy and data"></button>
    <section
      class="profile-sheet profile-sheet--privacy"
      role="dialog"
      aria-modal="true"
      aria-labelledby="privacyTitle"
      aria-describedby="privacyIntro"
    >
      <span class="profile-sheet-handle" aria-hidden="true"></span>
      <button class="profile-sheet-close" type="button" aria-label="Close privacy and data">
        <svg viewBox="0 0 14 14" aria-hidden="true">
          <path d="M2 2l10 10M12 2 2 12"></path>
        </svg>
      </button>

      <div class="profile-privacy-main" data-privacy-main>
        <h2 id="privacyTitle">Privacy &amp; data</h2>
        <p id="privacyIntro">Plain and honest — exactly what stays on your phone, and what Gems keeps.</p>

        <div class="profile-privacy-block">
          <h3>What Gems keeps</h3>
          <ul>
            <li>Your profile and the aesthetics you picked</li>
            <li>Your taste events — the choices that sharpen your ranking</li>
            <li>The edited images you generate (the outputs, so you can get them back)</li>
          </ul>
        </div>

        <div class="profile-privacy-block profile-privacy-block--never">
          <h3>What Gems never does</h3>
          <ul>
            <li>Upload your original photos — they stay on your device, always</li>
            <li>Only 512px thumbnails and images you explicitly edit ever leave the phone</li>
            <li>No face prints, no biometrics, server-side, ever</li>
          </ul>
        </div>

        <button
          class="profile-privacy-consent"
          type="button"
          data-training-toggle
          role="switch"
          aria-checked="false"
        >
          <span class="profile-setting-copy">
            <strong>Improve Gems with my photos</strong>
            <small data-training-sublabel>${escapeHtml(TRAINING_OFF_SUBLABEL)}</small>
          </span>
          ${toggleMarkup()}
        </button>

        <div class="profile-privacy-actions">
          <button class="profile-privacy-btn" type="button" data-privacy-download>
            Download my data
          </button>
          <button
            class="profile-privacy-btn profile-privacy-btn--danger"
            type="button"
            data-privacy-delete
          >
            Delete my account and data
          </button>
        </div>

        <p class="profile-privacy-legal">
          Read our
          <a href="privacy.html" target="_blank" rel="noopener">Privacy Policy</a>
          and
          <a href="terms.html" target="_blank" rel="noopener">Terms of Service</a>.
        </p>
      </div>

      <div class="profile-privacy-confirm" data-privacy-confirm hidden>
        <h3>Delete everything?</h3>
        <p>
          This permanently deletes your account, profile, projects, and edited
          photos. This cannot be undone.
        </p>
        <div class="profile-privacy-confirm-actions">
          <button class="profile-privacy-btn" type="button" data-privacy-cancel>
            Keep my account
          </button>
          <button
            class="profile-privacy-btn profile-privacy-btn--danger"
            type="button"
            data-privacy-confirm-delete
          >
            Delete forever
          </button>
        </div>
      </div>
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
  let privacyOpen = false;
  let privacySettingButton = null;
  let tasteData = TASTE.map(({ name: label, percent }) => ({ name: label, percent }));

  // Training-consent state, mirrored across the settings row and the privacy
  // sheet. signedIn tracks whether there is a session to persist against.
  let trainingOptIn = false;
  let trainingSignedIn = false;
  let trainingBusy = false;

  // Push the current training state onto whichever toggles are in the DOM (the
  // settings row is always present; the sheet's toggle exists only while open).
  function syncTrainingToggles() {
    const sublabel = trainingOptIn ? TRAINING_ON_SUBLABEL : TRAINING_OFF_SUBLABEL;
    const rowButton = mount.querySelector('[data-profile-action="training"]');
    if (rowButton) {
      rowButton.setAttribute("aria-checked", String(trainingOptIn));
      rowButton.classList.toggle("is-on", trainingOptIn);
      const rowSub = rowButton.querySelector("[data-setting-sublabel]");
      if (rowSub) rowSub.textContent = sublabel;
    }
    const sheetToggle = sheetRoot.querySelector("[data-training-toggle]");
    if (sheetToggle) {
      sheetToggle.setAttribute("aria-checked", String(trainingOptIn));
      sheetToggle.classList.toggle("is-on", trainingOptIn);
      const sheetSub = sheetToggle.querySelector("[data-training-sublabel]");
      if (sheetSub) sheetSub.textContent = sublabel;
    }
  }

  // Read the live consent state (defaults false/false; null when signed out).
  async function refreshConsents() {
    const result = await getConsents();
    trainingSignedIn = result !== null;
    trainingOptIn = Boolean(result?.training_opt_in);
    syncTrainingToggles();
  }

  // Flip the training opt-in: optimistic UI, persist, revert on failure.
  async function toggleTraining() {
    if (trainingBusy) return;
    if (!trainingSignedIn) {
      status.textContent = "Sign in to choose how Gems learns from your photos.";
      return;
    }
    trainingBusy = true;
    const next = !trainingOptIn;
    trainingOptIn = next;
    syncTrainingToggles();
    status.textContent = next
      ? "Thank you — Gems can learn from your photos now."
      : "Off. Gems won't learn from your photos.";
    const ok = await setConsent("training_opt_in", next);
    if (!ok) {
      trainingOptIn = !next;
      syncTrainingToggles();
      status.textContent = "Couldn't save that just now — please try again.";
    }
    trainingBusy = false;
  }

  function renderTaste(taste, choiceCount) {
    const card = mount.querySelector(".profile-taste-card");
    const bar = card.querySelector(".profile-taste-bar");
    const legend = card.querySelector(".profile-taste-legend");

    bar.innerHTML = taste
      .map(
        (entry, index) => `
          <span
            class="profile-taste-fill taste-${TASTE_SLOT_KEYS[index]}"
            style="width: ${entry.percent}%"
          ></span>
        `,
      )
      .join("");
    legend.innerHTML = taste
      .map(
        (entry, index) => `
          <div class="profile-taste-row">
            <span class="profile-taste-dot taste-${TASTE_SLOT_KEYS[index]}"></span>
            <strong>${entry.percent}%</strong>
            <span>${escapeHtml(entry.name)}</span>
          </div>
        `,
      )
      .join("");
    card.querySelector("p").textContent =
      `Learned from ${choiceCount} choices you've made — it sharpens every time you pick.`;
    card.setAttribute(
      "aria-label",
      `Taste profile: ${taste.map((entry) => `${entry.percent} percent ${entry.name}`).join(", ")}`,
    );
  }

  // Replaces the demo chart with real signal: the user's chosen aesthetics
  // ranked by how often they show up in their recent taste_events.
  async function refreshTasteProfile() {
    try {
      const supabase = await getSupabase();
      const session = await getSession();
      if (!supabase || !session) return;
      const [{ data: aesthetics }, { data: events }] = await Promise.all([
        supabase
          .from("profile_aesthetics")
          .select("label")
          .eq("profile_id", session.user.id)
          .order("position"),
        supabase
          .from("taste_events")
          .select("subject")
          .eq("profile_id", session.user.id)
          .order("created_at", { ascending: false })
          .limit(400),
      ]);
      if (!aesthetics?.length || !events?.length) return;

      const ranked = aesthetics
        .map(({ label }) => {
          const needle = label.toLowerCase();
          const count = events.filter((event) =>
            JSON.stringify(event.subject ?? {}).toLowerCase().includes(needle),
          ).length;
          return { name: label, count };
        })
        .filter((entry) => entry.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, 3);
      if (!ranked.length) return;

      const total = ranked.reduce((sum, entry) => sum + entry.count, 0);
      let remaining = 100;
      tasteData = ranked.map((entry, index) => {
        const percent =
          index === ranked.length - 1
            ? remaining
            : Math.round((entry.count / total) * 100);
        remaining -= percent;
        return { name: entry.name, percent };
      });
      renderTaste(tasteData, events.length);
    } catch (error) {
      console.info("Taste profile stayed in demo mode", error);
    }
  }

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

  function closePrivacy({ restoreFocus = true } = {}) {
    if (!privacyOpen) return;
    privacyOpen = false;
    sheetRoot.replaceChildren();
    content.inert = false;
    bottomChrome.inert = false;
    content.removeAttribute("aria-hidden");
    bottomChrome.removeAttribute("aria-hidden");
    if (restoreFocus && privacySettingButton) {
      privacySettingButton.focus({ preventScroll: true });
    }
  }

  async function downloadMyData() {
    status.textContent = "Preparing your data…";
    const blob = await exportMyData();
    if (!blob) {
      status.textContent = trainingSignedIn
        ? "Couldn't prepare your data right now."
        : "Sign in to download your data.";
      return;
    }
    try {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "gems-data.json";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      status.textContent = "Your Gems data is downloading.";
    } catch (error) {
      console.info("Data download stayed local", error);
      status.textContent = "Couldn't start the download.";
    }
  }

  function openPrivacy() {
    if (privacyOpen) return;
    // The paywall shares sheetRoot; only one sheet lives there at a time.
    closePaywall({ restoreFocus: false });
    privacyOpen = true;
    profileActions.openSetting("Privacy & data");
    content.inert = true;
    bottomChrome.inert = true;
    content.setAttribute("aria-hidden", "true");
    bottomChrome.setAttribute("aria-hidden", "true");
    sheetRoot.innerHTML = privacyMarkup();
    syncTrainingToggles();

    const scrim = sheetRoot.querySelector(".profile-sheet-scrim");
    const dialog = sheetRoot.querySelector(".profile-sheet");
    const closeButton = sheetRoot.querySelector(".profile-sheet-close");
    const mainPane = sheetRoot.querySelector("[data-privacy-main]");
    const confirmPane = sheetRoot.querySelector("[data-privacy-confirm]");
    const trainingToggle = sheetRoot.querySelector("[data-training-toggle]");
    const downloadButton = sheetRoot.querySelector("[data-privacy-download]");
    const deleteButton = sheetRoot.querySelector("[data-privacy-delete]");
    const cancelButton = sheetRoot.querySelector("[data-privacy-cancel]");
    const confirmDelete = sheetRoot.querySelector("[data-privacy-confirm-delete]");

    scrim.addEventListener("click", () => closePrivacy());
    closeButton.addEventListener("click", () => closePrivacy());
    trainingToggle.addEventListener("click", () => void toggleTraining());
    downloadButton.addEventListener("click", () => void downloadMyData());

    // Step into the destructive confirm.
    deleteButton.addEventListener("click", () => {
      mainPane.hidden = true;
      confirmPane.hidden = false;
      status.textContent = "Confirm to permanently delete your account.";
      window.requestAnimationFrame(() => cancelButton.focus({ preventScroll: true }));
    });
    cancelButton.addEventListener("click", () => {
      confirmPane.hidden = true;
      mainPane.hidden = false;
      status.textContent = "";
      window.requestAnimationFrame(() => deleteButton.focus({ preventScroll: true }));
    });
    confirmDelete.addEventListener("click", async () => {
      if (confirmDelete.disabled) return;
      confirmDelete.disabled = true;
      cancelButton.disabled = true;
      status.textContent = "Deleting your account and data…";
      const result = await deleteMyAccount();
      if (result?.deleted) {
        // Everything is gone — restart at the splash, like sign-out does.
        status.textContent = "Your account and data have been deleted.";
        window.location.reload();
        return;
      }
      confirmDelete.disabled = false;
      cancelButton.disabled = false;
      status.textContent = "Couldn't delete your account right now — please try again.";
    });

    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePrivacy();
        return;
      }
      if (event.key !== "Tab") return;
      // Only trap across the buttons that are actually visible (the confirm
      // pane and main pane swap via [hidden], so offsetParent filters them).
      const focusable = [...dialog.querySelectorAll("button")].filter(
        (element) => !element.disabled && element.offsetParent !== null,
      );
      if (!focusable.length) return;
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
    // Keep the engagement signal, then render + present the live taste card.
    profileActions.shareTasteProfile({ ...profileState, taste: tasteData });
    void (async () => {
      try {
        status.textContent = "Preparing your card…";
        const result = await shareTasteProfile({
          name: profileState.name,
          taste: tasteData,
        });
        status.textContent = result?.shared
          ? "Shared!"
          : "Saved your taste card.";
      } catch (error) {
        console.info("Taste share stayed local", error);
        status.textContent = "Couldn't share right now.";
      }
    })();
  });

  mount.querySelectorAll("[data-profile-action]").forEach((button) => {
    if (button.dataset.profileAction === "privacy") {
      privacySettingButton = button;
    }
    button.addEventListener("click", () => {
      const action = button.dataset.profileAction;
      if (action === "training") {
        void toggleTraining();
        return;
      }
      if (action === "privacy") {
        openPrivacy();
        return;
      }
      if (action === "people") {
        void import("./gems-people-view.js").then((m) => m.openPeopleStudio());
        return;
      }
      if (action === "memories") {
        void import("./gems-memories-view.js").then((m) => m.openMemories());
        return;
      }
      // camera / help are not built yet. Every other stub on this screen
      // narrates itself; these two recorded a taste event and then did nothing
      // visible at all, which reads as a broken row rather than an unfinished
      // one. Say so, on screen.
      profileActions.openSetting(button.dataset.profileAction);
      status.textContent =
        button.dataset.profileAction === "camera"
          ? "Camera roll access is managed in your device settings for now."
          : "Help & feedback is coming soon — email us in the meantime.";
    });
  });

  mount.querySelector("#profileSignOut").addEventListener("click", () => {
    status.textContent = "Signing out.";
    void profileActions.signOut();
  });

  mount.querySelectorAll("[data-app-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      const tab = button.dataset.appTab;
      if (tab === "Home" || tab === "Discover" || tab === "Photos" || tab === "Studio") {
        closePaywall({ restoreFocus: false });
        closePrivacy({ restoreFocus: false });
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
      void refreshTasteProfile();
      void refreshConsents();
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

    closePrivacy,

    deactivate() {
      closePaywall({ restoreFocus: false });
      closePrivacy({ restoreFocus: false });
    },
  });
}
