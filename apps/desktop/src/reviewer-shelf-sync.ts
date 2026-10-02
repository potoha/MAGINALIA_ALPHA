/**
 * Explicit main-process synchronization from approved Reviewer records into a
 * selected Private Shelf. Creating this adapter performs no network requests;
 * callers opt in by invoking it from a dedicated sync action.
 */
import { lookupOpenBdMetadata } from "./openbd-metadata";
import {
  materializeReviewerRecords,
  type MaterializationResult,
  type ReviewerShelfMetadataLookup
} from "./reviewer-shelf-materializer";
import {
  parseReviewerBaseUrl,
  type ReviewerQuotation
} from "./reviewer-ipc";
import type {
  ApprovedReviewerRecord,
  ReviewerReconciliationPending
} from "./reviewer-shelf-reconciliation";

export const REVIEWER_SHELF_SYNC_PAGE_LIMIT = 100;
export const MAX_REVIEWER_SHELF_SYNC_PAGES = 1_001;

export type ReviewerShelfSyncFailureCode =
  | "reviewer-unavailable"
  | "reviewer-error"
  | "reviewer-invalid-response"
  | "pagination-inconsistent";

export interface ReviewerShelfSyncResult {
  readonly kind: "completed" | "error";
  readonly materialized: number;
  readonly unchanged: number;
  /** Number of records left pending by the existing reconciliation core. */
  readonly pending: number;
  readonly pendingRecords: readonly ReviewerReconciliationPending[];
  readonly conflicts: number;
  /** Per-record openBD lookup failures, or one for a sync-wide Reviewer error. */
  readonly failed: number;
  readonly error?: {
    readonly code: ReviewerShelfSyncFailureCode;
    readonly message: string;
  };
}

export interface ReviewerShelfSyncAdapterOptions {
  /** Main-process configuration only; never supplied by renderer input. */
  readonly baseUrl?: string;
  readonly getBaseUrl?: () => string | URL | null | Promise<string | URL | null>;
  readonly reviewerFetcher?: typeof fetch;
  /** Override metadata lookup for a host adapter or focused tests. */
  readonly lookupMetadata?: ReviewerShelfMetadataLookup;
  /** Override the durable boundary for focused tests. */
  readonly materialize?: typeof materializeReviewerRecords;
  /** Must not exceed the Reviewer sidecar's limit of 100. */
  readonly pageLimit?: number;
}

interface ReviewerSearchPage {
  readonly results: readonly ReviewerQuotation[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

type PageResult =
  | { readonly kind: "page"; readonly page: ReviewerSearchPage }
  | { readonly kind: "error"; readonly code: ReviewerShelfSyncFailureCode; readonly message: string };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOptionalStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isReviewerQuotation(value: unknown): value is ReviewerQuotation {
  return isPlainRecord(value)
    && typeof value.annotationId === "string"
    && value.annotationId.length > 0
    && typeof value.captureId === "string"
    && value.captureId.length > 0
    && typeof value.pageId === "string"
    && value.pageId.length > 0
    && isOptionalStringOrNull(value.sourcePageId)
    && isOptionalStringOrNull(value.isbn13)
    && isOptionalStringOrNull(value.title)
    && Array.isArray(value.authors)
    && value.authors.every((author) => typeof author === "string")
    && typeof value.quote === "string"
    && value.quote.length > 0
    && typeof value.pageLabel === "string"
    && typeof value.comment === "string"
    && value.reviewState === "APPROVED"
    && (value.reviewedAtMs === undefined
      || value.reviewedAtMs === null
      || (typeof value.reviewedAtMs === "number" && Number.isFinite(value.reviewedAtMs)));
}

function parseSearchPage(value: unknown): ReviewerSearchPage | null {
  if (!isPlainRecord(value)
    || !Array.isArray(value.results)
    || !isSafeInteger(value.total)
    || !isSafeInteger(value.limit)
    || !isSafeInteger(value.offset)
    || !value.results.every(isReviewerQuotation)) {
    return null;
  }

  if (value.limit < 1
    || value.results.length > value.limit
    || !Number.isSafeInteger(value.offset + value.results.length)
    || value.offset + value.results.length > value.total) {
    return null;
  }

  const results = value.results.map((quotation) => Object.freeze({
    ...quotation,
    authors: Object.freeze([...quotation.authors]),
    reviewedAtMs: quotation.reviewedAtMs ?? null
  }));
  return Object.freeze({
    results: Object.freeze(results),
    total: value.total,
    limit: value.limit,
    offset: value.offset
  });
}

function toApprovedReviewerRecord(quotation: ReviewerQuotation): ApprovedReviewerRecord {
  return Object.freeze({
    annotationId: quotation.annotationId,
    reviewState: "APPROVED",
    // Reviewer permits approved quotations with no ISBN; the reconciliation
    // core will keep these records pending without blocking independent rows.
    isbn13: quotation.isbn13 ?? "",
    quote: quotation.quote,
    pageLabel: quotation.pageLabel,
    comment: quotation.comment
  });
}

function reviewerError(
  code: ReviewerShelfSyncFailureCode,
  message: string
): ReviewerShelfSyncResult {
  return Object.freeze({
    kind: "error",
    materialized: 0,
    unchanged: 0,
    pending: 0,
    pendingRecords: Object.freeze([]),
    conflicts: 0,
    failed: 1,
    error: Object.freeze({ code, message })
  });
}

async function fetchSearchPage(
  baseUrl: URL,
  fetcher: typeof fetch,
  offset: number,
  limit: number
): Promise<PageResult> {
  const endpoint = new URL("api/search", baseUrl);
  endpoint.searchParams.set("q", "");
  endpoint.searchParams.set("status", "APPROVED");
  endpoint.searchParams.set("limit", String(limit));
  endpoint.searchParams.set("offset", String(offset));

  let response: Response;
  try {
    response = await fetcher(endpoint, { method: "GET", redirect: "error" });
  } catch {
    return {
      kind: "error",
      code: "reviewer-unavailable",
      message: "Reviewer unavailable. Try again from Shelf Review."
    };
  }
  if (!response.ok) {
    return {
      kind: "error",
      code: "reviewer-error",
      message: `Reviewer search failed (${response.status}).`
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      kind: "error",
      code: "reviewer-invalid-response",
      message: "Reviewer returned an invalid search response."
    };
  }
  const page = parseSearchPage(body);
  if (page === null) {
    return {
      kind: "error",
      code: "reviewer-invalid-response",
      message: "Reviewer returned an invalid search response."
    };
  }
  if (page.limit !== limit || page.offset !== offset) {
    return {
      kind: "error",
      code: "pagination-inconsistent",
      message: "Reviewer search pagination was inconsistent."
    };
  }
  return { kind: "page", page };
}

function mapMaterializationResult(
  materialized: MaterializationResult,
  failed: number
): ReviewerShelfSyncResult {
  return Object.freeze({
    kind: "completed",
    materialized: materialized.materialized,
    unchanged: materialized.unchanged,
    pending: materialized.pending.length,
    pendingRecords: materialized.pending,
    conflicts: materialized.conflicts,
    failed
  });
}

/**
 * Create an explicit Reviewer -> Private Shelf synchronization operation.
 * Every approved search page is validated before the materializer is called,
 * so Reviewer transport or pagination failures cannot partially write Shelf
 * data. Search and export paths remain independent of this adapter.
 */
export function createReviewerShelfSyncAdapter(
  options: ReviewerShelfSyncAdapterOptions = {}
): (shelfRoot: string) => Promise<ReviewerShelfSyncResult> {
  const configuredBaseUrl = parseReviewerBaseUrl(options.baseUrl);
  const fetcher = options.reviewerFetcher ?? fetch;
  const lookupMetadata = options.lookupMetadata ?? ((isbn13) => lookupOpenBdMetadata(isbn13));
  const materialize = options.materialize ?? materializeReviewerRecords;
  const pageLimit = options.pageLimit ?? REVIEWER_SHELF_SYNC_PAGE_LIMIT;

  return async (shelfRoot: string): Promise<ReviewerShelfSyncResult> => {
    if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > REVIEWER_SHELF_SYNC_PAGE_LIMIT) {
      return reviewerError("reviewer-invalid-response", "The Reviewer page limit is invalid.");
    }

    let baseUrl = configuredBaseUrl;
    if (baseUrl === null && options.getBaseUrl !== undefined) {
      try {
        const resolved = await options.getBaseUrl();
        baseUrl = parseReviewerBaseUrl(resolved instanceof URL ? resolved.href : resolved ?? undefined);
      } catch {
        return reviewerError("reviewer-unavailable", "Reviewer unavailable. Try again from Shelf Review.");
      }
    }
    if (baseUrl === null) {
      return reviewerError("reviewer-unavailable", "Reviewer unavailable. Try again from Shelf Review.");
    }

    const records: ApprovedReviewerRecord[] = [];
    const annotationIds = new Set<string>();
    let expectedOffset = 0;
    let expectedTotal: number | undefined;
    let pageCount = 0;

    while (expectedTotal === undefined || expectedOffset < expectedTotal) {
      if (pageCount >= MAX_REVIEWER_SHELF_SYNC_PAGES) {
        return reviewerError("pagination-inconsistent", "Reviewer search pagination exceeded its safe limit.");
      }
      const result = await fetchSearchPage(baseUrl, fetcher, expectedOffset, pageLimit);
      if (result.kind === "error") return reviewerError(result.code, result.message);

      const { page } = result;
      if (expectedTotal !== undefined && page.total !== expectedTotal) {
        return reviewerError("pagination-inconsistent", "Reviewer search pagination was inconsistent.");
      }
      expectedTotal = page.total;
      if (page.offset !== expectedOffset
        || (page.total > expectedOffset && page.results.length === 0)
        || (page.offset + page.results.length < page.total && page.results.length !== page.limit)) {
        return reviewerError("pagination-inconsistent", "Reviewer search pagination was inconsistent.");
      }

      for (const quotation of page.results) {
        if (annotationIds.has(quotation.annotationId)) {
          return reviewerError("pagination-inconsistent", "Reviewer search returned a duplicate annotation.");
        }
        annotationIds.add(quotation.annotationId);
        records.push(toApprovedReviewerRecord(quotation));
      }

      const nextOffset = page.offset + page.results.length;
      if (nextOffset <= expectedOffset && nextOffset < page.total) {
        return reviewerError("pagination-inconsistent", "Reviewer search pagination did not make forward progress.");
      }
      expectedOffset = nextOffset;
      pageCount += 1;
    }

    const metadataByIsbn = new Map<string, Promise<Awaited<ReturnType<ReviewerShelfMetadataLookup>>>>();
    const failedAnnotationIds = new Set<string>();
    const cachedLookup: ReviewerShelfMetadataLookup = (isbn13) => {
      const cached = metadataByIsbn.get(isbn13);
      if (cached !== undefined) return cached;

      const lookup = Promise.resolve()
        .then(() => lookupMetadata(isbn13))
        .catch(() => ({ status: "unavailable" }))
        .then((result) => {
          if (result.status !== "ok" && result.status !== "not-found" && result.status !== "incomplete") {
            for (const record of records) {
              if (record.isbn13 === isbn13) failedAnnotationIds.add(record.annotationId);
            }
          }
          return result;
        });
      metadataByIsbn.set(isbn13, lookup);
      return lookup;
    };

    const summary = await materialize(shelfRoot, Object.freeze(records), cachedLookup);
    return mapMaterializationResult(summary, failedAnnotationIds.size);
  };
}
