import { boot, logs, reachHome } from './_qa-studio.mjs';
const SS='/private/tmp/claude-501/-Users-vishnusrikanth/27e14023-7753-4125-ab34-3c4d570cb2c3/scratchpad/';
const { browser, page } = await boot();
const dom = () => page.evaluate(()=>({
  studioMount: document.querySelector('#studioMount').children.length,
  profileMount: document.querySelector('#profileMount').children.length,
  studioFilters: document.querySelectorAll('[data-studio-filter]').length,
  studioTemplates: document.querySelectorAll('[data-studio-template]').length,
  studioProjects: document.querySelectorAll('[data-studio-project]').length,
  profileSettings: document.querySelectorAll('[data-profile-action]').length,
  tasteRows: document.querySelectorAll('.profile-taste-row').length,
  tabButtons: document.querySelectorAll('[data-app-tab]').length,
  sheetRoot: document.querySelector('#profileSheetRoot').children.length,
  stats: document.querySelectorAll('.profile-stat').length,
  bodyKids: document.body.children.length,
}));
try {
  await reachHome(page);
  console.log('base dom', JSON.stringify(await dom()));
  for (let i=1;i<=3;i++){
    await page.click('#homeScreen [data-app-tab="Studio"]'); await page.waitForTimeout(700);
    await page.click('#studioScreen [data-app-tab="Profile"]'); await page.waitForTimeout(700);
    await page.click('#profileScreen [data-app-tab="Home"]'); await page.waitForTimeout(700);
    console.log('cycle',i, JSON.stringify(await dom()));
  }
  // paywall open then tab away
  await page.click('#homeScreen [data-app-tab="Profile"]'); await page.waitForTimeout(700);
  await page.click('#profilePlus'); await page.waitForTimeout(400);
  await page.click('#profileScreen [data-app-tab="Studio"]'); await page.waitForTimeout(800);
  console.log('paywall->tab away', JSON.stringify(await page.evaluate(()=>({
    sheetRoot: document.querySelector('#profileSheetRoot').children.length,
    contentInert: !!document.querySelector('#profileContent').inert,
    ariaHidden: document.querySelector('#profileContent').getAttribute('aria-hidden'),
    studioActive: !!document.querySelector('#studioScreen.is-active')}))));
  await page.click('#studioScreen [data-app-tab="Profile"]'); await page.waitForTimeout(800);

  // privacy sheet
  await page.evaluate(()=>document.querySelector('#profileContent').scrollTo(0,99999));
  await page.click('[data-profile-action="privacy"]'); await page.waitForTimeout(600);
  console.log('privacy open', JSON.stringify(await page.evaluate(()=>({
    dialogs: document.querySelectorAll('#profileSheetRoot .profile-sheet').length,
    title: document.querySelector('#privacyTitle')?.textContent,
    active: document.activeElement?.className,
    h: Math.round(document.querySelector('.profile-sheet').getBoundingClientRect().height),
    sh: document.querySelector('.profile-sheet').scrollHeight,
    vh: window.innerHeight}))));
  await page.screenshot({path:SS+'privacy.png'});
  // toggle inside sheet
  await page.click('[data-training-toggle]'); await page.waitForTimeout(600);
  console.log('privacy toggle', await page.evaluate(()=>document.querySelector('[data-training-toggle]').getAttribute('aria-checked')), '| status:', await page.evaluate(()=>document.querySelector('#profileStatus').textContent));
  // download my data
  await page.click('[data-privacy-download]'); await page.waitForTimeout(1200);
  console.log('download status:', await page.evaluate(()=>document.querySelector('#profileStatus').textContent));
  // delete confirm pane
  await page.click('[data-privacy-delete]'); await page.waitForTimeout(500);
  console.log('confirm pane', JSON.stringify(await page.evaluate(()=>({main:document.querySelector('[data-privacy-main]').hidden, conf:document.querySelector('[data-privacy-confirm]').hidden, active:document.activeElement?.textContent?.trim()}))));
  await page.click('[data-privacy-cancel]'); await page.waitForTimeout(400);
  await page.keyboard.press('Escape'); await page.waitForTimeout(500);
  console.log('after esc privacy', JSON.stringify(await page.evaluate(()=>({sheet:document.querySelector('#profileSheetRoot').children.length, inert:!!document.querySelector('#profileContent').inert, active:document.activeElement?.textContent?.replace(/\s+/g,' ').trim().slice(0,40)}))));
  // share
  await page.evaluate(()=>document.querySelector('#profileContent').scrollTo(0,0));
  await page.click('#profileShare'); await page.waitForTimeout(2500);
  console.log('share status:', await page.evaluate(()=>document.querySelector('#profileStatus').textContent));
  console.log('share overlays:', JSON.stringify(await page.evaluate(()=>[...document.body.children].map(e=>e.id||e.className))));
  await page.screenshot({path:SS+'share.png'});
  console.log('final dom', JSON.stringify(await dom()));
} catch (e) { console.log('ERR', e.message, e.stack?.split('\n')[0]); }
console.log('--- LOGS ---'); console.log([...new Set(logs())].join('\n'));
await browser.close();
