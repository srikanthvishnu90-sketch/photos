// generate-commit-samples — run REAL commitment-poster generations through our
// own deployed generate-scene, so the athlete layer can be judged on output
// rather than on a mockup.
//
// The layout system can be proved in HTML. The generation cannot. This is the
// script that closes that gap.
//
//   # your own account — the free tier meters per profile, so use a real one
//   export GEMS_EMAIL='you@example.com'
//   export GEMS_PASSWORD='...'
//   node tool/generate-commit-samples.mjs ~/path/to/photo-of-you.jpg
//
//   # or skip the password with a token pasted from the app:
//   #   in the app, DevTools console:  (await window.__gemsSession?.())?.access_token
//   export GEMS_TOKEN='eyJ...'
//   node tool/generate-commit-samples.mjs ~/photo.jpg
//
//   # only some sports:
//   node tool/generate-commit-samples.mjs ~/photo.jpg football lacrosse
//
// Writes out/commit-samples/<sport>.jpg plus an index.html contact sheet.
//
// COST: one paid generation per sport. Ten sports is ten images. Free tier is
// metered per request id, and this uses ONE request id for the whole run, so a
// full run counts as a single free "prompt" of up to 10 images.
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { basename, extname } from "node:path";

const URL_BASE = "https://hkwkxacvcgorhthwyslx.supabase.co";
const PUBLISHABLE = "sb_publishable_Z8Fw1dZYiqOGUDITzU929A_i2k9wANc";

// Sport record — the same one the poster engine renders from. Kit and pose are
// what actually have to change per sport; everything else is school colour.
const SPORTS = {
  football:  { kit:"full shoulder pads and a helmet, team jersey and tight pants",
               pose:"walking straight toward the camera, helmet on, chin slightly down",
               where:"on the grass of a stadium field, yard lines under their feet, floodlights above" },
  lacrosse:  { kit:"a lacrosse helmet with facemask, team jersey, gloves and shorts, holding a lacrosse stick",
               pose:"jogging forward cradling the stick across the body",
               where:"on a turf field ringed by a red running track" },
  basketball:{ kit:"a sleeveless team jersey and shorts, no headwear, holding a basketball on the hip",
               pose:"standing square to camera, looking off to the side",
               where:"on an indoor hardwood court, banners and a packed gym behind" },
  baseball:  { kit:"a team cap, button-up jersey and belted pants, a bat resting on the shoulder",
               pose:"weight on the back foot, looking out toward the field",
               where:"on the infield dirt of a baseball diamond, outfield grass behind" },
  soccer:    { kit:"a short-sleeve team kit, shorts, long socks and boots, a ball at their feet",
               pose:"striding forward mid-step",
               where:"on a pitch with a goal net and corner flag behind" },
  track:     { kit:"a team singlet and half-tights, spikes",
               pose:"driving out of the starting blocks, front leg loaded",
               where:"in a lane of a red eight-lane running track, stadium seating behind" },
  wrestling: { kit:"a team singlet and headgear, wrestling shoes",
               pose:"in a low athletic stance, hands out ready to tie up",
               where:"on a circular mat under gym lights, dark seating around" },
  volleyball:{ kit:"a fitted team jersey, spandex shorts and knee pads",
               pose:"arm cocked back at the top of a jump",
               where:"on an indoor court with the net across the frame" },
  hockey:    { kit:"full hockey pads, a helmet with a cage, gloves and skates, holding a stick",
               pose:"skating forward, stick low across the ice",
               where:"on the ice of an arena rink, boards and red line visible, dark stands above" },
  swimming:  { kit:"a team swim suit with a cap and goggles pushed up on the forehead, a towel over one shoulder",
               pose:"standing on the starting blocks, arms loose",
               where:"at the end of a lane-roped competition pool, blocks in frame" },
};

const SCHOOL = { name: "Michigan", colors: "navy blue and maize yellow" };

async function getToken() {
  if (process.env.GEMS_TOKEN) return process.env.GEMS_TOKEN;
  const email = process.env.GEMS_EMAIL, password = process.env.GEMS_PASSWORD;
  if (!email || !password) {
    console.error("Set GEMS_TOKEN, or GEMS_EMAIL + GEMS_PASSWORD. See the header of this file.");
    process.exit(1);
  }
  const r = await fetch(`${URL_BASE}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: PUBLISHABLE, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const d = await r.json();
  if (!d.access_token) { console.error("sign-in failed:", JSON.stringify(d).slice(0, 300)); process.exit(1); }
  return d.access_token;
}

const photoPath = process.argv[2];
if (!photoPath) { console.error("usage: node tool/generate-commit-samples.mjs <photo-of-the-athlete> [sport...]"); process.exit(1); }
const wanted = process.argv.slice(3).filter((s) => SPORTS[s]);
const sports = wanted.length ? wanted : Object.keys(SPORTS);

// generate-scene labels the identity part image/jpeg unconditionally, so the
// input has to actually be a JPEG.
if (![".jpg", ".jpeg"].includes(extname(photoPath).toLowerCase())) {
  console.error(`${photoPath} must be a .jpg — the identity part is sent as image/jpeg.`);
  process.exit(1);
}
const subject = readFileSync(photoPath).toString("base64");
const token = await getToken();
// ONE request id for the whole run: the free tier meters per request, so a full
// run costs a single free "prompt" rather than ten of them.
const requestId = `commit-samples-${Date.now()}`;

mkdirSync("out/commit-samples", { recursive: true });
const results = [];

for (const sport of sports) {
  const S = SPORTS[sport];
  const prompt =
    `A high-school athlete ${S.pose}, wearing ${S.kit} in ${SCHOOL.colors}, ` +
    `${S.where}. Full body, shot from a natural distance with their feet visible. ` +
    `Plain uncluttered background directly behind the athlete so the figure can be cut out cleanly. ` +
    `No text, no logos, no scoreboard graphics, no other people in focus.`;

  process.stdout.write(`${sport.padEnd(11)} generating… `);
  const t0 = Date.now();
  const res = await fetch(`${URL_BASE}/functions/v1/generate-scene`, {
    method: "POST",
    headers: { apikey: PUBLISHABLE, authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      prompt, mode: "me", subjectBase64: subject,
      stylePackId: "game-day", aspect: "4:5", requestId,
      pose: S.pose, wardrobe: S.kit,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.url) {
    console.log(`FAILED ${res.status} ${JSON.stringify(data).slice(0, 160)}`);
    results.push({ sport, error: data.error || res.status });
    continue;
  }
  const img = Buffer.from(await (await fetch(data.url)).arrayBuffer());
  const file = `out/commit-samples/${sport}.jpg`;
  writeFileSync(file, img);
  console.log(`ok ${((Date.now() - t0) / 1000).toFixed(1)}s  ${(img.length / 1024).toFixed(0)}kB  ref=${data.referenceUsed ? basename(data.referenceUsed) : "none"}`);
  results.push({ sport, file: `${sport}.jpg`, ref: data.referenceUsed, spec: data.referenceSpecApplied });
}

writeFileSync("out/commit-samples/index.html", `<!doctype html><meta charset=utf-8>
<title>Commit samples</title>
<style>body{background:#0a0c12;color:#c8cedb;font:15px/1.6 system-ui;margin:0;padding:26px}
h1{color:#fff;font-size:20px;margin:0 0 6px}p{color:#79808f;margin:0 0 22px;font-size:14px}
.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:18px}
figure{margin:0}img{width:100%;border-radius:10px;display:block;background:#141824}
figcaption{font:12px/1.5 ui-monospace,monospace;color:#79808f;margin-top:7px}
.err{color:#e08b6d}</style>
<h1>Commitment generation samples</h1>
<p>One generation per sport, same identity photo, through the deployed generate-scene.</p>
<div class=g>${results.map(r => r.file
  ? `<figure><img src="${r.file}" alt="${r.sport}"><figcaption>${r.sport}${r.ref ? ` · ref ${basename(r.ref)}` : ""}${r.spec ? " · spec" : ""}</figcaption></figure>`
  : `<figure><figcaption class=err>${r.sport} — ${r.error}</figcaption></figure>`).join("")}</div>`);

console.log(`\n${results.filter(r => r.file).length}/${sports.length} generated → out/commit-samples/index.html`);
