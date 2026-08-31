import { launch, enterApp } from './_qa-lib.mjs';
const { browser, page, logs } = await launch();
const R=[]; const say=(...a)=>{R.push(a.join(' '));};
try {
  await enterApp(page);
  await page.click('#homeScreen [data-app-tab="Discover"]');
  await page.waitForTimeout(1200);

  const S = '#discoverSearch';
  const box = async () => { const b = await page.$eval(S, e => { const r=e.getBoundingClientRect(); return {x:+r.x.toFixed(1),y:+r.y.toFixed(1),w:+r.width.toFixed(1),h:+r.height.toFixed(1)}; }); return b; };
  say('REST box', JSON.stringify(await box()));
  await page.focus(S);
  await page.waitForTimeout(400);
  say('FOCUSED box', JSON.stringify(await box()));

  // fast typing, sample box + focus + caret each keystroke
  const word = 'travel';
  const samples=[];
  for (const ch of word) {
    await page.keyboard.type(ch, { delay: 8 });
    samples.push(await page.evaluate(() => {
      const e = document.querySelector('#discoverSearch');
      const r = e.getBoundingClientRect();
      return { y:+r.y.toFixed(1), focused: document.activeElement === e, ae: document.activeElement?.id||document.activeElement?.className, sel: e.selectionStart, val: e.value, n: document.querySelectorAll('[data-discover-card]').length };
    }));
  }
  say('TYPE-FAST samples:', JSON.stringify(samples));

  // clear
  await page.fill(S, '');
  await page.waitForTimeout(200);
  say('after clear cards=', await page.$$eval('[data-discover-card]', e=>e.length));

  // 200-char string
  const long = 'a'.repeat(200);
  await page.focus(S);
  await page.evaluate(()=>document.querySelector('#discoverSearch').select());
  const t0 = Date.now();
  await page.keyboard.type(long, { delay: 0 });
  const dur = Date.now()-t0;
  const st = await page.evaluate(()=>{const e=document.querySelector('#discoverSearch');const r=e.getBoundingClientRect();return {len:e.value.length,focused:document.activeElement===e,y:+r.y.toFixed(1),sel:e.selectionStart, overflowX: document.documentElement.scrollWidth > window.innerWidth, docW: document.documentElement.scrollWidth, winW: window.innerWidth};});
  say('200CHAR', dur+'ms', JSON.stringify(st));
  say('empty state present:', await page.$$eval('.discover-empty', e=>e.length), (await page.$('.discover-empty'))? await page.$eval('.discover-empty', e=>e.innerText.replace(/\n/g,' | ')) : '');

  // paste
  await page.evaluate(()=>{const e=document.querySelector('#discoverSearch'); e.value=''; e.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.focus(S);
  await page.evaluate(async ()=>{ /* simulate paste */ });
  await page.evaluate(()=>{
    const e = document.querySelector('#discoverSearch');
    const dt = new DataTransfer(); dt.setData('text/plain','Nightlife');
    e.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
  });
  await page.waitForTimeout(200);
  say('paste-event value=', await page.$eval(S,e=>e.value), 'cards=', await page.$$eval('[data-discover-card]',e=>e.length));

  // select-all-replace
  await page.fill(S, 'gym');
  await page.waitForTimeout(200);
  say('gym cards=', await page.$$eval('[data-discover-card]',e=>e.length), await page.$$eval('.discover-card-caption strong', e=>e.map(x=>x.textContent.trim())));
  await page.focus(S);
  await page.keyboard.press('Control+a');
  await page.keyboard.type('beach', {delay:5});
  await page.waitForTimeout(250);
  say('select-all-replace ->', await page.$eval(S,e=>e.value), 'cards=', await page.$$eval('[data-discover-card]',e=>e.length));

  // emoji
  await page.fill(S,'');
  await page.focus(S);
  await page.evaluate(()=>{const e=document.querySelector('#discoverSearch'); e.value='🌴☀️🎉'; e.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.waitForTimeout(200);
  say('emoji cards=', await page.$$eval('[data-discover-card]',e=>e.length), 'empty=', await page.$$eval('.discover-empty',e=>e.length));

  // special chars
  for (const s of ['%%%','\\\\','[](){}','*.+?^$|','..*','a"b\'c','&<>']) {
    await page.evaluate((v)=>{const e=document.querySelector('#discoverSearch'); e.value=v; e.dispatchEvent(new Event('input',{bubbles:true}));}, s);
    await page.waitForTimeout(80);
    say('special', JSON.stringify(s), '->cards', await page.$$eval('[data-discover-card]',e=>e.length));
  }

  // XSS
  await page.evaluate(()=>{ window.__xss=0; window.alert = ()=>{window.__xss++;}; });
  const payload = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  await page.evaluate((v)=>{const e=document.querySelector('#discoverSearch'); e.value=v; e.dispatchEvent(new Event('input',{bubbles:true}));}, payload);
  await page.waitForTimeout(600);
  say('XSS: injected imgs in grid=', await page.$$eval('#discoverGrid img, #discoverGrid script', e=>e.length), 'alerts=', await page.evaluate(()=>window.__xss), 'gridHTML=', (await page.$eval('#discoverGrid', e=>e.innerHTML)).slice(0,200).replace(/\s+/g,' '));
  say('doc has stray img=', await page.$$eval('img[src="x"]', e=>e.length));

  // debounce check: count renders per keystroke via MutationObserver
  await page.fill(S,'');
  await page.evaluate(()=>{ window.__m=0; const o=new MutationObserver(()=>{window.__m++;}); o.observe(document.querySelector('#discoverGrid'),{childList:true,subtree:true}); window.__obs=o; });
  await page.focus(S);
  await page.keyboard.type('travelling', { delay: 10 });
  await page.waitForTimeout(500);
  say('mutations for 10 keystrokes =', await page.evaluate(()=>window.__m));

} catch (e) { say('FAIL '+e.message+'\n'+e.stack); }
console.log(R.join('\n'));
console.log('--- LOGS ---'); logs.forEach(l=>console.log(l));
await browser.close();
