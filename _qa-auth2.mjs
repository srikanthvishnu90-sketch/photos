import { chromium } from "playwright";
const BASE = "http://127.0.0.1:8201/";
const errors = [];
const log = (...a) => console.log(...a);
function attach(page, tag) {
  page.on("console", (m) => { if (m.type() === "error") errors.push(`[${tag}] console.error: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`[${tag}] pageerror: ${e.message}`));
  page.on("requestfailed", (r) => errors.push(`[${tag}] requestfailed: ${r.url()} :: ${r.failure()?.errorText}`));
}
const mk = (b, size = { width: 390, height: 844 }) =>
  b.newContext({ viewport: size, deviceScaleFactor: 3, isMobile: true, hasTouch: true, serviceWorkers: "block" });

async function toStep(page, { name = "Tester", gender = "Female", age = "22–29" } = {}) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#loginScreen.is-active", { timeout: 15000 });
  await page.click("#signupButton");
  await page.waitForSelector("#nameInput");
  await page.type("#nameInput", name, { delay: 3 });
  await page.keyboard.press("Enter");
  await page.waitForSelector("#genderContinue");
  await page.click(`[data-selection="${gender}"]`);
  await page.click("#genderContinue");
  await page.waitForSelector("#ageContinue");
  if (age) { await page.click(`[data-selection="${age}"]`); await page.click("#ageContinue"); await page.waitForSelector("#aestheticSearchInput"); }
}

const browser = await chromium.launch();

/* --- A: is onboardingScroll actually scrollable at 320x568? --- */
{
  const ctx = await mk(browser, { width: 320, height: 568 });
  const page = await ctx.newPage();
  attach(page, "A");
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#loginScreen.is-active", { timeout: 15000 });
  await page.waitForTimeout(600);
  log("A login scroll:", await page.evaluate(() => {
    const s = document.querySelector("#loginScroll");
    return { scrollH: s.scrollHeight, clientH: s.clientHeight, overflowY: getComputedStyle(s).overflowY, canScroll: s.scrollHeight > s.clientHeight };
  }));
  await page.screenshot({ path: "/private/tmp/claude-501/-Users-vishnusrikanth/27e14023-7753-4125-ab34-3c4d570cb2c3/scratchpad/a-login-320.png" });

  await page.click("#signupButton");
  await page.waitForSelector("#nameInput");
  await page.waitForTimeout(900);
  const scrollInfo = async (label) => log(`A ${label}:`, await page.evaluate(() => {
    const s = document.querySelector("#onboardingScroll");
    return { scrollH: s.scrollHeight, clientH: s.clientHeight, overflowY: getComputedStyle(s).overflowY, canScroll: s.scrollHeight > s.clientHeight, scrollTop: s.scrollTop };
  }));
  await scrollInfo("name step scroll");
  await page.type("#nameInput", "Sam", { delay: 3 });
  await page.keyboard.press("Enter");
  await page.waitForSelector("#genderContinue");
  await page.waitForTimeout(900);
  await scrollInfo("gender step scroll");
  log("A gender continue visible in viewport?", await page.evaluate(() => {
    const b = document.querySelector("#genderContinue").getBoundingClientRect();
    return { top: Math.round(b.top), bottom: Math.round(b.bottom), winH: window.innerHeight, fullyVisible: b.bottom <= window.innerHeight };
  }));
  await page.screenshot({ path: "/private/tmp/claude-501/-Users-vishnusrikanth/27e14023-7753-4125-ab34-3c4d570cb2c3/scratchpad/a-gender-320.png" });

  await page.click('[data-selection="Female"]');
  await page.click("#genderContinue");
  await page.waitForSelector("#ageContinue");
  await page.waitForTimeout(900);
  await scrollInfo("age step scroll (no gate)");
  log("A age continue rect (no gate):", await page.evaluate(() => { const b = document.querySelector("#ageContinue").getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), winH: window.innerHeight }; }));
  await page.click('[data-selection="Under 18"]');
  await page.waitForTimeout(400);
  await scrollInfo("age step scroll (gate open)");
  log("A gate + continue rects:", await page.evaluate(() => {
    const r = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom) }; };
    return { gate: r("#minorGate"), confirm: r("#minorConfirm"), note: r(".minor-note"), cont: r("#ageContinue"), winH: window.innerHeight, scrollTop: document.querySelector("#onboardingScroll").scrollTop };
  }));
  await page.screenshot({ path: "/private/tmp/claude-501/-Users-vishnusrikanth/27e14023-7753-4125-ab34-3c4d570cb2c3/scratchpad/a-minor-320.png" });
  await ctx.close();
}

/* --- B: selected library chips vanish while a search query is present --- */
{
  const ctx = await mk(browser);
  const page = await ctx.newPage();
  attach(page, "B");
  await toStep(page);
  await page.waitForTimeout(500);
  await page.evaluate(() => document.querySelector('[data-vibe="Dark Gym"]').click());
  await page.evaluate(() => document.querySelector('[data-vibe="Y2K"]').click());
  await page.waitForTimeout(200);
  log("B after picking 2:", await page.evaluate(() => ({
    counter: document.querySelector("#aestheticCounter").textContent.trim(),
    visibleSelected: [...document.querySelectorAll("#tagCloud .vibe-chip.is-selected span")].map((s) => s.textContent.trim()),
  })));
  // type a non-matching query
  await page.evaluate(() => { const i = document.querySelector("#aestheticSearchInput"); i.value = "zzzz"; i.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.waitForTimeout(250);
  log("B with query 'zzzz':", await page.evaluate(() => ({
    counter: document.querySelector("#aestheticCounter").textContent.trim(),
    visibleSelected: [...document.querySelectorAll("#tagCloud .vibe-chip.is-selected span")].map((s) => s.textContent.trim()),
    cloudHTMLLen: document.querySelector("#tagCloud").textContent.trim().slice(0, 120),
    continueLabel: document.querySelector("#aestheticContinue").textContent.trim(),
  })));
  await page.screenshot({ path: "/private/tmp/claude-501/-Users-vishnusrikanth/27e14023-7753-4125-ab34-3c4d570cb2c3/scratchpad/b-query-hides-picks.png" });

  // clean repro of the back/forward stale query
  await page.evaluate(() => { const i = document.querySelector("#aestheticSearchInput"); i.value = "coast"; i.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.waitForTimeout(200);
  await page.click("#onboardingBack");
  await page.waitForTimeout(500);
  await page.click("#ageContinue");
  await page.waitForSelector("#aestheticSearchInput");
  await page.waitForTimeout(600);
  log("B after back+forward:", await page.evaluate(() => ({
    searchValue: document.querySelector("#aestheticSearchInput").value,
    counter: document.querySelector("#aestheticCounter").textContent.trim(),
    visibleSelected: [...document.querySelectorAll("#tagCloud .vibe-chip.is-selected span")].map((s) => s.textContent.trim()),
    chipCount: document.querySelectorAll("#tagCloud .vibe-chip").length,
  })));
  await page.screenshot({ path: "/private/tmp/claude-501/-Users-vishnusrikanth/27e14023-7753-4125-ab34-3c4d570cb2c3/scratchpad/b-back-forward-stale.png" });
  // clear restores
  await page.click("#clearAestheticSearch");
  await page.waitForTimeout(200);
  log("B after clear:", await page.evaluate(() => [...document.querySelectorAll("#tagCloud .vibe-chip.is-selected span")].map((s) => s.textContent.trim())));
  await ctx.close();
}

/* --- C: long custom tag layout --- */
{
  const ctx = await mk(browser);
  const page = await ctx.newPage();
  attach(page, "C");
  await toStep(page);
  await page.waitForTimeout(500);
  log("C tagCloud css:", await page.evaluate(() => { const s = getComputedStyle(document.querySelector("#tagCloud")); return { overflow: s.overflow, overflowX: s.overflowX, display: s.display, flexWrap: s.flexWrap }; }));
  const LONG = "Supercalifragilisticexpialidocious".repeat(6);
  await page.evaluate((v) => { const i = document.querySelector("#aestheticSearchInput"); i.value = v; i.dispatchEvent(new Event("input", { bubbles: true })); }, LONG);
  await page.waitForTimeout(300);
  await page.screenshot({ path: "/private/tmp/claude-501/-Users-vishnusrikanth/27e14023-7753-4125-ab34-3c4d570cb2c3/scratchpad/c-long-addchip.png" });
  log("C addchip rect:", await page.evaluate(() => { const b = document.querySelector("[data-add-custom]").getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), width: Math.round(b.width), winW: window.innerWidth }; }));
  await page.evaluate(() => document.querySelector("[data-add-custom]").click());
  await page.waitForTimeout(300);
  await page.screenshot({ path: "/private/tmp/claude-501/-Users-vishnusrikanth/27e14023-7753-4125-ab34-3c4d570cb2c3/scratchpad/c-long-selected.png" });
  log("C selected chip rect:", await page.evaluate(() => { const b = document.querySelector("#tagCloud .vibe-chip.is-selected").getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), width: Math.round(b.width), winW: window.innerWidth }; }));
  log("C can the remove X be reached?", await page.evaluate(() => {
    const x = document.querySelector("#tagCloud .vibe-chip.is-selected .chip-icon-remove");
    if (!x) return "no icon";
    const b = x.getBoundingClientRect();
    return { left: Math.round(b.left), right: Math.round(b.right), onScreen: b.right <= window.innerWidth };
  }));
  // does the deselect still work by clicking the chip body?
  await page.evaluate(() => document.querySelector("#tagCloud .vibe-chip.is-selected").click());
  await page.waitForTimeout(200);
  log("C after deselect counter:", await page.textContent("#aestheticCounter"));

  // Custom tag containing a double quote — round trip toggle
  await page.evaluate(() => { const i = document.querySelector("#aestheticSearchInput"); i.value = 'He said "hi" & <b>'; i.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.waitForTimeout(200);
  await page.evaluate(() => document.querySelector("[data-add-custom]").click());
  await page.waitForTimeout(200);
  log("C quote tag stored:", await page.evaluate(() => [...document.querySelectorAll("#tagCloud .vibe-chip.is-selected span")].map((s) => s.textContent)));
  await page.evaluate(() => document.querySelector("#tagCloud .vibe-chip.is-selected").click());
  await page.waitForTimeout(200);
  log("C quote tag deselect works? counter:", (await page.textContent("#aestheticCounter")).trim(), "selected:", await page.evaluate(() => document.querySelectorAll("#tagCloud .vibe-chip.is-selected").length));
  await ctx.close();
}

/* --- D: settled Y measurements (no entrance animation contamination) --- */
{
  const ctx = await mk(browser);
  const page = await ctx.newPage();
  attach(page, "D");
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#loginScreen.is-active", { timeout: 15000 });
  await page.click("#signupButton");
  await page.waitForSelector("#nameInput");
  await page.waitForTimeout(1800);
  const y = async (s) => { const e = await page.$(s); const b = await e.boundingBox(); return +b.y.toFixed(2); };
  const yRest = await y("#nameInput");
  const btnRest = await y("#nameContinue");
  await page.focus("#nameInput");
  await page.waitForTimeout(800);
  const yFocus = await y("#nameInput");
  const btnFocus = await y("#nameContinue");
  await page.keyboard.type("Alexandria Constantinopolitan", { delay: 12 });
  await page.waitForTimeout(600);
  const yTyped = await y("#nameInput");
  const btnTyped = await y("#nameContinue");
  log("D SETTLED name input Y rest/focus/typed:", yRest, yFocus, yTyped, "delta:", (yFocus - yRest).toFixed(2), (yTyped - yFocus).toFixed(2));
  log("D SETTLED continue Y rest/focus/typed:", btnRest, btnFocus, btnTyped);

  // aesthetic search settled
  await page.keyboard.press("Enter");
  await page.waitForSelector("#genderContinue");
  await page.click('[data-selection="Male"]');
  await page.click("#genderContinue");
  await page.waitForSelector("#ageContinue");
  await page.click('[data-selection="30+"]');
  await page.click("#ageContinue");
  await page.waitForSelector("#aestheticSearchInput");
  await page.waitForTimeout(1500);
  const sRest = await y("#aestheticSearch");
  const cRest = await y("#aestheticContinue");
  await page.focus("#aestheticSearchInput");
  await page.waitForTimeout(700);
  const sFocus = await y("#aestheticSearch");
  const cFocus = await y("#aestheticContinue");
  await page.keyboard.type("dark", { delay: 25 });
  await page.waitForTimeout(500);
  const sTyped = await y("#aestheticSearch");
  const cTyped = await y("#aestheticContinue");
  log("D SETTLED search Y rest/focus/typed:", sRest, sFocus, sTyped);
  log("D SETTLED aestheticContinue Y rest/focus/typed:", cRest, cFocus, cTyped);
  // Enter when query exactly matches a library tag
  await page.evaluate(() => { const i = document.querySelector("#aestheticSearchInput"); i.value = "Dark Gym"; i.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.waitForTimeout(200);
  await page.focus("#aestheticSearchInput");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  log("D Enter on exact library match -> counter:", (await page.textContent("#aestheticCounter")).trim(), "selected:", await page.evaluate(() => [...document.querySelectorAll("#tagCloud .vibe-chip.is-selected span")].map((s) => s.textContent.trim())));
  await ctx.close();
}

/* --- E: focus/tab behaviour, splash tabbing, aria-hidden focus traps --- */
{
  const ctx = await mk(browser);
  const page = await ctx.newPage();
  attach(page, "E");
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(400);
  // during splash
  const during = [];
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("Tab");
    during.push(await page.evaluate(() => {
      const a = document.activeElement;
      return `${a?.id || a?.tagName}@screen=${a?.closest("section.screen")?.id || "-"}/ariaHidden=${a?.closest('[aria-hidden="true"]') ? "yes" : "no"}`;
    }));
  }
  log("E TAB during splash:", during.join(" | "));
  await page.waitForSelector("#loginScreen.is-active", { timeout: 15000 });
  await page.waitForTimeout(800);

  // onboarding tab order incl. header
  await page.click("#signupButton");
  await page.waitForSelector("#nameInput");
  await page.waitForTimeout(900);
  log("E focus on name step:", await page.evaluate(() => document.activeElement?.id));
  const order = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    order.push(await page.evaluate(() => {
      const a = document.activeElement;
      return `${a?.id || a?.tagName}.${String(a?.className || "").split(" ")[0]}@${a?.closest("section.screen")?.id || "-"}`;
    }));
  }
  log("E name-step tab order:", order.join(" | "));
  // Are login-screen controls still tabbable from onboarding?
  await page.waitForTimeout(600);
  log("E loginScreen hidden after transition:", await page.evaluate(() => ({ hidden: document.querySelector("#loginScreen").hidden, aria: document.querySelector("#loginScreen").getAttribute("aria-hidden") })));
  const order2 = [];
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    order2.push(await page.evaluate(() => {
      const a = document.activeElement;
      return `${a?.id || a?.tagName}@${a?.closest("section.screen")?.id || "-"}`;
    }));
  }
  log("E tab order after transition settle:", order2.join(" | "));
  log("E back button computed focus style:", await page.evaluate(() => {
    const b = document.querySelector("#onboardingBack"); b.focus();
    const s = getComputedStyle(b);
    return { outline: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`, isFocused: document.activeElement === b };
  }));
  // Enter on the disabled Continue
  await page.evaluate(() => document.querySelector("#nameInput").focus());
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  log("E Enter on empty name -> still name step:", await page.evaluate(() => !!document.querySelector("#nameInput")));
  await ctx.close();
}

/* --- F: rerun of full flow, watching for any console error incl. supabase --- */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") errors.push(`[F/full] console.error: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`[F/full] pageerror: ${e.message}`));
  page.on("requestfailed", (r) => errors.push(`[F/full] requestfailed: ${r.url()} :: ${r.failure()?.errorText}`));
  const infos = [];
  page.on("console", (m) => { if (m.type() === "info" || m.type() === "log") infos.push(m.text().slice(0, 140)); });
  await toStep(page, { name: "Fiona", gender: "Female", age: "Under 18" }).catch(async (e) => {
    // Under 18 needs the gate
    log("F expected: under-18 blocked at age step ->", e.message.split("\n")[0]);
  });
  if (await page.$("#minorConfirm")) {
    await page.click("#minorConfirm");
    await page.click("#ageContinue");
    await page.waitForSelector("#aestheticSearchInput");
  }
  await page.waitForTimeout(600);
  await page.evaluate(() => document.querySelector('[data-vibe="Coastal"]').click());
  await page.waitForTimeout(200);
  await page.click("#aestheticContinue");
  await page.waitForTimeout(1000);
  log("F done screen:", await page.evaluate(() => ({ active: document.querySelector("#doneScreen").classList.contains("is-active"), name: document.querySelector("#doneName").textContent })));
  await page.waitForTimeout(3500);
  log("F home:", await page.evaluate(() => document.querySelector("#homeScreen").classList.contains("is-active")));
  log("F console info/log:", infos.slice(0, 15));
  await ctx.close();
}

log("\n============ ERRORS ============");
if (!errors.length) log("(none)");
else [...new Set(errors)].forEach((e) => log(" -", e));
await browser.close();
