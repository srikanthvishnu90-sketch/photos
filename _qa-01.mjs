import { launch, enterApp } from './_qa-lib.mjs';
const { browser, page, logs } = await launch();
try {
  await enterApp(page);
  console.log('ENTERED APP OK');
  // Go to Discover
  const tabs = await page.$$eval('[data-app-tab]', els => els.map(e => e.dataset.appTab + '|' + (e.closest('[hidden]')?'hidden':'vis')));
  console.log('tabs:', JSON.stringify(tabs));
  await page.click('#homeScreen [data-app-tab="Discover"]');
  await page.waitForTimeout(1200);
  console.log('discover active:', await page.$eval('#discoverScreen', e => e.className + ' hidden=' + e.hidden));
  console.log('cards:', await page.$$eval('[data-discover-card]', e=>e.length));
  console.log('chips:', await page.$$eval('[data-discover-category]', e=>e.map(x=>x.dataset.discoverCategory)));
} catch (e) { console.log('FAIL', e.message); }
console.log('--- LOGS ---'); logs.forEach(l=>console.log(l));
await browser.close();
