import { describe, expect, it, vi } from "vitest";
import { parseQuoteRef, serializeQuoteRef } from "@maginalia/writing-core";
import {
  createReviewerResolutionAdapter,
  REVIEWER_RESOLUTION_SEARCH_LIMIT,
  scanQuoteRefs,
  type ReviewerResolutionResult
} from "./reviewer-resolution";
import type { ReviewerQuotation } from "./reviewer-ipc";

const ISBN = "9780306406157";
const SECOND_ISBN = "9780134685991";
const BASE_URL = "http://127.0.0.1:8765";

function quotation(
  annotationId: string,
  overrides: Partial<ReviewerQuotation> = {}
): ReviewerQuotation {
  return {
    annotationId,
    captureId: `capture-${annotationId}`,
    pageId: `page-${annotationId}`,
    sourcePageId: null,
    isbn13: ISBN,
    title: "開かれた作品",
    authors: ["ウンベルト・エーコ"],
    quote: `引用 ${annotationId}`,
    pageLabel: "42",
    comment: "",
    reviewState: "APPROVED",
    reviewedAtMs: 1,
    ...overrides
  };
}

function marker(annotationId: string): string {
  return serializeQuoteRef({ quoteId: annotationId, mode: "normal" });
}

function searchPage(results: readonly ReviewerQuotation[], total = results.length, offset = 0): Response {
  return new Response(JSON.stringify({
    results,
    total,
    limit: REVIEWER_RESOLUTION_SEARCH_LIMIT,
    offset
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function publication(isbn13: string, overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    updatedAtMs: 1,
    book: {
      isbn13,
      title: "開かれた作品",
      authors: ["ウンベルト・エーコ"],
      publisher: "青土社",
      publishedDate: "1990",
      subtitle: "ignored",
      coverUrl: "https://example.invalid/cover.jpg",
      provenance: { title: "openBD" },
      ...overrides
    },
    highlights: []
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function adapterWith(fetcher: typeof fetch) {
  return createReviewerResolutionAdapter({ baseUrl: BASE_URL, fetcher });
}

describe("Reviewer QuoteRef source resolution", () => {
  it("scans valid and malformed markers without changing document text", () => {
    const text = `before\n${marker("annotation-1")}\nafter\n<!-- maginalia:quote-ref v1 not-json -->`;
    const occurrences = scanQuoteRefs(text, parseQuoteRef);
    expect(occurrences).toHaveLength(2);
    expect(occurrences[0].quoteRef).toEqual({ quoteId: "annotation-1", mode: "normal" });
    expect(occurrences[1].quoteRef).toBeNull();
    expect(text).toContain(marker("annotation-1"));
  });

  it("resolves an ISBN-backed quote and maps only allowlisted publication fields", async () => {
    const calls: URL[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      calls.push(url);
      if (url.pathname === "/api/search") return searchPage([quotation("annotation-1")]);
      if (url.pathname === `/api/books/${ISBN}/publication`) return publication(ISBN);
      throw new Error(`unexpected endpoint ${url}`);
    });

    const result = await adapterWith(fetcher)(marker("annotation-1"));
    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") return;
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({
      id: `book:isbn13:${ISBN}`,
      type: "book",
      title: "開かれた作品",
      authors: ["ウンベルト・エーコ"],
      publisher: "青土社",
      publishedDate: "1990",
      identifiers: { isbn13: ISBN }
    });
    expect(result.sources[0]).not.toHaveProperty("metadata");
    expect(result.sources[0]).not.toHaveProperty("coverUrl");
    expect(calls[0].searchParams.get("q")).toBe("");
    expect(calls[0].searchParams.get("status")).toBe("APPROVED");
    expect(calls[0].searchParams.get("limit")).toBe(String(REVIEWER_RESOLUTION_SEARCH_LIMIT));
    expect(calls[0].searchParams.get("offset")).toBe("0");
  });

  it("deduplicates two QuoteRefs for one book and fetches publication once", async () => {
    const first = quotation("annotation-1");
    const second = quotation("annotation-2", { pageLabel: "43" });
    const publicationCalls: URL[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/search") return searchPage([first, second]);
      publicationCalls.push(url);
      return publication(ISBN);
    });

    const result = await adapterWith(fetcher)(`${marker(first.annotationId)}\n${marker(second.annotationId)}`);
    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") return;
    expect(result.resolved).toHaveLength(2);
    expect(result.sources).toHaveLength(1);
    expect(publicationCalls).toHaveLength(1);
  });

  it("resolves multiple books with deterministic first-occurrence source order", async () => {
    const first = quotation("annotation-1");
    const second = quotation("annotation-2", {
      isbn13: SECOND_ISBN,
      title: "第二の本",
      authors: ["第二著者"]
    });
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/search") return searchPage([first, second]);
      return url.pathname === `/api/books/${SECOND_ISBN}/publication`
        ? publication(SECOND_ISBN, { title: "第二の本" })
        : publication(ISBN);
    });

    const result = await adapterWith(fetcher)(`${marker(first.annotationId)}\n${marker(second.annotationId)}`);
    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") return;
    expect(result.sources.map((source) => source.id)).toEqual([
      `book:isbn13:${ISBN}`,
      `book:isbn13:${SECOND_ISBN}`
    ]);
  });

  it("keeps unresolved malformed, missing, and no-ISBN refs without failing the document refresh", async () => {
    const present = quotation("present");
    const absentIsbn = quotation("no-isbn", { isbn13: null });
    const invalidIsbn = quotation("bad-isbn", { isbn13: "9780306406158" });
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/search") return searchPage([present, absentIsbn, invalidIsbn]);
      return publication(ISBN);
    });
    const text = `${marker("present")}\n${marker("missing")}\n${marker("no-isbn")}\n${marker("bad-isbn")}\n<!-- maginalia:quote-ref v1 nope -->`;

    const result = await adapterWith(fetcher)(text);
    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") return;
    expect(result.resolved).toHaveLength(1);
    expect(result.unresolved.map((item) => item.code)).toEqual([
      "quote-not-found",
      "isbn-absent",
      "isbn-invalid",
      "malformed-marker"
    ]);
  });

  it("handles publication unavailable, malformed, and ISBN mismatch as unresolved", async () => {
    const unavailable = quotation("unavailable");
    const malformed = quotation("malformed", { isbn13: SECOND_ISBN });
    const mismatchIsbn = "9780132350884";
    const mismatch = quotation("mismatch", { isbn13: mismatchIsbn });
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/search") return searchPage([unavailable, malformed, mismatch]);
      if (url.pathname.endsWith(`/api/books/${ISBN}/publication`)) return new Response(null, { status: 404 });
      if (url.pathname.endsWith(`/api/books/${SECOND_ISBN}/publication`)) return new Response("bad", { status: 200 });
      return publication(ISBN, { isbn13: ISBN });
    });

    const result = await adapterWith(fetcher)(`${marker("unavailable")}\n${marker("malformed")}\n${marker("mismatch")}`);
    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") return;
    expect(result.resolved).toHaveLength(0);
    expect(result.unresolved.map((item) => item.code)).toEqual([
      "publication-unavailable",
      "publication-malformed",
      "publication-mismatch"
    ]);
  });

  it("returns an explicit refresh failure for Reviewer transport, malformed search, and pagination errors", async () => {
    const ref = marker("annotation-1");
    const unavailable = await adapterWith(async () => { throw new Error("offline"); })(ref);
    expect(unavailable).toMatchObject({ kind: "error", code: "reviewer-unavailable" });

    const malformed = await adapterWith(async () => new Response("bad", { status: 200 }))(ref);
    expect(malformed).toMatchObject({ kind: "error", code: "reviewer-invalid-response" });

    const invalidField = await adapterWith(async () => new Response(JSON.stringify({
      results: [{ ...quotation("annotation-1"), isbn13: 9780306406157 }],
      total: 1,
      limit: REVIEWER_RESOLUTION_SEARCH_LIMIT,
      offset: 0
    }), { status: 200 }))(ref);
    expect(invalidField).toMatchObject({ kind: "error", code: "pagination-inconsistent" });

    const inconsistent = await adapterWith(async () => new Response(JSON.stringify({
      results: [],
      total: 1,
      limit: REVIEWER_RESOLUTION_SEARCH_LIMIT,
      offset: 0
    }), { status: 200 }))(ref);
    expect(inconsistent).toMatchObject({ kind: "error", code: "pagination-inconsistent" });
  });

  it("walks pages until the requested annotation ids are found", async () => {
    const target = quotation("late");
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.searchParams.get("offset") === "0") {
        return searchPage(Array.from({ length: REVIEWER_RESOLUTION_SEARCH_LIMIT }, (_, index) => quotation(`filler-${index}`)), 101, 0);
      }
      if (url.searchParams.get("offset") === "100") return searchPage([target], 101, 100);
      return publication(ISBN);
    });
    const result = await adapterWith(fetcher)(marker(target.annotationId));
    expect(result.kind).toBe("resolved");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
