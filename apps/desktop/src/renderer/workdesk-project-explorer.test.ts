import { describe, expect, it } from "vitest";
import { workdeskProjectShortcutsForRoot } from "./workdesk-project-explorer";

const projects = [
  { projectIdentityId: "11111111-1111-4111-8111-111111111111", title: "Available", available: true },
  { projectIdentityId: "22222222-2222-4222-8222-222222222222", title: "遠いProject", available: false }
] as const;

describe("Workdesk Project Explorer shortcuts", () => {
  it("shows the Workdesk index entries as virtual root children without dropping unavailable registrations", () => {
    expect(workdeskProjectShortcutsForRoot({ workdesk: { documentId: "workdesk-doc" }, projects }, "workdesk-doc"))
      .toEqual(projects.map((project) => ({ ...project, kind: "project-shortcut" })));
  });

  it("does not show Workdesk shortcuts in a child Project Explorer or without an active Workdesk", () => {
    expect(workdeskProjectShortcutsForRoot({ workdesk: { documentId: "workdesk-doc" }, projects }, "project-doc")).toEqual([]);
    expect(workdeskProjectShortcutsForRoot(null, "workdesk-doc")).toEqual([]);
  });
});
