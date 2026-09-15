import type {
  OpenLibraryResult,
  QuotationReference,
  ResolveQuotationForInsertRequest,
  ResolveQuotationForInsertResult,
  SearchLibraryRequest,
  SearchLibraryResult
} from "../library-ipc";
import type { LibraryOpenResult, LibrarySummary } from "../library-service";
import type {
  CapturedInsertionTarget,
  WritingInsertionResult
} from "./controller";
import type { QuotationInsertionInput } from "@maginalia/writing-core";

export interface LibraryControllerApi {
  openLibrary(): Promise<OpenLibraryResult>;
  searchLibrary(request: SearchLibraryRequest): Promise<SearchLibraryResult>;
  resolveQuotationForInsert(request: ResolveQuotationForInsertRequest): Promise<ResolveQuotationForInsertResult>;
}

export interface LibraryWritingPort {
  captureInsertionTarget(): CapturedInsertionTarget | null;
  isInsertionTargetCurrent?(target: CapturedInsertionTarget | null): boolean;
  insertQuotation(target: CapturedInsertionTarget, input: QuotationInsertionInput): WritingInsertionResult;
}

export type LibraryStatus = "idle" | "opening" | "searching" | "resolving" | "ready" | "error";

export interface LibraryViewState {
  readonly library: LibrarySummary | null;
  readonly query: string;
  readonly status: LibraryStatus;
  readonly references: readonly QuotationReference[];
  readonly selectedAnnotationId: string | null;
  readonly error: string | null;
}

export interface LibraryControllerView {
  setLibraryState(state: LibraryViewState): void;
}

export interface LibraryControllerOptions {
  readonly api: LibraryControllerApi;
  readonly writing: LibraryWritingPort;
  readonly view: LibraryControllerView;
}

const EMPTY_STATE: LibraryViewState = Object.freeze({
  library: null,
  query: "",
  status: "idle",
  references: Object.freeze([]),
  selectedAnnotationId: null,
  error: null
});

const OPEN_FAILED = "The Library could not be opened. Choose it again.";
const SEARCH_FAILED = "The Library search could not be completed. Try again.";
const RESOLVE_FAILED = "The quotation could not be resolved. Try again.";
const NO_LIBRARY = "Choose a Library before searching.";
const NO_MANUSCRIPT = "Open a manuscript before inserting a quotation.";
const NO_REFERENCE = "Select a quotation before inserting it.";
const STALE_INSERT = "The writing target changed before insertion. Select Insert again.";

function copyLibrary(library: LibrarySummary): LibrarySummary {
  return Object.freeze({
    libraryId: library.libraryId,
    displayName: library.displayName
  });
}

/** Copy exactly the renderer-safe reference allowlist; extra runtime fields are discarded. */
function copyReference(reference: QuotationReference): QuotationReference {
  const output: {
    annotationId: string;
    sourceId: string;
    title: string;
    authors: readonly string[];
    page?: number;
  } = {
    annotationId: reference.annotationId,
    sourceId: reference.sourceId,
    title: reference.title,
    authors: Object.freeze([...reference.authors])
  };
  if (reference.page !== undefined) output.page = reference.page;
  return Object.freeze(output);
}

function copyReferences(references: readonly QuotationReference[]): readonly QuotationReference[] {
  return Object.freeze(references.map(copyReference));
}

function copyState(state: LibraryViewState): LibraryViewState {
  return Object.freeze({
    library: state.library === null ? null : copyLibrary(state.library),
    query: state.query,
    status: state.status,
    references: copyReferences(state.references),
    selectedAnnotationId: state.selectedAnnotationId,
    error: state.error
  });
}

function isResolvedForReference(
  result: ResolveQuotationForInsertResult,
  libraryId: string,
  annotationId: string
): result is Extract<ResolveQuotationForInsertResult, { kind: "resolved" }> {
  return result.kind === "resolved"
    && result.libraryId === libraryId
    && result.annotationId === annotationId;
}

function restoreAfterLibraryDialog(state: LibraryViewState, error: string | null): Partial<LibraryViewState> {
  const status = state.status === "opening" || state.status === "searching" || state.status === "resolving"
    ? state.library === null ? "idle" : "ready"
    : state.status;
  return { ...state, status, error };
}

export class LibraryController {
  private readonly api: LibraryControllerApi;
  private readonly writing: LibraryWritingPort;
  private readonly view: LibraryControllerView;
  private state: LibraryViewState = EMPTY_STATE;
  private generation = 0;

  public constructor(options: LibraryControllerOptions) {
    this.api = options.api;
    this.writing = options.writing;
    this.view = options.view;
    this.render();
  }

  public getState(): LibraryViewState {
    return copyState(this.state);
  }

  public setQuery(query: string): void {
    if (query === this.state.query) return;
    this.generation += 1;
    this.replaceState({
      query,
      references: [],
      selectedAnnotationId: null,
      status: "idle",
      error: null
    });
  }

  public selectReference(annotationId: string): void {
    const reference = this.state.references.find((candidate) => candidate.annotationId === annotationId);
    if (!reference || this.state.selectedAnnotationId === annotationId) return;
    this.generation += 1;
    this.replaceState({ selectedAnnotationId: annotationId, error: null, status: "ready" });
  }

  /** Apply a successful explicit repository Shelf handoff without opening a dialog. */
  public activateLibrary(result: LibraryOpenResult | { readonly kind: "error"; readonly message: string }): boolean {
    this.generation += 1;
    if (result.kind !== "opened") {
      this.replaceState({ status: "error", error: result.message });
      return false;
    }

    this.replaceState({
      library: copyLibrary(result.library),
      query: "",
      references: [],
      selectedAnnotationId: null,
      status: "idle",
      error: null
    });
    return true;
  }

  public openLibrary(): Promise<void> {
    const operation = ++this.generation;
    const previous = this.state;
    this.replaceState({
      references: [],
      selectedAnnotationId: null,
      status: "opening",
      error: null
    });
    return this.openLibraryOperation(operation, previous);
  }

  public search(query?: string): Promise<void> {
    if (query !== undefined && query !== this.state.query) this.setQuery(query);
    const library = this.state.library;
    if (library === null) {
      this.generation += 1;
      this.replaceState({ status: "error", error: NO_LIBRARY });
      return Promise.resolve();
    }

    const operation = ++this.generation;
    const request = {
      libraryId: library.libraryId,
      query: this.state.query
    } satisfies SearchLibraryRequest;
    this.replaceState({
      references: [],
      selectedAnnotationId: null,
      status: "searching",
      error: null
    });
    return this.searchOperation(operation, request);
  }

  public async insertReference(annotationId?: string): Promise<void> {
    const selectedId = annotationId ?? this.state.selectedAnnotationId;
    const library = this.state.library;
    if (library === null) {
      this.generation += 1;
      this.replaceState({ status: "error", error: NO_LIBRARY });
      return;
    }
    const reference = selectedId === undefined || selectedId === null
      ? undefined
      : this.state.references.find((candidate) => candidate.annotationId === selectedId);

    if (reference === undefined) {
      this.generation += 1;
      this.replaceState({ status: "error", error: NO_REFERENCE });
      return;
    }
    if (this.state.selectedAnnotationId !== reference.annotationId) {
      this.generation += 1;
      this.replaceState({ selectedAnnotationId: reference.annotationId, error: null, status: "ready" });
    }

    // Capture before resolve and fail locally when there is no active manuscript.
    const target = this.writing.captureInsertionTarget();
    if (target === null) {
      this.generation += 1;
      this.replaceState({ status: "error", error: NO_MANUSCRIPT });
      return;
    }

    const operation = ++this.generation;
    const request: ResolveQuotationForInsertRequest = {
      libraryId: library.libraryId,
      annotationId: reference.annotationId
    };
    this.replaceState({ status: "resolving", error: null });

    let result: ResolveQuotationForInsertResult;
    try {
      result = await this.api.resolveQuotationForInsert(request);
    } catch (_error: unknown) {
      if (operation === this.generation) this.replaceState({ status: "error", error: RESOLVE_FAILED });
      return;
    }

    if (operation !== this.generation) return;
    if (!this.isInsertionTargetCurrent(target)) {
      this.replaceState({ status: "error", error: STALE_INSERT });
      return;
    }
    if (!isResolvedForReference(result, library.libraryId, reference.annotationId)) {
      if (result.kind === "error") this.replaceState({ status: "error", error: result.message });
      else this.replaceState({ status: "error", error: RESOLVE_FAILED });
      return;
    }

    // Keep the resolved response transient. Only this explicit insertion call
    // receives the quotation text; it is never copied into Library state/view.
    const insertionInput: QuotationInsertionInput = {
      annotationId: result.annotationId,
      sourceId: result.sourceId,
      title: result.title,
      authors: result.authors,
      quote: result.quote,
      ...(result.page === undefined ? {} : { page: result.page })
    };

    let insertion: WritingInsertionResult;
    try {
      insertion = this.writing.insertQuotation(target, insertionInput);
    } catch (_error: unknown) {
      this.replaceState({ status: "error", error: STALE_INSERT });
      return;
    }
    if (insertion.kind === "inserted") {
      this.replaceState({ status: "ready", error: null });
    } else if (insertion.code === "stale-target") {
      // A target can become stale between the check and the edit call.
      this.replaceState({ status: "error", error: STALE_INSERT });
      return;
    } else {
      this.replaceState({ status: "error", error: insertion.message });
    }
  }

  private async openLibraryOperation(operation: number, previous: LibraryViewState): Promise<void> {
    let result: OpenLibraryResult;
    try {
      result = await this.api.openLibrary();
    } catch (_error: unknown) {
      if (operation === this.generation) {
        this.replaceState({ ...restoreAfterLibraryDialog(previous, OPEN_FAILED), status: "error" });
      }
      return;
    }
    if (operation !== this.generation) return;
    if (result.kind === "cancelled") {
      this.replaceState(restoreAfterLibraryDialog(previous, previous.error));
      return;
    }
    if (result.kind !== "opened") {
      this.replaceState({ ...restoreAfterLibraryDialog(previous, result.message), status: "error" });
      return;
    }

    this.replaceState({
      library: copyLibrary(result.library),
      query: "",
      references: [],
      selectedAnnotationId: null,
      status: "idle",
      error: null
    });
  }

  private async searchOperation(operation: number, request: SearchLibraryRequest): Promise<void> {
    let result: SearchLibraryResult;
    try {
      result = await this.api.searchLibrary(request);
    } catch (_error: unknown) {
      if (operation === this.generation) this.replaceState({ status: "error", error: SEARCH_FAILED });
      return;
    }
    if (operation !== this.generation) return;
    if (result.kind !== "results") {
      this.replaceState({ status: "error", error: result.message });
      return;
    }
    if (result.libraryId !== request.libraryId) {
      this.replaceState({ status: "error", error: SEARCH_FAILED });
      return;
    }
    this.replaceState({
      references: copyReferences(result.results),
      selectedAnnotationId: null,
      status: "ready",
      error: null
    });
  }

  private replaceState(update: Partial<LibraryViewState>): void {
    this.state = copyState({ ...this.state, ...update });
    this.render();
  }

  private render(): void {
    this.view.setLibraryState(this.getState());
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
