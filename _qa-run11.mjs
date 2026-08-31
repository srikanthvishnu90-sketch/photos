import { boot, logs, reachHome } from './_qa-studio.mjs';
const SS='/private/tmp/claude-501/-Users-vishnusrikanth/27e14023-7753-4125-ab34-3c4d570cb2c3/scratchpad/';
const sizes = [[320,568],[430,932]];
for (const [w,h] of sizes) {
  const { browser, page } = await boot({width:w,height:h});
  try {
    await reachHome(page);
    const overflow = () => page.evaluate((vw)=>{
      const out=[];
      document.querySelectorAll('#studioScreen *, #profileScreen *').forEach(el=>{
        if(el.offsetParent===null) return;
        const r=el.getBoundingClientRect();
        if(r.width===0) return;
        if(r.right > vw+1 || r.left < -1){
          // ignore intentional horizontal scrollers and their children
          let p=el, scroller=false;
          while(p && p!==document.body){ if(p.classList && (p.classList.contains('home-scroll')||getComputedStyle(p).overflowX==='auto'||getComputedStyle(p).overflowX==='scroll')){scroller=true;break;} p=p.parentElement; }
          if(scroller) return;
          out.push(`${el.tagName}.${(el.className&&el.className.baseVal!==undefined?el.className.baseVal:el.className||'').toString().split(' ')[0]}#${el.id} L${Math.round(r.left)} R${Math.round(r.right)} W${Math.round(r.width)}`);
        }
      });
      return {list:[...new Set(out)].slice(0,20), docScrollW: document.documentElement.scrollWidth, bodyScrollW: document.body.scrollWidth, vw};
    }, w);
    await page.click('#homeScreen [data-app-tab="Studio"]'); await page.waitForTimeout(900);
    for (const f of ['All','Dumps','Edits','Templates','Moodboards']) {
      await page.click(`[data-studio-filter="${f}"]`); await page.waitForTimeout(300);
      const o = await overflow();
      if (o.list.length || o.docScrollW>w) console.log(`${w}x${h} STUDIO ${f}`, JSON.stringify(o));
    }
    await page.screenshot({path:`${SS}studio-${w}.png`, fullPage:false});
    await page.evaluate(()=>document.querySelector('#studioContent').scrollTo(0,99999)); await page.waitForTimeout(400);
    await page.screenshot({path:`${SS}studio-${w}-bottom.png`});
    await page.click('#studioScreen [data-app-tab="Profile"]'); await page.waitForTimeout(1000);
    console.log(`${w}x${h} PROFILE`, JSON.stringify(await overflow()));
    await page.screenshot({path:`${SS}profile-${w}.png`});
    await page.evaluate(()=>document.querySelector('#profileContent').scrollTo(0,99999)); await page.waitForTimeout(400);
    await page.screenshot({path:`${SS}profile-${w}-bottom.png`});
    await page.click('#profilePlus'); await page.waitForTimeout(600);
    const pw = await page.evaluate(()=>{const s=document.querySelector('.profile-sheet');const r=s.getBoundingClientRect();return {y:Math.round(r.y),h:Math.round(r.height),sh:s.scrollHeight,ch:s.clientHeight,vh:window.innerHeight, ctaVisible: (()=>{const b=document.querySelector('#profileStartTrial').getBoundingClientRect();return b.bottom<=window.innerHeight+1;})(), noteBottom: Math.round(document.querySelector('.profile-trial-note').getBoundingClientRect().bottom)};});
    console.log(`${w}x${h} PAYWALL`, JSON.stringify(pw));
    await page.screenshot({path:`${SS}paywall-${w}.png`});
  } catch(e){ console.log('ERR',w,e.message.split('\n')[0]); }
  console.log(`--- LOGS ${w} ---`, [...new Set(logs())].join(' | '));
  await browser.close();
}
