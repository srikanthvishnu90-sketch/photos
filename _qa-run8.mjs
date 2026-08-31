import { boot, logs, reachHome } from './_qa-studio.mjs';
const SS='/private/tmp/claude-501/-Users-vishnusrikanth/27e14023-7753-4125-ab34-3c4d570cb2c3/scratchpad/';
const { browser, page } = await boot();
async function clearReveal(){
  for (let i=0;i<10;i++){
    const n = await page.evaluate(()=>{
      const r=document.querySelector('#gemsRevealRoot');
      if(!r||!r.children.length) return 0;
      const c=r.querySelector('[data-reveal-close],[aria-label="Close"],.reveal-close');
      if(c){c.click();return 1;}
      r.replaceChildren(); return 2;
    });
    if(n===0) return;
    await page.waitForTimeout(400);
  }
}
try {
  await reachHome(page);
  const seed = await page.evaluate(async () => {
    const m = await import('./gems-photolib.js');
    const files = [];
    for (let i=0;i<14;i++){
      const c=document.createElement('canvas');c.width=600;c.height=800;const g=c.getContext('2d');
      g.fillStyle=`hsl(${i*25} 60% ${40+i}%)`;g.fillRect(0,0,600,800);
      g.fillStyle='#fff';g.font='60px sans-serif';g.fillText('P'+i,40,120);
      const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',0.8));
      files.push(new File([blob],`p${i}.jpg`,{type:'image/jpeg',lastModified:Date.now()-i*86400000}));
    }
    try{await m.importPhotoFiles(files);return {count:await m.photoCount()};}catch(e){return {err:e.message};}
  });
  console.log('SEED', JSON.stringify(seed));
  await page.waitForTimeout(2000); await clearReveal(); await page.waitForTimeout(500);
  await page.click('#homeScreen [data-app-tab="Studio"]');
  await page.waitForTimeout(900);
  await page.click('#studioNewProject');
  await page.waitForTimeout(700);
  await page.click('#studioDumpBuild');
  await page.waitForTimeout(5000);
  console.log('after build', await page.evaluate(()=>document.querySelector('#studioDumpBody').textContent.replace(/\s+/g,' ').trim().slice(0,300)));
  await page.screenshot({path:SS+'dump-options.png'});
  const opt = await page.$('[data-dump-option]');
  if (opt) { await opt.click(); await page.waitForTimeout(800); }
  console.log('revise input present:', !!(await page.$('.studio-dump-input')));
  await page.screenshot({path:SS+'dump-set.png'});

  // ==== TEXT INPUT TESTS ====
  const box = async () => page.evaluate(()=>{const i=document.querySelector('.studio-dump-input');if(!i)return null;const r=i.getBoundingClientRect();return {y:Math.round(r.y),x:Math.round(r.x),w:Math.round(r.width)};});
  console.log('rest box', JSON.stringify(await box()));
  await page.focus('.studio-dump-input'); await page.waitForTimeout(400);
  console.log('focused box', JSON.stringify(await box()));
  const long = 'A'.repeat(200);
  await page.type('.studio-dump-input', long, {delay:2});
  await page.waitForTimeout(300);
  console.log('typing box', JSON.stringify(await box()));
  console.log('value len / focus / caret', JSON.stringify(await page.evaluate(()=>{const i=document.querySelector('.studio-dump-input');return {len:i.value.length, focused:document.activeElement===i, sel:i.selectionStart};})));
  // emoji + select-all replace
  await page.evaluate(()=>{const i=document.querySelector('.studio-dump-input');i.select();});
  await page.type('.studio-dump-input','🔥🌊 café naïve 😀', {delay:5});
  console.log('emoji', JSON.stringify(await page.evaluate(()=>{const i=document.querySelector('.studio-dump-input');return {v:i.value, focused:document.activeElement===i, caret:i.selectionStart};})));
  // paste
  await page.evaluate(()=>{const i=document.querySelector('.studio-dump-input');i.select();});
  await page.evaluate(()=>{
    const i=document.querySelector('.studio-dump-input');
    const dt=new DataTransfer(); dt.setData('text/plain','pasted <b>bold</b> text');
    i.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
  });
  await page.waitForTimeout(200);
  console.log('paste', JSON.stringify(await page.evaluate(()=>document.querySelector('.studio-dump-input').value)));
  // HTML injection -> submit revision
  await page.evaluate(()=>{const i=document.querySelector('.studio-dump-input');i.value='';});
  await page.fill('.studio-dump-input', '<img src=x onerror=window.__XSS=1> replace slide 6');
  await page.press('.studio-dump-input','Enter');
  await page.waitForTimeout(1500);
  const inj = await page.evaluate(()=>({xss: !!window.__XSS, imgs: document.querySelectorAll('#studioDumpBody img[src="x"]').length,
    noteHtml: document.querySelector('.studio-dump-note')?.innerHTML || null,
    noteText: document.querySelector('.studio-dump-note')?.textContent || null,
    bodySnippet: document.querySelector('#studioDumpBody').innerHTML.slice(0,0)}));
  console.log('INJECTION', JSON.stringify(inj));
  await page.screenshot({path:SS+'dump-inject.png'});
  // status live region
  console.log('status', await page.evaluate(()=>document.querySelector('#studioStatus').textContent));
  // save to studio while signed out
  await page.click('#studioDumpSave'); await page.waitForTimeout(1200);
  console.log('save status', await page.evaluate(()=>document.querySelector('#studioStatus').textContent));
} catch (e) { console.log('ERR', e.message, e.stack?.split('\n')[0]); }
console.log('--- LOGS ---'); console.log([...new Set(logs())].join('\n'));
await browser.close();
