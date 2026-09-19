/**
 * Renderer-safe boundary for the Capture Reviewer search API.
 *
 * The renderer sends only a query.  The main process owns the configured
 * loopback URL and performs the HTTP request; no Reviewer database or path is
 * exposed to the renderer.
 */

export const SEARCH_SHELF_CHANNEL = "maginalia:search-shelf";
export const MAX_SHELF_QUERY_CHARS = 500;
export const REVIEWER_SEARCH_STATUS = "APPROVED" as const;
export const REVIEWER_SEARCH_LIMIT = 50;

export interface SearchShelfRequest {
  readonly query: string;
}

export interface ReviewerQuotation {
  readonly annotationId: string;
  readonly captureId: string;
  readonly pageId: string;
  readonly sourcePageId: string | null;
  readonly isbn13: string | null;
  readonly title: string | null;
  readonly authors: readonly string[];
  readonly quote: string;
  readonly pageLabel: string;
  readonly comment: string;
  readonly reviewState: string;
  readonly reviewedAtMs: number | null;
}

export interface SearchShelfSuccess {
  readonly kind: "results";
  readonly results: readonly ReviewerQuotation[];
  readonly total: number;
}

export type ShelfSearchFailureCode =
  | "invalid-request"
  | "reviewer-unavailable"
  | "reviewer-error"
  | "reviewer-invalid-response";

export interface SearchShelfFailure {
  readonly kind: "error";
  readonly code: ShelfSearchFailureCode;
  readonly message: string;
}

export type SearchShelfResult = SearchShelfSuccess | SearchShelfFailure;

export interface ReviewerInvokeEvent {
  readonly sender: object;
}

export interface ReviewerSearchDependencies {
  readonly search: (query: string) => SearchShelfResult | Promise<SearchShelfResult>;
}

export interface ReviewerHandlers {
  readonly searchShelf: (
    event: ReviewerInvokeEvent,
    request: unknown,
    ...args: readonly unknown[]
  ) => Promise<SearchShelfResult>;
}

const INVALID_REQUEST: SearchShelfFailure = {
  kind: "error",
  code: "invalid-request",
  message: "The Shelf search request was invalid."
};

const REVIEWER_UNAVAILABLE: SearchShelfFailure = {
  kind: "error",
  code: "reviewer-unavailable",
  message: "Reviewer unavailable. Start the local Reviewer and try again."
};

const REVIEWER_ERROR: SearchShelfFailure = {
  kind: "error",
  code: "reviewer-error",
  message: "Reviewer search could not be completed. Try again."
};

const REVIEWER_INVALID_RESPONSE: SearchShelfFailure = {
  kind: "error",
  code: "reviewer-invalid-response",
  message: "Reviewer returned an invalid search response."
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  try {
    const keys = Reflect.ownKeys(value);
    return keys.length === expected.length
      && keys.every((key) => typeof key === "string" && expected.includes(key));
  } catch {
    return false;
  }
}

export function isSearchShelfRequest(value: unknown): value is SearchShelfRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ["query"])
    && typeof value.query === "string"
    && value.query.length <= MAX_SHELF_QUERY_CHARS;
}

function copyStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : value === null ? null : null;
}

function copyAuthors(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value.filter((author): author is string => typeof author === "string"));
}

function copyQuotation(value: unknown): ReviewerQuotation | null {
  if (!isPlainRecord(value)) return null;
  const requiredString = (key: string): string | null =>
    typeof value[key] === "string" && value[key].length > 0 ? value[key] as string : null;
  const annotationId = requiredString("annotationId");
  const captureId = requiredString("captureId");
  const pageId = requiredString("pageId");
  const quote = requiredString("quote");
  if (annotationId === null || captureId === null || pageId === null || quote === null) return null;
  const pageLabel = typeof value.pageLabel === "string" ? value.pageLabel : "";
  const comment = typeof value.comment === "string" ? value.comment : "";
  const reviewState = typeof value.reviewState === "string" ? value.reviewState : "";
  const reviewedAtMs = typeof value.reviewedAtMs === "number" && Number.isFinite(value.reviewedAtMs)
    ? value.reviewedAtMs
    : null;
  return Object.freeze({
    annotationId,
    captureId,
    pageId,
    sourcePageId: copyStringOrNull(value.sourcePageId),
    isbn13: copyStringOrNull(value.isbn13),
    title: copyStringOrNull(value.title),
    authors: copyAuthors(value.authors),
    quote,
    pageLabel,
    comment,
    reviewState,
    reviewedAtMs
  });
}

/** Normalize only the Reviewer fields that are part of the Shelf contract. */
export function normalizeReviewerSearchResponse(value: unknown): SearchShelfSuccess | null {
  if (!isPlainRecord(value) || !Array.isArray(value.results)) return null;
  const results: ReviewerQuotation[] = [];
  for (const item of value.results) {
    const quotation = copyQuotation(item);
    if (quotation === null) return null;
    results.push(quotation);
  }
  const total = typeof value.total === "number" && Number.isInteger(value.total) && value.total >= 0
    ? value.total
    : results.length;
  return Object.freeze({
    kind: "results",
    results: Object.freeze(results),
    total
  });
}

export function createReviewerHandlers(dependencies: ReviewerSearchDependencies): ReviewerHandlers {
  return {
    searchShelf: async (_event, request, ...args) => {
      if (args.length !== 0 || !isSearchShelfRequest(request)) return INVALID_REQUEST;
      try {
        const result = await dependencies.search(request.query);
        if (result.kind === "results") return result;
        return result;
      } catch (_error: unknown) {
        return REVIEWER_ERROR;
      }
    }
  };
}

export interface ReviewerSearchAdapterOptions {
  /** Main-process configuration; never supplied by the renderer. */
  readonly baseUrl?: string;
  readonly fetcher?: typeof fetch;
}

function loopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost"
    || normalized === "127.0.0.1"
    || normalized === "::1";
}

/** Parse and restrict Reviewer configuration to an HTTP(S) loopback origin. */
export function parseReviewerBaseUrl(value: string | undefined): URL | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || !loopbackHostname(parsed.hostname)
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.search.length > 0
    || parsed.hash.length > 0) {
    return null;
  }
  return parsed;
}

function reviewerUnavailable(): SearchShelfFailure {
  return Object.freeze({ ...REVIEWER_UNAVAILABLE });
}

/**
 * Create the main-process Reviewer adapter.  Missing/invalid configuration and
 * connection failures become an explicit unavailable state; they never throw
 * into the renderer and never fall back to a local database.
 */
export function createReviewerSearchAdapter(options: ReviewerSearchAdapterOptions = {}) {
  const baseUrl = parseReviewerBaseUrl(options.baseUrl);
  const fetcher = options.fetcher ?? fetch;
  return async (query: string): Promise<SearchShelfResult> => {
    if (baseUrl === null) return reviewerUnavailable();
    const endpoint = new URL("api/search", baseUrl);
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("status", REVIEWER_SEARCH_STATUS);
    endpoint.searchParams.set("limit", String(REVIEWER_SEARCH_LIMIT));
    try {
      const response = await fetcher(endpoint, { method: "GET", redirect: "error" });
      if (!response.ok) {
        return Object.freeze({ ...REVIEWER_ERROR, message: `Reviewer search failed (${response.status}).` });
      }
      const body: unknown = await response.json();
      return normalizeReviewerSearchResponse(body) ?? Object.freeze({ ...REVIEWER_INVALID_RESPONSE });
    } catch (_error: unknown) {
      return reviewerUnavailable();
    }
  };
}
