import { boot, logs, reachHome } from './_qa-studio.mjs';
const SS='/private/tmp/claude-501/-Users-vishnusrikanth/27e14023-7753-4125-ab34-3c4d570cb2c3/scratchpad/';
const { browser, page } = await boot();
const t = () => page.evaluate(() => {
  const b = document.querySelector('[data-profile-action="training"]');
  return { aria: b.getAttribute('aria-checked'), cls: b.className.includes('is-on'),
    sub: b.querySelector('[data-setting-sublabel]')?.textContent,
    thumbX: Math.round(b.querySelector('.profile-toggle-thumb').getBoundingClientRect().x),
    status: document.querySelector('#profileStatus').textContent,
    ls: Object.keys(localStorage).length };
});
try {
  await reachHome(page);
  const lsAfterOnboard = await page.evaluate(()=>Object.fromEntries(Object.entries(localStorage)));
  console.log('localStorage after onboarding keys:', Object.keys(lsAfterOnboard));
  await page.click('#homeScreen [data-app-tab="Profile"]');
  await page.waitForTimeout(1200);
  await page.evaluate(()=>document.querySelector('#profileContent').scrollTo(0,99999));
  await page.waitForTimeout(300);
  console.log('training before', JSON.stringify(await t()));
  await page.click('[data-profile-action="training"]');
  await page.waitForTimeout(700);
  console.log('training after tap', JSON.stringify(await t()));
  await page.click('[data-profile-action="training"]');
  await page.waitForTimeout(700);
  console.log('training after tap2', JSON.stringify(await t()));

  // non-toggle rows
  for (const a of ['camera','help']) {
    await page.evaluate(()=>document.querySelector('#profileStatus').textContent='');
    const before = await page.evaluate(()=>({html:document.body.children.length, url:location.href}));
    await page.click(`[data-profile-action="${a}"]`);
    await page.waitForTimeout(900);
    const after = await page.evaluate(()=>({html:document.body.children.length, url:location.href, status:document.querySelector('#profileStatus').textContent, overlays:[...document.body.children].map(e=>e.id||e.className)}));
    console.log('ROW', a, 'before', JSON.stringify(before), 'after', JSON.stringify(after));
  }
  // people
  await page.click('[data-profile-action="people"]'); await page.waitForTimeout(1600);
  console.log('people ->', JSON.stringify(await page.evaluate(()=>({overlays:[...document.body.children].map(e=>e.id||e.className), text:(document.body.innerText||'').slice(-400)}))));
  await page.screenshot({path:SS+'people.png'});
  await page.keyboard.press('Escape'); await page.waitForTimeout(600);
  await page.evaluate(()=>{[...document.body.children].forEach(e=>{if(e.id!=='gemsApp'&&e.id!=='gemsRevealRoot'&&e.className&&/overlay|sheet|modal/i.test(e.className)) e.querySelector('button')?.click();});});
  await page.waitForTimeout(600);
  console.log('after people close', JSON.stringify(await page.evaluate(()=>[...document.body.children].map(e=>e.id||e.className))));
  // memories
  await page.click('[data-profile-action="memories"]'); await page.waitForTimeout(1600);
  console.log('memories ->', JSON.stringify(await page.evaluate(()=>({overlays:[...document.body.children].map(e=>e.id||e.className)}))));
  await page.screenshot({path:SS+'memories.png'});
} catch (e) { console.log('ERR', e.message, e.stack); }
console.log('--- LOGS ---'); console.log(logs().join('\n'));
await browser.close();
