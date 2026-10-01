export interface OpenBdBookMetadata {
  readonly isbn13: string;
  readonly title: string;
  readonly authors: string[];
  readonly publisher?: string;
  readonly year?: number;
}

export type OpenBdMetadataResult =
  | { readonly status: "ok"; readonly metadata: OpenBdBookMetadata }
  | { readonly status: "unavailable" | "not-found" | "incomplete" | "invalid-response" };

export interface OpenBdFetchResponse {
  readonly ok: boolean;
  json(): Promise<unknown>;
}

export type OpenBdFetcher = (url: string) => Promise<OpenBdFetchResponse>;

const OPENBD_GET_ENDPOINT = "https://api.openbd.jp/v1/get";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Normalize only ASCII structural whitespace. In particular, preserve Japanese
 * punctuation and ideographic spaces exactly as supplied by openBD.
 */
function normalizeStructuralWhitespace(value: string): string {
  return value
    .replace(/[\u0009-\u000d ]+/gu, " ")
    .replace(/^ +| +$/gu, "");
}

function hasVisibleText(value: string): boolean {
  return /[^\s]/u.test(value);
}

function parseAuthors(value: string): string[] {
  const authorText = normalizeStructuralWhitespace(value);
  if (!hasVisibleText(authorText)) return [];

  // openBD summary.author commonly represents Japanese catalog names as
  // "surname,given surname,given". Split only when every whitespace-delimited
  // token has this form; do not guess from punctuation or ordinary name spaces.
  const catalogNames = authorText.split(" ");
  if (catalogNames.length > 1 && catalogNames.every((name) => /^[^,\s]+,[^,\s]+$/u.test(name))) {
    return catalogNames;
  }

  return [authorText];
}

function parseYear(pubdate: string): number | undefined {
  const match = /^(\d{4})(?:\d{2}(?:\d{2})?|-\d{2}(?:-\d{2})?)?$/u.exec(
    normalizeStructuralWhitespace(pubdate)
  );
  if (!match) return undefined;
  const year = Number(match[1]);
  return year > 0 ? year : undefined;
}

function isbnMatches(value: string, requestedIsbn13: string): boolean {
  const compact = value.replace(/[\u0009-\u000d -]/gu, "");
  return compact === requestedIsbn13;
}

/**
 * Look up one already-validated ISBN-13 through the fixed openBD endpoint.
 * The fetcher can be injected by tests; callers cannot choose a URL or path.
 */
export async function lookupOpenBdMetadata(
  isbn13: string,
  fetcher: OpenBdFetcher = globalThis.fetch
): Promise<OpenBdMetadataResult> {
  const url = `${OPENBD_GET_ENDPOINT}?isbn=${encodeURIComponent(isbn13)}`;

  let response: OpenBdFetchResponse;
  try {
    response = await fetcher(url);
  } catch (_error: unknown) {
    return { status: "unavailable" };
  }

  if (!response.ok) return { status: "unavailable" };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (_error: unknown) {
    return { status: "invalid-response" };
  }

  if (!Array.isArray(payload)) return { status: "invalid-response" };
  if (payload.length === 0) return { status: "not-found" };
  if (payload.length !== 1) return { status: "invalid-response" };

  const entry: unknown = payload[0];
  if (entry === null) return { status: "not-found" };
  if (!isRecord(entry) || !isRecord(entry.summary)) return { status: "invalid-response" };

  const summary = entry.summary;
  if (Object.hasOwn(summary, "isbn")) {
    if (typeof summary.isbn !== "string" || !isbnMatches(summary.isbn, isbn13)) {
      return { status: "invalid-response" };
    }
  }

  if (
    !Object.hasOwn(summary, "title")
    || !Object.hasOwn(summary, "author")
    || summary.title === null
    || summary.author === null
  ) {
    return { status: "incomplete" };
  }
  if (typeof summary.title !== "string" || typeof summary.author !== "string") {
    return { status: "invalid-response" };
  }

  const title = normalizeStructuralWhitespace(summary.title);
  const authors = parseAuthors(summary.author);
  if (!hasVisibleText(title) || authors.length === 0) return { status: "incomplete" };

  if (Object.hasOwn(summary, "publisher") && typeof summary.publisher !== "string") {
    return { status: "invalid-response" };
  }
  if (Object.hasOwn(summary, "pubdate") && typeof summary.pubdate !== "string") {
    return { status: "invalid-response" };
  }

  const publisher = typeof summary.publisher === "string"
    ? normalizeStructuralWhitespace(summary.publisher)
    : "";
  const year = typeof summary.pubdate === "string" ? parseYear(summary.pubdate) : undefined;

  return {
    status: "ok",
    metadata: {
      isbn13,
      title,
      authors,
      ...(hasVisibleText(publisher) ? { publisher } : {}),
      ...(year !== undefined ? { year } : {})
    }
  };
}
