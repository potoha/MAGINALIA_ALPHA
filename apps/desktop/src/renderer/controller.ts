import {
  confirmSave,
  createSaveSnapshot,
  editDocument,
  insertQuoteRef as createQuoteRefInsertion,
  insertQuotation as createQuotationInsertion,
  isDirty,
  openDocument,
  type DocumentId,
  type DocumentState,
  type QuoteRef,
  type QuoteRefInsertionResult,
  type QuotationInsertionInput,
  type QuotationInsertionResult
} from "@maginalia/writing-core";
import type {
  OpenMarkdownSuccess,
  OpenMarkdownResult,
  SaveMarkdownResult
} from "../markdown-ipc";
import type { MarkdownPreloadApi } from "../preload-api";

export interface WritingSurface {
  replaceDocument(text: string): void;
  getText(): string;
  getSelection(): WritingTextRange;
  applyEdit(range: WritingTextRange, text: string, selection: WritingTextRange): void;
  onTextChange(listener: (text: string) => void): () => void;
  focus(): void;
}

/** UTF-16 offsets shared by Writing Core and the Monaco adapter. */
export interface WritingTextRange {
  readonly start: number;
  readonly end: number;
}

export interface CapturedInsertionTarget {
  readonly documentId: DocumentId;
  /** Local revision invalidates a target after any edit, open, or clear. */
  readonly revision: number;
  readonly range: WritingTextRange;
}

export interface WritingInsertionStaleFailure {
  readonly kind: "error";
  readonly code: "stale-target";
  readonly message: string;
}

export interface WritingInsertionSurfaceFailure {
  readonly kind: "error";
  readonly code: "surface-failed";
  readonly message: string;
}

export type WritingInsertionResult =
  | QuotationInsertionResult
  | QuoteRefInsertionResult
  | WritingInsertionStaleFailure
  | WritingInsertionSurfaceFailure;

export type WritingStatus =
  | { kind: "empty"; message: string }
  | { kind: "saved"; message: string }
  | { kind: "modified"; message: string }
  | { kind: "saving"; message: string }
  | { kind: "error"; message: string };

export interface WritingView {
  setDocumentName(name: string): void;
  setStatus(status: WritingStatus): void;
  setSaveEnabled(enabled: boolean): void;
}

export type WritingDocumentChangeListener = (document: DocumentState | null) => void;

export interface WritingControllerOptions {
  readonly api: MarkdownPreloadApi;
  readonly surface: WritingSurface;
  readonly view: WritingView;
  readonly confirmReplace: (displayName: string) => boolean | Promise<boolean>;
}

interface SaveOperation {
  readonly id: number;
  readonly snapshot: ReturnType<typeof createSaveSnapshot>;
  queued: boolean;
  completion?: Promise<void>;
}

const NO_DOCUMENT_NAME = "No document open";

export class WritingController {
  private readonly api: MarkdownPreloadApi;
  private readonly surface: WritingSurface;
  private readonly view: WritingView;
  private readonly confirmReplace: WritingControllerOptions["confirmReplace"];
  private readonly removeTextListener: () => void;
  private document: DocumentState | null = null;
  private currentSave: SaveOperation | null = null;
  private nextSaveId = 1;
  private revision = 0;
  private replacingSurface = false;
  private errorMessage: string | undefined;
  private readonly documentChangeListeners = new Set<WritingDocumentChangeListener>();

  public constructor(options: WritingControllerOptions) {
    this.api = options.api;
    this.surface = options.surface;
    this.view = options.view;
    this.confirmReplace = options.confirmReplace;
    this.removeTextListener = this.surface.onTextChange((text) => this.handleTextChange(text));
    this.render();
  }

  public getDocumentState(): DocumentState | null {
    return this.document;
  }

  public hasUnsavedChanges(): boolean {
    return this.document !== null && isDirty(this.document);
  }

  /** Subscribe to document changes without exposing the editor surface. */
  public onDocumentChange(listener: WritingDocumentChangeListener): () => void {
    this.documentChangeListeners.add(listener);
    return () => this.documentChangeListeners.delete(listener);
  }

  public captureInsertionTarget(): CapturedInsertionTarget | null {
    const current = this.document;
    if (current === null) return null;
    const range = this.surface.getSelection();
    return {
      documentId: current.documentId,
      revision: this.revision,
      range: { start: range.start, end: range.end }
    };
  }

  public isInsertionTargetCurrent(target: CapturedInsertionTarget | null): boolean {
    const current = this.document;
    return current !== null
      && target !== null
      && typeof target === "object"
      && current.documentId === target.documentId
      && this.revision === target.revision;
  }

  public insertQuotation(
    target: CapturedInsertionTarget,
    input: QuotationInsertionInput
  ): WritingInsertionResult {
    return this.applyInsertion(
      target,
      (current, targetRange) => createQuotationInsertion(current, targetRange, input),
      "The quotation could not be inserted into the editor."
    );
  }

  /**
   * Insert a stable QuoteRef through the same captured-target and Writing
   * Surface boundary as legacy literal quotations.  The Shelf never receives
   * or manipulates the Monaco surface directly.
   */
  public insertQuoteRef(
    target: CapturedInsertionTarget,
    input: QuoteRef
  ): WritingInsertionResult {
    return this.applyInsertion(
      target,
      (current, targetRange) => createQuoteRefInsertion(current, targetRange, input),
      "The QuoteRef could not be inserted into the editor."
    );
  }

  private applyInsertion(
    target: CapturedInsertionTarget,
    createInsertion: (
      current: DocumentState,
      target: { readonly documentId: DocumentId; readonly start: number; readonly end: number }
    ) => QuotationInsertionResult | QuoteRefInsertionResult,
    surfaceFailureMessage: string
  ): WritingInsertionResult {
    const current = this.document;
    if (current === null
      || target === null
      || typeof target !== "object"
      || current.documentId !== target.documentId
      || this.revision !== target.revision) {
      return {
        kind: "error",
        code: "stale-target",
        message: "The quotation target is no longer current."
      };
    }

    const targetRange = target.range;
    if (targetRange === null || typeof targetRange !== "object") {
      return {
        kind: "error",
        code: "invalid-range",
        message: "The quotation selection is outside the current document."
      };
    }

    const result = createInsertion(current, {
      documentId: target.documentId,
      start: targetRange.start,
      end: targetRange.end
    });
    if (result.kind !== "inserted") return result;

    const revisionBeforeEdit = this.revision;
    try {
      this.surface.applyEdit(
        targetRange,
        result.insertedText,
        { start: result.selectionStart, end: result.selectionEnd }
      );
    } catch (_error: unknown) {
      return {
        kind: "error",
        code: "surface-failed",
        message: surfaceFailureMessage
      };
    }

    // Monaco emits the normal text-change event synchronously. A small test
    // surface may not, so keep the Core state correct in either case.
    if (this.document !== null
      && this.document.documentId === target.documentId
      && this.document.currentText !== result.state.currentText) {
      this.document = result.state;
    }
    const surfaceEmittedChange = this.revision !== revisionBeforeEdit;
    if (!surfaceEmittedChange) this.revision += 1;
    this.errorMessage = undefined;
    this.render();
    if (!surfaceEmittedChange) this.notifyDocumentChange();
    return result;
  }

  /**
   * Apply one complete-document edit through the WritingSurface boundary.
   * Consumers such as derived-reference refresh must not touch Monaco.
   */
  public replaceText(nextText: string): boolean {
    const current = this.document;
    if (current === null || typeof nextText !== "string" || nextText === current.currentText) {
      return false;
    }

    const currentSelection = this.surface.getSelection();
    const clamp = (offset: number): number => Math.max(0, Math.min(nextText.length, offset));
    const revisionBeforeEdit = this.revision;
    // Monaco stores a UTF-8 BOM as model metadata. `getText()` exposes that
    // character to Writing Core, but inserting it through executeEdits would
    // create a second BOM. Keep the authoring text unchanged while passing
    // only the model payload through the surface boundary.
    const surfaceText = current.currentText.startsWith("\uFEFF") && nextText.startsWith("\uFEFF")
      ? nextText.slice(1)
      : nextText;
    try {
      this.surface.applyEdit(
        { start: 0, end: current.currentText.length },
        surfaceText,
        { start: clamp(currentSelection.start), end: clamp(currentSelection.end) }
      );
    } catch (_error: unknown) {
      return false;
    }

    // Monaco emits the normal text-change event synchronously. A small test
    // surface may not, so keep the Core state correct in either case.
    if (this.document !== null
      && this.document.documentId === current.documentId
      && this.document.currentText !== nextText) {
      this.document = editDocument(this.document, nextText);
    }
    const surfaceEmittedChange = this.revision !== revisionBeforeEdit;
    if (!surfaceEmittedChange) this.revision += 1;
    this.errorMessage = undefined;
    this.render();
    if (!surfaceEmittedChange) this.notifyDocumentChange();
    return true;
  }

  public async open(): Promise<void> {
    const current = this.document;
    if (current && isDirty(current) && !(await this.confirmReplace(current.displayName))) {
      this.render();
      return;
    }

    let result: OpenMarkdownResult;
    try {
      result = await this.api.openMarkdown();
    } catch (_error: unknown) {
      this.showError("The Markdown file could not be opened. Try again.");
      return;
    }

    if (result.kind === "cancelled") {
      this.render();
      return;
    }
    if (result.kind !== "opened") {
      this.showError(result.message);
      return;
    }

    this.applyOpenedDocument(result);
  }

  public applyOpenedDocument(result: OpenMarkdownSuccess): void {
    // Any outstanding save belongs to the replaced document. Its completion
    // is ignored by the operation id and cannot affect this new state.
    this.currentSave = null;
    this.errorMessage = undefined;
    this.document = openDocument({
      documentId: result.sessionId,
      displayName: result.displayName,
      text: result.text
    });
    this.revision += 1;
    this.replacingSurface = true;
    try {
      this.surface.replaceDocument(result.text);
    } finally {
      this.replacingSurface = false;
    }
    this.render();
    this.notifyDocumentChange();
    this.surface.focus();
  }

  public clearDocument(): void {
    // A cleared surface cannot be affected by a save belonging to the
    // document that was just removed.
    this.currentSave = null;
    this.errorMessage = undefined;
    this.document = null;
    this.revision += 1;
    this.replacingSurface = true;
    try {
      this.surface.replaceDocument("");
    } finally {
      this.replacingSurface = false;
    }
    this.render();
    this.notifyDocumentChange();
  }

  public save(): Promise<void> {
    const current = this.document;
    if (!current || !isDirty(current)) return Promise.resolve();

    const active = this.currentSave;
    if (active && active.snapshot.documentId === current.documentId) {
      active.queued = true;
      this.render();
      return active.completion ?? Promise.resolve();
    }
    if (active) return Promise.resolve();

    const operation: SaveOperation = {
      id: this.nextSaveId++,
      snapshot: createSaveSnapshot(current),
      queued: false
    };
    this.currentSave = operation;
    const completion = this.executeSave(operation).then(() => {
      if (this.currentSave?.id !== operation.id) return;

      const followUp = operation.queued
        && this.document !== null
        && this.document.documentId === operation.snapshot.documentId
        && isDirty(this.document);
      this.currentSave = null;
      if (followUp) {
        return this.save();
      }
      this.render();
    });
    operation.completion = completion;
    this.render();
    return completion;
  }

  public dispose(): void {
    this.removeTextListener();
  }

  private handleTextChange(text: string): void {
    if (this.replacingSurface || this.document === null) return;
    this.document = editDocument(this.document, text);
    this.revision += 1;
    this.errorMessage = undefined;
    this.render();
    this.notifyDocumentChange();
  }

  private notifyDocumentChange(): void {
    for (const listener of this.documentChangeListeners) {
      try {
        listener(this.document);
      } catch {
        // A view listener must not interrupt editor state transitions.
      }
    }
  }

  private async executeSave(operation: SaveOperation): Promise<void> {
    let result: SaveMarkdownResult;
    try {
      result = await this.api.saveMarkdown({
        sessionId: operation.snapshot.documentId,
        text: operation.snapshot.text
      });
    } catch (_error: unknown) {
      if (this.currentSave?.id === operation.id) {
        this.showError("The Markdown file could not be saved. Try again.");
      }
      return;
    }

    if (this.currentSave?.id !== operation.id) return;

    if (result.kind === "saved"
      && result.sessionId === operation.snapshot.documentId
      && result.text === operation.snapshot.text) {
      if (this.document !== null) {
        this.document = confirmSave(this.document, operation.snapshot);
      }
      this.errorMessage = undefined;
      return;
    }

    if (result.kind === "conflict" || result.kind === "error") {
      this.showError(result.message);
      return;
    }

    this.showError("The save confirmation did not match this draft. Try saving again.");
  }

  private showError(message: string): void {
    this.errorMessage = message;
    this.render();
  }

  private render(): void {
    const current = this.document;
    this.view.setDocumentName(current?.displayName ?? NO_DOCUMENT_NAME);

    if (current === null) {
      this.view.setStatus({ kind: "empty", message: "No document open" });
      this.view.setSaveEnabled(false);
      return;
    }

    const savingCurrent = this.currentSave?.snapshot.documentId === current.documentId;
    if (savingCurrent) {
      this.view.setStatus({ kind: "saving", message: "Saving…" });
    } else if (this.errorMessage !== undefined) {
      this.view.setStatus({ kind: "error", message: this.errorMessage });
    } else if (isDirty(current)) {
      this.view.setStatus({ kind: "modified", message: "Modified" });
    } else {
      this.view.setStatus({ kind: "saved", message: "Saved" });
    }

    this.view.setSaveEnabled(!savingCurrent && isDirty(current));
  }
}
