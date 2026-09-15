import { describe, expect, it, vi } from "vitest";
import { openDocument, type QuotationInsertionInput } from "@maginalia/writing-core";
import type {
  OpenLibraryResult,
  ResolveQuotationForInsertRequest,
  ResolveQuotationForInsertResult,
  SearchLibraryRequest,
  SearchLibraryResult,
  QuotationReference
} from "../library-ipc";
import {
  LibraryController,
  type LibraryControllerApi,
  type LibraryControllerView,
  type LibraryViewState,
  type LibraryWritingPort
} from "./library-controller";
import type { CapturedInsertionTarget, WritingInsertionResult } from "./controller";

const LIBRARY_ONE = "11111111-1111-4111-8111-111111111111";
const LIBRARY_TWO = "22222222-2222-4222-8222-222222222222";

const reference: QuotationReference = {
  annotationId: "ann:01ARZ3NDEKTSV4RRFFQ69G5FAV",
  sourceId: "isbn:9784101010014",
  title: "A Book",
  authors: ["Author One"],
  page: 42
};

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

class FakeView implements LibraryControllerView {
  public state: LibraryViewState = {
    library: null,
    query: "",
    status: "idle",
    references: [],
    selectedAnnotationId: null,
    error: null
  };
  public readonly states: LibraryViewState[] = [];

  public setLibraryState(state: LibraryViewState): void {
    this.state = state;
    this.states.push(state);
  }
}

class FakeWriting implements LibraryWritingPort {
  public target: CapturedInsertionTarget | null = {
    documentId: "document-1",
    revision: 1,
    range: { start: 0, end: 0 }
  };
  public targetCurrent = true;
  public readonly insertionCalls: Array<{
    target: CapturedInsertionTarget;
    input: QuotationInsertionInput;
  }> = [];
  public insertionResult: WritingInsertionResult | undefined;
  public captureCalls = 0;

  public captureInsertionTarget(): CapturedInsertionTarget | null {
    this.captureCalls += 1;
    return this.target;
  }

  public isInsertionTargetCurrent(target: CapturedInsertionTarget | null): boolean {
    return this.targetCurrent && target !== null && target === this.target;
  }

  public insertQuotation(target: CapturedInsertionTarget, input: QuotationInsertionInput): WritingInsertionResult {
    this.insertionCalls.push({ target, input });
    if (this.insertionResult !== undefined) return this.insertionResult;
    return {
      kind: "inserted",
      state: openDocument({ documentId: target.documentId, displayName: "manuscript.md", text: input.quote }),
      insertedText: input.quote,
      selectionStart: input.quote.length,
      selectionEnd: input.quote.length
    };
  }
}

function defaultApi(overrides: Partial<LibraryControllerApi> = {}): LibraryControllerApi {
  return {
    openLibrary: overrides.openLibrary ?? (() => Promise.resolve({
      kind: "opened",
      library: { libraryId: LIBRARY_ONE, displayName: "My Library" },
      recordCount: 1,
      issueCount: 0
    } as const satisfies OpenLibraryResult)),
    searchLibrary: overrides.searchLibrary ?? ((request: SearchLibraryRequest) => Promise.resolve({
      kind: "results",
      libraryId: request.libraryId,
      results: [reference]
    } as const satisfies SearchLibraryResult)),
    resolveQuotationForInsert: overrides.resolveQuotationForInsert ?? ((request: ResolveQuotationForInsertRequest) => Promise.resolve({
      kind: "resolved",
      libraryId: request.libraryId,
      annotationId: request.annotationId,
      sourceId: reference.sourceId,
      title: reference.title,
      authors: reference.authors,
      page: reference.page,
      quote: "Resolved quotation"
    } as const satisfies ResolveQuotationForInsertResult))
  };
}

function makeHarness(
  api: LibraryControllerApi = defaultApi()
): { controller: LibraryController; view: FakeView; writing: FakeWriting; api: LibraryControllerApi } {
  const view = new FakeView();
  const writing = new FakeWriting();
  const controller = new LibraryController({ api, writing, view });
  return { controller, view, writing, api };
}

async function openAndSearch(controller: LibraryController, query = "query"): Promise<void> {
  await controller.openLibrary();
  await controller.search(query);
}

describe("LibraryController", () => {
  it("keeps search state reference-only, including for a memo-only match", async () => {
    const memoOnlyReference = {
      ...reference,
      privateMemo: "PRIVATE_MEMO",
      matchField: "privateMemo",
      snippet: "PRIVATE_SNIPPET",
      quote: "PRIVATE_QUOTE"
    } as unknown as QuotationReference;
    const api = defaultApi({
      searchLibrary: (request) => Promise.resolve({
        kind: "results",
        libraryId: request.libraryId,
        results: [memoOnlyReference]
      } as const)
    });
    const { controller, view } = makeHarness(api);

    await openAndSearch(controller, "memo");

    expect(view.state.library).toEqual({ libraryId: LIBRARY_ONE, displayName: "My Library" });
    expect(view.state.query).toBe("memo");
    expect(view.state.references).toEqual([reference]);
    expect(Object.keys(view.state.references[0]).sort()).toEqual([
      "annotationId", "authors", "page", "sourceId", "title"
    ]);
    const serialized = JSON.stringify(view.state);
    expect(serialized).not.toContain("PRIVATE");
    expect(serialized).not.toContain("snippet");
    expect(serialized).not.toContain("matchField");
  });

  it("requires an active manuscript before resolving a quotation", async () => {
    const resolve = vi.fn(() => Promise.resolve({
      kind: "resolved",
      libraryId: LIBRARY_ONE,
      annotationId: reference.annotationId,
      sourceId: reference.sourceId,
      title: reference.title,
      authors: reference.authors,
      quote: "Should not resolve"
    } as const));
    const api = defaultApi({ resolveQuotationForInsert: resolve });
    const { controller, view, writing } = makeHarness(api);
    writing.target = null;
    await openAndSearch(controller);
    controller.selectReference(reference.annotationId);

    await controller.insertReference();

    expect(writing.captureCalls).toBe(1);
    expect(resolve).not.toHaveBeenCalled();
    expect(view.state.error).toBe("Open a manuscript before inserting a quotation.");
  });

  it("applies an explicit repository Shelf handoff without retaining old references", async () => {
    const { controller, view } = makeHarness();
    await openAndSearch(controller);

    const activated = controller.activateLibrary({
      kind: "opened",
      library: { libraryId: LIBRARY_TWO, displayName: "Shelf" },
      recordCount: 0,
      issueCount: 0
    });

    expect(activated).toBe(true);
    expect(view.state.library).toEqual({ libraryId: LIBRARY_TWO, displayName: "Shelf" });
    expect(view.state.references).toEqual([]);
    expect(view.state.selectedAnnotationId).toBeNull();
    expect(view.state.query).toBe("");
  });

  it("resolves exactly once and sends the transient quotation to WritingController", async () => {
    const resolve = vi.fn((request: ResolveQuotationForInsertRequest) => Promise.resolve({
      kind: "resolved",
      libraryId: request.libraryId,
      annotationId: request.annotationId,
      sourceId: reference.sourceId,
      title: reference.title,
      authors: reference.authors,
      page: reference.page,
      quote: "Resolved quotation"
    } as const));
    const api = defaultApi({ resolveQuotationForInsert: resolve });
    const { controller, view, writing } = makeHarness(api);
    await openAndSearch(controller);

    await controller.insertReference(reference.annotationId);

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({ libraryId: LIBRARY_ONE, annotationId: reference.annotationId });
    expect(writing.insertionCalls).toHaveLength(1);
    expect(writing.insertionCalls[0].input).toEqual({
      annotationId: reference.annotationId,
      sourceId: reference.sourceId,
      title: reference.title,
      authors: reference.authors,
      page: reference.page,
      quote: "Resolved quotation"
    });
    expect(JSON.stringify(controller.getState())).not.toContain("Resolved quotation");
    expect(JSON.stringify(view.state)).not.toContain("Resolved quotation");
    expect(view.state.error).toBeNull();
  });

  it("ignores a late search result after the Library is replaced", async () => {
    const pendingSearch = deferred<SearchLibraryResult>();
    let openCount = 0;
    const api = defaultApi({
      openLibrary: () => {
        openCount += 1;
        return Promise.resolve({
          kind: "opened",
          library: {
            libraryId: openCount === 1 ? LIBRARY_ONE : LIBRARY_TWO,
            displayName: openCount === 1 ? "First" : "Second"
          },
          recordCount: 1,
          issueCount: 0
        } as const);
      },
      searchLibrary: () => pendingSearch.promise
    });
    const { controller, view } = makeHarness(api);
    await controller.openLibrary();
    const searching = controller.search("old");
    await Promise.resolve();

    await controller.openLibrary();
    pendingSearch.resolve({ kind: "results", libraryId: LIBRARY_ONE, results: [reference] });
    await searching;

    expect(view.state.library).toEqual({ libraryId: LIBRARY_TWO, displayName: "Second" });
    expect(view.state.references).toEqual([]);
    expect(view.state.query).toBe("");
  });

  it("ignores a late resolve after selection changes", async () => {
    const pendingResolve = deferred<ResolveQuotationForInsertResult>();
    const secondReference: QuotationReference = {
      ...reference,
      annotationId: "ann:01ARZ3NDEKTSV4RRFFQ69G5FAY",
      title: "Another Book"
    };
    const api = defaultApi({
      searchLibrary: (request) => Promise.resolve({
        kind: "results",
        libraryId: request.libraryId,
        results: [reference, secondReference]
      } as const),
      resolveQuotationForInsert: () => pendingResolve.promise
    });
    const { controller, writing } = makeHarness(api);
    await openAndSearch(controller);

    const inserting = controller.insertReference(reference.annotationId);
    await Promise.resolve();
    controller.selectReference(secondReference.annotationId);
    pendingResolve.resolve({
      kind: "resolved",
      libraryId: LIBRARY_ONE,
      annotationId: reference.annotationId,
      sourceId: reference.sourceId,
      title: reference.title,
      authors: reference.authors,
      quote: "Late quotation"
    });
    await inserting;

    expect(writing.insertionCalls).toHaveLength(0);
  });

  it("discards a resolved quotation when the Writing target becomes stale", async () => {
    const pendingResolve = deferred<ResolveQuotationForInsertResult>();
    const api = defaultApi({ resolveQuotationForInsert: () => pendingResolve.promise });
    const { controller, writing, view } = makeHarness(api);
    await openAndSearch(controller);

    const inserting = controller.insertReference(reference.annotationId);
    await Promise.resolve();
    writing.targetCurrent = false;
    pendingResolve.resolve({
      kind: "resolved",
      libraryId: LIBRARY_ONE,
      annotationId: reference.annotationId,
      sourceId: reference.sourceId,
      title: reference.title,
      authors: reference.authors,
      quote: "Stale quotation"
    });
    await inserting;

    expect(writing.insertionCalls).toHaveLength(0);
    expect(JSON.stringify(view.state)).not.toContain("Stale quotation");
    expect(view.state.status).toBe("error");
    expect(view.state.error).toBe("The writing target changed before insertion. Select Insert again.");
  });

  it("reports a stale target if it changes between validation and insertion", async () => {
    const api = defaultApi();
    const { controller, writing, view } = makeHarness(api);
    writing.insertionResult = {
      kind: "error",
      code: "stale-target",
      message: "The quotation target is no longer current."
    };
    await openAndSearch(controller);

    await controller.insertReference(reference.annotationId);

    expect(writing.insertionCalls).toHaveLength(1);
    expect(view.state.status).toBe("error");
    expect(view.state.error).toBe("The writing target changed before insertion. Select Insert again.");
  });

  it("rejects a resolved quotation from another Library or annotation", async () => {
    const resolve = vi.fn(() => Promise.resolve({
      kind: "resolved",
      libraryId: LIBRARY_TWO,
      annotationId: "ann:01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      sourceId: reference.sourceId,
      title: reference.title,
      authors: reference.authors,
      quote: "Must not insert"
    } as const));
    const { controller, writing, view } = makeHarness(defaultApi({ resolveQuotationForInsert: resolve }));
    await openAndSearch(controller);

    await controller.insertReference(reference.annotationId);

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(writing.insertionCalls).toHaveLength(0);
    expect(view.state.status).toBe("error");
    expect(view.state.error).toBe("The quotation could not be resolved. Try again.");
  });
});
