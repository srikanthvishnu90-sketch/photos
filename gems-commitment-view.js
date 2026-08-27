// gems-commitment-view.js — the Commitment Studio overlay. Pick your athlete
// photo + your school (from the directory) + sport/name/headline, then Gems
// generates the commitment poster. Self-contained full-screen overlay; never
// throws. The generated poster can be saved back into the library.
import { listPhotos, importPhotoFiles, getPhotoBlob } from "./gems-photolib.js";
import { searchSchools, generateCommitment, SPORTS } from "./gems-commitment.js";
import { hasMeIdentity, getMeReferences, faceDistanceToMe } from "./gems-faces.js";
import { createGenProgress } from "./gems-gen-progress.js";

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const HEADLINES = ["COMMITTED", "NEXT CHAPTER", "SIGNED"];

export async function openCommitmentStudio() {
  if (typeof document === "undefined") return;
  document.querySelector(".commit-overlay")?.remove();

  const state = { photoId: null, school: null, sport: "football", name: "", headline: "COMMITTED", busy: false, resultUrl: "", faceNote: "", gen: null };

  const overlay = document.createElement("div");
  overlay.className = "commit-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Commitment studio");
  document.body.append(overlay);

  const close = () => overlay.remove();

  let photos = [];
  try {
    photos = await listPhotos();
  } catch {
    photos = [];
  }

  const render = () => {
    overlay.innerHTML = `
      <header class="commit-topbar">
        <h2 class="commit-title">Commitment post</h2>
        <button class="commit-close" type="button" aria-label="Close">✕</button>
      </header>
      <div class="commit-body">
        ${
          state.busy
            ? `<div class="commit-result">
                 <div class="gen-stage">
                   <div class="gen-pic"></div>
                   <div class="gen-grain"></div>
                   <span class="gen-tag">AI POST${state.school ? " · " + esc(state.school.display) : ""}</span>
                   ${state.gen ? state.gen.html() : ""}
                 </div>
               </div>`
            : state.resultUrl
            ? `<div class="commit-result">
                 <img class="commit-result-img" src="${esc(state.resultUrl)}" alt="Your commitment post" />
                 ${state.faceNote ? `<p class="commit-note">${esc(state.faceNote)}</p>` : ""}
                 <div class="commit-actions">
                   <button class="commit-btn" data-again type="button">Try again</button>
                   <button class="commit-btn commit-btn--primary" data-save type="button">Save to my photos</button>
                 </div>
               </div>`
            : `
        <label class="commit-label">1 · Your athlete photo</label>
        ${
          photos.length
            ? `<div class="commit-photos">
                 ${photos.slice(0, 24).map((p) => `<button type="button" class="commit-photo${state.photoId === p.id ? " is-active" : ""}" data-photo="${esc(p.id)}"><img src="${esc(p.url)}" alt="" loading="lazy"></button>`).join("")}
               </div>`
            : `<p class="commit-hint">Import a photo first (Home → Import), then come back.</p>`
        }

        <label class="commit-label">2 · Your school</label>
        <input class="commit-input" data-school-search type="text" autocomplete="off" placeholder="Search your college…" value="${esc(state.school ? state.school.display : "")}" />
        <div class="commit-school-results" data-school-results hidden></div>

        <label class="commit-label">3 · Sport</label>
        <select class="commit-input" data-sport>
          ${SPORTS.map((s) => `<option value="${s.code}"${state.sport === s.code ? " selected" : ""}>${esc(s.label)}</option>`).join("")}
        </select>

        <label class="commit-label">4 · Your name</label>
        <input class="commit-input" data-name type="text" maxlength="40" placeholder="First Last" value="${esc(state.name)}" />

        <label class="commit-label">5 · Headline</label>
        <div class="commit-headlines">
          ${HEADLINES.map((h) => `<button type="button" class="commit-chip${state.headline === h ? " is-active" : ""}" data-headline="${h}">${h}</button>`).join("")}
        </div>

        <button class="commit-btn commit-btn--primary commit-generate" data-generate type="button" ${state.photoId && state.school && !state.busy ? "" : "disabled"}>
          ${state.busy ? "Generating your post…" : "Generate my commitment post"}
        </button>
        <p class="commit-note">Uses AI · keeps your face · your school's real colors + logo. Sign in required.</p>
        <p class="commit-status" data-status></p>`
        }
      </div>
    `;
    wire();
    // Re-bind the staged lifecycle overlay after every innerHTML rebuild.
    if (state.busy && state.gen) state.gen.attach(overlay);
  };

  function wire() {
    overlay.querySelector(".commit-close")?.addEventListener("click", close);

    overlay.querySelectorAll("[data-photo]").forEach((b) =>
      b.addEventListener("click", () => {
        state.photoId = b.dataset.photo;
        render();
      }),
    );

    const search = overlay.querySelector("[data-school-search]");
    const results = overlay.querySelector("[data-school-results]");
    let searchTimer = 0;
    search?.addEventListener("input", () => {
      state.school = null;
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(async () => {
        const rows = await searchSchools(search.value);
        if (!results) return;
        if (!rows.length) {
          results.hidden = true;
          return;
        }
        results.innerHTML = rows
          .map(
            (r) => `<button type="button" class="commit-school-row" data-school='${esc(JSON.stringify({ id: r.id, display: r.display, sports: r.sports }))}'>
              ${r.logo ? `<img src="${esc(r.logo)}" alt="">` : ""}<span>${esc(r.display)}</span></button>`,
          )
          .join("");
        results.hidden = false;
        results.querySelectorAll("[data-school]").forEach((row) =>
          row.addEventListener("click", () => {
            try {
              const picked = JSON.parse(row.dataset.school);
              state.school = picked;
              if (Array.isArray(picked.sports) && picked.sports.length && !picked.sports.includes(state.sport)) {
                state.sport = picked.sports[0];
              }
            } catch {
              /* ignore */
            }
            render();
          }),
        );
      }, 220);
    });

    overlay.querySelector("[data-sport]")?.addEventListener("change", (e) => {
      state.sport = e.target.value;
    });
    overlay.querySelector("[data-name]")?.addEventListener("input", (e) => {
      state.name = e.target.value;
    });
    overlay.querySelectorAll("[data-headline]").forEach((b) =>
      b.addEventListener("click", () => {
        state.headline = b.dataset.headline;
        render();
      }),
    );

    overlay.querySelector("[data-generate]")?.addEventListener("click", () => void generate());
    overlay.querySelector("[data-again]")?.addEventListener("click", () => {
      state.resultUrl = "";
      render();
    });
    overlay.querySelector("[data-save]")?.addEventListener("click", () => void saveResult());
  }

  async function scoreFace(url) {
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const bmp = await createImageBitmap(blob);
      const d = await faceDistanceToMe(bmp);
      bmp.close?.();
      return d;
    } catch (error) {
      console.info("face verify skipped", error);
      return null;
    }
  }

  async function generate() {
    if (state.busy || !state.photoId || !state.school) return;
    state.busy = true;
    state.faceNote = "";
    state.gen = createGenProgress({
      request: `${state.headline.toLowerCase()} — ${state.school.display}`,
      packLabel: state.school.display,
      count: 1,
    });
    render();
    const status = overlay.querySelector("[data-status]");

    // Identity-lock + verify: attach the athlete's tagged face references and
    // auto-reroll if the poster's face drifts from their real one.
    let identityPhotoIds = [];
    let verify = false;
    try {
      if (await hasMeIdentity()) {
        verify = true;
        identityPhotoIds = (await getMeReferences(4)).map((r) => r.photoId);
      }
    } catch { /* no identity → single pass */ }

    const opts = {
      photoId: state.photoId,
      identityPhotoIds,
      schoolId: state.school.id,
      sport: state.sport,
      athleteName: state.name,
      headline: state.headline,
      quality: "pro",
    };
    const MAX_ATTEMPTS = verify ? 2 : 1;
    const GOOD_DIST = 0.6; // posters stylize more; be a touch more lenient
    let best = null;
    let bestDist = Infinity;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const statusEl = overlay.querySelector("[data-status]");
      if (statusEl && attempt > 0) statusEl.textContent = "Improving the likeness…";
      const result = await generateCommitment(opts);
      if (!result?.url) { best = best || result; break; }
      if (!verify) { best = result; break; }
      const dist = await scoreFace(result.url);
      if (dist == null) { best = result; break; }
      if (dist < bestDist) { bestDist = dist; best = result; }
      if (dist <= GOOD_DIST) break;
    }

    state.busy = false;
    state.gen?.stop();
    state.gen = null;
    if (best?.url) {
      state.resultUrl = best.url;
      state.faceNote =
        verify && bestDist < Infinity
          ? bestDist <= GOOD_DIST
            ? "Matched to your face ✓"
            : "Closest match — hit Try again if the face is off"
          : "";
      render();
      return;
    }
    render();
    const result = best;
    const msg = overlay.querySelector("[data-status]") || status;
    if (msg) {
      msg.textContent =
        result?.error === "signin"
          ? "Sign in to generate your commitment post."
          : result?.error === "paywall"
            ? "You've used your free generations this month — Gems Plus unlocks more."
            : result?.error === "refused"
              ? result.reply || "Use your own photo and name."
              : "That didn't generate — try again.";
    }
  }

  async function saveResult() {
    if (!state.resultUrl) return;
    try {
      const res = await fetch(state.resultUrl);
      const blob = await res.blob();
      await importPhotoFiles([new File([blob], "commitment.jpg", { type: blob.type || "image/jpeg" })]);
      const btn = overlay.querySelector("[data-save]");
      if (btn) btn.textContent = "Saved ✓";
    } catch (error) {
      console.info("save commitment failed", error);
    }
  }

  render();
  window.addEventListener("keydown", function onKey(e) {
    if (e.key === "Escape") {
      close();
      window.removeEventListener("keydown", onKey);
    }
  });
}
