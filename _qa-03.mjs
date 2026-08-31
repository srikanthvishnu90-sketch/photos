import { launch, enterApp } from './_qa-lib.mjs';
const { browser, page, logs } = await launch();
const R=[]; const say=(...a)=>R.push(a.join(' '));
const CARDS = {1:['Poses','Travel','Fits'],2:['Nightlife','Photo dumps','Dating'],3:['Photo dumps','Fits','Dating'],4:['Dark Gym','Poses','Fits'],5:['Euro Summer','Travel','Photo dumps'],6:['Travel','Poses','Dating']};
try {
  await enterApp(page);
  await page.click('#homeScreen [data-app-tab="Discover"]');
  await page.waitForTimeout(1500);

  const chips = await page.$$eval('[data-discover-category]', e=>e.map(x=>x.dataset.discoverCategory));
  for (const c of chips) {
    await page.click(`[data-discover-category="${c}"]`);
    await page.waitForTimeout(150);
    const ids = await page.$$eval('[data-discover-card]', e=>e.map(x=>+x.dataset.discoverCard));
    const expect = c==='For you' ? [1,2,3,4,5,6] : Object.entries(CARDS).filter(([k,v])=>v.includes(c)).map(([k])=>+k);
    const ok = JSON.stringify([...ids].sort()) === JSON.stringify(expect.sort());
    const overflow = await page.evaluate(()=>({docW:document.documentElement.scrollWidth,win:window.innerWidth, gridW: document.querySelector('#discoverGrid').scrollWidth, gridClient: document.querySelector('#discoverGrid').clientWidth}));
    const cols = await page.$$eval('.discover-column', e=>e.map(x=>x.children.length));
    say(`CHIP ${c}: ids=${JSON.stringify(ids)} expected=${JSON.stringify(expect)} ${ok?'OK':'*** MISMATCH ***'} cols=${JSON.stringify(cols)} overflow=${JSON.stringify(overflow)}`);
    const aria = await page.$eval(`[data-discover-category="${c}"]`, e=>e.getAttribute('aria-pressed'));
    if (aria!=='true') say(`  chip ${c} aria-pressed=${aria} *** `);
  }

  // combine chip + search
  await page.click('[data-discover-category="Travel"]');
  await page.fill('#discoverSearch','gym');
  await page.waitForTimeout(200);
  say('Travel + "gym" =>', await page.$$eval('[data-discover-card]',e=>e.length), 'empty=', await page.$$eval('.discover-empty',e=>e.length));
  await page.fill('#discoverSearch','coast');
  await page.waitForTimeout(200);
  say('Travel + "coast" =>', JSON.stringify(await page.$$eval('.discover-card-caption strong',e=>e.map(x=>x.textContent.trim()))));
  // now change chip while query present
  await page.click('[data-discover-category="Nightlife"]');
  await page.waitForTimeout(200);
  say('switch chip to Nightlife with query "coast" still in box: input=', await page.$eval('#discoverSearch',e=>e.value), 'cards=', await page.$$eval('[data-discover-card]',e=>e.length), 'empty=', await page.$$eval('.discover-empty',e=>e.length));

  // reset
  await page.fill('#discoverSearch','');
  await page.click('[data-discover-category="For you"]');
  await page.waitForTimeout(300);

  // CARD TRAY
  const scrollBefore = await page.evaluate(()=>document.querySelector('#discoverContent').scrollTop);
  await page.click('[data-discover-card="1"]');
  await page.waitForTimeout(400);
  say('tray open: actions visible=', await page.$$eval('.discover-card-actions.is-visible [data-discover-action]',e=>e.map(x=>x.dataset.discoverAction)));
  say('aria-expanded=', await page.$eval('[data-discover-card="1"]',e=>e.getAttribute('aria-expanded')));
  say('bodyOverflow=', await page.evaluate(()=>getComputedStyle(document.body).overflow), 'htmlOverflow=', await page.evaluate(()=>getComputedStyle(document.documentElement).overflow));
  say('focus after open =', await page.evaluate(()=>document.activeElement?.dataset?.discoverCard || document.activeElement?.tagName));
  // close
  await page.click('[data-discover-card="1"]');
  await page.waitForTimeout(300);
  say('tray closed: actionsVisible=', await page.$$eval('.discover-card-actions.is-visible',e=>e.length), 'scrollLocked=', await page.evaluate(()=>document.querySelector('#discoverContent').style.overflow||'none'));

  // buttons respond
  await page.click('[data-discover-card="1"]');
  await page.waitForTimeout(300);
  await page.click('[data-discover-action="Save to moodboard"][data-discover-card-id="1"]');
  await page.waitForTimeout(800);
  say('after Save to moodboard: status=', JSON.stringify(await page.$eval('#discoverStatus',e=>e.textContent)));
  await page.click('[data-discover-action="Apply this aesthetic"][data-discover-card-id="1"]');
  await page.waitForTimeout(1500);
  say('after Apply aesthetic: status=', JSON.stringify(await page.$eval('#discoverStatus',e=>e.textContent)));
  await page.click('[data-discover-action="Recreate this"][data-discover-card-id="1"]');
  await page.waitForTimeout(2000);
  say('after Recreate: overlays=', await page.evaluate(()=>document.body.innerHTML.length), 'sceneStudio present=', await page.$$eval('[class*="scene"],[id*="scene"]',e=>e.length));
  say('screen still discover=', await page.$eval('#discoverScreen',e=>e.className));
  const shot = await page.screenshot({path:'/private/tmp/claude-501/-Users-vishnusrikanth/27e14023-7753-4125-ab34-3c4d570cb2c3/scratchpad/after-recreate.png'});
} catch(e){ say('FAIL '+e.message+'\n'+e.stack); }
console.log(R.join('\n'));
console.log('--- LOGS ---'); logs.forEach(l=>console.log(l));
await browser.close();
