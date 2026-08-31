// gems-modal-a11y.js — making an overlay genuinely modal.
//
// `role="dialog"` + `aria-modal="true"` is a PROMISE to assistive tech, not a
// mechanism. Without inerting the rest of the page, Tab still walks straight out
// of the overlay into the screen behind it — measured in the scene studio as 14
// of 25 tab stops landing on the buttons underneath.
//
// The inerted elements are MARKED with an attribute rather than captured in a
// closure, so any teardown path can release them. That matters: overlays here
// are sometimes torn down by a bare `.remove()` from a different code path, and
// a closure-based release would leave the whole app permanently inert with no
// overlay on screen.

const FLAG = "data-gems-inert-backdrop";

/**
 * Make every top-level element except `keep` inert while a modal is open.
 * Safe to call repeatedly; it releases any previous inerting first.
 * @param {Element} keep the overlay element that must stay interactive
 */
export function inertBackdrop(keep) {
  if (typeof document === "undefined") return;
  releaseBackdrop();
  for (const el of Array.from(document.body.children)) {
    // Skip anything already inert for its own reasons — releasing later must
    // not turn something back on that we did not turn off.
    if (el === keep || el.inert) continue;
    el.inert = true;
    el.setAttribute("aria-hidden", "true");
    el.setAttribute(FLAG, "");
  }
}

/** Undo inertBackdrop. Idempotent, and safe to call when nothing is inert. */
export function releaseBackdrop() {
  if (typeof document === "undefined") return;
  for (const el of Array.from(document.querySelectorAll(`[${FLAG}]`))) {
    el.inert = false;
    el.removeAttribute("aria-hidden");
    el.removeAttribute(FLAG);
  }
}

/**
 * Keep Tab inside `dialog` and close it on Escape.
 *
 * Escape is bound at the DOCUMENT, not the dialog: tapping non-focusable
 * content inside a sheet (a paragraph, an image) moves focus to <body>, and a
 * dialog-bound handler then never fires.
 *
 * @param {HTMLElement} dialog
 * @param {() => void} onClose
 * @returns {() => void} cleanup — must be called when the dialog is torn down
 */
export function trapFocus(dialog, onClose) {
  if (typeof document === "undefined" || !dialog) return () => {};
  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]),' +
    ' textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const items = () =>
    Array.from(dialog.querySelectorAll(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );

  const onKeydown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose?.();
      return;
    }
    if (event.key !== "Tab") return;
    const list = items();
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;
    // Focus outside the dialog (body, or the page behind) — pull it back in.
    if (!dialog.contains(active)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  document.addEventListener("keydown", onKeydown);
  return () => document.removeEventListener("keydown", onKeydown);
}
