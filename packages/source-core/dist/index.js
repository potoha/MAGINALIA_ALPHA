const ISBN13_PREFIXES = new Set(["978", "979"]);
const ISBN13_PATTERN = /^[0-9]{13}$/u;
/**
 * Return a canonical ISBN-13, or undefined when the value is absent or not a
 * valid unformatted ISBN-13. Hyphens, spaces, and non-ASCII digits are
 * intentionally rejected so source identity never depends on formatting.
 */
export function normalizeIsbn13(value) {
    if (typeof value !== "string" || !ISBN13_PATTERN.test(value))
        return undefined;
    if (!ISBN13_PREFIXES.has(value.slice(0, 3)))
        return undefined;
    let sum = 0;
    for (let index = 0; index < 12; index += 1) {
        sum += Number(value[index]) * (index % 2 === 0 ? 1 : 3);
    }
    const checksum = (10 - (sum % 10)) % 10;
    return checksum === Number(value[12]) ? value : undefined;
}
/** Type guard for a canonical, valid ISBN-13 string. */
export function isValidIsbn13(value) {
    return normalizeIsbn13(value) !== undefined;
}
/** Return the deterministic Source identity for a canonical ISBN-13. */
export function isbnBookSourceId(isbn13) {
    const normalized = normalizeIsbn13(isbn13);
    if (normalized === undefined)
        throw new SourceCoreError("invalid-isbn13", "A valid ISBN-13 is required.");
    return `book:isbn13:${normalized}`;
}
/** A bounded error for callers that choose strict Source construction. */
export class SourceCoreError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "SourceCoreError";
    }
}
function optionalText(value) {
    if (typeof value !== "string")
        return undefined;
    const text = value.trim();
    return text.length > 0 ? text : undefined;
}
function copyAuthors(authors) {
    if (!Array.isArray(authors))
        return Object.freeze([]);
    return Object.freeze(authors
        .filter((author) => typeof author === "string")
        .map((author) => author.trim())
        .filter((author) => author.length > 0));
}
function copyIdentifiers(identifiers, isbn13) {
    const output = {};
    if (identifiers !== null && identifiers !== undefined) {
        for (const [key, value] of Object.entries(identifiers)) {
            if (key.trim().length === 0 || typeof value !== "string")
                continue;
            const normalizedKey = key.trim();
            const normalizedValue = value.trim();
            if (normalizedValue.length > 0)
                output[normalizedKey] = normalizedValue;
        }
    }
    // The canonical ISBN always wins over a caller-provided value.
    const result = { ...output, isbn13 };
    return Object.freeze(result);
}
function copyMetadata(metadata) {
    if (metadata === null || metadata === undefined)
        return undefined;
    return Object.freeze({ ...metadata });
}
/**
 * Adapt normalized, provider-neutral book metadata to a deterministic Source.
 * Missing or invalid ISBNs return undefined so resolver callers can preserve
 * the originating QuoteRef as unresolved without inventing an identity.
 */
export function adaptBookSource(input) {
    if (input === null || input === undefined || typeof input !== "object")
        return undefined;
    const isbn13 = normalizeIsbn13(input.isbn13);
    if (isbn13 === undefined)
        return undefined;
    const title = optionalText(input.title);
    const publisher = optionalText(input.publisher);
    const publishedDate = optionalText(input.publishedDate);
    const url = optionalText(input.url);
    const accessedDate = optionalText(input.accessedDate);
    const metadata = copyMetadata(input.metadata);
    const source = {
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
export function createBookSource(input) {
    const source = adaptBookSource(input);
    if (source === undefined) {
        throw new SourceCoreError("invalid-isbn13", "A valid ISBN-13 is required to create a book Source.");
    }
    return source;
}
