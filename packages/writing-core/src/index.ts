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

export type QuotationInsertionFailureCode =
  | "document-mismatch"
  | "invalid-range"
  | "invalid-quotation";

export interface QuotationInsertionFailure {
  readonly kind: "error";
  readonly code: QuotationInsertionFailureCode;
  readonly message: string;
}

export type QuotationInsertionResult = QuotationInsertionSuccess | QuotationInsertionFailure;

export function openDocument(document: OpenDocument): DocumentState {
  return {
    documentId: document.documentId,
    displayName: document.displayName,
    currentText: document.text,
    savedText: document.text
  };
}

export function editDocument(state: DocumentState, text: string): DocumentState {
  return {
    ...state,
    currentText: text
  };
}

export function createSaveSnapshot(state: DocumentState): SaveSnapshot {
  return {
    documentId: state.documentId,
    text: state.currentText
  };
}

export function confirmSave(state: DocumentState, snapshot: SaveSnapshot): DocumentState {
  if (snapshot.documentId !== state.documentId) {
    return state;
  }

  return {
    ...state,
    savedText: snapshot.text
  };
}

export function isDirty(state: DocumentState): boolean {
  return state.currentText !== state.savedText;
}

const MARKDOWN_CONTROL_CHARACTERS = new Set([
  "\\", "`", "*", "_", "{", "}", "[", "]", "(", ")", "#", "+", "-", ".", "!", "|", ">", "~", "<", "&"
]);
const MARKDOWN_PROVENANCE_CHARACTERS = new Set([
  "\\", "`", "*", "_", "{", "}", "[", "]", "(", ")", "!", "|", "~", "<", ">", "&"
]);

function escapeMarkdownLiteral(value: string): string {
  let output = "";
  for (const character of value) {
    output += MARKDOWN_CONTROL_CHARACTERS.has(character) ? `\\${character}` : character;
  }
  return output;
}

function escapeMarkdownProvenanceField(value: string): string {
  // Provenance is embedded in a paragraph, so line-oriented markers such as
  // '-' and '.' are ordinary text here. Escape only characters that can still
  // introduce inline Markdown or raw HTML in that paragraph.
  let output = "";
  for (const character of value) {
    output += MARKDOWN_PROVENANCE_CHARACTERS.has(character) ? `\\${character}` : character;
  }
  return output;
}

function cleanProvenanceField(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeEol(value: string, eol: string): string {
  return value.replace(/\r\n|\r|\n/g, eol);
}

/**
 * Create a readable Markdown provenance paragraph from the public quotation
 * allowlist. Extra runtime properties are intentionally never read.
 */
export function formatQuotationProvenance(input: QuotationInsertionInput): string {
  const title = cleanProvenanceField(input.title) || "無題";
  const authors = input.authors
    .map((author) => cleanProvenanceField(author))
    .filter((author) => author.length > 0)
    .map((author) => escapeMarkdownProvenanceField(author));
  const sourceId = cleanProvenanceField(input.sourceId) || "unknown";
  const annotationId = cleanProvenanceField(input.annotationId) || "unknown";
  const fields = [`出典: ${escapeMarkdownProvenanceField(title)}`];
  if (authors.length > 0) fields.push(`著者: ${authors.join("、")}`);
  fields.push(`source: ${escapeMarkdownProvenanceField(sourceId)}`);
  if (input.page !== undefined) fields.push(`p. ${input.page}`);
  fields.push(`annotation: ${escapeMarkdownProvenanceField(annotationId)}`);
  return fields.join(" / ");
}

function validateQuotation(input: QuotationInsertionInput): boolean {
  return typeof input === "object"
    && input !== null
    && typeof input.annotationId === "string"
    && input.annotationId.length > 0
    && typeof input.sourceId === "string"
    && input.sourceId.length > 0
    && typeof input.title === "string"
    && input.title.length > 0
    && Array.isArray(input.authors)
    && input.authors.every((author) => typeof author === "string")
    && typeof input.quote === "string"
    && input.quote.length > 0
    && (input.page === undefined || (typeof input.page === "number" && Number.isInteger(input.page) && input.page > 0));
}

function insertionSeparatorBefore(text: string, start: number, eol: string): string {
  if (start === 0) return "";
  const before = text.slice(0, start);
  if (before.endsWith(`${eol}${eol}`)) return "";
  if (before.endsWith(eol)) return eol;
  return `${eol}${eol}`;
}

function insertionSeparatorAfter(text: string, end: number, eol: string): string {
  if (end === text.length) return "";
  const after = text.slice(end);
  if (after.startsWith(`${eol}${eol}`)) return "";
  if (after.startsWith(eol)) return eol;
  return `${eol}${eol}`;
}

/**
 * Replace a UTF-16 selection with a literal quotation and public provenance.
 * The function is host-independent and does not normalize the existing text.
 */
export function insertQuotation(
  state: DocumentState,
  target: QuotationInsertionTarget,
  input: QuotationInsertionInput,
): QuotationInsertionResult {
  if (target === null || typeof target !== "object") return {
    kind: "error",
    code: "invalid-range",
    message: "The quotation selection is outside the current document.",
  };
  if (target.documentId !== state.documentId) return {
    kind: "error",
    code: "document-mismatch",
    message: "The quotation target belongs to another document.",
  };
  if (!Number.isInteger(target.start)
    || !Number.isInteger(target.end)
    || target.start < 0
    || target.end < target.start
    || target.end > state.currentText.length) {
    return {
      kind: "error",
      code: "invalid-range",
      message: "The quotation selection is outside the current document.",
    };
  }
  if (!validateQuotation(input)) return {
    kind: "error",
    code: "invalid-quotation",
    message: "The quotation data is invalid.",
  };

  const eolMatch = state.currentText.match(/\r\n|\r|\n/);
  const eol = eolMatch?.[0] ?? "\n";
  const quote = escapeMarkdownLiteral(normalizeEol(input.quote, eol));
  const provenance = formatQuotationProvenance(input);
  const coreFragment = `${quote}${eol}${eol}${provenance}`;
  const insertedText = `${insertionSeparatorBefore(state.currentText, target.start, eol)}${coreFragment}${insertionSeparatorAfter(state.currentText, target.end, eol)}`;
  const currentText = `${state.currentText.slice(0, target.start)}${insertedText}${state.currentText.slice(target.end)}`;
  const selection = target.start + insertedText.length;
  return {
    kind: "inserted",
    state: editDocument(state, currentText),
    insertedText,
    selectionStart: selection,
    selectionEnd: selection,
  };
}
