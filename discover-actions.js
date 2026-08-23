// These are the integration boundaries for Discover. Real creation, library,
// aesthetic, and moodboard flows can attach here without changing the UI.
// Engagement signals land in Supabase taste_events (no-op when signed out).
import { recordTasteEvent } from "./gems-supabase.js";

export const discoverActions = Object.freeze({
  chooseCategory(category) {
    recordTasteEvent("discover_category_chosen", { category });
  },

  search(query) {
    // TODO: connect discovery search when the content service is available.
    recordTasteEvent("search_query", { surface: "discover", query });
  },

  runCardAction(action, card) {
    // TODO: route the selected inspiration action into its real workflow.
    recordTasteEvent(
      action === "Recreate this"
        ? "discover_recreate_tapped"
        : "discover_card_action",
      { action, cardId: card.id, title: card.title },
    );
  },

  selectTab(tab) {
    recordTasteEvent("tab_selected", { tab, from: "Discover" });
  },
});
