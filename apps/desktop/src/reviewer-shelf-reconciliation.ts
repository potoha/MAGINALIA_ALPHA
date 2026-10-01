/**
 * Pure projection from an approved Reviewer search record to Format v0.1
 * Book/Annotation candidates. This module does not read or write Shelf files.
 */

import { createHash } from "node:crypto";
import {
  FORMAT_VERSION,
  generateEntityId,
  validateEntity,
  type Annotation,
  type Book
} from "@maginalia/format";
import { normalizeIsbn13 } from "@maginalia/source-core";

export const REVIEWER_SHELF_PROVENANCE_VERSION = 1 as const;

/** Raw approved Reviewer fields consumed at this explicit import boundary. */
export interface ApprovedReviewerRecord {
  readonly annotationId: string;
  readonly reviewState: "APPROVED";
  readonly isbn13: string;
  readonly quote: string;
  readonly pageLabel: string;
  readonly comment: string;
}

/** openBD metadata is supplied separately; it is never fetched by this module. */
export interface OpenBdBookMetadata {
  readonly isbn13: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly publisher?: string | null;
  readonly year?: number | null;
}

export type ReviewerReconciliationPendingCode =
  | "invalid-reviewer-record"
  | "reviewer-not-approved"
  | "invalid-reviewer-annotation-id"
  | "invalid-isbn13"
  | "openbd-metadata-missing"
  | "openbd-isbn-mismatch"
  | "invalid-openbd-title"
  | "invalid-openbd-authors"
  | "invalid-openbd-publisher"
  | "invalid-openbd-year"
  | "pending-location"
  | "invalid-format-candidate"
  | "invalid-generated-annotation-id";

export interface ReviewerReconciliationPending {
  readonly kind: "pending";
  readonly code: ReviewerReconciliationPendingCode;
  readonly reviewerAnnotationId?: string;
  readonly digest?: string;
  /** Preserves a nonnumeric label for an explicit later locator decision. */
  readonly pageLabel?: string;
}

export type AnnotationDraft = Omit<Annotation, "id">;

/**
 * A deterministic, non-materialized candidate. An ann:ULID is deliberately
 * absent until materializeReviewerReconciliationCandidate is called.
 */
export interface ReviewerReconciliationCandidate {
  readonly kind: "candidate";
  readonly digest: string;
  readonly reviewerAnnotationId: string;
  readonly book: Book;
  readonly annotation: AnnotationDraft;
}

export type ReviewerReconciliationResult =
  | ReviewerReconciliationPending
  | ReviewerReconciliationCandidate;

export interface MaterializedReviewerReconciliation {
  readonly kind: "materialized";
  readonly book: Book;
  readonly annotation: Annotation;
}

export type ReviewerMaterializationResult =
  | MaterializedReviewerReconciliation
  | ReviewerReconciliationPending;

export type AnnotationIdGenerator = () => string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pending(
  code: ReviewerReconciliationPendingCode,
  details: Partial<Pick<ReviewerReconciliationPending, "reviewerAnnotationId" | "digest" | "pageLabel">> = {}
): ReviewerReconciliationPending {
  return Object.freeze({ kind: "pending", code, ...details });
}

function isUuid(value: string): boolean {
  // Check the UUID wire shape without deriving or rewriting its identity.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

function reviewerDigest(record: ApprovedReviewerRecord): string {
  // Fixed property order makes the digest independent of input object key order.
  // Only fields used by this projection participate; unrelated Reviewer API
  // fields cannot silently alter reconciliation identity.
  const canonicalRecord = JSON.stringify({
    annotationId: record.annotationId,
    comment: record.comment,
    isbn13: record.isbn13,
    pageLabel: record.pageLabel,
    quote: record.quote,
    reviewState: record.reviewState
  });
  return `sha256:${createHash("sha256").update(canonicalRecord, "utf8").digest("hex")}`;
}

function parseApprovedReviewerRecord(value: unknown): ApprovedReviewerRecord | ReviewerReconciliationPending {
  if (!isRecord(value)) return pending("invalid-reviewer-record");
  if (value.reviewState !== "APPROVED") return pending("reviewer-not-approved");
  if (typeof value.annotationId !== "string" || !isUuid(value.annotationId)) {
    return pending("invalid-reviewer-annotation-id");
  }
  if (typeof value.isbn13 !== "string" || normalizeIsbn13(value.isbn13) === undefined) {
    return pending("invalid-isbn13", { reviewerAnnotationId: value.annotationId });
  }
  if (typeof value.quote !== "string" || value.quote.length === 0
    || typeof value.pageLabel !== "string" || typeof value.comment !== "string") {
    return pending("invalid-reviewer-record", { reviewerAnnotationId: value.annotationId });
  }

  return Object.freeze({
    annotationId: value.annotationId,
    reviewState: "APPROVED",
    isbn13: value.isbn13,
    quote: value.quote,
    pageLabel: value.pageLabel,
    comment: value.comment
  });
}

function positiveIntegerPage(pageLabel: string): number | undefined {
  // Do not trim, Unicode-normalize, or coerce labels such as "42a", "四十二",
  // or " 42" into a numeric page.
  if (!/^[1-9][0-9]*$/u.test(pageLabel)) return undefined;
  const page = Number(pageLabel);
  return Number.isSafeInteger(page) && page > 0 ? page : undefined;
}

type ParsedOpenBdMetadata = Pick<Book, "title" | "authors"> & Partial<Pick<Book, "publisher" | "year">>;

function parseOpenBdMetadata(
  value: unknown,
  isbn13: string,
  annotationId: string,
  digest: string
): ParsedOpenBdMetadata | ReviewerReconciliationPending {
  if (!isRecord(value)) {
    return pending("openbd-metadata-missing", { reviewerAnnotationId: annotationId, digest });
  }
  if (typeof value.isbn13 !== "string" || normalizeIsbn13(value.isbn13) === undefined
    || value.isbn13 !== isbn13) {
    return pending("openbd-isbn-mismatch", { reviewerAnnotationId: annotationId, digest });
  }
  if (typeof value.title !== "string" || value.title.trim().length === 0) {
    return pending("invalid-openbd-title", { reviewerAnnotationId: annotationId, digest });
  }
  if (!Array.isArray(value.authors) || value.authors.length === 0
    || !value.authors.every((author) => typeof author === "string" && author.trim().length > 0)) {
    return pending("invalid-openbd-authors", { reviewerAnnotationId: annotationId, digest });
  }

  let publisher: string | undefined;
  if (value.publisher !== undefined && value.publisher !== null) {
    if (typeof value.publisher !== "string" || value.publisher.trim().length === 0) {
      return pending("invalid-openbd-publisher", { reviewerAnnotationId: annotationId, digest });
    }
    publisher = value.publisher;
  }

  let year: number | undefined;
  if (value.year !== undefined && value.year !== null) {
    if (typeof value.year !== "number" || !Number.isInteger(value.year) || value.year < 0) {
      return pending("invalid-openbd-year", { reviewerAnnotationId: annotationId, digest });
    }
    year = value.year;
  }

  return Object.freeze({
    title: value.title,
    authors: Object.freeze([...value.authors]) as string[],
    ...(publisher === undefined ? {} : { publisher }),
    ...(year === undefined ? {} : { year })
  });
}

/**
 * Validate and project one approved Reviewer record plus its supplied openBD
 * metadata. No Shelf storage or network access occurs here.
 */
export function createReviewerReconciliationCandidate(
  reviewerRecord: unknown,
  openBdMetadata: unknown
): ReviewerReconciliationResult {
  const record = parseApprovedReviewerRecord(reviewerRecord);
  if ("kind" in record) return record;

  const digest = reviewerDigest(record);
  const details = { reviewerAnnotationId: record.annotationId, digest };
  const metadata = parseOpenBdMetadata(openBdMetadata, record.isbn13, record.annotationId, digest);
  if ("kind" in metadata) return metadata;

  const page = positiveIntegerPage(record.pageLabel);
  if (page === undefined) {
    return pending("pending-location", { ...details, pageLabel: record.pageLabel });
  }

  const book: Book = Object.freeze({
    type: "book",
    version: FORMAT_VERSION,
    id: `isbn:${record.isbn13}`,
    isbn13: record.isbn13,
    title: metadata.title,
    authors: Object.freeze([...metadata.authors]) as unknown as string[],
    ...(metadata.publisher === undefined ? {} : { publisher: metadata.publisher }),
    ...(metadata.year === undefined ? {} : { year: metadata.year })
  });
  const bookValidation = validateEntity("book", book);
  if (!bookValidation.valid) return pending("invalid-format-candidate", details);

  const reviewerProvenance = Object.freeze({
    version: REVIEWER_SHELF_PROVENANCE_VERSION,
    annotationId: record.annotationId,
    digest
  });
  const annotation: AnnotationDraft = Object.freeze({
    type: "annotation",
    version: FORMAT_VERSION,
    source: `isbn:${record.isbn13}`,
    location: Object.freeze({ page }),
    quote: record.quote,
    ...(record.comment.length === 0 ? {} : { privateMemo: record.comment }),
    deviceMetadata: Object.freeze({ maginaliaReviewer: reviewerProvenance })
  });

  return Object.freeze({
    kind: "candidate",
    digest,
    reviewerAnnotationId: record.annotationId,
    book: bookValidation.value,
    annotation
  });
}

/**
 * Assign the Format ann:ULID exactly when a caller first materializes a
 * candidate. The generated ID is checked against the canonical Format schema.
 */
export function materializeReviewerReconciliationCandidate(
  candidate: ReviewerReconciliationCandidate,
  generateAnnotationId: AnnotationIdGenerator = () => generateEntityId("ann")
): ReviewerMaterializationResult {
  let id: string;
  try {
    id = generateAnnotationId();
  } catch {
    return pending("invalid-generated-annotation-id", {
      reviewerAnnotationId: candidate.reviewerAnnotationId,
      digest: candidate.digest
    });
  }

  const annotation = { ...candidate.annotation, id } as Annotation;
  const bookValidation = validateEntity("book", candidate.book);
  const annotationValidation = validateEntity("annotation", annotation);
  if (!bookValidation.valid || !annotationValidation.valid) {
    return pending("invalid-generated-annotation-id", {
      reviewerAnnotationId: candidate.reviewerAnnotationId,
      digest: candidate.digest
    });
  }

  return Object.freeze({
    kind: "materialized",
    book: bookValidation.value,
    annotation: annotationValidation.value
  });
}
