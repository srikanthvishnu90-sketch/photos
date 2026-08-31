import { chromium } from "playwright";
const BASE = "http://127.0.0.1:8202/";
const logs = [];
const out = (...a) => console.log(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "));
function wire(p) {
  p.on("console", m => { const t = m.type(); if (t === "error" || t === "warning") logs.push({ kind: `console.${t}`, text: m.text(), loc: m.location() }); });
  p.on("pageerror", e => logs.push({ kind: "pageerror", text: e.message, stack: (e.stack || "").split("\n").slice(0, 5).join(" | ") }));
  p.on("requestfailed", r => logs.push({ kind: "requestfailed", text: `${r.url()} :: ${r.failure()?.errorText}` }));
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
async function run() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  wire(page);
  await reachHome(page);
  const seeded = await page.evaluate(async () => {
    function mk(n) { const c = document.createElement("canvas"); c.width = 700; c.height = 900; const x = c.getContext("2d");
      const g = x.createLinearGradient(0,0,700,900); g.addColorStop(0, `hsl(${n*29},70%,55%)`); g.addColorStop(1, `hsl(${n*53},60%,25%)`); x.fillStyle=g; x.fillRect(0,0,700,900);
      for (let i=0;i<6000;i++){ x.fillStyle=`rgba(${(i*11)%255},${(i*17)%255},${(i*31)%255},.6)`; x.fillRect((i*41)%700,(i*67)%900,3,3);}
      x.fillStyle="#fff"; x.font="bold 120px sans-serif"; x.fillText("P"+n, 50, 460);
      return new Promise(r => c.toBlob(b => r(new File([b], `p${n}.jpg`, {type:"image/jpeg"})), "image/jpeg", .92)); }
    const files = []; for (let i=0;i<14;i++) files.push(await mk(i));
    const lib = await import("/gems-photolib.js");
    const added = await lib.importPhotoFiles(files);
    return { added: added.length, total: (await lib.listPhotos()).length };
  });
  out("seeded:", seeded);
  await page.evaluate(() => document.querySelector("#homeScreen [data-app-tab='Discover']").click());
  await page.waitForTimeout(900);
  await page.evaluate(() => document.querySelector("#discoverScreen [data-app-tab='Home']").click());
  await page.waitForTimeout(3000);

  out("carousel:", await page.evaluate(() => ({
    cards: document.querySelectorAll("#gemsCarousel .home-gem-card").length,
    dots: document.querySelectorAll("#gemDots .gem-dot").length,
    dotsHidden: document.querySelector("#gemDots").hidden,
    seeAll: document.querySelector("#seeAllGems").textContent,
    seeAllHidden: document.querySelector("#seeAllGems").hidden,
    status: document.querySelector("#gemCarouselStatus").textContent,
    labels: [...document.querySelectorAll("#gemsCarousel .gem-caption strong")].map(s => s.textContent),
    imgsOk: [...document.querySelectorAll("#gemsCarousel img")].every(i => i.complete && i.naturalWidth > 0),
  })));
  const b = logs.length;
  const before = await page.evaluate(() => [...document.querySelectorAll("[id$='Screen']")].filter(e => e.classList.contains("is-active")).map(e => e.id));
  await page.evaluate(() => document.querySelector("#seeAllGems").click());
  await page.waitForTimeout(1500);
  out("seeAllClick:", { before, after: await page.evaluate(() => [...document.querySelectorAll("[id$='Screen']")].filter(e => e.classList.contains("is-active")).map(e => e.id)), overlays: await page.evaluate(() => [...document.body.children].filter(e => e.tagName === "DIV" && e.id !== "gemsApp" && e.id !== "gemsRevealRoot").length) }, logs.slice(b).map(l => `${l.kind}: ${l.text}`));

  // dot sync across full scroll
  out("dotSync:", await page.evaluate(async () => {
    const c = document.querySelector("#gemsCarousel"); const res = [];
    for (let i = 0; i < 6; i++) {
      c.scrollLeft = i * c.clientWidth; c.dispatchEvent(new Event("scroll"));
      await new Promise(r => setTimeout(r, 250));
      res.push({ i, active: [...document.querySelectorAll("#gemDots .gem-dot")].findIndex(d => d.classList.contains("is-active")), status: document.querySelector("#gemCarouselStatus").textContent });
    }
    c.scrollLeft = 0; return res;
  }));

  // hidden gem
  out("hiddenGem:", await page.evaluate(() => {
    const s = document.querySelector(".home-hidden-section"); const img = document.querySelector(".hidden-gem-photo");
    return { sectionHidden: s.hidden, hasImg: !!img, imgOk: img ? img.complete && img.naturalWidth > 0 : null, imgRect: img ? { w: img.getBoundingClientRect().width, h: img.getBoundingClientRect().height } : null,
      title: document.querySelector(".hidden-gem-copy strong").textContent, detail: document.querySelector(".hidden-gem-copy small").textContent,
      demoSceneStillThere: !!document.querySelector(".hidden-gem .home-scene") };
  }));
  const b2 = logs.length;
  await page.evaluate(() => document.querySelector("#openHiddenGem").click());
  await page.waitForTimeout(2000);
  out("hiddenGemClick:", await page.evaluate(() => [...document.querySelectorAll("[id$='Screen']")].filter(e => e.classList.contains("is-active")).map(e => e.id)), logs.slice(b2).map(l => `${l.kind}: ${l.text}`));
  await page.evaluate(() => { const a = [...document.querySelectorAll("[id$='Screen']")].find(e => e.classList.contains("is-active")); a?.querySelector('[data-app-tab="Home"]')?.click(); });
  await page.waitForTimeout(1500);

  // page overflow with real content, 3 widths, and full-page screenshot
  for (const [w, h] of [[320, 568], [390, 844], [430, 932]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(700);
    out(`ovf${w}:`, await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, inner: window.innerWidth, body: document.body.scrollWidth,
      offenders: [...document.querySelectorAll("#homeScreen *")].filter(e => { const r = e.getBoundingClientRect(); if (!r.width) return false; let p = e.parentElement, clipped = false; while (p) { const cs = getComputedStyle(p); if (cs.overflowX === "auto" || cs.overflowX === "scroll" || cs.overflowX === "hidden") { clipped = true; break; } p = p.parentElement; } return !clipped && (r.right > window.innerWidth + 0.6 || r.left < -0.6); }).map(e => e.className.toString().slice(0, 40)).slice(0, 10) })));
    await page.screenshot({ path: `/private/tmp/claude-501/-Users-vishnusrikanth/27e14023-7753-4125-ab34-3c4d570cb2c3/scratchpad/real-${w}.png` });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  await page.evaluate(() => document.querySelector("#homeContent").scrollTop = 99999);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `/private/tmp/claude-501/-Users-vishnusrikanth/27e14023-7753-4125-ab34-3c4d570cb2c3/scratchpad/real-bottom.png` });

  out("\n===== LOGS ====="); logs.forEach(l => out(JSON.stringify(l)));
  await browser.close();
}
run().catch(e => { console.error("FATAL", e); logs.forEach(l => console.log(JSON.stringify(l))); process.exit(1); });
