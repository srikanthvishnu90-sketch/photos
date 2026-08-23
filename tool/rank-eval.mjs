#!/usr/bin/env node
// rank-photos eval harness (docs/rank-photos.md — the acceptance test).
//
// Usage:
//   GEMINI_API_KEY=... node tool/rank-eval.mjs [--photos eval/photos] [--expected eval/expected.json]
//
// eval/expected.json shape:
//   {
//     "aesthetics": ["Dark Gym", "Streetwear"],
//     "purposes": {
//       "general": { "request": "my best photos", "expected_top5": ["dark1.jpg", ...] },
//       "cover":   { "request": "cover for a gym dump", "expected_top5": [...] },
//       "dating":  { "request": "dating profile picks", "expected_top5": [...] }
//     },
//     "expected_last": ["blurry-accident.jpg"]   // must land in the bottom 3
//   }
//
// Pass A results are cached in eval/.pass-a-cache.json (a photo is described
// once, ever — same rule as production). Delete the cache after changing
// PASS_A_PROMPT.
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { PASS_A_PROMPT, buildPassBPrompt } from "../supabase/functions/rank-photos/prompts.js";

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : args[index + 1];
};
const PHOTOS_DIR = argValue("--photos", "eval/photos");
const EXPECTED_PATH = argValue("--expected", "eval/expected.json");
const CACHE_PATH = "eval/.pass-a-cache.json";
const BATCH = 14;

if (!API_KEY) {
  console.error("GEMINI_API_KEY is required");
  process.exit(1);
}

async function callGemini(parts) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { response_mime_type: "application/json", temperature: 0.2 },
      }),
    },
  );
  if (!response.ok) throw new Error(`gemini ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  const start = text.indexOf("{");
  return JSON.parse(text.slice(start, text.lastIndexOf("}") + 1));
}

function mimeFor(name) {
  if (/\.png$/i.test(name)) return "image/png";
  if (/\.webp$/i.test(name)) return "image/webp";
  if (/\.heic$/i.test(name)) return "image/heic";
  return "image/jpeg";
}

async function describeAll(files) {
  let cache = {};
  try {
    cache = JSON.parse(await readFile(CACHE_PATH, "utf8"));
  } catch {
    /* no cache yet */
  }
  const uncached = files.filter((file) => !cache[basename(file)]);
  for (let offset = 0; offset < uncached.length; offset += BATCH) {
    const batch = uncached.slice(offset, offset + BATCH);
    const parts = [{ text: PASS_A_PROMPT }];
    for (const [index, file] of batch.entries()) {
      parts.push({ text: `Image ${index}:` });
      parts.push({
        inline_data: {
          mime_type: mimeFor(file),
          data: (await readFile(file)).toString("base64"),
        },
      });
    }
    const result = await callGemini(parts);
    for (const photo of result.photos ?? []) {
      const file = batch[photo.index];
      if (file) cache[basename(file)] = photo;
    }
    console.log(`Pass A: described ${Math.min(offset + BATCH, uncached.length)}/${uncached.length} new photos`);
  }
  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2));
  return files.map((file) => ({ file: basename(file), ...cache[basename(file)] }));
}

function overlapAt5(rankedNames, expected) {
  const top5 = new Set(rankedNames.slice(0, 5));
  return expected.filter((name) => top5.has(name)).length;
}

const expectedConfig = JSON.parse(await readFile(EXPECTED_PATH, "utf8"));
await mkdir(PHOTOS_DIR, { recursive: true }).catch(() => {});
const files = (await readdir(PHOTOS_DIR))
  .filter((name) => /\.(jpe?g|png|webp|heic)$/i.test(name))
  .sort()
  .map((name) => join(PHOTOS_DIR, name));
if (!files.length) {
  console.error(`No photos in ${PHOTOS_DIR} — add ~30 personal test photos (include dark aesthetic shots deliberately).`);
  process.exit(1);
}
console.log(`${files.length} photos in the test set`);

const described = await describeAll(files);
let totalScore = 0;
let totalPossible = 0;

for (const [purpose, config] of Object.entries(expectedConfig.purposes ?? {})) {
  const descriptions = described.map((entry, index) => ({ ...entry, index }));
  const result = await callGemini([
    {
      text: buildPassBPrompt({
        request: config.request,
        purpose,
        userAesthetics: expectedConfig.aesthetics ?? [],
        tasteSummary: expectedConfig.taste_summary ?? "",
        descriptions,
      }),
    },
  ]);
  const ranking = [...(result.ranking ?? [])].sort((a, b) => b.score - a.score);
  const rankedNames = ranking.map((entry) => described[entry.index]?.file).filter(Boolean);
  const overlap = overlapAt5(rankedNames, config.expected_top5 ?? []);
  totalScore += overlap;
  totalPossible += Math.min(5, (config.expected_top5 ?? []).length);
  console.log(`\n${purpose} ("${config.request}") — overlap@5: ${overlap}/${Math.min(5, (config.expected_top5 ?? []).length)}`);
  console.log(`  top 5: ${rankedNames.slice(0, 5).join(", ")}`);

  const expectedLast = expectedConfig.expected_last ?? [];
  if (expectedLast.length) {
    const bottom3 = new Set(rankedNames.slice(-3));
    const caught = expectedLast.filter((name) => bottom3.has(name));
    console.log(`  blurry accidents in bottom 3: ${caught.length}/${expectedLast.length} ${caught.length === expectedLast.length ? "PASS" : "FAIL"}`);
  }
}

console.log(`\nTOTAL overlap@5: ${totalScore}/${totalPossible}`);
