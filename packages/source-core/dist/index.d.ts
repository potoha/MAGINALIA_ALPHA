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
/**
 * Return a canonical ISBN-13, or undefined when the value is absent or not a
 * valid unformatted ISBN-13. Hyphens, spaces, and non-ASCII digits are
 * intentionally rejected so source identity never depends on formatting.
 */
export declare function normalizeIsbn13(value: unknown): string | undefined;
/** Type guard for a canonical, valid ISBN-13 string. */
export declare function isValidIsbn13(value: unknown): value is string;
/** Return the deterministic Source identity for a canonical ISBN-13. */
export declare function isbnBookSourceId(isbn13: string): `book:isbn13:${string}`;
export type SourceCoreErrorCode = "invalid-isbn13";
/** A bounded error for callers that choose strict Source construction. */
export declare class SourceCoreError extends Error {
    readonly code: SourceCoreErrorCode;
    constructor(code: SourceCoreErrorCode, message: string);
}
/**
 * Adapt normalized, provider-neutral book metadata to a deterministic Source.
 * Missing or invalid ISBNs return undefined so resolver callers can preserve
 * the originating QuoteRef as unresolved without inventing an identity.
 */
export declare function adaptBookSource(input: BookSourceInput | null | undefined): IsbnBookSource | undefined;
/**
 * Strict counterpart to `adaptBookSource` for callers that require a Source.
 * Resolver code should normally use the tolerant adapter instead.
 */
export declare function createBookSource(input: BookSourceInput): IsbnBookSource;
//# sourceMappingURL=index.d.ts.map