import { describe, expect, it, vi } from "vitest";
import type { OpenMarkdownResult, SaveMarkdownRequest } from "../markdown-ipc";
import type { ProjectFileOpenResult } from "../project-ipc";
import type { ProjectFileSummary } from "../project-service";
import { WritingController, type WritingStatus, type WritingSurface, type WritingTextRange, type WritingView } from "./controller";
import { ProjectNavigationController, type ProjectNavigationApi, type ProjectNavigationState, type ProjectNavigationView } from "./project-controller";

class Surface implements WritingSurface {
  private readonly listeners = new Set<(text: string) => void>();
  public text = "";
  public replaceDocument(text: string): void { this.text = text; }
  public getText(): string { return this.text; }
  public getSelection(): WritingTextRange { return { start: 0, end: 0 }; }
  public applyEdit(): void { /* unused */ }
  public onTextChange(listener: (text: string) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  public focus(): void { /* unused */ }
  public edit(text: string): void { this.text = text; for (const listener of this.listeners) listener(text); }
}

class WritingViewStub implements WritingView {
  public status: WritingStatus = { kind: "empty", message: "" };
  public setDocumentName(): void { /* unused */ }
  public setStatus(status: WritingStatus): void { this.status = status; }
  public setSaveEnabled(): void { /* unused */ }
}

class ProjectViewStub implements ProjectNavigationView {
  public state: ProjectNavigationState = { project: null, files: [], activeFileId: null };
  public error: string | null = null;
  public setProjectState(state: ProjectNavigationState): void { this.state = state; }
  public setProjectError(message: string | null): void { this.error = message; }
}

const files: readonly ProjectFileSummary[] = [
  { fileId: "00000000-0000-4000-8000-000000000001", displayName: "first.md", documentType: "draft", title: "First" },
  { fileId: "00000000-0000-4000-8000-000000000002", displayName: "second.md", documentType: "memo", title: "Second" }
];
const project = { projectId: "00000000-0000-4000-8000-000000000010", displayName: "Coffee" };

function opened(file: ProjectFileSummary): OpenMarkdownResult {
  return {
    kind: "opened",
    sessionId: file.fileId,
    displayName: file.displayName,
    text: file.fileId.endsWith("001") ? "first" : "second"
  };
}

function harness(
  decision: "save" | "discard" | "cancel",
  openFile: (file: ProjectFileSummary) => ProjectFileOpenResult = (file) => opened(file),
  tabs = false,
  flushAllDocuments?: () => Promise<boolean>
) {
  const surface = new Surface();
  const writingView = new WritingViewStub();
  const view = new ProjectViewStub();
  const openProjectFile = vi.fn(async ({ fileId }: { fileId: string }) => {
    const file = files.find((candidate) => candidate.fileId === fileId);
    if (!file) return { kind: "error", code: "project-file-open-failed", message: "missing" } as const;
    return openFile(file);
  });
  const saveMarkdown = vi.fn(async (request: SaveMarkdownRequest) => ({
    kind: "saved" as const, sessionId: request.sessionId, displayName: "saved.md", text: request.text
  }));
  const api: ProjectNavigationApi = {
    openProject: async () => ({ kind: "opened", project, files }),
    createProject: async () => ({ kind: "cancelled" }),
    restoreProject: async () => ({ kind: "none" }),
    openProjectFile,
    createProjectFile: async () => ({ kind: "error", code: "project-file-invalid", message: "unused" })
  };
  const writing = new WritingController({
    api: { ...api, saveMarkdown, openMarkdown: async () => ({ kind: "cancelled" } as const) },
    surface,
    view: writingView,
    confirmReplace: () => true
  });
  const navigation = new ProjectNavigationController({
    api,
    writing,
    view,
    decideDirtySwitch: () => decision,
    confirmDocumentSwitch: !tabs,
    flushAllDocuments
  });
  return { navigation, openProjectFile, saveMarkdown, surface, writing, view };
}

describe("ProjectNavigationController", () => {
  it("keeps the active file on dirty cancel", async () => {
    const test = harness("cancel");
    await test.navigation.openProject();
    test.surface.edit("changed");
    await test.navigation.openFile(files[1].fileId);
    expect(test.openProjectFile).toHaveBeenCalledTimes(1);
    expect(test.view.state.activeFileId).toBe(files[0].fileId);
    expect(test.surface.text).toBe("changed");
  });

  it("saves or discards before switching files", async () => {
    const saved = harness("save");
    await saved.navigation.openProject();
    saved.surface.edit("saved edit");
    await saved.navigation.openFile(files[1].fileId);
    expect(saved.saveMarkdown).toHaveBeenCalledWith({ sessionId: files[0].fileId, text: "saved edit" });
    expect(saved.view.state.activeFileId).toBe(files[1].fileId);

    const discarded = harness("discard");
    await discarded.navigation.openProject();
    discarded.surface.edit("discarded edit");
    await discarded.navigation.openFile(files[1].fileId);
    expect(discarded.saveMarkdown).not.toHaveBeenCalled();
    expect(discarded.surface.text).toBe("second");
  });

  it("preserves the current edit when the target file fails to open", async () => {
    const test = harness("discard", (file) => file.fileId === files[1].fileId
      ? ({ kind: "error", code: "project-file-open-failed", message: "cannot open" } as const)
      : opened(file));
    await test.navigation.openProject();
    test.surface.edit("keep me");
    await test.navigation.openFile(files[1].fileId);
    expect(test.view.state.activeFileId).toBe(files[0].fileId);
    expect(test.surface.text).toBe("keep me");
    expect(test.view.error).toBe("cannot open");
  });

  it("switches central tabs without replacing dirty sessions and reactivates an existing tab", async () => {
    const test = harness("cancel", (file) => opened(file), true);
    await test.navigation.openProject();
    test.surface.edit("first edited");
    await test.navigation.openFile(files[1].fileId);
    await test.navigation.openFile(files[0].fileId);

    expect(test.saveMarkdown).not.toHaveBeenCalled();
    expect(test.surface.text).toBe("first edited");
    expect(test.writing.getDocumentSessions()).toHaveLength(2);
    expect(test.view.state.activeFileId).toBe(files[0].fileId);
  });

  it("flushes every session before replacing the Project", async () => {
    const flushAll = vi.fn(async () => false);
    const test = harness("cancel", (file) => opened(file), true, flushAll);
    await test.navigation.openProject();
    test.surface.edit("project dirty");

    await test.navigation.openProject();

    expect(flushAll).toHaveBeenCalledTimes(1);
    expect(test.openProjectFile).toHaveBeenCalledTimes(1);
    expect(test.view.state.project).toEqual(project);
    expect(test.view.error).toBe("Save or discard the current manuscript before switching.");
  });
});
