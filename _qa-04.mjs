import { launch, enterApp } from './_qa-lib.mjs';
const { browser, page, logs } = await launch();
const R=[]; const say=(...a)=>R.push(a.join(' '));
const SP='/private/tmp/claude-501/-Users-vishnusrikanth/27e14023-7753-4125-ab34-3c4d570cb2c3/scratchpad/';
try {
  await enterApp(page);
  await page.click('#homeScreen [data-app-tab="Discover"]');
  await page.waitForTimeout(1500);
  await page.click('[data-discover-category="Dark Gym"]');
  await page.waitForTimeout(400);
  await page.screenshot({path:SP+'d-darkgym.png'});
  await page.click('[data-discover-category="Euro Summer"]');
  await page.waitForTimeout(400);
  await page.screenshot({path:SP+'d-euro.png'});
  await page.click('[data-discover-category="For you"]');
  await page.waitForTimeout(400);
  await page.click('[data-discover-card="1"]');
  await page.waitForTimeout(500);
  await page.screenshot({path:SP+'d-tray.png'});
  // Find photos like this -> should navigate to Photos and run search
  await page.click('[data-discover-action="Find photos like this in my library"][data-discover-card-id="1"]');
  await page.waitForTimeout(1500);
  say('after Find-similar: activeScreen=', await page.evaluate(()=>[...document.querySelectorAll('.screen.is-active')].map(e=>e.id).join(',')));
  say('photos search value=', await page.$eval('#photosSearch',e=>e.value));
  say('photos grid count=', await page.$$eval('#photosGrid [data-photo-id]',e=>e.length), 'libTitle=', await page.$eval('#photosLibraryTitle',e=>e.textContent));
  say('photos empty shown=', await page.$eval('#photosEmpty',e=>e.hidden===false));
  await page.screenshot({path:SP+'p-findsimilar.png'});
} catch(e){ say('FAIL '+e.message); }
console.log(R.join('\n'));
console.log('--- LOGS ---'); logs.forEach(l=>console.log(l));
await browser.close();
