import { chromium } from "playwright";
import { spawn } from "node:child_process";
const srv = spawn("python3", ["-m", "http.server", "8112", "--bind", "127.0.0.1"],
  { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("http://127.0.0.1:8112/tool/grade-perf-test.html", { waitUntil: "networkidle" });
console.log("full-res / capped-preview per look\n");
for (const [w, h] of [[1200, 900], [2048, 1536], [4032, 3024]]) {
  const r = await page.evaluate(([w, h]) => window.__perf(w, h), [w, h]);
  const mp = ((w * h) / 1e6).toFixed(1);
  console.log(`${w}x${h} (${mp}MP)`.padEnd(22) +
    Object.entries(r).map(([k, v]) => `${k}=${v.ms}/${v.preview}ms${v.ok ? "" : " FAILED"}`).join("  "));
}
await browser.close(); srv.kill();
