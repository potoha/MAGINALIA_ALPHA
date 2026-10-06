import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serializeQuoteRef } from "@maginalia/writing-core";
import { LibraryService, type LibraryOpenResult } from "./library-service";
import { materializeReviewerRecords } from "./reviewer-shelf-materializer";
import { createReviewerShelfSyncAdapter } from "./reviewer-shelf-sync";
import { resolveShelfQuoteRefs } from "./shelf-resolution";
import { renderResolvedMarkdown } from "./renderer/export-renderer";
import type { OpenBdBookMetadata } from "./reviewer-shelf-reconciliation";

const ISBN = "9780306406157";
const REVIEWER_ANNOTATION_UUID = "123e4567-e89b-42d3-a456-426614174000";
const BOOK_TITLE = "『日本語の研究書』";
const BOOK_AUTHOR = "山田太郎";
const QUOTE = "「多様な視点から歴史を読む。」";
const PRIVATE_MEMO = "史料批判の論点";

let shelfRoot: string | undefined;

afterEach(async () => {
  vi.unstubAllGlobals();
  if (shelfRoot !== undefined) await rm(shelfRoot, { recursive: true, force: true });
  shelfRoot = undefined;
});

function opened(result: LibraryOpenResult) {
  expect(result.kind).toBe("opened");
  if (result.kind !== "opened") throw new Error("Expected the Private Shelf to open");
  return result;
}

async function createShelf(): Promise<string> {
  shelfRoot = await mkdtemp(path.join(os.tmpdir(), "maginalia-引用棚-"));
  await mkdir(shelfRoot, { recursive: true });
  await writeFile(path.join(shelfRoot, "library.json"), JSON.stringify({
    type: "library",
    version: "0.1",
    name: "日本語の引用棚",
    booksPath: "books",
    annotationsPath: "annotations"
  }), "utf8");
  return shelfRoot;
}

describe("H6R2 canonical Reviewer persistence", () => {
  it("materializes an approved quote once, survives reload and service restart, then searches and resolves its old UUID offline", async () => {
    const root = await createShelf();
    const reviewerRecord = {
      annotationId: REVIEWER_ANNOTATION_UUID,
      captureId: "capture-日本語",
      pageId: "page-日本語",
      sourcePageId: null,
      packageId: "capkg:01ARZ3NDEKTSV4RRFFQ69G5FAV",
      sourceKind: "book" as const,
      getDate: "202602011230",
      isbn13: ISBN,
      url: null,
      title: BOOK_TITLE,
      authors: [BOOK_AUTHOR],
      publisher: "青土社",
      year: 2021,
      sourceFiles: [],
      quote: QUOTE,
      pageLabel: "42",
      comment: PRIVATE_MEMO,
      reviewState: "APPROVED" as const,
      reviewedAtMs: 1_796_000_000_000
    };
    const page = { results: [reviewerRecord], total: 1, limit: 10, offset: 0 };
    const reviewerFetcher: typeof fetch = vi.fn(async () =>
      new Response(JSON.stringify(page), { status: 200 })
    );
    const metadata: OpenBdBookMetadata = {
      isbn13: ISBN,
      title: BOOK_TITLE,
      authors: [BOOK_AUTHOR],
      publisher: "青土社",
      year: 2021
    };
    const lookupMetadata = vi.fn(async () => ({ status: "ok" as const, metadata }));
    const sync = createReviewerShelfSyncAdapter({
      baseUrl: "http://127.0.0.1:43127/",
      pageLimit: 10,
      reviewerFetcher,
      lookupMetadata
    });

    const synced = await sync(root);

    expect(synced).toMatchObject({
      kind: "completed",
      materialized: 1,
      unchanged: 0,
      pending: 0,
      conflicts: 0,
      failed: 0
    });
    expect(reviewerFetcher).toHaveBeenCalledTimes(1);

    const repeated = await materializeReviewerRecords(root, [{
      annotationId: REVIEWER_ANNOTATION_UUID,
      reviewState: "APPROVED",
      packageId: "capkg:01ARZ3NDEKTSV4RRFFQ69G5FAV",
      sourceKind: "book",
      getDate: "202602011230",
      isbn13: ISBN,
      url: null,
      title: BOOK_TITLE,
      authors: [BOOK_AUTHOR],
      publisher: "青土社",
      year: 2021,
      quote: QUOTE,
      pageLabel: "42",
      comment: PRIVATE_MEMO
    }], lookupMetadata);
    expect(repeated).toMatchObject({ materialized: 0, unchanged: 1, pending: [], conflicts: 0 });

    const owner = {};
    const firstService = new LibraryService();
    const firstOpen = opened(await firstService.openPrivateShelfForOwner(owner, root));
    const firstActiveResult = firstService.getActivePrivateShelfForOwner(owner);
    expect(firstActiveResult.kind).toBe("private-shelf");
    if (firstActiveResult.kind !== "private-shelf") throw new Error("Expected the selected canonical Private Shelf");
    const canonicalBookId = firstActiveResult.entities.books[0]?.id;
    expect(canonicalBookId).toMatch(/^book:[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
    expect(firstActiveResult.records).toEqual([expect.objectContaining({
      annotationId: expect.stringMatching(/^ann:/u),
      sourceId: canonicalBookId,
      quote: QUOTE,
      privateMemo: PRIVATE_MEMO,
      title: BOOK_TITLE,
      authors: [BOOK_AUTHOR],
      page: 42
    })]);
    expect(firstActiveResult.entities).toMatchObject({
      books: [{
        id: canonicalBookId,
        version: "0.4",
        source: { kind: "book" },
        get: { date: "202602011230" },
        isbn13: ISBN,
        title: BOOK_TITLE,
        authors: [BOOK_AUTHOR],
        publisher: "青土社",
        year: 2021
      }],
      annotations: [{
        version: "0.4",
        source: { id: canonicalBookId, kind: "book" },
        get: { date: "202602011230" },
        location: { page: 42 },
        quote: QUOTE,
        deviceMetadata: { maginaliaReviewer: { annotationId: REVIEWER_ANNOTATION_UUID } }
      }]
    });
    const canonicalAnnotationId = firstActiveResult.entities.annotations[0]?.id;
    expect(canonicalAnnotationId).toMatch(/^ann:/u);

    const reloaded = opened(await firstService.reloadForOwner(owner));
    expect(reloaded.library.libraryId).toBe(firstOpen.library.libraryId);
    expect(reloaded.recordCount).toBe(1);

    const restartedService = new LibraryService();
    const restartedOwner = {};
    const reopened = opened(await restartedService.openPrivateShelfForOwner(restartedOwner, root));
    const restartedActiveResult = restartedService.getActivePrivateShelfForOwner(restartedOwner);
    expect(restartedActiveResult.kind).toBe("private-shelf");
    if (restartedActiveResult.kind !== "private-shelf") throw new Error("Expected the reopened canonical Private Shelf");
    expect(restartedActiveResult.entities).toEqual(firstActiveResult.entities);

    const forbiddenNetworkFetch = vi.fn(async () => {
      throw new Error("Canonical Shelf search and resolution must not contact Reviewer or another network service.");
    }) as typeof fetch;
    vi.stubGlobal("fetch", forbiddenNetworkFetch);

    const search = restartedService.searchForOwner(restartedOwner, reopened.library.libraryId, "多様な視点");
    expect(search).toMatchObject({
      kind: "results",
      results: [{ annotationId: canonicalAnnotationId, sourceId: canonicalBookId, title: BOOK_TITLE, authors: [BOOK_AUTHOR] }]
    });
    const inserted = restartedService.resolveQuotationForInsertForOwner(
      restartedOwner,
      reopened.library.libraryId,
      canonicalAnnotationId
    );
    expect(inserted).toMatchObject({
      kind: "resolved",
      annotationId: canonicalAnnotationId,
      sourceId: canonicalBookId,
      title: BOOK_TITLE,
      authors: [BOOK_AUTHOR],
      page: 42,
      quote: QUOTE
    });

    const oldReviewerQuoteRef = serializeQuoteRef({ quoteId: REVIEWER_ANNOTATION_UUID, mode: "normal" });
    const aliasResolution = await resolveShelfQuoteRefs(oldReviewerQuoteRef, restartedActiveResult.entities);
    expect(aliasResolution).toMatchObject({
      kind: "resolved",
      resolved: [{
        quoteRef: { quoteId: REVIEWER_ANNOTATION_UUID, mode: "normal" },
        quotation: {
          annotationId: REVIEWER_ANNOTATION_UUID,
          isbn13: ISBN,
          title: BOOK_TITLE,
          authors: [BOOK_AUTHOR],
          quote: QUOTE,
          pageLabel: "42"
        },
        source: { id: canonicalBookId }
      }],
      unresolved: []
    });
    expect(reviewerFetcher).toHaveBeenCalledTimes(1);
    expect(forbiddenNetworkFetch).not.toHaveBeenCalled();

    const exportText = `本文\n\n${oldReviewerQuoteRef}\n`;
    const exportResolution = await resolveShelfQuoteRefs(exportText, restartedActiveResult.entities);
    const exported = renderResolvedMarkdown({
      documentId: "canonical-export",
      revision: 1,
      currentText: exportText,
    }, exportResolution);
    expect(exported).toMatchObject({
      kind: "rendered",
      resolvedCount: 1,
      sourceCount: 1,
    });
    if (exported.kind === "rendered") {
      expect(exported.text).toContain(`> ${QUOTE}`);
      expect(exported.text).toContain(BOOK_TITLE);
      expect(exported.text).toContain(BOOK_AUTHOR);
      expect(exported.text).not.toContain(REVIEWER_ANNOTATION_UUID);
    }
  });

  it("keeps a current Book with contradictory source kind as a conflict", async () => {
    const root = await createShelf();
    const books = path.join(root, "books");
    await mkdir(books, { recursive: true });
    const existingBook = path.join(books, "book-01J0A1B2C3D4E5F6G7H8J9K0M1.json");
    const existingBookText = JSON.stringify({
      type: "book",
      version: "0.4",
      id: "book:01J0A1B2C3D4E5F6G7H8J9K0M1",
      source: { kind: "website" },
      get: { date: "202601011200" },
      isbn13: ISBN,
      url: "https://example.test/source",
      title: "Existing source"
    });
    await writeFile(existingBook, existingBookText, "utf8");

    const result = await materializeReviewerRecords(root, [{
      annotationId: REVIEWER_ANNOTATION_UUID,
      reviewState: "APPROVED",
      packageId: "capkg:01ARZ3NDEKTSV4RRFFQ69G5FAV",
      sourceKind: "book",
      getDate: "202602011230",
      isbn13: ISBN,
      title: BOOK_TITLE,
      authors: [BOOK_AUTHOR],
      quote: QUOTE,
      pageLabel: "42",
      comment: PRIVATE_MEMO,
    }], async () => ({
      status: "ok",
      metadata: {
        isbn13: ISBN,
        title: BOOK_TITLE,
        authors: [BOOK_AUTHOR],
      },
    }));

    expect(result).toMatchObject({ materialized: 0, unchanged: 0, conflicts: 1, pending: [] });
    await expect(import("node:fs/promises").then(({ readFile }) => readFile(existingBook, "utf8")))
      .resolves.toBe(existingBookText);
  });
});
