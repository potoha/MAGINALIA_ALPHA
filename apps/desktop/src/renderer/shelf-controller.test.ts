import { describe, expect, it, vi } from "vitest";
import { openDocument, type QuoteRef } from "@maginalia/writing-core";
import type { CapturedInsertionTarget, WritingInsertionResult } from "./controller";
import {
  ShelfController,
  type ShelfControllerApi,
  type ShelfControllerView,
  type ShelfViewState,
  type ShelfWritingPort
} from "./shelf-controller";
import type { ReviewerQuotation, SearchShelfResult } from "../reviewer-ipc";

const quotation: ReviewerQuotation = {
  annotationId: "2b6c4e0c-7268-4da0-9ad3-f5d1c8b7f2a1",
  captureId: "capture-1",
  pageId: "page-1",
  sourcePageId: "source-page-1",
  isbn13: "9780306406157",
  title: "検索の本",
  authors: ["山田太郎"],
  quote: "これは日本語の引用です。",
  pageLabel: "42",
  comment: "レビューコメント",
  reviewState: "APPROVED",
  reviewedAtMs: 10
};

class FakeView implements ShelfControllerView {
  public state: ShelfViewState = {
    query: "",
    status: "idle",
    results: [],
    selectedAnnotationId: null,
    error: null
  };
  public setShelfState(state: ShelfViewState): void {
    this.state = state;
  }
}

class FakeWriting implements ShelfWritingPort {
  public target: CapturedInsertionTarget | null = {
    documentId: "document-1",
    revision: 1,
    range: { start: 0, end: 0 }
  };
  public targetCurrent = true;
  public readonly insertions: Array<{ target: CapturedInsertionTarget; ref: QuoteRef }> = [];
  public captureInsertionTarget = vi.fn(() => this.target);
  public isInsertionTargetCurrent = vi.fn((target: CapturedInsertionTarget | null) =>
    this.targetCurrent && target !== null && target === this.target);

  public insertQuoteRef(target: CapturedInsertionTarget, ref: QuoteRef): WritingInsertionResult {
    this.insertions.push({ target, ref });
    return {
      kind: "inserted",
      state: openDocument({ documentId: target.documentId, displayName: "notes.md", text: "marker" }),
      insertedText: "marker",
      selectionStart: 6,
      selectionEnd: 6
    };
  }
}

function makeHarness(result: SearchShelfResult = { kind: "results", results: [quotation], total: 1 }) {
  const view = new FakeView();
  const writing = new FakeWriting();
  const api: ShelfControllerApi = {
    searchShelf: vi.fn(async () => result)
  };
  const controller = new ShelfController({ api, writing, view });
  return { controller, view, writing, api };
}

describe("ShelfController", () => {
  it("maps Reviewer results and inserts only annotationId as a normal QuoteRef", async () => {
    const { controller, view, writing } = makeHarness();
    await controller.search("日本語");

    expect(view.state.results).toEqual([quotation]);
    expect(view.state.status).toBe("ready");
    await controller.insertResult(quotation.annotationId);

    expect(writing.insertions).toEqual([{
      target: writing.target,
      ref: { quoteId: quotation.annotationId, mode: "normal" }
    }]);
    expect(view.state.error).toBeNull();
  });

  it("keeps empty results as a successful search", async () => {
    const { controller, view } = makeHarness({ kind: "results", results: [], total: 0 });
    await controller.search("");
    expect(view.state.status).toBe("ready");
    expect(view.state.results).toEqual([]);
    expect(view.state.error).toBeNull();
  });

  it("surfaces Reviewer errors and unavailable state", async () => {
    const { controller, view } = makeHarness({
      kind: "error",
      code: "reviewer-unavailable",
      message: "Reviewer unavailable."
    });
    await controller.search("q");
    expect(view.state.status).toBe("error");
    expect(view.state.error).toBe("Reviewer unavailable.");
  });

  it("does not call Writing when no document is open", async () => {
    const { controller, view, writing } = makeHarness();
    await controller.search("q");
    writing.target = null;
    await controller.insertResult(quotation.annotationId);
    expect(writing.insertions).toHaveLength(0);
    expect(view.state.error).toBe("Open a manuscript before inserting a quotation.");
  });

  it("rejects a stale insertion target", async () => {
    const { controller, view, writing } = makeHarness();
    await controller.search("q");
    writing.targetCurrent = false;
    await controller.insertResult(quotation.annotationId);
    expect(writing.insertions).toHaveLength(0);
    expect(view.state.error).toBe("The writing target changed before insertion. Select Insert again.");
  });
});
