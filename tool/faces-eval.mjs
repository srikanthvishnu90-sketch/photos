// Face-recognition core eval — the pure math (distance + clustering). The
// in-browser detection/embedding (face-api.js) can't run in node, so this
// validates the clustering that turns descriptors into people.
//   run: node tool/faces-eval.mjs
import { euclidean, cosine, centroid, clusterDescriptors } from "../gems-faces.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${detail}`); }
};

// Deterministic pseudo-random so the test is stable (no Math.random dependence).
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

const DIM = 128;
// Three well-separated "people" base descriptors; each face = base + small noise.
function person(offset) { return Array.from({ length: DIM }, (_, i) => Math.sin(i * 0.1 + offset)); }
const bases = [person(0), person(2.0), person(4.0)];
function noisyFace(baseIdx, noise = 0.03) {
  return bases[baseIdx].map((v) => v + (rnd() - 0.5) * 2 * noise);
}

console.log("Face recognition — clustering eval\n");

// distance sanity
ok("euclidean self = 0", euclidean(bases[0], bases[0]) === 0);
ok("cosine self ≈ 1", Math.abs(cosine(bases[0], bases[0]) - 1) < 1e-9);
ok("different people are far apart", euclidean(bases[0], bases[1]) > 1.0, `${euclidean(bases[0], bases[1])}`);
ok("centroid of one = itself", euclidean(centroid([bases[0]]), bases[0]) < 1e-9);

// Build 30 faces: 12 of person0, 10 of person1, 8 of person2, shuffled by id order.
const items = [];
for (let i = 0; i < 12; i++) items.push({ id: `a${i}`, truth: 0, descriptor: noisyFace(0) });
for (let i = 0; i < 10; i++) items.push({ id: `b${i}`, truth: 1, descriptor: noisyFace(1) });
for (let i = 0; i < 8; i++) items.push({ id: `c${i}`, truth: 2, descriptor: noisyFace(2) });

const assign = clusterDescriptors(items, 0.56);
const clusterCount = new Set(assign.values()).size;
ok("finds exactly 3 people", clusterCount === 3, `got ${clusterCount}`);

// Every same-truth pair shares a cluster; different-truth never do.
let sameOk = true, diffOk = true;
for (const a of items) for (const b of items) {
  if (a === b) continue;
  const together = assign.get(a.id) === assign.get(b.id);
  if (a.truth === b.truth && !together) sameOk = false;
  if (a.truth !== b.truth && together) diffOk = false;
}
ok("all same-person faces grouped together", sameOk);
ok("no two different people merged", diffOk);

// A brand-new distinct person opens a new cluster.
const items2 = [...items, { id: "d0", truth: 3, descriptor: person(6.0) }];
const assign2 = clusterDescriptors(items2, 0.56);
ok("a distinct 4th person → 4 clusters", new Set(assign2.values()).size === 4);

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
