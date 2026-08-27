// Edit Interpreter v2 — acceptance eval for the LOCAL deterministic path.
// Runs the 12 spec cases against localInterpret + pure helpers. Model-only cases
// (scenario / real-person / dangerous placement) correctly DEFER to the model
// here (localInterpret returns null); those are validated live against the
// interpret-edit function when a session token is available.
//   run:  node tool/edit-interpreter-eval.mjs
import {
  localInterpret, magnitudeFor, zoomInRetain, zoomOutGrow, cropRectFor, hasEditOp,
} from "../gems-edit-interpreter.js";
import { matchNamedGrade } from "../gems-canvas.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${detail}`); }
};
const engines = (r) => (r?.plan ?? []).map((s) => s.engine);
const ops = (r) => (r?.plan ?? []).map((s) => s.op);
const noGenerative = (r) => engines(r).every((e) => e === "client");

console.log("Edit Interpreter v2 — local acceptance eval\n");

// 1 — zoom in just a little → crop retain 88–92%, subject, ZERO generative
{
  const r = localInterpret("zoom in just a little");
  const c = r?.plan?.find((s) => s.op === "crop");
  ok("1 zoom-in-little: crop op", !!c);
  ok("1 retain 0.88–0.92", c && c.params.retain >= 0.88 && c.params.retain <= 0.92, `retain=${c?.params.retain}`);
  ok("1 subject-centered", c?.params.center === "subject");
  ok("1 ZERO generative", noGenerative(r), engines(r).join(","));
}

// 2 — zoom out → expand +~30%, generative
{
  const r = localInterpret("zoom out");
  const e = r?.plan?.find((s) => s.op === "expand");
  ok("2 expand op, generative", e && e.engine === "generative");
  ok("2 grow ~0.30", e && Math.abs(e.params.grow - 0.3) < 0.06, `grow=${e?.params.grow}`);
}

// 3 — a little more (after #1) → crop again ~5% more, client
{
  const session = { ops: [{ op: "crop", params: { retain: 0.9, center: "subject" } }] };
  const r = localInterpret("a little more", session);
  const c = r?.plan?.find((s) => s.op === "crop");
  ok("3 crop again", !!c);
  ok("3 ~5% additional (retain ~0.95)", c && Math.abs(c.params.retain - 0.95) < 0.02, `retain=${c?.params.retain}`);
  ok("3 ZERO generative", noGenerative(r));
}

// 4 — too much, go back a bit (after #2 expand) → undo + reduced re-run
{
  const session = { ops: [{ op: "expand", params: { grow: 0.3 } }] };
  const r = localInterpret("too much, go back a bit", session);
  ok("4 has undo", ops(r).includes("undo"), ops(r).join(","));
  const e = r?.plan?.find((s) => s.op === "expand");
  ok("4 reduced expand ~0.15", e && Math.abs(e.params.grow - 0.15) < 0.05, `grow=${e?.params.grow}`);
}

// 5 — scenario → DEFER to model (localInterpret returns null)
{
  const r = localInterpret("put me at the top of the burj khalifa staring down");
  ok("5 scenario defers to model", r === null);
}

// 6 — zoom in a bit and make it warmer → crop ~78–82% + warmth +~20, both client
{
  const r = localInterpret("zoom in a bit and make it warmer");
  const c = r?.plan?.find((s) => s.op === "crop");
  const a = r?.plan?.find((s) => s.op === "adjust");
  ok("6 two ops (crop+adjust)", !!c && !!a, ops(r).join(","));
  ok("6 crop ~0.78–0.82", c && c.params.retain >= 0.77 && c.params.retain <= 0.83, `retain=${c?.params.retain}`);
  ok("6 warmth ~+20", a && Math.abs((a.params.warmth ?? 0) - 20) <= 6, `warmth=${a?.params.warmth}`);
  ok("6 ZERO generative", noGenerative(r), engines(r).join(","));
}

// 7 — make the sky bluer but keep everything else → local_adjust sky, NOT global/generative
{
  const r = localInterpret("make the sky bluer but keep everything else");
  const la = r?.plan?.find((s) => s.op === "local_adjust");
  ok("7 local_adjust op", !!la, ops(r).join(","));
  ok("7 target sky", la?.params.target === "sky");
  ok("7 not global adjust", !ops(r).includes("adjust"));
  ok("7 client (not generative repaint)", noGenerative(r));
}

// 8 — crop to 4:5 → crop exact ratio, client
{
  const r = localInterpret("crop to 4:5");
  const c = r?.plan?.find((s) => s.op === "crop");
  ok("8 crop op", !!c);
  ok("8 aspect 4:5", c?.params.aspect === "4:5");
  ok("8 ZERO generative", noGenerative(r));
}

// 9 — make it pop → adjust (contrast+vibrance ~30–40) OR clarify
{
  const r = localInterpret("make it pop");
  const a = r?.plan?.find((s) => s.op === "adjust");
  ok("9 adjust op", !!a, ops(r).join(","));
  ok("9 contrast+vibrance present", a && a.params.contrast > 0 && a.params.vibrance > 0, JSON.stringify(a?.params));
  ok("9 magnitudes ~30–40", a && a.params.contrast >= 25 && a.params.contrast <= 45, `c=${a?.params.contrast}`);
}

// 10 — put my ex in this photo → DEFER (model refuses a real other person)
{
  const r = localInterpret("put my ex in this photo");
  ok("10 defers to model (refusal there)", r === null);
}

// 11 — dangerous placement → DEFER (model substitutes safe vantage)
{
  const r = localInterpret("put me hanging off the edge of the eiffel tower");
  ok("11 defers to model (safe substitution)", r === null);
}

// 12 — rotate it like 5 degrees left → rotate -5, client
{
  const r = localInterpret("rotate it like 5 degrees left");
  const rot = r?.plan?.find((s) => s.op === "rotate");
  ok("12 rotate op", !!rot, ops(r).join(","));
  ok("12 degrees -5", rot?.params.degrees === -5, `deg=${rot?.params.degrees}`);
  ok("12 ZERO generative", noGenerative(r));
}

// Pure helper spot-checks
console.log("\n  pure helpers");
ok("magnitude 'slightly' small", magnitudeFor("slightly") <= 0.1);
ok("magnitude 'way more' large", magnitudeFor("way more") >= 0.45);
ok("zoomInRetain 'just a little' 0.9", zoomInRetain("just a little") === 0.9);
ok("zoomOutGrow 'whole room' big", zoomOutGrow("show the whole room") >= 0.6);
{
  // crop rect: retain 0.5 centered on subject at (0.25,0.25) box
  const rect = cropRectFor({ retain: 0.5, center: "subject" }, 1000, 1000, { x: 0.1, y: 0.1, w: 0.3, h: 0.3 });
  ok("cropRect size 500x500", rect.w === 500 && rect.h === 500, JSON.stringify(rect));
  ok("cropRect clamped in-bounds", rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= 1000, JSON.stringify(rect));
}
{
  // crop rect with aspect 1:1 from a 1000x800 retain 1 → 800x800
  const rect = cropRectFor({ retain: 1, aspect: "1:1", center: "center" }, 1000, 800);
  ok("cropRect 1:1 → 800x800", rect.w === 800 && rect.h === 800, JSON.stringify(rect));
}

// Named looks — the on-device fast path. A look the app already owns must match
// (aliases and comparatives included), tonal words must NOT, and a compound ask
// must leave the rest of the instruction behind for the interpreter to finish.
console.log("\n  named looks (fast path)");
{
  const hits = [
    ["make it moodier", "after-dark"],
    ["after dark", "after-dark"],
    ["give it that moody look", "after-dark"],
    ["golden hour please", "golden-hour"],
    ["make it dark gym", "dark-gym"],
    ["clean editorial", "clean-editorial"],
    ["make it look like film", "film"],
  ];
  for (const [text, key] of hits) {
    const m = matchNamedGrade(text);
    ok(`named '${text}' → ${key}`, m?.grade.key === key, `got ${m?.grade.key ?? "null"}`);
  }
  // Tonal words own the slider path — a grade must never swallow them.
  for (const text of ["brighter", "make it darker", "warmer", "more contrast", "set the mood"]) {
    ok(`tonal '${text}' is NOT a named look`, matchNamedGrade(text) === null,
      `got ${matchNamedGrade(text)?.grade.key}`);
  }
  // Longest name wins over a shorter alias inside it.
  ok("'dark gym' beats 'dark' aliases", matchNamedGrade("shoot it dark gym")?.grade.key === "dark-gym");
}

// The compound guard: whatever is LEFT after the look's name is removed decides
// whether the grade alone finished the job.
console.log("\n  compound instructions");
{
  const cases = [
    ["make it moodier", false],
    ["after dark", false],
    ["golden hour vibes", false],
    ["remove the guy in the background and make it moodier", true],
    ["crop it square and make it after dark", true],
    ["make it moodier and brighter", true],
    ["blur the background, golden hour", true],
    ["put me in tokyo, after dark", true],
  ];
  for (const [text, expected] of cases) {
    const m = matchNamedGrade(text);
    ok(`compound '${text}' → ${expected ? "rest remains" : "look only"}`,
      !!m && hasEditOp(m.rest) === expected, `rest='${m?.rest}' op=${m && hasEditOp(m.rest)}`);
  }
  // hasEditOp on its own: it is the same vocabulary localInterpret routes on.
  ok("hasEditOp('') false", hasEditOp("") === false);
  ok("hasEditOp('make it ') false", hasEditOp("make it ") === false);
  ok("hasEditOp('crop it square') true", hasEditOp("crop it square") === true);
  ok("hasEditOp('remove the sign') true", hasEditOp("remove the sign") === true);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
