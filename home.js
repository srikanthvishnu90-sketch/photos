import { homeActions } from "./home-actions.js";
import { appTabBarMarkup, syncActiveTab } from "./app-tabs.js";
import { getSupabase, getSession, recordTasteEvent } from "./gems-supabase.js";
import { pickGemOfTheDay } from "./gems-daily.js";
import { importPhotoFiles, listPhotos } from "./gems-photolib.js";
import { importFromDevice, hasNativeLibrary } from "./gems-native.js";

// Keep in sync with gems-supabase.js, which declares these but does not
// export them (client-safe by design — RLS does the real gatekeeping).
const SUPABASE_URL = "https://hkwkxacvcgorhthwyslx.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_Z8Fw1dZYiqOGUDITzU929A_i2k9wANc";

const CHAT_ENDPOINT = `${SUPABASE_URL}/functions/v1/gems-chat`;
const CHAT_NAVIGATE_DELAY_MS = 900;
const CHAT_TABS = Object.freeze(["Photos", "Studio", "Editor", "Discover"]);
const SIGNED_OUT_REPLY =
  "Sign in to chat with Gems — I can find, build, and edit your photos.";
const CHAT_ERROR_REPLY = "I couldn't think just then — try again.";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const GEMS = Object.freeze([
  { id: 1, label: "Best cover", meta: "Golden hour", scene: "portrait" },
  { id: 2, label: "Best with friends", meta: "Saturday night", scene: "friends" },
  { id: 3, label: "Dark Gym match", meta: "From your vibe", scene: "gym" },
  { id: 4, label: "Best candid", meta: "Downtown", scene: "city" },
  { id: 5, label: "Euro Summer match", meta: "From your vibe", scene: "beach" },
]);

const ACTIONS = Object.freeze([
  { label: "Commitment post", icon: "spark" },
  { label: "Make a photo dump", icon: "stack" },
  { label: "Edit a photo", icon: "edit" },
  { label: "Find my best photos", icon: "search" },
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
        <div class="home-header-actions">
          <button id="homeImport" class="home-import home-entrance" type="button">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 3v7M4.8 6.4 8 3.2l3.2 3.2M3.5 12.5h9"></path>
            </svg>
            <span class="home-import-label">Import</span>
          </button>
          <button id="homeProfile" class="home-avatar home-entrance" type="button" aria-label="Open profile">
            <span id="homeInitial">V</span>
          </button>
        </div>
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
                <span class="gem-sample-tag" aria-hidden="true">Sample</span>
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

      <section class="home-section home-draft-section" aria-labelledby="draftTitle" hidden>
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

      <section class="home-section home-hidden-section" aria-labelledby="hiddenGemTitle" hidden>
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
      <div id="homeReplyStrip" class="home-reply-strip" aria-live="polite" hidden>
        <div class="home-reply-line">
          <p id="homeReplyText" class="home-reply-text"></p>
          <button id="homeReplyClose" class="home-reply-close" type="button" aria-label="Dismiss Gems reply">
            <svg viewBox="0 0 10 10" aria-hidden="true">
              <path d="M1.5 1.5 8.5 8.5M8.5 1.5 1.5 8.5"></path>
            </svg>
          </button>
        </div>
        <div id="homeReplyChips" class="home-reply-chips" hidden></div>
      </div>
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
  const dotsWrap = mount.querySelector("#gemDots");
  let dots = [...mount.querySelectorAll(".gem-dot")];
  const carouselStatus = mount.querySelector("#gemCarouselStatus");
  const seeAllLink = mount.querySelector("#seeAllGems");
  let gemCount = GEMS.length;
  let realGems = false;
  const chatForm = mount.querySelector("#homeChatForm");
  const chatInput = mount.querySelector("#homeChatInput");
  const chatSend = mount.querySelector("#homeChatSend");
  const chatStatus = mount.querySelector("#homeChatStatus");
  const replyStrip = mount.querySelector("#homeReplyStrip");
  const replyText = mount.querySelector("#homeReplyText");
  const replyChips = mount.querySelector("#homeReplyChips");
  const replyClose = mount.querySelector("#homeReplyClose");
  const hiddenGemBtn = mount.querySelector("#openHiddenGem");
  let activeGem = 0;
  let scrollFrame = 0;
  let activated = false;
  let chatInFlight = false;
  let navigateTimer = 0;
  // The real photo currently backing the Hidden-gem card (null in demo mode),
  // plus the id we last fired a "shown" event for (so we fire it once per gem).
  let hiddenGemPhotoId = null;
  let hiddenGemShownFor = null;
  // The signed-in user's chosen aesthetics, fetched once per activation.
  let aestheticsPromise = null;

  function updateCarousel() {
    scrollFrame = 0;
    const card = carousel.querySelector(".home-gem-card");
    if (!card) return;
    const nextIndex = Math.max(
      0,
      Math.min(gemCount - 1, Math.round(carousel.scrollLeft / (card.offsetWidth + 12))),
    );
    if (nextIndex === activeGem) return;
    activeGem = nextIndex;
    dots.forEach((dot, index) => dot.classList.toggle("is-active", index === activeGem));
    carouselStatus.textContent = `Photo ${activeGem + 1} of ${gemCount}`;
  }

  // An honest label for a real imported photo — the ranking category once it's
  // computed, otherwise a plain, truthful line (never a fabricated "Best cover"
  // on an unranked photo).
  // Utility images (screenshots, documents, memes) are things people SAVE, not
  // photos worth showing off — never "best photos".
  const UTILITY_TYPES = new Set(["screenshot", "document", "meme"]);
  function isUtility(record) {
    return UTILITY_TYPES.has(record.derived?.passA?.photo_type);
  }

  function gemLabelFor(record) {
    const passA = record.derived?.passA;
    // A genuine smile or laughter is the truest "best photo" signal — lead with it.
    if (passA?.smile === "laughing") return { label: "Full of life", meta: "Someone laughing" };
    if (passA?.smile === "genuine") return { label: "A real smile", meta: "This one's alive" };
    const cat = passA?.best_for?.[0];
    const map = {
      cover: ["Best cover", "Sharp & clean"],
      "dump-slot": ["Great in a dump", "Your vibe"],
      dating: ["Dating pick", "Strong solo shot"],
      "profile-pic": ["Profile-worthy", "Clear & confident"],
    };
    if (cat && map[cat]) return { label: map[cat][0], meta: map[cat][1] };
    if (passA?.appeal >= 4) return { label: "A moment", meta: "Worth sharing" };
    if (record.gem) return { label: "Ranked gem", meta: "One of your best" };
    return { label: "Just imported", meta: "Tap to do something with it" };
  }

  // Swap the placeholder scenes for the user's real best photos once a library
  // exists. Rebuilds the cards, dots, and "See all" count from the shared store.
  async function refreshGemsCarousel() {
    try {
      const all = await listPhotos();
      if (!Array.isArray(all) || all.length === 0) {
        // Honest first-run state: no invented "best photos", just an invitation
        // to import. (No more Sample cards masquerading as the user's library.)
        realGems = false;
        gemCount = 0;
        carousel.innerHTML = `
          <button class="home-gem-empty" type="button">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 7v10M7 12h10"></path>
              <rect x="3.5" y="3.5" width="17" height="17" rx="5"></rect>
            </svg>
            <span class="home-gem-empty-title">Import your photos</span>
            <span class="home-gem-empty-sub">Gems finds your best ones automatically</span>
          </button>`;
        dotsWrap.hidden = true;
        if (seeAllLink) seeAllLink.hidden = true;
        carouselStatus.textContent = "No photos imported yet";
        carousel
          .querySelector(".home-gem-empty")
          ?.addEventListener("click", () => importButton.click());
        return;
      }
      if (seeAllLink) seeAllLink.hidden = false;
      // Once photos are analyzed, keep utility images (screenshots/docs) out of
      // "best photos" — but only when at least one real photo survives, so a
      // library that is ALL screenshots still shows something rather than empty.
      const described = all.filter((record) => record.derived?.passA);
      const realOnly = all.filter((record) => !isUtility(record));
      const pool = described.length && realOnly.length ? realOnly : all;
      // Rank by emotional appeal first (from the analyst), then the on-device
      // gem flag, then raw quality — so a smiling candid beats a sharp screenshot.
      const appealOf = (record) => record.derived?.passA?.appeal ?? (record.gem ? 3.5 : 0);
      const ranked = [...pool].sort(
        (a, b) =>
          appealOf(b) - appealOf(a) ||
          Number(b.gem) - Number(a.gem) ||
          (b.metrics?.quality ?? 0) - (a.metrics?.quality ?? 0),
      );
      const top = ranked.slice(0, 6);
      realGems = true;
      gemCount = top.length;
      carousel.innerHTML = top
        .map((record, index) => {
          const { label, meta } = gemLabelFor(record);
          return `
            <button class="home-gem-card home-entrance" type="button" data-gem-id="${escapeHtml(record.id)}" aria-label="${escapeHtml(label)}, ${escapeHtml(meta)}" style="--home-delay: ${150 + index * 35}ms">
              <img class="home-gem-photo" src="${escapeHtml(record.url)}" alt="" loading="lazy" decoding="async" />
              <span class="gem-caption"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(meta)}</small></span>
            </button>`;
        })
        .join("");
      dotsWrap.innerHTML = top
        .map((_, index) => `<span class="gem-dot${index === 0 ? " is-active" : ""}"></span>`)
        .join("");
      dots = [...dotsWrap.querySelectorAll(".gem-dot")];
      dotsWrap.hidden = top.length < 2;
      if (seeAllLink) seeAllLink.textContent = `See all ${all.length}`;
      activeGem = 0;
      carousel.scrollTo({ left: 0, behavior: "auto" });
      carouselStatus.textContent = `Photo 1 of ${gemCount}`;
      // Rewire the new cards to open the photo.
      carousel.querySelectorAll("[data-gem-id]").forEach((card) => {
        card.addEventListener("click", () => {
          homeActions.openGem(card.dataset.gemId);
          onNavigate("Photos", {});
        });
      });
    } catch (error) {
      console.info("Gems carousel stayed in sample mode", error);
    }
  }

  function queueCarouselUpdate() {
    if (scrollFrame) return;
    scrollFrame = window.requestAnimationFrame(updateCarousel);
  }

  function syncChat() {
    const hasInput = chatInput.value.trim().length > 0;
    chatForm.classList.toggle("has-value", hasInput);
    chatSend.disabled = chatInFlight || !hasInput;
  }

  function setChatPrompt(prompt) {
    chatInput.value = prompt;
    syncChat();
    chatInput.focus({ preventScroll: true });
  }

  function hideReply() {
    replyStrip.hidden = true;
    replyText.textContent = "";
    replyChips.innerHTML = "";
    replyChips.hidden = true;
  }

  // The dock reply: one short assistant line plus up to two clarify chips.
  // Text lands via textContent and chip labels/values via escapeHtml, so
  // model output can never inject markup.
  function showReply(text, clarify) {
    try {
      replyText.textContent = String(text);
      const chips = (Array.isArray(clarify) ? clarify : [])
        .filter(
          (chip) =>
            chip && typeof chip.label === "string" && typeof chip.value === "string",
        )
        .slice(0, 2);
      replyChips.innerHTML = chips
        .map(
          (chip) => `
            <button class="home-reply-chip" type="button" data-chip-value="${escapeHtml(chip.value)}">
              ${escapeHtml(chip.label)}
            </button>
          `,
        )
        .join("");
      replyChips.hidden = chips.length === 0;
      replyStrip.hidden = false;
    } catch (error) {
      console.info("Gems reply strip unavailable", error);
    }
  }

  // Any navigation away from Home also dismisses the dock reply.
  function goTo(tab, payload) {
    window.clearTimeout(navigateTimer);
    hideReply();
    onNavigate(tab, payload);
  }

  function loadAesthetics() {
    if (!aestheticsPromise) {
      aestheticsPromise = (async () => {
        try {
          const supabase = await getSupabase();
          const session = await getSession();
          if (!supabase || !session) return [];
          const { data } = await supabase
            .from("profile_aesthetics")
            .select("label")
            .eq("profile_id", session.user.id)
            .order("position");
          return (data ?? [])
            .map((row) => row?.label)
            .filter((label) => typeof label === "string");
        } catch (error) {
          console.info("Aesthetics unavailable for chat", error);
          return [];
        }
      })();
    }
    return aestheticsPromise;
  }

  function chatActionPayload(data) {
    const action = data?.action;
    if (!action || !CHAT_TABS.includes(action.navigate)) return null;
    let payload =
      action.payload && typeof action.payload === "object" ? { ...action.payload } : {};
    if (
      action.navigate === "Photos" &&
      data?.intent === "find" &&
      data?.rankRequest &&
      payload.rank == null
    ) {
      payload.rank = data.rankRequest;
    }
    if (
      action.navigate === "Editor" &&
      typeof data?.editInstruction === "string" &&
      data.editInstruction &&
      payload.instruction == null
    ) {
      payload = { mode: "describe", instruction: data.editInstruction, ...payload };
    }
    return { navigate: action.navigate, payload };
  }

  // Does this chat message read as a direct edit instruction (vs. find/build/
  // chat)? Conservative on purpose — ambiguous asks fall through to the server
  // orchestrator. Leads with an edit verb, or clearly names an edit operation.
  const EDIT_LEAD_RE =
    /^(make (?:it|this|the photo|my photo)\b|edit\b|remove\b|erase\b|delete\b|crop\b|rotate\b|flip\b|mirror\b|brighten\b|darken\b|enhance\b|retouch\b|blur\b|sharpen\b|colou?rize\b|restore\b|straighten\b)/i;
  const EDIT_WORD_RE =
    /\b(brighter|darker|more contrast|less contrast|warmer|cooler|saturat\w*|vibran\w*|black and white|b&w|grayscale|greyscale|sharpen|vignette|add grain|blur the background|remove the background|remove background|erase|crop it|crop this|rotate|retouch|auto[- ]?enhance|colou?rize)\b/i;
  function looksLikeEdit(text) {
    const t = String(text || "").toLowerCase();
    // Don't hijack find/build requests that happen to contain an edit-ish word.
    if (/\b(best|find|show me|rank|dump|carousel|collage|template|which)\b/.test(t)) {
      return false;
    }
    return EDIT_LEAD_RE.test(t) || EDIT_WORD_RE.test(t);
  }

  // Which photo should a Home-chat edit act on? Prefer today's hidden gem (the
  // one already surfaced on screen), else the most recent import. Null when the
  // library is empty — the editor then just prefills the instruction.
  async function editTargetPhotoId() {
    if (hiddenGemPhotoId) return hiddenGemPhotoId;
    try {
      const all = await listPhotos();
      if (!Array.isArray(all) || !all.length) return null;
      // listPhotos already returns newest-first (sorted by addedAt).
      return all[0]?.id ?? null;
    } catch {
      return null;
    }
  }

  // The real Gems orchestrator call. Every failure path degrades to a gentle
  // strip message — this function never throws and always re-enables send.
  async function sendChatMessage(message) {
    const prompt = String(message ?? "").trim();
    if (!prompt || chatInFlight) return;

    window.clearTimeout(navigateTimer);
    hideReply();

    // Fast path: an obvious edit instruction ("make it brighter", "remove the
    // background", "crop this") opens the editor on the user's photo and applies
    // it right away — no server round-trip, so it works offline and in demo too.
    if (looksLikeEdit(prompt)) {
      const targetId = await editTargetPhotoId();
      if (targetId) {
        void homeActions.sendPrompt(prompt);
        chatInput.value = "";
        syncChat();
        showReply("Opening the editor to make that change…");
        goTo("Editor", { mode: "describe", instruction: prompt, photoId: targetId });
        return;
      }
      // No photos yet — fall through so the user gets a helpful reply.
    }

    chatInFlight = true;
    chatSend.disabled = true;
    void homeActions.sendPrompt(prompt);
    chatStatus.textContent = `Sent: ${prompt}`;
    chatInput.value = "";

    try {
      const session = await getSession();
      if (!session) {
        showReply(SIGNED_OUT_REPLY, null);
        return;
      }

      const userAesthetics = await loadAesthetics();
      const response = await fetch(CHAT_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          apikey: SUPABASE_PUBLISHABLE_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message: prompt, userAesthetics, screen: "Home" }),
      });
      if (response.status === 402) {
        showReply("You've used all your free chats this month — Gems Plus unlocks more.");
        return;
      }
      if (!response.ok) throw new Error(`gems-chat ${response.status}`);
      const data = await response.json();

      const reply =
        typeof data?.reply === "string" && data.reply.trim() ? data.reply : "Done.";
      showReply(reply, data?.clarify);
      homeActions.chatReplyShown(typeof data?.intent === "string" ? data.intent : "chat");

      const routed = chatActionPayload(data);
      if (routed) {
        // An edit routed to the Editor needs a photo to act on. If the server
        // didn't name one, target the photo the user is most likely to mean:
        // today's hidden gem, else their most recent import.
        if (
          routed.navigate === "Editor" &&
          routed.payload?.instruction &&
          routed.payload.photoId == null
        ) {
          const targetId = await editTargetPhotoId();
          if (targetId) routed.payload.photoId = targetId;
        }
        navigateTimer = window.setTimeout(
          () => goTo(routed.navigate, routed.payload),
          CHAT_NAVIGATE_DELAY_MS,
        );
      }
    } catch (error) {
      console.info("Gems chat unavailable", error);
      showReply(CHAT_ERROR_REPLY, null);
    } finally {
      chatInFlight = false;
      syncChat();
    }
  }

  // Strip the shared lead off the reason so it reads cleanly under the fixed
  // "You forgot about this one" heading, leaving just the detail sentence.
  function hiddenGemDetail(reason) {
    const line = String(reason ?? "").trim();
    if (!line) return "A gem you never posted";
    const stripped = line.replace(/^you forgot about this one\s*[—–-]\s*/i, "").trim();
    return stripped || line;
  }

  // Real-library mode: swap the Hidden-gem card's demo CSS scene for the actual
  // photo of the day plus its reason. When there's no real gem (empty library,
  // signed out, private browsing) the demo scene is left byte-identical.
  // Text lands via textContent, so nothing here can inject markup. Never throws.
  async function refreshHiddenGem() {
    if (!hiddenGemBtn) return;
    const hiddenSection = hiddenGemBtn.closest(".home-hidden-section");
    try {
      const result = await pickGemOfTheDay();
      if (!result?.record?.url) {
        // No real gem yet → hide the section rather than show an invented one.
        if (hiddenSection) hiddenSection.hidden = true;
        hiddenGemPhotoId = null;
        return;
      }
      if (hiddenSection) hiddenSection.hidden = false;
      const { record, reason } = result;
      hiddenGemPhotoId = record.id;

      let img = hiddenGemBtn.querySelector(".hidden-gem-photo");
      if (!img) {
        img = document.createElement("img");
        img.className = "hidden-gem-photo";
        img.alt = "";
        img.setAttribute("aria-hidden", "true");
        const scene = hiddenGemBtn.querySelector(".home-scene");
        if (scene) scene.replaceWith(img);
        else hiddenGemBtn.prepend(img);
      }
      img.src = record.url;

      const strong = hiddenGemBtn.querySelector(".hidden-gem-copy strong");
      const small = hiddenGemBtn.querySelector(".hidden-gem-copy small");
      if (strong) strong.textContent = "You forgot about this one";
      if (small) small.textContent = hiddenGemDetail(reason);

      if (hiddenGemShownFor !== record.id) {
        hiddenGemShownFor = record.id;
        try {
          recordTasteEvent("gem_of_day_shown", { photoId: record.id });
        } catch (error) {
          console.info("gem_of_day_shown skipped", error);
        }
      }
    } catch (error) {
      console.info("Hidden gem of the day unavailable", error);
    }
  }

  carousel.addEventListener("scroll", queueCarouselUpdate, { passive: true });
  profile.addEventListener("click", () => {
    homeActions.openProfile();
    goTo("Profile");
  });
  mount.querySelector("#seeAllGems").addEventListener("click", homeActions.seeAllGems);
  mount.querySelector("#openDraft").addEventListener("click", () => {
    homeActions.openDraft();
    goTo("Studio", { projectId: 1 });
  });
  hiddenGemBtn.addEventListener("click", () => {
    homeActions.openHiddenGem();
    // Real gem → open it in the editor ("do something with it"). Demo mode
    // keeps its original telemetry-only behavior.
    if (hiddenGemPhotoId) goTo("Editor", { mode: "describe", photoId: hiddenGemPhotoId });
  });
  mount.querySelector("#discoverVibes").addEventListener("click", () => {
    homeActions.selectTab("Discover");
    goTo("Discover");
  });
  // Real photo import, straight from Home. Goes through the device boundary:
  // the native iOS shell scans the whole camera roll; the web opens the
  // multi-file picker. Progress shows on the button, then the carousel and the
  // hidden gem refresh to reflect the new library.
  const importButton = mount.querySelector("#homeImport");
  const importLabel = importButton.querySelector(".home-import-label");
  let importing = false;

  async function runImport() {
    if (importing) return;
    importing = true;
    homeActions.attachPhoto();
    importButton.classList.add("is-busy");
    importButton.disabled = true;
    let added = [];
    let files = [];
    try {
      files = await importFromDevice({
        // Native enumeration reports scan progress before the on-device analysis.
        onProgress: ({ done, total }) => {
          importLabel.textContent = total ? `${done}/${total}` : "Scanning…";
        },
      });
      if (files.length) {
        added = await importPhotoFiles(files, {
          onProgress: ({ done, total }) => {
            importLabel.textContent = `${done}/${total}`;
          },
        });
      }
    } catch (error) {
      console.info("Home import failed", error);
      if (error?.code === "denied") {
        showReply("Gems needs photo access to find your best shots — enable it in Settings.");
      }
    }
    importLabel.textContent = "Import";
    importButton.classList.remove("is-busy");
    importButton.disabled = false;
    importing = false;
    if (!files.length) return; // user cancelled the picker — say nothing
    await refreshGemsCarousel();
    void refreshHiddenGem();
    if (!added || added.length === 0) {
      showReply("Those didn't import — try photos straight from your library.");
      return;
    }
    const gems = added.filter((record) => record.gem).length;
    showReply(
      gems > 0
        ? `Imported ${added.length} photos — ${gems} already stand out as gems. Ask me to rank them.`
        : `Imported ${added.length} photos. Ask me for your best ones and I'll rank them.`,
    );
    recordTasteEvent("home_import_completed", {
      added: added.length,
      gems,
      source: hasNativeLibrary() ? "native" : "web",
    });
  }

  importButton.addEventListener("click", runImport);
  // The chat dock's paperclip now imports too, rather than being a dead stub.
  mount.querySelector("#attachPhoto").addEventListener("click", runImport);
  replyClose.addEventListener("click", () => {
    window.clearTimeout(navigateTimer);
    hideReply();
  });
  replyChips.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-chip-value]");
    if (!chip) return;
    void sendChatMessage(chip.dataset.chipValue);
  });

  mount.querySelectorAll("[data-gem-id]").forEach((button) => {
    button.addEventListener("click", () => homeActions.openGem(Number(button.dataset.gemId)));
  });

  mount.querySelectorAll("[data-home-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.homeAction;
      homeActions.startAction(action);
      if (action === "Commitment post") {
        void import("./gems-commitment-view.js").then((m) => m.openCommitmentStudio());
        return;
      }
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
      if (tab === "Discover" || tab === "Photos" || tab === "Studio" || tab === "Profile") {
        goTo(tab);
        return;
      }
      if (tab === "Home") syncActiveTab(mount, "Home");
    });
  });

  chatInput.addEventListener("input", syncChat);
  chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void sendChatMessage(chatInput.value);
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
      // Each activation starts a fresh chat context: refetch aesthetics on
      // the next send and clear any reply left over from a previous session.
      aestheticsPromise = null;
      window.clearTimeout(navigateTimer);
      hideReply();
      // Recompute today's hidden gem each activation (rotates daily; upgrades
      // the demo card to a real photo once a library exists).
      void refreshHiddenGem();
      void refreshGemsCarousel();
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
      // Returning to Home (e.g. after importing photos) recomputes the gem —
      // the first activate() ran on an empty library.
      void refreshHiddenGem();
      void refreshGemsCarousel();
    },

    focusHeading() {
      name.focus({ preventScroll: true });
    },
  });
}
