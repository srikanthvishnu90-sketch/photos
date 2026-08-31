import { chromium } from "playwright";
const BASE = "http://127.0.0.1:8202/";
const out = (...a) => console.log(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "));
const logs = [];
async function reachHome(page) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.click("#splashScreen").catch(() => {});
  await page.waitForSelector("#loginScreen.is-active", { timeout: 15000 });
  await page.click("#signupButton");
  await page.waitForSelector("#nameInput", { timeout: 10000 });
  await page.fill("#nameInput", "Vish"); await page.click("#nameContinue");
  await page.waitForSelector("#skipGender"); await page.click("#skipGender");
  await page.waitForSelector("#ageContinue");
  const ranges = await page.$$eval("#onboardingStep [data-selection]", e => e.map(x => x.dataset.selection));
  await page.click(`[data-selection="${ranges[2] || ranges[0]}"]`); await page.click("#ageContinue");
  await page.waitForSelector("#aestheticContinue");
  const vibes = await page.$$eval("#tagCloud [data-vibe]", e => e.slice(0, 2).map(x => x.dataset.vibe));
  for (const v of vibes) { await page.click(`#tagCloud [data-vibe="${v}"]`); await page.waitForTimeout(120); }
  await page.click("#aestheticContinue");
  await page.waitForSelector("#homeScreen.is-active", { timeout: 25000 });
  await page.waitForTimeout(1200);
}
async function run() {
  const browser = await chromium.launch();
  for (const [w, h] of [[390, 844], [320, 568], [430, 932]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    page.on("pageerror", e => logs.push({ w, kind: "pageerror", text: e.message }));
    page.on("console", m => { if (m.type() === "error") logs.push({ w, kind: "console.error", text: m.text() }); });
    await reachHome(page);
    await page.evaluate(async () => {
      function mk(n) { const c = document.createElement("canvas"); c.width = 700; c.height = 900; const x = c.getContext("2d");
        const g = x.createLinearGradient(0,0,700,900); g.addColorStop(0, `hsl(${n*29},70%,55%)`); g.addColorStop(1, `hsl(${n*53},60%,25%)`); x.fillStyle=g; x.fillRect(0,0,700,900);
        for (let i=0;i<6000;i++){ x.fillStyle=`rgba(${(i*11)%255},${(i*17)%255},${(i*31)%255},.6)`; x.fillRect((i*41)%700,(i*67)%900,3,3);}
        return new Promise(r => c.toBlob(b => r(new File([b], `p${n}.jpg`, {type:"image/jpeg"})), "image/jpeg", .92)); }
      const files = []; for (let i=0;i<10;i++) files.push(await mk(i));
      const lib = await import("/gems-photolib.js"); await lib.importPhotoFiles(files);
    });
    await page.evaluate(() => document.querySelector("#homeScreen [data-app-tab='Discover']").click());
    await page.waitForTimeout(800);
    await page.evaluate(() => document.querySelector("#discoverScreen [data-app-tab='Home']").click());
    await page.waitForTimeout(2500);
    const geo = await page.evaluate(() => {
      const c = document.querySelector("#gemsCarousel");
      const cards = [...c.querySelectorAll(".home-gem-card")];
      const cs = getComputedStyle(c);
      return { vw: window.innerWidth, cardW: cards[0]?.offsetWidth, gap: cs.gap, columnGap: cs.columnGap, padL: cs.paddingLeft, padR: cs.paddingRight,
        assumedStride: cards[0]?.offsetWidth + 12,
        realStride: cards[1] ? cards[1].offsetLeft - cards[0].offsetLeft : null,
        n: cards.length, scrollW: c.scrollWidth, clientW: c.clientWidth, snapType: cs.scrollSnapType };
    });
    out(`geo@${w}:`, geo);
    const sync = await page.evaluate(async () => {
      const c = document.querySelector("#gemsCarousel");
      const cards = [...c.querySelectorAll(".home-gem-card")];
      const res = [];
      for (let i = 0; i < cards.length; i++) {
        c.scrollLeft = cards[i].offsetLeft - c.offsetLeft; // snap the i-th card into view
        c.dispatchEvent(new Event("scroll"));
        await new Promise(r => setTimeout(r, 250));
        res.push({ card: i + 1, dot: [...document.querySelectorAll("#gemDots .gem-dot")].findIndex(d => d.classList.contains("is-active")) + 1, status: document.querySelector("#gemCarouselStatus").textContent });
      }
      return res;
    });
    out(`dotSync@${w}:`, sync, "MISMATCH:", sync.filter(r => r.dot !== r.card).map(r => `card ${r.card} -> dot ${r.dot} / "${r.status}"`));
    await ctx.close();
  }
  out("LOGS:", logs);
  await browser.close();
}
run().catch(e => { console.error("FATAL", e); process.exit(1); });
