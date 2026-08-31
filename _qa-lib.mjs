import { chromium } from '/Users/vishnusrikanth/assigno/node_modules/playwright/index.mjs';

export const BASE = 'http://127.0.0.1:8203/';

export async function launch({ width = 390, height = 844 } = {}) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') logs.push(`[console.${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${(e.stack||'').split('\n').slice(0,4).join('\n')}`));
  page.on('requestfailed', (r) => {
    const u = r.url();
    if (u.startsWith('http://127.0.0.1:8203')) logs.push(`[requestfailed] ${u} :: ${r.failure()?.errorText}`);
  });
  return { browser, ctx, page, logs };
}

export async function enterApp(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  // skip splash
  await page.click('#splashScreen').catch(()=>{});
  await page.waitForSelector('#loginScreen.is-active', { timeout: 8000 });
  await page.waitForTimeout(500);
  await page.click('#signupButton');
  await page.waitForSelector('#nameInput', { timeout: 8000 });
  await page.fill('#nameInput', 'QA Tester');
  await page.click('#nameContinue');
  await page.waitForSelector('#genderContinue', { timeout: 8000 });
  await page.click('[data-selection="Female"]');
  await page.click('#genderContinue');
  await page.waitForSelector('#ageContinue', { timeout: 8000 });
  await page.click('[data-selection="18–24"]').catch(async () => {
    const b = await page.$$('.age-step [data-selection]');
    await b[1].click();
  });
  await page.click('#ageContinue');
  await page.waitForSelector('#tagCloud [data-vibe]', { timeout: 8000 });
  await page.click('#tagCloud [data-vibe]');
  await page.click('#aestheticContinue');
  await page.waitForSelector('#homeScreen.is-active', { timeout: 20000 });
  await page.waitForTimeout(1200);
}

export async function goTab(page, tab) {
  await page.click(`.gems-app.is-authenticated [data-app-tab="${tab}"], [data-app-tab="${tab}"]`, { force: true });
  await page.waitForTimeout(900);
}
