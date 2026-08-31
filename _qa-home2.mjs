import { chromium } from "playwright";

const BASE = "http://127.0.0.1:8202/";
const logs = [];
const out = (...a) => console.log(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "));

function wire(page) {
  page.on("console", (m) => { const t = m.type(); if (t === "error" || t === "warning") logs.push({ kind: `console.${t}`, text: m.text(), loc: m.location() }); });
  page.on("pageerror", (e) => logs.push({ kind: "pageerror", text: e.message, stack: (e.stack || "").split("\n").slice(0, 5).join(" | ") }));
  page.on("requestfailed", (r) => logs.push({ kind: "requestfailed", text: `${r.url()} :: ${r.failure()?.errorText}` }));
}

async function reachHome(page) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#splashScreen.is-active", { timeout: 5000 }).catch(() => {});
  await page.click("#splashScreen").catch(() => {});
  await page.waitForSelector("#loginScreen.is-active", { timeout: 15000 });
  await page.click("#signupButton");
  await page.waitForSelector("#nameInput", { timeout: 10000 });
  await page.fill("#nameInput", "Vish");
  await page.click("#nameContinue");
  await page.waitForSelector("#skipGender", { timeout: 10000 });
  await page.click("#skipGender");
  await page.waitForSelector("#ageContinue", { timeout: 10000 });
  const ranges = await page.$$eval("#onboardingStep [data-selection]", els => els.map(e => e.dataset.selection));
  await page.click(`[data-selection="${ranges[2] || ranges[0]}"]`);
  await page.click("#ageContinue");
  await page.waitForSelector("#aestheticContinue", { timeout: 10000 });
  const vibes = await page.$$eval("#tagCloud [data-vibe]", els => els.slice(0, 2).map(e => e.dataset.vibe));
  for (const v of vibes) { await page.click(`#tagCloud [data-vibe="${v}"]`); await page.waitForTimeout(120); }
  await page.click("#aestheticContinue");
  await page.waitForSelector("#homeScreen.is-active", { timeout: 25000 });
  await page.waitForTimeout(1200);
}

const dockBox = (page) => page.evaluate(() => {
  const f = document.querySelector("#homeChatForm").getBoundingClientRect();
  const t = document.querySelector("#homeScreen .home-tabs").getBoundingClientRect();
  const ts = getComputedStyle(document.querySelector("#homeScreen .home-tabs"));
  return { y: +f.y.toFixed(2), h: +f.height.toFixed(2), tabsY: +t.y.toFixed(2), tabsVis: ts.visibility, tabsOpacity: ts.opacity };
});

async function run() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  wire(page);
  await reachHome(page);
  out("### home");

  // ---- A. select-all replace with Meta+A
  await page.click("#homeChatInput");
  await page.keyboard.type("original message here");
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("REPLACED");
  out("metaSelectAll:", await page.evaluate(() => ({ v: document.querySelector("#homeChatInput").value, active: document.activeElement?.id })));
  // also try ControlOrMeta
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("X");
  out("ctrlOrMetaSelectAll:", await page.evaluate(() => document.querySelector("#homeChatInput").value));

  // ---- B. reply strip vs dock position
  await page.evaluate(() => { const i = document.querySelector("#homeChatInput"); i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); });
  const beforeReply = await dockBox(page);
  await page.evaluate(() => { const i = document.querySelector("#homeChatInput"); i.value = "hello there"; i.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.click("#homeChatSend");
  await page.waitForTimeout(2500);
  const afterReply = await dockBox(page);
  out("replyStripDockMove:", { beforeReply, afterReply, delta: +(afterReply.y - beforeReply.y).toFixed(2) });
  out("replyState:", await page.evaluate(() => ({ hidden: document.querySelector("#homeReplyStrip").hidden, text: document.querySelector("#homeReplyText").textContent, chips: document.querySelector("#homeReplyChips").hidden, inputVal: document.querySelector("#homeChatInput").value, sendDisabled: document.querySelector("#homeChatSend").disabled })));

  // dock still fixed while reply visible + typing
  await page.click("#homeChatInput");
  await page.waitForTimeout(300);
  const f1 = await dockBox(page);
  await page.keyboard.type("x".repeat(120), { delay: 0 });
  await page.waitForTimeout(200);
  const f2 = await dockBox(page);
  out("dockWithReply:", { f1, f2, move: +(f2.y - f1.y).toFixed(2) });

  // ---- C. trend strip scroll + clipping
  out("trendStrip:", await page.evaluate(async () => {
    const s = document.querySelector(".trend-strip");
    const cs = getComputedStyle(s);
    const before = s.scrollLeft;
    s.scrollLeft = 9999;
    await new Promise(r => setTimeout(r, 200));
    const after = s.scrollLeft;
    s.scrollLeft = 0;
    return { overflowX: cs.overflowX, scrollWidth: s.scrollWidth, clientWidth: s.clientWidth, scrolled: after > before, maxScroll: after, rectRight: s.getBoundingClientRect().right, win: window.innerWidth };
  }));

  // ---- D. seed photos then check carousel + hidden gem
  const seeded = await page.evaluate(async () => {
    function makeFile(name, r, g, b) {
      const c = document.createElement("canvas");
      c.width = 640; c.height = 800;
      const x = c.getContext("2d");
      const grad = x.createLinearGradient(0, 0, 640, 800);
      grad.addColorStop(0, `rgb(${r},${g},${b})`);
      grad.addColorStop(1, `rgb(${255 - r},${g},${255 - b})`);
      x.fillStyle = grad; x.fillRect(0, 0, 640, 800);
      x.fillStyle = "#fff"; x.font = "bold 90px sans-serif"; x.fillText(name, 40, 400);
      // add noise/detail so quality metrics are non-trivial
      for (let i = 0; i < 4000; i++) { x.fillStyle = `rgba(${(i*7)%255},${(i*13)%255},${(i*29)%255},0.5)`; x.fillRect((i*37)%640, (i*53)%800, 3, 3); }
      return new Promise(res => c.toBlob(b2 => res(new File([b2], `${name}.jpg`, { type: "image/jpeg" })), "image/jpeg", 0.92));
    }
    const files = [];
    for (let i = 0; i < 6; i++) files.push(await makeFile(`P${i}`, 30 + i * 35, 80 + i * 20, 200 - i * 25));
    const lib = await import("/gems-photolib.js");
    const added = await lib.importPhotoFiles(files);
    return { added: added?.length ?? 0, total: (await lib.listPhotos()).length };
  });
  out("seeded:", seeded);

  // force home to refresh via tab round-trip
  await page.evaluate(() => document.querySelector("#homeScreen [data-app-tab='Discover']").click());
  await page.waitForTimeout(900);
  await page.evaluate(() => document.querySelector("#discoverScreen [data-app-tab='Home']").click());
  await page.waitForTimeout(2500);

  out("carouselReal:", await page.evaluate(async () => {
    const c = document.querySelector("#gemsCarousel");
    const cards = [...c.querySelectorAll(".home-gem-card")];
    const imgs = [...c.querySelectorAll("img")].map(i => ({ complete: i.complete, nw: i.naturalWidth, src: i.src.slice(0, 30) }));
    const before = c.scrollLeft; c.scrollLeft = 9999; await new Promise(r => setTimeout(r, 250)); const after = c.scrollLeft;
    return { cards: cards.length, imgs, scrolled: after > before, scrollW: c.scrollWidth, clientW: c.clientWidth,
      dotsHidden: document.querySelector("#gemDots").hidden, dots: document.querySelectorAll("#gemDots .gem-dot").length,
      seeAll: document.querySelector("#seeAllGems").textContent, seeAllHidden: document.querySelector("#seeAllGems").hidden,
      status: document.querySelector("#gemCarouselStatus").textContent,
      labels: cards.map(x => x.querySelector("strong")?.textContent) };
  }));
  await page.waitForTimeout(500);
  out("carouselDotsSync:", await page.evaluate(async () => {
    const c = document.querySelector("#gemsCarousel");
    c.scrollLeft = c.clientWidth; c.dispatchEvent(new Event("scroll"));
    await new Promise(r => setTimeout(r, 400));
    return { active: [...document.querySelectorAll("#gemDots .gem-dot")].findIndex(d => d.classList.contains("is-active")), status: document.querySelector("#gemCarouselStatus").textContent };
  }));
  out("hiddenGem:", await page.evaluate(() => {
    const s = document.querySelector(".home-hidden-section");
    const img = document.querySelector(".hidden-gem-photo");
    return { hidden: s?.hidden, hasImg: !!img, imgOk: img ? img.complete && img.naturalWidth > 0 : null,
      title: document.querySelector(".hidden-gem-copy strong")?.textContent,
      detail: document.querySelector(".hidden-gem-copy small")?.textContent };
  }));
  out("draftSection:", await page.evaluate(() => ({ hidden: document.querySelector(".home-draft-section")?.hidden })));

  // gem card click -> Photos
  const gemClick = await page.evaluate(() => { const b = document.querySelector("#gemsCarousel .home-gem-card"); if (!b) return false; b.click(); return true; });
  await page.waitForTimeout(1200);
  out("gemCardNav:", { gemClick, active: await page.evaluate(() => [...document.querySelectorAll("[id$='Screen']")].filter(e => e.classList.contains("is-active")).map(e => e.id)) });
  await page.evaluate(() => document.querySelector("#photosScreen [data-app-tab='Home']")?.click());
  await page.waitForTimeout(1200);

  // ---- E. tiles: second tap behaviour + overlay accumulation
  const tileSeq = ["Commitment post", "Euro Summer", "Edit a photo", "Find my best photos", "Commitment post", "Euro Summer"];
  for (const label of tileSeq) {
    const homeNow = await page.evaluate(() => document.querySelector("#homeScreen")?.classList.contains("is-active"));
    if (!homeNow) { await page.evaluate(() => { const a = [...document.querySelectorAll("[id$='Screen']")].find(e => e.classList.contains("is-active")); a?.querySelector('[data-app-tab="Home"]')?.click(); }); await page.waitForTimeout(900); }
    const before = logs.length;
    await page.evaluate((l) => document.querySelector(`[data-home-action="${l}"]`)?.click(), label);
    await page.waitForTimeout(2000);
    const st = await page.evaluate(() => ({
      chat: document.querySelector("#homeChatInput")?.value,
      bodyKids: [...document.body.children].map(e => e.id || e.tagName + "." + (e.className || "").toString().slice(0, 25)),
      overlayCount: document.querySelectorAll("body > div:not(#gemsApp)").length,
      active: [...document.querySelectorAll("[id$='Screen']")].filter(e => e.classList.contains("is-active")).map(e => e.id),
      reply: { hidden: document.querySelector("#homeReplyStrip")?.hidden, text: document.querySelector("#homeReplyText")?.textContent },
    }));
    out("TILE", label, st, logs.slice(before).map(l => `${l.kind}: ${l.text}`));
    // close overlay
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    await page.evaluate(() => { document.querySelectorAll("body > div:not(#gemsApp) [aria-label='Close'], body > div:not(#gemsApp) .close, body > div:not(#gemsApp) [data-close]").forEach(b => b.click()); });
    await page.waitForTimeout(600);
  }
  out("afterTiles bodyKids:", await page.evaluate(() => [...document.body.children].map(e => e.id || e.tagName)));

  // ---- F. rapid tab switching
  const beforeRapid = logs.length;
  for (let i = 0; i < 12; i++) {
    await page.evaluate(() => { const a = [...document.querySelectorAll("[id$='Screen']")].find(e => e.classList.contains("is-active")); const tabs = ["Home","Discover","Photos","Studio","Profile"]; const t = tabs[Math.floor(Math.random()*5)]; a?.querySelector(`[data-app-tab="${t}"]`)?.click(); });
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(1500);
  await page.evaluate(() => { const a = [...document.querySelectorAll("[id$='Screen']")].find(e => e.classList.contains("is-active")); a?.querySelector('[data-app-tab="Home"]')?.click(); });
  await page.waitForTimeout(1200);
  out("rapidTabs:", await page.evaluate(() => ({
    activeScreens: [...document.querySelectorAll("[id$='Screen']")].filter(e => e.classList.contains("is-active")).map(e => e.id),
    visibleScreens: [...document.querySelectorAll("[id$='Screen']")].filter(e => !e.hidden).map(e => e.id),
    homeNodes: document.querySelectorAll("#homeScreen *").length,
    chatForms: document.querySelectorAll("#homeChatForm").length,
  })), logs.slice(beforeRapid).map(l => `${l.kind}: ${l.text}`));

  // ---- G. double-tap same tile / tab
  const beforeDbl = logs.length;
  await page.evaluate(() => { const b = document.querySelector("#homeScreen [data-app-tab='Home']"); b.click(); b.click(); b.click(); });
  await page.waitForTimeout(800);
  out("homeTabSelfClick:", await page.evaluate(() => ({ active: document.querySelector("#homeScreen").classList.contains("is-active"), tabs: document.querySelectorAll("#homeScreen .home-tabs").length })), logs.slice(beforeDbl).map(l => `${l.kind}: ${l.text}`));

  // ---- H. dock while send in flight (no network -> fails fast)
  await page.evaluate(() => { const i = document.querySelector("#homeChatInput"); i.value = "test in flight"; i.dispatchEvent(new Event("input", { bubbles: true })); });
  const dIn0 = await dockBox(page);
  await page.click("#homeChatSend");
  await page.waitForTimeout(150);
  const dIn1 = await dockBox(page);
  await page.waitForTimeout(3000);
  const dIn2 = await dockBox(page);
  out("inFlightDock:", { dIn0, dIn1, dIn2 });

  // ---- I. profile via avatar & back
  await page.evaluate(() => document.querySelector("#homeProfile").click());
  await page.waitForTimeout(1200);
  out("avatarNav:", await page.evaluate(() => [...document.querySelectorAll("[id$='Screen']")].filter(e => e.classList.contains("is-active")).map(e => e.id)));
  await page.evaluate(() => document.querySelector("#profileScreen [data-app-tab='Home']")?.click());
  await page.waitForTimeout(1000);

  // ---- J. overflow re-check with real content at 3 widths
  for (const [w, h] of [[320, 568], [390, 844], [430, 932]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(600);
    out(`overflow ${w}:`, await page.evaluate(() => ({
      docScrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, bodyScrollW: document.body.scrollWidth,
      pageScrollX: (() => { window.scrollTo(9999, 0); const x = window.scrollX; window.scrollTo(0, 0); return x; })(),
      clipped: [...document.querySelectorAll("#homeScreen .home-section, #homeScreen .home-header, #homeScreen .home-bottom-chrome, #homeScreen .home-action, #homeScreen .home-tab")].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > window.innerWidth + 0.6 || r.left < -0.6); }).map(e => ({ c: e.className.toString().slice(0, 40), l: +e.getBoundingClientRect().left.toFixed(1), r: +e.getBoundingClientRect().right.toFixed(1) })),
      dockBottomGap: window.innerHeight - document.querySelector("#homeScreen .home-tabs").getBoundingClientRect().bottom,
      tabLabelsWrapped: [...document.querySelectorAll("#homeScreen .home-tab span:not(.home-tab-icon)")].map(s => ({ t: s.textContent, sw: s.scrollWidth, cw: s.clientWidth })),
      actionTilesOverflow: [...document.querySelectorAll("#homeScreen .home-action")].map(a => ({ t: a.textContent.trim(), sw: a.scrollWidth, cw: a.clientWidth, over: a.scrollWidth > a.clientWidth + 1 })),
    })));
    await page.screenshot({ path: `/private/tmp/claude-501/-Users-vishnusrikanth/27e14023-7753-4125-ab34-3c4d570cb2c3/scratchpad/home-${w}.png`, fullPage: false });
  }

  out("\n===== LOGS =====");
  logs.forEach(l => out(JSON.stringify(l)));
  await browser.close();
}
run().catch(e => { console.error("FATAL", e); logs.forEach(l => console.log(JSON.stringify(l))); process.exit(1); });
