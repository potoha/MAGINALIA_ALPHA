import { describe, expect, it } from "vitest";
import { CENTRAL_SERVICE_VIEW_MANIFEST, WORKBENCH_VIEW_MANIFEST } from "./workbench-views";

describe("Workbench view manifest", () => {
  it("exposes Project, Shelf, Menu, and document Properties in the normal Workbench", () => {
    expect(WORKBENCH_VIEW_MANIFEST.map((view) => view.id)).toEqual(["workspace", "library", "menu", "properties"]);
    expect(WORKBENCH_VIEW_MANIFEST.map((view) => view.title)).toEqual(["Project", "Shelf", "Menu", "Properties"]);
    expect(WORKBENCH_VIEW_MANIFEST.map((view) => view.activityButtonId)).toEqual([
      "activity-view-workspace",
      "activity-view-library",
      "activity-view-menu",
      "activity-view-properties"
    ]);
    expect(WORKBENCH_VIEW_MANIFEST.filter((view) => view.defaultRegion === "secondary-sidebar").map((view) => view.title))
      .toEqual(["Shelf", "Menu", "Properties"]);
    expect(WORKBENCH_VIEW_MANIFEST.map((view) => view.id as string)).not.toContain("repository");
  });
});

describe("central service view manifest", () => {
  it("registers Reviewer outside document tabs and Activity Bar views", () => {
    expect(CENTRAL_SERVICE_VIEW_MANIFEST).toEqual([{
      id: "reviewer",
      title: "Reviewer",
      panelId: "central-service-view",
      slotId: "reviewer-service-slot"
    }]);
    expect(WORKBENCH_VIEW_MANIFEST.map((view) => view.id)).not.toContain("reviewer");
  });
});
