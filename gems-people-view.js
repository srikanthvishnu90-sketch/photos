// gems-people-view.js — the "People" studio. Scans the library for faces
// on-device (face-api.js via gems-faces.js), clusters them into people, and lets
// the user name a cluster and mark one as "me" — which is what makes "best photos
// of me" work in search. All processing is local; only numeric embeddings persist.
// Self-contained overlay; never throws.
import { listPhotos, getPhotoBlob } from "./gems-photolib.js";
import { loadBitmap } from "./gems-canvas.js";
import {
  canRecognizeFaces, enrollBatch, listPeople, namePerson, markMe,
  photoIdsForPerson, clearFaceData,
} from "./gems-faces.js";

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const SCAN_BATCH = 60; // photos per "Scan" tap (face-api is heavy)

export async function openPeopleStudio() {
  if (typeof document === "undefined") return;
  document.querySelector(".people-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.className = "people-overlay commit-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  document.body.append(overlay);
  const close = () => overlay.remove();

  const state = { people: [], photos: [], scanning: false, scanned: 0, done: false };

  try { state.photos = await listPhotos(); } catch { state.photos = []; }
  const urlFor = (id) => state.photos.find((p) => p.id === id)?.url ?? "";

  async function refreshPeople() {
    try { state.people = await listPeople(); } catch { state.people = []; }
    // Attach a representative photo url to each person for the thumbnail.
    for (const person of state.people) {
      try {
        const ids = await photoIdsForPerson(person.id);
        person.count = ids.length;
        person.thumb = urlFor(ids[0]);
      } catch {
        person.count = person.size;
        person.thumb = "";
      }
    }
  }

  async function loadBitmapFor(photoId) {
    const blob = await getPhotoBlob(photoId);
    return blob ? loadBitmap(blob) : null;
  }

  async function scan() {
    if (state.scanning) return;
    if (!canRecognizeFaces()) {
      render(`Face recognition isn't available in this browser.`);
      return;
    }
    state.scanning = true;
    render();
    const ids = state.photos.map((p) => p.id);
    const status = overlay.querySelector("[data-people-status]");
    if (status) status.textContent = "Loading the face model…";
    try {
      const result = await enrollBatch(ids, loadBitmapFor, SCAN_BATCH);
      state.scanned += result.scanned;
      await refreshPeople();
      state.done = true;
    } catch (error) {
      console.info("face scan failed", error);
    }
    state.scanning = false;
    render();
  }

  function render(note = "") {
    const hasPeople = state.people.length > 0;
    overlay.innerHTML = `
      <header class="commit-topbar">
        <h2 class="commit-title">People</h2>
        <button class="commit-close" type="button" aria-label="Close">✕</button>
      </header>
      <div class="commit-body">
        <p class="commit-hint">Gems finds the faces in your photos <strong>on your device</strong> and groups them into people. Nothing about your face ever leaves your phone. Tag yourself once and "best photos of me" just works.</p>

        ${
          hasPeople
            ? `<div class="people-grid">
                ${state.people.map((p) => `
                  <div class="people-card${p.isMe ? " is-me" : ""}" data-person="${esc(p.id)}">
                    <div class="people-thumb">${p.thumb ? `<img src="${esc(p.thumb)}" alt="" loading="lazy">` : "🙂"}</div>
                    <input class="people-name" data-name="${esc(p.id)}" type="text" maxlength="40" placeholder="Add a name" value="${esc(p.name)}" />
                    <div class="people-meta">${p.count ?? p.size} photo${(p.count ?? p.size) === 1 ? "" : "s"}</div>
                    <button class="people-me${p.isMe ? " is-active" : ""}" data-me="${esc(p.id)}" type="button">${p.isMe ? "✓ This is me" : "This is me"}</button>
                  </div>
                `).join("")}
              </div>`
            : `<p class="commit-hint">${state.done ? "No faces found in the scanned photos yet." : "Tap Scan to find the people in your camera roll."}</p>`
        }

        <button class="commit-btn commit-btn--primary" data-scan type="button" ${state.scanning ? "disabled" : ""}>
          ${state.scanning ? "Scanning…" : hasPeople ? "Scan more photos" : "Scan my photos for faces"}
        </button>
        ${hasPeople ? `<button class="commit-btn" data-clear type="button">Clear all face data</button>` : ""}
        <p class="commit-status" data-people-status>${esc(note || (state.scanned ? `Scanned ${state.scanned} photos.` : ""))}</p>
        <p class="commit-note">Requires sign-in and your real photos imported. Faces are matched with a model that runs in your browser.</p>
      </div>
    `;
    overlay.querySelector(".commit-close")?.addEventListener("click", close);
    overlay.querySelector("[data-scan]")?.addEventListener("click", () => void scan());
    overlay.querySelector("[data-clear]")?.addEventListener("click", async () => {
      await clearFaceData();
      state.people = [];
      state.done = false;
      state.scanned = 0;
      render("Face data cleared.");
    });
    overlay.querySelectorAll("[data-name]").forEach((input) =>
      input.addEventListener("change", () => void namePerson(input.dataset.name, input.value)),
    );
    overlay.querySelectorAll("[data-me]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        await markMe(btn.dataset.me);
        await refreshPeople();
        render("Tagged. 'Best photos of me' will now find you.");
      }),
    );
  }

  await refreshPeople();
  state.done = state.people.length > 0;
  render();

  window.addEventListener("keydown", function onKey(e) {
    if (e.key === "Escape") { close(); window.removeEventListener("keydown", onKey); }
  });
}
