// Reference retrieval eval (R15/R16) — pure maths, no network, no database.
//
// The claims under test are the ones the protocol actually makes, so each is
// measured rather than asserted: ranking really orders by similarity, MMR
// really lowers the mean pairwise similarity of a batch versus top-N (printed
// as a number), the same request really returns the same references, and every
// degenerate case returns something sane instead of throwing.
//
//   run: node tool/retrieval-eval.mjs
//
// Node >= 22.18 strips the types from the .ts import natively; no build step.
import {
  cosineSimilarity,
  l2Normalize,
  meanPairwiseSimilarity,
  rankReferences,
  referenceCandidateFromRow,
  selectByMaximalMarginalRelevance,
  selectOrderedSpread,
  selectReferences,
  shouldUseNoReferencePath,
} from "../supabase/functions/_shared/reference-retrieval-v1.ts";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${detail}`); }
};
const section = (name) => console.log(`\n${name}`);
const ids = (picks) => picks.map((p) => p.candidate.id).join(",");
const round = (n) => Math.round(n * 1000) / 1000;

// Deterministic pseudo-noise so the eval never depends on Math.random.
function noise(seed, i) {
  const x = Math.sin(seed * 127.1 + i * 311.7) * 43758.5453;
  return x - Math.floor(x) - 0.5;
}

const DIMS = 16;
function direction(axis, jitterSeed = 0, jitter = 0) {
  const vec = new Array(DIMS).fill(0);
  vec[axis % DIMS] = 1;
  if (jitter) for (let i = 0; i < DIMS; i++) vec[i] += jitter * noise(jitterSeed, i);
  return l2Normalize(vec);
}

console.log("Reference retrieval — R15 ranking + R16 diversity eval");

// ---------------------------------------------------------------------------
section("R15 — ranking orders by similarity, not by position");
// ---------------------------------------------------------------------------
{
  const query = direction(0);
  const candidates = [
    { id: "far", storagePath: "p/far.jpg", textEmbedding: direction(5) },
    { id: "mid", storagePath: "p/mid.jpg", textEmbedding: l2Normalize(direction(0).map((v, i) => v + direction(5)[i])) },
    { id: "near", storagePath: "p/near.jpg", textEmbedding: direction(0, 1, 0.02) },
  ];
  const ranked = rankReferences({ text: "anything", queryEmbedding: query }, candidates);
  ok("nearest candidate ranks first", ranked[0].candidate.id === "near", ids(ranked));
  ok("orthogonal candidate ranks last", ranked[2].candidate.id === "far", ids(ranked));
  ok("scores are monotonically non-increasing",
    ranked[0].score >= ranked[1].score && ranked[1].score >= ranked[2].score,
    ranked.map((r) => round(r.score)).join(" > "));
  ok("input order does not change the ranking",
    ids(rankReferences({ text: "anything", queryEmbedding: query }, [...candidates].reverse())) === ids(ranked));

  // Measured quality is a real second-stage lever, not decoration.
  const withQuality = rankReferences({ text: "anything", queryEmbedding: query }, [
    { ...candidates[2], id: "near-bad", qualityScore: 0.0 },
    { ...candidates[1], id: "mid-good", qualityScore: 1.0 },
  ]);
  ok("stage two can overturn stage one on a large quality gap",
    withQuality[0].candidate.id === "mid-good",
    withQuality.map((r) => `${r.candidate.id}=${round(r.score)}`).join(" "));
}

// ---------------------------------------------------------------------------
section("R16 — MMR increases batch diversity versus top-N (measured)");
// ---------------------------------------------------------------------------
{
  // A pack shaped like a real one: one big cluster shot at the same spot, which
  // also happens to score highest, plus genuinely different places nearby.
  const near = Array.from({ length: 6 }, (_, i) => ({
    id: `dup${i}`,
    storagePath: `_global/packs/dubai/${10 + i}.jpg`,
    textEmbedding: direction(0, i + 1, 0.03),
  }));
  const varied = Array.from({ length: 6 }, (_, i) => ({
    id: `varied${i}`,
    storagePath: `_global/packs/dubai/${40 + i}.jpg`,
    textEmbedding: l2Normalize(direction(0).map((v, k) => 0.5 * v + direction(i + 1)[k])),
  }));
  const pack = [...near, ...varied];
  const request = { text: "dubai rooftop", stylePackId: "dubai", queryEmbedding: direction(0) };
  const COUNT = 6;

  const ranked = rankReferences(request, pack);
  const topN = ranked.slice(0, COUNT);
  const mmr = selectByMaximalMarginalRelevance(ranked, COUNT, 0.7, "seed");

  const topNDiversity = meanPairwiseSimilarity(topN.map((r) => r.features));
  const mmrDiversity = meanPairwiseSimilarity(mmr.map((r) => r.features));
  const drop = topNDiversity - mmrDiversity;

  console.log(`    top-${COUNT} mean pairwise similarity : ${round(topNDiversity)}`);
  console.log(`    MMR    mean pairwise similarity : ${round(mmrDiversity)}`);
  console.log(`    diversity improvement           : ${round(drop)} (${round(100 * drop / topNDiversity)}% less redundant)`);

  ok("top-N collapses onto the near-duplicate cluster",
    topN.every((r) => r.candidate.id.startsWith("dup")), ids(topN));
  ok("MMR measurably reduces mean pairwise similarity", drop > 0.15,
    `drop=${round(drop)}`);
  ok("MMR draws from more than one cluster",
    new Set(mmr.map((r) => r.candidate.id.replace(/\d+$/, ""))).size > 1, ids(mmr));
  ok("MMR returns exactly the requested count, no repeats",
    mmr.length === COUNT && new Set(mmr.map((r) => r.candidate.id)).size === COUNT, ids(mmr));

  // Lambda has to actually be the dial it claims to be.
  const relevanceHeavy = selectByMaximalMarginalRelevance(ranked, COUNT, 1.0, "seed");
  const diversityHeavy = selectByMaximalMarginalRelevance(ranked, COUNT, 0.0, "seed");
  const relevanceHeavyDiversity = meanPairwiseSimilarity(relevanceHeavy.map((r) => r.features));
  const diversityHeavyDiversity = meanPairwiseSimilarity(diversityHeavy.map((r) => r.features));
  console.log(`    lambda=1.0 (pure relevance)     : ${round(relevanceHeavyDiversity)}`);
  console.log(`    lambda=0.0 (pure diversity)     : ${round(diversityHeavyDiversity)}`);
  ok("lambda=1.0 reproduces top-N exactly", ids(relevanceHeavy) === ids(topN));
  ok("lambda=0.0 is the most diverse of the three",
    diversityHeavyDiversity <= mmrDiversity + 1e-9 && mmrDiversity < relevanceHeavyDiversity,
    `${round(diversityHeavyDiversity)} <= ${round(mmrDiversity)} < ${round(relevanceHeavyDiversity)}`);

  // And the same thing through the composed entry point.
  const selection = selectReferences(request, pack, { count: COUNT });
  ok("selectReferences reports its own diversity",
    Math.abs(selection.diversity - meanPairwiseSimilarity(selection.picks.map((p) => p.features))) < 1e-12);
  ok("selectReferences beats top-N on diversity too",
    selection.diversity < topNDiversity - 0.15,
    `${round(selection.diversity)} vs ${round(topNDiversity)}`);
}

// ---------------------------------------------------------------------------
section("Determinism — a user redoing a scene gets the same places");
// ---------------------------------------------------------------------------
{
  const pack = Array.from({ length: 40 }, (_, i) => ({
    id: `a${i}`,
    storagePath: `_global/packs/dubai/${i}.jpg`,
    textEmbedding: direction(i % 8, i + 1, 0.4),
  }));
  const request = { text: "dubai marina at dusk", stylePackId: "dubai", queryEmbedding: direction(2) };

  const runs = Array.from({ length: 5 }, () => ids(selectReferences(request, pack, { count: 6 }).picks));
  ok("five identical requests return identical references", new Set(runs).size === 1, runs[0]);

  const shuffled = [...pack].sort((a, b) => (a.id.length - b.id.length) || b.id.localeCompare(a.id));
  ok("candidate row order does not affect the result",
    ids(selectReferences(request, shuffled, { count: 6 }).picks) === runs[0]);

  // Retrieval is a function of the QUERY, not of the prompt string: same query
  // vector, same references, whatever words produced it. Reseeding does not
  // re-roll either — the seed only settles ties, and a fully ranked pack has
  // none. This is deliberate; a seed that moved a ranked result would be the
  // modulo problem in disguise.
  const samePromptDifferentWords = ids(
    selectReferences({ ...request, text: "dubai desert at noon" }, pack, { count: 6 }).picks);
  ok("the same query vector returns the same references", samePromptDifferentWords === runs[0]);
  const reseeded = ids(selectReferences({ ...request, seed: "retry-2" }, pack, { count: 6 }).picks);
  ok("reseeding does not silently re-roll a ranked result", reseeded === runs[0]);

  // Without a query vector the prompt text IS the query, so it does move.
  const lexical = pack.map(({ id, storagePath }) => ({ id, storagePath, label: `${id} rooftop dusk` }));
  const promptA = ids(selectReferences({ text: "rooftop dusk", stylePackId: "dubai" }, lexical, { count: 6 }).picks);
  const promptB = ids(selectReferences({ text: "desert noon", stylePackId: "dubai" }, lexical, { count: 6 }).picks);
  ok("in lexical mode the prompt text changes the result", promptA !== promptB, `${promptA} | ${promptB}`);

  // Exclusion is the supported way to ask for different places on a retry.
  const first = selectReferences(request, pack, { count: 6 });
  const retry = selectReferences(request, pack, {
    count: 6,
    exclude: first.picks.map((p) => p.candidate.id),
  });
  const overlap = retry.picks.filter((p) => first.picks.some((q) => q.candidate.id === p.candidate.id));
  ok("excluding what was used returns entirely new references",
    retry.picks.length === 6 && overlap.length === 0, ids(retry.picks));
  ok("exclusion is reported", retry.notes.includes("applied_exclusions"), retry.notes.join(","));
  ok("exhausting the pack falls to the NO-REFERENCE path, not a repeat",
    shouldUseNoReferencePath(selectReferences(request, pack, { count: 6, exclude: pack.map((c) => c.id) })));

  // The degraded path DOES move with the seed, because there its offset is the
  // only thing there is to move.
  const bare2 = pack.map(({ id, storagePath }) => ({ id, storagePath }));
  const spreadA = ids(selectReferences({ text: "", stylePackId: "dubai" }, bare2, { count: 6 }).picks);
  const spreadB = ids(selectReferences({ text: "", stylePackId: "dubai", seed: "retry-2" }, bare2, { count: 6 }).picks);
  ok("ordered spread moves with the seed", spreadA !== spreadB, `${spreadA} | ${spreadB}`);

  // The ordered-spread degrade must be just as reproducible.
  const bare = pack.map(({ id, storagePath }) => ({ id, storagePath }));
  const spreadRuns = Array.from({ length: 3 }, () =>
    selectOrderedSpread(bare, 6, "seed-x").map((c) => c.id).join(","));
  ok("ordered spread is deterministic", new Set(spreadRuns).size === 1, spreadRuns[0]);
}

// ---------------------------------------------------------------------------
section("Degraded path — no embeddings, no shot specs, numeric filenames");
// ---------------------------------------------------------------------------
{
  // This is the live library today: 955 rows, every embedding and shot_spec null.
  const pack = Array.from({ length: 147 }, (_, i) => ({
    id: `dubai-${i}`,
    storagePath: `_global/packs/dubai/${i}.jpg`,
  }));
  const selection = selectReferences({ text: "", stylePackId: "dubai" }, pack, { count: 6 });

  ok("degrades to ordered spread, not to a crash", selection.mode === "ordered_spread", selection.mode);
  ok("flags itself as degraded", selection.degraded === true);
  ok("explains why", selection.notes.includes("no_embeddings"), selection.notes.join(","));
  ok("still returns a full batch", selection.picks.length === 6);
  ok("returns no duplicates", new Set(selection.picks.map((p) => p.candidate.id)).size === 6);

  // The measured reason to prefer a stride: consecutive files are one shoot.
  const indexOf = (p) => Number(p.candidate.storagePath.match(/(\d+)\.jpg$/)[1]);
  const picked = selection.picks.map(indexOf).sort((a, b) => a - b);
  const gaps = picked.slice(1).map((v, i) => v - picked[i]);
  const minGap = Math.min(...gaps);
  console.log(`    picked indices                  : ${picked.join(", ")}`);
  console.log(`    smallest gap between picks      : ${minGap} (modulo selection gives 1)`);
  ok("spread never picks adjacent files, unlike environmentRef % n", minGap > 1, `minGap=${minGap}`);
}

// ---------------------------------------------------------------------------
section("Degenerate cases — the ones that will actually happen");
// ---------------------------------------------------------------------------
{
  const empty = selectReferences({ text: "anything" }, [], { count: 6 });
  ok("empty input returns no picks", empty.picks.length === 0);
  ok("empty input signals the NO-REFERENCE path (R18)", shouldUseNoReferencePath(empty));
  ok("empty input says why", empty.notes.includes("no_candidates"), empty.notes.join(","));

  const zero = selectReferences({ text: "x" }, [{ id: "a", storagePath: "a.jpg" }], { count: 0 });
  ok("count=0 returns nothing and does not throw", zero.picks.length === 0);

  const negative = selectReferences({ text: "x" }, [{ id: "a", storagePath: "a.jpg" }], { count: -3 });
  ok("negative count returns nothing", negative.picks.length === 0);

  const few = selectReferences({ text: "" }, [
    { id: "a", storagePath: "p/1.jpg" },
    { id: "b", storagePath: "p/2.jpg" },
  ], { count: 6 });
  ok("fewer candidates than requested returns what exists", few.picks.length === 2, ids(few.picks));
  ok("never pads by repeating a reference",
    new Set(few.picks.map((p) => p.candidate.id)).size === few.picks.length);
  ok("insufficiency is reported", few.notes.includes("insufficient_candidates"), few.notes.join(","));

  const identicalVector = direction(3);
  const identical = Array.from({ length: 5 }, (_, i) => ({
    id: `same${i}`,
    storagePath: `p/same${i}.jpg`,
    textEmbedding: identicalVector,
  }));
  const clones = selectReferences({ text: "q", queryEmbedding: identicalVector }, identical, { count: 3 });
  ok("all-identical candidates terminate", clones.picks.length === 3, ids(clones.picks));
  ok("all-identical candidates stay distinct rows",
    new Set(clones.picks.map((p) => p.candidate.id)).size === 3);
  ok("all-identical candidates report maximum redundancy",
    Math.abs(clones.diversity - 1) < 1e-6, `${round(clones.diversity)}`);
  ok("all-identical selection is reproducible",
    ids(selectReferences({ text: "q", queryEmbedding: identicalVector }, identical, { count: 3 }).picks)
      === ids(clones.picks));

  const single = selectReferences({ text: "q" }, [{ id: "only", storagePath: "p/only.jpg" }], { count: 6 });
  ok("a one-photo library returns that one photo", single.picks.length === 1);
  ok("a single pick reports zero pairwise similarity", single.diversity === 0);

  const junk = selectReferences({ text: "q" }, [
    null,
    undefined,
    {},
    { id: "no-path" },
    { id: "nan", storagePath: "p/nan.jpg", textEmbedding: [Number.NaN, 1, 2] },
    { id: "dupe", storagePath: "p/x.jpg" },
    { id: "dupe", storagePath: "p/y.jpg" },
  ], { count: 4 });
  ok("malformed rows are dropped, not thrown on", junk.picks.length > 0, ids(junk.picks));
  ok("duplicate ids collapse to one", junk.picks.filter((p) => p.candidate.id === "dupe").length === 1);
  ok("dropping is reported", junk.notes.includes("dropped_invalid_candidates"), junk.notes.join(","));

  ok("mismatched vector lengths score 0 rather than throwing",
    cosineSimilarity([1, 0], [1, 0, 0]) === 0);
  ok("a zero vector scores 0 rather than NaN", cosineSimilarity([0, 0], [1, 0]) === 0);
  ok("normalising a zero vector does not produce NaN",
    l2Normalize([0, 0]).every(Number.isFinite));

  // Partial backfill: a handful of embedded rows must not monopolise the batch.
  const mostlyBare = Array.from({ length: 30 }, (_, i) => ({
    id: `m${i}`,
    storagePath: `p/${i}.jpg`,
    textEmbedding: i < 3 ? direction(i, i + 1, 0.1) : null,
  }));
  const partial = selectReferences({ text: "" }, mostlyBare, { count: 6 });
  ok("a 3-of-30 backfill does not shrink the library to 3",
    partial.picks.length === 6, `${partial.mode} ${partial.picks.length}`);
}

// ---------------------------------------------------------------------------
section("Row mapping — R13 eligibility is data, not a filename regex");
// ---------------------------------------------------------------------------
{
  ok("maps a live inspiration_assets row", referenceCandidateFromRow({
    id: "u", storage_path: "_global/packs/dubai/1.jpg", style_pack_id: "dubai",
    eligible: true, is_ai_render: false, quality_score: null, shot_spec: null,
  })?.storagePath === "_global/packs/dubai/1.jpg");
  ok("rejects an ineligible row",
    referenceCandidateFromRow({ id: "u", storage_path: "a.jpg", eligible: false }) === null);
  ok("rejects a measured AI render",
    referenceCandidateFromRow({ id: "u", storage_path: "a.jpg", is_ai_render: true }) === null);
  ok("rejects a non-image path",
    referenceCandidateFromRow({ id: "u", storage_path: "a.txt" }) === null);
  ok("reads a pgvector text column",
    referenceCandidateFromRow({ id: "u", storage_path: "a.jpg", visual_embedding: "[0.1,0.2,0.3]" })
      ?.visualEmbedding?.length === 3);
  ok("reads an embedding carried as a plain array",
    referenceCandidateFromRow({ id: "u", storage_path: "a.jpg", text_embedding: [0.1, 0.2] })
      ?.textEmbedding?.length === 2);
  ok("survives a malformed vector column",
    referenceCandidateFromRow({ id: "u", storage_path: "a.jpg", visual_embedding: "not-a-vector" })
      ?.visualEmbedding === null);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
