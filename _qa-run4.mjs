import { boot, logs, reachHome } from './_qa-studio.mjs';
const SS='/private/tmp/claude-501/-Users-vishnusrikanth/27e14023-7753-4125-ab34-3c4d570cb2c3/scratchpad/';
const { browser, page } = await boot();
const state = () => page.evaluate(() => ({
  status: document.querySelector('#studioStatus')?.textContent,
  dumpOpen: !document.querySelector('#studioDump')?.hidden,
  dumpTitle: document.querySelector('#studioDumpTitle')?.textContent,
  dumpSub: document.querySelector('#studioDumpRequest')?.textContent,
  dumpBody: (document.querySelector('#studioDumpBody')?.textContent||'').replace(/\s+/g,' ').trim().slice(0,300),
  bodyChildren: document.body.children.length,
  bodyIds: [...document.body.children].map(e=>e.id||e.className),
}));
try {
  await reachHome(page);
  await page.click('#homeScreen [data-app-tab="Studio"]');
  await page.waitForTimeout(900);
  const names = await page.$$eval('[data-studio-template]', els=>els.map(e=>e.dataset.studioTemplate));
  console.log('templates:', names);
  for (const n of names) {
    await page.click(`[data-studio-template="${n}"]`);
    await page.waitForTimeout(1500);
    const s = await state();
    console.log('### TEMPLATE', n, JSON.stringify(s));
    await page.screenshot({path:SS+'tpl-'+n.replace(/\s+/g,'_')+'.png'});
    // close whatever opened
    await page.evaluate(()=>{
      document.querySelector('#studioDump [data-dump-close]')?.click();
      const ov=[...document.body.children].filter(e=>e.id&&e.id!=='gemsApp'&&e.id!=='gemsRevealRoot');
      ov.forEach(o=>{const c=o.querySelector('[data-close],[aria-label="Close"],.close,button');if(c)c.click();});
    });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(700);
    const after = await state();
    console.log('    after-close', JSON.stringify({dumpOpen:after.dumpOpen, bodyIds: after.bodyIds}));
    // ensure studio visible again
    const vis = await page.evaluate(()=>!!document.querySelector('#studioScreen.is-active'));
    if(!vis) console.log('    !! studio no longer active');
  }
} catch (e) { console.log('ERR', e.message, e.stack); }
console.log('--- LOGS ---'); console.log(logs().join('\n'));
await browser.close();
