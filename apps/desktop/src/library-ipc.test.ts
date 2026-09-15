import { describe, expect, it } from "vitest";
import {
  createLibraryHandlers,
  isResolveQuotationForInsertRequest,
  isSearchLibraryRequest,
  MAX_LIBRARY_QUERY_CHARS,
  type LibraryHandlers,
} from "./library-ipc";

const LIBRARY_ID = "22222222-2222-4222-8222-222222222222";
const ANNOTATION_ID = "ann:01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_ANNOTATION_ID = "ann:01ARZ3NDEKTSV4RRFFQ69G5FAW";

function createTestHandlers(overrides: Partial<Parameters<typeof createLibraryHandlers>[0]> = {}): LibraryHandlers {
  return createLibraryHandlers({
    pickLibraryFolder: async () => ({ canceled: true, filePaths: [] }),
    openLibraryRoot: async () => ({
      kind: "opened",
      library: { libraryId: LIBRARY_ID, displayName: "Library" },
      recordCount: 0,
      issueCount: 0,
    }),
    searchLibrary: async () => ({
      kind: "results",
      libraryId: LIBRARY_ID,
      results: [],
    }),
    resolveQuotationForInsert: async () => ({
      kind: "error",
      code: "annotation-not-found",
      message: "not found",
    }),
    ...overrides,
  });
}

describe("Library quotation IPC boundary", () => {
  it("accepts exact search and resolve requests only", () => {
    const search = { libraryId: LIBRARY_ID, query: "日本語 *" };
    expect(isSearchLibraryRequest(search)).toBe(true);
    expect(isSearchLibraryRequest({ ...search, path: "C:\\outside" })).toBe(false);
    expect(isSearchLibraryRequest({ ...search, extra: true })).toBe(false);
    expect(isSearchLibraryRequest({ ...search, libraryId: "../../library" })).toBe(false);
    expect(isSearchLibraryRequest({ ...search, query: "x".repeat(MAX_LIBRARY_QUERY_CHARS + 1) })).toBe(false);
    expect(isSearchLibraryRequest({ libraryId: LIBRARY_ID })).toBe(false);
    expect(isSearchLibraryRequest(null)).toBe(false);
    expect(isSearchLibraryRequest([search])).toBe(false);

    const resolve = { libraryId: LIBRARY_ID, annotationId: ANNOTATION_ID };
    expect(isResolveQuotationForInsertRequest(resolve)).toBe(true);
    expect(isResolveQuotationForInsertRequest({ ...resolve, path: "C:\\outside" })).toBe(false);
    expect(isResolveQuotationForInsertRequest({ ...resolve, extra: true })).toBe(false);
    expect(isResolveQuotationForInsertRequest({ ...resolve, annotationId: "../../outside" })).toBe(false);
    expect(isResolveQuotationForInsertRequest({ libraryId: LIBRARY_ID, annotationId: "" })).toBe(false);
    expect(isResolveQuotationForInsertRequest(null)).toBe(false);
  });

  it("opens through one selected folder, preserves cancellation, and sanitizes failures", async () => {
    let picked = 0;
    let selectedPath = "";
    const handlers = createTestHandlers({
      pickLibraryFolder: async () => {
        picked += 1;
        return { canceled: false, filePaths: ["C:\\private\\library"] };
      },
      openLibraryRoot: async (_owner, rootPath) => {
        selectedPath = rootPath;
        return {
          kind: "opened",
          library: { libraryId: LIBRARY_ID, displayName: "Private" },
          recordCount: 2,
          issueCount: 1,
        };
      },
    });
    const owner = {};
    const opened = await handlers.openLibrary({ sender: owner });
    expect(opened).toMatchObject({ kind: "opened", recordCount: 2, issueCount: 1 });
    expect(selectedPath).toBe("C:\\private\\library");
    expect(JSON.stringify(opened)).not.toContain(selectedPath);

    const cancelled = createTestHandlers({
      pickLibraryFolder: async () => {
        picked += 1;
        return { canceled: true, filePaths: [] };
      },
    });
    expect(await cancelled.openLibrary({ sender: {} })).toEqual({ kind: "cancelled" });
    expect(await cancelled.openLibrary({ sender: {} }, { path: "C:\\outside" })).toMatchObject({
      kind: "error",
      code: "invalid-request",
    });

    const multiple = createTestHandlers({
      pickLibraryFolder: async () => ({ canceled: false, filePaths: ["C:\\one", "C:\\two"] }),
    });
    expect(await multiple.openLibrary({ sender: {} })).toMatchObject({
      kind: "error",
      code: "folder-dialog-failed",
    });

    const thrownOpen = createTestHandlers({
      pickLibraryFolder: async () => ({ canceled: false, filePaths: ["C:\\secret"] }),
      openLibraryRoot: async () => {
        throw new Error("stack/path C:\\secret");
      },
    });
    const failed = await thrownOpen.openLibrary({ sender: {} });
    expect(failed).toMatchObject({ kind: "error", code: "library-open-failed" });
    expect(JSON.stringify(failed)).not.toContain("stack/path");
    expect(picked).toBe(2);
  });

  it("maps search references without quotation, memo, evidence, or paths", async () => {
    let called: unknown[] = [];
    const handlers = createTestHandlers({
      searchLibrary: async (owner, libraryId, query) => {
        called = [owner, libraryId, query];
        return {
          kind: "results",
          libraryId,
          results: [{
            annotationId: ANNOTATION_ID,
            sourceId: "isbn:9781234567890",
            title: "Title",
            authors: ["Author"],
            page: 7,
          }],
        };
      },
    });
    const owner = {};
    const result = await handlers.searchLibrary({ sender: owner }, { libraryId: LIBRARY_ID, query: "needle" });
    expect(called).toEqual([owner, LIBRARY_ID, "needle"]);
    expect(result).toEqual({
      kind: "results",
      libraryId: LIBRARY_ID,
      results: [{
        annotationId: ANNOTATION_ID,
        sourceId: "isbn:9781234567890",
        title: "Title",
        authors: ["Author"],
        page: 7,
      }],
    });
    expect(Object.keys(result.kind === "results" ? result.results[0] : {}).sort()).toEqual([
      "annotationId",
      "authors",
      "page",
      "sourceId",
      "title",
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("quote");
    expect(serialized).not.toContain("privateMemo");
    expect(serialized).not.toContain("rawOcr");
    expect(serialized).not.toContain("C:\\private");

    let calledInvalid = false;
    const invalid = createTestHandlers({
      searchLibrary: async () => {
        calledInvalid = true;
        return { kind: "results", libraryId: LIBRARY_ID, results: [] };
      },
    });
    expect(await invalid.searchLibrary(
      { sender: {} },
      { libraryId: LIBRARY_ID, query: "x".repeat(MAX_LIBRARY_QUERY_CHARS + 1) },
    )).toMatchObject({ kind: "error", code: "invalid-request" });
    expect(calledInvalid).toBe(false);
  });

  it("resolves only through the dedicated insertion operation and sanitizes thrown errors", async () => {
    let called: unknown[] = [];
    const handlers = createTestHandlers({
      resolveQuotationForInsert: async (owner, libraryId, annotationId) => {
        called = [owner, libraryId, annotationId];
        return {
          kind: "resolved",
          libraryId,
          annotationId,
          sourceId: "isbn:9781234567890",
          title: "Title",
          authors: ["Author"],
          page: 7,
          quote: "引用本文",
        };
      },
    });
    const owner = {};
    const result = await handlers.resolveQuotationForInsert(
      { sender: owner },
      { libraryId: LIBRARY_ID, annotationId: ANNOTATION_ID },
    );
    expect(called).toEqual([owner, LIBRARY_ID, ANNOTATION_ID]);
    expect(result).toEqual({
      kind: "resolved",
      libraryId: LIBRARY_ID,
      annotationId: ANNOTATION_ID,
      sourceId: "isbn:9781234567890",
      title: "Title",
      authors: ["Author"],
      page: 7,
      quote: "引用本文",
    });
    expect(Object.keys(result).sort()).toEqual([
      "annotationId",
      "authors",
      "kind",
      "libraryId",
      "page",
      "quote",
      "sourceId",
      "title",
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("privateMemo");
    expect(serialized).not.toContain("rawOcr");
    expect(serialized).not.toContain("comment");
    expect(serialized).not.toContain("C:\\private");

    expect(await handlers.resolveQuotationForInsert(
      { sender: {} },
      { libraryId: LIBRARY_ID, annotationId: ANNOTATION_ID, path: "C:\\outside" },
    )).toMatchObject({ kind: "error", code: "invalid-request" });

    const thrown = createTestHandlers({
      resolveQuotationForInsert: async () => {
        throw new Error("raw stack and C:\\secret");
      },
    });
    const failed = await thrown.resolveQuotationForInsert(
      { sender: {} },
      { libraryId: LIBRARY_ID, annotationId: OTHER_ANNOTATION_ID },
    );
    expect(failed).toMatchObject({ kind: "error", code: "quotation-resolve-failed" });
    expect(JSON.stringify(failed)).not.toContain("raw stack");
    expect(JSON.stringify(failed)).not.toContain("C:\\secret");
  });
});
