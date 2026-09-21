import { describe, expect, it, vi } from "vitest";
import type { ReviewerQuotation } from "../reviewer-ipc";
import {
  DEFAULT_SHELF_SEARCH_FIELDS,
  ProjectSearchController,
  filterShelfResults,
  insertProjectSearchSelection,
  shelfFilterValidation
} from "./unified-search";

function quotation(overrides: Partial<ReviewerQuotation> = {}): ReviewerQuotation {
  return {
    annotationId: "ann-1", captureId: "capture-1", pageId: "page-1", sourcePageId: null, isbn13: null,
    title: "Book title", authors: ["Author"], quote: "quoted 日本語", pageLabel: "42", comment: "comment needle",
    reviewState: "APPROVED", reviewedAtMs: null, ...overrides
  };
}

describe("unified Shelf search", () => {
  it("filters broad Reviewer results by each selected field with OR semantics without changing identity", () => {
    const entries = [quotation(), quotation({ annotationId: "ann-2", title: "Different", quote: "other", comment: "other", authors: ["Other"], pageLabel: "9" })];
    expect(filterShelfResults(entries, "日本語", new Set(["quote"])).map((entry) => entry.annotationId)).toEqual(["ann-1"]);
    expect(filterShelfResults(entries, "needle", new Set(["comment"])).map((entry) => entry.annotationId)).toEqual(["ann-1"]);
    expect(filterShelfResults(entries, "book", new Set(["title"])).map((entry) => entry.annotationId)).toEqual(["ann-1"]);
    expect(filterShelfResults(entries, "author", new Set(["authors"])).map((entry) => entry.annotationId)).toEqual(["ann-1"]);
    expect(filterShelfResults(entries, "42", new Set(["pageLabel"])).map((entry) => entry.annotationId)).toEqual(["ann-1"]);
    expect(filterShelfResults(entries, "needle", new Set(["title", "comment"])).map((entry) => entry.annotationId)).toEqual(["ann-1"]);
    expect(filterShelfResults(entries, "日本語", DEFAULT_SHELF_SEARCH_FIELDS)[0]?.annotationId).toBe("ann-1");
    expect(shelfFilterValidation(new Set())).toContain("at least one");
  });
});

describe("Project literal insertion", () => {
  const target = { documentId: "11111111-1111-4111-8111-111111111111", revision: 1, range: { start: 2, end: 2 } };

  it("inserts the selected raw string only through a current target", () => {
    const insert = vi.fn(() => true);
    expect(insertProjectSearchSelection(target, "## raw\n[[link]]", () => true, insert)).toBe("inserted");
    expect(insert).toHaveBeenCalledWith(target, "## raw\n[[link]]");
    expect(insertProjectSearchSelection(target, "", () => true, insert)).toBe("empty-selection");
    expect(insertProjectSearchSelection(target, "text", () => false, insert)).toBe("stale-target");
  });
});

describe("Project search controller", () => {
  it("keeps async results and errors in a bounded view state", async () => {
    const states: string[] = [];
    const controller = new ProjectSearchController({
      searchProjectMarkdown: vi.fn(async () => ({ kind: "results" as const, total: 1, results: [{ fileId: "f", displayName: "notes/a.md", excerpt: "日本語", text: "日本語" }] }))
    }, (state) => states.push(state.kind));
    await controller.search("11111111-1111-4111-8111-111111111111", "日本語");
    expect(controller.getState()).toMatchObject({ kind: "results", total: 1 });
    expect(states).toEqual(["searching", "results"]);
  });
});
