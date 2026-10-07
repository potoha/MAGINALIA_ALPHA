import { describe, expect, it, vi } from "vitest";
import type { WorkdeskOpened } from "../workdesk-ipc";
import { restoreWorkdeskForReturn, WORKDESK_RETURN_RESTORE_ERROR } from "./workdesk-return";

const openedDesk = {
  kind: "opened",
  workdesk: { workdeskIdentityId: "desk-id", documentId: "desk-document", title: "Desk" },
  project: { projectId: "desk-document", displayName: "Desk" },
  files: [],
  projects: [],
  lastActiveContext: { kind: "home" }
} satisfies WorkdeskOpened;

describe("Workdesk return action", () => {
  it("restores and activates only the remembered Workdesk", async () => {
    const restore = vi.fn(async () => openedDesk);
    const activate = vi.fn(async (_result: WorkdeskOpened) => true);
    const rememberHome = vi.fn(async () => undefined);
    const showError = vi.fn();

    await restoreWorkdeskForReturn({ restore, activate, rememberHome, showError });

    expect(restore).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledWith(openedDesk);
    expect(rememberHome).toHaveBeenCalledOnce();
    expect(showError).not.toHaveBeenCalled();
  });

  it("does not remember Home when the existing dirty-session guard cancels activation", async () => {
    const restore = vi.fn(async () => openedDesk);
    const activate = vi.fn(async (_result: WorkdeskOpened) => false);
    const rememberHome = vi.fn(async () => undefined);
    const showError = vi.fn();

    await restoreWorkdeskForReturn({ restore, activate, rememberHome, showError });

    expect(activate).toHaveBeenCalledWith(openedDesk);
    expect(rememberHome).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });

  it("shows a visible recoverable error for none without opening a picker", async () => {
    const restore = vi.fn(async () => ({ kind: "none" as const }));
    const activate = vi.fn(async (_result: WorkdeskOpened) => true);
    const rememberHome = vi.fn(async () => undefined);
    const showError = vi.fn();

    await restoreWorkdeskForReturn({ restore, activate, rememberHome, showError });

    expect(restore).toHaveBeenCalledOnce();
    expect(activate).not.toHaveBeenCalled();
    expect(rememberHome).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledWith(WORKDESK_RETURN_RESTORE_ERROR);
  });

  it("shows restore failures and never activates a guessed Workdesk", async () => {
    const restore = vi.fn(async () => ({ kind: "error" as const, code: "invalid-identity", message: "Remembered Workdesk is invalid." }));
    const activate = vi.fn(async (_result: WorkdeskOpened) => true);
    const rememberHome = vi.fn(async () => undefined);
    const showError = vi.fn();

    await restoreWorkdeskForReturn({ restore, activate, rememberHome, showError });

    expect(activate).not.toHaveBeenCalled();
    expect(rememberHome).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledWith("Remembered Workdesk is invalid.");
  });

  it("shows the existing Open Workdesk guidance if restore rejects", async () => {
    const restore = vi.fn(async () => { throw new Error("restore failed"); });
    const activate = vi.fn(async (_result: WorkdeskOpened) => true);
    const rememberHome = vi.fn(async () => undefined);
    const showError = vi.fn();

    await restoreWorkdeskForReturn({ restore, activate, rememberHome, showError });

    expect(activate).not.toHaveBeenCalled();
    expect(rememberHome).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledWith(WORKDESK_RETURN_RESTORE_ERROR);
  });
});
