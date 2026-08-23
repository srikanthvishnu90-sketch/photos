// Integration boundaries for projects and templates. Persisted project data,
// exports, and creation services can attach here without changing the Studio UI.
export const studioActions = Object.freeze({
  createProject() {
    // TODO: open the production project-creation flow.
    console.info("TODO: Create Studio project");
  },

  openProject(project) {
    // TODO: open the matching saved project and restore its editing state.
    console.info("TODO: Open Studio project", project.id);
  },

  startTemplate(template) {
    // TODO: create a project from the selected template.
    console.info("TODO: Start Studio template", template.name);
  },

  chooseFilter(filter) {
    // TODO: record Studio filter engagement.
    console.info("TODO: Choose Studio filter", filter);
  },

  selectTab(tab) {
    // TODO: connect native analytics to primary navigation.
    console.info("TODO: Select app tab", tab);
  },
});
