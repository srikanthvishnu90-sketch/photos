// These are the integration boundaries for Discover. Real creation, library,
// aesthetic, and moodboard flows can attach here without changing the UI.
export const discoverActions = Object.freeze({
  chooseCategory(category) {
    // TODO: record Discover category engagement.
    console.info("TODO: Choose Discover category", category);
  },

  search(query) {
    // TODO: connect discovery search when the content service is available.
    console.info("TODO: Search Discover", query);
  },

  runCardAction(action, card) {
    // TODO: route the selected inspiration action into its real workflow.
    console.info("TODO: Run Discover action", action, card.id);
  },

  selectTab(tab) {
    // TODO: connect Photos and Studio when those routes are built.
    console.info("TODO: Select tab", tab);
  },
});
