// These boundaries keep the authenticated Home UI independent from the
// eventual photo library, studio, profile, discovery, and AI services.
// Behavioral signals now land in Supabase taste_events (owner-only RLS,
// silent no-op when signed out); AI and native services still attach here.
import { recordTasteEvent } from "./gems-supabase.js";

export const homeActions = Object.freeze({
  openProfile() {
    recordTasteEvent("profile_opened", { from: "home" });
  },

  openGem(gemId) {
    recordTasteEvent("gem_tapped", { gemId, from: "home_carousel" });
  },

  seeAllGems() {
    recordTasteEvent("gems_see_all_tapped", { from: "home" });
  },

  startAction(action) {
    // TODO: route the selected creation intent into the AI workflow.
    recordTasteEvent("creation_intent_tapped", { action });
  },

  openDraft() {
    recordTasteEvent("draft_resumed", { from: "home" });
  },

  openHiddenGem() {
    recordTasteEvent("hidden_gem_opened", {});
  },

  openTrend(vibe) {
    recordTasteEvent("trend_tapped", { vibe });
  },

  attachPhoto() {
    // TODO: attach a photo once photo-library permissions are connected.
    recordTasteEvent("chat_attach_tapped", {});
  },

  async sendPrompt(prompt) {
    // Telemetry only — the Gems orchestrator call itself lives in home.js.
    recordTasteEvent("chat_prompt_sent", { prompt });
  },

  chatReplyShown(intent) {
    recordTasteEvent("chat_reply_shown", { intent });
  },

  selectTab(tab) {
    recordTasteEvent("tab_selected", { tab, from: "Home" });
  },
});
