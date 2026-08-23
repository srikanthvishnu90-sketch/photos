#!/usr/bin/env node
// Aesthetic vocabulary analytics (run monthly).
//
// During onboarding, users pick aesthetics from an official library and may
// also type their OWN — those free-text tags land in `custom_aesthetic_events`.
// This report surfaces the custom vocabulary people actually reach for, split
// by who's typing it, so the team can decide which custom tags have earned a
// place in the official onboarding library. It only reads; it promotes nothing
// automatically — the output is a human decision aid.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node tool/aesthetic-analytics.mjs [--days 90]
//
// The SERVICE key is required (this reads across all users, bypassing RLS).
// It is read from the environment only, never hardcoded, and never printed.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : args[index + 1];
};
const DAYS = Math.max(1, Number(argValue("--days", "90")) || 90);
const TOP_N = 20;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    "Usage: SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node tool/aesthetic-analytics.mjs [--days 90]",
  );
  console.error("Both SUPABASE_URL and SUPABASE_SERVICE_KEY are required.");
  process.exit(1);
}

// Normalize a raw tag for counting: trim, collapse whitespace, lowercase.
function normalizeTerm(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function bucket(value) {
  const key = String(value ?? "").trim();
  return key || "unknown";
}

// Fetch recent custom-aesthetic rows via the PostgREST endpoint. Returns [] on
// any failure and never leaks the key into the thrown/logged message.
async function fetchRows() {
  const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString();
  const endpoint =
    `${SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/custom_aesthetic_events` +
    `?select=raw_text,gender,age_range,created_at,co_selections` +
    `&created_at=gte.${encodeURIComponent(since)}` +
    `&order=created_at.desc`;
  try {
    const response = await fetch(endpoint, {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      // Report status only — never echo headers or the key.
      throw new Error(`custom_aesthetic_events request failed: HTTP ${response.status}`);
    }
    const data = await response.json();
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error(`Could not read analytics: ${error.message}`);
    return [];
  }
}

// Count occurrences into a Map keyed by normalized term, keeping a display
// label (the first spelling seen) for each.
function tallyTerms(rows) {
  const counts = new Map();
  const labels = new Map();
  for (const row of rows) {
    const term = normalizeTerm(row?.raw_text);
    if (!term) continue;
    counts.set(term, (counts.get(term) ?? 0) + 1);
    if (!labels.has(term)) labels.set(term, String(row.raw_text).trim());
  }
  return { counts, labels };
}

function topTerms(counts, labels, limit = TOP_N) {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term, count]) => ({ term: labels.get(term) ?? term, count }));
}

function printRanking(title, ranked) {
  console.log(`\n${title}`);
  if (ranked.length === 0) {
    console.log("  (none)");
    return;
  }
  const width = String(ranked[0].count).length;
  for (const { term, count } of ranked) {
    console.log(`  ${String(count).padStart(width)}  ${term}`);
  }
}

// Group rows by a field's bucketed value, then print each group's top terms.
function printSplit(title, rows, field) {
  console.log(`\n${"=".repeat(60)}\n${title}\n${"=".repeat(60)}`);
  const groups = new Map();
  for (const row of rows) {
    const key = bucket(row?.[field]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [key, groupRows] of ordered) {
    const { counts, labels } = tallyTerms(groupRows);
    printRanking(`${field} = ${key}  (${groupRows.length} tags)`, topTerms(counts, labels));
  }
}

// Simple co-selection patterns: how often a custom tag was typed alongside
// each official/other aesthetic listed in row.co_selections (array of labels).
function printCoSelections(rows) {
  const pairs = new Map();
  let seen = 0;
  for (const row of rows) {
    const co = row?.co_selections;
    if (!Array.isArray(co) || co.length === 0) continue;
    const term = normalizeTerm(row?.raw_text);
    if (!term) continue;
    seen += 1;
    for (const other of co) {
      const key = `${term}  +  ${normalizeTerm(other)}`;
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
    }
  }
  console.log(`\n${"=".repeat(60)}\nCO-SELECTION PATTERNS\n${"=".repeat(60)}`);
  if (seen === 0) {
    console.log("  (no co_selections data in range)");
    return;
  }
  const ranked = [...pairs.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_N);
  const width = String(ranked[0][1]).length;
  for (const [pair, count] of ranked) {
    console.log(`  ${String(count).padStart(width)}  ${pair}`);
  }
}

async function main() {
  const rows = await fetchRows();
  console.log(`Aesthetic vocabulary report — last ${DAYS} days`);
  console.log(`Custom-tag events analyzed: ${rows.length}`);
  if (rows.length === 0) {
    console.log("\nNothing to report. Check the date range or that events exist.");
    return;
  }

  const { counts, labels } = tallyTerms(rows);
  printRanking(`TOP ${TOP_N} CUSTOM TERMS OVERALL`, topTerms(counts, labels));
  printSplit("BY GENDER", rows, "gender");
  printSplit("BY AGE RANGE", rows, "age_range");
  printCoSelections(rows);

  console.log(
    `\nPromotion guidance: terms with high, cross-segment counts are the` +
      ` strongest candidates to add to the official onboarding library.`,
  );
}

main();
