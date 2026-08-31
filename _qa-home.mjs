import { chromium } from "playwright";

const BASE = "http://127.0.0.1:8202/";
const logs = [];
const out = (...a) => { const s = a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "); console.log(s); };

function wire(page, tag = "") {
  page.on("console", (m) => {
    const t = m.type();
    if (t === "error" || t === "warning") logs.push({ kind: `console.${t}`, text: m.text(), loc: m.location(), tag });
  });
  page.on("pageerror", (e) => logs.push({ kind: "pageerror", text: e.message, stack: (e.stack || "").split("\n").slice(0, 4).join(" | "), tag }));
  page.on("requestfailed", (r) => logs.push({ kind: "requestfailed", text: `${r.url()} :: ${r.failure()?.errorText}`, tag }));
}

async function reachHome(page, tag) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  // splash -> login
  await page.waitForSelector("#splashScreen.is-active", { timeout: 5000 }).catch(() => {});
  await page.click("#splashScreen").catch(() => {});
  await page.waitForSelector("#loginScreen.is-active", { timeout: 15000 });
  // Use signup button -> onboarding
  await page.click("#signupButton");
  await page.waitForSelector("#nameInput", { timeout: 10000 });
  await page.fill("#nameInput", "Vish");
  await page.click("#nameContinue");
  await page.waitForSelector("#skipGender", { timeout: 10000 });
  await page.click("#skipGender");
  await page.waitForSelector("#ageContinue", { timeout: 10000 });
  await page.click('[data-selection="25-34"]').catch(async () => {
    const first = await page.$$('#onboardingStep [data-selection]');
    await first[2].click();
  });
  await page.click("#ageContinue");
  await page.waitForSelector("#aestheticContinue", { timeout: 10000 });
  const vibes = await page.$$eval("#tagCloud [data-vibe]", (els) => els.slice(0, 2).map((e) => e.dataset.vibe));
  for (const v of vibes) { await page.click(`#tagCloud [data-vibe="${v}"]`); await page.waitForTimeout(150); }
  await page.click("#aestheticContinue");
  await page.waitForSelector("#homeScreen.is-active", { timeout: 25000 });
  await page.waitForTimeout(1500);
}

const results = {};

async function run() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  const page = await ctx.newPage();
  wire(page, "main");
  await reachHome(page, "main");
  out("### reached Home");

  // --- Greeting
  results.greeting = await page.evaluate(() => ({
    greeting: document.querySelector("#homeGreeting")?.textContent,
    name: document.querySelector("#homeGreetingName")?.textContent,
    initial: document.querySelector("#homeInitial")?.textContent,
    hour: new Date().getHours(),
  }));
  out("greeting:", results.greeting);

  // --- Chat dock at rest
  const dockBox = async () => page.evaluate(() => {
    const f = document.querySelector("#homeChatForm");
    const r = f.getBoundingClientRect();
    const tabs = document.querySelector(".home-tabs").getBoundingClientRect();
    const tabsStyle = getComputedStyle(document.querySelector(".home-tabs"));
    return { y: r.y, h: r.height, x: r.x, w: r.width, tabsY: tabs.y, tabsH: tabs.height, tabsOpacity: tabsStyle.opacity, tabsVis: tabsStyle.visibility, tabsTransform: tabsStyle.transform };
  });
  const rest = await dockBox();
  await page.click("#homeChatInput");
  await page.waitForTimeout(400);
  const focused = await dockBox();
  const long = "A".repeat(150) + " " + "hello world ".repeat(13);
  await page.type("#homeChatInput", long.slice(0, 300), { delay: 0 });
  await page.waitForTimeout(300);
  const typed = await dockBox();
  results.dock = { rest, focused, typed, moveOnFocus: +(focused.y - rest.y).toFixed(3), moveOnType: +(typed.y - focused.y).toFixed(3) };
  out("dock:", results.dock);

  results.longText = await page.evaluate(() => {
    const i = document.querySelector("#homeChatInput");
    return { len: i.value.length, active: document.activeElement?.id, selStart: i.selectionStart, tail: i.value.slice(-20) };
  });
  out("longText:", results.longText);

  // fast typing / caret checks
  await page.fill("#homeChatInput", "");
  await page.click("#homeChatInput");
  await page.keyboard.type("the quick brown fox jumps over the lazy dog 0123456789", { delay: 1 });
  results.fastType = await page.evaluate(() => {
    const i = document.querySelector("#homeChatInput");
    return { value: i.value, ok: i.value === "the quick brown fox jumps over the lazy dog 0123456789", caret: i.selectionStart, active: document.activeElement?.id };
  });
  out("fastType:", results.fastType);

  // select-all replace
  await page.keyboard.press("Control+a");
  await page.keyboard.type("replaced text");
  results.selectAllReplace = await page.evaluate(() => {
    const i = document.querySelector("#homeChatInput");
    return { value: i.value, active: document.activeElement?.id, sendDisabled: document.querySelector("#homeChatSend").disabled };
  });
  out("selectAllReplace:", results.selectAllReplace);

  // emoji + newline
  await page.fill("#homeChatInput", "");
  await page.click("#homeChatInput");
  await page.keyboard.insertText("hello 😀🎉 emoji");
  await page.keyboard.press("Enter"); // input type=text -> form submit? check
  await page.waitForTimeout(600);
  results.emojiEnter = await page.evaluate(() => ({
    value: document.querySelector("#homeChatInput").value,
    replyHidden: document.querySelector("#homeReplyStrip").hidden,
    replyText: document.querySelector("#homeReplyText").textContent,
    status: document.querySelector("#homeChatStatus").textContent,
  }));
  out("emojiEnter:", results.emojiEnter);
  await page.waitForTimeout(2500);
  results.afterSend = await page.evaluate(() => ({
    value: document.querySelector("#homeChatInput").value,
    replyHidden: document.querySelector("#homeReplyStrip").hidden,
    replyText: document.querySelector("#homeReplyText").textContent,
    sendDisabled: document.querySelector("#homeChatSend").disabled,
  }));
  out("afterSend:", results.afterSend);

  // paste
  await page.evaluate(() => { document.querySelector("#homeChatInput").value = ""; });
  await page.click("#homeChatInput");
  const pasteBefore = await dockBox();
  await page.evaluate(() => {
    const i = document.querySelector("#homeChatInput");
    const dt = new DataTransfer();
    dt.setData("text/plain", "pasted content ".repeat(20));
    i.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    // jsdom-ish: emulate default paste behavior
  });
  await page.keyboard.insertText("pasted content ".repeat(20));
  await page.waitForTimeout(200);
  const pasteAfter = await dockBox();
  results.paste = { moved: +(pasteAfter.y - pasteBefore.y).toFixed(3), len: await page.evaluate(() => document.querySelector("#homeChatInput").value.length), sendDisabled: await page.evaluate(() => document.querySelector("#homeChatSend").disabled) };
  out("paste:", results.paste);

  // blur & tabbar restore
  await page.evaluate(() => { document.querySelector("#homeChatInput").value = ""; document.querySelector("#homeChatInput").dispatchEvent(new Event("input", {bubbles:true})); document.activeElement.blur(); });
  await page.waitForTimeout(400);
  results.afterBlur = await dockBox();
  out("afterBlur:", results.afterBlur);

  // --- Tiles
  results.tiles = [];
  const tileLabels = await page.$$eval("[data-home-action]", (els) => els.map((e) => e.dataset.homeAction));
  out("tileLabels:", tileLabels);
  for (const label of tileLabels) {
    await page.evaluate(() => { const i = document.querySelector("#homeChatInput"); i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); });
    const before = logs.length;
    await page.click(`[data-home-action="${label}"]`);
    await page.waitForTimeout(1800);
    const state = await page.evaluate(() => ({
      chatValue: document.querySelector("#homeChatInput")?.value ?? null,
      activeScreen: [...document.querySelectorAll(".app-screen, [id$='Screen']")].filter(e => e.classList.contains("is-active")).map(e => e.id),
      overlays: [...document.body.children].filter(e => e.id && !e.id.endsWith("Screen")).map(e => e.id).slice(0, 20),
      bodyOverflowNodes: document.body.children.length,
    }));
    results.tiles.push({ label, state, newLogs: logs.slice(before).map(l => `${l.kind}: ${l.text}`) });
    out("tile", label, state, logs.slice(before).map(l => `${l.kind}: ${l.text}`));
    // dismiss any overlay / return home
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      document.querySelectorAll("[data-close], .sheet-close, .scene-close, .studio-close, [aria-label='Close']").forEach(b => b.click());
    });
    await page.waitForTimeout(600);
    const onHome = await page.evaluate(() => document.querySelector("#homeScreen")?.classList.contains("is-active"));
    if (!onHome) {
      await page.click("#homeScreen [data-app-tab='Home'], [data-app-tab='Home']").catch(async () => {
        const btns = await page.$$("[data-app-tab='Home']");
        for (const b of btns) { if (await b.isVisible()) { await b.click(); break; } }
      });
      await page.waitForTimeout(900);
    }
    const back = await page.evaluate(() => document.querySelector("#homeScreen")?.classList.contains("is-active"));
    results.tiles[results.tiles.length - 1].returnedHome = back;
    out("  returned home:", back);
  }

  // --- Carousel
  results.carousel = await page.evaluate(async () => {
    const c = document.querySelector("#gemsCarousel");
    const cards = [...c.querySelectorAll(".home-gem-card")];
    const before = c.scrollLeft;
    c.scrollLeft = c.scrollWidth;
    await new Promise(r => setTimeout(r, 400));
    const after = c.scrollLeft;
    c.scrollLeft = 0;
    const imgs = [...c.querySelectorAll("img")].map(i => ({ src: i.src.slice(0, 60), complete: i.complete, w: i.naturalWidth }));
    return { cards: cards.length, scrollWidth: c.scrollWidth, clientWidth: c.clientWidth, scrolled: after > before, imgs, dots: document.querySelectorAll(".gem-dot").length, status: document.querySelector("#gemCarouselStatus").textContent };
  });
  out("carousel:", results.carousel);
  await page.waitForTimeout(500);
  results.carouselDotsAfterScroll = await page.evaluate(async () => {
    const c = document.querySelector("#gemsCarousel");
    c.scrollLeft = 300; c.dispatchEvent(new Event("scroll"));
    await new Promise(r => setTimeout(r, 300));
    return { active: [...document.querySelectorAll(".gem-dot")].findIndex(d => d.classList.contains("is-active")), status: document.querySelector("#gemCarouselStatus").textContent };
  });
  out("carouselDots:", results.carouselDotsAfterScroll);

  // --- sections presence
  results.sections = await page.evaluate(() => ({
    draftSectionHidden: document.querySelector(".home-draft-section")?.hidden,
    draftBtnVisible: !!document.querySelector("#openDraft")?.offsetParent,
    hiddenGemSectionHidden: document.querySelector(".home-hidden-section")?.hidden,
    trends: [...document.querySelectorAll("[data-pack-scene]")].map(b => b.dataset.packScene),
  }));
  out("sections:", results.sections);

  // draft card navigation (force-show and click)
  results.draftNav = await (async () => {
    await page.evaluate(() => { const s = document.querySelector(".home-draft-section"); if (s) s.hidden = false; });
    await page.click("#openDraft");
    await page.waitForTimeout(1200);
    const r = await page.evaluate(() => ({ studioActive: document.querySelector("#studioScreen")?.classList.contains("is-active"), homeActive: document.querySelector("#homeScreen")?.classList.contains("is-active") }));
    return r;
  })();
  out("draftNav:", results.draftNav);
  // back home
  await page.evaluate(() => { const b = [...document.querySelectorAll("#studioScreen [data-app-tab='Home']")][0]; b?.click(); });
  await page.waitForTimeout(1000);

  // --- overflow at 390
  const overflow = async () => page.evaluate(() => ({
    docScrollW: document.documentElement.scrollWidth,
    docClientW: document.documentElement.clientWidth,
    bodyScrollW: document.body.scrollWidth,
    innerW: window.innerWidth,
    offenders: [...document.querySelectorAll("#homeScreen *")].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1); }).slice(0, 12).map(e => ({ cls: e.className?.toString?.().slice(0, 50), tag: e.tagName, right: Math.round(e.getBoundingClientRect().right), left: Math.round(e.getBoundingClientRect().left) })),
  }));
  results.overflow390 = await overflow();
  out("overflow390:", results.overflow390);

  // --- Tab cycling x3
  const tabs = ["Discover", "Photos", "Studio", "Profile"];
  results.cycles = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    for (const t of tabs) {
      const before = logs.length;
      const clicked = await page.evaluate((t) => {
        const active = [...document.querySelectorAll("[id$='Screen']")].find(e => e.classList.contains("is-active"));
        const btn = active?.querySelector(`[data-app-tab="${t}"]`);
        if (!btn) return false;
        btn.click(); return true;
      }, t);
      await page.waitForTimeout(900);
      const st = await page.evaluate((t) => ({
        activeScreens: [...document.querySelectorAll("[id$='Screen']")].filter(e => e.classList.contains("is-active")).map(e => e.id),
      }), t);
      results.cycles.push({ cycle, tab: t, clicked, ...st, newLogs: logs.slice(before).map(l => `${l.kind}: ${l.text}`) });
      out(`cycle${cycle} -> ${t}`, clicked, st.activeScreens, logs.slice(before).map(l => `${l.kind}: ${l.text}`));
    }
    const before = logs.length;
    await page.evaluate(() => {
      const active = [...document.querySelectorAll("[id$='Screen']")].find(e => e.classList.contains("is-active"));
      active?.querySelector('[data-app-tab="Home"]')?.click();
    });
    await page.waitForTimeout(1000);
    const homeState = await page.evaluate(() => ({
      active: document.querySelector("#homeScreen")?.classList.contains("is-active"),
      chatForms: document.querySelectorAll("#homeChatForm").length,
      tabBars: document.querySelectorAll("#homeScreen .home-tabs").length,
      gemCards: document.querySelectorAll("#homeScreen .home-gem-card").length,
      actionTiles: document.querySelectorAll("#homeScreen [data-home-action]").length,
      trendCards: document.querySelectorAll("#homeScreen [data-pack-scene]").length,
      totalHomeNodes: document.querySelectorAll("#homeScreen *").length,
      scrollTop: document.querySelector("#homeContent")?.scrollTop,
      bodyChildren: document.body.children.length,
      hiddenFileInputs: document.querySelectorAll("body > input[type=file]").length,
    }));
    results.cycles.push({ cycle, tab: "Home", ...homeState, newLogs: logs.slice(before).map(l => `${l.kind}: ${l.text}`) });
    out(`cycle${cycle} -> Home`, homeState, logs.slice(before).map(l => `${l.kind}: ${l.text}`));
  }

  // scroll memory test: scroll home, leave, come back
  await page.evaluate(() => { document.querySelector("#homeContent").scrollTop = 400; });
  await page.waitForTimeout(300);
  const scrolledTo = await page.evaluate(() => document.querySelector("#homeContent").scrollTop);
  await page.evaluate(() => document.querySelector("#homeScreen [data-app-tab='Discover']").click());
  await page.waitForTimeout(900);
  await page.evaluate(() => document.querySelector("#discoverScreen [data-app-tab='Home']")?.click());
  await page.waitForTimeout(900);
  results.scrollMemory = { scrolledTo, afterReturn: await page.evaluate(() => document.querySelector("#homeContent").scrollTop) };
  out("scrollMemory:", results.scrollMemory);

  // listener double-fire test: count taste events / clicks
  results.doubleFire = await page.evaluate(() => {
    let count = 0;
    const el = document.querySelector("#seeAllGems");
    const h = () => count++;
    el.addEventListener("click", h);
    el.click();
    el.removeEventListener("click", h);
    return { seeAllHandlerFires: count };
  });
  // measure real duplicate listeners via counting network/telemetry is hard; use a proxy:
  results.tabClickHandlers = await page.evaluate(() => {
    const btn = document.querySelector("#homeScreen [data-app-tab='Home']");
    let n = 0;
    const orig = btn.click.bind(btn);
    return { ok: true };
  });

  // --- viewport 320
  await page.setViewportSize({ width: 320, height: 568 });
  await page.waitForTimeout(600);
  results.overflow320 = await overflow();
  results.dock320 = await dockBox();
  out("overflow320:", results.overflow320);
  out("dock320:", results.dock320);
  results.clip320 = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll("#homeScreen .home-tab")].map(t => { const r = t.getBoundingClientRect(); return { label: t.textContent.trim(), x: Math.round(r.x), w: Math.round(r.width), right: Math.round(r.right) }; });
    const form = document.querySelector("#homeChatForm").getBoundingClientRect();
    const tabsRect = document.querySelector("#homeScreen .home-tabs").getBoundingClientRect();
    return { tabs, formBottom: form.bottom, tabsBottom: tabsRect.bottom, winH: window.innerHeight, overlap: form.bottom > tabsRect.top };
  });
  out("clip320:", results.clip320);
  // focus at 320
  await page.click("#homeChatInput");
  await page.waitForTimeout(400);
  results.dock320Focus = await dockBox();
  out("dock320Focus:", results.dock320Focus, "move:", results.dock320Focus.y - results.dock320.y);
  await page.evaluate(() => document.activeElement.blur());

  // --- viewport 430
  await page.setViewportSize({ width: 430, height: 932 });
  await page.waitForTimeout(600);
  results.overflow430 = await overflow();
  results.dock430 = await dockBox();
  out("overflow430:", results.overflow430);
  out("dock430:", results.dock430);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);

  // final: full page screenshot for eyeballing
  await page.screenshot({ path: "/private/tmp/claude-501/-Users-vishnusrikanth/27e14023-7753-4125-ab34-3c4d570cb2c3/scratchpad/home.png" });

  out("\n===== LOGS =====");
  logs.forEach(l => out(JSON.stringify(l)));
  out("\n===== SUMMARY =====");
  out(JSON.stringify(results, null, 1));

  await browser.close();
}

run().catch(e => { console.error("FATAL", e); logs.forEach(l => console.log(JSON.stringify(l))); process.exit(1); });
