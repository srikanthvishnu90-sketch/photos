import { launch, enterApp } from './_qa-lib.mjs';
const { browser, page, logs } = await launch();
const R=[]; const say=(...a)=>R.push(a.join(' '));
const state = async () => page.evaluate(()=>({
  sheets: document.querySelectorAll('.photos-sheet').length,
  scrims: document.querySelectorAll('.photos-sheet-scrim').length,
  rootKids: document.querySelector('#photoSheetRoot').childElementCount,
  contentInert: document.querySelector('#photosContent').inert,
  chromeInert: document.querySelector('#photosBottomChrome').inert,
  contentAria: document.querySelector('#photosContent').getAttribute('aria-hidden'),
  ae: (document.activeElement?.tagName||'')+'|'+(document.activeElement?.className||'').split(' ')[0]+'|'+(document.activeElement?.dataset?.photoId??''),
}));
const clickScrim = async ()=> page.mouse.click(195, 60);
try {
  await enterApp(page);
  await page.click('#homeScreen [data-app-tab="Photos"]');
  await page.waitForTimeout(1500);
  await page.focus('#photosGrid [data-photo-id="1"]');
  await page.click('#photosGrid [data-photo-id="1"]');
  await page.waitForTimeout(500);
  say('OPEN: '+JSON.stringify(await state()));
  const seq=[];
  for (let i=0;i<8;i++){ await page.keyboard.press('Tab'); seq.push(await page.evaluate(()=>{const a=document.activeElement; return (a?.tagName||'')+'|'+(a?.className||'').split(' ')[0]+'|'+((a?.textContent||'').trim().slice(0,18))+'|inSheet='+!!a?.closest('.photos-sheet');})); }
  say('TAB seq: '+JSON.stringify(seq,null,0));
  await page.keyboard.press('Escape'); await page.waitForTimeout(400);
  say('ESC(focus in dialog) -> '+JSON.stringify(await state()));

  // Escape after clicking non-focusable content inside sheet
  await page.click('#photosGrid [data-photo-id="1"]'); await page.waitForTimeout(400);
  await page.click('#photoSheetWhy');
  await page.waitForTimeout(150);
  say('activeElement after tapping sheet text: '+(await state()).ae);
  await page.keyboard.press('Escape'); await page.waitForTimeout(350);
  say('ESC after tapping sheet text -> sheets='+(await state()).sheets+' *** (expect 0)');
  if ((await state()).sheets>0){ await clickScrim(); await page.waitForTimeout(300); say('  scrim close worked -> sheets='+(await state()).sheets); }

  // Escape with body focus
  await page.click('#photosGrid [data-photo-id="1"]'); await page.waitForTimeout(400);
  await page.evaluate(()=>document.activeElement.blur());
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  say('ESC with body focus -> sheets='+(await state()).sheets);
  if ((await state()).sheets>0){ await clickScrim(); await page.waitForTimeout(300); }

  // Shift-Tab wrap from first
  await page.click('#photosGrid [data-photo-id="2"]'); await page.waitForTimeout(400);
  await page.keyboard.press('Shift+Tab');
  say('Shift+Tab from first -> '+(await page.evaluate(()=>(document.activeElement?.textContent||'').trim().slice(0,20)+'|inSheet='+!!document.activeElement?.closest('.photos-sheet'))));

  // background inert
  let bg='blocked';
  try { await page.click('#photosGrid [data-photo-id="5"]',{timeout:1200}); bg='CLICK WENT THROUGH'; } catch { }
  say('bg tile click while open: '+bg);
  let tabclick='blocked';
  try { await page.click('#photosBottomChrome [data-app-tab="Home"]',{timeout:1200}); tabclick='CLICK WENT THROUGH'; } catch {}
  say('bg tabbar click while open: '+tabclick);
  const sc = await page.evaluate(()=>{const c=document.querySelector('#photosContent'); const b=c.scrollTop; c.scrollTop=b+300; const a=c.scrollTop; c.scrollTop=b; return {before:b,after:a};});
  say('bg scrollability while open: '+JSON.stringify(sc));
  await clickScrim(); await page.waitForTimeout(400);
  say('AFTER SCRIM CLOSE: '+JSON.stringify(await state()));

  // 5 cycles
  for (let i=0;i<5;i++){ await page.click('#photosGrid [data-photo-id="3"]'); await page.waitForTimeout(220); await page.keyboard.press('Escape'); await page.waitForTimeout(220); }
  say('AFTER 5 CYCLES: '+JSON.stringify(await state()));
  await page.click('#photosGrid [data-photo-id="3"]'); await page.waitForTimeout(300);
  say('actions in sheet = '+await page.$$eval('[data-photo-action]',e=>e.length)+' (expect 5)');

  // Pin to board double check
  await page.click('[data-photo-action="Pin to board"]'); await page.waitForTimeout(1200);
  say('Pin to board -> label now: '+JSON.stringify(await page.$eval('[data-photo-action="Pin to board"] span',e=>e.textContent)));
  // navigate to editor
  await page.click('[data-photo-action="Describe an edit"]'); await page.waitForTimeout(3000);
  say('after Describe an edit: active='+await page.evaluate(()=>[...document.querySelectorAll('.screen.is-active')].map(e=>e.id).join(',')));
  say('post-nav state: '+JSON.stringify(await state()));
} catch(e){ say('FAIL '+e.message.split('\n')[0]); }
console.log(R.join('\n'));
console.log('--- LOGS ---'); logs.forEach(l=>console.log(l));
await browser.close();
