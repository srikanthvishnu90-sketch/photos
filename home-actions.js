// These boundaries keep the authenticated Home UI independent from the
// eventual photo library, studio, profile, discovery, and AI services.
export const homeActions = Object.freeze({
  openProfile() {
    // TODO: navigate to profile and settings.
    console.info("TODO: Open profile");
  },

  openGem(gemId) {
    // TODO: open the ranked photo detail.
    console.info("TODO: Open gem", gemId);
  },

  seeAllGems() {
    // TODO: navigate to the complete ranked-gems collection.
    console.info("TODO: See all gems");
  },

  startAction(action) {
    // TODO: route the selected creation intent into the AI workflow.
    console.info("TODO: Start home action", action);
  },

  openDraft() {
    // TODO: open the Studio draft.
    console.info("TODO: Open draft");
  },

  openHiddenGem() {
    // TODO: open the daily rediscovered photo.
    console.info("TODO: Open hidden gem");
  },

  openTrend(vibe) {
    // TODO: navigate to the selected Discover vibe.
    console.info("TODO: Open trend", vibe);
  },

  attachPhoto() {
    // TODO: attach a photo once photo-library permissions are connected.
    console.info("TODO: Attach photo");
  },

  async sendPrompt(prompt) {
    // TODO: send the prompt to the Gems AI chat service.
    console.info("TODO: Send home prompt", prompt);
  },

  selectTab(tab) {
    // TODO: connect the tab to its matching route.
    console.info("TODO: Select tab", tab);
  },
});
