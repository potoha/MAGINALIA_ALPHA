import { describe, expect, it, vi } from "vitest";
import {
  createProjectHandlers,
  type ProjectHandlerDependencies,
} from "./project-ipc";

const PROJECT_ID = "00000000-0000-4000-8000-000000000000";
const FILE_ID = "11111111-1111-4111-8111-111111111111";

function dependencies(overrides: Partial<ProjectHandlerDependencies> = {}): ProjectHandlerDependencies {
  return {
    pickProjectFolder: async () => ({ canceled: true, filePaths: [] }),
    pickProjectParent: async () => ({ canceled: true, filePaths: [] }),
    openProjectRoot: async () => ({
      kind: "error",
      code: "root-unreadable",
      message: "unused"
    }),
    createProject: async () => ({
      kind: "error",
      code: "project-create-failed",
      message: "unused"
    }),
    restoreProject: async () => ({ kind: "none" }),
    openProjectFile: async () => ({ kind: "cancelled" }),
    createProjectFile: async () => ({
      kind: "error",
      code: "project-file-invalid",
      message: "unused"
    }),
    ...overrides
  };
}

describe("Project IPC boundary", () => {
  it("rejects paths, extra fields, malformed IDs, and invalid document types before touching services", async () => {
    const openFile = vi.fn(async () => ({ kind: "cancelled" as const }));
    const createFile = vi.fn(async () => ({
      kind: "error" as const,
      code: "project-file-invalid" as const,
      message: "unused"
    }));
    const handlers = createProjectHandlers(dependencies({ openProjectFile: openFile, createProjectFile: createFile }));
    const event = { sender: {} };

    await expect(handlers.openProjectFile(event, {
      projectId: PROJECT_ID,
      fileId: FILE_ID,
      path: "C:\\outside.md"
    })).resolves.toMatchObject({ kind: "error", code: "invalid-request" });
    await expect(handlers.openProjectFile(event, {
      projectId: "../../outside",
      fileId: FILE_ID
    })).resolves.toMatchObject({ kind: "error", code: "invalid-request" });
    await expect(handlers.createProjectFile(event, {
      projectId: PROJECT_ID,
      fileName: "memo.md",
      title: "Memo",
      documentType: "quote"
    })).resolves.toMatchObject({ kind: "error", code: "invalid-request" });
    await expect(handlers.createProjectFile(event, {
      projectId: PROJECT_ID,
      fileName: "memo.md",
      title: "Memo",
      documentType: "memo",
      path: "C:\\outside.md"
    })).resolves.toMatchObject({ kind: "error", code: "invalid-request" });
    expect(openFile).not.toHaveBeenCalled();
    expect(createFile).not.toHaveBeenCalled();
  });

  it("passes the event owner and opaque handles through the approved boundary", async () => {
    const owner = {};
    const openProjectFile = vi.fn(async (requestOwner: object, projectId: string, fileId: string) => {
      expect(requestOwner).toBe(owner);
      expect(projectId).toBe(PROJECT_ID);
      expect(fileId).toBe(FILE_ID);
      return { kind: "cancelled" as const };
    });
    const handlers = createProjectHandlers(dependencies({ openProjectFile }));

    await expect(handlers.openProjectFile({ sender: owner }, { projectId: PROJECT_ID, fileId: FILE_ID }))
      .resolves.toEqual({ kind: "cancelled" });
    expect(openProjectFile).toHaveBeenCalledTimes(1);
  });

  it("returns cancellation without mutating Project state when a folder chooser is cancelled", async () => {
    const openProjectRoot = vi.fn();
    const handlers = createProjectHandlers(dependencies({
      pickProjectFolder: async () => ({ canceled: true, filePaths: [] }),
      openProjectRoot
    }));

    await expect(handlers.openProject({ sender: {} })).resolves.toEqual({ kind: "cancelled" });
    expect(openProjectRoot).not.toHaveBeenCalled();
  });
});
