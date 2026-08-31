import { boot, logs, reachHome } from './_qa-studio.mjs';
const SS='/private/tmp/claude-501/-Users-vishnusrikanth/27e14023-7753-4125-ab34-3c4d570cb2c3/scratchpad/';
const { browser, page } = await boot();
const pstate = () => page.evaluate(() => {
  const c = document.querySelector('#profileContent');
  return {
    name: document.querySelector('#profileName')?.textContent,
    avatar: document.querySelector('#profileAvatar')?.textContent,
    stats: [...document.querySelectorAll('.profile-stat')].map(e=>e.textContent.replace(/\s+/g,' ').trim()),
    taste: [...document.querySelectorAll('.profile-taste-row')].map(e=>e.textContent.replace(/\s+/g,' ').trim()),
    fills: [...document.querySelectorAll('.profile-taste-fill')].map(e=>{const r=e.getBoundingClientRect();return Math.round(r.width);}),
    barW: Math.round(document.querySelector('.profile-taste-bar').getBoundingClientRect().width),
    settings: [...document.querySelectorAll('[data-profile-action]')].map(e=>e.dataset.profileAction+'|'+(e.getAttribute('aria-checked')??'-')),
    sheetChildren: document.querySelector('#profileSheetRoot').children.length,
    bodyOverflow: getComputedStyle(document.body).overflow,
    htmlOverflow: getComputedStyle(document.documentElement).overflow,
    contentInert: !!c.inert, contentScrollTop: c.scrollTop,
    contentAriaHidden: c.getAttribute('aria-hidden'),
    docScrollX: window.scrollX, docScrollY: window.scrollY,
    activeEl: document.activeElement?.id || document.activeElement?.className || document.activeElement?.tagName,
    profileMountChildren: document.querySelector('#profileMount')?.children.length,
    status: document.querySelector('#profileStatus')?.textContent,
  };
});
try {
  await reachHome(page);
  await page.click('#homeScreen [data-app-tab="Profile"]');
  await page.waitForTimeout(1200);
  console.log('PROFILE base', JSON.stringify(await pstate(), null, 1));
  await page.screenshot({path:SS+'profile.png', fullPage:false});
  // scroll down to bottom to capture settings
  await page.evaluate(()=>document.querySelector('#profileContent').scrollTo(0,99999));
  await page.waitForTimeout(400);
  await page.screenshot({path:SS+'profile-bottom.png'});
  await page.evaluate(()=>document.querySelector('#profileContent').scrollTo(0,300));
  await page.waitForTimeout(200);

  for (let i=1;i<=5;i++){
    await page.click('#profilePlus');
    await page.waitForTimeout(500);
    const open = await pstate();
    const sheetInfo = await page.evaluate(()=>({
      dialogs: document.querySelectorAll('#profileSheetRoot .profile-sheet').length,
      scrims: document.querySelectorAll('#profileSheetRoot .profile-sheet-scrim').length,
      title: document.querySelector('#plusTitle')?.textContent,
      cta: document.querySelector('#profileStartTrial')?.textContent,
      note: document.querySelector('.profile-trial-note')?.textContent,
      features: document.querySelectorAll('.profile-plus-features li').length,
      rect: (()=>{const r=document.querySelector('.profile-sheet').getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)};})(),
      viewportH: window.innerHeight,
      overflowY: (()=>{const s=document.querySelector('.profile-sheet');return {sh:s.scrollHeight, ch:s.clientHeight, css:getComputedStyle(s).overflowY};})(),
    }));
    if(i===1){ await page.screenshot({path:SS+'paywall.png'}); console.log('PAYWALL OPEN', JSON.stringify(sheetInfo,null,1)); console.log('  state', JSON.stringify(open)); }
    else console.log(`open#${i}`, JSON.stringify({sheetChildren:open.sheetChildren, dialogs:sheetInfo.dialogs, active:open.activeEl, bodyOverflow:open.bodyOverflow, scrollTop:open.contentScrollTop}));
    // close: alternate scrim / close btn / Escape
    if(i%3===0){ await page.keyboard.press('Escape'); }
    else if(i%3===1){ await page.click('#profileSheetRoot .profile-sheet-close'); }
    else { await page.click('#profileSheetRoot .profile-sheet-scrim'); }
    await page.waitForTimeout(450);
    const closed = await pstate();
    console.log(`close#${i}`, JSON.stringify({sheetChildren:closed.sheetChildren, bodyOverflow:closed.bodyOverflow, htmlOverflow:closed.htmlOverflow, inert:closed.contentInert, ariaHidden:closed.contentAriaHidden, scrollTop:closed.contentScrollTop, active:closed.activeEl, docScrollY:closed.docScrollY}));
  }
} catch (e) { console.log('ERR', e.message, e.stack); }
console.log('--- LOGS ---'); console.log(logs().join('\n'));
await browser.close();
