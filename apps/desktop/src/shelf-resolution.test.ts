import { afterEach, describe, expect, it, vi } from "vitest";
import type { Annotation, Book } from "@maginalia/format";
import { serializeQuoteRef } from "@maginalia/writing-core";
import { resolveShelfQuoteRefs, type CanonicalShelfEntities } from "./shelf-resolution";

const ISBN = "9780306406157";
const REVIEWER_ANNOTATION_UUID = "123e4567-e89b-42d3-a456-426614174000";
const SECOND_REVIEWER_ANNOTATION_UUID = "123e4567-e89b-42d3-a456-426614174001";
const ANNOTATION_ID = "ann:01J0A1B2C3D4E5F6G7H8J9K0M1";
const SECOND_ANNOTATION_ID = "ann:01J0A1B2C3D4E5F6G7H8J9K0M2";

function book(overrides: Partial<Book> = {}): Book {
  return {
    type: "book",
    version: "0.1",
    id: `isbn:${ISBN}`,
    isbn13: ISBN,
    title: "『開かれた作品』",
    authors: ["ウンベルト・エーコ"],
    publisher: "青土社",
    year: 1990,
    ...overrides
  };
}

function annotation(
  reviewerAnnotationId: string,
  overrides: Partial<Annotation> = {}
): Annotation {
  return {
    type: "annotation",
    version: "0.1",
    id: ANNOTATION_ID,
    source: `isbn:${ISBN}`,
    location: { page: 42 },
    quote: "「引用の本文」\r\nそのまま保存する。",
    deviceMetadata: {
      maginaliaReviewer: {
        version: 1,
        annotationId: reviewerAnnotationId,
        digest: "sha256:0123456789abcdef"
      }
    },
    ...overrides
  };
}

function marker(quoteId: string): string {
  return serializeQuoteRef({ quoteId, mode: "normal" });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("canonical Shelf QuoteRef resolution", () => {
  it("resolves canonical ann IDs and unique durable Reviewer UUID aliases offline", async () => {
    const entities: CanonicalShelfEntities = {
      annotations: [annotation(REVIEWER_ANNOTATION_UUID)],
      books: [book()]
    };
    const fetcher = vi.fn(() => {
      throw new Error("Canonical Shelf resolution must not access the network.");
    });
    vi.stubGlobal("fetch", fetcher);

    for (const quoteId of [ANNOTATION_ID, REVIEWER_ANNOTATION_UUID]) {
      const result = await resolveShelfQuoteRefs(`前文\n${marker(quoteId)}\n後文`, entities);

      expect(result.kind).toBe("resolved");
      if (result.kind !== "resolved") continue;
      expect(result).toMatchObject({
        kind: "resolved",
        sources: [{
          id: `book:isbn13:${ISBN}`,
          type: "book",
          title: "『開かれた作品』",
          authors: ["ウンベルト・エーコ"],
          publisher: "青土社",
          publishedDate: "1990",
          identifiers: { isbn13: ISBN },
          metadata: { maginaliaBookId: `isbn:${ISBN}` }
        }],
        resolved: [{
          quoteRef: { quoteId, mode: "normal" },
          quotation: {
            annotationId: quoteId,
            isbn13: ISBN,
            title: "『開かれた作品』",
            authors: ["ウンベルト・エーコ"],
            quote: "「引用の本文」\r\nそのまま保存する。",
            pageLabel: "42"
          },
          source: { id: `book:isbn13:${ISBN}` }
        }],
        unresolved: []
      });
      expect(result.resolved[0]?.quotation).toMatchObject({
        captureId: "",
        pageId: "",
        sourcePageId: null,
        comment: "",
        reviewState: "CANONICAL",
        reviewedAtMs: null
      });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps a missing or ambiguous durable alias unresolved", async () => {
    const missing = await resolveShelfQuoteRefs(marker(REVIEWER_ANNOTATION_UUID), {
      annotations: [annotation(SECOND_REVIEWER_ANNOTATION_UUID)],
      books: [book()]
    });
    expect(missing).toMatchObject({
      kind: "resolved",
      resolved: [],
      unresolved: [{ code: "quote-not-found" }]
    });

    const ambiguous = await resolveShelfQuoteRefs(marker(REVIEWER_ANNOTATION_UUID), {
      annotations: [
        annotation(REVIEWER_ANNOTATION_UUID),
        annotation(REVIEWER_ANNOTATION_UUID, { id: SECOND_ANNOTATION_ID })
      ],
      books: [book()]
    });
    expect(ambiguous).toMatchObject({
      kind: "resolved",
      resolved: [],
      unresolved: [{ quoteRef: { quoteId: REVIEWER_ANNOTATION_UUID }, code: "quote-not-found" }]
    });
  });

  it("keeps absent or invalid canonical Books unresolved", async () => {
    const absent = await resolveShelfQuoteRefs(marker(REVIEWER_ANNOTATION_UUID), {
      annotations: [annotation(REVIEWER_ANNOTATION_UUID)],
      books: []
    });
    expect(absent).toMatchObject({
      kind: "resolved",
      resolved: [],
      unresolved: [{ code: "quote-not-found" }]
    });

    const invalid = await resolveShelfQuoteRefs(marker(REVIEWER_ANNOTATION_UUID), {
      annotations: [annotation(REVIEWER_ANNOTATION_UUID)],
      books: [book({ isbn13: "9780306406158" })]
    });
    expect(invalid).toMatchObject({
      kind: "resolved",
      resolved: [],
      unresolved: [{ code: "isbn-invalid" }]
    });
  });

  it("reports malformed markers and performs repeated resolution without any network request", async () => {
    const fetcher = vi.fn(() => {
      throw new Error("Network access must not be used for canonical Shelf resolution.");
    });
    vi.stubGlobal("fetch", fetcher);
    const entities = {
      annotations: [annotation(REVIEWER_ANNOTATION_UUID)],
      books: [book()]
    };
    const text = `${marker(REVIEWER_ANNOTATION_UUID)}\n<!-- maginalia:quote-ref v1 not-json -->`;

    const first = await resolveShelfQuoteRefs(text, entities);
    const afterRestart = await resolveShelfQuoteRefs(text, entities);

    expect(first).toMatchObject({
      kind: "resolved",
      resolved: [{ quoteRef: { quoteId: REVIEWER_ANNOTATION_UUID } }],
      unresolved: [{ quoteRef: null, code: "malformed-marker" }]
    });
    expect(afterRestart).toEqual(first);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
