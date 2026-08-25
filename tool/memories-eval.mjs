// Memories core eval — pure clustering, distance, titles, gem scoring, and the
// end-to-end buildMemories (the EXIF read needs a browser; this validates the
// logic that turns capture-meta'd records into events).
//   run: node tool/memories-eval.mjs
import {
  haversineKm, clusterByTimeLoc, formatDateRange, titleFor, gemScore, buildMemories,
} from "../gems-memories.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${d}`); } };
const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;

console.log("Memories — clustering + scoring eval\n");

// haversine
ok("haversine self = 0", haversineKm({ lat: 40, lon: -74 }, { lat: 40, lon: -74 }) < 1e-6);
ok("NYC→LA ~3900km", Math.abs(haversineKm({ lat: 40.7, lon: -74 }, { lat: 34.05, lon: -118.24 }) - 3936) < 60,
  `${haversineKm({ lat: 40.7, lon: -74 }, { lat: 34.05, lon: -118.24 })}`);

// time clustering: a same-day burst, then a photo 3 days later → 2 events
{
  const base = Date.UTC(2024, 6, 12, 10);
  const items = [
    { id: "a", t: base },
    { id: "b", t: base + HOUR },
    { id: "c", t: base + 2 * HOUR },
    { id: "d", t: base + 3 * DAY }, // far later → new event
  ];
  const cl = clusterByTimeLoc(items);
  ok("time gap splits events", cl.length === 2, `got ${cl.length}`);
  ok("same-day grouped", cl[0].length === 3, JSON.stringify(cl.map((g) => g.length)));
}

// location split: same time window but 500km apart → 2 events
{
  const base = Date.UTC(2024, 6, 12, 10);
  const items = [
    { id: "a", t: base, lat: 40.7, lon: -74 },
    { id: "b", t: base + HOUR, lat: 40.7, lon: -74 },
    { id: "c", t: base + 2 * HOUR, lat: 42.3, lon: -83 }, // ~330km+ jump
  ];
  const cl = clusterByTimeLoc(items, { radiusKm: 40 });
  ok("location jump splits events", cl.length === 2, `got ${cl.length}`);
}

// date range formatting
ok("same-day date label", /July 12, 2024/.test(formatDateRange(Date.UTC(2024, 6, 12, 9), Date.UTC(2024, 6, 12, 20))));
ok("multi-day date label", /July 12–14, 2024/.test(formatDateRange(Date.UTC(2024, 6, 12), Date.UTC(2024, 6, 14))));

// titles
ok("weekend title", /weekend/.test(titleFor([{ t: Date.UTC(2024, 6, 12) }, { t: Date.UTC(2024, 6, 13) }])));
ok("single-day title (no weekend)", !/weekend|trip/.test(titleFor([{ t: Date.UTC(2024, 6, 12, 9) }, { t: Date.UTC(2024, 6, 12, 18) }])));

// gem scoring: a smiling person beats a sharp screenshot
{
  const person = { metrics: { quality: 70 }, derived: { passA: { appeal: 4, people_count: 1, smile: true } } };
  const shot = { metrics: { quality: 90 }, derived: { passA: { appeal: 1, photo_type: "screenshot", people_count: 0 } } };
  ok("smiling person outscores sharp screenshot", gemScore(person) > gemScore(shot), `${gemScore(person)} vs ${gemScore(shot)}`);
}

// buildMemories end-to-end
{
  const base = Date.UTC(2024, 6, 12, 10);
  const rec = (id, tOffset, q = 60, extra = {}) => ({
    id, addedAt: base + tOffset, metrics: { quality: q },
    derived: { capture: { takenAt: base + tOffset, lat: null, lon: null }, passA: extra },
  });
  const records = [
    rec("a", 0), rec("b", HOUR), rec("c", 2 * HOUR, 80, { appeal: 5, people_count: 2, smile: true }),
    rec("solo", 10 * DAY), // isolated → below MIN_MEMORY, dropped
    rec("x", 20 * DAY), rec("y", 20 * DAY + HOUR), rec("z", 20 * DAY + 2 * HOUR),
  ];
  const mems = buildMemories(records);
  ok("two memories (3+ each)", mems.length === 2, `got ${mems.length}`);
  ok("isolated photo excluded", !mems.some((m) => m.photoIds.includes("solo")));
  ok("cover = strongest (c)", mems.find((m) => m.photoIds.includes("a"))?.coverId === "c");
  ok("newest event first", mems[0].photoIds.includes("x"));
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
