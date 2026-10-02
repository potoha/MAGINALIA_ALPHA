/**
 * Resolve authoring QuoteRefs from durable canonical Shelf entities.
 *
 * QuoteRef.quoteId remains opaque. It may identify the canonical Format
 * Annotation directly or use the durable Reviewer UUID alias recorded in
 * deviceMetadata.maginaliaReviewer.annotationId. The linked Format Book is
 * adapted to a provider-neutral Source without Reviewer or network access.
 */

import type { Annotation, Book } from "@maginalia/format" with { "resolution-mode": "import" };
import type { IsbnBookSource } from "@maginalia/source-core" with { "resolution-mode": "import" };
import type { QuoteRef } from "@maginalia/writing-core" with { "resolution-mode": "import" };
import type { ReviewerQuotation } from "./reviewer-ipc";
import {
  scanQuoteRefs,
  type QuoteRefOccurrence,
  type ResolvedQuoteRef,
  type ReviewerResolutionFailure,
  type ReviewerResolutionResult,
  type ReviewerResolutionSuccess,
  type UnresolvedQuoteRef
} from "./reviewer-resolution";

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

export interface CanonicalShelfEntities {
  readonly annotations: readonly Annotation[];
  readonly books: readonly Book[];
}

export type ShelfResolutionResult = ReviewerResolutionResult;

const INVALID_REQUEST: ReviewerResolutionFailure = Object.freeze({
  kind: "error",
  code: "invalid-request",
  message: "The Shelf resolution request was invalid."
});

const REVIEWER_ANNOTATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function reviewerAlias(annotation: Annotation): string | undefined {
  const deviceMetadata = annotation.deviceMetadata;
  if (!isRecord(deviceMetadata)) return undefined;
  const provenance = deviceMetadata.maginaliaReviewer;
  if (!isRecord(provenance)) return undefined;
  const annotationId = provenance.annotationId;
  return typeof annotationId === "string" && REVIEWER_ANNOTATION_UUID.test(annotationId)
    ? annotationId
    : undefined;
}

function indexBy<T>(values: readonly T[], getKey: (value: T) => string | undefined): ReadonlyMap<string, readonly T[]> {
  const mutable = new Map<string, T[]>();
  for (const value of values) {
    const key = getKey(value);
    if (key === undefined) continue;
    const matches = mutable.get(key) ?? [];
    matches.push(value);
    mutable.set(key, matches);
  }
  return mutable;
}

function indexReviewerAliases(annotations: readonly Annotation[]): ReadonlyMap<string, readonly Annotation[]> {
  return indexBy(annotations, reviewerAlias);
}

function indexCanonicalAnnotationIds(annotations: readonly Annotation[]): ReadonlyMap<string, readonly Annotation[]> {
  return indexBy(annotations, (annotation) => annotation.id);
}

function indexBooks(books: readonly Book[]): ReadonlyMap<string, Book | null> {
  const byId = new Map<string, Book | null>();
  for (const book of books) {
    byId.set(book.id, byId.has(book.id) ? null : book);
  }
  return byId;
}

function resolvedQuotation(
  quoteRef: QuoteRef,
  annotation: Annotation,
  book: Book
): ReviewerQuotation {
  return Object.freeze({
    // Keep the identity that the authoring document actually stores. The
    // canonical Shelf annotation ID is available on the resolved source data.
    annotationId: quoteRef.quoteId,
    // Capture and page IDs belong to Reviewer and have no canonical Shelf
    // equivalent, so do not invent values or expose machine-local details.
    captureId: "",
    pageId: "",
    sourcePageId: null,
    isbn13: book.isbn13,
    title: book.title,
    authors: Object.freeze([...book.authors]),
    quote: annotation.quote,
    pageLabel: annotation.location.page === undefined
      ? annotation.location.path ?? ""
      : String(annotation.location.page),
    comment: "",
    reviewState: "CANONICAL",
    reviewedAtMs: null
  });
}

function success(
  sources: readonly IsbnBookSource[],
  resolved: readonly ResolvedQuoteRef[],
  unresolved: readonly UnresolvedQuoteRef[]
): ReviewerResolutionSuccess {
  return Object.freeze({
    kind: "resolved",
    sources: Object.freeze([...sources]),
    resolved: Object.freeze([...resolved]),
    unresolved: Object.freeze([...unresolved].sort((left, right) => left.occurrence.offset - right.occurrence.offset))
  });
}

/**
 * Resolve QuoteRefs against already-loaded canonical Library entities.
 *
 * The result is deterministic for the supplied snapshot and can be recomputed
 * after an app restart without contacting Reviewer or performing publication
 * lookup. Duplicate aliases or Book IDs stay unresolved instead of selecting
 * an arbitrary entity.
 */
export async function resolveShelfQuoteRefs(
  documentText: unknown,
  entities: CanonicalShelfEntities
): Promise<ShelfResolutionResult> {
  if (typeof documentText !== "string"
    || entities === null
    || typeof entities !== "object"
    || !Array.isArray(entities.annotations)
    || !Array.isArray(entities.books)) {
    return INVALID_REQUEST;
  }

  const writingCore = await loadWritingCore();
  const occurrences = scanQuoteRefs(documentText, writingCore.parseQuoteRef);
  const validOccurrences = occurrences.filter(
    (occurrence): occurrence is QuoteRefOccurrence & { readonly quoteRef: QuoteRef } => occurrence.quoteRef !== null
  );
  const unresolved: UnresolvedQuoteRef[] = occurrences
    .filter((occurrence) => occurrence.quoteRef === null)
    .map((occurrence) => ({ occurrence, quoteRef: null, code: "malformed-marker" }));

  if (validOccurrences.length === 0) return success([], [], unresolved);

  const canonicalAnnotationIds = indexCanonicalAnnotationIds(entities.annotations);
  const aliases = indexReviewerAliases(entities.annotations);
  const books = indexBooks(entities.books);
  const sourceCore = await loadSourceCore();
  const sourcesById = new Map<string, IsbnBookSource>();
  const resolved: ResolvedQuoteRef[] = [];

  for (const occurrence of validOccurrences) {
    const quoteRef = occurrence.quoteRef;
    const canonicalMatches = canonicalAnnotationIds.get(quoteRef.quoteId);
    const matches = canonicalMatches ?? aliases.get(quoteRef.quoteId);
    if (matches === undefined || matches.length !== 1) {
      // Missing IDs and ambiguous aliases share the existing unresolved
      // result code. The resolver never chooses an arbitrary annotation.
      unresolved.push({ occurrence, quoteRef, code: "quote-not-found" });
      continue;
    }

    const annotation = matches[0];
    const book = books.get(annotation.source);
    if (book === undefined || book === null) {
      unresolved.push({ occurrence, quoteRef, code: "quote-not-found" });
      continue;
    }
    // The canonical Format Book ID is an ISBN identity. A mismatched ISBN
    // field must not redirect an Annotation to a different Source identity.
    if (book.id !== `isbn:${book.isbn13}`) {
      unresolved.push({ occurrence, quoteRef, code: "isbn-invalid" });
      continue;
    }

    const source = sourceCore.adaptBookSource({
      isbn13: book.isbn13,
      title: book.title,
      authors: book.authors,
      publisher: book.publisher,
      publishedDate: book.year === undefined ? undefined : String(book.year),
      metadata: { maginaliaBookId: book.id }
    });
    if (source === undefined) {
      unresolved.push({ occurrence, quoteRef, code: "isbn-invalid" });
      continue;
    }

    sourcesById.set(source.id, source);
    resolved.push(Object.freeze({
      occurrence,
      quoteRef,
      quotation: resolvedQuotation(quoteRef, annotation, book),
      source
    }));
  }

  return success([...sourcesById.values()], resolved, unresolved);
}
