import { chromium } from '/Users/vishnusrikanth/assigno/node_modules/playwright/index.mjs';

const LOG = [];
export async function boot({ width = 390, height = 844 } = {}) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
  });
  const page = await ctx.newPage();
  page.on('console', m => { if (['error','warning'].includes(m.type())) LOG.push(`[console.${m.type()}] ${m.text()}`); });
  page.on('pageerror', e => LOG.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', r => LOG.push(`[requestfailed] ${r.url()} :: ${r.failure()?.errorText}`));
  await page.goto('http://127.0.0.1:8205/', { waitUntil: 'domcontentloaded' });
  return { browser, ctx, page };
}
export function logs() { return LOG; }

export async function reachHome(page) {
  // splash -> login
  await page.waitForTimeout(300);
  await page.click('#splashScreen').catch(()=>{});
  await page.waitForSelector('#signupButton', { state: 'visible', timeout: 15000 });
  await page.click('#signupButton');
  await page.waitForSelector('#nameInput', { timeout: 15000 });
  await page.fill('#nameInput', 'QA Tester');
  await page.click('#nameContinue');
  await page.waitForTimeout(400);
  // gender step: skip
  await page.click('#skipGender');
  await page.waitForTimeout(400);
  // age step
  await page.click('[data-selection="18-24"]').catch(async () => {
    const b = await page.$$('.age-step [data-selection]'); if (b[1]) await b[1].click();
  });
  await page.waitForTimeout(200);
  await page.click('#ageContinue');
  await page.waitForTimeout(500);
  // aesthetics: pick first chip
  await page.waitForSelector('#tagCloud .vibe-chip', { timeout: 10000 });
  await page.click('#tagCloud .vibe-chip');
  await page.waitForTimeout(200);
  await page.click('#aestheticContinue');
  await page.waitForSelector('#homeScreen.is-active', { timeout: 20000 });
  await page.waitForTimeout(800);
}
