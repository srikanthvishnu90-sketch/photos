// Hidden-Gems Reveal — the first-run payoff.
// After a meaningful photo import, Gems analyzes the new library on-device and
// reveals "We found N gems in your camera roll", grouped by category with a
// staggered card-fan, then invites the user to "Pick the 3 most you" to seed
// their taste profile. This is the single most important retention moment.
//
// Design principles, mirrored from the rest of the client:
//   - Never throw, never block the app. Every path is try/caught.
//   - Degrade silently when analysis is unavailable (signed out) or the
//     library is empty — the overlay simply never appears.
//   - No network beyond the safe getSession/getSupabase/recordTasteEvent
//     no-ops that already degrade to nothing when signed out.
//   - Decoupled: this module reacts to the "gems:photos-imported" DOM event
//     dispatched by gems-photolib; it is never imported by the app flow.

import { listPhotos } from "./gems-photolib.js";
import { ensureDescriptions } from "./gems-ranker.js";
import { getSession, getSupabase, recordTasteEvent } from "./gems-supabase.js";

const MOUNT_ID = "gemsRevealRoot";
const SEEN_KEY = "gems_reveal_seen";
const MIN_IMPORT = 3; // only a meaningful first import earns the reveal
const MAX_GROUPS = 5;
const MAX_PER_GROUP = 6;
const MAX_CHIPS = 10;
const MAX_PICKS = 3;

// Machine vibe_tag (Pass A controlled vocabulary) → human aesthetic label.
const TAG_LABELS = Object.freeze({
  "dark-moody": "Dark & Moody",
  "low-exposure": "Dark & Moody",
  "golden-hour": "Golden Hour",
  "warm-film": "Film",
  grain: "Film",
  streetwear: "Streetwear",
  "euro-summer": "Euro Summer",
  "clean-bright": "Clean Editorial",
  editorial: "Clean Editorial",
  "flash-night": "Nightlife",
  "candid-social": "Candid",
  gym: "Dark Gym",
  luxury: "Luxury",
});

// Ordered fallback pool so "Pick the 3 most you" always has ~8-10 chips, even
// signed out when no descriptions (and thus no vibe_tags) exist.
const DEFAULT_LABELS = Object.freeze([
  "Dark & Moody",
  "Golden Hour",
  "Candid",
  "Clean Editorial",
  "Film",
  "Streetwear",
  "Nightlife",
  "Euro Summer",
  "Dark Gym",
  "Luxury",
]);

let listenerBound = false;
let revealShown = false; // module flag: at most one reveal per page session
let revealActive = false; // an overlay is currently open
let lastFocused = null; // element to restore focus to on close
let keydownHandler = null;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function hasSeen() {
  if (revealShown) return true;
  try {
    if (typeof localStorage !== "undefined" && localStorage.getItem(SEEN_KEY)) {
      return true;
    }
  } catch {
    // storage unavailable (private browsing) — fall back to the module flag
  }
  return false;
}

function markSeen() {
  revealShown = true;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(SEEN_KEY, "1");
    }
  } catch {
    // ignore — the module flag still prevents a repeat this session
  }
}

function prefersReducedMotion() {
  try {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  } catch {
    return false;
  }
}

function getMount() {
  try {
    return document.getElementById(MOUNT_ID) ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Analysis — group the imported library into non-empty categories.
// ---------------------------------------------------------------------------

function quality(record) {
  return record?.metrics?.quality ?? 0;
}

function byQualityDesc(a, b) {
  return quality(b) - quality(a);
}

function tagsOf(description) {
  const tags = description?.vibe_tags;
  return Array.isArray(tags) ? tags : [];
}

// Build the reveal model: headline count, grouped gem cards, and chip labels.
// `descriptions` is an id → Pass A description Map (may be empty when signed
// out — grouping then leans purely on on-device metrics + gem flags).
function buildModel(records, descriptions) {
  const desc = (record) => descriptions.get(record.id) ?? null;

  const groups = [];
  const seenIds = new Set();

  // Push a capped group of not-yet-shown photos under a title, if any remain.
  const pushGroup = (title, candidates, { allowRepeat = false } = {}) => {
    if (groups.length >= MAX_GROUPS) return;
    const chosen = [];
    for (const record of candidates) {
      if (!record?.url) continue; // no thumbnail → nothing to show
      if (!allowRepeat && seenIds.has(record.id)) continue;
      chosen.push(record);
      if (chosen.length >= MAX_PER_GROUP) break;
    }
    if (!chosen.length) return;
    for (const record of chosen) seenIds.add(record.id);
    groups.push({ title, photos: chosen });
  };

  const withUrl = records.filter((record) => record.url);
  const byQuality = [...withUrl].sort(byQualityDesc);

  // Best cover — Pass A best_for:cover first, else the highest quality overall.
  const covers = byQuality.filter((record) =>
    (desc(record)?.best_for ?? []).includes("cover"),
  );
  pushGroup("Best cover", covers.length ? covers : byQuality);

  // Golden hour — warm, sun-washed frames.
  pushGroup(
    "Golden hour",
    byQuality.filter((record) => {
      const tags = tagsOf(desc(record));
      return tags.includes("golden-hour") || tags.includes("warm-film");
    }),
  );

  // With friends — two or more people, or candid social energy.
  pushGroup(
    "With friends",
    byQuality.filter((record) => {
      const d = desc(record);
      return (d?.people_count ?? 0) >= 2 || tagsOf(d).includes("candid-social");
    }),
  );

  // Dark & moody — deliberate low light.
  pushGroup(
    "Dark & moody",
    byQuality.filter((record) => {
      const tags = tagsOf(desc(record));
      return tags.includes("dark-moody") || tags.includes("low-exposure");
    }),
  );

  // Ranked gems — the honest on-device gem picks (allowed to repeat, since
  // these are the headline act).
  pushGroup(
    "Ranked gems",
    byQuality.filter((record) => record.gem === true),
    { allowRepeat: true },
  );

  // Headline count: honest gem count, falling back to a top-quality tally.
  const gemCount = records.filter((record) => record.gem === true).length;
  let headlineCount = gemCount;
  if (headlineCount <= 0) {
    headlineCount = records.filter((record) => quality(record) >= 60).length;
  }
  if (headlineCount <= 0) {
    headlineCount = Math.min(records.length, MAX_PER_GROUP);
  }
  headlineCount = Math.max(1, headlineCount);

  return { headlineCount, groups, chips: buildChips(records, descriptions) };
}

// Aesthetic chips derived from the imported photos' vibe_tags, most common
// first, topped up from the default pool to ~8-10 options.
function buildChips(records, descriptions) {
  const counts = new Map();
  for (const record of records) {
    const description = descriptions.get(record.id);
    for (const tag of tagsOf(description)) {
      const label = TAG_LABELS[tag] ?? TAG_LABELS[String(tag).replace(/^other:/, "")];
      if (!label) continue;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }

  const ordered = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label]) => label);

  const labels = [];
  const push = (label) => {
    if (label && !labels.includes(label) && labels.length < MAX_CHIPS) {
      labels.push(label);
    }
  };
  for (const label of ordered) push(label);
  for (const label of DEFAULT_LABELS) push(label);
  return labels;
}

// ---------------------------------------------------------------------------
// Overlay lifecycle
// ---------------------------------------------------------------------------

function focusableEls(root) {
  try {
    return [...root.querySelectorAll("button:not([disabled])")].filter(
      (el) => el.offsetParent !== null,
    );
  } catch {
    return [];
  }
}

function trapFocus(overlay, event) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeReveal("dismissed");
    return;
  }
  if (event.key !== "Tab") return;
  const els = focusableEls(overlay);
  if (!els.length) return;
  const first = els[0];
  const last = els[els.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !overlay.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

function closeReveal(reason) {
  if (!revealActive) return;
  revealActive = false;
  const mount = getMount();
  try {
    if (mount) mount.innerHTML = "";
  } catch {
    // ignore
  }
  try {
    if (keydownHandler) {
      document.removeEventListener("keydown", keydownHandler, true);
    }
  } catch {
    // ignore
  }
  keydownHandler = null;
  try {
    if (lastFocused && typeof lastFocused.focus === "function") {
      lastFocused.focus({ preventScroll: true });
    }
  } catch {
    // ignore
  }
  lastFocused = null;
  try {
    if (reason) recordTasteEvent("reveal_" + reason, {});
  } catch {
    // ignore
  }
}

function skipMarkup() {
  return `<button class="reveal-skip" type="button" data-reveal-skip>Skip</button>`;
}

function analyzingMarkup() {
  return `
    <div class="reveal-scrim" aria-hidden="true"></div>
    <div class="reveal-panel reveal-panel-analyzing">
      ${skipMarkup()}
      <div class="reveal-analyzing">
        <span class="reveal-spinner" aria-hidden="true"></span>
        <p class="reveal-analyzing-copy">Analyzing your camera roll…</p>
      </div>
    </div>
  `;
}

function groupMarkup(group, groupIndex) {
  const cards = group.photos
    .map((record, index) => {
      const delay = 120 + groupIndex * 90 + index * 70;
      return `
        <span class="reveal-card" style="--reveal-delay:${delay}ms">
          <img
            class="reveal-card-img"
            src="${escapeHtml(record.url)}"
            alt="${escapeHtml(record.name ?? "Photo")}"
            loading="lazy"
            decoding="async"
          />
        </span>
      `;
    })
    .join("");
  return `
    <section class="reveal-group">
      <h3 class="reveal-group-title">${escapeHtml(group.title)}</h3>
      <div class="reveal-fan">${cards}</div>
    </section>
  `;
}

function gemsMarkup(model) {
  const n = model.headlineCount;
  const noun = n === 1 ? "gem" : "gems";
  const groups = model.groups
    .map((group, index) => groupMarkup(group, index))
    .join("");
  return `
    <div class="reveal-scrim" aria-hidden="true"></div>
    <div class="reveal-panel reveal-panel-gems">
      ${skipMarkup()}
      <header class="reveal-head">
        <p class="reveal-eyebrow">Camera roll, analyzed on your device</p>
        <h2 id="revealTitle" class="reveal-headline" tabindex="-1">
          We found <span class="reveal-count">${escapeHtml(String(n))}</span> ${noun}
        </h2>
        <p class="reveal-sub">The best of what you already shot — grouped and ready.</p>
      </header>
      <div class="reveal-groups">${groups}</div>
      <div class="reveal-actions">
        <button class="reveal-primary" type="button" data-reveal-continue>
          Pick the 3 most you
        </button>
      </div>
    </div>
  `;
}

function chipsMarkup(chips) {
  return chips
    .map(
      (label) => `
        <button
          class="reveal-chip"
          type="button"
          data-reveal-chip="${escapeHtml(label)}"
          aria-pressed="false"
        >${escapeHtml(label)}</button>
      `,
    )
    .join("");
}

function pickMarkup(model) {
  return `
    <div class="reveal-scrim" aria-hidden="true"></div>
    <div class="reveal-panel reveal-panel-pick">
      ${skipMarkup()}
      <header class="reveal-head">
        <p class="reveal-eyebrow">Seed your taste</p>
        <h2 id="revealTitle" class="reveal-headline" tabindex="-1">Pick the 3 most you</h2>
        <p class="reveal-sub">
          Tap up to three. Gems learns what you love and ranks every future roll for it.
        </p>
      </header>
      <div class="reveal-chips" role="group" aria-label="Aesthetic tags">
        ${chipsMarkup(model.chips)}
      </div>
      <p class="reveal-counter" data-reveal-counter aria-live="polite">Choose up to ${MAX_PICKS}</p>
      <div class="reveal-actions">
        <button class="reveal-primary" type="button" data-reveal-done>Done</button>
      </div>
    </div>
  `;
}

function openOverlay(html, { labelTitle = false } = {}) {
  const mount = getMount();
  if (!mount) return null;
  try {
    lastFocused = document.activeElement;
  } catch {
    lastFocused = null;
  }
  mount.innerHTML = `
    <div
      class="reveal-overlay"
      role="dialog"
      aria-modal="true"
      ${labelTitle ? 'aria-labelledby="revealTitle"' : 'aria-label="Hidden gems from your camera roll"'}
    >
      ${html}
    </div>
  `;
  const overlay = mount.querySelector(".reveal-overlay");
  revealActive = true;

  if (!keydownHandler) {
    keydownHandler = (event) => {
      try {
        const current = mount.querySelector(".reveal-overlay");
        if (current) trapFocus(current, event);
      } catch {
        // ignore
      }
    };
    document.addEventListener("keydown", keydownHandler, true);
  }

  // Wire the always-present skip control.
  overlay?.querySelector("[data-reveal-skip]")?.addEventListener("click", () => {
    closeReveal("skipped");
  });

  return overlay;
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

function renderPickStep(model) {
  const overlay = openOverlay(pickMarkup(model), { labelTitle: true });
  if (!overlay) return;

  const picked = new Set();
  const counter = overlay.querySelector("[data-reveal-counter]");
  const chips = [...overlay.querySelectorAll("[data-reveal-chip]")];

  const syncCounter = () => {
    if (!counter) return;
    counter.textContent =
      picked.size === 0
        ? `Choose up to ${MAX_PICKS}`
        : `${picked.size} of ${MAX_PICKS} chosen`;
    counter.classList.toggle("is-full", picked.size >= MAX_PICKS);
  };

  for (const chip of chips) {
    chip.addEventListener("click", () => {
      const label = chip.getAttribute("data-reveal-chip");
      if (picked.has(label)) {
        picked.delete(label);
        chip.classList.remove("is-selected");
        chip.setAttribute("aria-pressed", "false");
      } else if (picked.size < MAX_PICKS) {
        picked.add(label);
        chip.classList.add("is-selected");
        chip.setAttribute("aria-pressed", "true");
      }
      // Dim the unselected chips once the cap is hit.
      const full = picked.size >= MAX_PICKS;
      for (const other of chips) {
        const isPicked = picked.has(other.getAttribute("data-reveal-chip"));
        other.classList.toggle("is-dimmed", full && !isPicked);
      }
      syncCounter();
    });
  }

  overlay.querySelector("[data-reveal-done]")?.addEventListener("click", () => {
    void completePicks([...picked]);
  });

  focusHeadline(overlay);
}

async function completePicks(picked) {
  // Persist best-effort, then close no matter what. Never blocks or throws.
  try {
    const session = await getSession();
    if (session) {
      const supabase = await getSupabase();
      if (supabase && picked.length) {
        const rows = picked.map((label, index) => ({
          profile_id: session.user.id,
          label,
          position: index,
        }));
        try {
          await supabase
            .from("profile_aesthetics")
            .upsert(rows, {
              onConflict: "profile_id,label",
              ignoreDuplicates: true,
            });
        } catch (error) {
          console.info("Aesthetics upsert skipped", error);
        }
      }
    }
  } catch (error) {
    console.info("Reveal completion persistence skipped", error);
  }
  try {
    recordTasteEvent("reveal_completed", { picked });
  } catch {
    // ignore
  }
  closeReveal();
}

function focusHeadline(overlay) {
  try {
    const headline = overlay.querySelector("#revealTitle");
    if (headline && typeof headline.focus === "function") {
      window.requestAnimationFrame(() =>
        headline.focus({ preventScroll: true }),
      );
    }
  } catch {
    // ignore
  }
}

function renderGemsStep(model) {
  const overlay = openOverlay(gemsMarkup(model), { labelTitle: true });
  if (!overlay) return;
  overlay
    .querySelector("[data-reveal-continue]")
    ?.addEventListener("click", () => renderPickStep(model));
  focusHeadline(overlay);
}

async function runReveal() {
  // Show the analyzing state immediately so the moment feels responsive.
  const overlay = openOverlay(analyzingMarkup());
  if (!overlay) {
    // No mount — bail without marking the app in any bad state.
    revealActive = false;
    return;
  }

  let records = [];
  let descriptions = new Map();
  try {
    records = await listPhotos();
  } catch (error) {
    console.info("Reveal listing failed", error);
    closeReveal();
    return;
  }
  if (!Array.isArray(records) || records.length === 0) {
    // Nothing to reveal (empty or unavailable library) — vanish silently.
    closeReveal();
    return;
  }

  try {
    // Best-effort: cached descriptions only when signed out. Never fatal.
    descriptions = await ensureDescriptions(records);
    if (!(descriptions instanceof Map)) descriptions = new Map();
  } catch (error) {
    console.info("Reveal descriptions skipped", error);
    descriptions = new Map();
  }

  let model;
  try {
    model = buildModel(records, descriptions);
  } catch (error) {
    console.info("Reveal grouping failed", error);
    closeReveal();
    return;
  }
  if (!model.groups.length) {
    closeReveal();
    return;
  }

  // Brief, deliberate beat on the analyzing state before the payoff.
  const beat = prefersReducedMotion() ? 0 : 650;
  window.setTimeout(() => {
    try {
      if (!revealActive) return; // user skipped during analysis
      renderGemsStep(model);
    } catch (error) {
      console.info("Reveal render failed", error);
      closeReveal();
    }
  }, beat);
}

function onPhotosImported(event) {
  try {
    const count = Number(event?.detail?.count ?? 0);
    if (!Number.isFinite(count) || count < MIN_IMPORT) return;
    if (hasSeen() || revealActive) return;
    markSeen();
    void runReveal();
  } catch (error) {
    console.info("Reveal trigger skipped", error);
  }
}

// Register the trigger. Idempotent, and guarded so importing this module in
// Node (no window) never touches a browser global at load time.
export function initReveal() {
  if (typeof window === "undefined") return;
  if (listenerBound) return;
  listenerBound = true;
  try {
    window.addEventListener("gems:photos-imported", onPhotosImported);
  } catch (error) {
    console.info("Reveal init skipped", error);
  }
}

// Self-initialize on import (index.html loads this as a module after app.js).
if (typeof window !== "undefined") {
  initReveal();
}
