import { boot, logs, reachHome } from './_qa-studio.mjs';
const { browser, page } = await boot();
const snap = () => page.evaluate(() => {
  const vis = el => !!el && !el.hidden && el.offsetParent !== null;
  const grid = document.querySelector('#studioProjectsGrid');
  const empty = document.querySelector('#studioEmpty');
  return {
    activeChip: document.querySelector('.studio-filter.is-active')?.textContent.trim(),
    ariaPressed: [...document.querySelectorAll('[data-studio-filter]')].map(b=>b.dataset.studioFilter+':'+b.getAttribute('aria-pressed')),
    projectsSectionVisible: vis(document.querySelector('#studioProjectsSection')),
    projectsTitle: document.querySelector('#studioProjectsTitle')?.textContent,
    gridVisible: vis(grid),
    gridCards: grid.querySelectorAll('[data-studio-project]').length,
    gridNames: [...grid.querySelectorAll('[data-studio-project] strong')].map(e=>e.textContent),
    emptyVisible: vis(empty),
    emptyText: empty.textContent.replace(/\s+/g,' ').trim(),
    heroVisible: vis(document.querySelector('#studioHero')),
    templatesVisible: vis(document.querySelector('#studioTemplatesSection')),
    templateCount: document.querySelectorAll('[data-studio-template]').length,
    status: document.querySelector('#studioStatus')?.textContent,
    // measure the region between projects title and templates for "blank area"
    sectionRect: (()=>{const r=document.querySelector('#studioProjectsSection').getBoundingClientRect();return {h:Math.round(r.height)};})(),
  };
});
try {
  await reachHome(page);
  await page.click('#homeScreen [data-app-tab="Studio"]');
  await page.waitForTimeout(900);
  for (const f of ['All','Dumps','Edits','Templates','Moodboards','All']) {
    await page.click(`[data-studio-filter="${f}"]`);
    await page.waitForTimeout(350);
    console.log('### FILTER', f, JSON.stringify(await snap()));
  }
} catch (e) { console.log('ERR', e.message, e.stack); }
console.log('--- LOGS ---'); console.log(logs().join('\n'));
await browser.close();
