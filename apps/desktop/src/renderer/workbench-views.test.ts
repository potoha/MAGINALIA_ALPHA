import { describe, expect, it } from "vitest";
import { WORKBENCH_VIEW_MANIFEST } from "./workbench-views";

describe("Workbench view manifest", () => {
  it("exposes only Project and Library in the normal Activity Bar", () => {
    expect(WORKBENCH_VIEW_MANIFEST.map((view) => view.id)).toEqual(["workspace", "library"]);
    expect(WORKBENCH_VIEW_MANIFEST.map((view) => view.title)).toEqual(["Project", "Library"]);
    expect(WORKBENCH_VIEW_MANIFEST.map((view) => view.activityButtonId)).toEqual([
      "activity-view-workspace",
      "activity-view-library"
    ]);
    expect(WORKBENCH_VIEW_MANIFEST.map((view) => view.id as string)).not.toContain("repository");
  });
});
