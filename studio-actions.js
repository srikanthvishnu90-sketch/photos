// Integration boundaries for projects and templates. Persisted project data,
// exports, and creation services can attach here without changing the Studio UI.
// Engagement signals land in Supabase taste_events (no-op when signed out).
import { recordTasteEvent } from "./gems-supabase.js";

export const studioActions = Object.freeze({
  createProject() {
    // TODO: open the production project-creation flow (projects table is ready).
    recordTasteEvent("project_create_tapped", {});
  },

  openProject(project) {
    // TODO: open the matching saved project and restore its editing state.
    recordTasteEvent("project_opened", { projectId: project.id, name: project.name });
  },

  startTemplate(template) {
    // TODO: create a project from the selected template (kind='template').
    recordTasteEvent("template_started", { template: template.name });
  },

  chooseFilter(filter) {
    recordTasteEvent("studio_filter_chosen", { filter });
  },

  selectTab(tab) {
    recordTasteEvent("tab_selected", { tab, from: "Studio" });
  },
});
