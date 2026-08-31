import { boot, logs, reachHome } from './_qa-studio.mjs';
const { browser, page } = await boot();
const SS='/private/tmp/claude-501/-Users-vishnusrikanth/27e14023-7753-4125-ab34-3c4d570cb2c3/scratchpad/';
const state = () => page.evaluate(() => ({
  status: document.querySelector('#studioStatus')?.textContent,
  dumpOpen: !document.querySelector('#studioDump')?.hidden,
  dumpTitle: document.querySelector('#studioDumpTitle')?.textContent,
  dumpBody: (document.querySelector('#studioDumpBody')?.textContent||'').replace(/\s+/g,' ').trim().slice(0,220),
  overlays: [...document.querySelectorAll('body > *')].filter(e=>e.id&&!['gemsApp'].includes(e.id)).map(e=>e.id),
  bodyChildren: document.body.children.length,
  bodyOverflow: getComputedStyle(document.body).overflow,
}));
try {
  await reachHome(page);
  await page.click('#homeScreen [data-app-tab="Studio"]');
  await page.waitForTimeout(900);
  console.log('base', JSON.stringify(await state()));

  // hero continue draft
  await page.click('#studioContinueDraft'); await page.waitForTimeout(500);
  console.log('HERO ->', JSON.stringify(await state()));

  // board entry
  await page.click('#studioBoardEntry'); await page.waitForTimeout(900);
  console.log('BOARD ->', JSON.stringify(await state()));
  await page.screenshot({path:SS+'board.png'});
  // try close board
  const closed = await page.evaluate(()=>{ const b=document.querySelector('[data-board-close], .gems-board-close, .board-close'); if(b){b.click();return 'clicked';} return 'no-close-found';});
  console.log('board close:', closed); await page.waitForTimeout(600);
  console.log('after board close', JSON.stringify(await state()));
  await page.keyboard.press('Escape'); await page.waitForTimeout(500);
  console.log('after esc', JSON.stringify(await state()));
  await page.screenshot({path:SS+'board2.png'});
} catch (e) { console.log('ERR', e.message); }
console.log('--- LOGS ---'); console.log(logs().join('\n'));
await browser.close();
