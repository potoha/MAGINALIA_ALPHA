import type { WorkbenchView } from "./workbench-core";

/**
 * The Slice A view manifest is the one place where a view's meaning, default
 * region, and renderer mounting points are declared. WorkbenchCore only sees
 * the WorkbenchView part; the renderer uses the DOM fields to mount controls.
 */
export interface WorkbenchViewDescriptor extends WorkbenchView {
  activityButtonId: string;
  panelId: string;
}

export const WORKBENCH_VIEW_MANIFEST = [
  {
    id: "workspace",
    title: "Project",
    defaultRegion: "primary-sidebar",
    activityButtonId: "activity-view-workspace",
    panelId: "workspace-navigation"
  },
  {
    id: "repository",
    title: "Repository",
    defaultRegion: "primary-sidebar",
    activityButtonId: "activity-view-repository",
    panelId: "repository-navigation"
  },
  {
    id: "library",
    title: "Library",
    defaultRegion: "secondary-sidebar",
    activityButtonId: "activity-view-library",
    panelId: "library-navigation"
  }
] as const satisfies readonly WorkbenchViewDescriptor[];
