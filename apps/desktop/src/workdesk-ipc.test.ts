import { describe, expect, it, vi } from "vitest";
import {
  createWorkdeskHandlers,
  type ExistingProjectRegistrationChoice,
  type WorkdeskFolderSelection,
} from "./workdesk-ipc";
import type { WorkdeskIdentityRecoveryRoot, WorkdeskLastActiveContext } from "./workdesk-service";

const owner = {};

function dependencies() {
  const serviceOpen = vi.fn();
  const restorePrimary = vi.fn(async (): Promise<unknown> => undefined);
  return {
    pickWorkdeskFolder: vi.fn<() => Promise<WorkdeskFolderSelection>>(async () => ({ canceled: true, filePaths: [] })),
    pickWorkdeskParent: vi.fn<() => Promise<WorkdeskFolderSelection>>(async () => ({ canceled: true, filePaths: [] })),
    pickExistingProjectFolder: vi.fn<() => Promise<WorkdeskFolderSelection>>(async () => ({ canceled: true, filePaths: [] })),
    confirmAdoptWorkdesk: vi.fn(async () => false),
    confirmRegisterExistingProject: vi.fn(async (): Promise<ExistingProjectRegistrationChoice> => "register"),
    service: {
      open: serviceOpen,
      openForActivation: vi.fn(async (root: string) => serviceOpen(root)),
      create: vi.fn(),
      restorePrimary,
      restorePrimaryForActivation: vi.fn(async () => restorePrimary()),
      inspectIdentityRecoveryForActivation: vi.fn(async (_root: string, _cause: unknown): Promise<WorkdeskIdentityRecoveryRoot | undefined> => undefined),
      prepareAdoption: vi.fn(),
      adoptPreparedFolder: vi.fn(),
      loadPortableIndex: vi.fn(async () => ({ schemaVersion: 1 as const, projects: [] })),
      listRegisteredProjects: vi.fn(async () => []),
      setPrimary: vi.fn(async () => undefined),
      setLastActiveContext: vi.fn(async () => undefined),
      lastActiveContext: vi.fn(async (): Promise<WorkdeskLastActiveContext> => ({ kind: "home" })),
      resolveRegisteredProject: vi.fn(),
      validateExternalProject: vi.fn(),
      validateDirectChildProject: vi.fn(),
      prepareChildProjectDirectory: vi.fn(),
      registerPortableProject: vi.fn(async () => undefined),
      registerProjectPath: vi.fn(async () => undefined),
      registerProjectLocation: vi.fn(async () => undefined),
      unregisterProject: vi.fn(async () => undefined),
    },
    projects: {
      openForOwner: vi.fn(),
      openWorkdeskLooseFilesForOwner: vi.fn(),
      validateProjectRoot: vi.fn(),
      createForWorkdesk: vi.fn(),
      createFileForOwner: vi.fn(),
      readCopySourceForOwner: vi.fn(),
      copySourceToProjectForOwner: vi.fn()
    },
    isPermittedWorkdeskFolder: vi.fn(async () => true)
  };
}

describe("Workdesk IPC boundary", () => {
  it("returns restore failures distinctly without opening the first-run picker", async () => {
    const values = dependencies();
    values.service.restorePrimary.mockRejectedValue(Object.assign(new Error(
      "Saved Workdesk information is damaged. Use Open Workdesk to choose another folder."
    ), { name: "WorkdeskBoundaryError", code: "local-state-corrupt" }));
    const handlers = createWorkdeskHandlers(values as never);

    await expect(handlers.restoreWorkdesk({ sender: owner })).resolves.toMatchObject({
      kind: "error",
      code: "local-state-corrupt"
    });
    expect(values.pickWorkdeskFolder).not.toHaveBeenCalled();
  });

  it("opens a selected Workdesk and records it as the primary local path", async () => {
    const values = dependencies();
    const workdeskId = "11111111-1111-4111-8111-111111111111";
    const desk = { canonicalRoot: "main-process-only", identity: { id: workdeskId, title: "Desk", kind: "workbench" } };
    values.pickWorkdeskFolder.mockResolvedValue({ canceled: false, filePaths: ["C:\\資料\\Workdesk"] });
    values.service.open.mockResolvedValue(desk);
    values.projects.openWorkdeskLooseFilesForOwner.mockResolvedValue({
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
    expect(values.service.setLastActiveContext).not.toHaveBeenCalled();
  });

  it("opens readable documents in conflict recovery without selecting an identity", async () => {
    const values = dependencies();
    const recovery = {
      kind: "identity-recovery" as const,
      canonicalRoot: "main-process-only-conflicting-root",
      title: "作業机",
      code: "marker-conflict" as const,
      message: "Resolve the conflicting markers before using Projects.",
    };
    values.pickWorkdeskFolder.mockResolvedValue({ canceled: false, filePaths: [recovery.canonicalRoot] });
    values.service.openForActivation.mockResolvedValue(recovery);
    values.projects.openWorkdeskLooseFilesForOwner.mockResolvedValue({
      kind: "opened",
      project: { projectId: "opaque-document-handle", displayName: "作業机" },
      files: [{ fileId: "opaque-file-handle", displayName: "日本語メモ.md", title: "メモ", documentType: "memo" }],
    });
    const handlers = createWorkdeskHandlers(values as never);

    const result = await handlers.openWorkdesk({ sender: owner });

    expect(result).toMatchObject({
      kind: "recovery",
      workdesk: { documentId: "opaque-document-handle", title: "作業机" },
      files: [{ displayName: "日本語メモ.md" }],
      recovery: { code: "marker-conflict" },
    });
    expect(result.kind === "recovery" && "workdeskIdentityId" in result.workdesk).toBe(false);
    expect(JSON.stringify(result)).not.toContain(recovery.canonicalRoot);
    expect(values.projects.openWorkdeskLooseFilesForOwner).toHaveBeenCalledWith(owner, recovery.canonicalRoot, { rememberAsProject: false });
    expect(values.service.setPrimary).not.toHaveBeenCalled();
    expect(values.service.listRegisteredProjects).not.toHaveBeenCalled();
    expect(values.service.lastActiveContext).not.toHaveBeenCalled();
    expect(values.service.setLastActiveContext).not.toHaveBeenCalled();
    expect(values.projects.openForOwner).not.toHaveBeenCalled();
    await expect(handlers.createWorkdeskProject({ sender: owner }, {
      workdeskIdentityId: "22222222-2222-4222-8222-222222222222",
      title: "Unregistered",
    })).resolves.toMatchObject({ kind: "error", code: "workdesk-not-active" });
    expect(values.projects.createForWorkdesk).not.toHaveBeenCalled();
  });

  it("keeps readable notes open when the user declines adoption of a markerless Workdesk", async () => {
    const values = dependencies();
    const root = "main-process-only-markerless-root";
    const recovery = {
      kind: "identity-recovery" as const,
      canonicalRoot: root,
      title: "作業机",
      code: "missing-marker" as const,
      message: "This folder has no valid Workdesk identity. Readable documents are open in recovery mode.",
    };
    const candidate = { kind: "workdesk-adoption-candidate" as const };
    values.pickWorkdeskFolder.mockResolvedValue({ canceled: false, filePaths: [root] });
    values.service.openForActivation.mockRejectedValue(Object.assign(new Error("No valid Workdesk marker."), {
      name: "WorkdeskBoundaryError", code: "missing-marker",
    }));
    values.service.inspectIdentityRecoveryForActivation.mockResolvedValue(recovery);
    values.service.prepareAdoption.mockResolvedValue(candidate);
    values.confirmAdoptWorkdesk.mockResolvedValue(false);
    values.projects.openWorkdeskLooseFilesForOwner.mockResolvedValue({
      kind: "opened",
      project: { projectId: "opaque-document-handle", displayName: "作業机" },
      files: [{ fileId: "opaque-file-handle", displayName: "日本語メモ.md", title: "メモ", documentType: "memo" }],
    });
    const handlers = createWorkdeskHandlers(values as never);

    await expect(handlers.openWorkdesk({ sender: owner })).resolves.toMatchObject({
      kind: "recovery",
      workdesk: { documentId: "opaque-document-handle", title: "作業机" },
      files: [{ displayName: "日本語メモ.md" }],
      recovery: { code: "missing-marker" },
    });
    expect(values.service.prepareAdoption).toHaveBeenCalledWith(root);
    expect(values.confirmAdoptWorkdesk).toHaveBeenCalledOnce();
    expect(values.service.adoptPreparedFolder).not.toHaveBeenCalled();
    expect(values.projects.openWorkdeskLooseFilesForOwner).toHaveBeenCalledWith(owner, root, { rememberAsProject: false });
    expect(values.service.setPrimary).not.toHaveBeenCalled();
    expect(values.service.setLastActiveContext).not.toHaveBeenCalled();
  });

  it("creates a Workdesk through the typed marker service without Repository Core initialization", async () => {
    const values = dependencies();
    const desk = { canonicalRoot: "created-workdesk-root", identity: { id: "11111111-1111-4111-8111-111111111111", title: "Desk", kind: "workbench" } };
    values.pickWorkdeskParent.mockResolvedValue({ canceled: false, filePaths: ["parent-main-process-only"] });
    values.service.create.mockResolvedValue(desk);
    values.projects.openWorkdeskLooseFilesForOwner.mockResolvedValue({
      kind: "opened", project: { projectId: "workdesk-document", displayName: "Desk" }, files: []
    });
    const handlers = createWorkdeskHandlers(values as never);

    await expect(handlers.createWorkdesk({ sender: owner }, { title: "Desk" })).resolves.toMatchObject({ kind: "opened" });
    expect(values.service.create).toHaveBeenCalledWith("parent-main-process-only", "Desk");
    expect(values.service.open).not.toHaveBeenCalled();
    expect(values.projects.openWorkdeskLooseFilesForOwner).toHaveBeenCalledWith(owner, desk.canonicalRoot);
  });

  it("uses a separate Home command to reopen the known primary without a folder picker", async () => {
    const values = dependencies();
    const workdeskId = "11111111-1111-4111-8111-111111111111";
    const desk = { canonicalRoot: "main-process-only", identity: { id: workdeskId, title: "Desk", kind: "workbench" } };
    values.service.restorePrimary.mockResolvedValue(desk);
    values.projects.openWorkdeskLooseFilesForOwner.mockResolvedValue({
      kind: "opened",
      project: { projectId: workdeskId, displayName: "Desk" },
      files: [],
    });
    const handlers = createWorkdeskHandlers(values as never);

    await expect(handlers.returnToWorkdesk({ sender: owner })).resolves.toMatchObject({ kind: "opened" });
    expect(values.service.restorePrimary).toHaveBeenCalledOnce();
    expect(values.pickWorkdeskFolder).not.toHaveBeenCalled();
    expect(values.service.setLastActiveContext).not.toHaveBeenCalled();
  });

  it("restores a remembered marker conflict into read-only identity recovery", async () => {
    const values = dependencies();
    const recovery = {
      kind: "identity-recovery" as const,
      canonicalRoot: "remembered-conflicting-root",
      title: "作業机",
      code: "marker-conflict" as const,
      message: "Resolve the conflicting markers before using Projects.",
    };
    values.service.restorePrimaryForActivation.mockResolvedValue(recovery);
    values.projects.openWorkdeskLooseFilesForOwner.mockResolvedValue({
      kind: "opened", project: { projectId: "opaque-document-handle", displayName: "作業机" },
      files: [{ fileId: "opaque-file-handle", displayName: "neko.md", title: "neko", documentType: "other" }],
    });
    const handlers = createWorkdeskHandlers(values as never);

    await expect(handlers.restoreWorkdesk({ sender: owner })).resolves.toMatchObject({
      kind: "recovery",
      files: [{ displayName: "neko.md" }],
      recovery: { code: "marker-conflict" },
    });
    expect(values.projects.openWorkdeskLooseFilesForOwner).toHaveBeenCalledWith(owner, recovery.canonicalRoot, { rememberAsProject: false });
    expect(values.pickWorkdeskFolder).not.toHaveBeenCalled();
    expect(values.service.setPrimary).not.toHaveBeenCalled();
    expect(values.service.setLastActiveContext).not.toHaveBeenCalled();
  });

  it("restores a markerless remembered Workdesk as readable recovery without adopting it", async () => {
    const values = dependencies();
    const recovery = {
      kind: "identity-recovery" as const,
      canonicalRoot: "remembered-markerless-root",
      title: "作業机",
      code: "missing-marker" as const,
      message: "Readable documents remain available in recovery mode.",
    };
    values.service.restorePrimaryForActivation.mockResolvedValue(recovery);
    values.projects.openWorkdeskLooseFilesForOwner.mockResolvedValue({
      kind: "opened", project: { projectId: "opaque-document-handle", displayName: "作業机" },
      files: [{ fileId: "opaque-file-handle", displayName: "研究メモ.md", title: "研究メモ", documentType: "other" }],
    });
    const handlers = createWorkdeskHandlers(values as never);

    await expect(handlers.restoreWorkdesk({ sender: owner })).resolves.toMatchObject({
      kind: "recovery",
      files: [{ displayName: "研究メモ.md" }],
      recovery: { code: "missing-marker" },
    });
    expect(values.projects.openWorkdeskLooseFilesForOwner).toHaveBeenCalledWith(owner, recovery.canonicalRoot, { rememberAsProject: false });
    expect(values.confirmAdoptWorkdesk).not.toHaveBeenCalled();
    expect(values.pickWorkdeskFolder).not.toHaveBeenCalled();
    expect(values.service.setPrimary).not.toHaveBeenCalled();
    expect(values.service.setLastActiveContext).not.toHaveBeenCalled();
  });

  it("saves context only through the active Workdesk capability after renderer activation", async () => {
    const values = dependencies();
    const workdeskId = "11111111-1111-4111-8111-111111111111";
    const projectId = "22222222-2222-4222-8222-222222222222";
    const desk = { canonicalRoot: "main-process-only", identity: { id: workdeskId, title: "Desk", kind: "workbench" } };
    values.service.restorePrimary.mockResolvedValue(desk);
    values.projects.openWorkdeskLooseFilesForOwner.mockResolvedValue({ kind: "opened", project: { projectId: workdeskId, displayName: "Desk" }, files: [] });
    const handlers = createWorkdeskHandlers(values as never);

    await handlers.restoreWorkdesk({ sender: owner });
    await expect(handlers.saveWorkdeskContext({ sender: owner }, {
      workdeskIdentityId: workdeskId,
      context: { kind: "project", projectIdentityId: projectId },
    })).resolves.toEqual({ kind: "saved" });
    expect(values.service.setLastActiveContext).toHaveBeenCalledWith(desk, {
      kind: "project",
      projectIdentityId: projectId,
    });
    expect(values.pickWorkdeskFolder).not.toHaveBeenCalled();
  });

  it("does not save context through an inactive or mismatched Workdesk capability", async () => {
    const values = dependencies();
    const handlers = createWorkdeskHandlers(values as never);
    const result = await handlers.saveWorkdeskContext({ sender: owner }, {
      workdeskIdentityId: "11111111-1111-4111-8111-111111111111",
      context: { kind: "home" },
    });

    expect(result).toMatchObject({ kind: "error", code: "workdesk-not-active" });
    expect(values.service.setLastActiveContext).not.toHaveBeenCalled();
  });

  it("confirms adoption before adopting a selected populated folder", async () => {
    const values = dependencies();
    const workdeskId = "11111111-1111-4111-8111-111111111111";
    const desk = { canonicalRoot: "main-process-only", identity: { id: workdeskId, title: "Desk", kind: "workbench" } };
    const candidate = { kind: "workdesk-adoption-candidate" as const };
    values.pickWorkdeskFolder.mockResolvedValue({ canceled: false, filePaths: ["main-process-only"] });
    values.service.open.mockRejectedValue(new Error("folder has no Workdesk identity"));
    values.service.prepareAdoption.mockResolvedValue(candidate);
    values.service.adoptPreparedFolder.mockResolvedValue({ workdesk: desk, preserveIncompleteOnFailure: vi.fn(async () => undefined) });
    values.confirmAdoptWorkdesk.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    values.projects.openWorkdeskLooseFilesForOwner.mockResolvedValue({
      kind: "opened",
      project: { projectId: workdeskId, displayName: "Desk" },
      files: [],
    });
    const handlers = createWorkdeskHandlers(values as never);

    await expect(handlers.openWorkdesk({ sender: owner })).resolves.toEqual({ kind: "cancelled" });
    expect(values.service.adoptPreparedFolder).not.toHaveBeenCalled();
    await expect(handlers.openWorkdesk({ sender: owner })).resolves.toMatchObject({ kind: "opened" });
    expect(values.service.adoptPreparedFolder).toHaveBeenCalledWith(candidate);
    expect(values.service.setPrimary).toHaveBeenCalledWith(desk);
  });

  it("restores Home first without overwriting a remembered registered Project", async () => {
    const values = dependencies();
    const workdeskId = "11111111-1111-4111-8111-111111111111";
    const projectId = "22222222-2222-4222-8222-222222222222";
    const desk = { canonicalRoot: "main-process-only", identity: { id: workdeskId, title: "Desk", kind: "workbench" } };
    values.service.restorePrimary.mockResolvedValue(desk);
    values.service.lastActiveContext.mockResolvedValue({ kind: "project", projectIdentityId: projectId });
    values.projects.openWorkdeskLooseFilesForOwner.mockResolvedValue({ kind: "opened", project: { projectId: workdeskId, displayName: "Desk" }, files: [] });
    const handlers = createWorkdeskHandlers(values as never);

    const result = await handlers.restoreWorkdesk({ sender: owner });
    expect(result).toMatchObject({ kind: "opened", lastActiveContext: { kind: "project", projectIdentityId: projectId } });
    expect(values.service.setLastActiveContext).not.toHaveBeenCalled();
    expect(values.pickWorkdeskFolder).not.toHaveBeenCalled();
  });

  it("does not return child Project Markdown as loose Workdesk files", async () => {
    const values = dependencies();
    const workdeskId = "11111111-1111-4111-8111-111111111111";
    const desk = { canonicalRoot: "main-process-only", identity: { id: workdeskId, title: "Desk", kind: "workbench" } };
    values.pickWorkdeskFolder.mockResolvedValue({ canceled: false, filePaths: ["C:\\資料\\Workdesk"] });
    values.service.open.mockResolvedValue(desk);
    values.projects.openWorkdeskLooseFilesForOwner.mockResolvedValue({
      kind: "opened",
      project: { projectId: workdeskId, displayName: "Desk" },
      files: [
        { fileId: "22222222-2222-4222-8222-222222222222", displayName: "memo.md", title: "Memo", documentType: "memo" },
        { fileId: "33333333-3333-4333-8333-333333333333", displayName: "projects/Child/notes.md", title: "Child", documentType: "other" }
      ]
    });
    const handlers = createWorkdeskHandlers(values as never);

    await expect(handlers.openWorkdesk({ sender: owner })).resolves.toMatchObject({
      kind: "opened",
      files: [{ displayName: "memo.md" }]
    });
  });

  it("creates a registered child Project with the Workdesk UUID through ProjectService", async () => {
    const values = dependencies();
    const workdeskId = "11111111-1111-4111-8111-111111111111";
    const projectId = "22222222-2222-4222-8222-222222222222";
    const desk = { canonicalRoot: "desk-main-process-only", identity: { id: workdeskId, title: "Desk", kind: "workbench" } };
    const boundary = { canonicalRoot: "project-main-process-only", projectIdentity: { id: projectId, title: "Child", kind: "project" } };
    values.service.restorePrimary.mockResolvedValue(desk);
    values.projects.openWorkdeskLooseFilesForOwner.mockResolvedValue({
      kind: "opened", project: { projectId: workdeskId, displayName: "Desk" }, files: []
    });
    values.service.prepareChildProjectDirectory.mockResolvedValue("projects-root-main-only");
    values.projects.createForWorkdesk.mockResolvedValue({ kind: "created", canonicalRoot: boundary.canonicalRoot });
    values.service.validateDirectChildProject.mockResolvedValue(boundary);
    values.projects.validateProjectRoot.mockResolvedValue({ kind: "opened", project: { projectId, displayName: "Child" }, files: [] });
    values.projects.openForOwner.mockResolvedValue({ kind: "opened", project: { projectId, displayName: "Child" }, files: [] });
    const handlers = createWorkdeskHandlers(values as never);

    await handlers.restoreWorkdesk({ sender: owner });
    await expect(handlers.createWorkdeskProject({ sender: owner }, { workdeskIdentityId: workdeskId, title: "Child" }))
      .resolves.toMatchObject({ kind: "opened", node: { projectIdentityId: projectId } });
    expect(values.projects.createForWorkdesk).toHaveBeenCalledWith("projects-root-main-only", "Child", workdeskId);
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
      "11111111-1111-4111-8111-111111111111", "memo.md", "memo", "memo", null);
    expect(values.projects.createFileForOwner).toHaveBeenNthCalledWith(2, owner,
      "11111111-1111-4111-8111-111111111111", "draft.md", "draft", "draft", null);
    expect(values.projects.createFileForOwner).toHaveBeenNthCalledWith(3, owner,
      "11111111-1111-4111-8111-111111111111", "other.md", "other", "other", null);
  });

  it("does not create a loose Workdesk file below a hidden child Project root", async () => {
    const values = dependencies();
    values.isPermittedWorkdeskFolder.mockResolvedValue(false);
    const handlers = createWorkdeskHandlers(values as never);

    await expect(handlers.createWorkdeskFile({ sender: owner }, {
      workdeskId: "11111111-1111-4111-8111-111111111111",
      fileName: "memo.md",
      title: "Memo",
      documentType: "memo",
      parentEntryId: "22222222-2222-4222-8222-222222222222"
    })).resolves.toMatchObject({ kind: "error", code: "invalid-request" });
    expect(values.projects.createFileForOwner).not.toHaveBeenCalled();
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

  it("opens and validates an external Project before committing Workdesk membership", async () => {
    const values = dependencies();
    const workdeskId = "11111111-1111-4111-8111-111111111111";
    const projectId = "22222222-2222-4222-8222-222222222222";
    const desk = { canonicalRoot: "desk-main-process-only", identity: { id: workdeskId, title: "Desk", kind: "workbench" } };
    const boundary = { canonicalRoot: "project-main-process-only", workdeskIdentityId: workdeskId, projectIdentity: { id: projectId, title: "External", kind: "project" } };
    values.service.restorePrimary.mockResolvedValue(desk);
    values.service.validateExternalProject.mockResolvedValue(boundary);
    values.projects.openWorkdeskLooseFilesForOwner
      .mockResolvedValueOnce({ kind: "opened", project: { projectId: workdeskId, displayName: "Desk" }, files: [] });
    values.projects.openForOwner.mockResolvedValue({ kind: "opened", project: { projectId, displayName: "External" }, files: [] });
    values.projects.validateProjectRoot.mockResolvedValue({ kind: "opened", project: { projectId, displayName: "External" }, files: [] });
    const handlers = createWorkdeskHandlers(values as never);

    expect(await handlers.restoreWorkdesk({ sender: owner })).toMatchObject({ kind: "opened" });
    expect(await handlers.registerWorkdeskProject({ sender: owner }, { workdeskIdentityId: workdeskId })).toMatchObject({ kind: "cancelled" });
    values.pickExistingProjectFolder.mockResolvedValue({ canceled: false, filePaths: ["D:\\研究\\External"] });
    expect(await handlers.registerWorkdeskProject({ sender: owner }, { workdeskIdentityId: workdeskId })).toMatchObject({ kind: "opened", node: { projectIdentityId: projectId } });
    expect(values.projects.validateProjectRoot).toHaveBeenCalledWith(boundary.canonicalRoot);
    expect(values.service.validateExternalProject).toHaveBeenCalledWith("D:\\研究\\External", {
      expectedWorkdeskIdentityId: workdeskId,
      requireExistingMarker: true,
    });
    expect(values.service.registerProjectLocation).toHaveBeenCalledWith(desk, boundary);
    expect(values.confirmRegisterExistingProject).toHaveBeenCalledOnce();
  });

  it("keeps Workdesk on No and can open a valid Project without registering it", async () => {
    const values = dependencies();
    const workdeskId = "11111111-1111-4111-8111-111111111111";
    const projectId = "22222222-2222-4222-8222-222222222222";
    const desk = { canonicalRoot: "desk-main-process-only", identity: { id: workdeskId, title: "Desk", kind: "workbench" } };
    const boundary = { canonicalRoot: "project-main-process-only", workdeskIdentityId: workdeskId, projectIdentity: { id: projectId, title: "External", kind: "project" } };
    values.service.restorePrimary.mockResolvedValue(desk);
    values.service.validateExternalProject.mockResolvedValue(boundary);
    values.projects.openWorkdeskLooseFilesForOwner
      .mockResolvedValueOnce({ kind: "opened", project: { projectId: workdeskId, displayName: "Desk" }, files: [] });
    values.projects.validateProjectRoot.mockResolvedValue({ kind: "opened", project: { projectId, displayName: "External" }, files: [] });
    values.projects.openForOwner.mockResolvedValue({ kind: "opened", project: { projectId, displayName: "External" }, files: [] });
    values.pickExistingProjectFolder.mockResolvedValue({ canceled: false, filePaths: ["D:\\研究\\External"] });
    values.confirmRegisterExistingProject
      .mockResolvedValueOnce("cancel")
      .mockResolvedValueOnce("open-without-registration");
    const handlers = createWorkdeskHandlers(values as never);

    await handlers.restoreWorkdesk({ sender: owner });
    await expect(handlers.registerWorkdeskProject({ sender: owner }, { workdeskIdentityId: workdeskId }))
      .resolves.toEqual({ kind: "cancelled" });
    expect(values.service.registerProjectLocation).not.toHaveBeenCalled();
    expect(values.projects.openForOwner).not.toHaveBeenCalled();

    await expect(handlers.registerWorkdeskProject({ sender: owner }, { workdeskIdentityId: workdeskId }))
      .resolves.toEqual({
        kind: "opened-unregistered",
        project: { kind: "opened", project: { projectId, displayName: "External" }, files: [] },
      });
    expect(values.service.registerProjectLocation).not.toHaveBeenCalled();
    expect(values.projects.openForOwner).toHaveBeenCalledOnce();
  });

  it("keeps Workdesk active and writes no registration when the selected Project belongs elsewhere", async () => {
    const values = dependencies();
    const workdeskId = "11111111-1111-4111-8111-111111111111";
    const desk = { canonicalRoot: "desk-main-process-only", identity: { id: workdeskId, title: "Desk", kind: "workbench" } };
    values.service.restorePrimary.mockResolvedValue(desk);
    values.projects.openWorkdeskLooseFilesForOwner.mockResolvedValue({
      kind: "opened", project: { projectId: workdeskId, displayName: "Desk" }, files: []
    });
    values.pickExistingProjectFolder.mockResolvedValue({ canceled: false, filePaths: ["D:\\Research\\Other"] });
    values.service.validateExternalProject.mockRejectedValue(Object.assign(
      new Error("This Project is linked to a different Workdesk. Add it from that Workdesk; its identity marker was left unchanged."),
      { name: "WorkdeskBoundaryError", code: "mapping-conflict" },
    ));
    const handlers = createWorkdeskHandlers(values as never);

    await handlers.restoreWorkdesk({ sender: owner });
    await expect(handlers.registerWorkdeskProject({ sender: owner }, { workdeskIdentityId: workdeskId }))
      .resolves.toMatchObject({ kind: "error", code: "mapping-conflict", message: expect.stringContaining("left unchanged") });
    expect(values.projects.validateProjectRoot).not.toHaveBeenCalled();
    expect(values.service.registerProjectLocation).not.toHaveBeenCalled();
    expect(values.confirmRegisterExistingProject).not.toHaveBeenCalled();
  });

  it("removes only active Workdesk membership through opaque identities", async () => {
    const values = dependencies();
    const workdeskId = "11111111-1111-4111-8111-111111111111";
    const projectId = "22222222-2222-4222-8222-222222222222";
    const desk = { canonicalRoot: "desk-main-process-only", identity: { id: workdeskId, title: "Desk", kind: "workbench" } };
    values.service.restorePrimary.mockResolvedValue(desk);
    values.projects.openWorkdeskLooseFilesForOwner.mockResolvedValue({ kind: "opened", project: { projectId: workdeskId, displayName: "Desk" }, files: [] });
    const handlers = createWorkdeskHandlers(values as never);

    await handlers.restoreWorkdesk({ sender: owner });
    expect(await handlers.removeWorkdeskProject({ sender: owner }, { workdeskIdentityId: workdeskId, projectIdentityId: projectId }))
      .toEqual({ kind: "removed", projectIdentityId: projectId });
    expect(values.service.unregisterProject).toHaveBeenCalledWith(desk, projectId);
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
    values.projects.openWorkdeskLooseFilesForOwner
      .mockResolvedValueOnce({ kind: "opened", project: { projectId: workdeskId, displayName: "Desk" }, files: [] });
    values.projects.openForOwner.mockResolvedValue({ kind: "opened", project: { projectId, displayName: "Project" }, files: [] });
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
