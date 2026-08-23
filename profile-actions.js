// Integration boundaries for account, sharing, settings, and billing. The
// prototype keeps these actions local so production services can attach later.
export const profileActions = Object.freeze({
  shareTasteProfile(profile) {
    // TODO: generate and present the shareable taste-profile card.
    console.info("TODO: Share taste profile", profile);
  },

  openSetting(setting) {
    // TODO: route to the matching native settings screen.
    console.info("TODO: Open profile setting", setting);
  },

  openPlus() {
    // TODO: log the Gems Plus paywall impression.
    console.info("TODO: Open Gems Plus paywall");
  },

  startTrial() {
    // TODO: attach App Store subscription purchase flow.
    console.info("TODO: Start Gems Plus trial");
  },

  selectTab(tab) {
    // TODO: connect remaining tab destinations as they are built.
    console.info("TODO: Select app tab", tab);
  },
});
