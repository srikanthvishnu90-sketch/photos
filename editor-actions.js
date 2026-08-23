// Integration boundaries for the photo editor. The local demo updates versions
// immediately; production editing and export services can attach here later.
export const editorActions = Object.freeze({
  requestEdit(prompt, sourceVersion) {
    // TODO: send the prompt and source version to the image editing service.
    console.info("TODO: Request photo edit", prompt, sourceVersion);
  },

  selectManualTool(tool) {
    // TODO: activate the corresponding native canvas tool.
    console.info("TODO: Select manual editor tool", tool);
  },

  completeEdit(version) {
    // TODO: persist the selected version to the user's library and Studio.
    console.info("TODO: Complete photo edit", version);
  },
});
