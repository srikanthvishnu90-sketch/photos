import { launch, enterApp } from './_qa-lib.mjs';
const { browser, page, logs } = await launch();
const R=[]; const say=(...a)=>R.push(a.join(' '));
const SP='/private/tmp/claude-501/-Users-vishnusrikanth/27e14023-7753-4125-ab34-3c4d570cb2c3/scratchpad/';
const COLL={'Hidden gems':[1,4,6],'Best of August':[1,2,3,4,5,6,7,8,9],'Never posted':[1,5,8],'With friends':[2,3,7],'Dating picks':[1,5,6],'Worth editing':[3,4,8]};
try {
  await enterApp(page);
  await page.click('#homeScreen [data-app-tab="Photos"]');
  await page.waitForTimeout(1500);
  say('photos tiles=', await page.$$eval('#photosGrid [data-photo-id]',e=>e.length));
  say('gem badges=', await page.$$eval('.photos-gem-badge',e=>e.length), 'aria=', await page.$$eval('.photos-gem-badge',e=>e.map(x=>x.getAttribute('aria-label'))));
  say('collections=', await page.$$eval('[data-photo-collection]',e=>e.map(x=>x.dataset.photoCollection)));
  say('collection counts shown=', await page.$$eval('.photos-collection-overlay small',e=>e.map(x=>x.textContent.trim())));
  await page.screenshot({path:SP+'p-init.png', fullPage:false});

  for (const [name, ids] of Object.entries(COLL)) {
    await page.click(`[data-photo-collection="${name}"]`);
    await page.waitForTimeout(200);
    const got = await page.$$eval('#photosGrid [data-photo-id]',e=>e.map(x=>+x.dataset.photoId));
    const ok = JSON.stringify(got)===JSON.stringify(ids);
    say(`COLL ${name}: got=${JSON.stringify(got)} expected=${JSON.stringify(ids)} ${ok?'OK':'*** MISMATCH ***'} title=${await page.$eval('#photosLibraryTitle',e=>e.textContent)}`);
    await page.click(`[data-photo-collection="${name}"]`); // toggle off
    await page.waitForTimeout(150);
  }
  say('after toggling all off tiles=', await page.$$eval('#photosGrid [data-photo-id]',e=>e.length));

  // NL search hints
  for (const h of await page.$$eval('[data-photo-hint]',e=>e.map(x=>x.dataset.photoHint))) {
    await page.click(`[data-photo-hint="${h}"]`);
    await page.waitForTimeout(250);
    say(`HINT "${h}" -> value=${JSON.stringify(await page.$eval('#photosSearch',e=>e.value))} tiles=${await page.$$eval('#photosGrid [data-photo-id]',e=>e.map(x=>+x.dataset.photoId))} title=${await page.$eval('#photosLibraryTitle',e=>e.textContent)} hasValueClass=${await page.$eval('.photos-search',e=>e.classList.contains('has-value'))}`);
  }

  // search typing
  const S='#photosSearch';
  await page.fill(S,'');
  await page.waitForTimeout(200);
  say('cleared -> tiles=', await page.$$eval('#photosGrid [data-photo-id]',e=>e.length), 'title=', await page.$eval('#photosLibraryTitle',e=>e.textContent));
  await page.focus(S);
  const boxes=[];
  boxes.push(['rest', await page.$eval(S,e=>+e.getBoundingClientRect().y.toFixed(1))]);
  for (const ch of 'summer') {
    await page.keyboard.type(ch,{delay:8});
    boxes.push([ch, await page.evaluate(()=>{const e=document.querySelector('#photosSearch');return [+e.getBoundingClientRect().y.toFixed(1), document.activeElement===e, e.selectionStart, document.querySelectorAll('#photosGrid [data-photo-id]').length];})]);
  }
  say('PHOTOS typing:', JSON.stringify(boxes));

  // 200 chars
  await page.fill(S,'');
  await page.focus(S);
  const t0=Date.now(); await page.keyboard.type('b'.repeat(200),{delay:0}); const dur=Date.now()-t0;
  say('200char', dur+'ms', JSON.stringify(await page.evaluate(()=>{const e=document.querySelector('#photosSearch');return {len:e.value.length,focused:document.activeElement===e,y:+e.getBoundingClientRect().y.toFixed(1),docW:document.documentElement.scrollWidth,win:window.innerWidth};})));
  say('empty state hidden=', await page.$eval('#photosEmpty',e=>e.hidden), 'text=', JSON.stringify(await page.$eval('#photosEmpty',e=>e.innerText.replace(/\n/g,' | '))));

  // one char
  await page.fill(S,'z'); await page.waitForTimeout(200);
  say('single char "z" tiles=', await page.$$eval('#photosGrid [data-photo-id]',e=>e.length), '(expect 0 matches? terms filtered len>1)');
  await page.fill(S,'zzzz'); await page.waitForTimeout(200);
  say('"zzzz" tiles=', await page.$$eval('#photosGrid [data-photo-id]',e=>e.length), 'empty hidden=', await page.$eval('#photosEmpty',e=>e.hidden));

  // emoji + specials
  for (const s of ['🌴☀️','%%%','a"b\'c','&<>','*.+?^$|','[](){}']) {
    await page.evaluate(v=>{const e=document.querySelector('#photosSearch');e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}));},s);
    await page.waitForTimeout(80);
    say('PSPECIAL', JSON.stringify(s), 'tiles=', await page.$$eval('#photosGrid [data-photo-id]',e=>e.length));
  }

  // XSS
  await page.evaluate(()=>{window.__x=0;window.alert=()=>window.__x++;});
  await page.evaluate(()=>{const e=document.querySelector('#photosSearch');e.value='<img src=x onerror=alert(1)>';e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('search',{bubbles:true}));});
  await page.waitForTimeout(600);
  say('PXSS imgs=', await page.$$eval('img[src="x"]',e=>e.length),'alerts=',await page.evaluate(()=>window.__x), 'gridHTML=', (await page.$eval('#photosGrid',e=>e.innerHTML)).slice(0,120).replace(/\s+/g,' '));
  say('libraryTitle=', JSON.stringify(await page.$eval('#photosLibraryTitle',e=>e.textContent)), 'status=', JSON.stringify(await page.$eval('#photosStatus',e=>e.textContent)));

  // debounce
  await page.fill(S,'');
  await page.evaluate(()=>{window.__m=0;new MutationObserver(()=>window.__m++).observe(document.querySelector('#photosGrid'),{childList:true,subtree:true});});
  await page.focus(S); await page.keyboard.type('summertime',{delay:10});
  await page.waitForTimeout(400);
  say('photos grid mutations for 10 keystrokes=', await page.evaluate(()=>window.__m));
} catch(e){ say('FAIL '+e.message+'\n'+e.stack); }
console.log(R.join('\n'));
console.log('--- LOGS ---'); logs.forEach(l=>console.log(l));
await browser.close();
