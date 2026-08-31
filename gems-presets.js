// Named presets (edit recipes) stored on-device so they work offline / in demo.
// Shared by the editor (save/apply one) and the Photos screen (batch-apply).
// A preset is { id, name, ops }, where ops is an ordered list of parametric
// edits ({ op, params }) replayable via gems-canvas.applyRecipe.

import { dbNameFor, onDbUserChange } from "./gems-db-user.js";

// Partitioned per account, like every IndexedDB store. This was the last
// on-device store still on a single global key, so two accounts sharing a
// device also shared their saved looks.
const presetsKey = () => dbNameFor("gems.presets.v1");

// Switching accounts must not leave the previous account's presets on screen.
onDbUserChange(() => {
  try { window.dispatchEvent(new CustomEvent("gems:presets-changed")); } catch { /* no window */ }
});

export function loadPresets() {
  try {
    const raw = localStorage.getItem(presetsKey());
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function savePresetsList(list) {
  try {
    localStorage.setItem(presetsKey(), JSON.stringify(Array.isArray(list) ? list.slice(0, 40) : []));
  } catch (error) {
    console.info("Preset save failed", error);
  }
}
