// Named presets (edit recipes) stored on-device so they work offline / in demo.
// Shared by the editor (save/apply one) and the Photos screen (batch-apply).
// A preset is { id, name, ops }, where ops is an ordered list of parametric
// edits ({ op, params }) replayable via gems-canvas.applyRecipe.

const PRESETS_KEY = "gems.presets.v1";

export function loadPresets() {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function savePresetsList(list) {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(Array.isArray(list) ? list.slice(0, 40) : []));
  } catch (error) {
    console.info("Preset save failed", error);
  }
}
