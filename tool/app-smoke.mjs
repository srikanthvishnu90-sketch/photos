import { chromium } from "playwright";
import { spawn } from "node:child_process";
const ROOT = new URL("..", import.meta.url).pathname;
const srv = spawn("python3", ["-m", "http.server", "8113", "--bind", "127.0.0.1"], { cwd: ROOT, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
const b = await chromium.launch();
const p = await b.newPage();
const errs = [];
p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
p.on("pageerror", (e) => errs.push(String(e)));
await p.goto("http://127.0.0.1:8113/", { waitUntil: "networkidle" });
await p.waitForTimeout(3500);
const mods = await p.evaluate(async () => {
  try { const m = await import("/gems-canvas.js"); return { grades: m.FILTER_GRADES.length, fit: typeof m.fitForPreview }; }
  catch (e) { return { error: String(e) }; }
});
console.log("app loaded:", await p.title(), "| canvas module:", JSON.stringify(mods));
console.log("console errors:", errs.length);
errs.slice(0, 6).forEach((e) => console.log("  " + e));
await b.close(); srv.kill();
process.exit(errs.length ? 1 : 0);
