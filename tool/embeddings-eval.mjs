// Embeddings core eval — pure vector math (normalize, cosine search, dup groups).
// The in-browser CLIP model can't run in node; this validates the retrieval +
// dedup logic that turns vectors into search results and burst groups.
//   run: node tool/embeddings-eval.mjs
import { dot, l2normalize, topKByCosine, groupByCosine } from "../gems-embeddings.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${detail}`); }
};

console.log("Embeddings — retrieval + dedup eval\n");

// normalize → unit length
{
  const u = l2normalize([3, 4]);
  ok("l2normalize → unit length", Math.abs(Math.sqrt(u[0] * u[0] + u[1] * u[1]) - 1) < 1e-9, JSON.stringify(u));
  ok("cosine of identical unit vecs = 1", Math.abs(dot(u, u) - 1) < 1e-9);
}

// topK: a query near vector "A" ranks A first, orthogonal C last.
{
  const A = l2normalize([1, 0, 0]);
  const B = l2normalize([0.9, 0.1, 0]);
  const C = l2normalize([0, 0, 1]);
  const items = [{ id: "C", vec: C }, { id: "B", vec: B }, { id: "A", vec: A }];
  const q = l2normalize([0.95, 0.05, 0]);
  const res = topKByCosine(q, items, 3);
  ok("nearest ranked first", res[0].id === "A", res.map((r) => r.id).join(","));
  ok("orthogonal ranked last", res[2].id === "C", res.map((r) => r.id).join(","));
  const top2 = topKByCosine(q, items, 2);
  ok("k limits the result", top2.length === 2);
}

// dup grouping: two near-identical + two distinct → 3 groups, the pair together.
{
  const base = l2normalize(Array.from({ length: 16 }, (_, i) => Math.sin(i)));
  const nearDup = l2normalize(base.map((v) => v + 0.001)); // ~identical
  const other1 = l2normalize(Array.from({ length: 16 }, (_, i) => Math.cos(i)));
  const other2 = l2normalize(Array.from({ length: 16 }, (_, i) => Math.sin(i * 2 + 1)));
  const items = [
    { id: "burst1", vec: base },
    { id: "other1", vec: other1 },
    { id: "burst2", vec: nearDup },
    { id: "other2", vec: other2 },
  ];
  const groups = groupByCosine(items, 0.93);
  const pair = groups.find((g) => g.includes("burst1"));
  ok("near-duplicates grouped together", pair && pair.includes("burst2"), JSON.stringify(groups));
  ok("distinct photos not merged", groups.length === 3, `groups=${groups.length}`);
  const bursts = groups.filter((g) => g.length > 1);
  ok("exactly one burst group", bursts.length === 1);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
