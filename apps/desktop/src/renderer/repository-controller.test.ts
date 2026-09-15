import { describe, expect, it, vi } from "vitest";
import type {
  CreateRepositoryHistoryResult,
  CreateRepositoryResult,
  ListRepositoryHistoryResult,
  OpenRepositoryDocumentResult,
  OpenRepositoryHistoryResult,
  OpenRepositoryResult,
  UseRepositoryShelfResult,
} from "../repository-ipc";
import {
  RepositoryController,
  type RepositoryControllerApi,
  type RepositoryControllerView,
  type RepositoryDocumentPort,
  type RepositoryHistoryViewState,
  type RepositoryKindOption,
  type RepositoryLibraryPort,
  type RepositoryWritingPort,
  type RepositoryViewState,
} from "./repository-controller";
import type {
  DocumentActivationOutcome,
  RepositoryDocumentActivationResult,
} from "./workspace-controller";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const WORKBENCH_ID = "22222222-2222-4222-8222-222222222222";
const SHELF_ID = "33333333-3333-4333-8333-333333333333";
const HISTORY_ONE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HISTORY_TWO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const projectRepository = {
  repositoryId: PROJECT_ID,
  kind: "project" as const,
  title: "Project",
  templateVersion: 1 as const,
};

const workbenchRepository = {
  repositoryId: WORKBENCH_ID,
  kind: "workbench" as const,
  title: "Workbench",
  templateVersion: 1 as const,
};

const shelfRepository = {
  repositoryId: SHELF_ID,
  kind: "shelf" as const,
  title: "Private Shelf",
  templateVersion: 1 as const,
};

class FakeView implements RepositoryControllerView {
  public state: RepositoryViewState = { repository: null, status: "idle", error: null };
  public historyState: RepositoryHistoryViewState = {
    entries: [],
    selectedHistoryId: null,
    status: "idle",
    error: null,
  };
  public readonly states: RepositoryViewState[] = [];
  public readonly historyStates: RepositoryHistoryViewState[] = [];

  public setRepositoryState(state: RepositoryViewState): void {
    this.state = state;
    this.states.push(state);
  }

  public setRepositoryHistoryState(state: RepositoryHistoryViewState): void {
    this.historyState = state;
    this.historyStates.push(state);
  }
}

class FakeWriting implements RepositoryWritingPort {
  public dirty = false;
  public calls = 0;

  public hasUnsavedChanges(): boolean {
    this.calls += 1;
    return this.dirty;
  }
}

class FakeWorkspace implements RepositoryDocumentPort {
  public outcome: DocumentActivationOutcome = "activated";
  public invokeLoader = true;
  public calls = 0;
  public lastRequest: Promise<RepositoryDocumentActivationResult> | null = null;

  public openDocumentFromRepository(
    load: () => Promise<RepositoryDocumentActivationResult>,
  ): Promise<DocumentActivationOutcome> {
    this.calls += 1;
    if (!this.invokeLoader) return Promise.resolve(this.outcome);
    this.lastRequest = load();
    return this.lastRequest.then(() => this.outcome);
  }
}

class FakeLibrary implements RepositoryLibraryPort {
  public result = true;
  public calls = 0;
  public lastResult: UseRepositoryShelfResult | null = null;

  public activateLibrary(result: UseRepositoryShelfResult): boolean {
    this.calls += 1;
    this.lastResult = result;
    return this.result;
  }
}

function documentResult(): OpenRepositoryDocumentResult {
  return {
    kind: "opened",
    document: { documentId: "44444444-4444-4444-8444-444444444444", displayName: "Project" },
    manuscripts: [],
  };
}

function shelfResult(): UseRepositoryShelfResult {
  return {
    kind: "opened",
    library: { libraryId: "55555555-5555-4555-8555-555555555555", displayName: "Private Shelf" },
    recordCount: 0,
    issueCount: 0,
  };
}

function historyList(
  repositoryId: string,
  entries: readonly { readonly historyId: string; readonly timestampMs: number }[] = [],
): ListRepositoryHistoryResult {
  return {
    kind: "history",
    repositoryId,
    entries,
    truncated: false,
  };
}

function historySnapshot(repositoryId: string, historyId = HISTORY_ONE): CreateRepositoryHistoryResult {
  return {
    kind: "snapshot",
    repositoryId,
    created: true,
    latest: { historyId, timestampMs: 1_700_000_000_000 },
  };
}

function createApi(overrides: Partial<RepositoryControllerApi> = {}): RepositoryControllerApi {
  return {
    createRepository: overrides.createRepository ?? vi.fn(() => Promise.resolve({
      kind: "opened",
      repository: projectRepository,
    } as const satisfies CreateRepositoryResult)),
    openRepository: overrides.openRepository ?? vi.fn(() => Promise.resolve({
      kind: "opened",
      repository: projectRepository,
    } as const satisfies OpenRepositoryResult)),
    openRepositoryDocument: overrides.openRepositoryDocument ?? vi.fn(() => Promise.resolve(documentResult())),
    useRepositoryShelf: overrides.useRepositoryShelf ?? vi.fn(() => Promise.resolve(shelfResult())),
    createRepositoryHistory: overrides.createRepositoryHistory ?? vi.fn(() => Promise.resolve(historySnapshot(PROJECT_ID))),
    listRepositoryHistory: overrides.listRepositoryHistory ?? vi.fn(() => Promise.resolve(historyList(PROJECT_ID))),
    openRepositoryHistory: overrides.openRepositoryHistory ?? vi.fn(() => Promise.resolve({ kind: "cancelled" } as const satisfies OpenRepositoryHistoryResult)),
  };
}

function makeHarness(
  api: RepositoryControllerApi = createApi(),
): {
  controller: RepositoryController;
  api: RepositoryControllerApi;
  view: FakeView;
  workspace: FakeWorkspace;
  library: FakeLibrary;
  writing: FakeWriting;
} {
  const view = new FakeView();
  const workspace = new FakeWorkspace();
  const library = new FakeLibrary();
  const writing = new FakeWriting();
  const controller = new RepositoryController({ api, workspace, library, view, writing });
  return { controller, api, view, workspace, library, writing };
}

describe("RepositoryController", () => {
  it("sends exact create values, activates a Project, and stores only the safe summary", async () => {
    const create = vi.fn((_request: { kind: RepositoryKindOption; title: string }) => Promise.resolve({
      kind: "opened",
      repository: projectRepository,
    } as const satisfies CreateRepositoryResult));
    const api = createApi({ createRepository: create });
    const harness = makeHarness(api);

    await harness.controller.create("project", "日本語 Project");

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ kind: "project", title: "日本語 Project" });
    expect(harness.workspace.calls).toBe(1);
    expect(harness.api.openRepositoryDocument).toHaveBeenCalledTimes(1);
    expect(harness.api.openRepositoryDocument).toHaveBeenCalledWith({ repositoryId: PROJECT_ID });
    expect(harness.view.state).toEqual({
      repository: projectRepository,
      status: "ready",
      error: null,
    });
    expect(Object.keys(harness.view.state.repository ?? {}).sort()).toEqual([
      "kind", "repositoryId", "templateVersion", "title"
    ]);
    const serialized = JSON.stringify(harness.controller.getState());
    expect(serialized).not.toContain("C:\\private");
    expect(serialized).not.toContain("head");
    expect(serialized).not.toContain("tracked");
  });

  it("opens a Workbench and uses the same explicit Document activation path", async () => {
    const openRepository = vi.fn(() => Promise.resolve({
      kind: "opened",
      repository: workbenchRepository,
    } as const satisfies OpenRepositoryResult));
    const harness = makeHarness(createApi({ openRepository }));

    await harness.controller.openRepository();

    expect(openRepository).toHaveBeenCalledTimes(1);
    expect(harness.api.openRepositoryDocument).toHaveBeenCalledWith({ repositoryId: WORKBENCH_ID });
    expect(harness.view.state.repository).toEqual(workbenchRepository);
    expect(harness.view.state.status).toBe("ready");
  });

  it.each([
    ["cancelled", "pending", "Activation was cancelled. Choose Activate to try again."],
    ["failed", "error", "The repository could not be activated. Try again."],
  ] as const)("keeps Project activation safe when shared Document navigation is %s", async (outcome, status, error) => {
    const harness = makeHarness();
    await harness.controller.openRepository();
    harness.workspace.outcome = outcome;

    await harness.controller.activateRepository();

    expect(harness.workspace.calls).toBe(2);
    expect(harness.view.state.repository).toEqual(projectRepository);
    expect(harness.view.state.status).toBe(status);
    expect(harness.view.state.error).toBe(error);
  });

  it("does not call the handoff API when shared dirty navigation cancels", async () => {
    const harness = makeHarness();
    harness.workspace.outcome = "cancelled";
    harness.workspace.invokeLoader = false;

    await harness.controller.openRepository();

    expect(harness.workspace.calls).toBe(1);
    expect(harness.api.openRepositoryDocument).not.toHaveBeenCalled();
    expect(harness.view.state.status).toBe("pending");
    expect(harness.view.state.repository).toEqual(projectRepository);
  });

  it("activates a Private Shelf explicitly without touching Document navigation", async () => {
    const openRepository = vi.fn(() => Promise.resolve({
      kind: "opened",
      repository: shelfRepository,
    } as const satisfies OpenRepositoryResult));
    const useRepositoryShelf = vi.fn(() => Promise.resolve(shelfResult()));
    const api = createApi({ openRepository, useRepositoryShelf });
    const harness = makeHarness(api);

    await harness.controller.openRepository();

    expect(useRepositoryShelf).toHaveBeenCalledTimes(1);
    expect(useRepositoryShelf).toHaveBeenCalledWith({ repositoryId: SHELF_ID });
    expect(harness.library.calls).toBe(1);
    expect(harness.workspace.calls).toBe(0);
    expect(harness.view.state).toEqual({ repository: shelfRepository, status: "ready", error: null });
  });

  it("keeps the active repository summary when a later repository dialog is cancelled", async () => {
    let calls = 0;
    const openRepository = vi.fn(() => {
      calls += 1;
      return Promise.resolve(calls === 1
        ? { kind: "opened", repository: projectRepository } as const
        : { kind: "cancelled" } as const satisfies OpenRepositoryResult);
    });
    const harness = makeHarness(createApi({ openRepository }));
    await harness.controller.openRepository();
    await harness.controller.openRepository();

    expect(harness.view.state.repository).toEqual(projectRepository);
    expect(harness.view.state.status).toBe("ready");
    expect(harness.view.state.error).toBeNull();
  });

  it("restores pending Project activation after a cancelled Open chooser", async () => {
    let openCalls = 0;
    const openRepository = vi.fn(() => {
      openCalls += 1;
      return Promise.resolve(openCalls === 1
        ? { kind: "opened", repository: projectRepository } as const
        : { kind: "cancelled" } as const satisfies OpenRepositoryResult);
    });
    const createRepositoryHistory = vi.fn(() => Promise.resolve(historySnapshot(PROJECT_ID)));
    const harness = makeHarness(createApi({ openRepository, createRepositoryHistory }));
    await harness.controller.openRepository();
    harness.workspace.outcome = "cancelled";
    await harness.controller.activateRepository();
    const before = harness.controller.getState();

    await harness.controller.openRepository();

    expect(harness.controller.getState()).toEqual(before);
    expect(harness.view.state).toEqual({
      repository: projectRepository,
      status: "pending",
      error: "Activation was cancelled. Choose Activate to try again.",
    });
    await harness.controller.recordHistory();
    expect(createRepositoryHistory).not.toHaveBeenCalled();
    expect(harness.view.state.status).toBe("pending");
  });

  it("restores Project activation errors after a cancelled Create chooser", async () => {
    const createRepository = vi.fn(() => Promise.resolve({
      kind: "cancelled",
    } as const satisfies CreateRepositoryResult));
    const createRepositoryHistory = vi.fn(() => Promise.resolve(historySnapshot(PROJECT_ID)));
    const harness = makeHarness(createApi({ createRepository, createRepositoryHistory }));
    await harness.controller.openRepository();
    harness.workspace.outcome = "failed";
    await harness.controller.activateRepository();
    const before = harness.controller.getState();

    await harness.controller.create("project", "Replacement");

    expect(harness.controller.getState()).toEqual(before);
    expect(harness.view.state).toEqual({
      repository: projectRepository,
      status: "error",
      error: "The repository could not be activated. Try again.",
    });
    await harness.controller.recordHistory();
    expect(createRepositoryHistory).not.toHaveBeenCalled();
  });

  it("restores a failed Shelf activation after a cancelled Open chooser", async () => {
    let openCalls = 0;
    const openRepository = vi.fn(() => {
      openCalls += 1;
      return Promise.resolve(openCalls === 1
        ? { kind: "opened", repository: shelfRepository } as const
        : { kind: "cancelled" } as const satisfies OpenRepositoryResult);
    });
    const useRepositoryShelf = vi.fn(() => Promise.resolve({
      kind: "error",
      code: "library-not-owned",
      message: "The shelf is no longer available.",
    } as const satisfies UseRepositoryShelfResult));
    const createRepositoryHistory = vi.fn(() => Promise.resolve(historySnapshot(SHELF_ID)));
    const harness = makeHarness(createApi({ openRepository, useRepositoryShelf, createRepositoryHistory }));
    harness.library.result = false;
    await harness.controller.openRepository();
    const before = harness.controller.getState();

    await harness.controller.openRepository();

    expect(harness.controller.getState()).toEqual(before);
    expect(harness.view.state).toEqual({
      repository: shelfRepository,
      status: "error",
      error: "The shelf is no longer available.",
    });
    await harness.controller.recordHistory();
    expect(createRepositoryHistory).not.toHaveBeenCalled();
  });

  it("restores a ready repository and its stable History list after cancellation", async () => {
    let openCalls = 0;
    const openRepository = vi.fn(() => {
      openCalls += 1;
      return Promise.resolve(openCalls === 1
        ? { kind: "opened", repository: projectRepository } as const
        : { kind: "cancelled" } as const satisfies OpenRepositoryResult);
    });
    const historyEntries = [{ historyId: HISTORY_ONE, timestampMs: 1_700_000_000_000 }];
    const listRepositoryHistory = vi.fn(() => Promise.resolve(historyList(PROJECT_ID, historyEntries)));
    const createRepositoryHistory = vi.fn(() => Promise.resolve(historySnapshot(PROJECT_ID, HISTORY_TWO)));
    const harness = makeHarness(createApi({ openRepository, listRepositoryHistory, createRepositoryHistory }));
    await harness.controller.openRepository();
    await harness.controller.refreshHistory();
    const before = harness.controller.getState();
    const beforeHistory = harness.controller.getHistoryState();

    await harness.controller.openRepository();

    expect(harness.controller.getState()).toEqual(before);
    expect(harness.controller.getHistoryState()).toEqual(beforeHistory);
    expect(harness.view.state.status).toBe("ready");
    await harness.controller.recordHistory();
    expect(createRepositoryHistory).toHaveBeenCalledWith({ repositoryId: PROJECT_ID });
  });

  it("restores the idle no-repository state after a cancelled Create chooser", async () => {
    const createRepository = vi.fn(() => Promise.resolve({
      kind: "cancelled",
    } as const satisfies CreateRepositoryResult));
    const createRepositoryHistory = vi.fn(() => Promise.resolve(historySnapshot(PROJECT_ID)));
    const harness = makeHarness(createApi({ createRepository, createRepositoryHistory }));

    await harness.controller.create("project", "Cancelled");

    expect(harness.view.state).toEqual({ repository: null, status: "idle", error: null });
    expect(harness.controller.getHistoryState()).toEqual({
      entries: [],
      selectedHistoryId: null,
      status: "idle",
      error: null,
    });
    await harness.controller.recordHistory();
    expect(createRepositoryHistory).not.toHaveBeenCalled();
  });

  it("rejects activation without a repository and sanitizes API failures", async () => {
    const harness = makeHarness(createApi({
      openRepository: async () => {
        throw new Error("stack C:\\private\\repository");
      },
    }));
    await harness.controller.activateRepository();
    expect(harness.view.state.error).toBe("Open or create a repository before activating it.");

    await harness.controller.openRepository();
    expect(harness.view.state.status).toBe("error");
    expect(harness.view.state.error).toBe("The repository could not be opened. Choose it again.");
    expect(JSON.stringify(harness.controller.getState())).not.toContain("C:\\private");
  });

  it("coalesces double actions while the first operation is pending", async () => {
    let resolveOpen!: (result: OpenRepositoryResult) => void;
    const pending = new Promise<OpenRepositoryResult>((resolve) => {
      resolveOpen = resolve;
    });
    const openRepository = vi.fn(() => pending);
    const harness = makeHarness(createApi({ openRepository }));

    const first = harness.controller.openRepository();
    const second = harness.controller.openRepository();
    expect(openRepository).toHaveBeenCalledTimes(1);
    resolveOpen({ kind: "cancelled" });
    await Promise.all([first, second]);
    expect(harness.view.state.repository).toBeNull();
    expect(harness.view.state.status).toBe("idle");
  });

  it("keeps a failed shelf activation explicit and leaves workspace untouched", async () => {
    const openRepository = vi.fn(() => Promise.resolve({
      kind: "opened",
      repository: shelfRepository,
    } as const satisfies OpenRepositoryResult));
    const useRepositoryShelf = vi.fn(() => Promise.resolve({
      kind: "error",
      code: "library-not-owned",
      message: "The shelf is no longer available.",
    } as const satisfies UseRepositoryShelfResult));
    const harness = makeHarness(createApi({ openRepository, useRepositoryShelf }));
    harness.library.result = false;

    await harness.controller.openRepository();

    expect(harness.workspace.calls).toBe(0);
    expect(harness.library.calls).toBe(1);
    expect(harness.view.state.repository).toEqual(shelfRepository);
    expect(harness.view.state.status).toBe("error");
    expect(harness.view.state.error).toBe("The shelf is no longer available.");
  });

  it("keeps History renderer state opaque and newest-first", async () => {
    const listRepositoryHistory = vi.fn(() => Promise.resolve({
      kind: "history",
      repositoryId: PROJECT_ID,
      entries: [
        { historyId: HISTORY_ONE, timestampMs: 1_700_000_000_000, oid: "a".repeat(40), path: "C:\\private" },
        { historyId: HISTORY_TWO, timestampMs: 1_700_000_001_000, oid: "b".repeat(40), path: ".git/HEAD" },
      ],
      truncated: false,
    } as unknown as ListRepositoryHistoryResult));
    const harness = makeHarness(createApi({ listRepositoryHistory }));

    await harness.controller.openRepository();
    await harness.controller.refreshHistory();

    expect(harness.controller.getHistoryState()).toEqual({
      entries: [
        { historyId: HISTORY_TWO, timestampMs: 1_700_000_001_000 },
        { historyId: HISTORY_ONE, timestampMs: 1_700_000_000_000 },
      ],
      selectedHistoryId: null,
      status: "ready",
      error: null,
    });
    const serialized = JSON.stringify(harness.controller.getHistoryState());
    expect(serialized).not.toContain("C:\\private");
    expect(serialized).not.toContain(".git/HEAD");
    expect(serialized).not.toContain("a".repeat(40));
    expect(serialized).not.toMatch(/\b(?:git|oid|path)\b/i);
    expect(Object.keys(harness.controller.getHistoryState().entries[0] ?? {}).sort()).toEqual([
      "historyId",
      "timestampMs",
    ]);
  });

  it("refuses a Project History record while the authored manuscript is dirty", async () => {
    const createRepositoryHistory = vi.fn(() => Promise.resolve(historySnapshot(PROJECT_ID)));
    const listRepositoryHistory = vi.fn(() => Promise.resolve(historyList(PROJECT_ID)));
    const harness = makeHarness(createApi({ createRepositoryHistory, listRepositoryHistory }));
    await harness.controller.openRepository();
    harness.writing.dirty = true;

    await harness.controller.recordHistory();

    expect(harness.writing.calls).toBe(1);
    expect(createRepositoryHistory).not.toHaveBeenCalled();
    expect(listRepositoryHistory).not.toHaveBeenCalled();
    expect(harness.view.historyState.error).toBe(
      "Save or discard the current manuscript before recording History."
    );
  });

  it("records clean Project History and refreshes the bounded list", async () => {
    const createRepositoryHistory = vi.fn(() => Promise.resolve(historySnapshot(PROJECT_ID, HISTORY_TWO)));
    const listRepositoryHistory = vi.fn(() => Promise.resolve(historyList(PROJECT_ID, [
      { historyId: HISTORY_TWO, timestampMs: 1_700_000_002_000 },
      { historyId: HISTORY_ONE, timestampMs: 1_700_000_001_000 },
    ])));
    const harness = makeHarness(createApi({ createRepositoryHistory, listRepositoryHistory }));
    await harness.controller.openRepository();

    await harness.controller.recordHistory();

    expect(createRepositoryHistory).toHaveBeenCalledWith({ repositoryId: PROJECT_ID });
    expect(listRepositoryHistory).toHaveBeenCalledWith({ repositoryId: PROJECT_ID });
    expect(harness.view.historyState.status).toBe("ready");
    expect(harness.view.historyState.entries.map((entry) => entry.historyId)).toEqual([
      HISTORY_TWO,
      HISTORY_ONE,
    ]);
    expect(harness.writing.calls).toBe(1);
  });

  it("permits Shelf History without querying authored-document dirtiness", async () => {
    const openRepository = vi.fn(() => Promise.resolve({
      kind: "opened",
      repository: shelfRepository,
    } as const satisfies OpenRepositoryResult));
    const createRepositoryHistory = vi.fn(() => Promise.resolve(historySnapshot(SHELF_ID)));
    const listRepositoryHistory = vi.fn(() => Promise.resolve(historyList(SHELF_ID, [
      { historyId: HISTORY_ONE, timestampMs: 1_700_000_000_000 },
    ])));
    const harness = makeHarness(createApi({ openRepository, createRepositoryHistory, listRepositoryHistory }));
    await harness.controller.openRepository();
    harness.writing.dirty = true;

    await harness.controller.recordHistory();

    expect(harness.writing.calls).toBe(0);
    expect(createRepositoryHistory).toHaveBeenCalledWith({ repositoryId: SHELF_ID });
    expect(listRepositoryHistory).toHaveBeenCalledWith({ repositoryId: SHELF_ID });
    expect(harness.view.historyState.status).toBe("ready");
  });

  it("reports History list and copy failures without losing the active repository", async () => {
    const listRepositoryHistory = vi.fn(() => Promise.resolve({
      kind: "error",
      code: "repository-not-owned",
      message: "History unavailable.",
    } as const satisfies ListRepositoryHistoryResult));
    const harness = makeHarness(createApi({ listRepositoryHistory }));
    await harness.controller.openRepository();
    await harness.controller.refreshHistory();

    expect(harness.view.state.repository).toEqual(projectRepository);
    expect(harness.view.historyState.status).toBe("error");
    expect(harness.view.historyState.error).toBe("History unavailable.");

    const openRepositoryHistory = vi.fn(() => Promise.resolve({
      kind: "error",
      code: "history-not-found",
      message: "That saved version is gone.",
    } as const satisfies OpenRepositoryHistoryResult));
    const entries = [{ historyId: HISTORY_ONE, timestampMs: 1_700_000_000_000 }];
    const retryHarness = makeHarness(createApi({
      listRepositoryHistory: vi.fn(() => Promise.resolve(historyList(PROJECT_ID, entries))),
      openRepositoryHistory,
    }));
    await retryHarness.controller.openRepository();
    await retryHarness.controller.refreshHistory();
    retryHarness.controller.selectHistory(HISTORY_ONE);
    await retryHarness.controller.openHistoryCopy();

    expect(openRepositoryHistory).toHaveBeenCalledWith({ repositoryId: PROJECT_ID, historyId: HISTORY_ONE });
    expect(retryHarness.view.state.repository).toEqual(projectRepository);
    expect(retryHarness.view.historyState.error).toBe("That saved version is gone.");
  });

  it("keeps a cancelled History copy selected so the user can retry", async () => {
    const openRepositoryHistory = vi.fn(() => Promise.resolve({
      kind: "cancelled",
    } as const satisfies OpenRepositoryHistoryResult));
    const entries = [{ historyId: HISTORY_ONE, timestampMs: 1_700_000_000_000 }];
    const harness = makeHarness(createApi({
      listRepositoryHistory: vi.fn(() => Promise.resolve(historyList(PROJECT_ID, entries))),
      openRepositoryHistory,
    }));
    await harness.controller.openRepository();
    await harness.controller.refreshHistory();
    harness.controller.selectHistory(HISTORY_ONE);
    await harness.controller.openHistoryCopy();

    expect(harness.view.state.repository).toEqual(projectRepository);
    expect(harness.view.historyState.selectedHistoryId).toBe(HISTORY_ONE);
    expect(harness.view.historyState.status).toBe("ready");
    expect(harness.view.historyState.error).toBe(
      "Opening the History copy was cancelled. Choose Open History Copy to try again."
    );
  });

  it("activates an opened Project History copy through the dirty-safe workspace boundary", async () => {
    const copyRepository = {
      repositoryId: "66666666-6666-4666-8666-666666666666",
      kind: "project" as const,
      title: "Older Project",
      templateVersion: 1 as const,
    };
    const openRepositoryHistory = vi.fn(() => Promise.resolve({
      kind: "opened",
      repository: copyRepository,
    } as const satisfies OpenRepositoryHistoryResult));
    const entries = [{ historyId: HISTORY_ONE, timestampMs: 1_700_000_000_000 }];
    const harness = makeHarness(createApi({
      listRepositoryHistory: vi.fn(() => Promise.resolve(historyList(PROJECT_ID, entries))),
      openRepositoryHistory,
    }));
    await harness.controller.openRepository();
    await harness.controller.refreshHistory();
    harness.controller.selectHistory(HISTORY_ONE);
    harness.workspace.outcome = "cancelled";

    await harness.controller.openHistoryCopy();

    expect(openRepositoryHistory).toHaveBeenCalledWith({ repositoryId: PROJECT_ID, historyId: HISTORY_ONE });
    expect(harness.workspace.calls).toBe(2);
    expect(harness.view.state.repository).toEqual(copyRepository);
    expect(harness.view.state.repository?.repositoryId).not.toBe(PROJECT_ID);
    expect(harness.view.state.status).toBe("pending");
    expect(harness.view.historyState.entries).toEqual([]);

    harness.workspace.outcome = "activated";
    await harness.controller.activateRepository();
    expect(harness.view.state.repository).toEqual(copyRepository);
    expect(harness.view.state.status).toBe("ready");
  });

  it("activates an opened Shelf History copy via Library without touching Document", async () => {
    const copyRepository = {
      repositoryId: "77777777-7777-4777-8777-777777777777",
      kind: "shelf" as const,
      title: "Older Shelf",
      templateVersion: 1 as const,
    };
    const openRepository = vi.fn(() => Promise.resolve({
      kind: "opened",
      repository: shelfRepository,
    } as const satisfies OpenRepositoryResult));
    const useRepositoryShelf = vi.fn(() => Promise.resolve(shelfResult()));
    const openRepositoryHistory = vi.fn(() => Promise.resolve({
      kind: "opened",
      repository: copyRepository,
    } as const satisfies OpenRepositoryHistoryResult));
    const entries = [{ historyId: HISTORY_ONE, timestampMs: 1_700_000_000_000 }];
    const harness = makeHarness(createApi({
      openRepository,
      useRepositoryShelf,
      listRepositoryHistory: vi.fn(() => Promise.resolve(historyList(SHELF_ID, entries))),
      openRepositoryHistory,
    }));
    await harness.controller.openRepository();
    await harness.controller.refreshHistory();
    harness.controller.selectHistory(HISTORY_ONE);

    await harness.controller.openHistoryCopy();

    expect(openRepositoryHistory).toHaveBeenCalledWith({ repositoryId: SHELF_ID, historyId: HISTORY_ONE });
    expect(harness.workspace.calls).toBe(0);
    expect(harness.library.calls).toBe(2);
    expect(harness.view.state.repository).toEqual(copyRepository);
    expect(harness.view.state.status).toBe("ready");
  });

  it("does not let a pending History list replace a newer repository operation", async () => {
    let resolveList!: (result: ListRepositoryHistoryResult) => void;
    const pendingList = new Promise<ListRepositoryHistoryResult>((resolve) => {
      resolveList = resolve;
    });
    const listRepositoryHistory = vi.fn(() => pendingList);
    let openCalls = 0;
    const openRepository = vi.fn(() => {
      openCalls += 1;
      return Promise.resolve(openCalls === 1
        ? { kind: "opened", repository: projectRepository } as const
        : { kind: "opened", repository: workbenchRepository } as const);
    });
    const harness = makeHarness(createApi({ listRepositoryHistory, openRepository }));
    await harness.controller.openRepository();
    const refresh = harness.controller.refreshHistory();
    const newerOpen = harness.controller.openRepository();
    expect(openRepository).toHaveBeenCalledTimes(2);
    resolveList(historyList(PROJECT_ID, [{ historyId: HISTORY_ONE, timestampMs: 1_700_000_000_000 }]));
    await Promise.all([refresh, newerOpen]);

    expect(harness.view.state.repository).toEqual(workbenchRepository);
    expect(harness.view.historyState.entries).toEqual([]);
    expect(harness.view.historyState.status).toBe("idle");
  });
});
