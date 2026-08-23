// Integration boundaries for the intelligent photo library. The UI can remain
// unchanged when native photo import, semantic search, and editing are attached.
// Behavioral signals land in Supabase taste_events (no-op when signed out).
import { recordTasteEvent } from "./gems-supabase.js";

export const photosActions = Object.freeze({
  importPhotos() {
    // TODO: open the native photo picker after library permissions are connected.
    recordTasteEvent("photo_import_tapped", {});
  },

  search(query) {
    // TODO: send natural-language photo searches to the media index.
    recordTasteEvent("search_query", { surface: "photos", query });
  },

  openCollection(collection) {
    recordTasteEvent("collection_opened", { collection: collection.name ?? collection });
  },

  runPhotoAction(action, photoId) {
    // TODO: route the photo into the matching editor or conversation workflow.
    recordTasteEvent("photo_action_tapped", { action, photoId });
  },

  selectTab(tab) {
    recordTasteEvent("tab_selected", { tab, from: "Photos" });
  },
});
