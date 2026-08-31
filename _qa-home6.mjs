import { chromium } from "playwright";
const BASE = "http://127.0.0.1:8202/";
const out = (...a) => console.log(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "));
const logs = [];
const SP = "/private/tmp/claude-501/-Users-vishnusrikanth/27e14023-7753-4125-ab34-3c4d570cb2c3/scratchpad";
async function reachHome(page) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.click("#splashScreen").catch(() => {});
  await page.waitForSelector("#loginScreen.is-active", { timeout: 15000 });
  await page.click("#signupButton");
  await page.waitForSelector("#nameInput"); await page.fill("#nameInput", "Vish"); await page.click("#nameContinue");
  await page.waitForSelector("#skipGender"); await page.click("#skipGender");
  await page.waitForSelector("#ageContinue");
  const r = await page.$$eval("#onboardingStep [data-selection]", e => e.map(x => x.dataset.selection));
  await page.click(`[data-selection="${r[2] || r[0]}"]`); await page.click("#ageContinue");
  await page.waitForSelector("#aestheticContinue");
  const v = await page.$$eval("#tagCloud [data-vibe]", e => e.slice(0, 2).map(x => x.dataset.vibe));
  for (const x of v) { await page.click(`#tagCloud [data-vibe="${x}"]`); await page.waitForTimeout(120); }
  await page.click("#aestheticContinue");
  await page.waitForSelector("#homeScreen.is-active", { timeout: 25000 });
  await page.waitForTimeout(1200);
}
async function run() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on("pageerror", e => logs.push({ kind: "pageerror", text: e.message }));
  page.on("console", m => { if (m.type() === "error" || m.type() === "warning") logs.push({ kind: m.type(), text: m.text() }); });
  await reachHome(page);
  await page.screenshot({ path: `${SP}/clean-empty-390.png` });
  await page.evaluate(async () => {
    function mk(n) { const c = document.createElement("canvas"); c.width = 700; c.height = 900; const x = c.getContext("2d");
      const g = x.createLinearGradient(0,0,700,900); g.addColorStop(0, `hsl(${n*29},70%,55%)`); g.addColorStop(1, `hsl(${n*53},60%,25%)`); x.fillStyle=g; x.fillRect(0,0,700,900);
      for (let i=0;i<6000;i++){ x.fillStyle=`rgba(${(i*11)%255},${(i*17)%255},${(i*31)%255},.6)`; x.fillRect((i*41)%700,(i*67)%900,3,3);}
      return new Promise(r2 => c.toBlob(b => r2(new File([b], `p${n}.jpg`, {type:"image/jpeg"})), "image/jpeg", .92)); }
    const f = []; for (let i=0;i<10;i++) f.push(await mk(i));
    const lib = await import("/gems-photolib.js"); await lib.importPhotoFiles(f);
  });
  await page.waitForTimeout(2500);
  // dismiss reveal overlay
  const skipped = await page.evaluate(() => { const btns = [...document.querySelectorAll("#gemsRevealRoot button")]; const s = btns.find(b => /skip/i.test(b.textContent)); if (s) { s.click(); return true; } return false; });
  out("skippedReveal:", skipped);
  await page.waitForTimeout(1500);
  await page.evaluate(() => { document.querySelector("#gemsRevealRoot").innerHTML = ""; });
  await page.evaluate(() => { const a = [...document.querySelectorAll("[id$='Screen']")].find(e => e.classList.contains("is-active")); a?.querySelector('[data-app-tab="Discover"]')?.click(); });
  await page.waitForTimeout(900);
  await page.evaluate(() => document.querySelector("#discoverScreen [data-app-tab='Home']").click());
  await page.waitForTimeout(2500);
  for (const [w, h] of [[320, 568], [390, 844], [430, 932]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(600);
    await page.evaluate(() => document.querySelector("#homeContent").scrollTop = 0);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SP}/clean-top-${w}.png` });
    await page.evaluate(() => document.querySelector("#homeContent").scrollTop = 99999);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SP}/clean-bot-${w}.png` });
    out(`checked ${w}`, await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, inner: window.innerWidth,
      chatFormRect: (() => { const r = document.querySelector("#homeChatForm").getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1) }; })(),
      tabsRect: (() => { const r = document.querySelector("#homeScreen .home-tabs").getBoundingClientRect(); return { y: +r.y.toFixed(1), bottom: +r.bottom.toFixed(1) }; })(),
      winH: window.innerHeight })));
  }
  out("LOGS:", logs);
  await browser.close();
}
run().catch(e => { console.error("FATAL", e); process.exit(1); });
