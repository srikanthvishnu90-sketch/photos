import { launch, enterApp } from './_qa-lib.mjs';
const R=[]; const say=(...a)=>R.push(a.join(' '));
for (const w of [320,390,430]) {
  const { browser, page } = await launch({width:w,height:844});
  try{
    await enterApp(page);
    await page.click('#homeScreen [data-app-tab="Photos"]'); await page.waitForTimeout(1400);
    const h = await page.evaluate(()=>{
      const hd=document.querySelector('.photos-header');
      const cs=getComputedStyle(hd);
      const btns=[...hd.querySelectorAll('button')].map(b=>{const r=b.getBoundingClientRect();return {id:b.id,l:+r.left.toFixed(0),r:+r.right.toFixed(0)};});
      return {win:window.innerWidth, overflowX:cs.overflowX, scrollW:hd.scrollWidth, clientW:hd.clientWidth, btns};
    });
    say(`W=${w} header: `+JSON.stringify(h));
    // can we click Import?
    let ok='clickable';
    try { await page.click('#photosImport',{timeout:1500, trial:true}); } catch(e){ ok='NOT CLICKABLE: '+e.message.split('\n')[0]; }
    say(`  #photosImport ${ok}`);
    const vis = await page.evaluate(()=>{const b=document.querySelector('#photosImport'); const r=b.getBoundingClientRect(); return {fullyVisible: r.right<=window.innerWidth, clippedPx:+(r.right-window.innerWidth).toFixed(0)};});
    say('  '+JSON.stringify(vis));
    // rail scroll test
    const rail = await page.evaluate(()=>{const el=document.querySelector('.photos-collections'); el.scrollLeft=9999; const s=el.scrollLeft; el.scrollLeft=0; return {maxScroll:s, cs:getComputedStyle(el).overflowX};});
    say('  collections rail: '+JSON.stringify(rail));
  }catch(e){ say(`FAIL ${w} `+e.message.split('\n')[0]); }
  await browser.close();
}
console.log(R.join('\n'));
