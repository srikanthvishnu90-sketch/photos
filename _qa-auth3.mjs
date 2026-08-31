import { chromium } from "playwright";
const BASE = "http://127.0.0.1:8201/";
const log = (...a) => console.log(...a);
const errors = [];
const SP = "/private/tmp/claude-501/-Users-vishnusrikanth/27e14023-7753-4125-ab34-3c4d570cb2c3/scratchpad/";
const mk = (b, size = { width: 390, height: 844 }) =>
  b.newContext({ viewport: size, deviceScaleFactor: 3, isMobile: true, hasTouch: true, serviceWorkers: "block" });
const desc = () => {
  const a = document.activeElement;
  if (!a) return "null";
  return `${a.tagName}${a.id ? "#" + a.id : ""}${a.className ? "." + String(a.className).split(" ").join(".") : ""}[txt=${(a.textContent || "").trim().slice(0, 22)}]`;
};

const browser = await chromium.launch();

/* --- G: full keyboard journey with enabled buttons --- */
{
  const ctx = await mk(browser);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console.error: " + m.text()); });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#loginScreen.is-active", { timeout: 15000 });
  await page.waitForTimeout(900);
  await page.click("#signupButton");
  await page.waitForSelector("#nameInput");
  await page.waitForTimeout(1200);

  await page.keyboard.type("Keyboard User");
  const t = async (n, label) => {
    const out = [];
    for (let i = 0; i < n; i++) { await page.keyboard.press("Tab"); out.push(await page.evaluate(desc)); }
    log(`G ${label}:`, out.join(" | "));
  };
  await t(4, "name step (Continue enabled)");
  log("G nameContinue tabIndex/disabled:", await page.evaluate(() => { const b = document.querySelector("#nameContinue"); return { tabIndex: b.tabIndex, disabled: b.disabled, display: getComputedStyle(b).display, visibility: getComputedStyle(b).visibility }; }));

  await page.evaluate(() => document.querySelector("#nameInput").focus());
  await page.keyboard.press("Enter");
  await page.waitForSelector("#genderContinue");
  await page.waitForTimeout(900);
  await t(6, "gender step (Continue DISABLED)");
  await page.evaluate(() => document.querySelector('[data-selection="Female"]').click());
  await page.waitForTimeout(200);
  await page.evaluate(() => document.querySelector("#genderHeadline").focus());
  await t(6, "gender step (Continue ENABLED)");

  await page.evaluate(() => document.querySelector("#genderContinue").click());
  await page.waitForSelector("#ageContinue");
  await page.waitForTimeout(900);
  await page.evaluate(() => document.querySelector('[data-selection="Under 18"]').click());
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector("#ageHeadline").focus());
  await t(9, "age step w/ minor gate open");
  log("G minorConfirm focus style:", await page.evaluate(() => {
    const b = document.querySelector("#minorConfirm"); b.focus();
    const s = getComputedStyle(b);
    return { outline: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`, matchesFocusVisible: b.matches(":focus-visible") };
  }));
  // does selecting Under 18 announce / move focus / scroll on 390?
  log("G gate rect at 390:", await page.evaluate(() => {
    const b = document.querySelector("#minorGate").getBoundingClientRect();
    const c = document.querySelector("#ageContinue").getBoundingClientRect();
    return { gateTop: Math.round(b.top), gateBottom: Math.round(b.bottom), contBottom: Math.round(c.bottom), winH: window.innerHeight };
  }));
  log("G minorGate role/live:", await page.evaluate(() => {
    const g = document.querySelector("#minorGate");
    return { role: g.getAttribute("role"), live: g.getAttribute("aria-live"), tabindex: g.getAttribute("tabindex") };
  }));
  // does the disabled Continue explain itself?
  log("G ageContinue aria:", await page.evaluate(() => {
    const b = document.querySelector("#ageContinue");
    return { disabled: b.disabled, ariaDisabled: b.getAttribute("aria-disabled"), describedby: b.getAttribute("aria-describedby") };
  }));
  await page.evaluate(() => document.querySelector("#minorConfirm").click());
  await page.evaluate(() => document.querySelector("#ageContinue").click());
  await page.waitForSelector("#aestheticSearchInput");
  await page.waitForTimeout(1000);
  await page.evaluate(() => document.querySelector("#aestheticHeadline").focus());
  await t(8, "aesthetic step (Continue disabled, 28 chips)");
  await ctx.close();
}

/* --- H: custom picks survive back/forward; counter escaping; live regions --- */
{
  const ctx = await mk(browser);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console.error: " + m.text()); });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#loginScreen.is-active", { timeout: 15000 });
  await page.click("#signupButton");
  await page.waitForSelector("#nameInput");
  await page.type("#nameInput", "Custy", { delay: 3 });
  await page.keyboard.press("Enter");
  await page.waitForSelector("#genderContinue");
  await page.click('[data-selection="Male"]');
  await page.click("#genderContinue");
  await page.waitForSelector("#ageContinue");
  await page.click('[data-selection="30+"]');
  await page.click("#ageContinue");
  await page.waitForSelector("#aestheticSearchInput");
  await page.waitForTimeout(600);
  const add = async (v) => {
    await page.evaluate((x) => { const i = document.querySelector("#aestheticSearchInput"); i.value = x; i.dispatchEvent(new Event("input", { bubbles: true })); }, v);
    await page.waitForTimeout(150);
    await page.evaluate(() => document.querySelector("[data-add-custom]")?.click());
    await page.waitForTimeout(150);
  };
  await add("Skate Park");
  await page.evaluate(() => document.querySelector('[data-vibe="Grunge"]').click());
  await page.waitForTimeout(200);
  log("H picks:", await page.evaluate(() => [...document.querySelectorAll("#tagCloud .vibe-chip.is-selected span")].map((s) => s.textContent.trim())), "focus after add:", await page.evaluate(() => document.activeElement?.id));
  await page.click("#onboardingBack");
  await page.waitForTimeout(500);
  await page.click("#ageContinue");
  await page.waitForSelector("#aestheticSearchInput");
  await page.waitForTimeout(700);
  log("H after back/forward (query was empty):", await page.evaluate(() => ({
    search: document.querySelector("#aestheticSearchInput").value,
    counter: document.querySelector("#aestheticCounter").textContent.trim(),
    selected: [...document.querySelectorAll("#tagCloud .vibe-chip.is-selected span")].map((s) => s.textContent.trim()),
  })));
  // custom tag ordering: custom picks render first, library after — is the visual order the stored order?
  log("H stored vs visual order:", await page.evaluate(() => [...document.querySelectorAll("#tagCloud .vibe-chip")].slice(0, 4).map((c) => c.textContent.trim())));

  // aria-live on counter — is the max message announced?
  log("H counter aria:", await page.evaluate(() => { const c = document.querySelector("#aestheticCounter"); return { live: c.getAttribute("aria-live"), role: c.getAttribute("role") }; }));

  // 5-max: does anything tell the user why the 6th chip does nothing?
  for (const n of ["Y2K", "Coquette", "Alt"]) await page.evaluate((s) => document.querySelector(`[data-vibe="${s}"]`)?.click(), n);
  await page.waitForTimeout(200);
  log("H at max:", (await page.textContent("#aestheticCounter")).trim());
  const before = await page.textContent("#aestheticCounter");
  await page.evaluate(() => document.querySelector('[data-vibe="Preppy"]').click());
  await page.waitForTimeout(250);
  log("H clicked 6th while full — any feedback? counter same:", before.trim() === (await page.textContent("#aestheticCounter")).trim(),
    "chip class:", await page.getAttribute('[data-vibe="Preppy"]', "class"),
    "pointerEvents:", await page.evaluate(() => getComputedStyle(document.querySelector('[data-vibe="Preppy"]')).pointerEvents),
    "opacity:", await page.evaluate(() => getComputedStyle(document.querySelector('[data-vibe="Preppy"]')).opacity));
  await page.screenshot({ path: SP + "h-max5.png" });
  await ctx.close();
}

/* --- I: splash interactions + double-tap + resize mid-flow --- */
{
  const ctx = await mk(browser);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console.error: " + m.text()); });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  await page.tap("#splashScreen");
  await page.waitForTimeout(200);
  log("I tap-to-skip splash works:", await page.evaluate(() => document.querySelector("#loginScreen").classList.contains("is-active")));
  await page.tap("#splashScreen").catch(() => log("I second tap: splash gone"));
  await page.waitForTimeout(3000);
  log("I after full splash duration, still login:", await page.evaluate(() => ({
    login: document.querySelector("#loginScreen").classList.contains("is-active"),
    splashHidden: document.querySelector("#splashScreen").hidden,
  })));

  // Resize mid-onboarding
  await page.click("#signupButton");
  await page.waitForSelector("#nameInput");
  await page.type("#nameInput", "Resize Me", { delay: 3 });
  await page.keyboard.press("Enter");
  await page.waitForSelector("#genderContinue");
  await page.waitForTimeout(500);
  for (const s of [{ width: 320, height: 568 }, { width: 430, height: 932 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(s);
    await page.waitForTimeout(400);
    log(`I resized to ${s.width}x${s.height}:`, await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      winW: window.innerWidth,
      appH: getComputedStyle(document.documentElement).getPropertyValue("--app-height").trim(),
      winH: window.innerHeight,
      genderStillThere: !!document.querySelector("#genderContinue"),
    })));
  }
  // double-click continue rapidly (double submit guard)
  await page.evaluate(() => document.querySelector('[data-selection="Female"]').click());
  await page.evaluate(() => { const b = document.querySelector("#genderContinue"); b.click(); b.click(); b.click(); });
  await page.waitForTimeout(600);
  log("I triple-click Continue -> which step?", await page.evaluate(() => ({
    age: !!document.querySelector("#ageContinue"), aesth: !!document.querySelector("#aestheticSearchInput"),
    progressFilled: [...document.querySelectorAll(".progress-segment")].map((s) => s.classList.contains("is-filled")),
  })));
  // rapid double click on final Create-my-account
  await page.evaluate(() => document.querySelector('[data-selection="18–21"]').click());
  await page.evaluate(() => document.querySelector("#ageContinue").click());
  await page.waitForSelector("#aestheticSearchInput");
  await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelector('[data-vibe="Alt"]').click());
  await page.waitForTimeout(200);
  await page.evaluate(() => { const b = document.querySelector("#aestheticContinue"); b.click(); b.click(); });
  await page.waitForTimeout(1500);
  log("I double-submit -> done screen:", await page.evaluate(() => document.querySelector("#doneScreen").classList.contains("is-active")));
  await ctx.close();
}

log("\n==== ERRORS ====");
log(errors.length ? [...new Set(errors)].join("\n") : "(none)");
await browser.close();
