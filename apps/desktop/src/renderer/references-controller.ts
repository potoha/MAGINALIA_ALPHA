import type { DocumentState } from "@maginalia/writing-core";
import type {
  ResolveReferencesResult
} from "../reference-ipc";
import {
  refreshReferenceList,
  type ReferenceListRefreshResult
} from "./reference-list";

export type ReferencesViewState =
  | { readonly status: "empty"; readonly message: string; readonly unresolvedCount: number }
  | { readonly status: "needs-refresh"; readonly message: string; readonly unresolvedCount: number }
  | { readonly status: "refreshing"; readonly message: string; readonly unresolvedCount: number }
  | { readonly status: "ready"; readonly message: string; readonly unresolvedCount: number }
  | { readonly status: "error"; readonly message: string; readonly unresolvedCount: number };

export interface ReferencesWritingPort {
  getDocumentState(): DocumentState | null;
  onDocumentChange(listener: (document: DocumentState | null) => void): () => void;
  replaceText(nextText: string): boolean;
}

export interface ReferencesControllerApi {
  resolveReferences(request: { readonly text: string }): Promise<ResolveReferencesResult>;
}

export interface ReferencesControllerView {
  setReferencesState(state: ReferencesViewState): void;
}

function conflictMessage(result: Extract<ReferenceListRefreshResult, { readonly kind: "conflict" }>): string {
  switch (result.reason) {
    case "missing-start-marker": return "Reference list start marker is missing.";
    case "missing-end-marker": return "Reference list end marker is missing.";
    case "duplicate-markers": return "Reference list markers are duplicated or nested.";
    case "reversed-markers": return "Reference list markers are reversed.";
  }
}

function errorMessage(result: Extract<ResolveReferencesResult, { readonly kind: "error" }>): string {
  switch (result.code) {
    case "reviewer-unavailable": return "Reviewer unavailable. Reference list was not changed.";
    case "reviewer-invalid-response":
    case "pagination-inconsistent":
    case "reviewer-error":
      return "Reviewer could not resolve references. Reference list was not changed.";
    case "invalid-request":
      return "Reference refresh request was invalid. Reference list was not changed.";
  }
}

/**
 * Coordinates explicit derived-reference refreshes without owning the editor.
 * Text edits still pass through WritingController.replaceText().
 */
export class ReferencesController {
  private readonly api: ReferencesControllerApi;
  private readonly writing: ReferencesWritingPort;
  private readonly view: ReferencesControllerView;
  private readonly removeDocumentListener: () => void;
  private state: ReferencesViewState;
  private refreshing = false;
  private unresolvedCount = 0;

  public constructor(options: {
    readonly api: ReferencesControllerApi;
    readonly writing: ReferencesWritingPort;
    readonly view: ReferencesControllerView;
  }) {
    this.api = options.api;
    this.writing = options.writing;
    this.view = options.view;
    this.state = this.writing.getDocumentState() === null
      ? { status: "empty", message: "Open a document to refresh References.", unresolvedCount: 0 }
      : { status: "needs-refresh", message: "References need refresh.", unresolvedCount: 0 };
    this.removeDocumentListener = this.writing.onDocumentChange((document) => {
      if (document === null) {
        this.unresolvedCount = 0;
        this.setState({ status: "empty", message: "Open a document to refresh References.", unresolvedCount: 0 });
      } else if (!this.refreshing) {
        this.unresolvedCount = 0;
        this.setState({
          status: "needs-refresh",
          message: "References need refresh.",
          unresolvedCount: this.unresolvedCount
        });
      }
    });
    this.view.setReferencesState(this.state);
  }

  public getState(): ReferencesViewState {
    return this.state;
  }

  public async refresh(): Promise<void> {
    if (this.refreshing) return;
    const document = this.writing.getDocumentState();
    if (document === null) {
      this.unresolvedCount = 0;
      this.setState({ status: "empty", message: "Open a document to refresh References.", unresolvedCount: 0 });
      return;
    }

    this.refreshing = true;
    const snapshot = { documentId: document.documentId, text: document.currentText };
    this.setState({
      status: "refreshing",
      message: "Refreshing References…",
      unresolvedCount: this.unresolvedCount
    });

    let result: ResolveReferencesResult;
    try {
      result = await this.api.resolveReferences({ text: snapshot.text });
    } catch (_error: unknown) {
      this.refreshing = false;
      this.setState({
        status: "error",
        message: "Reviewer could not resolve references. Reference list was not changed.",
        unresolvedCount: this.unresolvedCount
      });
      return;
    }

    const current = this.writing.getDocumentState();
    if (current === null || current.documentId !== snapshot.documentId || current.currentText !== snapshot.text) {
      this.refreshing = false;
      if (current === null) {
        this.unresolvedCount = 0;
        this.setState({ status: "empty", message: "Open a document to refresh References.", unresolvedCount: 0 });
      } else {
        this.setState({ status: "needs-refresh", message: "References changed while refreshing.", unresolvedCount: this.unresolvedCount });
      }
      return;
    }

    if (result.kind === "error") {
      this.refreshing = false;
      this.setState({ status: "error", message: errorMessage(result), unresolvedCount: this.unresolvedCount });
      return;
    }

    const refreshed = refreshReferenceList(snapshot.text, result.sources);
    if (refreshed.kind === "conflict") {
      this.refreshing = false;
      this.setState({ status: "error", message: conflictMessage(refreshed), unresolvedCount: result.unresolved.length });
      return;
    }
    if (refreshed.kind === "changed" && !this.writing.replaceText(refreshed.text)) {
      this.refreshing = false;
      this.setState({
        status: "error",
        message: "Reference list could not be applied. The document was not changed.",
        unresolvedCount: this.unresolvedCount
      });
      return;
    }

    this.unresolvedCount = result.unresolved.length;
    this.refreshing = false;
    this.setState({
      status: "ready",
      message: result.unresolved.length === 0
        ? "References refreshed."
        : `${result.unresolved.length} quotation${result.unresolved.length === 1 ? "" : "s"} unresolved.`,
      unresolvedCount: this.unresolvedCount
    });
  }

  public dispose(): void {
    this.removeDocumentListener();
  }

  private setState(state: ReferencesViewState): void {
    this.state = Object.freeze(state);
    this.view.setReferencesState(this.state);
  }
}
