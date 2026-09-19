import type {
  ReviewerQuotation,
  SearchShelfRequest,
  SearchShelfResult
} from "../reviewer-ipc";
import type {
  CapturedInsertionTarget,
  WritingInsertionResult
} from "./controller";
import type { QuoteRef } from "@maginalia/writing-core";

export interface ShelfControllerApi {
  searchShelf(request: SearchShelfRequest): Promise<SearchShelfResult>;
}
export interface ShelfWritingPort {
  captureInsertionTarget(): CapturedInsertionTarget | null;
  isInsertionTargetCurrent?(target: CapturedInsertionTarget | null): boolean;
  insertQuoteRef(target: CapturedInsertionTarget, input: QuoteRef): WritingInsertionResult;
}

export type ShelfStatus = "idle" | "searching" | "ready" | "error";

export interface ShelfViewState {
  readonly query: string;
  readonly status: ShelfStatus;
  readonly results: readonly ReviewerQuotation[];
  readonly selectedAnnotationId: string | null;
  readonly error: string | null;
}

export interface ShelfControllerView {
  setShelfState(state: ShelfViewState): void;
}

export interface ShelfControllerOptions {
  readonly api: ShelfControllerApi;
  readonly writing: ShelfWritingPort;
  readonly view: ShelfControllerView;
}

const EMPTY_STATE: ShelfViewState = Object.freeze({
  query: "",
  status: "idle",
  results: Object.freeze([]),
  selectedAnnotationId: null,
  error: null
});

const SEARCH_FAILED = "Reviewer search could not be completed. Try again.";
const NO_MANUSCRIPT = "Open a manuscript before inserting a quotation.";
const NO_RESULT = "Select a quotation before inserting it.";
const STALE_INSERT = "The writing target changed before insertion. Select Insert again.";

function copyQuotation(quotation: ReviewerQuotation): ReviewerQuotation {
  return Object.freeze({
    annotationId: quotation.annotationId,
    captureId: quotation.captureId,
    pageId: quotation.pageId,
    sourcePageId: quotation.sourcePageId,
    isbn13: quotation.isbn13,
    title: quotation.title,
    authors: Object.freeze([...quotation.authors]),
    quote: quotation.quote,
    pageLabel: quotation.pageLabel,
    comment: quotation.comment,
    reviewState: quotation.reviewState,
    reviewedAtMs: quotation.reviewedAtMs
  });
}

function copyResults(results: readonly ReviewerQuotation[]): readonly ReviewerQuotation[] {
  return Object.freeze(results.map(copyQuotation));
}

function copyState(state: ShelfViewState): ShelfViewState {
  return Object.freeze({
    query: state.query,
    status: state.status,
    results: copyResults(state.results),
    selectedAnnotationId: state.selectedAnnotationId,
    error: state.error
  });
}

export class ShelfController {
  private readonly api: ShelfControllerApi;
  private readonly writing: ShelfWritingPort;
  private readonly view: ShelfControllerView;
  private state: ShelfViewState = EMPTY_STATE;
  private generation = 0;

  public constructor(options: ShelfControllerOptions) {
    this.api = options.api;
    this.writing = options.writing;
    this.view = options.view;
    this.render();
  }

  public getState(): ShelfViewState {
    return copyState(this.state);
  }

  public setQuery(query: string): void {
    if (query === this.state.query) return;
    this.generation += 1;
    this.replaceState({
      query,
      results: [],
      selectedAnnotationId: null,
      status: "idle",
      error: null
    });
  }

  public selectResult(annotationId: string): void {
    const result = this.state.results.find((candidate) => candidate.annotationId === annotationId);
    if (!result || this.state.selectedAnnotationId === annotationId) return;
    this.generation += 1;
    this.replaceState({ selectedAnnotationId: annotationId, error: null, status: "ready" });
  }

  public search(query?: string): Promise<void> {
    if (query !== undefined && query !== this.state.query) this.setQuery(query);
    const operation = ++this.generation;
    const request: SearchShelfRequest = { query: this.state.query };
    this.replaceState({ results: [], selectedAnnotationId: null, status: "searching", error: null });
    return this.searchOperation(operation, request);
  }

  public async insertResult(annotationId?: string): Promise<void> {
    const selectedId = annotationId ?? this.state.selectedAnnotationId;
    const result = selectedId === undefined || selectedId === null
      ? undefined
      : this.state.results.find((candidate) => candidate.annotationId === selectedId);
    if (result === undefined) {
      this.generation += 1;
      this.replaceState({ status: "error", error: NO_RESULT });
      return;
    }
    if (this.state.selectedAnnotationId !== result.annotationId) {
      this.generation += 1;
      this.replaceState({ selectedAnnotationId: result.annotationId, error: null, status: "ready" });
    }

    // Capture the target before the asynchronous boundary. The reviewer
    // record is transient UI metadata; only its opaque annotationId crosses
    // the Writing boundary.
    const target = this.writing.captureInsertionTarget();
    if (target === null) {
      this.generation += 1;
      this.replaceState({ status: "error", error: NO_MANUSCRIPT });
      return;
    }
    const operation = ++this.generation;
    if (!this.isInsertionTargetCurrent(target)) {
      this.replaceState({ status: "error", error: STALE_INSERT });
      return;
    }

    let insertion: WritingInsertionResult;
    try {
      insertion = this.writing.insertQuoteRef(target, {
        quoteId: result.annotationId,
        mode: "normal"
      });
    } catch (_error: unknown) {
      if (operation === this.generation) this.replaceState({ status: "error", error: STALE_INSERT });
      return;
    }
    if (operation !== this.generation) return;
    if (insertion.kind === "inserted") {
      this.replaceState({ status: "ready", error: null });
    } else if (insertion.code === "stale-target") {
      this.replaceState({ status: "error", error: STALE_INSERT });
    } else {
      this.replaceState({ status: "error", error: insertion.message });
    }
  }

  private async searchOperation(operation: number, request: SearchShelfRequest): Promise<void> {
    let result: SearchShelfResult;
    try {
      result = await this.api.searchShelf(request);
    } catch (_error: unknown) {
      if (operation === this.generation) this.replaceState({ status: "error", error: SEARCH_FAILED });
      return;
    }
    if (operation !== this.generation) return;
    if (result.kind !== "results") {
      this.replaceState({ status: "error", error: result.message });
      return;
    }
    this.replaceState({
      results: copyResults(result.results),
      selectedAnnotationId: null,
      status: "ready",
      error: null
    });
  }

  private replaceState(update: Partial<ShelfViewState>): void {
    this.state = copyState({ ...this.state, ...update });
    this.render();
  }

  private render(): void {
    this.view.setShelfState(this.getState());
  }

  private isInsertionTargetCurrent(target: CapturedInsertionTarget): boolean {
    if (this.writing.isInsertionTargetCurrent) {
      return this.writing.isInsertionTargetCurrent(target);
    }
    const current = this.writing.captureInsertionTarget();
    return current !== null
      && current.documentId === target.documentId
      && current.revision === target.revision;
  }
}
