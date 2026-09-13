import { describe, expect, it, vi } from "vitest";
import type { DocumentState } from "@maginalia/writing-core";
import type {
  OpenDocumentResult,
  OpenManuscriptRequest,
  OpenManuscriptResult
} from "../document-workspace-ipc";
import type {
  OpenMarkdownResult,
  SaveMarkdownRequest,
  SaveMarkdownResult
} from "../markdown-ipc";
import {
  WritingController,
  type WritingStatus,
  type WritingSurface,
  type WritingView
} from "./controller";
import {
  WorkspaceNavigationController,
  type DirtySwitchContext,
  type WorkspaceNavigationApi,
  type WorkspaceNavigationState,
  type WorkspaceNavigationView
} from "./workspace-controller";

class FakeSurface implements WritingSurface {
  private readonly listeners = new Set<(text: string) => void>();
  public text = "";
  public readonly replacedTexts: string[] = [];

  public replaceDocument(text: string): void {
    this.text = text;
    this.replacedTexts.push(text);
  }

  public getText(): string {
    return this.text;
  }

  public onTextChange(listener: (text: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public focus(): void {
    // Navigation tests do not need to observe focus.
  }

  public edit(text: string): void {
    this.text = text;
    for (const listener of this.listeners) listener(text);
  }
}

class FakeWritingView implements WritingView {
  public documentName = "";
  public status: WritingStatus = { kind: "empty", message: "" };
  public saveEnabled = false;

  public setDocumentName(name: string): void {
    this.documentName = name;
  }

  public setStatus(status: WritingStatus): void {
    this.status = status;
  }

  public setSaveEnabled(enabled: boolean): void {
    this.saveEnabled = enabled;
  }
}

class FakeWorkspaceView implements WorkspaceNavigationView {
  public state: WorkspaceNavigationState = {
    document: null,
    manuscripts: [],
    activeManuscriptId: null
  };
  public error: string | null = null;
  public readonly states: WorkspaceNavigationState[] = [];
  public readonly errors: Array<string | null> = [];

  public setWorkspaceState(state: WorkspaceNavigationState): void {
    this.state = state;
    this.states.push(state);
  }

  public setWorkspaceError(message: string | null): void {
    this.error = message;
    this.errors.push(message);
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function documentOpened(
  documentId = "document-1",
  manuscripts = [
    { manuscriptId: "manuscript-1", displayName: "manuscript.md" },
    { manuscriptId: "manuscript-2", displayName: "second.md" }
  ]
): OpenDocumentResult {
  return {
    kind: "opened",
    document: { documentId, displayName: documentId === "document-1" ? "First document" : "Second document" },
    manuscripts
  };
}

function manuscriptOpened(
  request: OpenManuscriptRequest,
  text = request.manuscriptId
): OpenManuscriptResult {
  return {
    kind: "opened",
    sessionId: `session-${request.manuscriptId}`,
    displayName: `${request.manuscriptId}.md`,
    text
  };
}

function makeHarness(options: {
  openDocument?: () => Promise<OpenDocumentResult>;
  openManuscript?: (request: OpenManuscriptRequest) => Promise<OpenManuscriptResult>;
  saveMarkdown?: (request: SaveMarkdownRequest) => Promise<SaveMarkdownResult>;
  decideDirtySwitch?: (context: DirtySwitchContext) => "save" | "discard" | "cancel" | Promise<"save" | "discard" | "cancel">;
} = {}) {
  const surface = new FakeSurface();
  const writingView = new FakeWritingView();
  const workspaceView = new FakeWorkspaceView();
  const openDocument = vi.fn(options.openDocument ?? (() => Promise.resolve(documentOpened())));
  const openManuscript = vi.fn(options.openManuscript ?? ((request: OpenManuscriptRequest) => Promise.resolve(manuscriptOpened(request))));
  const saveMarkdown = vi.fn(options.saveMarkdown ?? ((request: SaveMarkdownRequest) => Promise.resolve({
    kind: "saved",
    sessionId: request.sessionId,
    displayName: "saved.md",
    text: request.text
  } as const)));
  const api = {
    openMarkdown: vi.fn(() => Promise.resolve({ kind: "cancelled" } as const satisfies OpenMarkdownResult)),
    saveMarkdown,
    openDocument,
    openManuscript
  };
  const writing = new WritingController({
    api,
    surface,
    view: writingView,
    confirmReplace: () => true
  });
  const navigation = new WorkspaceNavigationController({
    api: api as WorkspaceNavigationApi & typeof api,
    writing,
    view: workspaceView,
    decideDirtySwitch: options.decideDirtySwitch ?? (() => "cancel")
  });
  return { api, navigation, surface, writing, writingView, workspaceView };
}

async function openDefault(navigation: WorkspaceNavigationController): Promise<void> {
  await navigation.openDocument();
}

function currentState(writing: WritingController): DocumentState {
  const state = writing.getDocumentState();
  if (!state) throw new Error("Expected an open writing document");
  return state;
}

describe("WorkspaceNavigationController", () => {
  it("opens a Document, reflects its list, and automatically opens the first manuscript", async () => {
    const harness = makeHarness();

    await harness.navigation.openDocument();

    expect(harness.api.openDocument).toHaveBeenCalledTimes(1);
    expect(harness.api.openManuscript).toHaveBeenCalledWith({
      documentId: "document-1",
      manuscriptId: "manuscript-1"
    });
    expect(harness.surface.text).toBe("manuscript-1");
    expect(harness.workspaceView.state).toEqual({
      document: { documentId: "document-1", displayName: "First document" },
      manuscripts: [
        { manuscriptId: "manuscript-1", displayName: "manuscript.md" },
        { manuscriptId: "manuscript-2", displayName: "second.md" }
      ],
      activeManuscriptId: "manuscript-1"
    });
    expect(currentState(harness.writing)).toMatchObject({
      documentId: "session-manuscript-1",
      currentText: "manuscript-1",
      savedText: "manuscript-1"
    });
    expect(harness.workspaceView.error).toBeNull();
  });

  it("switches clean manuscripts and makes selecting the active manuscript a no-op", async () => {
    const harness = makeHarness();
    await openDefault(harness.navigation);

    await harness.navigation.openManuscript("manuscript-2");
    await harness.navigation.openManuscript("manuscript-2");

    expect(harness.api.openManuscript).toHaveBeenCalledTimes(2);
    expect(harness.api.openManuscript).toHaveBeenLastCalledWith({
      documentId: "document-1",
      manuscriptId: "manuscript-2"
    });
    expect(harness.workspaceView.state.activeManuscriptId).toBe("manuscript-2");
    expect(harness.surface.text).toBe("manuscript-2");
  });

  it("saves dirty work before a manuscript switch", async () => {
    const decisions = vi.fn(() => "save" as const);
    const harness = makeHarness({ decideDirtySwitch: decisions });
    await openDefault(harness.navigation);
    harness.surface.edit("dirty manuscript");

    await harness.navigation.openManuscript("manuscript-2");

    expect(decisions).toHaveBeenCalledWith({
      currentDisplayName: "manuscript-1.md",
      target: { kind: "manuscript", displayName: "second.md" }
    });
    expect(harness.api.saveMarkdown).toHaveBeenCalledWith({
      sessionId: "session-manuscript-1",
      text: "dirty manuscript"
    });
    expect(harness.workspaceView.state.activeManuscriptId).toBe("manuscript-2");
    expect(currentState(harness.writing).currentText).toBe("manuscript-2");
  });

  it("saves dirty work before a Document switch", async () => {
    const decisions = vi.fn(() => "save" as const);
    let documentCalls = 0;
    const order: string[] = [];
    const harness = makeHarness({
      decideDirtySwitch: decisions,
      openDocument: vi.fn(async () => {
        order.push("document");
        documentCalls += 1;
        return documentCalls === 1
          ? documentOpened()
          : documentOpened("document-2", [{ manuscriptId: "manuscript-3", displayName: "new.md" }]);
      }),
      saveMarkdown: vi.fn(async (request) => {
        order.push("save");
        return {
          kind: "saved",
          sessionId: request.sessionId,
          displayName: "saved.md",
          text: request.text
        } as const;
      })
    });
    await openDefault(harness.navigation);
    harness.surface.edit("dirty document");

    await harness.navigation.openDocument();

    expect(order.slice(1)).toEqual(["save", "document"]);
    expect(harness.workspaceView.state.document).toEqual({ documentId: "document-2", displayName: "Second document" });
    expect(harness.workspaceView.state.activeManuscriptId).toBe("manuscript-3");
    expect(harness.surface.text).toBe("manuscript-3");
  });

  it.each([
    ["manuscript", "discard"],
    ["manuscript", "cancel"],
    ["document", "discard"],
    ["document", "cancel"]
  ] as const)("applies dirty %s navigation decision %s", async (target, decision) => {
    const decisions = vi.fn(() => decision);
    const harness = makeHarness({ decideDirtySwitch: decisions });
    await openDefault(harness.navigation);
    harness.surface.edit("unsaved");
    const initialDocumentCalls = harness.api.openDocument.mock.calls.length;
    const initialManuscriptCalls = harness.api.openManuscript.mock.calls.length;

    if (target === "manuscript") {
      await harness.navigation.openManuscript("manuscript-2");
    } else {
      await harness.navigation.openDocument();
    }

    expect(decisions).toHaveBeenCalledTimes(1);
    expect(harness.api.saveMarkdown).not.toHaveBeenCalled();
    if (decision === "cancel") {
      expect(harness.api.openDocument).toHaveBeenCalledTimes(initialDocumentCalls);
      expect(harness.api.openManuscript).toHaveBeenCalledTimes(initialManuscriptCalls);
      expect(harness.surface.text).toBe("unsaved");
      expect(currentState(harness.writing).currentText).toBe("unsaved");
    } else if (target === "manuscript") {
      expect(harness.api.openManuscript).toHaveBeenCalledTimes(initialManuscriptCalls + 1);
      expect(harness.workspaceView.state.activeManuscriptId).toBe("manuscript-2");
    } else {
      expect(harness.api.openDocument).toHaveBeenCalledTimes(initialDocumentCalls + 1);
    }
  });

  it.each([
    {
      kind: "conflict",
      code: "external-change",
      message: "The file changed on disk."
    },
    {
      kind: "error",
      code: "save-failed",
      message: "The file could not be saved."
    }
  ] as const)("does not switch after a dirty save $kind", async (saveResult) => {
    const harness = makeHarness({
      decideDirtySwitch: () => "save",
      saveMarkdown: async () => saveResult
    });
    await openDefault(harness.navigation);
    harness.surface.edit("unsaved");

    await harness.navigation.openManuscript("manuscript-2");

    expect(harness.api.openManuscript).toHaveBeenCalledTimes(1);
    expect(currentState(harness.writing)).toMatchObject({ currentText: "unsaved", savedText: "manuscript-1" });
    expect(harness.workspaceView.state.activeManuscriptId).toBe("manuscript-1");
    expect(harness.workspaceView.error).toBe("Save or discard the current manuscript before switching.");
  });

  it("does not switch when a save confirms an older snapshot but editing continues", async () => {
    const pending = deferred<SaveMarkdownResult>();
    const harness = makeHarness({
      decideDirtySwitch: () => "save",
      saveMarkdown: () => pending.promise
    });
    await openDefault(harness.navigation);
    harness.surface.edit("first");

    const switching = harness.navigation.openManuscript("manuscript-2");
    await Promise.resolve();
    harness.surface.edit("newer");
    pending.resolve({
      kind: "saved",
      sessionId: "session-manuscript-1",
      displayName: "manuscript-1.md",
      text: "first"
    });
    await switching;

    expect(harness.api.openManuscript).toHaveBeenCalledTimes(1);
    expect(currentState(harness.writing)).toMatchObject({ currentText: "newer", savedText: "first" });
    expect(harness.workspaceView.state.activeManuscriptId).toBe("manuscript-1");
    expect(harness.workspaceView.error).toBe("Save or discard the current manuscript before switching.");
  });

  it("clears the Writing state and surface for an empty Document", async () => {
    const harness = makeHarness({
      openDocument: async () => documentOpened("empty-document", [])
    });
    await openDefault(harness.navigation);

    await harness.navigation.openDocument();

    expect(harness.api.openManuscript).toHaveBeenCalledTimes(0);
    expect(harness.surface.text).toBe("");
    expect(harness.writing.getDocumentState()).toBeNull();
    expect(harness.workspaceView.state).toEqual({
      document: { documentId: "empty-document", displayName: "Second document" },
      manuscripts: [],
      activeManuscriptId: null
    });
    expect(harness.workspaceView.error).toBeNull();
  });

  it("keeps the new Document/list but clears the editor when its first manuscript fails", async () => {
    let documentCalls = 0;
    const harness = makeHarness({
      openDocument: async () => {
        documentCalls += 1;
        return documentCalls === 1
          ? documentOpened()
          : documentOpened("document-2", [{ manuscriptId: "manuscript-3", displayName: "new.md" }]);
      },
      openManuscript: async (request) => request.manuscriptId === "manuscript-1"
        ? manuscriptOpened(request)
        : {
          kind: "error",
          code: "missing-file",
          message: "The manuscript is missing."
        }
    });
    await openDefault(harness.navigation);
    await harness.navigation.openDocument();

    expect(harness.workspaceView.state).toEqual({
      document: { documentId: "document-2", displayName: "Second document" },
      manuscripts: [{ manuscriptId: "manuscript-3", displayName: "new.md" }],
      activeManuscriptId: null
    });
    expect(harness.writing.getDocumentState()).toBeNull();
    expect(harness.surface.text).toBe("");
    expect(harness.workspaceView.error).toBe("The manuscript is missing.");
  });

  it("ignores reentrant Document navigation while the first navigation is busy", async () => {
    let navigation: WorkspaceNavigationController;
    let documentCalls = 0;
    const harness = makeHarness({
      openDocument: async () => {
        documentCalls += 1;
        void navigation.openDocument();
        return documentOpened();
      }
    });
    navigation = harness.navigation;

    await navigation.openDocument();

    expect(documentCalls).toBe(1);
    expect(harness.api.openManuscript).toHaveBeenCalledTimes(1);
    expect(harness.workspaceView.state.activeManuscriptId).toBe("manuscript-1");
  });
});
