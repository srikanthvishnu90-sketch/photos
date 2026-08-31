// Grade schema v2 — acceptance eval for the FILTER_GRADES recipes.
// Pure data validation (no DOM), so it runs anywhere:
//   node tool/grade-eval.mjs
// Guards the invariants the looks depend on: every value in range, every HSL
// band real, curves monotonic in x and spanning the full range, film params
// sane, and — the two craft rules — skin protected and no flat tint on the
// re-authored looks.
import { FILTER_GRADES, HSL_BANDS } from "../gems-canvas.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
};

const ADJUST_RANGE = [-100, 100];
const BAND_KEYS = new Set(HSL_BANDS.map((b) => b.key));
const inRange = (v, [lo, hi]) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

// After Dark is the founder's transcribed Lightroom recipe and is deliberately
// exempt from the v2 rules — it is the reference, not a re-authored look.
const LEGACY = new Set(["after-dark"]);

console.log(`Grade schema v2 — ${FILTER_GRADES.length} looks\n`);

for (const g of FILTER_GRADES) {
  const n = g.key;
  ok(`${n}: has key+label`, typeof g.key === "string" && typeof g.label === "string");

  for (const [k, v] of Object.entries(g.adjust || {})) {
    ok(`${n}: adjust.${k} in range`, inRange(v, ADJUST_RANGE), `got ${v}`);
  }

  for (const [band, adj] of Object.entries(g.hsl || {})) {
    ok(`${n}: hsl.${band} is a real band`, BAND_KEYS.has(band));
    for (const [k, v] of Object.entries(adj || {})) {
      ok(`${n}: hsl.${band}.${k} in range`, inRange(v, ADJUST_RANGE), `got ${v}`);
      ok(`${n}: hsl.${band}.${k} is h|s|l`, ["h", "s", "l"].includes(k));
    }
  }

  if (g.curve) {
    for (const [ch, pts] of Object.entries(g.curve)) {
      ok(`${n}: curve.${ch} is a valid channel`, ["luma", "r", "g", "b"].includes(ch));
      ok(`${n}: curve.${ch} has >=2 points`, Array.isArray(pts) && pts.length >= 2);
      ok(`${n}: curve.${ch} spans 0..255`, pts[0][0] === 0 && pts[pts.length - 1][0] === 255,
        `${pts[0][0]}..${pts[pts.length - 1][0]}`);
      let monotonic = true, bounded = true;
      for (let i = 0; i < pts.length; i += 1) {
        const [x, y] = pts[i];
        if (!inRange(x, [0, 255]) || !inRange(y, [0, 255])) bounded = false;
        if (i && x <= pts[i - 1][0]) monotonic = false;
      }
      ok(`${n}: curve.${ch} x strictly increasing`, monotonic);
      ok(`${n}: curve.${ch} points in 0..255`, bounded);
    }
  }

  if (g.grade3) {
    for (const [zone, z] of Object.entries(g.grade3)) {
      if (zone === "balance") { ok(`${n}: grade3.balance in range`, inRange(z, ADJUST_RANGE)); continue; }
      ok(`${n}: grade3.${zone} is a real zone`, ["shadows", "midtones", "highlights"].includes(zone));
      if (z.h != null) ok(`${n}: grade3.${zone}.h is a hue`, inRange(z.h, [0, 360]), `got ${z.h}`);
      if (z.s != null) ok(`${n}: grade3.${zone}.s in 0..100`, inRange(z.s, [0, 100]), `got ${z.s}`);
      if (z.l != null) ok(`${n}: grade3.${zone}.l in range`, inRange(z.l, ADJUST_RANGE), `got ${z.l}`);
    }
  }

  if (g.film?.grain) {
    const gr = g.film.grain;
    ok(`${n}: film.grain.amount in 0..100`, inRange(gr.amount, [0, 100]), `got ${gr.amount}`);
    if (gr.shadowBias != null) ok(`${n}: film.grain.shadowBias in 0..1`, inRange(gr.shadowBias, [0, 1]));
    if (gr.chroma != null) ok(`${n}: film.grain.chroma in 0..1`, inRange(gr.chroma, [0, 1]));
  }
  if (g.film?.halation) {
    const ha = g.film.halation;
    ok(`${n}: film.halation.knee in 0..1`, inRange(ha.knee, [0, 1]), `got ${ha.knee}`);
    ok(`${n}: film.halation.radius in 1..100`, inRange(ha.radius, [1, 100]), `got ${ha.radius}`);
    ok(`${n}: film.halation.strength in 0..100`, inRange(ha.strength, [0, 100]), `got ${ha.strength}`);
    if (ha.hue) {
      ok(`${n}: film.halation.hue is 3 weights`, Array.isArray(ha.hue) && ha.hue.length === 3);
      ok(`${n}: film.halation.hue is red-dominant`, ha.hue[0] >= ha.hue[1] && ha.hue[0] >= ha.hue[2],
        "halation is red-weighted by physics");
    }
  }

  if (!LEGACY.has(n)) {
    // Craft rule 1 — no flat full-frame tint on a re-authored look.
    ok(`${n}: no flat tint`, !g.tint, "colour belongs in grade3, not a wash");
    // Craft rule 2 — skin protected. The orange band carries skin; a hard push
    // there is how a look wrecks a face.
    const o = g.hsl?.orange || {};
    ok(`${n}: skin protected (orange |s| <= 14)`, Math.abs(o.s || 0) <= 14, `got ${o.s}`);
    ok(`${n}: skin protected (orange |h| <= 8)`, Math.abs(o.h || 0) <= 8, `got ${o.h}`);
    // Craft rule 3 — a look is a recipe, not four numbers. An empty object is
    // not a layer: `film: {}` must not count toward the total.
    const nonEmpty = (v) => !!v && typeof v === "object" && Object.keys(v).length > 0;
    const layers = ["adjust", "curve", "hsl", "grade3", "film"].filter((k) => nonEmpty(g[k])).length;
    ok(`${n}: is a real recipe (>=4 non-empty layers)`, layers >= 4, `${layers} layers`);
  }
}

// ---------------------------------------------------------------------------
// Alias hygiene. Aliases are the vibe vocabulary: they feed matchNamedGrade()
// in the editor and matchGrade() in gems-edit-intent, and matchGrade runs
// BEFORE the content-edit check — so a place-word alias would hijack
// "put me on a beach" into a grade instead of a generative edit.
// ---------------------------------------------------------------------------
const PLACE_WORDS = [
  "beach", "ocean", "sea", "club", "bar", "gym", "street", "city", "pool",
  "yacht", "boat", "car", "hotel", "villa", "desert", "mountain", "dubai",
  "paris", "amalfi", "santorini", "mediterranean", "restaurant", "office",
];
const seen = new Map();
for (const g of FILTER_GRADES) {
  for (const a of g.aliases || []) {
    const t = String(a).toLowerCase().trim();
    ok(`alias "${t}" is at least 4 chars`, t.length >= 4);
    ok(`alias "${t}" is unique across looks`, !seen.has(t), `also on ${seen.get(t)}`);
    seen.set(t, g.key);
    // English noun phrases are head-final, so it is the LAST word that decides
    // whether the alias names a place or describes a look: "dark gym" is a
    // place ("put me in a dark gym" would be hijacked into a grade), while
    // "club lighting" is a look and safely means the nightlife grade.
    const head = t.split(/\s+/).pop();
    ok(`alias "${t}" names a look, not a place`, !PLACE_WORDS.includes(head),
      PLACE_WORDS.includes(head) ? `"${head}" in head position would hijack a content edit` : "");
  }
}
ok("every look carries aliases", FILTER_GRADES.every((g) => (g.aliases || []).length >= 3),
  "the vibe vocabulary is how a described look reaches the free on-device path");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
