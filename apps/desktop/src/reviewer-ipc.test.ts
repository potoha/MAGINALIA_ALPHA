import { describe, expect, it, vi } from "vitest";
import {
  createReviewerHandlers,
  createReviewerSearchAdapter,
  isSearchShelfRequest,
  normalizeReviewerSearchResponse,
  parseReviewerBaseUrl,
  type ReviewerQuotation
} from "./reviewer-ipc";

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

describe("Reviewer Shelf IPC", () => {
  it("accepts only the query field and does not accept a renderer URL", () => {
    expect(isSearchShelfRequest({ query: "日本語" })).toBe(true);
    expect(isSearchShelfRequest({ query: "", url: "http://example.test" })).toBe(false);
    expect(isSearchShelfRequest({ query: "x".repeat(501) })).toBe(false);
  });

  it("restricts configured Reviewer URLs to loopback", () => {
    expect(parseReviewerBaseUrl("http://127.0.0.1:8765")).not.toBeNull();
    expect(parseReviewerBaseUrl("http://localhost:9000")).not.toBeNull();
    expect(parseReviewerBaseUrl("http://[::1]:9000")).not.toBeNull();
    expect(parseReviewerBaseUrl("https://example.test")).toBeNull();
    expect(parseReviewerBaseUrl("http://127.0.0.1:8765?redirect=example.test")).toBeNull();
  });

  it("maps Japanese substring search to Reviewer /api/search with APPROVED", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ results: [quotation], total: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const search = createReviewerSearchAdapter({
      baseUrl: "http://127.0.0.1:8765",
      fetcher
    });

    await expect(search("日本語")).resolves.toEqual({
      kind: "results",
      results: [quotation],
      total: 1
    });
    expect(calls).toHaveLength(1);
    const requestUrl = new URL(calls[0].url);
    expect(requestUrl.pathname).toBe("/api/search");
    expect(requestUrl.searchParams.get("q")).toBe("日本語");
    expect(requestUrl.searchParams.get("status")).toBe("APPROVED");
    expect(requestUrl.searchParams.get("limit")).toBe("50");
    expect(calls[0].init?.redirect).toBe("error");
  });

  it("handles empty, HTTP error, malformed, and unavailable responses", async () => {
    const empty = createReviewerSearchAdapter({
      baseUrl: "http://127.0.0.1:8765",
      fetcher: async () => new Response(JSON.stringify({ results: [], total: 0 }), { status: 200 })
    });
    await expect(empty("")).resolves.toEqual({ kind: "results", results: [], total: 0 });

    const httpError = createReviewerSearchAdapter({
      baseUrl: "http://127.0.0.1:8765",
      fetcher: async () => new Response("offline", { status: 503 })
    });
    await expect(httpError("q")).resolves.toMatchObject({ kind: "error", code: "reviewer-error" });

    const malformed = createReviewerSearchAdapter({
      baseUrl: "http://127.0.0.1:8765",
      fetcher: async () => new Response(JSON.stringify({ results: [{ annotationId: "missing" }] }), { status: 200 })
    });
    await expect(malformed("q")).resolves.toMatchObject({ kind: "error", code: "reviewer-invalid-response" });

    const unavailable = createReviewerSearchAdapter({ baseUrl: "http://example.test" });
    await expect(unavailable("q")).resolves.toMatchObject({ kind: "error", code: "reviewer-unavailable" });
  });

  it("keeps the main-process adapter behind a semantic handler", async () => {
    const search = vi.fn(async (query: string) => normalizeReviewerSearchResponse({
      results: query.length === 0 ? [] : [quotation],
      total: query.length === 0 ? 0 : 1
    })!);
    const handlers = createReviewerHandlers({ search });
    await expect(handlers.searchShelf({ sender: {} }, { query: "日本語" })).resolves.toMatchObject({
      kind: "results",
      total: 1
    });
    expect(search).toHaveBeenCalledWith("日本語");
    await expect(handlers.searchShelf({ sender: {} }, { query: "q", url: "file:///db" })).resolves.toMatchObject({
      kind: "error",
      code: "invalid-request"
    });
  });
});
