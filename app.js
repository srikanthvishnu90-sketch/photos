import { authActions } from "./auth-actions.js";
import { getSession, getSupabase, waitForSession } from "./gems-supabase.js";
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
const otpForm = document.querySelector("#otpForm");
const otpInput = document.querySelector("#otpInput");
const otpEmail = document.querySelector("#otpEmail");
const otpError = document.querySelector("#otpError");
const otpVerifyButton = document.querySelector("#otpVerifyButton");
const otpResendButton = document.querySelector("#otpResendButton");
const backToEmailButton = document.querySelector("#backToEmailButton");
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
// Filled while the splash plays if a Supabase session already exists
// (returning visit or OAuth redirect); null keeps the demo login flow.
let restoredProfile = null;
// Set when a session exists but onboarding isn't finished (new Google/email
// signup) — routes to onboarding instead of the login screen.
let pendingOnboarding = null;
// Set when an OAuth return came back without a usable session (provider error,
// or the sign-in was declined) — show the login screen with a note, never sit
// on the splash.
let oauthFailed = false;
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
  const vv = window.visualViewport;
  const height = vv?.height ?? window.innerHeight;
  const offset = vv?.offsetTop ?? 0;
  const root = document.documentElement.style;
  // The app (.gems-app) is sized to visualViewport.height and shifted by
  // visualViewport.offsetTop, so it always equals the visible area above the
  // keyboard — the composer docks on the keyboard and nothing else moves.
  root.setProperty("--app-height", `${Math.round(height)}px`);
  root.setProperty("--app-offset", `${Math.round(offset)}px`);
  // Belt-and-suspenders: the window itself must never hold a scroll offset.
  if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
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

// OAuth (Google) and email OTP both produce a Supabase session. There is no
// separate "reject unknown account" for OAuth — signing in with Google either
// signs an existing user in or creates their account. We tell the two apart by
// whether their profile finished onboarding (age_range set):
//   - completed profile  -> existing user  -> straight to Home  (sign in)
//   - session, not done   -> new/unfinished -> onboarding       (sign up)
//   - no session          -> the login screen
// True when this page load is a return from an OAuth provider (Google) — the
// URL carries the PKCE code (or an implicit-flow token / error).
function isOAuthReturn() {
  const hash = window.location.hash || "";
  const query = window.location.search || "";
  return (
    /[?&#](code|access_token|refresh_token|error)=/.test(hash) ||
    /[?&](code|error)=/.test(query)
  );
}

function isOAuthError() {
  return /[?&#]error=/.test(window.location.hash || "") || /[?&]error=/.test(window.location.search || "");
}

function stripOAuthParams() {
  try {
    window.history.replaceState(null, "", window.location.pathname);
  } catch {
    /* ignore */
  }
}

async function checkExistingSession() {
  try {
    const oauthReturn = isOAuthReturn();
    // The provider bounced back with an error (declined, or the app isn't an
    // approved test user yet) — don't wait for a session that won't come.
    if (oauthReturn && isOAuthError()) {
      oauthFailed = true;
      stripOAuthParams();
      return;
    }
    // On an OAuth return the session appears a beat after boot (code exchange),
    // so wait for it rather than reading once and falling through to login.
    const session = oauthReturn ? await waitForSession() : await getSession();
    if (!session) {
      // A code came back but no session materialized — surface it, don't hang.
      if (oauthReturn) {
        oauthFailed = true;
        stripOAuthParams();
      }
      return;
    }
    if (oauthReturn) stripOAuthParams();
    const supabase = await getSupabase();
    const { data } = await supabase
      .from("profiles")
      .select("display_name, gender, age_range")
      .eq("id", session.user.id)
      .maybeSingle();
    const oauthName =
      session.user?.user_metadata?.full_name ||
      session.user?.user_metadata?.name ||
      "";
    if (data?.age_range) {
      // A fully-onboarded account — the only case that skips the login screen
      // (straight to Home).
      restoredProfile = { name: data.display_name };
      // Returning user: if this device has no local library yet (new device or
      // cleared storage), pull their photos down from their account in the
      // background — cross-device sync. Fires photos-imported when done.
      try {
        import("./gems-photolib.js").then((m) => m.hydrateFromCloudIfEmpty()).catch(() => {});
      } catch { /* ignore */ }
    } else if (oauthReturn) {
      // Just authenticated via Google/email but not onboarded yet — continue
      // straight into signup. A leftover incomplete session on a NORMAL boot
      // does NOT auto-jump into onboarding: the app always opens on the login
      // screen unless you're a fully-onboarded returning user.
      pendingOnboarding = { name: (data?.display_name || oauthName || "").trim() };
    }
  } catch (error) {
    console.info("Session restore skipped", error);
  }
}

function restoreToHome() {
  splashScreen.classList.remove("is-active");
  splashScreen.setAttribute("aria-hidden", "true");
  splashScreen.removeAttribute("tabindex");
  onboardingStarted = true;
  onboardingFinished = true;
  showHome(restoredProfile);

  const transitionDelay = reducedMotion.matches ? 0 : SCREEN_FADE_MS;
  window.setTimeout(() => {
    splashScreen.hidden = true;
  }, transitionDelay);
}

function dismissSplash() {
  splashScreen.classList.remove("is-active");
  splashScreen.setAttribute("aria-hidden", "true");
  splashScreen.removeAttribute("tabindex");
}

// A returning user who signed in with Google/email lands here without ever
// seeing the login screen: existing -> Home, new -> straight into onboarding.
function routeFromSplash() {
  if (restoredProfile) {
    restoreToHome();
    return true;
  }
  if (pendingOnboarding) {
    dismissSplash();
    onboardingStarted = true;
    onboardingScreen.hidden = false;
    onboardingScreen.classList.add("is-active");
    onboardingScreen.setAttribute("aria-hidden", "false");
    onboardingFlow.start({ name: pendingOnboarding.name });
    syncThemeColor("--color-white");
    const transitionDelay = reducedMotion.matches ? 0 : SCREEN_FADE_MS;
    window.setTimeout(() => {
      splashScreen.hidden = true;
    }, transitionDelay);
    return true;
  }
  return false;
}

function showLogin() {
  if (splashFinished) return;
  splashFinished = true;
  window.clearTimeout(splashTimer);

  if (routeFromSplash()) return;

  dismissSplash();
  loginScreen.classList.add("is-active");
  loginScreen.setAttribute("aria-hidden", "false");
  syncThemeColor("--color-white");
  if (oauthFailed) showOAuthNotice();

  const transitionDelay = reducedMotion.matches ? 0 : SCREEN_FADE_MS;
  window.setTimeout(() => {
    splashScreen.hidden = true;
    focusLoginHeading();
  }, transitionDelay);
}

// A quiet inline note on the login screen when an OAuth attempt came back
// without a session, so a declined/blocked sign-in explains itself instead of
// silently returning to login.
function showOAuthNotice() {
  try {
    let note = document.querySelector("#oauthNotice");
    if (!note) {
      note = document.createElement("p");
      note.id = "oauthNotice";
      note.className = "oauth-notice";
      note.setAttribute("role", "status");
      authOptions.parentNode.insertBefore(note, authOptions);
    }
    note.textContent = "Sign-in didn't complete. Please try again.";
    note.hidden = false;
  } catch {
    /* ignore */
  }
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

// No-op by design: the app now resizes to the visual viewport, so a focused
// input is already in view above the keyboard. Scrolling it into view here is
// exactly what made the screen "jump" — so we don't. Kept as a stable hook.
function keepEmailVisible() {}

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

// After a completed sign-in: returning onboarded users go straight to
// Home; everyone else continues into onboarding (now with a session, so
// their answers persist).
async function routeSignedInUser() {
  try {
    const supabase = await getSupabase();
    const session = await getSession();
    if (!supabase || !session) return false;
    const { data } = await supabase
      .from("profiles")
      .select("display_name, age_range")
      .eq("id", session.user.id)
      .maybeSingle();
    if (data?.age_range) {
      skipToHomeFromLogin({ name: data.display_name });
      return true;
    }
  } catch (error) {
    console.info("Post-auth routing fell back to onboarding", error);
  }
  return false;
}

function skipToHomeFromLogin(state) {
  onboardingStarted = true;
  onboardingFinished = true;
  loginScreen.classList.remove("is-active");
  loginScreen.setAttribute("aria-hidden", "true");
  showHome(state);

  const transitionDelay = reducedMotion.matches ? 0 : SCREEN_FADE_MS;
  window.setTimeout(() => {
    loginScreen.hidden = true;
  }, transitionDelay);
}

function syncOtpState() {
  const digits = otpInput.value.replace(/\D/g, "").slice(0, 6);
  if (digits !== otpInput.value) otpInput.value = digits;
  otpInput.classList.toggle("has-value", digits.length > 0);
  otpVerifyButton.disabled = digits.length !== 6;
  otpError.hidden = true;
}

function enterOtpMode(email) {
  otpEmail.textContent = email;
  otpInput.value = "";
  syncOtpState();
  emailForm.hidden = true;
  emailForm.setAttribute("aria-hidden", "true");
  otpForm.hidden = false;
  otpForm.setAttribute("aria-hidden", "false");
  window.requestAnimationFrame(() => otpInput.focus({ preventScroll: true }));
}

function leaveOtpMode() {
  otpForm.hidden = true;
  otpForm.setAttribute("aria-hidden", "true");
  emailForm.hidden = false;
  emailForm.setAttribute("aria-hidden", "false");
  window.requestAnimationFrame(() => emailInput.focus({ preventScroll: true }));
}

// Deliberate demo entrance: this address skips auth entirely (QA, app-store
// review, offline demos) — no OTP is ever requested for it.
const DEMO_EMAIL = "demo@gems.app";

async function handleEmailSubmit(event) {
  event.preventDefault();
  const email = emailInput.value.trim();
  if (!isValidEmail(email)) return;
  if (email.toLowerCase() === DEMO_EMAIL) {
    showOnboarding();
    return;
  }
  emailContinueButton.disabled = true;
  const { sent } = await authActions.requestEmailOtp(email);
  emailContinueButton.disabled = false;
  if (sent) {
    enterOtpMode(email);
    return;
  }
  // Fallback: backend unreachable, keep the prototype flow.
  showOnboarding();
}

async function handleOtpSubmit(event) {
  event.preventDefault();
  const token = otpInput.value.trim();
  if (token.length !== 6) return;
  otpVerifyButton.disabled = true;
  const { session } = await authActions.verifyEmailOtp(otpEmail.textContent, token);
  if (!session) {
    otpVerifyButton.disabled = false;
    otpError.hidden = false;
    otpInput.setAttribute("aria-invalid", "true");
    otpInput.select();
    return;
  }
  otpInput.setAttribute("aria-invalid", "false");
  const routedHome = await routeSignedInUser();
  if (!routedHome) showOnboarding();
}

// OAuth is redirect-only: initiate the provider redirect and paint NOTHING —
// painting the next screen here flashes onboarding for a frame before the
// browser navigates away. On return, checkExistingSession routes the user by
// their profile (existing -> Home, new -> onboarding). Only if no redirect
// starts (offline / not configured) do we keep the prototype flow going.
const appleButton = document.querySelector("#appleButton");
const googleButton = document.querySelector("#googleButton");

function setOAuthConnecting(button) {
  const note = document.querySelector("#oauthNotice");
  if (note) note.hidden = true;
  authOptions.setAttribute("aria-busy", "true");
  [appleButton, googleButton, emailOptionButton].forEach((b) => (b.disabled = true));
  const label = button.querySelector("span");
  if (label) label.textContent = "Connecting…";
}

function clearOAuthConnecting() {
  authOptions.removeAttribute("aria-busy");
  [appleButton, googleButton, emailOptionButton].forEach((b) => (b.disabled = false));
  appleButton.querySelector("span").textContent = "Continue with Apple";
  googleButton.querySelector("span").textContent = "Continue with Google";
}

async function startOAuth(button, authCall) {
  setOAuthConnecting(button);
  const { redirecting } = await authCall();
  if (redirecting) return; // browser is navigating to the provider — leave the screen as-is
  clearOAuthConnecting();
  showOnboarding();
}

appleButton.addEventListener("click", () => {
  void startOAuth(appleButton, () => authActions.signInWithApple());
});

googleButton.addEventListener("click", () => {
  void startOAuth(googleButton, () => authActions.signInWithGoogle());
});

// Explicit "Sign up" entry — starts a new user straight through the account-
// creation journey (name → gender → age → aesthetics).
document.querySelector("#signupButton").addEventListener("click", () => {
  showOnboarding();
});

splashScreen.addEventListener("click", showLogin);
splashScreen.addEventListener("keydown", handleSplashKeydown);
emailOptionButton.addEventListener("click", enterEmailMode);
backToOptionsButton.addEventListener("click", leaveEmailMode);
emailInput.addEventListener("input", syncEmailState);
emailInput.addEventListener("focus", () => window.setTimeout(keepEmailVisible, 180));
emailForm.addEventListener("submit", handleEmailSubmit);
otpInput.addEventListener("input", syncOtpState);
otpForm.addEventListener("submit", handleOtpSubmit);
otpResendButton.addEventListener("click", () => {
  void authActions.requestEmailOtp(otpEmail.textContent);
  otpInput.value = "";
  syncOtpState();
  otpInput.focus({ preventScroll: true });
});
backToEmailButton.addEventListener("click", leaveOtpMode);

document.querySelectorAll("[data-legal]").forEach((button) => {
  button.addEventListener("click", () => {
    const page = button.dataset.legal === "privacy" ? "privacy.html" : "terms.html";
    // Open the public legal page in a new tab so the sign-in flow isn't lost.
    window.open(page, "_blank", "noopener");
  });
});

window.addEventListener("resize", syncAppHeight);
window.visualViewport?.addEventListener("resize", () => {
  syncAppHeight();
  window.setTimeout(keepEmailVisible, 50);
});
// The keyboard opening/closing also fires visualViewport "scroll" (its offset
// changes); re-pin on that too so nothing drifts mid-animation.
window.visualViewport?.addEventListener("scroll", syncAppHeight);
// Belt-and-suspenders: if any focus attempt nudges the window, snap it back.
window.addEventListener("scroll", () => {
  if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
});
// Re-pin when an input gains/loses focus. iOS fires the keyboard's visualViewport
// events a beat late, so a few delayed snaps guarantee the composer never drifts
// or "drags down" while typing — on Safari, Chrome, macOS or iPhone.
window.addEventListener("focusin", () => {
  syncAppHeight();
  window.setTimeout(syncAppHeight, 100);
  window.setTimeout(syncAppHeight, 300);
});
window.addEventListener("focusout", () => {
  window.setTimeout(syncAppHeight, 100);
});
// "Edit" on a generated result saves it to the library and opens it in the editor.
window.addEventListener("gems:open-editor", (event) => {
  const photoId = event.detail?.photoId;
  if (photoId) navigateAuthenticated("Editor", { mode: "describe", photoId });
});
// "Chat" on a generated result: land on Home so the chatbox (which the result
// was just attached to via gems:attach-to-chat) is actually in front of the user.
window.addEventListener("gems:go-home", () => {
  navigateAuthenticated("Home", {});
});

syncAppHeight();
syncThemeColor();
syncEmailState();
// Warm the Supabase client immediately so that when the user taps Continue with
// Google there's no CDN import in the tap path (iOS drops late navigations).
void getSupabase();

// Auto-enrich: whenever photos are imported (from anywhere — Home, native shell,
// reveal), quietly run the on-device intelligence passes in the background so
// 'best photos', 'of me', search, and Memories just work. Lazy-loaded.
void import("./gems-enrich.js").then((m) => m.autoEnrichOnImport()).catch(() => {});
const bootIsOAuthReturn = isOAuthReturn();
// Route as soon as the session check resolves. On an OAuth return we ALWAYS
// leave the splash once we know the outcome — Home/onboarding on success, or
// the login screen (with a note) on failure — so a declined/blocked sign-in
// never leaves the app stuck re-showing the splash.
checkExistingSession().then(() => {
  if (bootIsOAuthReturn || restoredProfile || pendingOnboarding) showLogin();
});
// Fallback timer only; the session check above drives routing on an OAuth return.
splashTimer = window.setTimeout(showLogin, bootIsOAuthReturn ? 9000 : SPLASH_DURATION_MS);

// Keep this reference intentional: it makes the app-height owner explicit and
// prevents accidental garbage collection in embedded WebViews.
void app;
