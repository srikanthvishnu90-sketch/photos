import { boot, logs, reachHome } from './_qa-studio.mjs';
const SS='/private/tmp/claude-501/-Users-vishnusrikanth/27e14023-7753-4125-ab34-3c4d570cb2c3/scratchpad/';
const { browser, page } = await boot();
try {
  await reachHome(page);
  await page.click('#homeScreen [data-app-tab="Profile"]'); await page.waitForTimeout(900);
  // privacy sheet
  await page.evaluate(()=>document.querySelector('#profileContent').scrollTo(0,99999));
  await page.waitForTimeout(300);
  await page.click('[data-profile-action="privacy"]'); await page.waitForTimeout(700);
  console.log('privacy open', JSON.stringify(await page.evaluate(()=>{const s=document.querySelector('.profile-sheet');const r=s.getBoundingClientRect();return {
    dialogs: document.querySelectorAll('#profileSheetRoot .profile-sheet').length,
    title: document.querySelector('#privacyTitle')?.textContent,
    active: document.activeElement?.className,
    y:Math.round(r.y), h:Math.round(r.height), sh:s.scrollHeight, ch:s.clientHeight, vh:window.innerHeight,
    overflowY:getComputedStyle(s).overflowY};})));
  await page.screenshot({path:SS+'privacy.png'});
  await page.click('[data-training-toggle]'); await page.waitForTimeout(600);
  console.log('privacy toggle aria=', await page.evaluate(()=>document.querySelector('[data-training-toggle]').getAttribute('aria-checked')), '| status:', await page.evaluate(()=>document.querySelector('#profileStatus').textContent));
  await page.click('[data-privacy-download]'); await page.waitForTimeout(1500);
  console.log('download status:', await page.evaluate(()=>document.querySelector('#profileStatus').textContent));
  await page.click('[data-privacy-delete]'); await page.waitForTimeout(500);
  console.log('confirm pane', JSON.stringify(await page.evaluate(()=>({main:document.querySelector('[data-privacy-main]').hidden, conf:document.querySelector('[data-privacy-confirm]').hidden, active:document.activeElement?.textContent?.trim()}))));
  await page.screenshot({path:SS+'privacy-confirm.png'});
  await page.click('[data-privacy-cancel]'); await page.waitForTimeout(500);
  await page.keyboard.press('Escape'); await page.waitForTimeout(600);
  console.log('after esc privacy', JSON.stringify(await page.evaluate(()=>({sheet:document.querySelector('#profileSheetRoot').children.length, inert:!!document.querySelector('#profileContent').inert, active:document.activeElement?.textContent?.replace(/\s+/g,' ').trim().slice(0,40)}))));
  // share
  await page.evaluate(()=>document.querySelector('#profileContent').scrollTo(0,0)); await page.waitForTimeout(300);
  await page.click('#profileShare'); await page.waitForTimeout(3000);
  console.log('share status:', await page.evaluate(()=>document.querySelector('#profileStatus').textContent));
  console.log('share overlays:', JSON.stringify(await page.evaluate(()=>[...document.body.children].map(e=>e.id||e.className))));
  await page.screenshot({path:SS+'share.png'});
  // stats/identity check
  console.log('identity', JSON.stringify(await page.evaluate(()=>({name:document.querySelector('#profileName').textContent, plan:document.querySelector('.profile-identity-copy p').textContent}))));
} catch (e) { console.log('ERR', e.message, e.stack?.split('\n')[0]); }
console.log('--- LOGS ---'); console.log([...new Set(logs())].join('\n'));
await browser.close();
