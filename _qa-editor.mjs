import { chromium } from '/Users/vishnusrikanth/assigno/node_modules/playwright/index.mjs';

const BASE = 'http://127.0.0.1:8204/';
const PHASE = process.argv[2] || 'all';

const log = (...a) => console.log(...a);

export async function boot({ width = 390, height = 844 } = {}) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  try { await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE }); } catch (e) { console.log('perm grant failed', e.message); }
  const page = await ctx.newPage();
  const errors = [];
  const requests = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`[console.${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}\n${(e.stack||'').split('\n').slice(0,4).join('\n')}`));
  page.on('requestfailed', (r) => {
    const u = r.url();
    if (u.startsWith(BASE)) errors.push(`[requestfailed] ${u} ${r.failure()?.errorText}`);
  });
  page.on('request', (r) => { if (!r.url().startsWith(BASE)) requests.push(`${r.method()} ${r.url()}`); });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  return { browser, ctx, page, errors, requests };
}

export async function onboard(page) {
  // splash -> login
  await page.waitForSelector('#loginScreen.is-active', { timeout: 20000 });
  await page.click('#emailOptionButton');
  await page.waitForSelector('#emailForm:not([hidden])');
  await page.fill('#emailInput', 'demo@gems.app');
  await page.click('#emailContinueButton');
  await page.waitForSelector('#onboardingScreen.is-active', { timeout: 10000 });

  await page.waitForSelector('#nameInput', { timeout: 5000 });
  await page.fill('#nameInput', 'QA Tester');
  await page.click('#nameContinue');

  await page.waitForSelector('#genderContinue', { timeout: 5000 });
  await page.click('.selection-list [data-selection]');
  await page.click('#genderContinue');

  await page.waitForSelector('#ageContinue', { timeout: 5000 });
  const rows = await page.$$('.age-step .selection-list [data-selection]');
  await rows[Math.min(2, rows.length - 1)].click();
  await page.click('#ageContinue');

  await page.waitForSelector('#aestheticContinue', { timeout: 5000 });
  await page.click('#tagCloud [data-vibe]');
  await page.click('#aestheticContinue');
  await page.waitForSelector('#homeScreen.is-active', { timeout: 30000 });
}

export async function seedPhoto(page, { w = 4000, h = 3000 } = {}) {
  return await page.evaluate(async ({ w, h }) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    // A varied scene: gradient sky, sun, ground, skin-tone blob, dark corner
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#2a4d7a'); g.addColorStop(0.5, '#e0a35a'); g.addColorStop(1, '#1c1a17');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#fff6d0'; ctx.beginPath(); ctx.arc(w * 0.7, h * 0.28, w * 0.06, 0, 7); ctx.fill();
    ctx.fillStyle = '#c98d6a'; ctx.beginPath(); ctx.ellipse(w * 0.35, h * 0.6, w * 0.12, h * 0.18, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#2f7a4a'; ctx.fillRect(0, h * 0.82, w, h * 0.18);
    for (let i = 0; i < 400; i++) {
      ctx.fillStyle = `rgba(${(i * 37) % 255},${(i * 91) % 255},${(i * 53) % 255},0.35)`;
      ctx.fillRect((i * 977) % w, (i * 613) % h, 26, 26);
    }
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    const file = new File([blob], 'qa-source.jpg', { type: 'image/jpeg' });
    const mod = await import('./gems-photolib.js');
    const res = await mod.importPhotoFiles([file]);
    const all = await mod.listPhotos();
    return { imported: res?.length ?? (Array.isArray(res) ? res.length : null), count: all.length, id: all[0]?.id, w: all[0]?.width, h: all[0]?.height, blobSize: blob.size };
  }, { w, h });
}

export async function openEditor(page, photoId, mode = 'manual') {
  // Real app path: Photos tab -> tile -> sheet action
  await page.evaluate(() => {
    document.querySelector('#homeScreen [data-app-tab="Photos"]')?.click();
  });
  await page.waitForSelector('#photosScreen.is-active', { timeout: 8000 });
  await page.waitForTimeout(600);
  const tile = await page.$(`#photosScreen [data-photo-id]`);
  if (!tile) throw new Error('no photo tile in Photos grid');
  await tile.click();
  await page.waitForSelector('.photos-sheet-action', { timeout: 8000 });
  const label = mode === 'manual' ? 'Edit manually' : 'Describe an edit';
  const btn = await page.$(`[data-photo-action="${label}"]`);
  if (!btn) {
    const all = await page.$$eval('[data-photo-action]', (n) => n.map((x) => x.dataset.photoAction));
    throw new Error('sheet action not found; had: ' + JSON.stringify(all));
  }
  await btn.click();
  await page.waitForSelector('#editorScreen.is-active', { timeout: 8000 });
  await page.waitForFunction(() => {
    const img = document.querySelector('#editorPhotoView');
    return img && !img.hidden && img.getAttribute('src');
  }, { timeout: 15000 });
}

export async function meanOfUrl(page, url) {
  return await page.evaluate(async (u) => {
    const img = new Image();
    img.decoding = 'sync';
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = u; });
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, 64, 64);
    const d = ctx.getImageData(0, 0, 64, 64).data;
    let r = 0, g = 0, b = 0, varsum = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 4;
    r /= n; g /= n; b /= n;
    for (let i = 0; i < d.length; i += 4) { varsum += (d[i] - r) ** 2; }
    return { r: +r.toFixed(2), g: +g.toFixed(2), b: +b.toFixed(2), sd: +Math.sqrt(varsum / n).toFixed(2), w: img.naturalWidth, h: img.naturalHeight };
  }, url);
}

if (PHASE === 'filters') {
  const { browser, page, errors, requests } = await boot();
  await onboard(page);
  const seed = await seedPhoto(page);
  await openEditor(page, seed.id, 'manual');
  log('source dims', seed.w + 'x' + seed.h);

  await page.click('[data-editor-tool="Filters"]');
  await page.waitForSelector('.editor-filter-chip', { timeout: 10000 });
  const chips = await page.$$eval('[data-grade]', (n) => n.map((x) => x.dataset.grade));
  log('chips', chips.length, chips.join('|'));

  // wait for thumbs (generated sequentially)
  await page.waitForTimeout(6000);
  const thumbs = await page.$$eval('[data-grade]', (nodes) => nodes.map((n) => ({
    key: n.dataset.grade,
    bg: n.querySelector('[data-grade-thumb]')?.style.backgroundImage || '',
  })));
  for (const t of thumbs) {
    if (!t.bg) { log('THUMB MISSING', t.key); continue; }
    const url = t.bg.slice(4, -1).replace(/["']/g, '');
    const m = await meanOfUrl(page, url);
    log('thumb', t.key.padEnd(14), JSON.stringify(m));
  }

  log('--- tap timings ---');
  const timings = [];
  for (const key of chips) {
    const before = await page.evaluate(() => document.querySelector('#editorPhotoView').src);
    const t0 = Date.now();
    await page.click(`[data-grade="${key}"]`);
    let changed = false;
    try {
      await page.waitForFunction((b) => document.querySelector('#editorPhotoView').src !== b, before, { timeout: 30000 });
      changed = true;
    } catch { /* timeout */ }
    const ms = Date.now() - t0;
    const src = await page.evaluate(() => document.querySelector('#editorPhotoView').src);
    const m = changed ? await meanOfUrl(page, src) : null;
    timings.push({ key, ms, changed, mean: m });
    log('tap', key.padEnd(14), ms + 'ms', changed ? JSON.stringify(m) : 'NO PREVIEW CHANGE');
  }

  log('ERRORS', JSON.stringify(errors, null, 1));
  log('SUPABASE REQS', JSON.stringify(requests.filter((r) => r.includes('supabase.co')), null, 1));
  await browser.close();
}

if (PHASE === 'apply') {
  const { browser, page, errors } = await boot();
  await onboard(page);
  const seed = await seedPhoto(page);
  await openEditor(page, seed.id, 'manual');
  log('source dims (record)', seed.w + 'x' + seed.h);
  const origMean = await page.evaluate(() => {
    const i = document.querySelector('#editorPhotoView');
    return { src: i.src.slice(0, 12), w: i.naturalWidth, h: i.naturalHeight };
  });
  log('version0 natural', JSON.stringify(origMean));

  await page.click('[data-editor-tool="Filters"]');
  await page.waitForSelector('.editor-filter-chip');
  await page.click('[data-grade="golden-hour"]');
  await page.waitForTimeout(3000);
  const t0 = Date.now();
  await page.click('[data-filter-apply]');
  await page.waitForFunction(() => document.querySelectorAll('[data-editor-version]').length > 1, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  log('apply took', Date.now() - t0, 'ms');
  const vers = await page.$$eval('[data-editor-version]', (n) => n.map((x) => x.textContent.trim() + (x.classList.contains('is-active') ? '*' : '')));
  log('versions', JSON.stringify(vers));
  const committed = await page.evaluate(async () => {
    const i = document.querySelector('#editorPhotoView');
    await i.decode().catch(() => {});
    return { w: i.naturalWidth, h: i.naturalHeight, src: i.src.slice(0, 5) };
  });
  log('COMMITTED natural dims', JSON.stringify(committed));
  log('ERRORS', JSON.stringify(errors, null, 1));
  await browser.close();
}

if (PHASE === 'rapid') {
  const { browser, page, errors } = await boot();
  await onboard(page);
  const seed = await seedPhoto(page);
  await openEditor(page, seed.id, 'manual');
  await page.click('[data-editor-tool="Filters"]');
  await page.waitForSelector('.editor-filter-chip');
  await page.waitForTimeout(6000);

  const order = ['dark-gym', 'after-dark', 'film', 'coastal', 'nightlife', 'streetwear', 'golden-hour', 'euro-summer', 'clean-editorial', 'dark-gym', 'coastal', 'after-dark'];
  const memBefore = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
  const t0 = Date.now();
  for (const k of order) {
    await page.click(`[data-grade="${k}"]`, { delay: 0 });
    await page.waitForTimeout(40);
  }
  log('12 taps dispatched in', Date.now() - t0, 'ms');
  // let everything settle
  await page.waitForTimeout(12000);
  const last = order[order.length - 1];
  const state = await page.evaluate(() => ({
    src: document.querySelector('#editorPhotoView').src,
    active: [...document.querySelectorAll('[data-grade]')].filter((n) => n.classList.contains('is-active')).map((n) => n.dataset.grade),
    filterStyle: document.querySelector('#editorPhotoView').style.filter,
  }));
  const m = await meanOfUrl(page, state.src);
  log('after rapid: active chip(s)=', JSON.stringify(state.active), 'inline filter=', JSON.stringify(state.filterStyle));
  log('preview mean', JSON.stringify(m), 'expected for', last);
  // now settle and tap the same one alone to get the reference mean
  await page.click(`[data-grade="clean-editorial"]`);
  await page.waitForTimeout(4000);
  await page.click(`[data-grade="${last}"]`);
  await page.waitForTimeout(6000);
  const ref = await meanOfUrl(page, await page.evaluate(() => document.querySelector('#editorPhotoView').src));
  log('reference mean for', last, JSON.stringify(ref));
  const memAfter = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
  log('heap', memBefore, '->', memAfter, 'delta MB', ((memAfter - memBefore) / 1048576).toFixed(2));
  log('ERRORS', JSON.stringify(errors.filter((e) => !e.includes('willReadFrequently')), null, 1));
  await browser.close();
}

if (PHASE === 'typing') {
  const { browser, page, errors } = await boot();
  await onboard(page);
  const seed = await seedPhoto(page);
  await openEditor(page, seed.id, 'describe');
  await page.waitForTimeout(1500);
  const sel = '#editorPrompt';
  const box = async () => await page.$eval(sel, (n) => { const r = n.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; });
  const focused = async () => await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
  log('rest box', JSON.stringify(await box()));
  await page.focus(sel);
  await page.waitForTimeout(700);
  log('focused box', JSON.stringify(await box()), 'activeElement=', await focused());

  const long = 'Make the sky a deep cinematic teal and the skin tones warm, then add a subtle halation bloom around the highlights while keeping the grain fine and the shadows lifted just slightly for a filmic feel across the whole frame okay thanks. '.repeat(2).slice(0, 300);
  const t0 = Date.now();
  await page.type(sel, long, { delay: 3 });
  const typeMs = Date.now() - t0;
  const val = await page.$eval(sel, (n) => n.value);
  log('typed 300 chars in', typeMs, 'ms; length stored =', val.length, '(expected', long.length + ')', 'match=', val === long);
  log('while-typing box', JSON.stringify(await box()), 'activeElement=', await focused());
  const caret = await page.$eval(sel, (n) => ({ s: n.selectionStart, e: n.selectionEnd }));
  log('caret after typing', JSON.stringify(caret));

  // real paste (clipboard + ControlOrMeta+V)
  await page.evaluate(() => navigator.clipboard.writeText('PASTED-TEXT-9999 ')).catch((e) => log('clipboard write failed', e.message));
  await page.evaluate(() => { const n = document.querySelector('#editorPrompt'); n.focus(); n.setSelectionRange(0, 0); });
  const yBeforePaste = await box();
  await page.keyboard.press('ControlOrMeta+v');
  await page.waitForTimeout(300);
  const pv = await page.$eval(sel, (n) => n.value);
  log('after paste: len', pv.length, 'starts', JSON.stringify(pv.slice(0, 24)), 'caret', JSON.stringify(await page.$eval(sel, (n) => n.selectionStart)), 'boxMoved=', JSON.stringify(await box()) !== JSON.stringify(yBeforePaste));

  // select-all replace
  await page.click(sel);
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('replaced entirely');
  await page.waitForTimeout(200);
  log('after select-all replace:', JSON.stringify(await page.$eval(sel, (n) => n.value)), 'activeElement=', await focused());

  // emoji
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await page.type(sel, 'make it 🔥 moody 🌇 vibes 👨‍👩‍👧‍👦', { delay: 10 });
  await page.waitForTimeout(200);
  const ev = await page.$eval(sel, (n) => n.value);
  log('emoji value', JSON.stringify(ev), 'len', ev.length, 'activeElement=', await focused());
  log('final box', JSON.stringify(await box()));
  log('apply button disabled?', await page.$eval('#editorApply', (n) => n.disabled));
  log('ERRORS', JSON.stringify(errors.filter((e) => !e.includes('willReadFrequently')), null, 1));
  await browser.close();
}

if (PHASE === 'aliases') {
  const phrases = ['make it moody', 'golden hour', 'filmic', 'punchy', 'bright and airy', 'cold steel'];
  const { browser, page, errors, requests } = await boot();
  await onboard(page);
  const seed = await seedPhoto(page);
  await openEditor(page, seed.id, 'describe');
  await page.waitForTimeout(1500);
  for (const p of phrases) {
    const before = requests.filter((r) => r.includes('supabase.co/functions')).length;
    const versBefore = await page.$$eval('[data-editor-version]', (n) => n.length);
    const t0 = Date.now();
    await page.fill('#editorPrompt', p);
    await page.click('#editorApply');
    let ok = false;
    try {
      await page.waitForFunction((v) => document.querySelectorAll('[data-editor-version]').length > v, versBefore, { timeout: 25000 });
      ok = true;
    } catch { /* none */ }
    const ms = Date.now() - t0;
    const after = requests.filter((r) => r.includes('supabase.co/functions'));
    const newReqs = after.slice(before).filter((r) => !r.startsWith('OPTIONS'));
    const labels = await page.$$eval('[data-editor-version]', (n) => n.map((x) => x.textContent.trim()));
    const status = await page.$eval('#editorStatus', (n) => n.textContent);
    log(JSON.stringify(p).padEnd(20), ok ? 'v+' : 'NO VERSION', ms + 'ms', '| label=', labels[labels.length - 1], '| status=', JSON.stringify(status), '| net=', JSON.stringify(newReqs));
    await page.waitForTimeout(500);
  }
  log('ALL SUPABASE REQS', JSON.stringify([...new Set(requests.filter((r) => r.includes('supabase.co/functions')))], null, 1));
  log('ERRORS', JSON.stringify(errors.filter((e) => !e.includes('willReadFrequently')), null, 1));
  await browser.close();
}

if (PHASE === 'tools') {
  const { browser, page, errors } = await boot();
  await onboard(page);
  const seed = await seedPhoto(page, { w: 1800, h: 1200 });
  await openEditor(page, seed.id, 'manual');
  const tools = await page.$$eval('[data-editor-tool]', (n) => n.map((x) => x.dataset.editorTool));
  for (const t of tools) {
    const errCountBefore = errors.length;
    await page.click(`[data-editor-tool="${t}"]`);
    await page.waitForTimeout(900);
    const info = await page.evaluate(() => {
      const p = document.querySelector('#editorToolPanel');
      return {
        hidden: p.hidden,
        html: p.innerHTML.trim().length,
        controls: p.querySelectorAll('button, input, select, canvas').length,
        text: (p.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 70),
      };
    });
    const newErr = errors.slice(errCountBefore).filter((e) => !e.includes('willReadFrequently'));
    log(t.padEnd(16), 'hidden=' + info.hidden, 'len=' + info.html, 'controls=' + info.controls, '|', info.text, newErr.length ? ' ERR:' + JSON.stringify(newErr) : '');
  }
  // mid-edit tool switching: start adjust drag then jump away
  log('--- mid-edit switch ---');
  await page.click('[data-editor-tool="Adjust"]');
  await page.waitForTimeout(600);
  const slider = await page.$('#editorToolPanel input[type=range]');
  if (slider) {
    await slider.evaluate((n) => { n.value = String(Number(n.max) * 0.7); n.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForTimeout(200);
    await page.click('[data-editor-tool="Curves"]');
    await page.waitForTimeout(800);
    await page.click('[data-editor-tool="Filters"]');
    await page.waitForTimeout(1500);
    await page.click('[data-editor-tool="Crop"]');
    await page.waitForTimeout(800);
    const st = await page.evaluate(() => ({
      filter: document.querySelector('#editorPhotoView').style.filter,
      transform: document.querySelector('#editorPhotoView').style.transform,
      src: document.querySelector('#editorPhotoView').src.slice(0, 5),
      versions: document.querySelectorAll('[data-editor-version]').length,
    }));
    log('after switching Adjust->Curves->Filters->Crop:', JSON.stringify(st));
  }
  log('ERRORS', JSON.stringify(errors.filter((e) => !e.includes('willReadFrequently')), null, 1));
  await browser.close();
}

if (PHASE === 'versions') {
  const { browser, page, errors } = await boot();
  await onboard(page);
  const seed = await seedPhoto(page, { w: 1600, h: 1200 });
  await openEditor(page, seed.id, 'manual');
  await page.click('[data-editor-tool="Filters"]');
  await page.waitForSelector('.editor-filter-chip');
  await page.waitForTimeout(4000);
  for (const k of ['after-dark', 'golden-hour', 'coastal']) {
    await page.click(`[data-grade="${k}"]`);
    await page.waitForTimeout(2500);
    const n = await page.$$eval('[data-editor-version]', (x) => x.length);
    await page.click('[data-filter-apply]');
    await page.waitForFunction((v) => document.querySelectorAll('[data-editor-version]').length > v, n, { timeout: 40000 });
    await page.waitForTimeout(3000);
  }
  const labels = await page.$$eval('[data-editor-version]', (n) => n.map((x) => x.textContent.trim()));
  log('versions', JSON.stringify(labels));
  const means = [];
  for (let i = 0; i < labels.length; i++) {
    await page.click(`[data-editor-version="${i}"]`);
    await page.waitForTimeout(1200);
    const src = await page.evaluate(() => document.querySelector('#editorPhotoView').src);
    const m = await meanOfUrl(page, src);
    means.push({ i, label: labels[i], ...m });
    log('version', i, labels[i], JSON.stringify(m));
  }
  const uniq = new Set(means.map((m) => `${m.r}/${m.g}/${m.b}`));
  log('distinct images:', uniq.size, 'of', means.length);
  log('undo control present?', await page.evaluate(() => !!document.querySelector('[data-editor-undo], #editorUndo, [aria-label*="Undo" i]')));
  log('ERRORS', JSON.stringify(errors.filter((e) => !e.includes('willReadFrequently')), null, 1));
  await browser.close();
}

if (PHASE === 'reentry') {
  const { browser, page, errors } = await boot();
  await onboard(page);
  const seed = await seedPhoto(page, { w: 1600, h: 1200 });
  const snap = async (tag) => {
    const s = await page.evaluate(() => ({
      mounts: document.querySelectorAll('#editorMount .editor-shell, #editorMount > *').length,
      prompts: document.querySelectorAll('#editorPrompt').length,
      tools: document.querySelectorAll('[data-editor-tool]').length,
      versions: document.querySelectorAll('[data-editor-version]').length,
      modeBtns: document.querySelectorAll('[data-editor-mode]').length,
      canvases: document.querySelectorAll('#editorScreen canvas').length,
      promptValue: document.querySelector('#editorPrompt').value,
      status: document.querySelector('#editorStatus').textContent,
      heap: performance.memory?.usedJSHeapSize ?? 0,
    }));
    log(tag, JSON.stringify(s));
    return s;
  };
  for (let i = 1; i <= 3; i++) {
    await openEditor(page, seed.id, 'manual');
    await page.click('[data-editor-tool="Filters"]');
    await page.waitForSelector('.editor-filter-chip');
    await page.waitForTimeout(3500);
    await page.click('[data-grade="film"]');
    await page.waitForTimeout(2500);
    await snap('enter#' + i);
    await page.click('#editorBack');
    await page.waitForSelector('#photosScreen.is-active', { timeout: 8000 });
    await page.waitForTimeout(900);
    // back to home so openEditor's tab click works
    await page.evaluate(() => document.querySelector('#photosScreen [data-app-tab="Home"]')?.click());
    await page.waitForSelector('#homeScreen.is-active', { timeout: 8000 });
    await page.waitForTimeout(500);
  }
  // count listeners indirectly: click a chip once and see how many previews render
  log('ERRORS', JSON.stringify(errors.filter((e) => !e.includes('willReadFrequently')), null, 1));
  await browser.close();
}

if (PHASE === 'viewport') {
  for (const [w, h] of [[320, 568], [430, 932], [390, 844]]) {
    const { browser, page, errors } = await boot({ width: w, height: h });
    await onboard(page);
    const seed = await seedPhoto(page, { w: 1600, h: 1200 });
    await openEditor(page, seed.id, 'manual');
    await page.click('[data-editor-tool="Filters"]');
    await page.waitForSelector('.editor-filter-chip');
    await page.waitForTimeout(3500);
    const res = await page.evaluate((vw) => {
      const out = { docScrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, offenders: [] };
      const scope = document.querySelector('#editorScreen');
      for (const el of scope.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.right > vw + 1 || r.left < -1) {
          const cs = getComputedStyle(el);
          const parent = el.parentElement;
          const pOverflow = parent ? getComputedStyle(parent).overflowX : '';
          if (pOverflow === 'auto' || pOverflow === 'scroll') continue;
          out.offenders.push({ sel: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''), left: +r.left.toFixed(1), right: +r.right.toFixed(1), w: +r.width.toFixed(1), overflow: cs.overflowX });
        }
      }
      // clipping: does the version rail / tool rail overflow its own box?
      const rail = document.querySelector('#editorVersions');
      const filt = document.querySelector('.editor-filter-rail');
      const panel = document.querySelector('#editorToolPanel');
      out.rail = rail ? { sw: rail.scrollWidth, cw: rail.clientWidth, ox: getComputedStyle(rail).overflowX } : null;
      out.filterRail = filt ? { sw: filt.scrollWidth, cw: filt.clientWidth, ox: getComputedStyle(filt).overflowX } : null;
      out.panel = panel ? { sh: panel.scrollHeight, ch: panel.clientHeight, bottom: +panel.getBoundingClientRect().bottom.toFixed(1) } : null;
      const shell = document.querySelector('#editorMount');
      out.shell = { sh: shell.scrollHeight, ch: shell.clientHeight, rect: JSON.parse(JSON.stringify(shell.getBoundingClientRect())) };
      return out;
    }, w);
    log('=== viewport', w + 'x' + h, '===');
    log(JSON.stringify(res, null, 1).slice(0, 3000));
    await page.screenshot({ path: `/private/tmp/claude-501/-Users-vishnusrikanth/27e14023-7753-4125-ab34-3c4d570cb2c3/scratchpad/editor-${w}x${h}.png` });
    log('ERRORS', JSON.stringify(errors.filter((e) => !e.includes('willReadFrequently')), null, 1));
    await browser.close();
  }
}


if (PHASE === 'jank') {
  const { browser, page, errors } = await boot();
  await onboard(page);
  const seed = await seedPhoto(page);
  await openEditor(page, seed.id, 'manual');
  await page.click('[data-editor-tool="Filters"]');
  await page.waitForSelector('.editor-filter-chip');
  await page.waitForTimeout(6000);
  await page.evaluate(() => {
    window.__long = [];
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] });
  });
  // single tap: how long is the main thread blocked?
  await page.evaluate(() => { window.__long.length = 0; document.querySelector('[data-grade="golden-hour"]').click(); });
  await page.waitForTimeout(6000);
  log('single tap longtasks(ms):', JSON.stringify(await page.evaluate(() => window.__long)));

  // synchronous burst of 12 clicks, no waiting between
  const order = ['dark-gym','after-dark','film','coastal','nightlife','streetwear','golden-hour','euro-summer','clean-editorial','dark-gym','coastal','film'];
  await page.evaluate((o) => {
    window.__long.length = 0;
    window.__t0 = performance.now();
    for (const k of o) document.querySelector(`[data-grade="${k}"]`).click();
  }, order);
  await page.waitForTimeout(20000);
  log('burst longtasks(ms):', JSON.stringify(await page.evaluate(() => window.__long)));
  const st = await page.evaluate(() => ({
    active: [...document.querySelectorAll('[data-grade]')].filter((n) => n.classList.contains('is-active')).map((n) => n.dataset.grade),
    src: document.querySelector('#editorPhotoView').src,
  }));
  log('burst final active', JSON.stringify(st.active));
  log('burst final mean', JSON.stringify(await meanOfUrl(page, st.src)));
  await page.click('[data-grade="clean-editorial"]'); await page.waitForTimeout(4000);
  await page.click('[data-grade="film"]'); await page.waitForTimeout(6000);
  log('reference mean film', JSON.stringify(await meanOfUrl(page, await page.evaluate(() => document.querySelector('#editorPhotoView').src))));
  log('blob url count minted (filterThumbUrls proxy): n/a');
  log('ERRORS', JSON.stringify(errors.filter((e) => !e.includes('willReadFrequently')), null, 1));
  await browser.close();
}


if (PHASE === 'clip') {
  for (const [w, h] of [[320, 568], [390, 844], [430, 932]]) {
    const { browser, page, errors } = await boot({ width: w, height: h });
    await onboard(page);
    const seed = await seedPhoto(page, { w: 1600, h: 1200 });
    await openEditor(page, seed.id, 'manual');
    await page.click('[data-editor-tool="Filters"]');
    await page.waitForSelector('.editor-filter-chip');
    await page.waitForTimeout(3500);
    const info = await page.evaluate((vh) => {
      const btn = document.querySelector('[data-filter-apply]');
      const r = btn.getBoundingClientRect();
      // scrollable ancestors
      const chain = [];
      let el = btn;
      while (el && el !== document.documentElement) {
        const cs = getComputedStyle(el);
        chain.push({
          sel: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/)[0] : ''),
          oy: cs.overflowY, sh: el.scrollHeight, ch: el.clientHeight, scrollable: el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(cs.overflowY),
        });
        el = el.parentElement;
      }
      return { applyRect: { top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1) }, vh, offscreen: r.top > vh, chain,
        bodyScroll: { sh: document.body.scrollHeight, ch: document.body.clientHeight },
        panelRect: (() => { const p = document.querySelector('#editorManualPanel').getBoundingClientRect(); return { top: +p.top.toFixed(1), bottom: +p.bottom.toFixed(1) }; })(),
      };
    }, h);
    log('=== ' + w + 'x' + h + ' ===');
    log(JSON.stringify(info, null, 1));
    // can a user scroll to it?
    const scrolled = await page.evaluate(() => {
      const btn = document.querySelector('[data-filter-apply]');
      btn.scrollIntoView({ block: 'center' });
      const r = btn.getBoundingClientRect();
      return { top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1) };
    });
    log('after scrollIntoView:', JSON.stringify(scrolled), 'viewportH=', h);
    await page.screenshot({ path: `/private/tmp/claude-501/-Users-vishnusrikanth/27e14023-7753-4125-ab34-3c4d570cb2c3/scratchpad/clip-${w}x${h}.png` });
    log('ERRORS', JSON.stringify(errors.filter((e) => !e.includes('willReadFrequently') && !e.includes('dtype not')), null, 1));
    await browser.close();
  }
}


if (PHASE === 'clip2') {
  for (const [w, h] of [[320, 568], [390, 844], [430, 932]]) {
    const { browser, page, errors } = await boot({ width: w, height: h });
    await onboard(page);
    const seed = await seedPhoto(page, { w: 1600, h: 1200 });
    await openEditor(page, seed.id, 'manual');
    await page.waitForTimeout(1200);
    log('=== ' + w + 'x' + h + ' at rest (manual/Erase) ===');
    await page.screenshot({ path: `/private/tmp/claude-501/-Users-vishnusrikanth/27e14023-7753-4125-ab34-3c4d570cb2c3/scratchpad/rest-${w}x${h}.png` });
    const clipped = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('#editorScreen *')) {
        if (el.children.length) continue;
        const txt = (el.textContent || '').trim();
        if (!txt) continue;
        if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
          out.push({ txt: txt.slice(0, 30), sw: el.scrollWidth, cw: el.clientWidth, cls: (typeof el.className === 'string' ? el.className : '') });
        }
      }
      return out;
    });
    log('text-clipped elements:', JSON.stringify(clipped, null, 1));
    const chips = await page.evaluate(() => [...document.querySelectorAll('[data-editor-tool]')].map((n) => {
      const r = n.getBoundingClientRect();
      return { t: n.textContent.trim(), sw: n.scrollWidth, cw: n.clientWidth, w: +r.width.toFixed(1), h: +r.height.toFixed(1), clipped: n.scrollWidth > n.clientWidth + 1 };
    }).filter((x) => x.clipped));
    log('clipped tool chips:', JSON.stringify(chips));
    log('ERRORS', JSON.stringify(errors.filter((e) => !e.includes('willReadFrequently') && !e.includes('dtype not')), null, 1));
    await browser.close();
  }
}


if (PHASE === 'misc') {
  const { browser, page, errors, requests } = await boot();
  await onboard(page);
  const seed = await seedPhoto(page, { w: 2400, h: 1800 });
  await openEditor(page, seed.id, 'manual');

  // --- blob URL leak: thumbs revoked when leaving the Filters tool? ---
  await page.click('[data-editor-tool="Filters"]');
  await page.waitForSelector('.editor-filter-chip');
  await page.waitForTimeout(4000);
  const thumbUrl = await page.$eval('[data-grade="dark-gym"] [data-grade-thumb]', (n) => n.style.backgroundImage.slice(4, -1).replace(/["\']/g, ''));
  const aliveBefore = await page.evaluate((u) => fetch(u).then((r) => r.ok).catch(() => false), thumbUrl);
  await page.click('[data-editor-tool="Adjust"]');
  await page.waitForTimeout(800);
  const aliveAfterToolSwitch = await page.evaluate((u) => fetch(u).then((r) => r.ok).catch(() => false), thumbUrl);
  log('thumb blob alive before switch=', aliveBefore, ' after switching to Adjust=', aliveAfterToolSwitch, '(true after switch = leaked)');

  // heap growth over repeated Filters visits
  const h0 = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
  for (let i = 0; i < 8; i++) {
    await page.click('[data-editor-tool="Filters"]');
    await page.waitForTimeout(2600);
    await page.click('[data-editor-tool="Adjust"]');
    await page.waitForTimeout(300);
  }
  const h1 = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
  log('heap after 8 Filters visits:', (h0 / 1048576).toFixed(1), '->', (h1 / 1048576).toFixed(1), 'MB');

  // --- double-tap Apply -> duplicate versions? ---
  await page.click('[data-editor-tool="Filters"]');
  await page.waitForTimeout(3000);
  await page.click('[data-grade="film"]');
  await page.waitForTimeout(2500);
  const before = await page.$$eval('[data-editor-version]', (n) => n.length);
  await page.evaluate(() => { const b = document.querySelector('[data-filter-apply]'); b.click(); b.click(); b.click(); });
  await page.waitForTimeout(9000);
  const after = await page.$$eval('[data-editor-version]', (n) => n.length);
  log('versions before triple-Apply', before, '-> after', after, '(expected +1)');
  log('labels', JSON.stringify(await page.$$eval('[data-editor-version]', (n) => n.map((x) => x.textContent.trim()))));

  // --- Clear button ---
  await page.click('[data-editor-tool="Filters"]');
  await page.waitForTimeout(3000);
  await page.click('[data-grade="nightlife"]');
  await page.waitForTimeout(2500);
  const previewSrc = await page.evaluate(() => document.querySelector('#editorPhotoView').src);
  await page.click('[data-filter-clear]');
  await page.waitForTimeout(600);
  const afterClear = await page.evaluate(() => ({ src: document.querySelector('#editorPhotoView').src, filter: document.querySelector('#editorPhotoView').style.filter, applyDisabled: document.querySelector('[data-filter-apply]').disabled }));
  log('Clear restored canonical version?', afterClear.src !== previewSrc, JSON.stringify(afterClear).slice(0, 160));

  // --- switch to Describe mid-filter-preview ---
  await page.click('[data-grade="coastal"]');
  await page.waitForTimeout(2500);
  await page.click('[data-editor-mode="describe"]');
  await page.waitForTimeout(800);
  const afterMode = await page.evaluate(() => ({
    src: document.querySelector('#editorPhotoView').src.slice(0, 5),
    filter: document.querySelector('#editorPhotoView').style.filter,
    toolPanelHidden: document.querySelector('#editorToolPanel').hidden,
    describeHidden: document.querySelector('#editorDescribePanel').hidden,
  }));
  log('after mode switch mid-preview:', JSON.stringify(afterMode));
  await page.click('[data-editor-mode="manual"]');
  await page.waitForTimeout(800);
  log('back to manual, tool panel html len', await page.$eval('#editorToolPanel', (n) => n.innerHTML.length));

  // --- AI tool without a session (Erase / Add) ---
  await page.click('[data-editor-tool="Add"]');
  await page.waitForTimeout(600);
  const addInput = await page.$('#editorToolPanel input[type=text], #editorToolPanel input:not([type])');
  if (addInput) {
    await addInput.fill('a red balloon');
    const btns = await page.$$('#editorToolPanel button');
    for (const b of btns) { if ((await b.textContent()).trim().toLowerCase().includes('apply')) { await b.click(); break; } }
    await page.waitForTimeout(9000);
    log('Add status:', JSON.stringify(await page.$eval('#editorStatus', (n) => n.textContent)));
  } else { log('Add: no text input found'); }

  log('ERRORS', JSON.stringify(errors.filter((e) => !e.includes('willReadFrequently') && !e.includes('dtype not')), null, 1));
  log('SUPABASE', JSON.stringify([...new Set(requests.filter((r) => r.includes('supabase.co/functions')))], null, 1));
  await browser.close();
}

if (PHASE === 'smoke') {
  const { browser, page, errors, requests } = await boot();
  await onboard(page);
  log('onboarded OK');
  const seed = await seedPhoto(page);
  log('seed', JSON.stringify(seed));
  await openEditor(page, seed.id, 'manual');
  log('editor open. mode manual');
  const tools = await page.$$eval('[data-editor-tool]', (n) => n.map((x) => x.dataset.editorTool));
  log('tools', tools.length, tools.join('|'));
  log('ERRORS', JSON.stringify(errors, null, 1));
  log('EXT REQUESTS', JSON.stringify([...new Set(requests)], null, 1));
  await browser.close();
}
