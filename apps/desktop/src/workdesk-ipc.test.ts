import { describe, expect, it, vi } from "vitest";
import { createWorkdeskHandlers, type WorkdeskFolderSelection } from "./workdesk-ipc";

const owner = {};

function dependencies() {
  return {
    pickWorkdeskFolder: vi.fn<() => Promise<WorkdeskFolderSelection>>(async () => ({ canceled: true, filePaths: [] })),
    pickWorkdeskParent: vi.fn<() => Promise<WorkdeskFolderSelection>>(async () => ({ canceled: true, filePaths: [] })),
    pickExistingProjectFolder: vi.fn<() => Promise<WorkdeskFolderSelection>>(async () => ({ canceled: true, filePaths: [] })),
    service: {
      open: vi.fn(),
      restorePrimary: vi.fn(async (): Promise<unknown> => undefined),
      loadPortableIndex: vi.fn(async () => ({ schemaVersion: 1 as const, projects: [] })),
      listRegisteredProjects: vi.fn(async () => []),
      setPrimary: vi.fn(async () => undefined),
      resolveRegisteredProject: vi.fn(),
    },
    repositories: { createForOwner: vi.fn(), resolveForOwner: vi.fn() },
    projects: {
      openForOwner: vi.fn(),
      createFileForOwner: vi.fn(),
      readCopySourceForOwner: vi.fn(),
      copySourceToProjectForOwner: vi.fn()
    }
  };
}

describe("Workdesk IPC boundary", () => {
  it("opens a selected Workdesk and records it as the primary local path", async () => {
    const values = dependencies();
    const workdeskId = "11111111-1111-4111-8111-111111111111";
    const desk = { canonicalRoot: "main-process-only", identity: { id: workdeskId, title: "Desk", kind: "workbench" } };
    values.pickWorkdeskFolder.mockResolvedValue({ canceled: false, filePaths: ["C:\\資料\\Workdesk"] });
    values.service.open.mockResolvedValue(desk);
    values.projects.openForOwner.mockResolvedValue({
      kind: "opened",
      project: { projectId: workdeskId, displayName: "Desk" },
      files: []
    });
    const handlers = createWorkdeskHandlers(values as never);

    await expect(handlers.openWorkdesk({ sender: owner })).resolves.toMatchObject({
      kind: "opened",
      workdesk: { workdeskIdentityId: workdeskId, title: "Desk" }
    });
    expect(values.service.open).toHaveBeenCalledWith("C:\\資料\\Workdesk");
    expect(values.service.setPrimary).toHaveBeenCalledWith(desk);
  });

  it("rejects body creation before any service receives the request", async () => {
    const values = dependencies();
    const handlers = createWorkdeskHandlers(values as never);

    const result = await handlers.createWorkdeskFile({ sender: owner }, {
      workdeskId: "11111111-1111-4111-8111-111111111111",
      fileName: "body.md",
      title: "Body",
      documentType: "body"
    });

    expect(result).toMatchObject({ kind: "error", code: "invalid-request" });
    expect(values.projects.createFileForOwner).not.toHaveBeenCalled();
  });

  it("allows only loose memo, draft, and other document types", async () => {
    const values = dependencies();
    values.projects.createFileForOwner.mockResolvedValue({ kind: "created", project: {}, files: [], file: {} });
    const handlers = createWorkdeskHandlers(values as never);

    for (const documentType of ["memo", "draft", "other"] as const) {
      const result = await handlers.createWorkdeskFile({ sender: owner }, {
        workdeskId: "11111111-1111-4111-8111-111111111111",
        fileName: `${documentType}.md`,
        title: documentType,
        documentType
      });
      expect(result).toMatchObject({ kind: "created" });
    }

    expect(values.projects.createFileForOwner).toHaveBeenNthCalledWith(1, owner,
      "11111111-1111-4111-8111-111111111111", "memo.md", "memo", "memo");
    expect(values.projects.createFileForOwner).toHaveBeenNthCalledWith(2, owner,
      "11111111-1111-4111-8111-111111111111", "draft.md", "draft", "draft");
    expect(values.projects.createFileForOwner).toHaveBeenNthCalledWith(3, owner,
      "11111111-1111-4111-8111-111111111111", "other.md", "other", "other");
  });

  it("does not allow renderer-supplied Project registration without an active Workdesk capability", async () => {
    const values = dependencies();
    const handlers = createWorkdeskHandlers(values as never);
    const result = await handlers.registerWorkdeskProject({ sender: owner }, {
      workdeskIdentityId: "11111111-1111-4111-8111-111111111111"
    });
    expect(result).toMatchObject({ kind: "error", code: "workdesk-not-active" });
    expect(values.pickWorkdeskFolder).not.toHaveBeenCalled();
  });

  it("copies only an active opaque Workdesk source into a resolved registered Project", async () => {
    const values = dependencies();
    const workdeskId = "11111111-1111-4111-8111-111111111111";
    const projectId = "22222222-2222-4222-8222-222222222222";
    const sourceFileId = "33333333-3333-4333-8333-333333333333";
    const desk = { canonicalRoot: "main-process-only", identity: { id: workdeskId, title: "Desk", kind: "workbench" } };
    const source = { displayName: "memo.md", text: "source", title: "Memo", documentType: "memo" as const };
    values.service.restorePrimary.mockResolvedValue(desk);
    values.service.resolveRegisteredProject = vi.fn(async () => ({
      canonicalRoot: "destination-main-process-only",
      projectIdentity: { id: projectId, title: "Project", kind: "project" }
    }));
    values.projects.openForOwner
      .mockResolvedValueOnce({ kind: "opened", project: { projectId: workdeskId, displayName: "Desk" }, files: [] })
      .mockResolvedValueOnce({ kind: "opened", project: { projectId, displayName: "Project" }, files: [] });
    values.projects.readCopySourceForOwner = vi.fn(async () => source);
    values.projects.copySourceToProjectForOwner = vi.fn(async () => ({
      kind: "created", project: { projectId, displayName: "Project" }, files: [], file: { fileId: "44444444-4444-4444-8444-444444444444", displayName: "memo.md", documentType: "memo", title: "Memo" }
    }));
    const handlers = createWorkdeskHandlers(values as never);

    expect(await handlers.restoreWorkdesk({ sender: owner })).toMatchObject({ kind: "opened" });
    const result = await handlers.copyWorkdeskFileToProject({ sender: owner }, {
      workdeskId,
      sourceFileId,
      projectIdentityId: projectId,
      documentType: "memo"
    });

    expect(result).toMatchObject({ kind: "created", file: { displayName: "memo.md" } });
    expect(values.projects.readCopySourceForOwner).toHaveBeenCalledWith(owner, workdeskId, sourceFileId);
    expect(values.service.resolveRegisteredProject).toHaveBeenCalledWith(desk, projectId);
    expect(values.projects.copySourceToProjectForOwner).toHaveBeenCalledWith(
      expect.anything(), projectId, source, "memo"
    );
    const copyOwner = values.projects.copySourceToProjectForOwner.mock.calls[0]?.[0];
    expect(copyOwner).not.toBe(owner);
  });
});
