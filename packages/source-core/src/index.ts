/** The kinds understood by the provider-neutral Source contract. */
export type SourceType = "book" | "zine" | "web" | "other";

/**
 * A portable source reference used by authoring and derived-reference code.
 *
 * This is deliberately independent from the legacy Format v0.1 Source entity:
 * it has no version-specific ULID, storage path, or provider payload.
 */
export interface Source {
  readonly id: string;
  readonly type: SourceType;
  readonly title?: string;
  readonly authors: readonly string[];
  readonly publisher?: string;
  readonly publishedDate?: string;
  readonly identifiers?: Readonly<Record<string, string>>;
  readonly url?: string;
  readonly accessedDate?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** A Source whose identity is the canonical ISBN-13 value. */
export interface IsbnBookSource extends Source {
  readonly id: `book:isbn13:${string}`;
  readonly type: "book";
  readonly identifiers: Readonly<{
    readonly isbn13: string;
  } & Record<string, string>>;
}

/**
 * Provider-neutral book fields accepted by the Source adapter.
 *
 * `isbn13` is optional at this boundary because an upstream quotation may not
 * have one. Such input is intentionally unresolved and does not produce a
 * fabricated Source identity.
 */
export interface BookSourceInput {
  readonly isbn13?: string | null;
  readonly title?: string | null;
  readonly authors?: readonly string[] | null;
  readonly publisher?: string | null;
  readonly publishedDate?: string | null;
  readonly identifiers?: Readonly<Record<string, string>> | null;
  readonly url?: string | null;
  readonly accessedDate?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>> | null;
}

const ISBN13_PREFIXES = new Set(["978", "979"]);
const ISBN13_PATTERN = /^[0-9]{13}$/u;

/**
 * Return a canonical ISBN-13, or undefined when the value is absent or not a
 * valid unformatted ISBN-13. Hyphens, spaces, and non-ASCII digits are
 * intentionally rejected so source identity never depends on formatting.
 */
export function normalizeIsbn13(value: unknown): string | undefined {
  if (typeof value !== "string" || !ISBN13_PATTERN.test(value)) return undefined;
  if (!ISBN13_PREFIXES.has(value.slice(0, 3))) return undefined;

  let sum = 0;
  for (let index = 0; index < 12; index += 1) {
    sum += Number(value[index]) * (index % 2 === 0 ? 1 : 3);
  }
  const checksum = (10 - (sum % 10)) % 10;
  return checksum === Number(value[12]) ? value : undefined;
}

/** Type guard for a canonical, valid ISBN-13 string. */
export function isValidIsbn13(value: unknown): value is string {
  return normalizeIsbn13(value) !== undefined;
}

/** Return the deterministic Source identity for a canonical ISBN-13. */
export function isbnBookSourceId(isbn13: string): `book:isbn13:${string}` {
  const normalized = normalizeIsbn13(isbn13);
  if (normalized === undefined) throw new SourceCoreError("invalid-isbn13", "A valid ISBN-13 is required.");
  return `book:isbn13:${normalized}`;
}

export type SourceCoreErrorCode = "invalid-isbn13";

/** A bounded error for callers that choose strict Source construction. */
export class SourceCoreError extends Error {
  public constructor(public readonly code: SourceCoreErrorCode, message: string) {
    super(message);
    this.name = "SourceCoreError";
  }
}

function optionalText(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 ? text : undefined;
}

function copyAuthors(authors: readonly string[] | null | undefined): readonly string[] {
  if (!Array.isArray(authors)) return Object.freeze([]);
  return Object.freeze(
    authors
      .filter((author): author is string => typeof author === "string")
      .map((author) => author.trim())
      .filter((author) => author.length > 0)
  );
}

function copyIdentifiers(
  identifiers: Readonly<Record<string, string>> | null | undefined,
  isbn13: string
): IsbnBookSource["identifiers"] {
  const output: Record<string, string> = {};
  if (identifiers !== null && identifiers !== undefined) {
    for (const [key, value] of Object.entries(identifiers)) {
      if (key.trim().length === 0 || typeof value !== "string") continue;
      const normalizedKey = key.trim();
      const normalizedValue = value.trim();
      if (normalizedValue.length > 0) output[normalizedKey] = normalizedValue;
    }
  }
  // The canonical ISBN always wins over a caller-provided value.
  const result: Record<string, string> & { isbn13: string } = { ...output, isbn13 };
  return Object.freeze(result);
}

function copyMetadata(
  metadata: Readonly<Record<string, unknown>> | null | undefined
): Readonly<Record<string, unknown>> | undefined {
  if (metadata === null || metadata === undefined) return undefined;
  return Object.freeze({ ...metadata });
}

/**
 * Adapt normalized, provider-neutral book metadata to a deterministic Source.
 * Missing or invalid ISBNs return undefined so resolver callers can preserve
 * the originating QuoteRef as unresolved without inventing an identity.
 */
export function adaptBookSource(input: BookSourceInput | null | undefined): IsbnBookSource | undefined {
  if (input === null || input === undefined || typeof input !== "object") return undefined;
  const isbn13 = normalizeIsbn13(input.isbn13);
  if (isbn13 === undefined) return undefined;

  const title = optionalText(input.title);
  const publisher = optionalText(input.publisher);
  const publishedDate = optionalText(input.publishedDate);
  const url = optionalText(input.url);
  const accessedDate = optionalText(input.accessedDate);
  const metadata = copyMetadata(input.metadata);
  const source: IsbnBookSource = {
    id: `book:isbn13:${isbn13}`,
    type: "book",
    authors: copyAuthors(input.authors),
    identifiers: copyIdentifiers(input.identifiers, isbn13)
  };
  return Object.freeze({
    ...source,
    ...(title === undefined ? {} : { title }),
    ...(publisher === undefined ? {} : { publisher }),
    ...(publishedDate === undefined ? {} : { publishedDate }),
    ...(url === undefined ? {} : { url }),
    ...(accessedDate === undefined ? {} : { accessedDate }),
    ...(metadata === undefined ? {} : { metadata })
  });
}

/**
 * Strict counterpart to `adaptBookSource` for callers that require a Source.
 * Resolver code should normally use the tolerant adapter instead.
 */
export function createBookSource(input: BookSourceInput): IsbnBookSource {
  const source = adaptBookSource(input);
  if (source === undefined) {
    throw new SourceCoreError("invalid-isbn13", "A valid ISBN-13 is required to create a book Source.");
  }
  return source;
}
