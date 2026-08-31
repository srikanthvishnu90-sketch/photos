import { boot, logs, reachHome } from './_qa-studio.mjs';
const { browser, page } = await boot();
try {
  await reachHome(page);
  console.log('reached home OK');
  // go to studio
  await page.click('#homeScreen [data-app-tab="Studio"]');
  await page.waitForTimeout(900);
  const info = await page.evaluate(() => {
    const s = document.querySelector('#studioScreen');
    return { active: s?.classList.contains('is-active'), title: document.querySelector('#studioTitle')?.textContent,
      projects: [...document.querySelectorAll('[data-studio-project]')].map(b=>b.textContent.replace(/\s+/g,' ').trim()),
      status: document.querySelector('#studioStatus')?.textContent };
  });
  console.log(JSON.stringify(info, null, 2));
  await page.screenshot({ path: '/private/tmp/claude-501/-Users-vishnusrikanth/27e14023-7753-4125-ab34-3c4d570cb2c3/scratchpad/studio.png' });
} catch (e) { console.log('ERR', e.message); await page.screenshot({ path: '/private/tmp/claude-501/-Users-vishnusrikanth/27e14023-7753-4125-ab34-3c4d570cb2c3/scratchpad/fail.png' }); }
console.log('--- LOGS ---'); console.log(logs().join('\n'));
await browser.close();
