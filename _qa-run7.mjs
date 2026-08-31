import { boot, logs, reachHome } from './_qa-studio.mjs';
const SS='/private/tmp/claude-501/-Users-vishnusrikanth/27e14023-7753-4125-ab34-3c4d570cb2c3/scratchpad/';
const { browser, page } = await boot();
try {
  await reachHome(page);
  // seed photos into the on-device library
  const seed = await page.evaluate(async () => {
    const m = await import('./gems-photolib.js');
    const files = [];
    for (let i=0;i<14;i++){
      const c = document.createElement('canvas'); c.width=600; c.height=800;
      const g = c.getContext('2d');
      g.fillStyle = `hsl(${i*25} 60% ${40+i}%)`; g.fillRect(0,0,600,800);
      g.fillStyle='#fff'; g.font='60px sans-serif'; g.fillText('P'+i, 40, 120);
      const blob = await new Promise(r=>c.toBlob(r,'image/jpeg',0.8));
      files.push(new File([blob], `p${i}.jpg`, {type:'image/jpeg', lastModified: Date.now()-i*86400000}));
    }
    try { const res = await m.importPhotoFiles(files); return { ok:true, res: JSON.stringify(res).slice(0,200), count: await m.photoCount() }; }
    catch(e){ return { ok:false, err: e.message }; }
  });
  console.log('SEED', JSON.stringify(seed));
  await page.waitForTimeout(1500);
  await page.click('#homeScreen [data-app-tab="Studio"]');
  await page.waitForTimeout(900);
  await page.click('#studioNewProject');
  await page.waitForTimeout(700);
  console.log('dump opened', await page.evaluate(()=>document.querySelector('#studioDumpBody').textContent.replace(/\s+/g,' ').trim().slice(0,200)));
  await page.click('#studioDumpBuild');
  await page.waitForTimeout(4000);
  console.log('after build', await page.evaluate(()=>document.querySelector('#studioDumpBody').textContent.replace(/\s+/g,' ').trim().slice(0,300)));
  await page.screenshot({path:SS+'dump-options.png'});
  const opt = await page.$('[data-dump-option]');
  if (opt) { await opt.click(); await page.waitForTimeout(800); }
  const hasInput = await page.$('.studio-dump-input');
  console.log('revise input present:', !!hasInput);
  await page.screenshot({path:SS+'dump-set.png'});
} catch (e) { console.log('ERR', e.message, e.stack); }
console.log('--- LOGS ---'); console.log(logs().join('\n'));
await browser.close();
