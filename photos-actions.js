// Integration boundaries for the intelligent photo library. The UI can remain
// unchanged when native photo import, semantic search, and editing are attached.
export const photosActions = Object.freeze({
  importPhotos() {
    // TODO: open the native photo picker after library permissions are connected.
    console.info("TODO: Import photos");
  },

  search(query) {
    // TODO: send natural-language photo searches to the media index.
    console.info("TODO: Search photos", query);
  },

  openCollection(collection) {
    // TODO: load the complete smart collection from the media index.
    console.info("TODO: Open smart collection", collection);
  },

  runPhotoAction(action, photoId) {
    // TODO: route the photo into the matching editor or conversation workflow.
    console.info("TODO: Run photo action", action, photoId);
  },

  selectTab(tab) {
    // TODO: connect Studio when that route is built.
    console.info("TODO: Select tab", tab);
  },
});
