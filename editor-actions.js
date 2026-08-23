// Integration boundaries for the photo editor. The local demo updates versions
// immediately; production editing and export services can attach here later.
// Edit choices are the strongest taste signals — they land in taste_events.
import { recordTasteEvent } from "./gems-supabase.js";

export const editorActions = Object.freeze({
  requestEdit(prompt, sourceVersion) {
    // TODO: send the prompt and source version to the image editing service.
    recordTasteEvent(
      prompt === "Try another result" ? "edit_rerolled" : "edit_requested",
      { prompt, sourceVersion },
    );
  },

  selectManualTool(tool) {
    // TODO: activate the corresponding native canvas tool.
    recordTasteEvent("manual_tool_selected", { tool });
  },

  manualEditApplied(tool) {
    // A client-side manual edit (crop / adjust / filter grade) was committed to
    // a new version — the strongest hands-on taste signal.
    recordTasteEvent("manual_edit_applied", { tool });
  },

  editResultShown(kind, model) {
    // A real edited result reached the canvas — records which model served it.
    recordTasteEvent("edit_result_shown", { kind, model });
  },

  completeEdit(version) {
    // TODO: persist the selected version to the user's library and Studio.
    recordTasteEvent("edit_accepted", { version });
  },
});
