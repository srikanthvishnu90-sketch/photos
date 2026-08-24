// gems-board-view.js — the inspiration board viewer. A full-screen masonry
// overlay of everything the user has pinned (their own photos + Discover looks),
// so they can browse it like a Pinterest board and jump a pinned photo straight
// into the editor. Self-contained: appends its own overlay to <body>, reads from
// gems-board.js, and cleans up on close. Never throws.

import { listBoardItems, removeFromBoard } from "./gems-board.js";

function esc(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
  );
}

function itemMarkup(item) {
  const media = item.url
    ? `<img class="board-pin-photo" src="${esc(item.url)}" alt="" loading="lazy" decoding="async" />`
    : `<span class="board-pin-scene board-scene-${esc(item.scene || "default")}" aria-hidden="true"></span>`;
  const caption = item.title
    ? `<span class="board-pin-caption">${esc(item.title)}</span>`
    : "";
  return `
    <figure class="board-pin" data-pin-id="${esc(item.id)}" data-pin-photo="${esc(item.photoId ?? "")}">
      <button class="board-pin-open" type="button" aria-label="Open pin">
        ${media}
        ${caption}
      </button>
      <button class="board-pin-remove" type="button" aria-label="Remove from board" data-pin-remove>
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2 2 10"></path></svg>
      </button>
    </figure>
  `;
}

/**
 * Open the inspiration board overlay.
 * @param {{ onOpenPhoto?: (photoId: string) => void }} [options]
 */
export async function openBoardView({ onOpenPhoto = () => {} } = {}) {
  try {
    if (typeof document === "undefined") return;
    // One overlay at a time.
    document.querySelector(".board-overlay")?.remove();

    const overlay = document.createElement("div");
    overlay.className = "board-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Inspiration board");

    const close = () => {
      window.removeEventListener("keydown", onKey);
      overlay.remove();
    };
    const onKey = (event) => {
      if (event.key === "Escape") close();
    };

    let items = [];
    try {
      items = await listBoardItems();
    } catch (error) {
      console.info("Board load failed", error);
    }

    const grid = items.length
      ? `<div class="board-grid">${items.map(itemMarkup).join("")}</div>`
      : `<div class="board-empty">
           <span class="board-empty-mark" aria-hidden="true">
             <svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="7" height="9" rx="2"></rect><rect x="13.5" y="3.5" width="7" height="5.5" rx="2"></rect><rect x="13.5" y="11" width="7" height="9" rx="2"></rect><rect x="3.5" y="15" width="7" height="5" rx="2"></rect></svg>
           </span>
           <strong>Your board is empty</strong>
           <span>Pin photos (Photos → a photo → “Pin to board”) or looks from Discover to build it.</span>
         </div>`;

    overlay.innerHTML = `
      <header class="board-topbar">
        <h2 class="board-title">Inspiration board</h2>
        <span class="board-count">${items.length} pin${items.length === 1 ? "" : "s"}</span>
        <button class="board-close" type="button" aria-label="Close board">
          <svg viewBox="0 0 14 14" aria-hidden="true"><path d="M2 2l10 10M12 2 2 12"></path></svg>
        </button>
      </header>
      <div class="board-body">${grid}</div>
    `;

    overlay.querySelector(".board-close")?.addEventListener("click", close);
    // Tap a pin: open a photo pin in the editor; other pins just close.
    overlay.querySelectorAll(".board-pin-open").forEach((button) => {
      button.addEventListener("click", () => {
        const figure = button.closest("[data-pin-photo]");
        const photoId = figure?.dataset.pinPhoto;
        if (photoId) {
          close();
          onOpenPhoto(photoId);
        }
      });
    });
    // Unpin.
    overlay.querySelectorAll("[data-pin-remove]").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.stopPropagation();
        const figure = button.closest("[data-pin-id]");
        const id = figure?.dataset.pinId;
        if (!id) return;
        await removeFromBoard(id);
        figure.remove();
        const remaining = overlay.querySelectorAll(".board-pin").length;
        const count = overlay.querySelector(".board-count");
        if (count) count.textContent = `${remaining} pin${remaining === 1 ? "" : "s"}`;
        if (remaining === 0) close();
      });
    });

    document.body.append(overlay);
    window.addEventListener("keydown", onKey);
    window.requestAnimationFrame(() =>
      overlay.querySelector(".board-close")?.focus?.({ preventScroll: true }),
    );
  } catch (error) {
    console.info("openBoardView failed", error);
  }
}
