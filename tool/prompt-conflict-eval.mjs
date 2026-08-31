// Prompt conflict eval (R23/R24) — acceptance eval for the generate-scene PROMPT
// ASSEMBLY, not for any single block's wording.
//   run:  node tool/prompt-conflict-eval.mjs
//
// WHY THIS EXISTS. generate-scene builds one prompt out of 23 instruction blocks
// whose emission is conditional on mode, subject, references, and whether the
// chosen reference carries a measured shot_spec. Two instructions that overlap do
// not AVERAGE — the model picks one, silently, and the losing instruction is
// simply gone. This has already cost us twice:
//
//   1. FRAMING ("medium-to-wide, person fills a third") shipped alongside
//      ENVIRONMENT_MATCH_BLOCK ("match the reference's EXACT camera distance").
//      Fixed by suppressing FRAMING when an environment ref is attached.
//   2. COMPOSITION_DNA (a universal compositional ideal) shipped alongside the
//      spec-derived composition block (measured from the actual reference).
//      First fixed by gating on `!specComposition` — which was vacuous while no
//      reference carried a measured spec, so the generic lens kept shipping next
//      to ENV_MATCH's exact-framing instruction on every pack generation. Now
//      gated on `!envRefB64`, the same gate as FRAMING.
//
// R24: never add an instruction block without reconciling the ones it overlaps.
// This eval is the enforcement. It parses the real function source, enumerates
// every realistic input combination, computes the exact SET of blocks emitted for
// each, and checks that set against an explicit conflict table.
//
// It is deliberately paranoid about its own parser: a regex that silently matches
// nothing would turn this file into a green light that checks nothing, so every
// block it expects must be found, and the promptText expression's identifier set
// must match this file's model EXACTLY. Add a block to index.ts without adding it
// here and this eval fails at parse time, before it can pretend to pass.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_PATH = join(HERE, "..", "supabase", "functions", "generate-scene", "index.ts");

let pass = 0, fail = 0, warn = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
};
const warned = (name, detail = "") => { warn += 1; console.log(`  WARN  ${name}${detail ? " — " + detail : ""}`); };
/** A pair marked `resolved` must stay resolved — asserted by content, not co-occurrence. */
const RESOLVED_ASSERTIONS = [
  ["REALISM", /\bLANDSCAPE\b/i,
    "REALISM_LAYER prescribes a LANDSCAPE orientation again; the aspect tail forces vertical, so it can never be honoured."],
];

const die = (msg) => { console.error(`\nPARSE FAILURE: ${msg}\n\nThis eval refuses to report a pass it did not actually verify.`); process.exit(2); };

const src = readFileSync(SRC_PATH, "utf8");
if (src.length < 10000) die(`${SRC_PATH} is only ${src.length} bytes — that is not the real function`);

// ---------------------------------------------------------------------------
// Parser. Reads the actual block text out of index.ts. Fails loudly, never
// silently: a missing block is a hard exit, not an empty string.
// ---------------------------------------------------------------------------

/** Read the string literal (backtick or double-quote) that starts at index i. */
function readStringLiteralAt(s, i) {
  const quote = s[i];
  if (quote !== "`" && quote !== '"' && quote !== "'") return null;
  let out = "";
  for (let k = i + 1; k < s.length; k += 1) {
    const ch = s[k];
    if (ch === "\\") { out += ch + s[k + 1]; k += 1; continue; }
    if (quote === "`" && ch === "$" && s[k + 1] === "{") {
      // Copy the interpolation verbatim (we want its char weight, not its value)
      // and skip past the matching brace so a `}` inside cannot end the literal.
      let depth = 1; let k2 = k + 2; out += "${";
      while (k2 < s.length && depth > 0) {
        if (s[k2] === "{") depth += 1;
        else if (s[k2] === "}") depth -= 1;
        if (depth > 0) out += s[k2];
        k2 += 1;
      }
      out += "}"; k = k2 - 1; continue;
    }
    if (ch === quote) return { text: out, end: k };
    out += ch;
  }
  return null;
}

/**
 * Comment-aware forward scan. Comments must be skipped BEFORE quotes: this file
 * is full of prose comments containing apostrophes ("the environment block's
 * instruction"), and treating one as a string opener silently swallows the rest
 * of the function — which is precisely how a parser starts lying.
 * Returns the next string literal at or after `from`, or the index at which a
 * `want` character is found in code position.
 */
function scanFrom(s, from, want) {
  let i = from;
  while (i < s.length) {
    const c = s[i];
    if (c === "/" && s[i + 1] === "/") { while (i < s.length && s[i] !== "\n") i += 1; continue; }
    if (c === "/" && s[i + 1] === "*") { i += 2; while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i += 1; i += 2; continue; }
    if (c === "`" || c === '"' || c === "'") {
      const lit = readStringLiteralAt(s, i);
      if (!lit) return { kind: "eof" };
      if (!want) return { kind: "literal", text: lit.text, start: i, end: lit.end };
      i = lit.end + 1; continue;
    }
    if (want && c === want) return { kind: "char", index: i };
    i += 1;
  }
  return { kind: "eof" };
}

/** The first string literal appearing at or after `from` (comments skipped). */
function firstLiteralAfter(from, label) {
  const r = scanFrom(src, from, null);
  if (r.kind !== "literal") die(`no string literal found after the declaration of ${label}`);
  return r.text;
}

/** Text of `const NAME = <literal>` (the literal may be a few lines below). */
function constText(name) {
  const m = new RegExp(`const\\s+${name}\\s*(?::[^=]+)?=`).exec(src);
  if (!m) die(`could not find "const ${name} = ..." in ${SRC_PATH}`);
  const text = firstLiteralAfter(m.index + m[0].length, name);
  if (!text || text.length < 40) die(`block ${name} parsed to ${text.length} chars — the parser is not seeing the real text`);
  return text;
}

/** One representative value out of a Record<string,string> map. */
function recordEntry(mapName, key) {
  const m = new RegExp(`const\\s+${mapName}\\s*:\\s*Record<string,\\s*string>\\s*=\\s*\\{`).exec(src);
  if (!m) die(`could not find the ${mapName} record`);
  const kIdx = src.indexOf(`"${key}":`, m.index);
  if (kIdx < 0) die(`${mapName} has no "${key}" entry — the packs changed; update this eval`);
  const text = firstLiteralAfter(kIdx + key.length + 3, `${mapName}["${key}"]`);
  if (text.length < 100) die(`${mapName}["${key}"] parsed to ${text.length} chars`);
  return text;
}

/**
 * The three function-generated blocks (composition/lighting from the measured
 * shot_spec, and the reference manifest) are assembled line by line at runtime,
 * so their exact text depends on the spec values. We approximate their weight by
 * concatenating every string literal in the function body. Exact for the CONFLICT
 * logic (which is pure set membership) and close enough for the char budget.
 */
function functionLiterals(fnName) {
  const m = new RegExp(`function\\s+${fnName}\\s*\\(`).exec(src);
  if (!m) die(`could not find function ${fnName}()`);
  // Walk past the parameter list first — a destructured param has braces of its
  // own, and grabbing those instead of the body is exactly the kind of silent
  // mis-parse this eval exists to refuse.
  let p = src.indexOf("(", m.index), pd = 0, afterParams = -1;
  for (let k = p; k < src.length; k += 1) {
    if (src[k] === "(") pd += 1;
    else if (src[k] === ")") { pd -= 1; if (pd === 0) { afterParams = k; break; } }
  }
  if (afterParams < 0) die(`could not parse the parameter list of ${fnName}`);
  const open = scanFrom(src, afterParams, "{");
  if (open.kind !== "char") die(`function ${fnName} has no body`);
  let i = open.index, depth = 0, end = -1, k = i;
  while (k < src.length) {
    if (src[k] === "/" && src[k + 1] === "/") { while (k < src.length && src[k] !== "\n") k += 1; continue; }
    if (src[k] === "/" && src[k + 1] === "*") { k += 2; while (k < src.length && !(src[k] === "*" && src[k + 1] === "/")) k += 1; k += 2; continue; }
    if (src[k] === "`" || src[k] === '"' || src[k] === "'") { const l = readStringLiteralAt(src, k); if (l) { k = l.end + 1; continue; } }
    if (src[k] === "{") depth += 1;
    else if (src[k] === "}") { depth -= 1; if (depth === 0) { end = k; break; } }
    k += 1;
  }
  if (end < 0) die(`could not find the end of function ${fnName}`);
  const body = src.slice(i, end);
  let out = "", cursor = 0;
  for (;;) {
    const r = scanFrom(body, cursor, null);
    if (r.kind !== "literal") break;
    out += r.text + " ";
    cursor = r.end + 1;
  }
  if (out.length < 100) die(`function ${fnName} yielded only ${out.length} chars of literal text — parser drift`);
  return out;
}

// ---------------------------------------------------------------------------
// The blocks. Key = the short name used in the matrix; text = parsed source.
// ---------------------------------------------------------------------------
const BLOCK = {
  MANIFEST:      functionLiterals("referenceManifest"),
  STYLE:         recordEntry("STYLE_PACKS", "old-money"),
  REALISM:       constText("REALISM_LAYER"),
  REALISM_REFS:  constText("realismRefBlock"),
  ENV_MATCH:     constText("ENVIRONMENT_MATCH_BLOCK"),
  ENV_MATCH_BG:  constText("ENVIRONMENT_MATCH_BG_BLOCK"),
  NO_REF:        constText("NO_REF_GROUNDING"),
  BACKGROUND:    constText("BACKGROUND_BLOCK"),
  MATCH_REF:     constText("MATCH_REFERENCE_BLOCK"),
  IDENTITY:      constText("IDENTITY_BLOCK"),
  FACE_FID:      constText("FACE_FIDELITY"),
  FACE_REAL:     constText("FACE_REALISM"),
  MODESTY:       constText("MODESTY"),
  COMP_DNA:      constText("COMPOSITION_DNA"),
  SPEC_COMP:     functionLiterals("compositionFromSpec"),
  SPEC_LIGHT:    functionLiterals("lightingFromSpec"),
  FRAMING:       constText("FRAMING"),
  BUILD:         constText("buildBlock"),
  WARDROBE:      constText("wardrobeBlock"),
  AUTO_WARDROBE: constText("autoWardrobeBlock") + " " + recordEntry("PACK_WARDROBE", "old-money"),
  POSE:          constText("poseBlock"),
  CANDID_POSE:   constText("candidDefaultBlock"),
  ASPECT_TAIL:   constText("NEGATIVE"),
};

console.log(`Prompt conflict eval — parsed ${Object.keys(BLOCK).length} instruction blocks from generate-scene/index.ts\n`);

// ---------------------------------------------------------------------------
// Anti-drift guard. Parse the `const promptText = ...` expression and require
// its identifier set to match this file's model EXACTLY. If someone appends a
// new block to the prompt without teaching this eval about it, we fail here —
// which is the entire point of R24.
// ---------------------------------------------------------------------------
{
  const start = src.indexOf("const promptText =");
  if (start < 0) die("could not find the `const promptText =` assembly expression");
  const stop = src.indexOf("parts.push({ text: promptText })", start);
  if (stop < 0) die("could not find the end of the promptText assembly");
  const expr = src.slice(start, stop);
  // Strip string literals and comments so we only see identifiers — but KEEP the
  // code inside `${...}` interpolations, because that is where half the blocks
  // (REALISM_LAYER, FRAMING, MODESTY...) are actually referenced.
  const interpCode = (lit) => {
    let out = "";
    for (let k = 0; k < lit.length; k += 1) {
      if (lit[k] === "$" && lit[k + 1] === "{") {
        let depth = 1, k2 = k + 2;
        while (k2 < lit.length && depth > 0) {
          if (lit[k2] === "{") depth += 1;
          else if (lit[k2] === "}") { depth -= 1; if (!depth) break; }
          out += lit[k2]; k2 += 1;
        }
        out += " "; k = k2;
      }
    }
    return out;
  };
  // Comments FIRST — the assembly is heavily commented and those comments name
  // the very identifiers we are checking for ("Gating this on `!specComposition`
  // was wrong..."), so counting them would mask a real removal.
  let code = "", k = 0;
  while (k < expr.length) {
    if (expr[k] === "/" && expr[k + 1] === "/") { while (k < expr.length && expr[k] !== "\n") k += 1; continue; }
    if (expr[k] === "/" && expr[k + 1] === "*") { k += 2; while (k < expr.length && !(expr[k] === "*" && expr[k + 1] === "/")) k += 1; k += 2; continue; }
    if (expr[k] === "`" || expr[k] === '"' || expr[k] === "'") {
      const l = readStringLiteralAt(expr, k);
      if (l) { code += " " + interpCode(l.text) + " "; k = l.end + 1; continue; }
    }
    code += expr[k]; k += 1;
  }
  const idents = new Set((code.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []).filter((w) => !["const", "length"].includes(w)));
  // Everything the assembly is allowed to mention: the blocks it appends plus
  // the flags it branches on plus the two plain interpolations.
  const EXPECTED = new Set([
    "promptText", "prompt", "aspect",                       // literal interpolations
    "hasSubject", "envRefB64", "specComposition",            // branch conditions
    // `refIds` (what the caller asked for) was replaced in the assembly by
    // `attachedUserRefs` (what actually downloaded) — see UNGROUNDED/PHANTOM-REF.
    "attachedUserRefs", "recreatingReference",
    "manifestBlock", "styleBlock", "REALISM_LAYER", "realismRefBlock", "envRefBlock",
    "NO_REF_GROUNDING", "identityBlock", "FACE_FIDELITY", "FACE_REALISM", "MODESTY",
    "COMPOSITION_DNA", "specLighting", "FRAMING", "buildBlock", "wardrobeBlock",
    "autoWardrobeBlock", "poseBlock", "candidDefaultBlock", "NEGATIVE",
  ]);
  const extra = [...idents].filter((i) => !EXPECTED.has(i));
  const missing = [...EXPECTED].filter((i) => !idents.has(i));
  if (extra.length) die(`promptText mentions ${extra.join(", ")} — new block(s) added to the prompt that this eval does not model. Add them to BLOCK, to emit(), and reconcile them in CONFLICTS (R24).`);
  if (missing.length) die(`promptText no longer mentions ${missing.join(", ")} — the assembly was restructured; this eval's model is stale.`);
  ok("promptText assembly matches this eval's block model", true);
}

// Sanity: the two blocks whose collision started all this must still be the
// blocks we think they are. A rename that slipped past constText() would leave
// the conflict table pointing at nothing.
ok("FRAMING really is the distance instruction", /medium-to-wide/i.test(BLOCK.FRAMING) && /NOT fill the frame/i.test(BLOCK.FRAMING));
ok("ENV_MATCH really is the exact-framing instruction", /SAME CAMERA DISTANCE|same CAMERA DISTANCE/i.test(BLOCK.ENV_MATCH));
ok("COMP_DNA really is the universal composition ideal", /RULE OF THIRDS/i.test(BLOCK.COMP_DNA));
ok("MATCH_REF really is the recreate-the-reference instruction", /composition, camera angle, framing/i.test(BLOCK.MATCH_REF));
ok("SPEC_COMP really is the measured composition block", /MEASURED FROM THE ATTACHED ENVIRONMENT REFERENCE/i.test(BLOCK.SPEC_COMP));
ok("CANDID_POSE really is the non-negotiable pose", /NON-NEGOTIABLE/i.test(BLOCK.CANDID_POSE));

// ---------------------------------------------------------------------------
// THE CONFLICT TABLE. Pairs of blocks that must never appear in one prompt.
// severity "error" fails the run; "warn" is reported but does not, and is used
// for pairs where the overlap is real but one side is a standing property of
// the prompt rather than a regression a change could introduce.
// ---------------------------------------------------------------------------
const CONFLICTS = [
  // --- the two that already burned us (both now guarded; these are regression locks)
  ["FRAMING", "ENV_MATCH", "error",
    "FRAMING dictates medium-to-wide/person-fills-a-third; ENV_MATCH dictates the reference's EXACT camera distance. Two distance instructions do not average."],
  ["FRAMING", "SPEC_COMP", "error",
    "Same collision one layer down: SPEC_COMP states a measured camera distance and subject frame fraction; FRAMING states a generic one."],
  ["COMP_DNA", "SPEC_COMP", "error",
    "COMP_DNA is a universal compositional ideal; SPEC_COMP is measured from the actual reference. The measurement must win uncontested."],
  ["COMP_DNA", "ENV_MATCH", "error",
    "The wider form of the same bug: ENV_MATCH already says 'match the composition and framing EXACTLY', so the generic lens must be off whenever ANY environment reference is attached, not merely when a measured spec happens to exist."],

  // --- the same class of conflict on the match-reference (face-swap) path
  ["FRAMING", "MATCH_REF", "error",
    "MATCH_REF says match the reference's framing and distance exactly; FRAMING overrides that with a generic medium-to-wide."],
  ["COMP_DNA", "MATCH_REF", "error",
    "MATCH_REF says reproduce the reference's composition; COMP_DNA prescribes rule-of-thirds, off-centre, subject-small instead."],
  ["CANDID_POSE", "MATCH_REF", "error",
    "MATCH_REF says match the reference's pose; CANDID_POSE calls its between-takes pose NON-NEGOTIABLE. One of them is going to lose."],

  // --- reference-source conflicts: two different images claimed as the anchor
  ["ENV_MATCH", "NO_REF", "error",
    "NO_REF tells the model to INVENT the location; ENV_MATCH tells it to reproduce an attached one."],
  ["ENV_MATCH_BG", "NO_REF", "error", "Same, background mode."],
  ["MATCH_REF", "NO_REF", "error",
    "NO_REF says no setting reference is attached; MATCH_REF says recreate the attached reference."],
  ["ENV_MATCH", "MATCH_REF", "error",
    "Two different attached images each declared 'the' reference to reproduce."],
  ["ENV_MATCH", "REALISM_REFS", "error",
    "Both name the capture-quality target, from different images — and both say 'the LAST/FINAL attached photo(s)', so the positional language collides too."],
  ["ENV_MATCH_BG", "REALISM_REFS", "error", "Same, background mode."],
  ["ENV_MATCH", "ENV_MATCH_BG", "error",
    "The with-person and empty-scene variants of the same block."],

  // --- background mode must not carry any person instruction
  ["BACKGROUND", "IDENTITY", "error", "BACKGROUND says no human figures at all."],
  ["BACKGROUND", "FACE_FID", "error", "No face exists to be faithful to."],
  ["BACKGROUND", "FACE_REAL", "error", "No face exists."],
  ["BACKGROUND", "MODESTY", "error", "Nobody to dress."],
  ["BACKGROUND", "FRAMING", "error", "FRAMING frames a person; there is none."],
  ["BACKGROUND", "COMP_DNA", "error", "COMP_DNA places a person in the frame."],
  ["BACKGROUND", "BUILD", "error", "No body to keep honest."],
  ["BACKGROUND", "WARDROBE", "error", "Nobody to dress."],
  ["BACKGROUND", "AUTO_WARDROBE", "error", "Nobody to dress."],
  ["BACKGROUND", "POSE", "error", "Nobody to pose."],
  ["BACKGROUND", "CANDID_POSE", "error", "Nobody to pose."],
  ["BACKGROUND", "ENV_MATCH", "error",
    "ENV_MATCH's person-bearing variant instructs placing the user in the frame; BACKGROUND forbids any person."],
  ["ENV_MATCH_BG", "IDENTITY", "error",
    "ENV_MATCH_BG removes every person from the scene; IDENTITY inserts one."],

  // --- mutually-exclusive-by-construction pairs. Not conflicts of instruction so
  //     much as invariants: if both ever appear, a refactor broke the ternary.
  ["WARDROBE", "AUTO_WARDROBE", "error", "The explicit outfit and the auto-chosen outfit are alternatives, not a stack."],
  ["POSE", "CANDID_POSE", "error", "Same: the requested pose and the default candid pose are alternatives."],
  ["IDENTITY", "MATCH_REF", "error", "Both are the identity-handling block; the ternary picks exactly one."],
  ["IDENTITY", "BACKGROUND", "error", "Same ternary."],

  // --- standing tensions (warn). Real overlaps, but one side is always-on, so
  //     these describe a property of the prompt today rather than a regression.
  ["REALISM", "SPEC_LIGHT", "warn",
    "REALISM prescribes light universally ('HARSH, UNEVEN... avoid the even, soft, flattering look'); SPEC_LIGHT states the reference's MEASURED direction/hardness, which may be exactly the soft light REALISM forbids. Same universal-vs-measured shape as the COMP_DNA/SPEC_COMP bug."],
  // RESOLVED at the source: "LANDSCAPE or" was removed from REALISM_LAYER, since
  // the tail always forces a vertical aspect and the orientation half of that
  // bullet could therefore never be honoured. Kept as an ERROR pair so the
  // contradiction cannot come back unnoticed — the check below asserts REALISM
  // no longer prescribes an orientation at all.
  ["REALISM", "ASPECT_TAIL", "resolved",
    "REALISM must not prescribe an orientation: the tail always demands a vertical 4:5/9:16."],
  ["MATCH_REF", "AUTO_WARDROBE", "warn",
    "MATCH_REF says the output should be 'the same photograph, simply taken of the user' — which includes the reference's clothing; AUTO_WARDROBE independently dresses them from the pack vocabulary."],
  ["REALISM", "COMP_DNA", "warn",
    "REALISM wants casual grab-shot framing with the subject 'a little off-centre... natural (not golden-ratio) placement'; COMP_DNA prescribes deliberate rule-of-thirds art direction with a framing device and leading lines."],
];

// Table hygiene: a typo'd block name would make an entry silently unenforceable.
for (const [a, b] of CONFLICTS) {
  if (!(a in BLOCK)) die(`conflict table references unknown block "${a}"`);
  if (!(b in BLOCK)) die(`conflict table references unknown block "${b}"`);
}

// ---------------------------------------------------------------------------
// IMPERFECTION BUDGET. The realism literature is specific: a model given more
// than about two or three explicit "make it imperfect" levers stops rendering
// realism and starts performing deliberate degradation — visible grain, mushy
// focus, crushed exposure — which reads as a filtered photo, not a real one.
// We count DISTINCT imperfection concepts (a block repeating "noise" four times
// is one lever, not four) and, separately, total mentions.
// ---------------------------------------------------------------------------
const IMPERFECTION = {
  grain:        /\bgrain(y|s)?\b/gi,
  noise:        /\bnois(e|es|y)\b/gi,
  "chromatic-aberration": /chromatic aberration/gi,
  blur:         /\bblur(red|ry|ring|s)?\b|\bbokeh\b/gi,
  "soft-focus": /out of focus|missed focus|corner soft(ness)?|soft focus|softened by haze/gi,
  "blown-highlights": /\b(blown|clipped|clipping)\b/gi,
  vignette:     /\bvignett(e|ing)\b/gi,
  imperfect:    /\bimperfect(ion|ions|ly)?\b/gi,
  flaw:         /\bflaw(ed|s)?\b/gi,
  artifact:     /\bartifact(s)?\b|\bJPEG\b|\bcompression\b/gi,
  haze:         /\bhaz(e|y)\b|atmospheric perspective/gi,
  wear:         /\b(wear|worn|scuff(ed)?|smudge(s|d)?|wrinkle(s|d)?|creased?|stray hair|clutter|dust|grime)\b/gi,
  ghosting:     /\bghost(ing)?\b|\bdoubling\b/gi,
  flare:        /\bflare(s)?\b/gi,
  halo:         /\bhalo(s|ing)?\b/gi,
  "exposure-error": /\b(underexpos\w+|overexpos\w+|uneven exposure|milky|washed-out)\b/gi,
  tilt:         /\b(tilt|crooked|imperfect horizon|off-center|off-centre)\b/gi,
  "muted-color": /\b(muted|desaturated|slightly-off colou?r)\b/gi,
};
// A PROHIBITION is not a lever. "do NOT add creamy background blur" and "no added
// grain" must not be counted as instructions to degrade, or the budget measures
// vocabulary instead of instruction load. We split each block into clauses and
// drop any clause that is phrased as a prohibition. Crude, but the alternative —
// counting raw word hits — is measurably wrong in the other direction.
const NEGATED = /\b(do not|don't|never|no |not\b|avoid|banned|rather than|instead of|without)\b/i;
function levers(text) {
  return text.split(/[.;\n]|(?:—)/).filter((clause) => !NEGATED.test(clause));
}
// Justification for the threshold: the research ceiling is 2-3 levers. A prompt
// whose entire thesis is "make it look like a real phone photo" earns some slack,
// so we flag at DOUBLE the ceiling — 6 distinct levers — and treat anything above
// that as over-instruction to be argued for, not assumed.
const IMPERFECTION_FLAG = 6;
// Ratchet: the current worst case, recorded so it cannot grow unnoticed. If a new
// realism block pushes a combination past this, the eval fails and the author has
// to decide which lever to drop.
// Ratcheted down from 16 after REALISM_LAYER was cut from fifteen imperfection
// levers to four rules. The research ceiling is 2-3; 7 is where the prompt
// honestly sits today, and the remaining five come from REALISM_REFS and
// NO_REF_GROUNDING rather than the main block. Lower this as those are trimmed;
// never raise it without a measured reason.
const IMPERFECTION_CEILING = 7;

const leverCache = new Map();
function imperfectionProfile(blocks) {
  const hits = new Map();
  let total = 0;
  for (const b of blocks) {
    if (!leverCache.has(b)) leverCache.set(b, levers(BLOCK[b]));
    for (const clause of leverCache.get(b)) {
      for (const [concept, re] of Object.entries(IMPERFECTION)) {
        re.lastIndex = 0;
        const n = (clause.match(re) ?? []).length;
        if (n) { hits.set(concept, (hits.get(concept) ?? 0) + n); total += n; }
      }
    }
  }
  return { distinct: hits.size, total, concepts: [...hits.keys()].sort() };
}

// ---------------------------------------------------------------------------
// EMISSION MODEL — a faithful transcription of the promptText assembly and of
// the upstream code that decides which references get attached.
// ---------------------------------------------------------------------------
const PACK_REFS_ENABLED = true;     // env default
const REALISM_REFS_ENABLED = true;  // env default

function emit(c) {
  // --- upstream derivations (index.ts lines ~417-482, ~516-620)
  const hasSubject = c.mode === "me" && c.subject;
  const matchReference = c.mode === "me" && c.matchReference;
  const refIdsLen = c.userRefs === "none" ? 0 : 1;
  // Downloads can fail: refIds is what was ASKED for, attachedUserRefs what
  // actually made it into the parts array. The prompt branches on refIds.
  const attachedUserRefs = c.userRefs === "attached" ? 1 : 0;
  const envRef = PACK_REFS_ENABLED && !matchReference && refIdsLen === 0 && c.stylePack && c.envLibrary;
  const realismCount = (REALISM_REFS_ENABLED && !matchReference && !envRef)
    ? (hasSubject ? 2 : 3) : 0;
  const specComposition = envRef && c.spec;
  const specLighting = envRef && c.spec;
  const manifestRows = (hasSubject ? 1 : 0) + (attachedUserRefs ? 1 : 0) + (realismCount ? 1 : 0) + (envRef ? 1 : 0);

  // --- the assembly itself (index.ts lines 678-705), in order
  const out = [];
  if (manifestRows >= 2) out.push("MANIFEST");
  if (c.stylePack) out.push("STYLE");
  out.push("REALISM");
  if (realismCount > 0) out.push("REALISM_REFS");
  if (envRef) out.push(c.mode === "background" ? "ENV_MATCH_BG" : "ENV_MATCH");
  // Gated on what ACTUALLY attached, not on what the caller asked for: a failed
  // download previously suppressed the grounding block written for exactly that
  // case (UNGROUNDED) and emitted MATCH_REF with nothing attached (PHANTOM-REF).
  const recreatingReference = matchReference && attachedUserRefs > 0;
  if (!envRef && attachedUserRefs === 0) out.push("NO_REF");
  if (c.mode === "background") out.push("BACKGROUND");
  else if (recreatingReference) out.push("MATCH_REF");
  else if (hasSubject) out.push("IDENTITY");
  if (hasSubject) out.push("FACE_FID", "FACE_REAL", "MODESTY");
  // R21, as amended: gated on !envRefB64, not !specComposition. The earlier
  // `!specComposition` gate was vacuous while no reference had a measured spec,
  // so the generic lens shipped alongside ENV_MATCH's exact-framing instruction
  // on every pack generation.
  // Any instruction that dictates framing yields to a reference that IS the
  // framing — envRefB64 is always null on the match-reference path, so the
  // gate needs both terms.
  if (hasSubject && !envRef && !recreatingReference) out.push("COMP_DNA");
  if (specComposition) out.push("SPEC_COMP");
  if (specLighting) out.push("SPEC_LIGHT");
  if (hasSubject && !envRef && !recreatingReference) out.push("FRAMING");
  if (hasSubject) out.push("BUILD");
  if (hasSubject && c.wardrobe) out.push("WARDROBE");
  if (hasSubject && !c.wardrobe) out.push("AUTO_WARDROBE");
  if (hasSubject && c.pose) out.push("POSE");
  if (hasSubject && !c.pose && !recreatingReference) out.push("CANDID_POSE");
  out.push("ASPECT_TAIL");
  return { blocks: out, attachedUserRefs, refIdsLen, envRef, matchReference, recreatingReference, hasSubject };
}

// ---------------------------------------------------------------------------
// Enumerate every realistic input combination.
// ---------------------------------------------------------------------------
const combos = [];
for (const mode of ["me", "background"]) {
  for (const subject of [true, false]) {
    for (const stylePack of [true, false]) {
      for (const userRefs of ["none", "attached", "failed"]) {
        for (const matchReference of [true, false]) {
          for (const envLibrary of [true, false]) {
            for (const spec of [true, false]) {
              for (const pose of [true, false]) {
                for (const wardrobe of [true, false]) {
                  // Prune impossible/meaningless inputs so the matrix stays honest.
                  if (mode === "background" && (subject || matchReference)) continue;
                  if (mode === "me" && !subject && matchReference) continue; // face-swap needs a face
                  if (!stylePack && envLibrary) continue;                    // no pack, no pack library
                  if (!envLibrary && spec) continue;                         // a spec belongs to a library asset
                  if (!subject && (pose || wardrobe)) continue;              // ignored without a subject
                  combos.push({ mode, subject, stylePack, userRefs, matchReference, envLibrary, spec, pose, wardrobe });
                }
              }
            }
          }
        }
      }
    }
  }
}
if (combos.length < 60) die(`only ${combos.length} combinations enumerated — the pruning is too aggressive to be a real sweep`);

// Group by emitted block-set so the matrix is one row per DISTINCT prompt shape.
const shapes = new Map();
const flagWeight = (c) =>
  (c.subject ? 1 : 0) + (c.stylePack ? 1 : 0) + (c.userRefs !== "none" ? 1 : 0) +
  (c.matchReference ? 1 : 0) + (c.envLibrary ? 1 : 0) + (c.spec ? 1 : 0) +
  (c.pose ? 1 : 0) + (c.wardrobe ? 1 : 0);
for (const c of combos) {
  const e = emit(c);
  const sig = e.blocks.join("+");
  if (!shapes.has(sig)) shapes.set(sig, { ...e, sig, example: c, count: 0 });
  const shape = shapes.get(sig);
  shape.count += 1;
  // Show the SIMPLEST input that produces this shape, so the row does not
  // display flags (envlib, spec) that turned out to be inert for it.
  if (flagWeight(c) < flagWeight(shape.example)) shape.example = c;
}

// ---------------------------------------------------------------------------
// Checks + matrix.
// ---------------------------------------------------------------------------
const violations = new Map(); // "A x B" -> Set(sig)
const warnings = new Map();
let maxDistinct = 0;
const rows = [];

for (const s of shapes.values()) {
  const set = new Set(s.blocks);
  const chars = s.blocks.reduce((n, b) => n + BLOCK[b].length, 0);
  const imp = imperfectionProfile(s.blocks);
  maxDistinct = Math.max(maxDistinct, imp.distinct);

  const hit = [];
  for (const [a, b, sev, reason] of CONFLICTS) {
    // `resolved` pairs are fixed at the source and asserted by CONTENT below;
    // co-occurrence alone no longer means anything for them.
    if (sev === "resolved") continue;
    if (set.has(a) && set.has(b)) {
      const key = `${a} x ${b}`;
      const bucket = sev === "error" ? violations : warnings;
      if (!bucket.has(key)) bucket.set(key, { reason, sigs: new Set() });
      bucket.get(key).sigs.add(s.sig);
      if (sev === "error") hit.push(key);
    }
  }

  // Grounding coverage — the block-ABSENCE failure mode. Every prompt must
  // anchor the setting to something: an attached environment, an attached
  // reference to recreate, the user's own attached inspiration, or the explicit
  // "you are inventing it, ground it hard" block. A prompt with none of these
  // invents a clean AI backdrop with nothing telling it not to.
  const grounded = set.has("ENV_MATCH") || set.has("ENV_MATCH_BG") || set.has("NO_REF") || s.attachedUserRefs > 0;
  if (!grounded) hit.push("UNGROUNDED");
  // And a reference-recreation instruction with no reference actually attached
  // is an instruction to hallucinate one.
  const phantomRef = set.has("MATCH_REF") && s.attachedUserRefs === 0;
  if (phantomRef) hit.push("PHANTOM-REF");

  rows.push({ s, chars, imp, hit, grounded, phantomRef });
}

rows.sort((a, b) => (b.hit.length - a.hit.length) || (b.chars - a.chars));

const NAME = (c) =>
  `${c.mode === "background" ? "bg " : "me "}` +
  `${c.subject ? "subj " : "     "}` +
  `${c.stylePack ? "pack " : "     "}` +
  `${c.userRefs === "none" ? "         " : c.userRefs === "attached" ? "userref  " : "reffail  "}` +
  `${c.matchReference ? "match " : "      "}` +
  `${c.envLibrary ? "envlib " : "       "}` +
  `${c.spec ? "spec " : "     "}`;

console.log(`${shapes.size} distinct prompt shapes from ${combos.length} input combinations\n`);
console.log("  INPUTS                                              CHARS  IMPF   RESULT   (IMPF = distinct levers / total mentions)");
console.log("  " + "-".repeat(96));
for (const r of rows) {
  const flagImp = r.imp.distinct > IMPERFECTION_FLAG ? "!" : " ";
  const status = r.hit.length ? `FAIL  ${r.hit.join(", ")}` : "PASS";
  const impCol = `${r.imp.distinct}/${r.imp.total}`;
  console.log(`  ${NAME(r.s.example)} ${String(r.chars).padStart(6)} ${impCol.padStart(6)}${flagImp} ${status}`);
  console.log(`    blocks: ${r.s.blocks.join(" ")}`);
}

for (const [block, forbidden, why] of RESOLVED_ASSERTIONS) {
  ok(`${block} stays free of its resolved contradiction`, !forbidden.test(BLOCK[block] ?? ""), why);
}

console.log("\nCONFLICT TABLE RESULTS");
if (!violations.size) {
  console.log("  no forbidden pair is reachable in any enumerated combination");
} else {
  for (const [key, v] of violations) {
    console.log(`  FAIL  ${key}  (reachable in ${v.sigs.size} prompt shape${v.sigs.size === 1 ? "" : "s"})`);
    console.log(`        ${v.reason}`);
  }
}
for (const [key, v] of warnings) {
  warned(`${key}  (${v.sigs.size} shape${v.sigs.size === 1 ? "" : "s"})`, v.reason);
}
ok("no error-severity conflict pair is reachable", violations.size === 0, `${violations.size} pair(s) reachable`);

console.log("\nGROUNDING COVERAGE");
const ungrounded = rows.filter((r) => !r.grounded);
const phantom = rows.filter((r) => r.phantomRef);
ok("every prompt shape anchors the setting to something", ungrounded.length === 0,
  ungrounded.length ? `${ungrounded.length} shape(s) emit no grounding block and attach no reference` : "");
ok("no shape instructs recreating a reference that is not attached", phantom.length === 0,
  phantom.length ? `${phantom.length} shape(s) emit MATCH_REF with zero attached refs` : "");

console.log("\nIMPERFECTION BUDGET");
const over = rows.filter((r) => r.imp.distinct > IMPERFECTION_FLAG);
console.log(`  research ceiling 2-3 distinct levers; flagging above ${IMPERFECTION_FLAG}; worst shape here = ${maxDistinct}`);
console.log(`  ${over.length}/${rows.length} prompt shapes exceed the flag threshold`);
{
  const worst = rows.reduce((a, b) => (b.imp.distinct > a.imp.distinct ? b : a));
  console.log(`  worst: ${worst.imp.distinct} distinct (${worst.imp.total} mentions) — ${worst.imp.concepts.join(", ")}`);
  // Where the load comes from, so the number is actionable rather than scary.
  const perBlock = Object.keys(BLOCK)
    .map((b) => ({ b, d: imperfectionProfile([b]).distinct }))
    .filter((x) => x.d > 0).sort((a, b) => b.d - a.d);
  console.log(`  by block: ${perBlock.map((x) => `${x.b}=${x.d}`).join(" ")}`);
}
ok(`imperfection ratchet: worst shape <= ${IMPERFECTION_CEILING} distinct levers`, maxDistinct <= IMPERFECTION_CEILING,
  `worst is ${maxDistinct}; a new realism block raised the load — drop a lever before adding one`);

console.log(`\n${pass} passed, ${fail} failed, ${warn} warned`);
process.exit(fail ? 1 : 0);
