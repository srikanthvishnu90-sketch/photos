import { chromium } from "playwright";
const BASE = "http://127.0.0.1:8202/";
const out = (...a) => console.log(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "));
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
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 320, height: 568 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  await reachHome(p);
  await p.evaluate(async () => {
    function mk(n){const c=document.createElement("canvas");c.width=700;c.height=900;const x=c.getContext("2d");
      const g=x.createLinearGradient(0,0,700,900);g.addColorStop(0,`hsl(${n*29},70%,55%)`);g.addColorStop(1,`hsl(${n*53},60%,25%)`);x.fillStyle=g;x.fillRect(0,0,700,900);
      for(let i=0;i<6000;i++){x.fillStyle=`rgba(${(i*11)%255},${(i*17)%255},${(i*31)%255},.6)`;x.fillRect((i*41)%700,(i*67)%900,3,3);}
      return new Promise(r=>c.toBlob(bl=>r(new File([bl],`p${n}.jpg`,{type:"image/jpeg"})),"image/jpeg",.92));}
    const f=[];for(let i=0;i<8;i++)f.push(await mk(i));
    const lib=await import("/gems-photolib.js");await lib.importPhotoFiles(f);
  });
  await p.waitForTimeout(2500);
  await p.evaluate(() => { const s=[...document.querySelectorAll("#gemsRevealRoot button")].find(x=>/skip/i.test(x.textContent)); s?.click(); });
  await p.waitForTimeout(1200);
  await p.evaluate(() => document.querySelector("#gemsRevealRoot").innerHTML = "");
  await p.evaluate(() => { const a=[...document.querySelectorAll("[id$='Screen']")].find(e=>e.classList.contains("is-active")); a?.querySelector('[data-app-tab="Discover"]')?.click(); });
  await p.waitForTimeout(800);
  await p.evaluate(() => document.querySelector("#discoverScreen [data-app-tab='Home']").click());
  await p.waitForTimeout(2500);

  out("placeholderFit@320:", await p.evaluate(() => {
    const i = document.querySelector("#homeChatInput");
    const send = document.querySelector("#homeChatSend").getBoundingClientRect();
    const ir = i.getBoundingClientRect();
    // measure rendered width of the placeholder string
    const span = document.createElement("span");
    const cs = getComputedStyle(i);
    span.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${cs.font};letter-spacing:${cs.letterSpacing}`;
    span.textContent = i.placeholder;
    document.body.append(span);
    const textW = span.getBoundingClientRect().width;
    span.remove();
    return { inputW: +ir.width.toFixed(1), inputRight: +ir.right.toFixed(1), sendLeft: +send.left.toFixed(1), placeholder: i.placeholder, placeholderW: +textW.toFixed(1), clipped: textW > ir.width, overflowPx: +(textW - ir.width).toFixed(1), font: cs.font };
  }));

  out("hiddenGemLayout@320:", await p.evaluate(() => {
    const cap = document.querySelector(".hidden-gem-caption").getBoundingClientRect();
    const copy = document.querySelector(".hidden-gem-copy").getBoundingClientRect();
    const strong = document.querySelector(".hidden-gem-copy strong");
    const small = document.querySelector(".hidden-gem-copy small");
    const act = document.querySelector(".hidden-gem-action").getBoundingClientRect();
    const card = document.querySelector("#openHiddenGem").getBoundingClientRect();
    return { cardW: +card.width.toFixed(1), copyW: +copy.width.toFixed(1), actionW: +act.width.toFixed(1),
      strongLines: Math.round(strong.getBoundingClientRect().height / parseFloat(getComputedStyle(strong).lineHeight)),
      smallTruncated: small.scrollWidth > small.clientWidth + 1, smallScrollW: small.scrollWidth, smallClientW: small.clientWidth,
      smallText: small.textContent, overlapCopyAction: copy.right > act.left + 0.5 };
  }));

  await p.setViewportSize({ width: 390, height: 844 }); await p.waitForTimeout(500);
  out("placeholderFit@390:", await p.evaluate(() => {
    const i = document.querySelector("#homeChatInput"); const ir = i.getBoundingClientRect();
    const span = document.createElement("span"); const cs = getComputedStyle(i);
    span.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${cs.font};letter-spacing:${cs.letterSpacing}`;
    span.textContent = i.placeholder; document.body.append(span);
    const w = span.getBoundingClientRect().width; span.remove();
    return { inputW: +ir.width.toFixed(1), placeholderW: +w.toFixed(1), clipped: w > ir.width };
  }));
  await b.close();
}
run().catch(e => { console.error("FATAL", e); process.exit(1); });
