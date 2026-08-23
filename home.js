import { homeActions } from "./home-actions.js";
import { appTabBarMarkup, syncActiveTab } from "./app-tabs.js";

const GEMS = Object.freeze([
  { id: 1, label: "Best cover", meta: "Golden hour", scene: "portrait" },
  { id: 2, label: "Best with friends", meta: "Saturday night", scene: "friends" },
  { id: 3, label: "Dark Gym match", meta: "From your vibe", scene: "gym" },
  { id: 4, label: "Best candid", meta: "Downtown", scene: "city" },
  { id: 5, label: "Euro Summer match", meta: "From your vibe", scene: "beach" },
]);

const ACTIONS = Object.freeze([
  { label: "Make a photo dump", icon: "stack" },
  { label: "Edit a photo", icon: "edit" },
  { label: "Find my best photos", icon: "search" },
  { label: "Get inspiration", icon: "spark" },
]);

const TRENDS = Object.freeze([
  { name: "Euro Summer", style: "euro" },
  { name: "Concert", style: "concert" },
  { name: "Y2K", style: "y2k" },
  { name: "Golden Hour", style: "golden" },
]);

function sceneMarkup(scene) {
  if (scene === "portrait") {
    return `
      <div class="home-scene scene-portrait" aria-hidden="true">
        <span class="portrait-sun"></span>
        <span class="portrait-head"></span>
        <span class="portrait-body"></span>
      </div>
    `;
  }

  if (scene === "friends") {
    return `
      <div class="home-scene scene-friends" aria-hidden="true">
        <span class="friends-light"></span>
        <span class="friend friend-one"><i></i><b></b></span>
        <span class="friend friend-two"><i></i><b></b></span>
        <span class="friend friend-three"><i></i><b></b></span>
      </div>
    `;
  }

  if (scene === "city") {
    return `
      <div class="home-scene scene-city" aria-hidden="true">
        <span class="city-building city-building-one"></span>
        <span class="city-building city-building-two"></span>
        <span class="city-building city-building-three"></span>
        <span class="city-head"></span>
        <span class="city-body"></span>
      </div>
    `;
  }

  if (scene === "beach") {
    return `
      <div class="home-scene scene-beach" aria-hidden="true">
        <span class="beach-head"></span>
        <span class="beach-body"></span>
      </div>
    `;
  }

  return `
    <div class="home-scene scene-gym" aria-hidden="true">
      <span class="gym-bar"></span>
      <span class="gym-head"></span>
      <span class="gym-body"></span>
    </div>
  `;
}

function actionIcon(icon) {
  if (icon === "stack") {
    return `
      <svg class="home-line-icon" viewBox="0 0 17 17" aria-hidden="true">
        <rect x="1.5" y="4" width="9" height="11.5" rx="2"></rect>
        <path d="M5.5 1.5h8a2 2 0 0 1 2 2v9"></path>
      </svg>
    `;
  }

  if (icon === "edit") {
    return `
      <svg class="home-line-icon" viewBox="0 0 17 17" aria-hidden="true">
        <path d="M10.5 3 14 6.5 6 14.5l-4 .5.5-4 8-8Z"></path>
      </svg>
    `;
  }

  if (icon === "search") {
    return `
      <svg class="home-line-icon" viewBox="0 0 17 17" aria-hidden="true">
        <circle cx="7.2" cy="7.2" r="5.2"></circle>
        <path d="M11.2 11.2 15 15"></path>
      </svg>
    `;
  }

  return `
    <svg class="home-line-icon" viewBox="0 0 17 17" aria-hidden="true">
      <path d="M8.5 1.5c1 2.6 2.9 4.5 5.5 5.5-2.6 1-4.5 2.9-5.5 5.5-1-2.6-2.9-4.5-5.5-5.5 2.6-1 4.5-2.9 5.5-5.5Z"></path>
      <circle cx="13.8" cy="13.8" r="1.6"></circle>
    </svg>
  `;
}

function homeMarkup() {
  return `
    <div id="homeContent" class="home-content home-scroll">
      <header class="home-header">
        <div>
          <p id="homeGreeting" class="home-greeting home-entrance">Good morning</p>
          <h1 id="homeGreetingName" class="home-name home-entrance" tabindex="-1">Vish</h1>
        </div>
        <button id="homeProfile" class="home-avatar home-entrance" type="button" aria-label="Open profile">
          <span id="homeInitial">V</span>
        </button>
      </header>

      <section class="home-section home-gems-section" aria-labelledby="bestPhotosTitle">
        <div class="home-section-heading">
          <h2 id="bestPhotosTitle" class="home-section-title home-entrance">Your best photos right now</h2>
          <button id="seeAllGems" class="home-section-link home-entrance" type="button">See all 16</button>
        </div>
        <div id="gemsCarousel" class="gems-carousel home-scroll" aria-label="Your five highlighted photos">
          ${GEMS.map(
            (gem, index) => `
              <button
                class="home-gem-card home-entrance"
                type="button"
                data-gem-id="${gem.id}"
                aria-label="${gem.label}, ${gem.meta}"
                style="--home-delay: ${150 + index * 35}ms"
              >
                ${sceneMarkup(gem.scene)}
                <span class="gem-caption">
                  <strong>${gem.label}</strong>
                  <small>${gem.meta}</small>
                </span>
              </button>
            `,
          ).join("")}
        </div>
        <div id="gemDots" class="gem-dots" aria-hidden="true">
          ${GEMS.map(
            (_, index) => `<span class="gem-dot${index === 0 ? " is-active" : ""}"></span>`,
          ).join("")}
        </div>
        <span id="gemCarouselStatus" class="sr-only" aria-live="polite">Photo 1 of 5</span>
      </section>

      <section class="home-section home-create-section" aria-labelledby="createTitle">
        <h2 id="createTitle" class="home-section-title home-entrance">What would you like to create?</h2>
        <div class="home-action-grid">
          ${ACTIONS.map(
            (action, index) => `
              <button
                class="home-action home-entrance"
                type="button"
                data-home-action="${action.label}"
                style="--home-delay: ${280 + index * 35}ms"
              >
                ${actionIcon(action.icon)}
                <span>${action.label}</span>
              </button>
            `,
          ).join("")}
        </div>
      </section>

      <section class="home-section home-draft-section" aria-labelledby="draftTitle">
        <h2 id="draftTitle" class="home-section-title home-entrance">Pick up where you left off</h2>
        <button id="openDraft" class="home-draft home-entrance" type="button">
          <span class="draft-stack" aria-hidden="true">
            <span class="draft-photo draft-photo-back">${sceneMarkup("beach")}</span>
            <span class="draft-photo draft-photo-front">${sceneMarkup("portrait")}</span>
          </span>
          <span class="draft-copy">
            <strong>Summer Dump</strong>
            <small>Draft · 8 of 12 photos · Euro Summer</small>
          </span>
          <span class="draft-continue">Continue</span>
        </button>
      </section>

      <section class="home-section home-hidden-section" aria-labelledby="hiddenGemTitle">
        <div class="home-section-heading">
          <h2 id="hiddenGemTitle" class="home-section-title home-entrance">Hidden gem of the day</h2>
          <span class="home-section-meta home-entrance">New every day</span>
        </div>
        <button id="openHiddenGem" class="hidden-gem home-entrance" type="button">
          ${sceneMarkup("city")}
          <span class="hidden-gem-caption">
            <span class="hidden-gem-copy">
              <strong>You forgot about this one</strong>
              <small>Chicago · June 14 · never posted</small>
            </span>
            <span class="hidden-gem-action">Do something with it</span>
          </span>
        </button>
      </section>

      <section class="home-section home-trends-section" aria-labelledby="trendsTitle">
        <div class="home-section-heading home-section-heading-padded">
          <h2 id="trendsTitle" class="home-section-title home-entrance">Trending vibes this week</h2>
          <button id="discoverVibes" class="home-section-link home-entrance" type="button">Discover</button>
        </div>
        <div class="trend-strip home-scroll" aria-label="Trending aesthetics">
          ${TRENDS.map(
            (trend, index) => `
              <button
                class="trend-card trend-${trend.style} home-entrance"
                type="button"
                data-trend="${trend.name}"
                style="--home-delay: ${360 + index * 35}ms"
              >
                ${trend.name}
              </button>
            `,
          ).join("")}
        </div>
      </section>

      <div class="home-scroll-tail" aria-hidden="true"></div>
    </div>

    <div class="home-bottom-chrome">
      <div class="home-chat-dock">
        <form id="homeChatForm" class="home-chat-form home-entrance">
          <button id="attachPhoto" class="home-chat-icon" type="button" aria-label="Attach a photo">
            <svg viewBox="0 0 18 18" aria-hidden="true">
              <path d="M12.8 5.2 6.6 11.4a1.9 1.9 0 1 0 2.7 2.7l6-6a3.6 3.6 0 0 0-5.1-5.1L4 9.2a5.3 5.3 0 0 0 7.5 7.5l5-5"></path>
            </svg>
          </button>
          <label class="sr-only" for="homeChatInput">Ask Gems about your photos</label>
          <input
            id="homeChatInput"
            type="text"
            autocomplete="off"
            enterkeyhint="send"
            placeholder="Ask anything about your photos…"
          />
          <button id="homeChatSend" class="home-chat-send" type="submit" aria-label="Send" disabled>
            <svg viewBox="0 0 15 15" aria-hidden="true">
              <path d="M7.5 12.5v-10M3.5 6.5l4-4 4 4"></path>
            </svg>
          </button>
        </form>
        <span id="homeChatStatus" class="sr-only" aria-live="polite"></span>
      </div>

      ${appTabBarMarkup("Home")}
    </div>
  `;
}

function greetingForHour(hour) {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/**
 * @param {{screen: HTMLElement, mount: HTMLElement, onNavigate?: (tab: string) => void}} options
 */
export function createHomeScreen({ screen, mount, onNavigate = () => {} }) {
  mount.innerHTML = homeMarkup();

  const content = mount.querySelector("#homeContent");
  const greeting = mount.querySelector("#homeGreeting");
  const name = mount.querySelector("#homeGreetingName");
  const initial = mount.querySelector("#homeInitial");
  const profile = mount.querySelector("#homeProfile");
  const carousel = mount.querySelector("#gemsCarousel");
  const dots = [...mount.querySelectorAll(".gem-dot")];
  const carouselStatus = mount.querySelector("#gemCarouselStatus");
  const chatForm = mount.querySelector("#homeChatForm");
  const chatInput = mount.querySelector("#homeChatInput");
  const chatSend = mount.querySelector("#homeChatSend");
  const chatStatus = mount.querySelector("#homeChatStatus");
  let activeGem = 0;
  let scrollFrame = 0;
  let activated = false;

  function updateCarousel() {
    scrollFrame = 0;
    const card = carousel.querySelector(".home-gem-card");
    if (!card) return;
    const nextIndex = Math.max(
      0,
      Math.min(GEMS.length - 1, Math.round(carousel.scrollLeft / (card.offsetWidth + 12))),
    );
    if (nextIndex === activeGem) return;
    activeGem = nextIndex;
    dots.forEach((dot, index) => dot.classList.toggle("is-active", index === activeGem));
    carouselStatus.textContent = `Photo ${activeGem + 1} of ${GEMS.length}`;
  }

  function queueCarouselUpdate() {
    if (scrollFrame) return;
    scrollFrame = window.requestAnimationFrame(updateCarousel);
  }

  function syncChat() {
    const hasInput = chatInput.value.trim().length > 0;
    chatForm.classList.toggle("has-value", hasInput);
    chatSend.disabled = !hasInput;
  }

  function setChatPrompt(prompt) {
    chatInput.value = prompt;
    syncChat();
    chatInput.focus({ preventScroll: true });
  }

  carousel.addEventListener("scroll", queueCarouselUpdate, { passive: true });
  profile.addEventListener("click", () => {
    homeActions.openProfile();
    onNavigate("Profile");
  });
  mount.querySelector("#seeAllGems").addEventListener("click", homeActions.seeAllGems);
  mount.querySelector("#openDraft").addEventListener("click", homeActions.openDraft);
  mount.querySelector("#openHiddenGem").addEventListener("click", homeActions.openHiddenGem);
  mount.querySelector("#discoverVibes").addEventListener("click", () => {
    homeActions.selectTab("Discover");
    onNavigate("Discover");
  });
  mount.querySelector("#attachPhoto").addEventListener("click", homeActions.attachPhoto);

  mount.querySelectorAll("[data-gem-id]").forEach((button) => {
    button.addEventListener("click", () => homeActions.openGem(Number(button.dataset.gemId)));
  });

  mount.querySelectorAll("[data-home-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.homeAction;
      homeActions.startAction(action);
      setChatPrompt(action);
    });
  });

  mount.querySelectorAll("[data-trend]").forEach((button) => {
    button.addEventListener("click", () => homeActions.openTrend(button.dataset.trend));
  });

  mount.querySelectorAll("[data-app-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      const tab = button.dataset.appTab;
      homeActions.selectTab(tab);
      if (tab === "Discover" || tab === "Photos" || tab === "Profile") {
        onNavigate(tab);
        return;
      }
      if (tab === "Home") syncActiveTab(mount, "Home");
    });
  });

  chatInput.addEventListener("input", syncChat);
  chatForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const prompt = chatInput.value.trim();
    if (!prompt) return;

    chatSend.disabled = true;
    await homeActions.sendPrompt(prompt);
    chatStatus.textContent = `Sent: ${prompt}`;
    chatInput.value = "";
    syncChat();
  });

  syncChat();

  return Object.freeze({
    activate(profileState = {}) {
      const firstName = profileState.name?.trim().split(/\s+/)[0] || "Vish";
      greeting.textContent = greetingForHour(new Date().getHours());
      name.textContent = firstName;
      initial.textContent = firstName.charAt(0).toLocaleUpperCase();
      profile.setAttribute("aria-label", `Open profile for ${firstName}`);
      syncActiveTab(mount, "Home");
      if (activated) return;
      activated = true;
      content.scrollTo({ top: 0, behavior: "auto" });
      carousel.scrollTo({ left: 0, behavior: "auto" });
      activeGem = 0;
      dots.forEach((dot, index) => dot.classList.toggle("is-active", index === 0));
      carouselStatus.textContent = `Photo 1 of ${GEMS.length}`;

      screen.classList.remove("is-entering");
      void screen.offsetWidth;
      screen.classList.add("is-entering");
      window.setTimeout(() => screen.classList.remove("is-entering"), 900);
    },

    resume() {
      syncActiveTab(mount, "Home");
    },

    focusHeading() {
      name.focus({ preventScroll: true });
    },
  });
}
