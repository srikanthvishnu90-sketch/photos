import { chromium } from "playwright";
const BASE = "http://127.0.0.1:8202/";
const logs = [];
const out = (...a) => console.log(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "));
function wire(page) {
  page.on("console", m => { const t = m.type(); if (t === "error" || t === "warning") logs.push({ kind: `console.${t}`, text: m.text(), loc: m.location() }); });
  page.on("pageerror", e => logs.push({ kind: "pageerror", text: e.message, stack: (e.stack || "").split("\n").slice(0, 5).join(" | ") }));
  page.on("requestfailed", r => logs.push({ kind: "requestfailed", text: `${r.url()} :: ${r.failure()?.errorText}` }));
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
const setChat = (page, v) => page.evaluate(v => { const i = document.querySelector("#homeChatInput"); i.value = v; i.dispatchEvent(new Event("input", { bubbles: true })); }, v);
const getChat = page => page.evaluate(() => document.querySelector("#homeChatInput").value);

async function run() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  wire(page);
  await reachHome(page);
  out("### home");

  // 1. Does tapping a tile destroy a typed draft?
  for (const label of ["Commitment post", "Euro Summer", "Edit a photo", "Find my best photos"]) {
    await page.evaluate(() => { const a = [...document.querySelectorAll("[id$='Screen']")].find(e => e.classList.contains("is-active")); if (a?.id !== "homeScreen") a?.querySelector('[data-app-tab="Home"]')?.click(); });
    await page.waitForTimeout(800);
    await setChat(page, "MY IMPORTANT DRAFT");
    await page.evaluate(l => document.querySelector(`[data-home-action="${l}"]`).click(), label);
    await page.waitForTimeout(2200);
    out(`draftAfterTile[${label}]:`, JSON.stringify(await getChat(page)), "sendDisabled:", await page.evaluate(() => document.querySelector("#homeChatSend").disabled), "reply:", await page.evaluate(() => document.querySelector("#homeReplyText").textContent));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
    await page.evaluate(() => document.querySelectorAll("body > div:not(#gemsApp) [aria-label='Close']").forEach(b => b.click()));
    await page.waitForTimeout(500);
  }

  // 2. Message loss on failed send
  await page.evaluate(() => { const a = [...document.querySelectorAll("[id$='Screen']")].find(e => e.classList.contains("is-active")); if (a?.id !== "homeScreen") a?.querySelector('[data-app-tab="Home"]')?.click(); });
  await page.waitForTimeout(800);
  await page.route("**/functions/v1/gems-chat", r => r.abort());
  const longMsg = "Here is a really long carefully written prompt that I do not want to lose. " .repeat(4);
  await setChat(page, longMsg);
  await page.click("#homeChatSend");
  await page.waitForTimeout(200);
  out("duringSend:", { chat: JSON.stringify((await getChat(page)).slice(0, 40)), status: await page.evaluate(() => document.querySelector("#homeChatStatus").textContent.slice(0, 40)) });
  await page.waitForTimeout(4000);
  out("afterFailedSend:", { chat: JSON.stringify(await getChat(page)), reply: await page.evaluate(() => document.querySelector("#homeReplyText").textContent), sendDisabled: await page.evaluate(() => document.querySelector("#homeChatSend").disabled) });
  await page.unroute("**/functions/v1/gems-chat");

  // 3. Caret behaviour: insert in middle
  await setChat(page, "");
  await page.click("#homeChatInput");
  await page.keyboard.type("hello world");
  await page.evaluate(() => { const i = document.querySelector("#homeChatInput"); i.setSelectionRange(5, 5); });
  await page.keyboard.type(" BIG");
  out("midInsert:", await page.evaluate(() => { const i = document.querySelector("#homeChatInput"); return { v: i.value, caret: i.selectionStart, active: document.activeElement?.id }; }));

  // 4. Newline attempts
  await setChat(page, "");
  await page.click("#homeChatInput");
  await page.keyboard.insertText("line1\nline2\nline3");
  out("newlineInsert:", await page.evaluate(() => { const i = document.querySelector("#homeChatInput"); return { v: JSON.stringify(i.value), len: i.value.length, hasNewline: i.value.includes("\n") }; }));
  await page.keyboard.down("Shift"); await page.keyboard.press("Enter"); await page.keyboard.up("Shift");
  await page.waitForTimeout(500);
  out("shiftEnter:", await getChat(page));

  // 5. Paperclip attach
  const beforeAttach = logs.length;
  const dockBefore = await page.evaluate(() => document.querySelector("#homeChatForm").getBoundingClientRect().y);
  await page.evaluate(() => document.querySelector("#attachPhoto").click());
  await page.waitForTimeout(1800);
  out("attach:", await page.evaluate(() => ({
    overlays: [...document.body.children].map(e => e.id || e.className.toString().slice(0, 30)),
    attachHidden: document.querySelector("#homeChatAttach").hidden,
    dockY: document.querySelector("#homeChatForm").getBoundingClientRect().y,
  })), "before:", dockBefore, logs.slice(beforeAttach).map(l => `${l.kind}: ${l.text}`));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  await page.evaluate(() => document.querySelectorAll("body > div:not(#gemsApp) [aria-label='Close']").forEach(b => b.click()));
  await page.waitForTimeout(600);

  // 6. Trend pack buttons (all 8)
  for (const pack of ["euro-summer", "dubai", "old-money", "luxury-cars", "beach-club", "boat", "dark-luxe", "after-dark"]) {
    await page.evaluate(() => { const a = [...document.querySelectorAll("[id$='Screen']")].find(e => e.classList.contains("is-active")); if (a?.id !== "homeScreen") a?.querySelector('[data-app-tab="Home"]')?.click(); });
    await page.waitForTimeout(500);
    const b4 = logs.length;
    await page.evaluate(p => document.querySelector(`[data-pack-scene="${p}"]`).click(), pack);
    await page.waitForTimeout(1600);
    const st = await page.evaluate(() => ({ overlay: [...document.body.children].filter(e => !e.id && e.tagName === "DIV").map(e => e.className.toString().slice(0, 30)), title: document.querySelector("body > div:not(#gemsApp) h1, body > div:not(#gemsApp) h2")?.textContent?.slice(0, 50) }));
    out("PACK", pack, st, logs.slice(b4).map(l => `${l.kind}: ${l.text}`));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    await page.evaluate(() => document.querySelectorAll("body > div:not(#gemsApp) [aria-label='Close']").forEach(b => b.click()));
    await page.waitForTimeout(500);
  }
  out("bodyAfterPacks:", await page.evaluate(() => [...document.body.children].map(e => e.id || e.tagName + "." + e.className.toString().slice(0, 25))));

  // 7. Discover link + See all
  await page.evaluate(() => { const a = [...document.querySelectorAll("[id$='Screen']")].find(e => e.classList.contains("is-active")); if (a?.id !== "homeScreen") a?.querySelector('[data-app-tab="Home"]')?.click(); });
  await page.waitForTimeout(700);
  await page.evaluate(() => document.querySelector("#discoverVibes").click());
  await page.waitForTimeout(1000);
  out("discoverLink:", await page.evaluate(() => [...document.querySelectorAll("[id$='Screen']")].filter(e => e.classList.contains("is-active")).map(e => e.id)));
  await page.evaluate(() => document.querySelector("#discoverScreen [data-app-tab='Home']").click());
  await page.waitForTimeout(1000);
  const b5 = logs.length;
  await page.evaluate(() => document.querySelector("#seeAllGems").click());
  await page.waitForTimeout(1200);
  out("seeAllGems:", await page.evaluate(() => ({ active: [...document.querySelectorAll("[id$='Screen']")].filter(e => e.classList.contains("is-active")).map(e => e.id), hidden: document.querySelector("#seeAllGems").hidden })), logs.slice(b5).map(l => `${l.kind}: ${l.text}`));

  // 8. Home import button (cancel picker)
  const b6 = logs.length;
  await page.evaluate(() => document.querySelector("#homeImport").click());
  await page.waitForTimeout(2500);
  out("importBtn:", await page.evaluate(() => ({ busy: document.querySelector("#homeImport").classList.contains("is-busy"), disabled: document.querySelector("#homeImport").disabled, label: document.querySelector(".home-import-label").textContent })), logs.slice(b6).map(l => `${l.kind}: ${l.text}`));

  // 9. Reduced motion + re-entry x5 node count
  const counts = [];
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => { const a = [...document.querySelectorAll("[id$='Screen']")].find(e => e.classList.contains("is-active")); a?.querySelector('[data-app-tab="Profile"]')?.click(); });
    await page.waitForTimeout(700);
    await page.evaluate(() => document.querySelector("#profileScreen [data-app-tab='Home']").click());
    await page.waitForTimeout(900);
    counts.push(await page.evaluate(() => ({ n: document.querySelectorAll("#homeScreen *").length, gems: document.querySelectorAll("#gemsCarousel > *").length, dots: document.querySelectorAll("#gemDots > *").length, forms: document.querySelectorAll("#homeChatForm").length, bodyKids: document.body.children.length })));
  }
  out("reentryCounts:", counts);

  out("\n===== LOGS =====");
  logs.forEach(l => out(JSON.stringify(l)));
  await browser.close();
}
run().catch(e => { console.error("FATAL", e); logs.forEach(l => console.log(JSON.stringify(l))); process.exit(1); });
