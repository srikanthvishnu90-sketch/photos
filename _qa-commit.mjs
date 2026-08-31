import { boot, onboard, seedPhoto, openEditor } from './_qa-editor.mjs';

const log = (...a) => console.log(...a);

async function versionCount(page) { return await page.$$eval('[data-editor-version]', (n) => n.length); }
async function lastVersionDims(page) {
  return await page.evaluate(async () => { const im = document.querySelector('#editorPhotoView'); await im.decode().catch(() => {}); return im.naturalWidth + 'x' + im.naturalHeight; });
}
async function dragOnPhoto(page, frac = 0.5) {
  const box = await page.$eval('#editorPhotoView', (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const x0 = box.x + box.w * 0.3, y0 = box.y + box.h * frac;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) { await page.mouse.move(x0 + i * (box.w * 0.05), y0 + i * 2); await page.waitForTimeout(20); }
  await page.mouse.up();
  await page.waitForTimeout(400);
}
async function clickApply(page, re = /apply/i) {
  const btns = await page.$$('#editorToolPanel button');
  for (const b of btns) { const t = (await b.textContent()).trim(); if (re.test(t)) { await b.click(); return 'clicked:' + t; } }
  return 'NO APPLY BUTTON';
}

const { browser, page, errors } = await boot();
await onboard(page);
const seed = await seedPhoto(page, { w: 3000, h: 2000 });
await openEditor(page, seed.id, 'manual');
log('source', seed.w + 'x' + seed.h);

const run = async (tool, setup) => {
  const e0 = errors.length;
  await page.click(`[data-editor-tool="${tool}"]`);
  await page.waitForTimeout(1000);
  const before = await versionCount(page);
  let note = '';
  try { note = (await setup()) || ''; } catch (err) { note = 'SETUP-THREW: ' + err.message; }
  let ok = false;
  try { await page.waitForFunction((v) => document.querySelectorAll('[data-editor-version]').length > v, before, { timeout: 40000 }); ok = true; } catch { /* */ }
  await page.waitForTimeout(1200);
  const dims = ok ? await lastVersionDims(page) : '-';
  const labels = await page.$$eval('[data-editor-version]', (n) => n.map((x) => x.textContent.trim()));
  const status = await page.$eval('#editorStatus', (n) => n.textContent);
  const errs = errors.slice(e0).filter((e) => !e.includes('willReadFrequently') && !e.includes('dtype not'));
  log(tool.padEnd(15), (ok ? 'COMMIT ' + dims : 'NO COMMIT').padEnd(20), '| last=' + (labels[labels.length - 1] || '-').padEnd(14), '| status=' + JSON.stringify(status).slice(0, 58), '|', note, errs.length ? ' ERR ' + JSON.stringify(errs) : '');
};

await run('Adjust', async () => {
  const s = await page.$$('#editorToolPanel input[type=range]');
  await s[0].evaluate((n) => { n.value = '45'; n.dispatchEvent(new Event('input', { bubbles: true })); n.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForTimeout(1800);
  return await clickApply(page);
});
await run('Curves', async () => {
  const pad = await page.$('.editor-curve-pad');
  const b = await pad.boundingBox();
  await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.25, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(2200);
  return await clickApply(page);
});
await run('Levels', async () => {
  const s = await page.$$('#editorToolPanel input[type=range]');
  await s[0].evaluate((n) => { n.value = '30'; n.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForTimeout(1800);
  return await clickApply(page);
});
await run('HSL', async () => {
  const s = await page.$$('#editorToolPanel input[type=range]');
  await s[1].evaluate((n) => { n.value = '40'; n.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForTimeout(1800);
  return await clickApply(page);
});
await run('Rotate', async () => {
  const btns = await page.$$('#editorToolPanel button');
  for (const b of btns) if ((await b.textContent()).includes('Left')) { await b.click(); break; }
  await page.waitForTimeout(1500);
  return await clickApply(page);
});
await run('Perspective', async () => {
  const s = await page.$$('#editorToolPanel input[type=range]');
  await s[0].evaluate((n) => { n.value = '25'; n.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForTimeout(1800);
  return await clickApply(page);
});
await run('Crop', async () => {
  const btns = await page.$$('#editorToolPanel button');
  for (const b of btns) if ((await b.textContent()).trim() === '1:1') { await b.click(); break; }
  await page.waitForTimeout(1200);
  return await clickApply(page, /apply/i);
});
await run('White Balance', async () => {
  const box = await page.$eval('#editorPhotoView', (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await page.mouse.click(box.x + box.w * 0.6, box.y + box.h * 0.3);
  await page.waitForTimeout(2500);
  return 'tapped photo (auto-commits?)';
});
await run('Dodge & Burn', async () => { await dragOnPhoto(page, 0.5); await page.waitForTimeout(800); return await clickApply(page); });
await run('Draw', async () => { await dragOnPhoto(page, 0.4); await page.waitForTimeout(800); return await clickApply(page); });
await run('Blur & Sharpen', async () => { await dragOnPhoto(page, 0.6); await page.waitForTimeout(1500); return await clickApply(page); });
await run('Whiten', async () => { await dragOnPhoto(page, 0.55); await page.waitForTimeout(800); return await clickApply(page); });
await run('Stickers', async () => {
  const btns = await page.$$('#editorToolPanel button');
  if (btns[0]) await btns[0].click();
  const box = await page.$eval('#editorPhotoView', (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await page.mouse.click(box.x + box.w * 0.5, box.y + box.h * 0.5);
  await page.waitForTimeout(1000);
  return await clickApply(page);
});
await run('Portrait Blur', async () => { await dragOnPhoto(page, 0.5); await page.waitForTimeout(1500); return await clickApply(page); });
await run('Selective', async () => {
  const btns = await page.$$('#editorToolPanel button');
  for (const b of btns) if ((await b.textContent()).trim() === 'Sky') { await b.click(); break; }
  await page.waitForTimeout(2500);
  const s = await page.$$('#editorToolPanel input[type=range]');
  if (s[0]) await s[0].evaluate((n) => { n.value = '40'; n.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForTimeout(1800);
  return await clickApply(page);
});

log('final labels', JSON.stringify(await page.$$eval('[data-editor-version]', (n) => n.map((x) => x.textContent.trim()))));
log('ALL ERRORS', JSON.stringify(errors.filter((e) => !e.includes('willReadFrequently') && !e.includes('dtype not')), null, 1));
await browser.close();
