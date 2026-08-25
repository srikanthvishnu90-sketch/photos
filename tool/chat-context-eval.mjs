// Chat grounding — pure formatter eval (summarizePassA, formatLibrary).
import { summarizePassA, formatLibrary } from "../gems-chat-context.js";
let pass=0, fail=0;
const ok=(n,c,d="")=>{ if(c){pass++;console.log(`  ✓ ${n}`);} else {fail++;console.log(`  ✗ ${n} ${d}`);} };
console.log("Chat grounding — formatters\n");
ok("passA summary: smiling person", /1 person/.test(summarizePassA({people_count:1,smile:true})) && /smiling/.test(summarizePassA({people_count:1,smile:true})));
ok("passA summary: screenshot", /screenshot/.test(summarizePassA({photo_type:"screenshot",people_count:0})));
ok("passA vibe tags included", /beach/.test(summarizePassA({vibe_tags:["beach","sunset"]})));
ok("passA empty → 'a photo'", summarizePassA({})==="a photo");
ok("library empty", formatLibrary({count:0})==="The camera roll is empty.");
{ const s=formatLibrary({count:214,dateRange:{from:Date.UTC(2023,5,1),to:Date.UTC(2024,7,20)},indexed:200,people:[{name:"",isMe:true,count:88},{name:"Mom",isMe:false,count:20}]});
  ok("library has count", /214 photos/.test(s), s);
  ok("library has You + Mom", /You \(88\)/.test(s) && /Mom \(20\)/.test(s), s);
  ok("library has searchable", /200 searchable/.test(s), s);
}
console.log(`\n${fail===0?"ALL PASS":"FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail===0?0:1);
