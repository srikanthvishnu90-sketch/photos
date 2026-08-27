// gems-gen-progress.js — the shared generation-lifecycle animation. Every image
// generation surface (Scene Studio, dating, commitment, chat) shows the same
// staged overlay while the model works: spinner → staged narration → progress
// bar → done. One driver instance per generation run; markup is re-attachable
// across re-renders (the host screens rebuild their DOM with innerHTML).
function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/**
 * Create a staged progress driver.
 * opts: { request (the user's words), packLabel, refNote, count }
 * API: html() → overlay markup · attach(root) → (re)bind to [data-genprog] and
 * keep animating · setImage(k, n) → narrate "image k of n" · finish() → 100% +
 * fade · stop() → clear timers.
 */
export function createGenProgress(opts = {}) {
  const request = String(opts.request || "your photo").slice(0, 120);
  const packLabel = opts.packLabel || "";
  const count = Math.max(1, opts.count | 0 || 1);
  const stages = [
    { title: "Reading your request…", sub: `“${request}”`, pct: 8 },
    { title: "Planning the scene", sub: ["Place", "camera angle", "your pose", packLabel ? `${packLabel} light` : "the light"].join(" · "), pct: 22 },
    { title: "Matching real reference photos", sub: opts.refNote || "A real photo of the place anchors the look", pct: 40 },
    { title: "Generating", sub: "Realism layer on: iPhone framing, real textures, no AI gloss", pct: 62 },
    { title: "Finishing touches", sub: "Identity check · provenance kept with the file", pct: 92 },
  ];
  let index = 0;
  let pct = stages[0].pct;
  let imageNote = "";
  let done = false;
  let root = null;
  let timer = null;

  function current() {
    const s = stages[Math.min(index, stages.length - 1)];
    const sub = index >= 3 && imageNote ? imageNote : s.sub;
    return { title: done ? "Done" : s.title, sub: done ? "Here it is." : sub, pct: done ? 100 : pct };
  }

  function paint() {
    if (!root || !root.isConnected) return;
    const c = current();
    const t = root.querySelector("[data-genp-stage]");
    const s = root.querySelector("[data-genp-sub]");
    const b = root.querySelector("[data-genp-bar]");
    if (t) t.textContent = c.title;
    if (s) s.textContent = c.sub;
    if (b) b.style.transform = `scaleX(${c.pct / 100})`;
    if (done) root.classList.add("is-done");
  }

  function tick() {
    if (done) return;
    if (index < 3) {
      index += 1;
      pct = stages[index].pct;
    } else if (pct < 92) {
      // The model is actually working now — creep so it always feels alive.
      pct = Math.min(92, pct + (count > 1 ? 1 : 2));
      if (pct >= stages[4].pct) index = 4;
    }
    paint();
  }

  return {
    html() {
      const c = current();
      return `<div class="genp${done ? " is-done" : ""}" data-genprog>
        <div class="genp-spinner" aria-hidden="true"></div>
        <div class="genp-stage" data-genp-stage>${esc(c.title)}</div>
        <div class="genp-sub" data-genp-sub>${esc(c.sub)}</div>
        <div class="genp-bar"><i data-genp-bar style="transform:scaleX(${c.pct / 100})"></i></div>
      </div>`;
    },
    attach(host) {
      root = host?.querySelector?.("[data-genprog]") || null;
      paint();
      if (!timer) timer = window.setInterval(tick, 950);
    },
    setImage(k, n) {
      if (n > 1) {
        imageNote = `Image ${k} of ${n} — each one is its own scene`;
        if (index < 3) { index = 3; pct = stages[3].pct; }
        paint();
      }
    },
    finish() {
      done = true;
      paint();
      if (timer) { window.clearInterval(timer); timer = null; }
    },
    stop() {
      if (timer) { window.clearInterval(timer); timer = null; }
    },
  };
}
