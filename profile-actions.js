// Integration boundaries for account, sharing, settings, and billing. The
// prototype keeps these actions local so production services can attach later.
// Engagement signals land in Supabase taste_events (no-op when signed out).
import { getSupabase, recordTasteEvent } from "./gems-supabase.js";

export const profileActions = Object.freeze({
  shareTasteProfile(profile) {
    // TODO: generate and present the shareable taste-profile card.
    recordTasteEvent("taste_profile_share_tapped", { profile });
  },

  openSetting(setting) {
    // TODO: route to the matching native settings screen.
    recordTasteEvent("setting_opened", { setting });
  },

  openPlus() {
    recordTasteEvent("paywall_impression", { plan: "plus" });
  },

  startTrial() {
    // TODO: attach App Store subscription purchase flow.
    recordTasteEvent("trial_start_tapped", { plan: "plus" });
  },

  selectTab(tab) {
    recordTasteEvent("tab_selected", { tab, from: "Profile" });
  },

  // Ends the Supabase session (when one exists) and restarts the app at
  // the splash, which also resets the demo flow.
  async signOut() {
    try {
      const supabase = await getSupabase();
      if (supabase) await supabase.auth.signOut();
    } catch (error) {
      console.info("Sign out finished locally", error);
    }
    window.location.reload();
  },
});
