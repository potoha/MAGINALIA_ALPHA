/**
 * Main-process-only resolution of authoring QuoteRefs to provider-neutral
 * Sources.
 *
 * The authoring document contains only an opaque Reviewer annotation id.  The
 * Reviewer API has no annotation-id lookup endpoint, so an explicit refresh
 * walks the APPROVED empty-query search result pages, then fetches publication
 * metadata for each distinct ISBN.  No result from this module mutates the
 * Markdown document; callers decide whether a successful derived result can
 * be applied.
 */

import type {
  BookSourceInput,
  IsbnBookSource,
  Source
} from "@maginalia/source-core" with { "resolution-mode": "import" };
import type { QuoteRef } from "@maginalia/writing-core" with { "resolution-mode": "import" };
import {
  normalizeReviewerSearchResponse,
  parseReviewerBaseUrl,
  type ReviewerQuotation
} from "./reviewer-ipc";

export const REVIEWER_RESOLUTION_SEARCH_LIMIT = 100;
export const MAX_REVIEWER_RESOLUTION_PAGES = 1_001;

const QUOTE_REF_MARKER_PREFIX = "<!-- maginalia:quote-ref ";
const MARKER_TERMINATOR = "-->";

type SourceCore = typeof import("@maginalia/source-core", { with: { "resolution-mode": "import" } });
type WritingCore = typeof import("@maginalia/writing-core", { with: { "resolution-mode": "import" } });

let sourceCorePromise: Promise<SourceCore> | undefined;
let writingCorePromise: Promise<WritingCore> | undefined;

async function loadSourceCore(): Promise<SourceCore> {
  sourceCorePromise ??= import("@maginalia/source-core");
  return sourceCorePromise;
}

async function loadWritingCore(): Promise<WritingCore> {
  writingCorePromise ??= import("@maginalia/writing-core");
  return writingCorePromise;
}

/** One marker occurrence in the source document, including malformed ones. */
export interface QuoteRefOccurrence {
  readonly offset: number;
  readonly marker: string;
  readonly quoteRef: QuoteRef | null;
}

/** Scan only QuoteRef-looking markers; all other Markdown is left untouched. */
export function scanQuoteRefs(
  documentText: string,
  parse: (marker: string) => QuoteRef | null
): readonly QuoteRefOccurrence[] {
  if (typeof documentText !== "string" || documentText.length === 0) return [];

  const occurrences: QuoteRefOccurrence[] = [];
  let cursor = 0;
  while (cursor < documentText.length) {
    const offset = documentText.indexOf(QUOTE_REF_MARKER_PREFIX, cursor);
    if (offset < 0) break;
    const terminator = documentText.indexOf(MARKER_TERMINATOR, offset + QUOTE_REF_MARKER_PREFIX.length);
    const end = terminator < 0 ? documentText.length : terminator + MARKER_TERMINATOR.length;
    const marker = documentText.slice(offset, end);
    occurrences.push(Object.freeze({
      offset,
      marker,
      quoteRef: parse(marker)
    }));
    cursor = end;
  }
  return Object.freeze(occurrences);
}

export type QuoteRefUnresolvedCode =
  | "malformed-marker"
  | "quote-not-found"
  | "isbn-absent"
  | "isbn-invalid"
  | "publication-unavailable"
  | "publication-malformed"
  | "publication-mismatch";

export interface ResolvedQuoteRef {
  readonly occurrence: QuoteRefOccurrence;
  readonly quoteRef: QuoteRef;
  readonly quotation: ReviewerQuotation;
  readonly source: Source;
}

export interface UnresolvedQuoteRef {
  readonly occurrence: QuoteRefOccurrence;
  readonly quoteRef: QuoteRef | null;
  readonly code: QuoteRefUnresolvedCode;
}

export interface ReviewerResolutionSuccess {
  readonly kind: "resolved";
  readonly sources: readonly Source[];
  readonly resolved: readonly ResolvedQuoteRef[];
  readonly unresolved: readonly UnresolvedQuoteRef[];
}

export type ReviewerResolutionFailureCode =
  | "invalid-request"
  | "reviewer-unavailable"
  | "reviewer-error"
  | "reviewer-invalid-response"
  | "pagination-inconsistent";

export interface ReviewerResolutionFailure {
  readonly kind: "error";
  readonly code: ReviewerResolutionFailureCode;
  readonly message: string;
}

export type ReviewerResolutionResult = ReviewerResolutionSuccess | ReviewerResolutionFailure;

export interface ReviewerResolutionAdapterOptions {
  /** Main-process configuration only; never comes from renderer input. */
  readonly baseUrl?: string;
  /**
   * Main-process-only lazy locator for the managed Reviewer. It is invoked
   * only after the document is known to contain a valid QuoteRef, so ordinary
   * Markdown export remains independent of the sidecar.
   */
  readonly getBaseUrl?: () => string | URL | null | Promise<string | URL | null>;
  readonly fetcher?: typeof fetch;
}

interface SearchPage {
  readonly results: readonly ReviewerQuotation[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

interface PublicationSource {
  readonly kind: "source";
  readonly source: IsbnBookSource;
}

interface PublicationUnresolved {
  readonly kind: "unresolved";
  readonly code: "publication-unavailable" | "publication-malformed" | "publication-mismatch";
}

interface PublicationTransportFailure {
  readonly kind: "failure";
  readonly code: ReviewerResolutionFailureCode;
  readonly message: string;
}

type PublicationLookup = PublicationSource | PublicationUnresolved | PublicationTransportFailure;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function failure(code: ReviewerResolutionFailureCode, message: string): ReviewerResolutionFailure {
  return Object.freeze({ kind: "error", code, message });
}

function isFiniteSafeInteger(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0;
}

function isOptionalText(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

function isOptionalStringOrNull(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function isReviewerQuotationShape(value: unknown): boolean {
  if (!isPlainRecord(value)
    || typeof value.annotationId !== "string"
    || value.annotationId.length === 0
    || typeof value.captureId !== "string"
    || value.captureId.length === 0
    || typeof value.pageId !== "string"
    || value.pageId.length === 0
    || !isOptionalStringOrNull(value.sourcePageId)
    || !isOptionalStringOrNull(value.isbn13)
    || !isOptionalStringOrNull(value.title)
    || !Array.isArray(value.authors)
    || !value.authors.every((author): author is string => typeof author === "string")
    || typeof value.quote !== "string"
    || value.quote.length === 0
    || typeof value.pageLabel !== "string"
    || typeof value.comment !== "string"
    || typeof value.reviewState !== "string") {
    return false;
  }
  return value.reviewedAtMs === undefined
    || value.reviewedAtMs === null
    || (typeof value.reviewedAtMs === "number" && Number.isFinite(value.reviewedAtMs));
}

function normalizeSearchPage(value: unknown, expectedOffset: number): SearchPage | null {
  if (!isPlainRecord(value)
    || !Array.isArray(value.results)
    || !isFiniteSafeInteger(value.total)
    || !isFiniteSafeInteger(value.limit)
    || !isFiniteSafeInteger(value.offset)
    || value.limit !== REVIEWER_RESOLUTION_SEARCH_LIMIT
    || value.offset !== expectedOffset) {
    return null;
  }
  if (!value.results.every((result) => isReviewerQuotationShape(result))) return null;
  const normalized = normalizeReviewerSearchResponse(value);
  if (normalized === null
    || normalized.total !== value.total
    || normalized.results.length > REVIEWER_RESOLUTION_SEARCH_LIMIT
    || value.offset + normalized.results.length > value.total) {
    return null;
  }
  return Object.freeze({
    results: normalized.results,
    total: value.total,
    limit: value.limit,
    offset: value.offset
  });
}

function mapPublicationBook(
  value: unknown,
  requestedIsbn: string,
  sourceCore: SourceCore
): PublicationSource | PublicationUnresolved {
  if (!isPlainRecord(value)
    || value.schemaVersion !== 1
    || !isPlainRecord(value.book)) {
    return { kind: "unresolved", code: "publication-malformed" };
  }

  const book = value.book;
  if (typeof book.isbn13 !== "string") {
    return { kind: "unresolved", code: "publication-malformed" };
  }
  const publicationIsbn = sourceCore.normalizeIsbn13(book.isbn13);
  if (publicationIsbn === undefined) {
    return { kind: "unresolved", code: "publication-malformed" };
  }
  if (publicationIsbn !== requestedIsbn) {
    return { kind: "unresolved", code: "publication-mismatch" };
  }

  if (!isOptionalText(book.title)
    || !isOptionalText(book.publisher)
    || !isOptionalText(book.publishedDate)) {
    return { kind: "unresolved", code: "publication-malformed" };
  }
  if (!Array.isArray(book.authors)
    || !book.authors.every((author): author is string => typeof author === "string")) {
    return { kind: "unresolved", code: "publication-malformed" };
  }

  // This is intentionally an allowlist.  Reviewer provenance, cover, TOC,
  // subtitle and other provider fields must not leak into Source Core.
  const input: BookSourceInput = {
    isbn13: publicationIsbn,
    title: book.title,
    authors: book.authors,
    publisher: book.publisher,
    publishedDate: book.publishedDate
  };
  const source = sourceCore.adaptBookSource(input);
  return source === undefined
    ? { kind: "unresolved", code: "publication-malformed" }
    : { kind: "source", source };
}

function reviewerEndpoint(baseUrl: URL, path: string): URL {
  return new URL(path, baseUrl);
}

/**
 * Build the main-process Reviewer resolver.  It owns all network access and
 * accepts only document text at call time; renderer callers cannot select a
 * URL, port, database path, or arbitrary endpoint.
 */
export function createReviewerResolutionAdapter(
  options: ReviewerResolutionAdapterOptions = {}
): (documentText: string) => Promise<ReviewerResolutionResult> {
  const configuredBaseUrl = parseReviewerBaseUrl(options.baseUrl);
  const fetcher = options.fetcher ?? fetch;

  return async (documentText: string): Promise<ReviewerResolutionResult> => {
    const [writingCore, sourceCore] = await Promise.all([loadWritingCore(), loadSourceCore()]);
    const occurrences = scanQuoteRefs(documentText, writingCore.parseQuoteRef);
    const validOccurrences = occurrences.filter(
      (occurrence): occurrence is QuoteRefOccurrence & { readonly quoteRef: QuoteRef } => occurrence.quoteRef !== null
    );
    const unresolvedMalformed: UnresolvedQuoteRef[] = occurrences
      .filter((occurrence) => occurrence.quoteRef === null)
      .map((occurrence) => ({
        occurrence,
        quoteRef: null,
        code: "malformed-marker" as const
      }));

    if (validOccurrences.length === 0) {
      return Object.freeze({
        kind: "resolved",
        sources: Object.freeze([]),
        resolved: Object.freeze([]),
        unresolved: Object.freeze(unresolvedMalformed)
      });
    }
    let baseUrl = configuredBaseUrl;
    if (baseUrl === null && options.getBaseUrl !== undefined) {
      try {
        const resolved = await options.getBaseUrl();
        baseUrl = parseReviewerBaseUrl(resolved instanceof URL ? resolved.href : resolved ?? undefined);
      } catch {
        return failure("reviewer-unavailable", "Reviewer unavailable. Try again from Shelf Review.");
      }
    }
    if (baseUrl === null) return failure(
      "reviewer-unavailable",
      "Reviewer unavailable. Try again from Shelf Review."
    );

    const wantedIds = new Set(validOccurrences.map((occurrence) => occurrence.quoteRef.quoteId));
    const quotations = new Map<string, ReviewerQuotation>();
    let expectedOffset = 0;
    let expectedTotal: number | undefined;
    let pageCount = 0;

    while (quotations.size < wantedIds.size) {
      if (pageCount >= MAX_REVIEWER_RESOLUTION_PAGES) {
        return failure("pagination-inconsistent", "Reviewer search pagination exceeded its safe limit.");
      }
      const endpoint = reviewerEndpoint(baseUrl, "api/search");
      endpoint.searchParams.set("q", "");
      endpoint.searchParams.set("status", "APPROVED");
      endpoint.searchParams.set("limit", String(REVIEWER_RESOLUTION_SEARCH_LIMIT));
      endpoint.searchParams.set("offset", String(expectedOffset));

      let response: Response;
      try {
        response = await fetcher(endpoint, { method: "GET", redirect: "error" });
      } catch (_error: unknown) {
        return failure("reviewer-unavailable", "Reviewer unavailable. Try again from Shelf Review.");
      }
      if (!response.ok) {
        return failure("reviewer-error", `Reviewer search failed (${response.status}).`);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (_error: unknown) {
        return failure("reviewer-invalid-response", "Reviewer returned an invalid search response.");
      }
      const page = normalizeSearchPage(body, expectedOffset);
      if (page === null || (expectedTotal !== undefined && page.total !== expectedTotal)) {
        return failure("pagination-inconsistent", "Reviewer search pagination was inconsistent.");
      }
      expectedTotal = page.total;
      pageCount += 1;
      for (const quotation of page.results) {
        if (wantedIds.has(quotation.annotationId) && !quotations.has(quotation.annotationId)) {
          quotations.set(quotation.annotationId, quotation);
        }
      }
      const nextOffset = page.offset + page.results.length;
      // Validate page shape before accepting even an otherwise-complete match;
      // a short non-final page can hide skipped records and must fail refresh.
      if (nextOffset < page.total && page.results.length !== page.limit) {
        return failure("pagination-inconsistent", "Reviewer search returned a short non-final page.");
      }
      if (quotations.size >= wantedIds.size) break;
      if (page.total === 0 || nextOffset >= page.total) break;
      expectedOffset += page.limit;
    }

    const resolved: ResolvedQuoteRef[] = [];
    const unresolved: UnresolvedQuoteRef[] = [...unresolvedMalformed];
    const sourceById = new Map<string, IsbnBookSource>();
    const publicationByIsbn = new Map<string, Promise<PublicationLookup>>();

    const getPublication = (isbn13: string): Promise<PublicationLookup> => {
      const existing = publicationByIsbn.get(isbn13);
      if (existing !== undefined) return existing;
      const lookup = (async (): Promise<PublicationLookup> => {
        const endpoint = reviewerEndpoint(baseUrl, `api/books/${encodeURIComponent(isbn13)}/publication`);
        let response: Response;
        try {
          response = await fetcher(endpoint, { method: "GET", redirect: "error" });
        } catch (_error: unknown) {
          return {
            kind: "failure",
            code: "reviewer-unavailable",
            message: "Reviewer unavailable. Try again from Shelf Review."
          };
        }
        if (response.status === 404) return { kind: "unresolved", code: "publication-unavailable" };
        if (!response.ok) {
          return {
            kind: "failure",
            code: "reviewer-error",
            message: `Reviewer publication lookup failed (${response.status}).`
          };
        }
        let body: unknown;
        try {
          body = await response.json();
        } catch (_error: unknown) {
          return { kind: "unresolved", code: "publication-malformed" };
        }
        return mapPublicationBook(body, isbn13, sourceCore);
      })();
      publicationByIsbn.set(isbn13, lookup);
      return lookup;
    };

    for (const occurrence of validOccurrences) {
      const quoteRef = occurrence.quoteRef;
      const quotation = quotations.get(quoteRef.quoteId);
      if (quotation === undefined) {
        unresolved.push({ occurrence, quoteRef, code: "quote-not-found" });
        continue;
      }
      if (quotation.isbn13 === null || quotation.isbn13.trim().length === 0) {
        unresolved.push({ occurrence, quoteRef, code: "isbn-absent" });
        continue;
      }
      const isbn13 = sourceCore.normalizeIsbn13(quotation.isbn13);
      if (isbn13 === undefined) {
        unresolved.push({ occurrence, quoteRef, code: "isbn-invalid" });
        continue;
      }
      const publication = await getPublication(isbn13);
      if (publication.kind === "failure") return failure(publication.code, publication.message);
      if (publication.kind === "unresolved") {
        unresolved.push({ occurrence, quoteRef, code: publication.code });
        continue;
      }
      const source = publication.source;
      sourceById.set(source.id, source);
      resolved.push({ occurrence, quoteRef, quotation, source });
    }

    unresolved.sort((left, right) => left.occurrence.offset - right.occurrence.offset);
    return Object.freeze({
      kind: "resolved",
      sources: Object.freeze([...sourceById.values()]),
      resolved: Object.freeze(resolved),
      unresolved: Object.freeze(unresolved)
    });
  };
}
