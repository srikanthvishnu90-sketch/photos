// Browser render + physics acceptance test for the grade engine.
//   cd ~/assigno && node grade-render-test.mjs
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;
const srv = spawn("python3", ["-m", "http.server", "8111", "--bind", "127.0.0.1"], { cwd: ROOT, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto("http://127.0.0.1:8111/tool/grade-render-test.html", { waitUntil: "networkidle" });
const res = await page.evaluate(() => window.__run());
await browser.close();
srv.kill();

let fail = 0;
const check = (n, c, d) => { if (c) console.log(`  ok   ${n}${d ? " — " + d : ""}`); else { fail++; console.log(`  FAIL ${n} — ${d}`); } };

console.log("PHYSICS (each pass in isolation)\n");
const g = res.physics.grain;
check("grain is luminance-dependent (shadow > mid > high)",
  g.shadow > g.mid && g.mid > g.high, `variance ${g.shadow} / ${g.mid} / ${g.high}`);
check("grain dies out in the speculars", g.high < g.shadow * 0.3, `high ${g.high} vs shadow ${g.shadow}`);

for (const name of ["red", "magenta"]) {
  const h = res.physics[`halation_${name}`];
  // Compare the same annulus with and without the pass. (A far-field reference
  // is invalid here: the test background is a gradient, so a wider ring sits on
  // a different base tone.) In isolation nothing else touches the frame, so any
  // gain in this ring is the bloom.
  const ringGainR = h.ringR - h.baseRingR;
  const ringGainB = h.ringB - h.baseRingB;
  check(`halation (${name}) blooms locally around the highlight`, ringGainR > 4,
    `ring gained ${ringGainR.toFixed(1)} red`);
  check(`halation (${name}) is red-weighted`, ringGainR > ringGainB * 1.4,
    `red +${ringGainR.toFixed(1)} vs blue +${ringGainB.toFixed(1)}`);
  const prof = h.profile.map((p, i) => (p && h.baseProfile[i] ? +(p[0] - h.baseProfile[i][0]).toFixed(1) : null));
  console.log(`       red gain by distance from the highlight edge (6px bins): ${prof.join("  ")}`);
}

const t = res.physics.threeWay;
const shadowShift = (t.shadowRGB[2] - t.baseShadowRGB[2]) - (t.shadowRGB[0] - t.baseShadowRGB[0]);
const highShift = (t.highRGB[0] - t.baseHighRGB[0]) - (t.highRGB[2] - t.baseHighRGB[2]);
check("three-way cools the shadows", shadowShift > 3, `blue-over-red +${shadowShift.toFixed(1)}`);
check("three-way warms the highlights", highShift > 3, `red-over-blue +${highShift.toFixed(1)}`);
check("three-way leaves the two zones opposed", shadowShift > 0 && highShift > 0,
  "warm highlights against cool shadows is the whole point");

console.log("\nLOOKS\n");
const b = res.base;
for (const [key, s] of Object.entries(res.looks)) {
  if (s.error) { console.log(`${key}: ${s.error}`); fail++; continue; }
  console.log(`${key.padEnd(16)} diff=${String(s.diff).padStart(6)}  mean=[${s.mean.join(", ")}]  ${s.ms}ms  ${(s.bytes / 1024).toFixed(0)}kB`);
  if (s.bytes <= 1000) { fail++; console.log(`  FAIL ${key} produced no image`); }
  // Mean-absolute per-pixel difference: a symmetric curve holds the mean steady
  // while changing every pixel, so difference-of-means is the wrong test.
  if (!(s.diff > 2)) { fail++; console.log(`  FAIL ${key} barely changed the frame — diff ${s.diff}`); }
  if (s.ms > 400) { fail++; console.log(`  FAIL ${key} too slow — ${s.ms}ms`); }
}

console.log(`\nconsole errors: ${errors.length}`);
errors.slice(0, 5).forEach((e) => console.log("  " + e));
console.log(fail ? `\n${fail} FAILURES` : "\nALL PASS");
process.exit(fail || errors.length ? 1 : 0);
