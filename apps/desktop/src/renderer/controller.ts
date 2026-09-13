import {
  confirmSave,
  createSaveSnapshot,
  editDocument,
  isDirty,
  openDocument,
  type DocumentState
} from "@maginalia/writing-core";
import type {
  OpenMarkdownResult,
  SaveMarkdownResult
} from "../markdown-ipc";
import type { MarkdownPreloadApi } from "../preload-api";

export interface WritingSurface {
  replaceDocument(text: string): void;
  getText(): string;
  onTextChange(listener: (text: string) => void): () => void;
  focus(): void;
}

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
  private replacingSurface = false;
  private errorMessage: string | undefined;

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

    // Any outstanding save belongs to the replaced document. Its completion
    // is ignored by the operation id and cannot affect this new state.
    this.currentSave = null;
    this.errorMessage = undefined;
    this.document = openDocument({
      documentId: result.sessionId,
      displayName: result.displayName,
      text: result.text
    });
    this.replacingSurface = true;
    try {
      this.surface.replaceDocument(result.text);
    } finally {
      this.replacingSurface = false;
    }
    this.render();
    this.surface.focus();
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
    this.errorMessage = undefined;
    this.render();
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
