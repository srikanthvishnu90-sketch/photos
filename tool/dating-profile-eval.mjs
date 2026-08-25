// Dating profile = 6-slot select + fill-gaps — acceptance eval (founder's model).
// Verifies assembleDatingProfile slots the right photo types, prefers the user's
// own photos for solo slots, drops utility, and reports the missing slots as gaps.
//   run: node tool/dating-profile-eval.mjs
import { assembleDatingProfile, DATING_SLOTS } from "../gems-rank-assembly.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${d}`); } };

console.log("Dating profile — 6-slot select + fill gaps\n");

const rec = (id, passA, score) => ({ record: { id, derived: { passA }, metrics: { quality: score } }, score });

// A library with a photo for every slot but ALSO a screenshot and a non-me
// portrait that should not win the face slot.
const results = [
  rec("face_me",   { people_count: 1, distance: "close" }, 80),
  rec("face_other",{ people_count: 1, distance: "close" }, 95), // higher score but NOT me
  rec("full_me",   { people_count: 1, distance: "wide" }, 70),
  rec("group1",    { people_count: 4, photo_type: "group" }, 65),
  rec("action1",   { people_count: 1, photo_type: "action" }, 60),
  rec("candid1",   { people_count: 1, candid_or_posed: "candid" }, 55),
  rec("object1",   { people_count: 0, photo_type: "scene" }, 50),
  rec("junk1",     { photo_type: "screenshot", people_count: 0 }, 99), // utility
];
const me = new Set(["face_me", "full_me", "action1", "candid1"]);

const { lineup, gaps } = assembleDatingProfile(results, { preferIds: me });
const bySlot = Object.fromEntries(lineup.map((s) => [s.slot, s]));

ok("returns all 6 slots", lineup.length === 6 && DATING_SLOTS.length === 6);
ok("face slot prefers ME over a higher-scoring stranger", bySlot.face.record?.id === "face_me", bySlot.face.record?.id);
ok("full-body slot filled from a wide me shot", bySlot.fullbody.record?.id === "full_me");
ok("social slot = the group", bySlot.social.record?.id === "group1");
ok("activity slot = the action shot", bySlot.activity.record?.id === "action1");
ok("standout slot = the scene/object", bySlot.standout.record?.id === "object1");
ok("no screenshot anywhere in the lineup", !lineup.some((s) => s.record?.id === "junk1"));
ok("no gaps when everything is covered", gaps.length === 0, gaps.join(","));
ok("no photo used twice", new Set(lineup.filter((s) => s.record).map((s) => s.record.id)).size === lineup.filter((s) => s.record).length);

// A sparse library: only a face + a group → the other 4 slots are gaps.
const sparse = [
  rec("f1", { people_count: 1, distance: "close" }, 70),
  rec("g1", { people_count: 3, photo_type: "group" }, 60),
];
const r2 = assembleDatingProfile(sparse, { preferIds: new Set(["f1"]) });
ok("sparse library reports the right gaps", r2.gaps.length === 4 && !r2.gaps.includes("face") && !r2.gaps.includes("social"), r2.gaps.join(","));
ok("every gap slot names a fill recipe", r2.lineup.filter((s) => !s.record).every((s) => typeof s.recipe === "string" && s.recipe.length > 0));

// Empty input → all gaps, no throw.
const r3 = assembleDatingProfile([], {});
ok("empty input → 6 gaps, no crash", r3.gaps.length === 6 && r3.lineup.length === 6);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
