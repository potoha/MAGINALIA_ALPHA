import type {
  CreateRepositoryHistoryResult,
  CreateRepositoryResult,
  ListRepositoryHistoryResult,
  OpenRepositoryDocumentResult,
  OpenRepositoryHistoryResult,
  OpenRepositoryResult,
  RepositoryHistoryCopyRequest,
  RepositoryHistoryRequest,
  RepositoryHandoffRequest,
  UseRepositoryShelfResult,
  CreateRepositoryRequest,
} from "../repository-ipc";
import type {
  DocumentActivationOutcome,
  RepositoryDocumentActivationResult,
} from "./workspace-controller";

export type RepositoryKindOption = CreateRepositoryRequest["kind"];

/** Renderer-safe repository summary; roots and administrative state stay in main. */
export interface RepositoryViewSummary {
  readonly repositoryId: string;
  readonly kind: RepositoryKindOption;
  readonly title: string;
  readonly templateVersion: 1;
}

export type RepositoryControllerStatus =
  | "idle"
  | "creating"
  | "opening"
  | "activating"
  | "ready"
  | "pending"
  | "error";

export interface RepositoryViewState {
  readonly repository: RepositoryViewSummary | null;
  readonly status: RepositoryControllerStatus;
  readonly error: string | null;
}

export interface RepositoryHistoryEntry {
  readonly historyId: string;
  readonly timestampMs: number;
}

export type RepositoryHistoryStatus = "idle" | "loading" | "recording" | "opening" | "ready" | "error";

export interface RepositoryHistoryViewState {
  readonly entries: readonly RepositoryHistoryEntry[];
  readonly selectedHistoryId: string | null;
  readonly status: RepositoryHistoryStatus;
  readonly error: string | null;
}

export interface RepositoryControllerView {
  setRepositoryState(state: RepositoryViewState): void;
  setRepositoryHistoryState?(state: RepositoryHistoryViewState): void;
}

export interface RepositoryControllerApi {
  createRepository(request: CreateRepositoryRequest): Promise<CreateRepositoryResult>;
  openRepository(): Promise<OpenRepositoryResult>;
  openRepositoryDocument(request: RepositoryHandoffRequest): Promise<OpenRepositoryDocumentResult>;
  useRepositoryShelf(request: RepositoryHandoffRequest): Promise<UseRepositoryShelfResult>;
  createRepositoryHistory(request: RepositoryHistoryRequest): Promise<CreateRepositoryHistoryResult>;
  listRepositoryHistory(request: RepositoryHistoryRequest): Promise<ListRepositoryHistoryResult>;
  openRepositoryHistory(request: RepositoryHistoryCopyRequest): Promise<OpenRepositoryHistoryResult>;
}

/** Read-only bridge to the active Writing document's dirty state. */
export interface RepositoryWritingPort {
  hasUnsavedChanges(): boolean;
}

export interface RepositoryDocumentPort {
  openDocumentFromRepository(
    load: () => Promise<RepositoryDocumentActivationResult>
  ): Promise<DocumentActivationOutcome>;
}

export interface RepositoryLibraryPort {
  activateLibrary(result: UseRepositoryShelfResult): boolean;
}

export interface RepositoryControllerOptions {
  readonly api: RepositoryControllerApi;
  readonly workspace: RepositoryDocumentPort | null;
  readonly library: RepositoryLibraryPort | null;
  readonly view: RepositoryControllerView;
  readonly writing?: RepositoryWritingPort | null;
}

const EMPTY_STATE: RepositoryViewState = Object.freeze({
  repository: null,
  status: "idle",
  error: null,
});

const EMPTY_HISTORY_STATE: RepositoryHistoryViewState = Object.freeze({
  entries: Object.freeze([]),
  selectedHistoryId: null,
  status: "idle",
  error: null,
});

const CREATE_FAILED = "The repository could not be created. Try again.";
const OPEN_FAILED = "The repository could not be opened. Choose it again.";
const ACTIVATION_FAILED = "The repository could not be activated. Try again.";
const ACTIVATION_CANCELLED = "Activation was cancelled. Choose Activate to try again.";
const NO_REPOSITORY = "Open or create a repository before activating it.";
const UNAVAILABLE = "Repository controls are unavailable. Reload MAGINALIA to try again.";
const HISTORY_NO_REPOSITORY = "Open or create a repository before using History.";
const HISTORY_NOT_READY = "Activate the repository before recording History.";
const HISTORY_DIRTY = "Save or discard the current manuscript before recording History.";
const HISTORY_RECORD_FAILED = "Repository History could not be recorded. Try again.";
const HISTORY_LIST_FAILED = "Repository History could not be refreshed. Try again.";
const HISTORY_COPY_FAILED = "The selected History version could not be opened as a copy.";
const HISTORY_COPY_CANCELLED = "Opening the History copy was cancelled. Choose Open History Copy to try again.";

function copyRepository(repository: RepositoryViewSummary): RepositoryViewSummary {
  return Object.freeze({
    repositoryId: repository.repositoryId,
    kind: repository.kind,
    title: repository.title,
    templateVersion: 1 as const,
  });
}

function copyState(state: RepositoryViewState): RepositoryViewState {
  return Object.freeze({
    repository: state.repository === null ? null : copyRepository(state.repository),
    status: state.status,
    error: state.error,
  });
}

function copyHistoryEntry(entry: RepositoryHistoryEntry): RepositoryHistoryEntry {
  return Object.freeze({
    historyId: entry.historyId,
    timestampMs: entry.timestampMs,
  });
}

function copyHistoryState(state: RepositoryHistoryViewState): RepositoryHistoryViewState {
  return Object.freeze({
    entries: Object.freeze(state.entries.map(copyHistoryEntry)),
    selectedHistoryId: state.selectedHistoryId,
    status: state.status,
    error: state.error,
  });
}

function copyOpenedRepository(result: Extract<CreateRepositoryResult | OpenRepositoryResult, { kind: "opened" }>): RepositoryViewSummary {
  return copyRepository(result.repository);
}

function copyOpenedHistoryRepository(
  result: Extract<OpenRepositoryHistoryResult, { kind: "opened" }>,
): RepositoryViewSummary {
  return copyRepository(result.repository);
}

function isOpenedRepository(
  result: CreateRepositoryResult | OpenRepositoryResult,
): result is Extract<CreateRepositoryResult | OpenRepositoryResult, { kind: "opened" }> {
  return result.kind === "opened"
    && result.repository !== null
    && typeof result.repository === "object";
}

interface RepositoryDialogSnapshot {
  readonly state: RepositoryViewState;
  readonly history: RepositoryHistoryViewState;
  readonly historyBusy: boolean;
}

export class RepositoryController {
  private readonly api: RepositoryControllerApi;
  private readonly workspace: RepositoryDocumentPort | null;
  private readonly library: RepositoryLibraryPort | null;
  private readonly writing: RepositoryWritingPort | null;
  private readonly view: RepositoryControllerView;
  private state: RepositoryViewState = EMPTY_STATE;
  private historyState: RepositoryHistoryViewState = EMPTY_HISTORY_STATE;
  private generation = 0;
  private historyGeneration = 0;
  private busy = false;
  private historyBusy = false;

  public constructor(options: RepositoryControllerOptions) {
    this.api = options.api;
    this.workspace = options.workspace;
    this.library = options.library;
    this.writing = options.writing ?? null;
    this.view = options.view;
    this.render();
    this.renderHistory();
  }

  public getState(): RepositoryViewState {
    return copyState(this.state);
  }

  public getHistoryState(): RepositoryHistoryViewState {
    return copyHistoryState(this.historyState);
  }

  public create(kind: RepositoryKindOption, title: string): Promise<void> {
    if (this.busy) return Promise.resolve();
    const previous = this.captureDialogSnapshot();
    const operation = this.begin("creating");
    return this.createOperation(operation, { kind, title }, previous);
  }

  public openRepository(): Promise<void> {
    if (this.busy) return Promise.resolve();
    const previous = this.captureDialogSnapshot();
    const operation = this.begin("opening");
    return this.openOperation(operation, previous);
  }

  public activateRepository(): Promise<void> {
    if (this.busy) return Promise.resolve();
    const repository = this.state.repository;
    if (repository === null) {
      this.generation += 1;
      this.replaceState({ status: "error", error: NO_REPOSITORY });
      return Promise.resolve();
    }
    const operation = this.begin("activating");
    return this.activateOperation(operation, repository);
  }

  public refreshHistory(): Promise<void> {
    if (this.busy || this.historyBusy) return Promise.resolve();
    const repository = this.state.repository;
    if (repository === null) {
      this.historyGeneration += 1;
      this.replaceHistoryState({ status: "error", error: HISTORY_NO_REPOSITORY });
      return Promise.resolve();
    }

    const operation = this.beginHistory("loading");
    return this.listHistoryOperation(operation, this.generation, repository.repositoryId);
  }

  public recordHistory(): Promise<void> {
    if (this.busy || this.historyBusy) return Promise.resolve();
    const repository = this.state.repository;
    if (repository === null) {
      this.historyGeneration += 1;
      this.replaceHistoryState({ status: "error", error: HISTORY_NO_REPOSITORY });
      return Promise.resolve();
    }
    if (this.state.status !== "ready") {
      this.historyGeneration += 1;
      this.replaceHistoryState({ status: "error", error: HISTORY_NOT_READY });
      return Promise.resolve();
    }
    if (repository.kind !== "shelf" && this.hasUnsavedChanges()) {
      this.historyGeneration += 1;
      this.replaceHistoryState({ status: "error", error: HISTORY_DIRTY });
      return Promise.resolve();
    }

    const operation = this.beginHistory("recording");
    return this.recordHistoryOperation(operation, this.generation, repository.repositoryId);
  }

  public selectHistory(historyId: string | null): void {
    if (this.historyBusy) return;
    const selectedHistoryId = historyId !== null
      && this.historyState.entries.some((entry) => entry.historyId === historyId)
      ? historyId
      : null;
    if (selectedHistoryId === this.historyState.selectedHistoryId && this.historyState.error === null) return;
    this.historyGeneration += 1;
    this.replaceHistoryState({ selectedHistoryId, status: "ready", error: null });
  }

  public openHistoryCopy(): Promise<void> {
    if (this.busy || this.historyBusy) return Promise.resolve();
    const repository = this.state.repository;
    const selectedHistoryId = this.historyState.selectedHistoryId;
    if (repository === null) {
      this.historyGeneration += 1;
      this.replaceHistoryState({ status: "error", error: HISTORY_NO_REPOSITORY });
      return Promise.resolve();
    }
    if (selectedHistoryId === null) {
      this.historyGeneration += 1;
      this.replaceHistoryState({ status: "error", error: "Select a History version before opening a copy." });
      return Promise.resolve();
    }

    const operation = this.beginHistory("opening");
    return this.openHistoryCopyOperation(
      operation,
      this.generation,
      repository.repositoryId,
      selectedHistoryId,
    );
  }

  private begin(status: RepositoryControllerStatus): number {
    this.busy = true;
    this.historyGeneration += 1;
    this.historyBusy = false;
    this.historyState = EMPTY_HISTORY_STATE;
    const operation = ++this.generation;
    this.replaceState({ status, error: null });
    this.renderHistory();
    return operation;
  }

  private beginHistory(status: RepositoryHistoryStatus): number {
    this.historyBusy = true;
    const operation = ++this.historyGeneration;
    this.replaceHistoryState({ status, error: null });
    return operation;
  }

  private async createOperation(
    operation: number,
    request: CreateRepositoryRequest,
    previous: RepositoryDialogSnapshot,
  ): Promise<void> {
    let result: CreateRepositoryResult;
    try {
      result = await this.api.createRepository({ kind: request.kind, title: request.title });
    } catch (_error: unknown) {
      if (operation === this.generation) this.replaceState({ status: "error", error: CREATE_FAILED });
      this.finish(operation);
      return;
    }
    if (operation !== this.generation) return;
    if (result.kind === "cancelled") {
      this.restoreAfterDialog(operation, previous);
      return;
    }
    if (!isOpenedRepository(result)) {
      this.replaceState({ status: "error", error: result.message });
      this.finish(operation);
      return;
    }
    await this.activateOperation(operation, copyOpenedRepository(result));
  }

  private async openOperation(operation: number, previous: RepositoryDialogSnapshot): Promise<void> {
    let result: OpenRepositoryResult;
    try {
      result = await this.api.openRepository();
    } catch (_error: unknown) {
      if (operation === this.generation) this.replaceState({ status: "error", error: OPEN_FAILED });
      this.finish(operation);
      return;
    }
    if (operation !== this.generation) return;
    if (result.kind === "cancelled") {
      this.restoreAfterDialog(operation, previous);
      return;
    }
    if (!isOpenedRepository(result)) {
      this.replaceState({ status: "error", error: result.message });
      this.finish(operation);
      return;
    }
    await this.activateOperation(operation, copyOpenedRepository(result));
  }

  private async activateOperation(operation: number, repository: RepositoryViewSummary): Promise<void> {
    if (operation !== this.generation) return;
    this.replaceState({ repository, status: "activating", error: null });

    if (repository.kind === "shelf") {
      if (this.library === null) {
        this.finishWithError(operation, UNAVAILABLE);
        return;
      }
      let result: UseRepositoryShelfResult;
      try {
        result = await this.api.useRepositoryShelf({ repositoryId: repository.repositoryId });
      } catch (_error: unknown) {
        this.finishWithError(operation, ACTIVATION_FAILED);
        return;
      }
      if (operation !== this.generation) return;
      const activated = this.library.activateLibrary(result);
      if (activated) {
        this.replaceState({ status: "ready", error: null });
      } else {
        this.finishWithError(operation, result.kind === "error" ? result.message : ACTIVATION_FAILED);
        return;
      }
      this.finish(operation);
      return;
    }

    if (this.workspace === null) {
      this.finishWithError(operation, UNAVAILABLE);
      return;
    }
    let outcome: DocumentActivationOutcome;
    try {
      outcome = await this.workspace.openDocumentFromRepository(
        () => this.api.openRepositoryDocument({ repositoryId: repository.repositoryId }),
      );
    } catch (_error: unknown) {
      this.finishWithError(operation, ACTIVATION_FAILED);
      return;
    }
    if (operation !== this.generation) return;
    if (outcome === "activated") {
      this.replaceState({ status: "ready", error: null });
    } else if (outcome === "cancelled") {
      this.replaceState({ status: "pending", error: ACTIVATION_CANCELLED });
    } else {
      this.finishWithError(operation, ACTIVATION_FAILED);
      return;
    }
    this.finish(operation);
  }

  private async listHistoryOperation(
    operation: number,
    repositoryGeneration: number,
    repositoryId: string,
  ): Promise<void> {
    let result: ListRepositoryHistoryResult;
    try {
      result = await this.api.listRepositoryHistory({ repositoryId });
    } catch (_error: unknown) {
      if (this.isCurrentHistoryOperation(operation, repositoryGeneration, repositoryId)) {
        this.replaceHistoryState({ status: "error", error: HISTORY_LIST_FAILED });
        this.historyBusy = false;
      }
      return;
    }
    if (!this.isCurrentHistoryOperation(operation, repositoryGeneration, repositoryId)) return;
    if (result.kind !== "history" || result.repositoryId !== repositoryId) {
      this.replaceHistoryState({ status: "error", error: result.kind === "error" ? result.message : HISTORY_LIST_FAILED });
      this.historyBusy = false;
      return;
    }

    const entries = result.entries
      .map((entry) => ({ historyId: entry.historyId, timestampMs: entry.timestampMs }))
      .sort((left, right) => right.timestampMs - left.timestampMs);
    this.replaceHistoryState({
      entries,
      selectedHistoryId: null,
      status: "ready",
      error: null,
    });
    this.historyBusy = false;
  }

  private async recordHistoryOperation(
    operation: number,
    repositoryGeneration: number,
    repositoryId: string,
  ): Promise<void> {
    let result: CreateRepositoryHistoryResult;
    try {
      result = await this.api.createRepositoryHistory({ repositoryId });
    } catch (_error: unknown) {
      if (this.isCurrentHistoryOperation(operation, repositoryGeneration, repositoryId)) {
        this.replaceHistoryState({ status: "error", error: HISTORY_RECORD_FAILED });
        this.historyBusy = false;
      }
      return;
    }
    if (!this.isCurrentHistoryOperation(operation, repositoryGeneration, repositoryId)) return;
    if (result.kind !== "snapshot" || result.repositoryId !== repositoryId) {
      this.replaceHistoryState({ status: "error", error: result.kind === "error" ? result.message : HISTORY_RECORD_FAILED });
      this.historyBusy = false;
      return;
    }

    // A successful snapshot is followed by a bounded refresh so the newest
    // renderer-safe entry is immediately selectable without exposing the
    // snapshot's OID or any repository path.
    this.replaceHistoryState({ status: "loading", error: null });
    await this.listHistoryOperation(operation, repositoryGeneration, repositoryId);
  }

  private async openHistoryCopyOperation(
    operation: number,
    repositoryGeneration: number,
    repositoryId: string,
    historyId: string,
  ): Promise<void> {
    let result: OpenRepositoryHistoryResult;
    try {
      result = await this.api.openRepositoryHistory({ repositoryId, historyId });
    } catch (_error: unknown) {
      if (this.isCurrentHistoryOperation(operation, repositoryGeneration, repositoryId)) {
        this.replaceHistoryState({ status: "error", error: HISTORY_COPY_FAILED });
        this.historyBusy = false;
      }
      return;
    }
    if (!this.isCurrentHistoryOperation(operation, repositoryGeneration, repositoryId)) return;
    if (result.kind === "cancelled") {
      this.replaceHistoryState({ status: "ready", error: HISTORY_COPY_CANCELLED });
      this.historyBusy = false;
      return;
    }
    if (result.kind !== "opened") {
      this.replaceHistoryState({ status: "error", error: result.kind === "error" ? result.message : HISTORY_COPY_FAILED });
      this.historyBusy = false;
      return;
    }

    const copy = copyOpenedHistoryRepository(result);
    this.historyState = EMPTY_HISTORY_STATE;
    this.renderHistory();
    const activationOperation = ++this.generation;
    this.replaceState({ repository: copy, status: "pending", error: null });
    await this.activateOperation(activationOperation, copy);
    this.historyBusy = false;
  }

  private captureDialogSnapshot(): RepositoryDialogSnapshot {
    return Object.freeze({
      state: copyState(this.state),
      history: copyHistoryState(this.historyState),
      historyBusy: this.historyBusy,
    });
  }

  private restoreAfterDialog(operation: number, previous: RepositoryDialogSnapshot): void {
    if (operation !== this.generation) return;
    this.state = copyState(previous.state);
    this.render();
    // A chooser supersedes any in-flight History request.  Restore a stable
    // prior list when one existed, but never resurrect a stale loading/recording
    // operation that could leave the controller busy forever.
    this.historyState = previous.historyBusy
      ? EMPTY_HISTORY_STATE
      : copyHistoryState(previous.history);
    this.historyBusy = false;
    this.renderHistory();
    this.finish(operation);
  }

  private finishWithError(operation: number, message: string): void {
    if (operation !== this.generation) return;
    this.replaceState({ status: "error", error: message });
    this.finish(operation);
  }

  private finish(operation: number): void {
    if (operation === this.generation) this.busy = false;
  }

  private hasUnsavedChanges(): boolean {
    if (this.writing === null) return false;
    try {
      return this.writing.hasUnsavedChanges();
    } catch (_error: unknown) {
      // A dirty-state query that cannot be answered must fail closed before a
      // History snapshot rather than silently recording a possibly dirty tree.
      return true;
    }
  }

  private isCurrentHistoryOperation(
    operation: number,
    repositoryGeneration: number,
    repositoryId: string,
  ): boolean {
    return this.historyBusy
      && this.historyGeneration === operation
      && this.generation === repositoryGeneration
      && this.state.repository?.repositoryId === repositoryId;
  }

  private replaceState(update: Partial<RepositoryViewState>): void {
    this.state = copyState({ ...this.state, ...update });
    this.render();
    // History controls also depend on the Repository ready/pending state.
    // Re-render both view slices together so the DOM cannot retain disabled
    // controls after Repository activation completes.
    this.renderHistory();
  }

  private render(): void {
    this.view.setRepositoryState(this.getState());
  }

  private replaceHistoryState(update: Partial<RepositoryHistoryViewState>): void {
    this.historyState = copyHistoryState({ ...this.historyState, ...update });
    this.renderHistory();
  }

  private renderHistory(): void {
    this.view.setRepositoryHistoryState?.(this.getHistoryState());
  }
}
