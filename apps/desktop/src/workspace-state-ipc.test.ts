import { describe, expect, it, vi } from "vitest";
import {
  createWorkspaceStateHandlers,
  EMPTY_WORKSPACE_STATE,
  isWorkspaceState,
  type WorkspaceState
} from "./workspace-state-ipc";

const state: WorkspaceState = {
  version: 1,
  projectId: "project-1",
  openFileIds: ["file-a", "file-b"],
  activeFileId: "file-a",
  viewPlacements: [{ documentId: "session-a", viewType: "markdown", region: "main", groupId: "editor-group-1" }]
};

describe("workspace state IPC", () => {
  it("accepts opaque project-relative state and rejects paths", () => {
    expect(isWorkspaceState(state)).toBe(true);
    expect(isWorkspaceState({ ...state, openFileIds: ["C:\\outside.md"] })).toBe(false);
    expect(isWorkspaceState({ ...state, viewPlacements: [{ ...state.viewPlacements[0], region: "right" }] })).toBe(false);
  });

  it("isolates invalid requests and persistence errors", async () => {
    const load = vi.fn(async () => state);
    const save = vi.fn(async () => undefined);
    const handlers = createWorkspaceStateHandlers({ load, save });
    const event = { sender: {} };

    expect(await handlers.loadWorkspaceState(event)).toEqual(state);
    expect(await handlers.loadWorkspaceState(event, "unexpected")).toMatchObject({ kind: "error", code: "invalid-request" });
    expect(await handlers.saveWorkspaceState(event, state)).toEqual({ kind: "saved" });
    expect(await handlers.saveWorkspaceState(event, { ...state, openFileIds: ["../outside"] })).toMatchObject({
      kind: "error", code: "invalid-request"
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);

    const unavailable = createWorkspaceStateHandlers({
      load: async () => { throw new Error("broken"); },
      save: async () => { throw new Error("broken"); }
    });
    expect(await unavailable.loadWorkspaceState(event)).toMatchObject({ kind: "error", code: "load-failed" });
    expect(await unavailable.saveWorkspaceState(event, state)).toMatchObject({ kind: "error", code: "save-failed" });
    expect(EMPTY_WORKSPACE_STATE.projectId).toBeNull();
  });
});
