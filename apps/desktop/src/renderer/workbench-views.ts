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

/**
 * Main-process-backed views occupy the central service surface, not a document
 * tab or Activity Bar region. Their identity is registered here so they cannot
 * accidentally acquire DocumentSession semantics.
 */
export interface CentralServiceViewDescriptor {
  readonly id: string;
  readonly title: string;
  readonly panelId: string;
  readonly slotId: string;
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
    id: "library",
    title: "Shelf",
    defaultRegion: "secondary-sidebar",
    activityButtonId: "activity-view-library",
    panelId: "library-navigation"
  },
  {
    id: "properties",
    title: "Properties",
    defaultRegion: "secondary-sidebar",
    activityButtonId: "activity-view-properties",
    panelId: "properties-panel"
  }
] as const satisfies readonly WorkbenchViewDescriptor[];

export const CENTRAL_SERVICE_VIEW_MANIFEST = [
  {
    id: "reviewer",
    title: "Reviewer",
    panelId: "central-service-view",
    slotId: "reviewer-service-slot"
  }
] as const satisfies readonly CentralServiceViewDescriptor[];
