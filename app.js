import { authActions } from "./auth-actions.js";
import { createOnboardingFlow } from "./onboarding.js";
import { createHomeScreen } from "./home.js";
import { createDiscoverScreen } from "./discover.js";
import { createPhotosScreen } from "./photos.js";
import { createEditorScreen } from "./editor.js";
import { createStudioScreen } from "./studio.js";
import { createProfileScreen } from "./profile.js";

const SPLASH_DURATION_MS = 2600;
const SCREEN_FADE_MS = 400;
const DONE_HANDOFF_MS = 1800;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const app = document.querySelector("#gemsApp");
const splashScreen = document.querySelector("#splashScreen");
const loginScreen = document.querySelector("#loginScreen");
const loginHeadline = document.querySelector("#loginHeadline");
const loginScroll = document.querySelector("#loginScroll");
const authOptions = document.querySelector("#authOptions");
const emailForm = document.querySelector("#emailForm");
const emailInput = document.querySelector("#emailInput");
const emailContinueButton = document.querySelector("#emailContinueButton");
const emailOptionButton = document.querySelector("#emailOptionButton");
const backToOptionsButton = document.querySelector("#backToOptionsButton");
const onboardingScreen = document.querySelector("#onboardingScreen");
const doneScreen = document.querySelector("#doneScreen");
const doneHeadline = document.querySelector("#doneHeadline");
const doneName = document.querySelector("#doneName");
const homeScreen = document.querySelector("#homeScreen");
const discoverScreen = document.querySelector("#discoverScreen");
const photosScreen = document.querySelector("#photosScreen");
const editorScreen = document.querySelector("#editorScreen");
const studioScreen = document.querySelector("#studioScreen");
const profileScreen = document.querySelector("#profileScreen");

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let splashFinished = false;
let onboardingStarted = false;
let onboardingFinished = false;
let homeShown = false;
let activeAuthenticatedScreen = null;
let splashTimer;
let homeTimer;
let routeTimer;
let authenticatedProfileState = {};

const onboardingFlow = createOnboardingFlow({
  screen: onboardingScreen,
  stepRoot: document.querySelector("#onboardingStep"),
  scrollRoot: document.querySelector("#onboardingScroll"),
  backButton: document.querySelector("#onboardingBack"),
  progress: document.querySelector("#onboardingProgress"),
  onComplete: showDone,
});

const homeController = createHomeScreen({
  screen: homeScreen,
  mount: document.querySelector("#homeMount"),
  onNavigate: navigateAuthenticated,
});

const discoverController = createDiscoverScreen({
  screen: discoverScreen,
  mount: document.querySelector("#discoverMount"),
  onNavigate: navigateAuthenticated,
});

const photosController = createPhotosScreen({
  screen: photosScreen,
  mount: document.querySelector("#photosMount"),
  onNavigate: navigateAuthenticated,
});

const editorController = createEditorScreen({
  screen: editorScreen,
  mount: document.querySelector("#editorMount"),
  onNavigate: navigateAuthenticated,
});

const studioController = createStudioScreen({
  screen: studioScreen,
  mount: document.querySelector("#studioMount"),
  onNavigate: navigateAuthenticated,
});

const profileController = createProfileScreen({
  screen: profileScreen,
  mount: document.querySelector("#profileMount"),
  onNavigate: navigateAuthenticated,
});

function syncAppHeight() {
  const height = window.visualViewport?.height ?? window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${Math.round(height)}px`);
}

function syncThemeColor(token = "--color-petal") {
  const color = getComputedStyle(document.documentElement)
    .getPropertyValue(token)
    .trim();
  document.querySelector('meta[name="theme-color"]').setAttribute("content", color);
}

function focusLoginHeading() {
  loginHeadline.focus({ preventScroll: true });
}

function showLogin() {
  if (splashFinished) return;
  splashFinished = true;
  window.clearTimeout(splashTimer);

  splashScreen.classList.remove("is-active");
  splashScreen.setAttribute("aria-hidden", "true");
  splashScreen.removeAttribute("tabindex");
  loginScreen.classList.add("is-active");
  loginScreen.setAttribute("aria-hidden", "false");
  syncThemeColor("--color-white");

  const transitionDelay = reducedMotion.matches ? 0 : SCREEN_FADE_MS;
  window.setTimeout(() => {
    splashScreen.hidden = true;
    focusLoginHeading();
  }, transitionDelay);
}

function handleSplashKeydown(event) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  showLogin();
}

function isValidEmail(value) {
  return EMAIL_PATTERN.test(value.trim());
}

function syncEmailState() {
  const value = emailInput.value;
  const valid = isValidEmail(value);
  emailInput.classList.toggle("has-value", value.length > 0);
  emailContinueButton.disabled = !valid;
  emailInput.setAttribute("aria-invalid", valid || value.length === 0 ? "false" : "true");
}

function keepEmailVisible() {
  if (document.activeElement !== emailInput) return;
  emailInput.scrollIntoView({
    block: "center",
    behavior: reducedMotion.matches ? "auto" : "smooth",
  });
}

function showOnboarding() {
  if (onboardingStarted) return;
  onboardingStarted = true;
  emailInput.blur();

  loginScreen.classList.remove("is-active");
  loginScreen.setAttribute("aria-hidden", "true");
  onboardingScreen.hidden = false;
  onboardingScreen.classList.add("is-active");
  onboardingScreen.setAttribute("aria-hidden", "false");
  onboardingFlow.start();
  syncThemeColor("--color-white");

  const transitionDelay = reducedMotion.matches ? 0 : SCREEN_FADE_MS;
  window.setTimeout(() => {
    loginScreen.hidden = true;
  }, transitionDelay);
}

function showDone(state) {
  if (onboardingFinished) return;
  onboardingFinished = true;

  const name = state.name.trim().split(/\s+/)[0] || "friend";
  doneName.textContent = name;
  onboardingScreen.classList.remove("is-active");
  onboardingScreen.setAttribute("aria-hidden", "true");
  doneScreen.hidden = false;
  doneScreen.classList.add("is-active");
  doneScreen.setAttribute("aria-hidden", "false");
  syncThemeColor("--color-petal");

  const transitionDelay = reducedMotion.matches ? 0 : SCREEN_FADE_MS;
  window.setTimeout(() => {
    onboardingScreen.hidden = true;
    doneHeadline.focus({ preventScroll: true });
  }, transitionDelay);

  homeTimer = window.setTimeout(
    () => showHome(state),
    reducedMotion.matches ? 900 : DONE_HANDOFF_MS,
  );
}

function showHome(state = {}) {
  if (homeShown) return;
  homeShown = true;
  authenticatedProfileState = { ...state };
  activeAuthenticatedScreen = "Home";
  window.clearTimeout(homeTimer);

  doneScreen.classList.remove("is-active");
  doneScreen.setAttribute("aria-hidden", "true");
  homeScreen.hidden = false;
  homeScreen.classList.add("is-active");
  homeScreen.setAttribute("aria-hidden", "false");
  homeController.activate(state);
  syncThemeColor("--color-white");

  const transitionDelay = reducedMotion.matches ? 0 : SCREEN_FADE_MS;
  window.setTimeout(() => {
    doneScreen.hidden = true;
    homeController.focusHeading();
  }, transitionDelay);
}

async function finishAuth(authCall) {
  await authCall();
  showOnboarding();
}

function enterEmailMode() {
  authOptions.hidden = true;
  authOptions.setAttribute("aria-hidden", "true");
  emailForm.hidden = false;
  emailForm.setAttribute("aria-hidden", "false");

  window.requestAnimationFrame(() => {
    emailInput.focus({ preventScroll: true });
    window.setTimeout(keepEmailVisible, 180);
  });
}

function transitionAuthenticated(targetName, payload = {}) {
  if (!homeShown || activeAuthenticatedScreen === targetName) return;
  const routes = {
    Home: { screen: homeScreen, controller: homeController },
    Discover: { screen: discoverScreen, controller: discoverController },
    Photos: { screen: photosScreen, controller: photosController },
    Editor: { screen: editorScreen, controller: editorController },
    Studio: { screen: studioScreen, controller: studioController },
    Profile: { screen: profileScreen, controller: profileController },
  };
  const source = routes[activeAuthenticatedScreen];
  const target = routes[targetName];
  if (!source || !target) return;

  activeAuthenticatedScreen = targetName;
  window.clearTimeout(routeTimer);
  source.controller.deactivate?.();
  source.screen.classList.remove("is-active");
  source.screen.setAttribute("aria-hidden", "true");
  target.screen.hidden = false;
  target.screen.classList.add("is-active");
  target.screen.setAttribute("aria-hidden", "false");
  if (targetName === "Home") target.controller.resume();
  else if (targetName === "Profile") target.controller.activate(authenticatedProfileState);
  else target.controller.activate(payload);
  syncThemeColor("--color-white");

  const transitionDelay = reducedMotion.matches ? 0 : SCREEN_FADE_MS;
  routeTimer = window.setTimeout(() => {
    source.screen.hidden = true;
    target.controller.focusHeading();
  }, transitionDelay);
}

function navigateAuthenticated(tab, payload = {}) {
  if (
    tab === "Home" ||
    tab === "Discover" ||
    tab === "Photos" ||
    tab === "Editor" ||
    tab === "Studio" ||
    tab === "Profile"
  ) {
    transitionAuthenticated(tab, payload);
  }
}

function leaveEmailMode() {
  emailInput.blur();
  emailForm.hidden = true;
  emailForm.setAttribute("aria-hidden", "true");
  authOptions.hidden = false;
  authOptions.setAttribute("aria-hidden", "false");
  loginScroll.scrollTo({ top: 0, behavior: "auto" });
  emailOptionButton.focus({ preventScroll: true });
}

async function handleEmailSubmit(event) {
  event.preventDefault();
  const email = emailInput.value.trim();
  if (!isValidEmail(email)) return;
  await finishAuth(() => authActions.requestEmailOtp(email));
}

document.querySelector("#appleButton").addEventListener("click", () => {
  void finishAuth(() => authActions.signInWithApple());
});

document.querySelector("#googleButton").addEventListener("click", () => {
  void finishAuth(() => authActions.signInWithGoogle());
});

splashScreen.addEventListener("click", showLogin);
splashScreen.addEventListener("keydown", handleSplashKeydown);
emailOptionButton.addEventListener("click", enterEmailMode);
backToOptionsButton.addEventListener("click", leaveEmailMode);
emailInput.addEventListener("input", syncEmailState);
emailInput.addEventListener("focus", () => window.setTimeout(keepEmailVisible, 180));
emailForm.addEventListener("submit", handleEmailSubmit);

document.querySelectorAll("[data-legal]").forEach((button) => {
  button.addEventListener("click", () => {
    // TODO: route to the matching legal document when URLs are available.
  });
});

window.addEventListener("resize", syncAppHeight);
window.visualViewport?.addEventListener("resize", () => {
  syncAppHeight();
  window.setTimeout(keepEmailVisible, 50);
});

syncAppHeight();
syncThemeColor();
syncEmailState();
splashTimer = window.setTimeout(showLogin, SPLASH_DURATION_MS);

// Keep this reference intentional: it makes the app-height owner explicit and
// prevents accidental garbage collection in embedded WebViews.
void app;
