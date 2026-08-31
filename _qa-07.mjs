import { launch, enterApp } from './_qa-lib.mjs';
const SP='/private/tmp/claude-501/-Users-vishnusrikanth/27e14023-7753-4125-ab34-3c4d570cb2c3/scratchpad/';
const R=[]; const say=(...a)=>R.push(a.join(' '));

async function overflowReport(page, label, sel) {
  const o = await page.evaluate((sel)=>{
    const win = window.innerWidth;
    const bad = [];
    document.querySelectorAll(sel+' *').forEach(el=>{
      const r = el.getBoundingClientRect();
      if (r.width===0&&r.height===0) return;
      if (r.right > win + 1 || r.left < -1) bad.push({cls:(el.className&&el.className.baseVal===undefined?String(el.className):'svg').split(' ')[0]||el.tagName, l:+r.left.toFixed(0), r:+r.right.toFixed(0), txt:(el.textContent||'').trim().slice(0,25)});
    });
    return { docW: document.documentElement.scrollWidth, win, bodyScrollW: document.body.scrollWidth, bad: bad.slice(0,14), badCount: bad.length };
  }, sel);
  say(label+': '+JSON.stringify(o));
}

for (const vp of [{width:320,height:568},{width:430,height:932}]) {
  const { browser, page, logs } = await launch(vp);
  try {
    await enterApp(page);
    await page.click('#homeScreen [data-app-tab="Discover"]'); await page.waitForTimeout(1300);
    await overflowReport(page, `DISCOVER ${vp.width}x${vp.height}`, '#discoverScreen');
    await page.screenshot({path:`${SP}d-${vp.width}.png`});
    await page.click('[data-discover-card="1"]'); await page.waitForTimeout(400);
    await overflowReport(page, `DISCOVER-TRAY ${vp.width}`, '#discoverScreen');
    await page.click('[data-discover-card="1"]'); await page.waitForTimeout(300);
    await page.click('#discoverScreen [data-app-tab="Photos"]'); await page.waitForTimeout(1300);
    await overflowReport(page, `PHOTOS ${vp.width}x${vp.height}`, '#photosScreen');
    await page.screenshot({path:`${SP}p-${vp.width}.png`});
    await page.click('#photosGrid [data-photo-id="1"]'); await page.waitForTimeout(500);
    await overflowReport(page, `PHOTOS-SHEET ${vp.width}`, '#photoSheetRoot');
    const clip = await page.evaluate(()=>{const s=document.querySelector('.photos-sheet'); const r=s.getBoundingClientRect(); return {top:+r.top.toFixed(0), bottom:+r.bottom.toFixed(0), winH:window.innerHeight, scrollH:s.scrollHeight, clientH:s.clientHeight, lastActionBottom:+[...s.querySelectorAll('[data-photo-action]')].at(-1).getBoundingClientRect().bottom.toFixed(0)};});
    say(`SHEET geometry ${vp.width}: `+JSON.stringify(clip));
    await page.screenshot({path:`${SP}p-sheet-${vp.width}.png`});
  } catch(e){ say(`FAIL ${vp.width}: `+e.message.split('\n')[0]); }
  logs.forEach(l=>say(`[${vp.width}] `+l));
  await browser.close();
}
console.log(R.join('\n'));
