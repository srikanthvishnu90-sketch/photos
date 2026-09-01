// style-parity-eval — every on-device look must have an AI-side definition, and
// the two must be reachable by the same words.
//
// Only after-dark used to have one, so asking the model for "Film" got a generic
// interpretation while the canvas had a precise six-layer recipe. The two paths
// disagreed about what the look meant, silently, depending on which one you hit.
//
//   node tool/style-parity-eval.mjs
import { readFileSync } from "node:fs";
import { FILTER_GRADES } from "../gems-canvas.js";

const src = readFileSync(new URL("../supabase/functions/edit-photo/index.ts", import.meta.url), "utf8");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) pass += 1;
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
};

const block = src.match(/const NAMED_STYLES[^{]*\{([\s\S]*?)\n\};/);
if (!block) {
  console.error("PARSE FAILURE: NAMED_STYLES not found in edit-photo. This eval refuses to pass unverified.");
  process.exit(2);
}
const defined = [...block[1].matchAll(/^\s{2}"([a-z-]+)":/gm)].map((m) => m[1]);
console.log(`AI-side styles defined: ${defined.length}\n`);

for (const grade of FILTER_GRADES) {
  ok(`${grade.key}: has an AI-side style`, defined.includes(grade.key));
  // The aliases that route to a look on-device must also trigger it in the AI
  // path, or the same words give two different results depending on the route.
  const entry = block[1].match(new RegExp(`"${grade.key}":\\s*\\{\\s*triggers:\\s*/([^/]+)/`));
  if (!entry) continue;
  const re = new RegExp(entry[1], "i");
  for (const alias of grade.aliases ?? []) {
    ok(`${grade.key}: alias "${alias}" routes AI-side too`, re.test(alias));
  }
}

ok("no AI-side style exists without an on-device grade", 
  defined.every((d) => FILTER_GRADES.some((g) => g.key === d)),
  defined.filter((d) => !FILTER_GRADES.some((g) => g.key === d)).join(", "));

// Negation discipline: image models render what a prohibition names, so the
// style blocks must be written as positive assertions.
const negations = (block[1].match(/\b(do not|don't|never|no |avoid)\b/gi) ?? []).length;
ok(`style blocks stay positive (${negations} negations)`, negations <= 2,
  "image models tend to render what a prohibition names");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
