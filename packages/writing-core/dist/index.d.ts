/**
 * The document id is opaque to Writing Core. It is only compared for identity;
 * it is not interpreted as a filesystem path or any other host identifier.
 */
export type DocumentId = string;
export interface OpenDocument {
    readonly documentId: DocumentId;
    readonly displayName: string;
    readonly text: string;
}
export interface DocumentState {
    readonly documentId: DocumentId;
    readonly displayName: string;
    readonly currentText: string;
    /** The text from the most recent save confirmation. */
    readonly savedText: string;
}
export interface SaveSnapshot {
    readonly documentId: DocumentId;
    readonly text: string;
}
export interface QuotationInsertionInput {
    readonly annotationId: string;
    readonly sourceId: string;
    readonly title: string;
    readonly authors: readonly string[];
    readonly page?: number;
    readonly quote: string;
}
/**
 * A reference to a Reviewer quotation in the authoring document.
 *
 * `quoteId` is intentionally opaque.  In particular, it is not required to
 * use the legacy `ann:ULID` shape and it must never contain resolved quote
 * text or a fabricated Source id.  Slice C supports only the normal mode.
 */
export type QuoteRefMode = "normal";
export interface QuoteRef {
    readonly quoteId: string;
    readonly mode: QuoteRefMode;
}
export interface QuoteRefInsertionFailure {
    readonly kind: "error";
    readonly code: "document-mismatch" | "invalid-range" | "invalid-quote-ref";
    readonly message: string;
}
export type QuoteRefInsertionResult = QuotationInsertionSuccess | QuoteRefInsertionFailure;
export interface QuotationInsertionTarget {
    readonly documentId: DocumentId;
    /** UTF-16 offsets, matching JavaScript string and Monaco model offsets. */
    readonly start: number;
    readonly end: number;
}
export interface QuotationInsertionSuccess {
    readonly kind: "inserted";
    readonly state: DocumentState;
    readonly insertedText: string;
    readonly selectionStart: number;
    readonly selectionEnd: number;
}
export type QuotationInsertionFailureCode = "document-mismatch" | "invalid-range" | "invalid-quotation";
export interface QuotationInsertionFailure {
    readonly kind: "error";
    readonly code: QuotationInsertionFailureCode;
    readonly message: string;
}
export type QuotationInsertionResult = QuotationInsertionSuccess | QuotationInsertionFailure;
export declare function openDocument(document: OpenDocument): DocumentState;
export declare function editDocument(state: DocumentState, text: string): DocumentState;
export declare function createSaveSnapshot(state: DocumentState): SaveSnapshot;
export declare function confirmSave(state: DocumentState, snapshot: SaveSnapshot): DocumentState;
export declare function isDirty(state: DocumentState): boolean;
/** Return true for a Slice C QuoteRef (opaque id, normal mode only). */
export declare function isQuoteRef(value: unknown): value is QuoteRef;
/**
 * Serialize a QuoteRef as the deterministic, plain-text Markdown marker used
 * by the authoring document.  Only the stable identity and mode are emitted.
 */
export declare function serializeQuoteRef(value: QuoteRef): string;
/**
 * Parse one complete QuoteRef marker.  Unknown versions, modes, fields, and
 * malformed payloads return null so callers can leave source text untouched.
 */
export declare function parseQuoteRef(marker: unknown): QuoteRef | null;
/**
 * Create a readable Markdown provenance paragraph from the public quotation
 * allowlist. Extra runtime properties are intentionally never read.
 */
export declare function formatQuotationProvenance(input: QuotationInsertionInput): string;
/**
 * Replace a UTF-16 selection with a literal quotation and public provenance.
 * The function is host-independent and does not normalize the existing text.
 */
export declare function insertQuotation(state: DocumentState, target: QuotationInsertionTarget, input: QuotationInsertionInput): QuotationInsertionResult;
/**
 * Replace a UTF-16 selection with a stable QuoteRef marker.
 *
 * This is the Slice C Normal authoring path.  It intentionally does not read
 * or embed quotation text, title, authors, page metadata, or a Source id.  The
 * existing insertQuotation function above remains available for legacy flows.
 */
export declare function insertQuoteRef(state: DocumentState, target: QuotationInsertionTarget, input: QuoteRef): QuoteRefInsertionResult;
//# sourceMappingURL=index.d.ts.map