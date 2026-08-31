// Grade-engine regression test: renders every look through a PAST version of
// gems-canvas.js and the current one, and reports the per-pixel difference.
//   node tool/regression-test.mjs [git-ref]        (default: the v2 commit's parent)
//
// after-dark must come back bit-identical — it is the founder's transcribed
// Lightroom recipe and the reference the other looks were brought up to, so a
// silent change to it would be a real regression.
import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";

const REF = process.argv[2] || "f0a3de0~1";
const ROOT = new URL("..", import.meta.url).pathname;
const SNAP = `${ROOT}tool/_gems-canvas-prev.js`;
writeFileSync(SNAP, execFileSync("git", ["show", `${REF}:gems-canvas.js`], { cwd: ROOT, maxBuffer: 1 << 24 }));
console.log(`comparing HEAD against ${REF}\n`);
const srv = spawn("python3", ["-m", "http.server", "8114", "--bind", "127.0.0.1"],
  { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
const b = await chromium.launch();
const p = await b.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(String(e)));
await p.goto("http://127.0.0.1:8114/tool/regression-test.html", { waitUntil: "networkidle" });
const r = await p.evaluate(() => window.__cmp());
await b.close(); srv.kill();
try { unlinkSync(SNAP); } catch {}
let fail = 0;
for (const [k, v] of Object.entries(r)) {
  console.log(`${k.padEnd(16)} ${v.note || `meanDiff=${v.meanDiff}  maxDiff=${v.maxDiff}`}`);
}
const ad = r["after-dark"];
if (!ad || ad.maxDiff !== 0) { fail++; console.log(`\nFAIL after-dark changed — maxDiff ${ad?.maxDiff}`); }
else console.log("\nok  after-dark is pixel-identical to the pre-v2 engine");
errs.forEach((e) => { fail++; console.log("pageerror: " + e); });
process.exit(fail ? 1 : 0);
