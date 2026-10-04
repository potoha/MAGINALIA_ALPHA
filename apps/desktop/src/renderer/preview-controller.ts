import type { DocumentState } from "@maginalia/writing-core";
import type { ResolveReferencesResult } from "../reference-ipc";
import {
  createPreviewQuoteMap,
  scanQuoteMarkersFromText,
  type PreviewQuoteMap
} from "./markdown-renderer";
import {
  type RendererPreferenceStore,
  type WritingDirection
} from "./renderer-preferences";

export type PreviewMode = "edit" | "preview";

export interface PreviewWritingPort {
  getDocumentState(): (DocumentState & { readonly revision?: number }) | null;
  onDocumentChange(listener: (document: DocumentState | null) => void): () => void;
}

export interface PreviewResolutionApi {
  resolveReferences(request: { readonly text: string }): Promise<ResolveReferencesResult>;
}

export interface PreviewView {
  setPreviewState(state: {
    readonly mode: PreviewMode;
    readonly direction: WritingDirection;
    readonly document: (DocumentState & { readonly revision?: number }) | null;
    readonly quoteMap: PreviewQuoteMap;
  }): void;
}

/**
 * Keeps preview presentation and quotation lookup out of WritingController.
 * It reads the DocumentSession and coordinates only disposable presentation.
 * Preview authoring still enters through WritingController, never this class.
 */
export class PreviewController {
  private mode: PreviewMode = "edit";
  private direction: WritingDirection;
  private generation = 0;
  private inlineEditingDocumentId: string | null = null;
  private readonly removeDocumentListener: () => void;

  public constructor(private readonly options: {
    readonly writing: PreviewWritingPort;
    readonly api: PreviewResolutionApi | null;
    readonly view: PreviewView;
    readonly preferences: RendererPreferenceStore;
  }) {
    this.direction = options.preferences.load().defaultWritingDirection;
    this.removeDocumentListener = options.writing.onDocumentChange(() => this.refresh());
    this.refresh();
  }

  public getMode(): PreviewMode { return this.mode; }
  public getDirection(): WritingDirection { return this.direction; }
  public isInlineEditing(): boolean { return this.inlineEditingDocumentId !== null; }

  /** Keep a focused editable island stable until blur/composition completes. */
  public setInlineEditing(documentId: string | null): void {
    if (this.inlineEditingDocumentId === documentId) return;
    this.inlineEditingDocumentId = documentId;
    if (documentId === null) this.refresh();
  }

  public setMode(mode: PreviewMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.inlineEditingDocumentId = null;
    this.refresh();
  }

  public setDirection(direction: WritingDirection): void {
    if (this.direction === direction) return;
    this.direction = direction;
    const current = this.options.preferences.load();
    this.options.preferences.save({ ...current, defaultWritingDirection: direction });
    this.refresh();
  }

  public dispose(): void { this.removeDocumentListener(); }

  /** Recompose disposable Preview state after an inactive source session changes. */
  public refresh(): void {
    const document = this.options.writing.getDocumentState();
    if (this.mode === "preview" && document !== null && document.documentId === this.inlineEditingDocumentId) return;
    if (document === null || document.documentId !== this.inlineEditingDocumentId) this.inlineEditingDocumentId = null;
    const generation = ++this.generation;
    this.options.view.setPreviewState({ mode: this.mode, direction: this.direction, document, quoteMap: new Map() });
    if (this.mode !== "preview" || document === null) return;
    const markers = scanQuoteMarkersFromText(document.currentText);
    if (markers.length === 0) return;
    const api = this.options.api;
    if (api === null) {
      this.showIfCurrent(generation, document, createPreviewQuoteMap([], [], "Reviewer unavailable."), markers);
      return;
    }
    void api.resolveReferences({ text: document.currentText }).then((result) => {
      if (result.kind === "error") {
        this.showIfCurrent(generation, document, createPreviewQuoteMap([], [], "Reviewer unavailable."), markers);
      } else {
        this.showIfCurrent(generation, document, createPreviewQuoteMap(result.resolved, result.unresolved), markers);
      }
    }, () => this.showIfCurrent(generation, document, createPreviewQuoteMap([], [], "Reviewer unavailable."), markers));
  }

  private showIfCurrent(
    generation: number,
    snapshot: DocumentState,
    partial: PreviewQuoteMap,
    markers: readonly string[]
  ): void {
    const current = this.options.writing.getDocumentState();
    if (generation !== this.generation || current === null
      || current.documentId !== snapshot.documentId || current.currentText !== snapshot.currentText) return;
    const quoteMap = new Map(partial);
    for (const marker of markers) {
      if (!quoteMap.has(marker)) quoteMap.set(marker, { state: "unresolved", reason: "Quotation unresolved." });
    }
    this.options.view.setPreviewState({ mode: this.mode, direction: this.direction, document: current, quoteMap });
  }
}
