/**
 * Validated projection from an approved Reviewer quotation to Shelf v0.4.
 * Reviewer remains the workflow authority; this module carries the package
 * provenance needed by the main-process Shelf writer without doing I/O.
 */
import { createHash } from "node:crypto";
import type {
  ShelfAnnotationV04,
  ShelfBookV04,
  ShelfSourceFileV04,
  ShelfSourceKind
} from "@maginalia/format" with { "resolution-mode": "import" };

type FormatCore = typeof import("@maginalia/format", { with: { "resolution-mode": "import" } });
type SourceCore = typeof import("@maginalia/source-core", { with: { "resolution-mode": "import" } });

let formatCorePromise: Promise<FormatCore> | undefined;
let sourceCorePromise: Promise<SourceCore> | undefined;

function loadFormatCore(): Promise<FormatCore> {
  formatCorePromise ??= import("@maginalia/format");
  return formatCorePromise;
}

function loadSourceCore(): Promise<SourceCore> {
  sourceCorePromise ??= import("@maginalia/source-core");
  return sourceCorePromise;
}

export const REVIEWER_SHELF_PROVENANCE_VERSION = 2 as const;

export interface ReviewerSourceFile extends ShelfSourceFileV04 {
  readonly bytes?: Uint8Array;
}

/** Fields are copied from the validated package manifest kept with the import. */
export interface ApprovedReviewerRecord {
  readonly annotationId: string;
  readonly reviewState: "APPROVED";
  readonly packageId?: string | null;
  readonly sourceKind?: ShelfSourceKind | null;
  readonly getDate?: string | null;
  readonly isbn13?: string | null;
  readonly url?: string | null;
  readonly title?: string | null;
  readonly authors?: readonly string[];
  readonly publisher?: string | null;
  readonly year?: number | null;
  readonly circleName?: string | null;
  readonly eventName?: string | null;
  readonly quote: string;
  readonly pageLabel: string;
  readonly comment: string;
  readonly sourceFiles?: readonly ReviewerSourceFile[];
  readonly sourceAssetsUnavailable?: boolean;
}

/** Optional provider enrichment. Manifest fields always take precedence. */
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
  | "invalid-package-id"
  | "source-provenance-missing"
  | "invalid-source-kind"
  | "invalid-get-date"
  | "invalid-isbn13"
  | "invalid-source-url"
  | "invalid-source-metadata"
  | "invalid-source-file"
  | "canonical-source-files-missing"
  | "canonical-source-unavailable"
  | "canonical-source-hash-mismatch"
  | "canonical-source-media-mismatch"
  | "pending-location"
  | "invalid-format-candidate"
  | "invalid-generated-annotation-id";

export interface ReviewerReconciliationPending {
  readonly kind: "pending";
  readonly code: ReviewerReconciliationPendingCode;
  readonly reviewerAnnotationId?: string;
  readonly digest?: string;
  readonly pageLabel?: string;
}

export interface ReviewerReconciliationCandidate {
  readonly kind: "candidate";
  readonly digest: string;
  readonly reviewerAnnotationId: string;
  readonly packageId: string;
  readonly sourceKind: ShelfSourceKind;
  readonly getDate: string;
  readonly isbn13?: string;
  readonly url?: string;
  readonly title?: string;
  readonly authors: readonly string[];
  readonly publisher?: string;
  readonly year?: number;
  readonly circleName?: string;
  readonly eventName?: string;
  readonly quote: string;
  readonly page?: number;
  readonly pageLabel: string;
  readonly privateMemo?: string;
  readonly sourceFiles: readonly ShelfSourceFileV04[];
  readonly canonicalSourceAssets: readonly { readonly file: ShelfSourceFileV04; readonly bytes: Uint8Array }[];
  readonly bookId: `book:${string}`;
}

export type ReviewerReconciliationResult = ReviewerReconciliationCandidate | ReviewerReconciliationPending;
export type AnnotationIdGenerator = () => string;

export interface MaterializedReviewerReconciliation {
  readonly kind: "materialized";
  readonly book: ShelfBookV04;
  readonly annotation: ShelfAnnotationV04;
}

export type ReviewerMaterializationResult = MaterializedReviewerReconciliation | ReviewerReconciliationPending;

const PACKAGE_ID = /^capkg:[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const REVIEWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const GET_DATE = /^(?:[0-9]{4}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])(?:[01][0-9]|2[0-3])(?:[0-5][0-9])|oldversionplaceholder)$/u;
const SOURCE_KINDS = new Set<ShelfSourceKind>([
  "book", "selfpublish", "website", "bookwithoutisbn", "Handwritten"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pending(
  code: ReviewerReconciliationPendingCode,
  details: Partial<Pick<ReviewerReconciliationPending, "reviewerAnnotationId" | "digest" | "pageLabel">> = {}
): ReviewerReconciliationPending {
  return Object.freeze({ kind: "pending", code, ...details });
}

function positiveIntegerPage(pageLabel: string): number | undefined {
  // Do not coerce whitespace, localized digits, or labels such as `42a`.
  if (!/^[1-9][0-9]*$/u.test(pageLabel)) return undefined;
  const page = Number(pageLabel);
  return Number.isSafeInteger(page) ? page : undefined;
}

function validRelativePackagePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\0")) return false;
  if (value.startsWith("/") || /^[A-Za-z]:/u.test(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function validUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).href === value;
  } catch {
    return false;
  }
}

function digestRecord(value: {
  annotationId: string;
  packageId: string;
  sourceKind: ShelfSourceKind;
  getDate: string;
  isbn13?: string;
  url?: string;
  title?: string;
  authors: readonly string[];
  publisher?: string;
  year?: number;
  circleName?: string;
  eventName?: string;
  quote: string;
  pageLabel: string;
  comment: string;
  sourceFiles: readonly ShelfSourceFileV04[];
}): string {
  const canonical = JSON.stringify({
    annotationId: value.annotationId,
    packageId: value.packageId,
    sourceKind: value.sourceKind,
    getDate: value.getDate,
    isbn13: value.isbn13 ?? null,
    url: value.url ?? null,
    quote: value.quote,
    pageLabel: value.pageLabel,
    comment: value.comment,
    sourceFiles: value.sourceFiles
  });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

/** Validate one approved record and its imported package provenance. */
export async function createReviewerReconciliationCandidate(
  reviewerRecord: unknown,
  openBdMetadata?: unknown
): Promise<ReviewerReconciliationResult> {
  const formatCore = await loadFormatCore();
  const sourceCore = await loadSourceCore();
  if (!isRecord(reviewerRecord)) return pending("invalid-reviewer-record");
  const annotationId = reviewerRecord.annotationId;
  if (reviewerRecord.reviewState !== "APPROVED") return pending("reviewer-not-approved");
  if (typeof annotationId !== "string" || !REVIEWER_UUID.test(annotationId)) {
    return pending("invalid-reviewer-annotation-id");
  }
  const details = { reviewerAnnotationId: annotationId };
  if (typeof reviewerRecord.quote !== "string" || reviewerRecord.quote.length === 0
    || typeof reviewerRecord.pageLabel !== "string" || typeof reviewerRecord.comment !== "string") {
    return pending("invalid-reviewer-record", details);
  }
  const packageId = reviewerRecord.packageId;
  if (typeof packageId !== "string" || !PACKAGE_ID.test(packageId)) return pending("invalid-package-id", details);
  const sourceKind = reviewerRecord.sourceKind;
  if (typeof sourceKind !== "string" || !SOURCE_KINDS.has(sourceKind as ShelfSourceKind)) {
    return pending("source-provenance-missing", details);
  }
  if (!GET_DATE.test(String(reviewerRecord.getDate ?? ""))) return pending("invalid-get-date", details);
  const getDate = reviewerRecord.getDate as string;

  let isbn13: string | undefined;
  if (reviewerRecord.isbn13 !== undefined && reviewerRecord.isbn13 !== null && reviewerRecord.isbn13 !== "") {
    isbn13 = sourceCore.normalizeIsbn13(reviewerRecord.isbn13);
    if (isbn13 === undefined) return pending("invalid-isbn13", details);
  }
  let url: string | undefined;
  if (reviewerRecord.url !== undefined && reviewerRecord.url !== null && reviewerRecord.url !== "") {
    if (!validUrl(reviewerRecord.url)) return pending("invalid-source-url", details);
    url = reviewerRecord.url;
  }
  if (sourceKind !== "Handwritten" && isbn13 === undefined && url === undefined) {
    return pending("invalid-source-metadata", details);
  }

  const title = typeof reviewerRecord.title === "string" && reviewerRecord.title.trim().length > 0
    ? reviewerRecord.title
    : undefined;
  let authors: readonly string[] = [];
  if (reviewerRecord.authors !== undefined) {
    if (!Array.isArray(reviewerRecord.authors) || !reviewerRecord.authors.every((value) => typeof value === "string")) {
      return pending("invalid-source-metadata", details);
    }
    authors = Object.freeze([...reviewerRecord.authors]);
  }
  let publisher: string | undefined;
  if (reviewerRecord.publisher !== undefined && reviewerRecord.publisher !== null && reviewerRecord.publisher !== "") {
    if (typeof reviewerRecord.publisher !== "string") return pending("invalid-source-metadata", details);
    publisher = reviewerRecord.publisher;
  }
  let year: number | undefined;
  if (reviewerRecord.year !== undefined && reviewerRecord.year !== null) {
    if (typeof reviewerRecord.year !== "number" || !Number.isInteger(reviewerRecord.year) || reviewerRecord.year < 0) {
      return pending("invalid-source-metadata", details);
    }
    year = reviewerRecord.year;
  }
  const circleName = typeof reviewerRecord.circleName === "string" && reviewerRecord.circleName.length > 0
    ? reviewerRecord.circleName
    : undefined;
  const eventName = typeof reviewerRecord.eventName === "string" && reviewerRecord.eventName.length > 0
    ? reviewerRecord.eventName
    : undefined;
  // Optional openBD values enrich absent manifest metadata only. They never
  // provide package identity, source kind, or acquisition time.
  const effectiveTitle = title ?? (isRecord(openBdMetadata)
    && openBdMetadata.isbn13 === isbn13
    && typeof openBdMetadata.title === "string"
    && openBdMetadata.title.trim().length > 0 ? openBdMetadata.title : undefined);
  const effectiveAuthors = authors.length > 0 ? authors : (isRecord(openBdMetadata)
    && openBdMetadata.isbn13 === isbn13
    && Array.isArray(openBdMetadata.authors)
    && openBdMetadata.authors.every((value) => typeof value === "string")
    ? Object.freeze([...openBdMetadata.authors]) as readonly string[] : authors);
  const effectivePublisher = publisher ?? (isRecord(openBdMetadata)
    && openBdMetadata.isbn13 === isbn13
    && typeof openBdMetadata.publisher === "string" ? openBdMetadata.publisher : undefined);
  const effectiveYear = year ?? (isRecord(openBdMetadata)
    && openBdMetadata.isbn13 === isbn13
    && typeof openBdMetadata.year === "number"
    && Number.isInteger(openBdMetadata.year)
    && openBdMetadata.year >= 0 ? openBdMetadata.year : undefined);

  const filesValue = reviewerRecord.sourceFiles ?? [];
  if (!Array.isArray(filesValue)) return pending("invalid-source-file", details);
  const sourceFiles: ShelfSourceFileV04[] = [];
  const seenPaths = new Set<string>();
  for (const file of filesValue) {
    if (!isRecord(file)
      || !validRelativePackagePath(file.path)
      || (file.mediaType !== "image/jpeg" && file.mediaType !== "application/pdf")
      || typeof file.sha256 !== "string"
      || !/^[0-9a-f]{64}$/u.test(file.sha256)
      || (file.originalName !== undefined && (typeof file.originalName !== "string" || file.originalName.length === 0))) {
      return pending("invalid-source-file", details);
    }
    if (seenPaths.has(file.path)) return pending("invalid-source-file", details);
    seenPaths.add(file.path);
    sourceFiles.push(Object.freeze({
      path: file.path,
      mediaType: file.mediaType,
      sha256: file.sha256,
      ...(typeof file.originalName === "string" ? { originalName: file.originalName } : {})
    }));
  }
  if (sourceKind === "Handwritten" && sourceFiles.length === 0) {
    return pending("canonical-source-files-missing", details);
  }
  if (reviewerRecord.sourceAssetsUnavailable === true
    || sourceFiles.some((file) => !filesValue.some((entry) => isRecord(entry)
      && entry.path === file.path && entry.bytes instanceof Uint8Array))) {
    return pending("canonical-source-unavailable", details);
  }

  const assets: { file: ShelfSourceFileV04; bytes: Uint8Array }[] = [];
  for (const file of sourceFiles) {
    const original = filesValue.find((item) => isRecord(item) && item.path === file.path) as Record<string, unknown> | undefined;
    const bytes = original?.bytes;
    if (!(bytes instanceof Uint8Array)) return pending("canonical-source-unavailable", details);
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== file.sha256) return pending("canonical-source-hash-mismatch", details);
    if (file.mediaType === "application/pdf") {
      if (Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-") {
        return pending("canonical-source-media-mismatch", details);
      }
    } else if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
      return pending("canonical-source-media-mismatch", details);
    }
    assets.push({ file, bytes: new Uint8Array(bytes) });
  }

  const page = positiveIntegerPage(reviewerRecord.pageLabel);
  if (page === undefined) return pending("pending-location", { ...details, pageLabel: reviewerRecord.pageLabel });
  const digest = digestRecord({
    annotationId,
    packageId,
    sourceKind: sourceKind as ShelfSourceKind,
    getDate,
    ...(isbn13 === undefined ? {} : { isbn13 }),
    ...(url === undefined ? {} : { url }),
    ...(effectiveTitle === undefined ? {} : { title: effectiveTitle }),
    authors: effectiveAuthors,
    ...(effectivePublisher === undefined ? {} : { publisher: effectivePublisher }),
    ...(effectiveYear === undefined ? {} : { year: effectiveYear }),
    ...(circleName === undefined ? {} : { circleName }),
    ...(eventName === undefined ? {} : { eventName }),
    quote: reviewerRecord.quote,
    pageLabel: reviewerRecord.pageLabel,
    comment: reviewerRecord.comment,
    sourceFiles
  });
  const bookId = formatCore.generateEntityId("book");
  if (!/^book:[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(bookId)) return pending("invalid-format-candidate", { ...details, digest });
  return Object.freeze({
    kind: "candidate",
    digest,
    reviewerAnnotationId: annotationId,
    packageId,
    sourceKind: sourceKind as ShelfSourceKind,
    getDate,
    ...(isbn13 === undefined ? {} : { isbn13 }),
    ...(url === undefined ? {} : { url }),
    ...(effectiveTitle === undefined ? {} : { title: effectiveTitle }),
    authors: effectiveAuthors,
    ...(effectivePublisher === undefined ? {} : { publisher: effectivePublisher }),
    ...(effectiveYear === undefined ? {} : { year: effectiveYear }),
    ...(circleName === undefined ? {} : { circleName }),
    ...(eventName === undefined ? {} : { eventName }),
    quote: reviewerRecord.quote,
    page,
    pageLabel: reviewerRecord.pageLabel,
    ...(reviewerRecord.comment.length === 0 ? {} : { privateMemo: reviewerRecord.comment }),
    sourceFiles: Object.freeze(sourceFiles),
    canonicalSourceAssets: Object.freeze(assets.map((asset) => Object.freeze(asset))),
    bookId: bookId as `book:${string}`
  });
}

/** Build the durable v0.4 entities after Book reconciliation chose an ID. */
export async function materializeReviewerReconciliationCandidate(
  candidate: ReviewerReconciliationCandidate,
  book: ShelfBookV04,
  shelfFiles: readonly ShelfSourceFileV04[],
  generateAnnotationId?: AnnotationIdGenerator
): Promise<ReviewerMaterializationResult> {
  const formatCore = await loadFormatCore();
  let id: string;
  try {
    id = generateAnnotationId === undefined ? formatCore.generateEntityId("ann") : generateAnnotationId();
  } catch {
    return pending("invalid-generated-annotation-id", {
      reviewerAnnotationId: candidate.reviewerAnnotationId,
      digest: candidate.digest
    });
  }
  const annotation: ShelfAnnotationV04 = Object.freeze({
    type: "annotation",
    version: "0.4",
    id: id as `ann:${string}`,
    source: Object.freeze({
      id: book.id,
      kind: book.source.kind,
      ...(shelfFiles.length === 0 ? {} : { files: Object.freeze([...shelfFiles]) })
    }),
    get: Object.freeze({ date: candidate.getDate }),
    quote: candidate.quote,
    ...(candidate.isbn13 === undefined ? {} : { isbn13: candidate.isbn13 }),
    ...(candidate.url === undefined ? {} : { url: candidate.url }),
    location: Object.freeze({ page: candidate.page! }),
    ...(candidate.privateMemo === undefined ? {} : { privateMemo: candidate.privateMemo }),
    deviceMetadata: Object.freeze({
      maginaliaReviewer: Object.freeze({
        version: REVIEWER_SHELF_PROVENANCE_VERSION,
        annotationId: candidate.reviewerAnnotationId,
        digest: candidate.digest,
        packageId: candidate.packageId
      })
    })
  });
  const bookValidation = formatCore.validateShelfEntity("book", book);
  const annotationValidation = formatCore.validateShelfEntity("annotation", annotation);
  if (!/^ann:[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(id)
    || !bookValidation.valid || !annotationValidation.valid) {
    return pending("invalid-generated-annotation-id", {
      reviewerAnnotationId: candidate.reviewerAnnotationId,
      digest: candidate.digest
    });
  }
  return Object.freeze({
    kind: "materialized",
    book: bookValidation.value as ShelfBookV04,
    annotation: annotationValidation.value as ShelfAnnotationV04
  });
}
