import type {
  DocumentWorkspaceOpened,
  DocumentSummary,
  ManuscriptSummary
} from "../document-workspace";
import type {
  OpenDocumentResult,
  OpenManuscriptRequest,
  OpenManuscriptResult
} from "../document-workspace-ipc";
import type { WritingController } from "./controller";

export interface WorkspaceNavigationApi {
  openDocument(): Promise<OpenDocumentResult>;
  openManuscript(request: OpenManuscriptRequest): Promise<OpenManuscriptResult>;
}

export interface WorkspaceNavigationState {
  readonly document: DocumentSummary | null;
  readonly manuscripts: readonly ManuscriptSummary[];
  readonly activeManuscriptId: string | null;
}

export interface WorkspaceNavigationView {
  setWorkspaceState(state: WorkspaceNavigationState): void;
  setWorkspaceError(message: string | null): void;
}

export type DirtySwitchDecision = "save" | "discard" | "cancel";

/** Path-free result accepted from a repository-to-Document handoff. */
export type RepositoryDocumentActivationResult =
  | DocumentWorkspaceOpened
  | { readonly kind: "cancelled" }
  | { readonly kind: "error"; readonly message: string };

export type DocumentActivationOutcome = "activated" | "cancelled" | "failed";

export type WorkspaceSwitchTarget =
  | { readonly kind: "document" }
  | { readonly kind: "manuscript"; readonly displayName: string };

export interface DirtySwitchContext {
  readonly currentDisplayName: string;
  readonly target: WorkspaceSwitchTarget;
}

export interface WorkspaceNavigationControllerOptions {
  readonly api: WorkspaceNavigationApi;
  readonly writing: WritingController;
  readonly view: WorkspaceNavigationView;
  readonly decideDirtySwitch: (
    context: DirtySwitchContext
  ) => DirtySwitchDecision | Promise<DirtySwitchDecision>;
}

const EMPTY_STATE: WorkspaceNavigationState = {
  document: null,
  manuscripts: [],
  activeManuscriptId: null
};

const OPEN_DOCUMENT_FAILED = "The Document folder could not be opened. Try again.";
const OPEN_MANUSCRIPT_FAILED = "The Markdown manuscript could not be opened. Try again.";
const SWITCH_REQUIRES_CLEAN = "Save or discard the current manuscript before switching.";

export class WorkspaceNavigationController {
  private readonly api: WorkspaceNavigationApi;
  private readonly writing: WritingController;
  private readonly view: WorkspaceNavigationView;
  private readonly decideDirtySwitch: WorkspaceNavigationControllerOptions["decideDirtySwitch"];
  private state: WorkspaceNavigationState = EMPTY_STATE;
  private navigationBusy = false;
  private lastDirtySwitchOutcome: DocumentActivationOutcome = "cancelled";

  public constructor(options: WorkspaceNavigationControllerOptions) {
    this.api = options.api;
    this.writing = options.writing;
    this.view = options.view;
    this.decideDirtySwitch = options.decideDirtySwitch;
    this.view.setWorkspaceState(this.state);
    this.view.setWorkspaceError(null);
  }

  public getState(): WorkspaceNavigationState {
    return {
      ...this.state,
      manuscripts: [...this.state.manuscripts]
    };
  }

  public openDocument(): Promise<void> {
    return this.runNavigation(() => this.openDocumentNow());
  }

  public openManuscript(manuscriptId: string): Promise<void> {
    return this.runNavigation(() => this.openManuscriptNow(manuscriptId));
  }

  /**
   * Apply a path-free Document result supplied by an explicit repository
   * handoff. The existing dirty guard runs before the loader is invoked, so a
   * cancelled switch does not ask main to replace the current Document.
   */
  public openDocumentFromRepository(
    load: () => Promise<RepositoryDocumentActivationResult>
  ): Promise<DocumentActivationOutcome> {
    if (this.navigationBusy) return Promise.resolve("cancelled");
    this.navigationBusy = true;
    return this.openDocumentFromRepositoryNow(load)
      .catch((_error: unknown) => {
        this.showError(OPEN_DOCUMENT_FAILED);
        return "failed" as const;
      })
      .finally(() => {
        this.navigationBusy = false;
      });
  }

  private async openDocumentNow(): Promise<void> {
    if (!(await this.canSwitch({ kind: "document" }))) return;

    let result: OpenDocumentResult;
    try {
      result = await this.api.openDocument();
    } catch (_error: unknown) {
      this.showError(OPEN_DOCUMENT_FAILED);
      return;
    }

    if (result.kind === "cancelled") return;
    if (result.kind !== "opened") {
      this.showError(result.message);
      return;
    }

    await this.applyOpenedDocument(result);
  }

  private async openDocumentFromRepositoryNow(
    load: () => Promise<RepositoryDocumentActivationResult>
  ): Promise<DocumentActivationOutcome> {
    if (!(await this.canSwitch({ kind: "document" }))) return this.lastDirtySwitchOutcome;

    let result: RepositoryDocumentActivationResult;
    try {
      result = await load();
    } catch (_error: unknown) {
      this.showError(OPEN_DOCUMENT_FAILED);
      return "failed";
    }
    if (result.kind === "cancelled") return "cancelled";
    if (result.kind !== "opened") {
      this.showError(result.message);
      return "failed";
    }
    return (await this.applyOpenedDocument(result)) ? "activated" : "failed";
  }

  private async applyOpenedDocument(result: DocumentWorkspaceOpened): Promise<boolean> {
    // The previous document must lose its editor/save capability as soon as
    // the new Document has been accepted, even if its first manuscript fails.
    this.writing.clearDocuments();
    this.replaceWorkspace({
      document: result.document,
      manuscripts: result.manuscripts,
      activeManuscriptId: null
    });
    this.showError(null);

    const first = result.manuscripts[0];
    if (!first) return true;
    return this.openSelectedManuscript(result.document.documentId, first);
  }

  private async openManuscriptNow(manuscriptId: string): Promise<void> {
    const document = this.state.document;
    if (!document) {
      this.showError("Open a Document before choosing a manuscript.");
      return;
    }

    const manuscript = this.state.manuscripts.find((candidate) => candidate.manuscriptId === manuscriptId);
    if (!manuscript) {
      this.showError("That manuscript is not available in the current Document.");
      return;
    }
    if (this.state.activeManuscriptId === manuscriptId) return;
    if (!(await this.canSwitch({ kind: "manuscript", displayName: manuscript.displayName }))) return;

    await this.openSelectedManuscript(document.documentId, manuscript);
  }

  private async openSelectedManuscript(
    documentId: string,
    manuscript: ManuscriptSummary
  ): Promise<boolean> {
    let result: OpenManuscriptResult;
    try {
      result = await this.api.openManuscript({
        documentId,
        manuscriptId: manuscript.manuscriptId
      });
    } catch (_error: unknown) {
      this.showError(OPEN_MANUSCRIPT_FAILED);
      return false;
    }

    if (result.kind === "opened") {
      this.writing.applyOpenedDocument(result);
      this.replaceWorkspace({
        ...this.state,
        activeManuscriptId: manuscript.manuscriptId
      });
      this.showError(null);
      return true;
    }

    this.showError(result.kind === "error" ? result.message : OPEN_MANUSCRIPT_FAILED);
    return false;
  }

  private async canSwitch(target: WorkspaceSwitchTarget): Promise<boolean> {
    if (!this.writing.hasUnsavedChanges()) return true;
    const current = this.writing.getDocumentState();
    if (!current) return true;
    this.lastDirtySwitchOutcome = "cancelled";

    let decision: DirtySwitchDecision;
    try {
      decision = await this.decideDirtySwitch({
        currentDisplayName: current.displayName,
        target
      });
    } catch (_error: unknown) {
      this.lastDirtySwitchOutcome = "failed";
      this.showError(SWITCH_REQUIRES_CLEAN);
      return false;
    }

    if (decision === "discard") return true;
    if (decision !== "save") return false;

    try {
      await this.writing.save();
    } catch (_error: unknown) {
      this.lastDirtySwitchOutcome = "failed";
      this.showError(SWITCH_REQUIRES_CLEAN);
      return false;
    }

    if (this.writing.hasUnsavedChanges()) {
      this.lastDirtySwitchOutcome = "failed";
      this.showError(SWITCH_REQUIRES_CLEAN);
      return false;
    }
    return true;
  }

  private runNavigation(operation: () => Promise<void>): Promise<void> {
    if (this.navigationBusy) return Promise.resolve();
    this.navigationBusy = true;
    return operation()
      .catch((_error: unknown) => {
        this.showError(OPEN_DOCUMENT_FAILED);
      })
      .finally(() => {
        this.navigationBusy = false;
      });
  }

  private replaceWorkspace(state: WorkspaceNavigationState): void {
    this.state = {
      document: state.document,
      manuscripts: [...state.manuscripts],
      activeManuscriptId: state.activeManuscriptId
    };
    this.view.setWorkspaceState(this.state);
  }

  private showError(message: string | null): void {
    this.view.setWorkspaceError(message);
  }
}
