import { chromium } from "playwright";

const BASE = "http://127.0.0.1:8201/";
const errors = [];
const log = (...a) => console.log(...a);

function attach(page, tag) {
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") {
      errors.push(`[${tag}] console.${m.type()}: ${m.text()}`);
    }
  });
  page.on("pageerror", (e) => errors.push(`[${tag}] pageerror: ${e.message}`));
  page.on("requestfailed", (r) =>
    errors.push(`[${tag}] requestfailed: ${r.url()} :: ${r.failure()?.errorText}`),
  );
}

async function newCtx(browser, size = { width: 390, height: 844 }) {
  const ctx = await browser.newContext({
    viewport: size,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    serviceWorkers: "block",
  });
  return ctx;
}

async function gotoOnboarding(page) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  // splash -> login
  await page.waitForSelector("#loginScreen.is-active", { timeout: 15000 });
  await page.click("#signupButton");
  await page.waitForSelector("#nameInput", { timeout: 5000 });
}

async function box(page, sel) {
  const el = await page.$(sel);
  if (!el) return null;
  const b = await el.boundingBox();
  return b ? { x: +b.x.toFixed(2), y: +b.y.toFixed(2), w: +b.width.toFixed(2), h: +b.height.toFixed(2) } : null;
}

const browser = await chromium.launch();

/* ---------------- TEST 1: splash timing ---------------- */
{
  const ctx = await newCtx(browser);
  const page = await ctx.newPage();
  attach(page, "splash");
  const t0 = Date.now();
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  const splashVisible = await page.isVisible("#splashScreen");
  const wordmark = await page.textContent(".splash-wordmark");
  await page.waitForSelector("#loginScreen.is-active", { timeout: 15000 });
  const dt = Date.now() - t0;
  log(`T1 splash visible=${splashVisible} wordmark=${JSON.stringify(wordmark?.trim())} -> login in ${dt}ms`);
  // aria state after transition
  await page.waitForTimeout(700);
  log("T1 after transition:", await page.evaluate(() => ({
    splashHidden: document.querySelector("#splashScreen").hidden,
    splashAria: document.querySelector("#splashScreen").getAttribute("aria-hidden"),
    splashTabindex: document.querySelector("#splashScreen").getAttribute("tabindex"),
    loginAria: document.querySelector("#loginScreen").getAttribute("aria-hidden"),
    activeEl: document.activeElement?.id || document.activeElement?.tagName,
    themeColor: document.querySelector('meta[name="theme-color"]').content,
  })));
  await ctx.close();
}

/* ---------------- TEST 2: email input typing ---------------- */
{
  const ctx = await newCtx(browser);
  const page = await ctx.newPage();
  attach(page, "email");
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#loginScreen.is-active", { timeout: 15000 });
  await page.waitForTimeout(600);
  await page.click("#emailOptionButton");
  await page.waitForTimeout(400);

  const rest = await box(page, "#emailInput");
  await page.focus("#emailInput");
  await page.waitForTimeout(400);
  const onFocus = await box(page, "#emailInput");
  const LONG = "averyveryverylongemailaddresslocalpart.thatkeepsgoing@subdomain.example-domain.co.uk";
  await page.type("#emailInput", LONG, { delay: 8 });
  await page.waitForTimeout(300);
  const afterType = await box(page, "#emailInput");
  const val = await page.inputValue("#emailInput");
  const focusKept = await page.evaluate(() => document.activeElement?.id);
  log("T2 email box rest/focus/afterType:", JSON.stringify(rest), JSON.stringify(onFocus), JSON.stringify(afterType));
  log(`T2 value ok=${val === LONG} len=${val.length} focusKept=${focusKept}`);
  log("T2 continue disabled?", await page.getAttribute("#emailContinueButton", "disabled"));

  // caret mid-string test
  await page.fill("#emailInput", "abcdef@x.com");
  await page.focus("#emailInput");
  await page.keyboard.press("Home");
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.type("ZZ");
  log("T2 caret-mid result:", await page.inputValue("#emailInput"));

  // emoji + 200 char
  const two00 = "a".repeat(190) + "@ex.com";
  await page.fill("#emailInput", two00);
  log("T2 200char len kept:", (await page.inputValue("#emailInput")).length);
  await page.fill("#emailInput", "");
  await page.type("#emailInput", "🙂🎉test@ex.com", { delay: 10 });
  log("T2 emoji value:", JSON.stringify(await page.inputValue("#emailInput")));
  log("T2 emoji continue disabled?", await page.getAttribute("#emailContinueButton", "disabled"));

  // select-all replace
  await page.click("#emailInput");
  await page.keyboard.press("Meta+A");
  await page.keyboard.type("replaced@ex.com");
  log("T2 select-all replace:", await page.inputValue("#emailInput"));
  // paste
  await page.evaluate(() => {
    const i = document.querySelector("#emailInput");
    i.focus();
    i.select();
    document.execCommand("insertText", false, "pasted@ex.com");
  });
  log("T2 paste:", await page.inputValue("#emailInput"), "disabled=", await page.getAttribute("#emailContinueButton", "disabled"));

  // horizontal overflow on login
  log("T2 overflowX:", await page.evaluate(() => ({
    docW: document.documentElement.scrollWidth,
    winW: window.innerWidth,
    bodyW: document.body.scrollWidth,
  })));
  await ctx.close();
}

/* ---------------- TEST 3: onboarding step 1 name typing ---------------- */
{
  const ctx = await newCtx(browser);
  const page = await ctx.newPage();
  attach(page, "name");
  await gotoOnboarding(page);
  await page.waitForTimeout(500);

  log("T3 continue initially disabled:", await page.getAttribute("#nameContinue", "disabled"));
  const rest = await box(page, "#nameInput");
  const btnRest = await box(page, "#nameContinue");
  await page.focus("#nameInput");
  await page.waitForTimeout(400);
  const onFocus = await box(page, "#nameInput");
  const btnFocus = await box(page, "#nameContinue");

  const LONG200 = "Bartholomew".repeat(20).slice(0, 200);
  await page.type("#nameInput", LONG200, { delay: 4 });
  await page.waitForTimeout(300);
  const afterType = await box(page, "#nameInput");
  const btnAfter = await box(page, "#nameContinue");
  const v = await page.inputValue("#nameInput");
  log("T3 name box rest/focus/type Y:", rest?.y, onFocus?.y, afterType?.y);
  log("T3 button box rest/focus/type Y:", btnRest?.y, btnFocus?.y, btnAfter?.y);
  log(`T3 200-char typed -> len=${v.length} (maxlength=80 expected) startsOK=${v === LONG200.slice(0, 80)}`);
  log("T3 focus kept:", await page.evaluate(() => document.activeElement?.id));
  log("T3 overflowX:", await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth })));

  // one char => disabled, two => enabled
  await page.fill("#nameInput", "");
  await page.type("#nameInput", "A");
  log("T3 1 char continue disabled:", await page.getAttribute("#nameContinue", "disabled"));
  await page.type("#nameInput", "l");
  log("T3 2 char continue disabled:", await page.getAttribute("#nameContinue", "disabled"));
  // whitespace only
  await page.fill("#nameInput", "     ");
  await page.dispatchEvent("#nameInput", "input");
  log("T3 whitespace-only continue disabled:", await page.getAttribute("#nameContinue", "disabled"));
  // fill() doesn't fire same as type; retype
  await page.fill("#nameInput", "");
  await page.type("#nameInput", "   ");
  log("T3 typed-3-spaces continue disabled:", await page.getAttribute("#nameContinue", "disabled"));

  // caret mid
  await page.fill("#nameInput", "");
  await page.type("#nameInput", "Jonathan", { delay: 5 });
  await page.evaluate(() => { const i = document.querySelector("#nameInput"); i.focus(); i.setSelectionRange(3, 3); });
  await page.keyboard.type("XY");
  log("T3 caret-mid:", await page.inputValue("#nameInput"), "sel:", await page.evaluate(() => document.querySelector("#nameInput").selectionStart));

  // emoji
  await page.fill("#nameInput", "");
  await page.type("#nameInput", "Al🙂ex👍", { delay: 10 });
  log("T3 emoji:", JSON.stringify(await page.inputValue("#nameInput")));

  // HTML injection in name -> shown on gender step headline
  await page.fill("#nameInput", "");
  await page.type("#nameInput", "<img src=x onerror=alert(1)> Bob", { delay: 3 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  log("T3 gender headline HTML:", (await page.innerHTML("#genderHeadline")).replace(/\s+/g, " ").slice(0, 200));
  log("T3 injected img present?", await page.evaluate(() => !!document.querySelector("#genderHeadline img")));
  await page.click("#onboardingBack");
  await page.waitForTimeout(400);
  log("T3 back preserves name:", JSON.stringify(await page.inputValue("#nameInput")));

  // apostrophe name
  await page.fill("#nameInput", "");
  await page.type("#nameInput", "O'Brien \"Q\" & Co", { delay: 3 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  await page.click("#onboardingBack");
  await page.waitForTimeout(400);
  log("T3 apostrophe round-trip:", JSON.stringify(await page.inputValue("#nameInput")));
  await ctx.close();
}

/* ---------------- TEST 4: steps 2,3 + minor gate ---------------- */
{
  const ctx = await newCtx(browser);
  const page = await ctx.newPage();
  attach(page, "gate");
  await gotoOnboarding(page);
  await page.type("#nameInput", "Testy", { delay: 5 });
  await page.keyboard.press("Enter");
  await page.waitForSelector("#genderContinue");
  await page.waitForTimeout(400);
  log("T4 gender continue disabled initially:", await page.getAttribute("#genderContinue", "disabled"));
  await page.click('[data-selection="Female"]');
  log("T4 after Female disabled:", await page.getAttribute("#genderContinue", "disabled"));
  await page.click("#genderContinue");
  await page.waitForSelector("#ageContinue");
  await page.waitForTimeout(400);

  log("T4 age continue disabled initially:", await page.getAttribute("#ageContinue", "disabled"));
  log("T4 minorGate hidden initially:", await page.evaluate(() => document.querySelector("#minorGate").hidden));

  // Non-minor first
  await page.click('[data-selection="22–29"]');
  log("T4 after 22-29 disabled:", await page.getAttribute("#ageContinue", "disabled"));

  // Under 18
  await page.click('[data-selection="Under 18"]');
  await page.waitForTimeout(200);
  log("T4 Under18 -> gate hidden:", await page.evaluate(() => document.querySelector("#minorGate").hidden));
  log("T4 Under18 -> continue disabled attr:", await page.getAttribute("#ageContinue", "disabled"));
  log("T4 Under18 -> continue .disabled prop:", await page.evaluate(() => document.querySelector("#ageContinue").disabled));

  // try forcing click while blocked
  await page.evaluate(() => document.querySelector("#ageContinue").click());
  await page.waitForTimeout(300);
  log("T4 forced click while blocked -> still on age step?", await page.evaluate(() => !!document.querySelector("#ageContinue")));
  // try Enter key on the disabled button / on focused row
  await page.focus('[data-selection="Under 18"]');
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  log("T4 after Enter on row -> still age step?", await page.evaluate(() => !!document.querySelector("#ageContinue")));

  // confirm
  await page.click("#minorConfirm");
  await page.waitForTimeout(150);
  log("T4 after confirm -> continue disabled:", await page.evaluate(() => document.querySelector("#ageContinue").disabled));
  log("T4 confirm aria-pressed:", await page.getAttribute("#minorConfirm", "aria-pressed"));
  // untoggle
  await page.click("#minorConfirm");
  log("T4 after untoggle -> continue disabled:", await page.evaluate(() => document.querySelector("#ageContinue").disabled));
  await page.click("#minorConfirm");

  // switch away and back: does confirm reset?
  await page.click('[data-selection="30+"]');
  log("T4 switch to 30+ -> gate hidden:", await page.evaluate(() => document.querySelector("#minorGate").hidden), "continueDisabled:", await page.evaluate(() => document.querySelector("#ageContinue").disabled));
  await page.click('[data-selection="Under 18"]');
  await page.waitForTimeout(150);
  log("T4 back to Under18 -> confirm reset?", await page.evaluate(() => ({
    pressed: document.querySelector("#minorConfirm").getAttribute("aria-pressed"),
    contDisabled: document.querySelector("#ageContinue").disabled,
  })));

  // Now: does state survive back/forward navigation?
  await page.click("#minorConfirm");
  await page.waitForTimeout(100);
  await page.click("#onboardingBack"); // -> gender
  await page.waitForTimeout(400);
  log("T4 back to gender, female still selected:", await page.getAttribute('[data-selection="Female"]', "aria-pressed"));
  await page.click("#genderContinue");
  await page.waitForTimeout(400);
  log("T4 forward to age, state:", await page.evaluate(() => ({
    u18: document.querySelector('[data-selection="Under 18"]').getAttribute("aria-pressed"),
    gateHidden: document.querySelector("#minorGate").hidden,
    confirmPressed: document.querySelector("#minorConfirm").getAttribute("aria-pressed"),
    contDisabled: document.querySelector("#ageContinue").disabled,
  })));

  // Skip gender path
  await page.click("#onboardingBack");
  await page.waitForTimeout(400);
  await page.click("#skipGender");
  await page.waitForTimeout(400);
  log("T4 skipGender -> on age step:", await page.evaluate(() => !!document.querySelector("#ageContinue")));

  await ctx.close();
}

/* ---------------- TEST 5: aesthetics step ---------------- */
{
  const ctx = await newCtx(browser);
  const page = await ctx.newPage();
  attach(page, "aesth");
  await gotoOnboarding(page);
  await page.type("#nameInput", "Testy", { delay: 5 });
  await page.keyboard.press("Enter");
  await page.waitForSelector("#genderContinue");
  await page.click('[data-selection="Male"]');
  await page.click("#genderContinue");
  await page.waitForSelector("#ageContinue");
  await page.click('[data-selection="22–29"]');
  await page.click("#ageContinue");
  await page.waitForSelector("#aestheticSearchInput");
  await page.waitForTimeout(500);

  log("T5 continue disabled initially:", await page.evaluate(() => document.querySelector("#aestheticContinue").disabled));
  const searchRest = await box(page, "#aestheticSearch");
  await page.focus("#aestheticSearchInput");
  await page.waitForTimeout(300);
  const searchFocus = await box(page, "#aestheticSearch");

  // fast typing test
  await page.type("#aestheticSearchInput", "streetwear vibes", { delay: 3 });
  await page.waitForTimeout(200);
  const searchTyped = await box(page, "#aestheticSearch");
  log("T5 search Y rest/focus/typed:", searchRest?.y, searchFocus?.y, searchTyped?.y);
  log("T5 typed value:", JSON.stringify(await page.inputValue("#aestheticSearchInput")));
  log("T5 focus kept:", await page.evaluate(() => document.activeElement?.id));

  // caret mid-typing (input.value = query reassignment on every keystroke)
  await page.fill("#aestheticSearchInput", "");
  await page.type("#aestheticSearchInput", "abcdef", { delay: 5 });
  await page.evaluate(() => { const i = document.querySelector("#aestheticSearchInput"); i.focus(); i.setSelectionRange(2, 2); });
  await page.keyboard.type("XY");
  log("T5 caret-mid value:", await page.inputValue("#aestheticSearchInput"), "sel:", await page.evaluate(() => document.querySelector("#aestheticSearchInput").selectionStart));

  // very long 200 char tag
  await page.fill("#aestheticSearchInput", "");
  const LONG = "L".repeat(200);
  await page.evaluate((v) => { const i = document.querySelector("#aestheticSearchInput"); i.value = v; i.dispatchEvent(new Event("input", { bubbles: true })); }, LONG);
  await page.waitForTimeout(200);
  log("T5 long tag addChip present:", await page.evaluate(() => !!document.querySelector("[data-add-custom]")));
  const chipBox = await box(page, "[data-add-custom]");
  log("T5 long addChip box:", JSON.stringify(chipBox), "viewportW=390");
  log("T5 long-tag overflowX:", await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, cloud: document.querySelector("#tagCloud").scrollWidth, cloudClient: document.querySelector("#tagCloud").clientWidth })));
  await page.evaluate(() => document.querySelector("[data-add-custom]").click());
  await page.waitForTimeout(200);
  log("T5 after adding 200-char tag, counter:", await page.textContent("#aestheticCounter"));
  log("T5 overflow after add:", await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth })));

  // HTML injection
  await page.fill("#aestheticSearchInput", "");
  await page.evaluate(() => { const i = document.querySelector("#aestheticSearchInput"); i.value = "<script>alert(1)</scr" + "ipt>"; i.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.waitForTimeout(200);
  const addChipHtml = await page.evaluate(() => document.querySelector("[data-add-custom]")?.outerHTML || "none");
  log("T5 XSS addChip outerHTML:", addChipHtml.replace(/\s+/g, " ").slice(0, 400));
  await page.evaluate(() => document.querySelector("[data-add-custom]")?.click());
  await page.waitForTimeout(200);
  log("T5 script tag injected into DOM?", await page.evaluate(() => document.querySelectorAll("#tagCloud script").length));
  log("T5 selected chips text:", await page.evaluate(() => [...document.querySelectorAll("#tagCloud .vibe-chip.is-selected span")].map((s) => s.textContent)));

  // img onerror injection
  await page.evaluate(() => { const i = document.querySelector("#aestheticSearchInput"); i.value = '"><img src=x onerror="window.__pwned=1">'; i.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.waitForTimeout(200);
  if (await page.$("[data-add-custom]")) { await page.evaluate(() => document.querySelector("[data-add-custom]").click()); await page.waitForTimeout(300); }
  log("T5 __pwned:", await page.evaluate(() => window.__pwned ?? false), "imgs in cloud:", await page.evaluate(() => document.querySelectorAll("#tagCloud img").length));

  // duplicate tag attempt
  await page.evaluate(() => { const i = document.querySelector("#aestheticSearchInput"); i.value = "MyTag"; i.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.waitForTimeout(150);
  const beforeCount = await page.evaluate(() => document.querySelectorAll("#tagCloud .vibe-chip.is-selected").length);
  if (await page.$("[data-add-custom]")) await page.evaluate(() => document.querySelector("[data-add-custom]").click());
  await page.waitForTimeout(200);
  log("T5 counter after MyTag:", await page.textContent("#aestheticCounter"));
  await page.evaluate(() => { const i = document.querySelector("#aestheticSearchInput"); i.value = "MyTag"; i.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.waitForTimeout(150);
  log("T5 duplicate MyTag add-chip shown?", await page.evaluate(() => !!document.querySelector("[data-add-custom]")));
  await page.evaluate(() => { const i = document.querySelector("#aestheticSearchInput"); i.value = "mytag"; i.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.waitForTimeout(150);
  log("T5 case-variant mytag add-chip shown?", await page.evaluate(() => !!document.querySelector("[data-add-custom]")));
  await page.evaluate(() => { const i = document.querySelector("#aestheticSearchInput"); i.value = " MyTag "; i.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.waitForTimeout(150);
  log("T5 whitespace-padded MyTag add-chip shown?", await page.evaluate(() => !!document.querySelector("[data-add-custom]")));

  // whitespace only / empty
  await page.evaluate(() => { const i = document.querySelector("#aestheticSearchInput"); i.value = "   "; i.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.waitForTimeout(150);
  log("T5 whitespace-only add-chip shown?", await page.evaluate(() => !!document.querySelector("[data-add-custom]")));
  // Enter submit on whitespace
  await page.focus("#aestheticSearchInput");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  log("T5 after Enter on whitespace, counter:", await page.textContent("#aestheticCounter"));

  log("T5 selections now:", await page.evaluate(() => [...document.querySelectorAll("#tagCloud .vibe-chip.is-selected span")].map((s) => s.textContent.trim())));
  await ctx.close();
}

/* ---------------- TEST 6: max-5 enforcement ---------------- */
{
  const ctx = await newCtx(browser);
  const page = await ctx.newPage();
  attach(page, "max5");
  await gotoOnboarding(page);
  await page.type("#nameInput", "Maxy", { delay: 5 });
  await page.keyboard.press("Enter");
  await page.waitForSelector("#genderContinue");
  await page.click('[data-selection="Male"]');
  await page.click("#genderContinue");
  await page.waitForSelector("#ageContinue");
  await page.click('[data-selection="30+"]');
  await page.click("#ageContinue");
  await page.waitForSelector("#aestheticSearchInput");
  await page.waitForTimeout(400);

  const names = ["Dark Gym", "Euro Summer", "Nightlife Flash", "Film Nostalgia", "Clean Editorial", "Streetwear", "Quiet Luxury"];
  for (const n of names) {
    const sel = `[data-vibe="${n}"]`;
    if (await page.$(sel)) {
      await page.evaluate((s) => document.querySelector(s)?.click(), sel);
      await page.waitForTimeout(120);
    }
    const count = await page.evaluate(() => document.querySelectorAll("#tagCloud .vibe-chip.is-selected").length);
    log(`T6 clicked ${n} -> selected=${count} counter="${(await page.textContent("#aestheticCounter")).trim()}"`);
  }
  log("T6 final selected:", await page.evaluate(() => [...document.querySelectorAll("#tagCloud .vibe-chip.is-selected span")].map((s) => s.textContent.trim())));
  log("T6 6th chip aria-disabled:", await page.getAttribute('[data-vibe="Streetwear"]', "aria-disabled"), "disabled attr:", await page.getAttribute('[data-vibe="Streetwear"]', "disabled"));

  // custom add while full
  await page.evaluate(() => { const i = document.querySelector("#aestheticSearchInput"); i.value = "OverflowTag"; i.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.waitForTimeout(150);
  const addChip = await page.$("[data-add-custom]");
  log("T6 add-chip while full exists:", !!addChip, "dimmed:", await page.getAttribute("[data-add-custom]", "class").catch(() => "-"));
  if (addChip) { await page.evaluate(() => document.querySelector("[data-add-custom]").click()); await page.waitForTimeout(300); }
  log("T6 after clicking add while full, counter:", (await page.textContent("#aestheticCounter")).trim());
  // enter key submit while full
  await page.focus("#aestheticSearchInput");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  log("T6 after Enter while full, counter:", (await page.textContent("#aestheticCounter")).trim());

  // back preserves aesthetics?
  await page.click("#onboardingBack");
  await page.waitForTimeout(400);
  await page.click("#ageContinue");
  await page.waitForTimeout(500);
  log("T6 after back+forward selections:", await page.evaluate(() => [...document.querySelectorAll("#tagCloud .vibe-chip.is-selected span")].map((s) => s.textContent.trim())));
  log("T6 counter after return:", (await page.textContent("#aestheticCounter")).trim());
  log("T6 search input value after return:", JSON.stringify(await page.inputValue("#aestheticSearchInput")));

  // complete
  await page.click("#aestheticContinue");
  await page.waitForTimeout(1200);
  log("T6 done screen active:", await page.evaluate(() => document.querySelector("#doneScreen")?.classList.contains("is-active")), "name:", await page.textContent("#doneName"));
  await page.waitForTimeout(3000);
  log("T6 home shown:", await page.evaluate(() => document.querySelector("#homeScreen")?.classList.contains("is-active")));
  await ctx.close();
}

/* ---------------- TEST 7: keyboard-only nav + focus visibility ---------------- */
{
  const ctx = await newCtx(browser);
  const page = await ctx.newPage();
  attach(page, "kbd");
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#loginScreen.is-active", { timeout: 15000 });
  await page.waitForTimeout(800);

  const tabOrder = [];
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    tabOrder.push(await page.evaluate(() => {
      const a = document.activeElement;
      const inHiddenScreen = a?.closest("section.screen")?.id;
      return `${a?.id || a?.tagName}${a?.className ? "." + String(a.className).split(" ")[0] : ""}@${inHiddenScreen}`;
    }));
  }
  log("T7 login tab order:", tabOrder.join(" | "));

  // focus outline present?
  await page.evaluate(() => document.querySelector("#signupButton").focus());
  log("T7 signup focus styles:", await page.evaluate(() => {
    const s = getComputedStyle(document.querySelector("#signupButton"));
    return { outline: s.outlineStyle + " " + s.outlineWidth + " " + s.outlineColor, boxShadow: s.boxShadow };
  }));

  // keyboard through onboarding
  await page.click("#signupButton");
  await page.waitForSelector("#nameInput");
  await page.waitForTimeout(400);
  await page.keyboard.type("Kaydee");
  await page.keyboard.press("Enter");
  await page.waitForSelector("#genderContinue");
  await page.waitForTimeout(400);
  log("T7 focus after step2:", await page.evaluate(() => document.activeElement?.id));
  const order2 = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    order2.push(await page.evaluate(() => document.activeElement?.id || document.activeElement?.className));
  }
  log("T7 gender tab order:", order2.join(" | "));
  // activate Female via keyboard
  await page.evaluate(() => document.querySelector('[data-selection="Female"]').focus());
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
  log("T7 Female via Enter, pressed:", await page.getAttribute('[data-selection="Female"]', "aria-pressed"));
  await page.evaluate(() => document.querySelector("#genderContinue").focus());
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  log("T7 reached age step:", await page.evaluate(() => !!document.querySelector("#ageContinue")), "focus:", await page.evaluate(() => document.activeElement?.id));
  // focus-visible on select-row
  log("T7 select-row focus style:", await page.evaluate(() => {
    const el = document.querySelector('[data-selection="Under 18"]');
    el.focus();
    const s = getComputedStyle(el);
    return { outline: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`, boxShadow: s.boxShadow };
  }));
  // back button reachability
  log("T7 backButton attrs:", await page.evaluate(() => {
    const b = document.querySelector("#onboardingBack");
    return { disabled: b.disabled, aria: b.getAttribute("aria-hidden"), tabIndex: b.tabIndex };
  }));
  await ctx.close();
}

/* ---------------- TEST 8: small + large viewports ---------------- */
for (const size of [{ width: 320, height: 568 }, { width: 430, height: 932 }]) {
  const ctx = await newCtx(browser, size);
  const page = await ctx.newPage();
  attach(page, `vp${size.width}`);
  await gotoOnboarding(page);
  await page.waitForTimeout(400);
  const rep = async (label) =>
    log(`T8 ${size.width}x${size.height} ${label}:`, await page.evaluate(() => {
      const doc = document.documentElement;
      const app = document.querySelector(".gems-app");
      const clipped = [...document.querySelectorAll("#onboardingStep *")]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1 || r.bottom > window.innerHeight + 1);
        })
        .map((el) => {
          const r = el.getBoundingClientRect();
          return `${el.tagName}${el.id ? "#" + el.id : "." + String(el.className).split(" ")[0]}[${Math.round(r.left)},${Math.round(r.right)},${Math.round(r.bottom)}]`;
        });
      return { scrollW: doc.scrollWidth, winW: window.innerWidth, appW: app?.getBoundingClientRect().width, overflowing: clipped.slice(0, 10) };
    }));
  await rep("name step");
  await page.type("#nameInput", "Sam", { delay: 5 });
  await page.keyboard.press("Enter");
  await page.waitForSelector("#genderContinue");
  await page.waitForTimeout(400);
  await rep("gender step");
  await page.click('[data-selection="Female"]');
  await page.click("#genderContinue");
  await page.waitForSelector("#ageContinue");
  await page.waitForTimeout(400);
  await page.click('[data-selection="Under 18"]');
  await page.waitForTimeout(300);
  await rep("age step + minor gate");
  log(`T8 ${size.width} ageContinue box:`, JSON.stringify(await box(page, "#ageContinue")), "minorNote:", JSON.stringify(await box(page, ".minor-note")));
  await page.click("#minorConfirm");
  await page.click("#ageContinue");
  await page.waitForSelector("#aestheticSearchInput");
  await page.waitForTimeout(500);
  await rep("aesthetic step");
  await page.click('[data-vibe="Dark Gym"]');
  await page.waitForTimeout(200);
  await rep("aesthetic w/ selection");
  log(`T8 ${size.width} aestheticContinue box:`, JSON.stringify(await box(page, "#aestheticContinue")));
  await ctx.close();
}

/* ---------------- TEST 9: minor gate deep — does gender leak / gate bypass via back ---------------- */
{
  const ctx = await newCtx(browser);
  const page = await ctx.newPage();
  attach(page, "gate2");
  await gotoOnboarding(page);
  await page.type("#nameInput", "Minor", { delay: 5 });
  await page.keyboard.press("Enter");
  await page.waitForSelector("#genderContinue");
  await page.click('[data-selection="Female"]');
  await page.click("#genderContinue");
  await page.waitForSelector("#ageContinue");
  await page.click('[data-selection="Under 18"]');
  await page.click("#minorConfirm");
  await page.click("#ageContinue");
  await page.waitForSelector("#aestheticSearchInput");
  await page.waitForTimeout(400);
  // now go back to age, deselect confirm, and see if we can still return forward
  await page.click("#onboardingBack");
  await page.waitForTimeout(400);
  log("T9 on age step, confirm pressed:", await page.getAttribute("#minorConfirm", "aria-pressed"));
  await page.click("#minorConfirm"); // uncheck
  await page.waitForTimeout(150);
  log("T9 unchecked -> ageContinue disabled:", await page.evaluate(() => document.querySelector("#ageContinue").disabled));
  await page.evaluate(() => document.querySelector("#ageContinue").click());
  await page.waitForTimeout(300);
  log("T9 forced click after uncheck -> still age step:", await page.evaluate(() => !!document.querySelector("#ageContinue")));
  // Does the custom-aesthetic analytics get suppressed for minors? (network watch)
  await page.click("#minorConfirm");
  await page.click("#ageContinue");
  await page.waitForSelector("#aestheticSearchInput");
  await page.waitForTimeout(300);
  const reqs = [];
  page.on("request", (r) => { if (/supabase|custom_aesthetic/.test(r.url())) reqs.push(r.method() + " " + r.url()); });
  await page.evaluate(() => { const i = document.querySelector("#aestheticSearchInput"); i.value = "MinorTag"; i.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.waitForTimeout(150);
  if (await page.$("[data-add-custom]")) await page.evaluate(() => document.querySelector("[data-add-custom]").click());
  await page.waitForTimeout(800);
  log("T9 supabase requests after minor custom tag:", reqs.length ? reqs : "none");
  await ctx.close();
}

/* ---------------- TEST 10: rapid typing / IME-ish stress on aesthetic search ---------------- */
{
  const ctx = await newCtx(browser);
  const page = await ctx.newPage();
  attach(page, "stress");
  await gotoOnboarding(page);
  await page.type("#nameInput", "Stress", { delay: 2 });
  await page.keyboard.press("Enter");
  await page.waitForSelector("#genderContinue");
  await page.click('[data-selection="Male"]');
  await page.click("#genderContinue");
  await page.waitForSelector("#ageContinue");
  await page.click('[data-selection="18–21"]');
  await page.click("#ageContinue");
  await page.waitForSelector("#aestheticSearchInput");
  await page.waitForTimeout(400);

  const S = "the quick brown fox jumps over the lazy dog 0123456789";
  await page.focus("#aestheticSearchInput");
  await page.keyboard.type(S, { delay: 0 });
  await page.waitForTimeout(400);
  const got = await page.inputValue("#aestheticSearchInput");
  log("T10 fast-typed match:", got === S, JSON.stringify(got));
  log("T10 focus kept:", await page.evaluate(() => document.activeElement?.id));
  log("T10 selectionStart:", await page.evaluate(() => document.querySelector("#aestheticSearchInput").selectionStart), "len", got.length);

  // measure Y movement during typing
  const ys = [];
  await page.fill("#aestheticSearchInput", "");
  for (const ch of "Dark Gym Extra Long Query Text Here") {
    await page.keyboard.type(ch);
    const b = await box(page, "#aestheticSearch");
    ys.push(b?.y);
  }
  log("T10 search Y during typing distinct:", [...new Set(ys)]);
  const cb = [];
  for (const ch of "abc") { await page.keyboard.type(ch); cb.push((await box(page, "#aestheticContinue"))?.y); }
  log("T10 continue-button Y during typing:", [...new Set(cb)]);
  await ctx.close();
}

log("\n================ CONSOLE ERRORS / WARNINGS / FAILED REQUESTS ================");
if (!errors.length) log("(none)");
else [...new Set(errors)].forEach((e) => log(" -", e));

await browser.close();
