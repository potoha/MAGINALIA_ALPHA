import { describe, expect, it } from "vitest";
import { restoreRememberedWorkdeskContext, shouldPromptForPrimaryWorkdesk } from "./workdesk-startup";
import type { WorkdeskOpened } from "../workdesk-ipc";

describe("primary Workdesk startup", () => {
  it("offers folder selection only for the normal first-run restore result", () => {
    expect(shouldPromptForPrimaryWorkdesk("none", true)).toBe(true);
    expect(shouldPromptForPrimaryWorkdesk("opened", true)).toBe(false);
    expect(shouldPromptForPrimaryWorkdesk("error", true)).toBe(false);
    expect(shouldPromptForPrimaryWorkdesk("none", false)).toBe(false);
  });
});

describe("remembered Workdesk context startup", () => {
  const projectIdentityId = "33333333-3333-4333-8333-333333333333";
  const openedHome: WorkdeskOpened = {
    kind: "opened",
    workdesk: { workdeskIdentityId: "11111111-1111-4111-8111-111111111111", documentId: "desk-doc", title: "Home" },
    project: { projectId: "desk-doc", displayName: "Home" },
    files: [],
    projects: [],
    lastActiveContext: { kind: "home" },
  };

  it("activates Home before reopening the remembered registered Project", async () => {
    const order: string[] = [];
    const projectResult = {
      kind: "opened" as const,
      project: {
        kind: "opened" as const,
        project: { projectId: "project-doc", displayName: "Project A" },
        files: [],
      },
      node: { projectIdentityId, title: "Project A", available: true },
    };
    const result = await restoreRememberedWorkdeskContext({
      ...openedHome,
      lastActiveContext: { kind: "project", projectIdentityId },
    }, {
      activateHome: async () => { order.push("home"); return true; },
      openProject: async (request) => {
        order.push(`open:${request.workdeskIdentityId}:${request.projectIdentityId}`);
        return projectResult;
      },
      activateProject: async () => { order.push("project"); return true; },
      showError: (message) => order.push(`error:${message}`),
    });

    expect(order).toEqual([
      "home",
      `open:${openedHome.workdesk.workdeskIdentityId}:${projectIdentityId}`,
      "project",
    ]);
    expect(result).toEqual({ kind: "project" });
  });

  it("keeps the Workdesk open and explains an unavailable remembered Project", async () => {
    const order: string[] = [];
    const result = await restoreRememberedWorkdeskContext({
      ...openedHome,
      lastActiveContext: { kind: "project", projectIdentityId },
    }, {
      activateHome: async () => { order.push("home"); return true; },
      openProject: async () => ({ kind: "error", code: "invalid-project", message: "Project A is unavailable." }),
      activateProject: async () => { order.push("project"); return true; },
      showError: (message) => order.push(`error:${message}`),
    });

    expect(result.kind).toBe("home-fallback");
    expect(order).toEqual(["home", "error:The last Project could not be restored. The Workdesk is open. Project A is unavailable."]);
  });
});
