// "Best photos" = forced 4-type mix — acceptance eval (the founder's definition).
// Verifies bestTypeOf classification + assembleBestPhotos always returns the mix
// (group / self-action / self-scenery / object), never a flat score-sort, and
// keeps utility images out of the lead.
//   run: node tool/best-photos-eval.mjs
import { bestTypeOf, assembleBestPhotos } from "../gems-rank-assembly.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${d}`); } };

console.log("Best photos — forced 4-type mix\n");

// classification
ok("explicit best_type wins", bestTypeOf({ best_type: "self-scenery", people_count: 1 }) === "self-scenery");
ok("2+ people → group", bestTypeOf({ people_count: 3, photo_type: "group" }) === "group");
ok("1 person + action → self-action", bestTypeOf({ people_count: 1, photo_type: "action" }) === "self-action");
ok("1 person + wide → self-scenery", bestTypeOf({ people_count: 1, distance: "wide" }) === "self-scenery");
ok("1 person + close → portrait", bestTypeOf({ people_count: 1, distance: "close" }) === "portrait");
ok("no people + object → object", bestTypeOf({ people_count: 0, photo_type: "object" }) === "object");
ok("screenshot → utility", bestTypeOf({ photo_type: "screenshot", people_count: 0 }) === "utility");

// helper to build a scored result
const rec = (id, passA, score) => ({ record: { id, derived: { passA }, metrics: { quality: score } }, score });

// A library heavy on portraits/self, with one of each named type present but
// NOT at the top by score — the mix must surface all four regardless.
const results = [
  rec("port1", { people_count: 1, distance: "close" }, 95), // portrait, highest score
  rec("port2", { people_count: 1, distance: "close" }, 92),
  rec("port3", { people_count: 1, distance: "close" }, 90),
  rec("grp1",  { people_count: 4, photo_type: "group" }, 70), // group, lower score
  rec("act1",  { people_count: 1, photo_type: "action" }, 68), // self-action
  rec("scen1", { people_count: 1, distance: "wide" }, 66), // self-scenery
  rec("obj1",  { people_count: 0, photo_type: "object" }, 60), // object (the Rolex)
  rec("shot1", { photo_type: "screenshot", people_count: 0 }, 99), // utility, top score
];

const out = assembleBestPhotos(results, { slots: 8, includeObjects: true });
const topTypes = out.slice(0, 4).map((r) => bestTypeOf(r.record.derived.passA));
ok("all 4 named types appear in the lead", ["group", "self-action", "self-scenery", "object"].every((t) => topTypes.includes(t)), topTypes.join(","));
ok("group leads (founder priority #1)", bestTypeOf(out[0].record.derived.passA) === "group");
ok("object (Rolex) included despite low score", out.slice(0, 4).some((r) => r.record.id === "obj1"));
ok("utility screenshot NOT in the lead despite score 99", !out.slice(0, 5).some((r) => r.record.id === "shot1"), out.slice(0,5).map(r=>r.record.id).join(","));
ok("utility sinks to the very end", out[out.length - 1].record.id === "shot1");
ok("returns the whole set (permutation)", out.length === results.length);

// No object case: mix still works with 3 types
const noObj = results.filter((r) => r.record.id !== "obj1");
const out2 = assembleBestPhotos(noObj, { slots: 8 });
ok("missing a type is skipped gracefully", out2.length === noObj.length && !out2.some((r) => bestTypeOf(r.record.derived.passA) === "object"));

// "of me" preference: two self-action shots, the LOWER-scored one is actually
// you (preferIds) → it wins the self-action slot; objects still included.
const meResults = [
  rec("act_me",    { people_count: 1, photo_type: "action" }, 55), // you, lower score
  rec("act_other", { people_count: 1, photo_type: "action" }, 88), // someone else, higher
  rec("grp1",      { people_count: 3, photo_type: "group" }, 70),
  rec("obj1",      { people_count: 0, photo_type: "object" }, 60),
];
const outMe = assembleBestPhotos(meResults, { slots: 8, preferIds: new Set(["act_me"]) });
const actionPick = outMe.find((r) => bestTypeOf(r.record.derived.passA) === "self-action");
ok("'of me' prefers YOUR photo within a type despite lower score", actionPick?.record.id === "act_me", actionPick?.record.id);
ok("'of me' still includes the object b-roll", outMe.slice(0, 4).some((r) => r.record.id === "obj1"));

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
