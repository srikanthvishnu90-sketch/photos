import { launch, enterApp } from './_qa-lib.mjs';
const { browser, page, logs } = await launch();
const R=[]; const say=(...a)=>R.push(a.join(' '));
const SP='/private/tmp/claude-501/-Users-vishnusrikanth/27e14023-7753-4125-ab34-3c4d570cb2c3/scratchpad/';
try {
  await enterApp(page);
  // ---- Discover tray 5 cycles + node/listener duplication
  await page.click('#homeScreen [data-app-tab="Discover"]'); await page.waitForTimeout(1300);
  say('discoverGrid aria-live='+await page.$eval('#discoverGrid',e=>e.getAttribute('aria-live')));
  for (let i=0;i<5;i++){ await page.click('[data-discover-card="1"]'); await page.waitForTimeout(200); await page.click('[data-discover-card="1"]'); await page.waitForTimeout(200); }
  say('after 5 tray cycles: cards='+await page.$$eval('[data-discover-card]',e=>e.length)+' actionBlocks='+await page.$$eval('.discover-card-actions',e=>e.length)+' visible='+await page.$$eval('.discover-card-actions.is-visible',e=>e.length));
  // count taste events fired per action click (listener doubling proxy)
  await page.click('[data-discover-card="2"]'); await page.waitForTimeout(300);
  await page.evaluate(()=>{window.__c=0; const o=console.info; console.info=(...a)=>{window.__c++;o(...a);};});
  // two cards open at once?
  await page.click('[data-discover-card="4"]'); await page.waitForTimeout(300);
  say('two cards tapped -> open trays='+await page.$$eval('.discover-card-actions.is-visible',e=>e.length)+' expanded='+await page.$$eval('[data-discover-card][aria-expanded="true"]',e=>e.length));

  // ---- Recreate overlay + scroll lock after close
  await page.click('[data-discover-action="Recreate this"][data-discover-card-id="4"]');
  await page.waitForTimeout(2500);
  const ov = await page.evaluate(()=>{
    const roots=[...document.body.children].map(e=>e.id||e.tagName+'.'+(e.className||'').split(' ')[0]);
    return {roots, bodyOverflow:getComputedStyle(document.body).overflow, discoverInert: document.querySelector('#discoverScreen')?.inert, discoverContentScroll: document.querySelector('#discoverContent').scrollTop};
  });
  say('recreate overlay open: '+JSON.stringify(ov));
  await page.screenshot({path:SP+'d-recreate.png'});
  // find close button
  const closed = await page.evaluate(()=>{
    const btn=[...document.querySelectorAll('button')].find(b=>/close/i.test(b.getAttribute('aria-label')||'') && b.offsetParent!==null);
    if(btn){btn.click(); return btn.outerHTML.slice(0,80);} return 'NO CLOSE BUTTON FOUND';
  });
  await page.waitForTimeout(1000);
  say('closed via: '+closed);
  const after = await page.evaluate(()=>{
    const c=document.querySelector('#discoverContent');
    const b=c.scrollTop; c.scrollTop=b+200; const a=c.scrollTop; c.scrollTop=b;
    return {canScroll:a!==b, bodyOverflow:getComputedStyle(document.body).overflow, discoverInert:document.querySelector('#discoverScreen')?.inert, sceneOverlays: document.querySelectorAll('.scene-sheet,.scene-studio,[class*="scene-"]').length};
  });
  say('after closing recreate: '+JSON.stringify(after));
  let cardClick='ok';
  try{ await page.click('[data-discover-card="1"]',{timeout:2000}); }catch(e){ cardClick='BLOCKED: '+e.message.split('\n')[0]; }
  say('discover card clickable after closing overlay: '+cardClick);

  // ---- Photos: real wheel scroll behind open sheet
  await page.click('#discoverScreen [data-app-tab="Photos"]'); await page.waitForTimeout(1400);
  await page.evaluate(()=>document.querySelector('#photosContent').scrollTo(0,120));
  await page.waitForTimeout(200);
  await page.click('#photosGrid [data-photo-id="1"]'); await page.waitForTimeout(500);
  const b4 = await page.evaluate(()=>document.querySelector('#photosContent').scrollTop);
  await page.mouse.move(195, 40);
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(500);
  const aft = await page.evaluate(()=>document.querySelector('#photosContent').scrollTop);
  say(`wheel over scrim while sheet open: before=${b4} after=${aft} ${aft!==b4?'*** BACKGROUND SCROLLED ***':'locked'}`);
  // wheel over the sheet itself (past its own scroll end)
  await page.mouse.move(195, 700);
  await page.mouse.wheel(0, 2000);
  await page.waitForTimeout(500);
  const aft2 = await page.evaluate(()=>({bg:document.querySelector('#photosContent').scrollTop, sheet:document.querySelector('.photos-sheet')?.scrollTop}));
  say('wheel over sheet: '+JSON.stringify(aft2));
  // touch drag on scrim
  await page.touchscreen.tap(195, 40).catch(()=>{});
  await page.waitForTimeout(400);
  say('tap on scrim closes? sheets='+await page.$$eval('.photos-sheet',e=>e.length));
} catch(e){ say('FAIL '+e.message.split('\n')[0]); }
console.log(R.join('\n'));
console.log('--- LOGS ---'); logs.forEach(l=>console.log(l));
await browser.close();
