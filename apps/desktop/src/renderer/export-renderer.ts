import { parseQuoteRef, type QuoteRef } from "@maginalia/writing-core";
import type { IsbnBookSource } from "@maginalia/source-core";
import type {
  ResolvedQuoteRef,
  ReviewerResolutionFailure,
  ReviewerResolutionResult,
  UnresolvedQuoteRef
} from "../reviewer-resolution";
import { scanQuoteRefs } from "../reviewer-resolution";
import {
  formatReferenceSource,
  refreshReferenceList,
  type ReferenceListConflictReason
} from "./reference-list";
import { renderInternalLinksForExport } from "../project-links";
import { createExportDocumentModel, serializeExportDocumentModel } from "./export-document-model";

/** The immutable input captured from the active DocumentSession at export start. */
export interface ExportDocumentSnapshot {
  readonly documentId: string;
  readonly revision: number;
  readonly currentText: string;
}

export type ExportRenderBlockCode =
  | "invalid-snapshot"
  | "resolution-error"
  | "unresolved-quote"
  | "resolution-incomplete"
  | "reference-marker-conflict";

export interface ExportRenderSuccess {
  readonly kind: "rendered";
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
  readonly resolvedCount: number;
  readonly sourceCount: number;
}

export interface ExportRenderBlocked {
  readonly kind: "blocked";
  readonly code: ExportRenderBlockCode;
  readonly message: string;
  readonly unresolved?: readonly UnresolvedQuoteRef[];
  readonly resolution?: ReviewerResolutionFailure;
  readonly referenceConflict?: ReferenceListConflictReason;
}

export type ExportRenderResult = ExportRenderSuccess | ExportRenderBlocked;

const MARKDOWN_CONTROL_CHARACTERS = new Set([
  "\\", "`", "*", "_", "{", "}", "[", "]", "(", ")", "#", "+", "-", ".", "!", "|", ">", "~", "<", "&"
]);
const PROVENANCE_CONTROL_CHARACTERS = new Set([
  "\\", "`", "*", "_", "{", "}", "[", "]", "(", ")", "!", "|", "~", "<", ">", "&"
]);

function escapeMarkdownLiteral(value: string): string {
  let output = "";
  for (const character of value) {
    output += MARKDOWN_CONTROL_CHARACTERS.has(character) ? `\\${character}` : character;
  }
  return output;
}

function escapeProvenanceField(value: string): string {
  let output = "";
  for (const character of value) {
    output += PROVENANCE_CONTROL_CHARACTERS.has(character) ? `\\${character}` : character;
  }
  return output;
}

function cleanExternalText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeQuoteText(value: string): string {
  return value
    .replace(/\r\n|\r/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ")
    .replace(/\t/gu, "    ");
}

function preferredEol(value: string): string {
  for (let index = value.length - 1; index >= 0; index -= 1) {
    if (value[index] === "\n") return index > 0 && value[index - 1] === "\r" ? "\r\n" : "\n";
    if (value[index] === "\r") return "\r";
  }
  return "\n";
}

interface ExportQuoteRefOccurrence {
  readonly offset: number;
  readonly marker: string;
  readonly quoteRef: QuoteRef | null;
}

/**
 * The Slice C resolver scans v1 markers. Export additionally recognizes any
 * version-looking QuoteRef comment so a future/unknown marker can never pass
 * through silently as ordinary Markdown.
 */
function scanExportQuoteRefs(documentText: string): readonly ExportQuoteRefOccurrence[] {
  const known = scanQuoteRefs(documentText, parseQuoteRef);
  const knownByOffset = new Map(known.map((occurrence) => [occurrence.offset, occurrence]));
  const occurrences: ExportQuoteRefOccurrence[] = [];
  const prefix = "<!-- maginalia:quote-ref";
  let cursor = 0;
  while (cursor < documentText.length) {
    const offset = documentText.indexOf(prefix, cursor);
    if (offset < 0) break;
    const afterPrefix = documentText[offset + prefix.length];
    if (afterPrefix !== " " && afterPrefix !== "\t" && afterPrefix !== "v" && afterPrefix !== "V") {
      cursor = offset + prefix.length;
      continue;
    }
    const terminator = documentText.indexOf("-->", offset + prefix.length);
    const end = terminator < 0 ? documentText.length : terminator + 3;
    const marker = documentText.slice(offset, end);
    const knownOccurrence = knownByOffset.get(offset);
    occurrences.push(knownOccurrence ?? {
      offset,
      marker,
      quoteRef: parseQuoteRef(marker)
    });
    cursor = end;
  }
  return occurrences;
}

function normalizeEol(value: string, eol: string): string {
  return value.replace(/\r\n|\r|\n/g, eol);
}

/**
 * Render only the public quotation text as a Markdown blockquote.  The
 * resolved annotation id, capture ids, page ids, and Source id are never
 * read by this function.
 */
export function renderResolvedQuote(
  resolved: ResolvedQuoteRef,
  eol = "\n"
): string {
  const quote = normalizeEol(normalizeQuoteText(resolved.quotation.quote), eol);
  const lines = quote.split(eol).map((line) => `> ${escapeMarkdownLiteral(line)}`);
  const block = lines.join(eol);
  const provenance = renderResolvedProvenance(resolved);
  return provenance.length === 0 ? block : `${block}${eol}${eol}${provenance}`;
}

/**
 * Render a compact, human-readable provenance cue.  Only title, authors, and
 * pageLabel are allowed; provider/runtime identifiers are deliberately not
 * part of the exported representation.
 */
export function renderResolvedProvenance(resolved: ResolvedQuoteRef): string {
  const quotation = resolved.quotation;
  const source = resolved.source;
  const title = cleanExternalText(source.title) || cleanExternalText(quotation.title);
  const authors = (source.authors.length > 0 ? source.authors : quotation.authors)
    .map(cleanExternalText)
    .filter((author) => author.length > 0)
    .map(escapeProvenanceField);
  const pageLabel = cleanExternalText(quotation.pageLabel);

  let body = authors.join("、");
  if (title.length > 0) body += `『${escapeProvenanceField(title)}』`;
  if (pageLabel.length > 0) body += `${body.length > 0 ? "、" : ""}p.${escapeProvenanceField(pageLabel)}`;
  return body.length === 0 ? "" : `（${body}）`;
}

function dedupeSources(sources: readonly IsbnBookSource[]): IsbnBookSource[] {
  const unique = new Map<string, IsbnBookSource>();
  for (const source of sources) {
    if (!unique.has(source.id)) unique.set(source.id, source);
  }
  return [...unique.values()].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  );
}

/** Render deterministic bibliography entries without emitting Source IDs. */
export function renderResolvedReferences(
  sources: readonly IsbnBookSource[],
  eol = "\n"
): string {
  return dedupeSources(sources).map(formatReferenceSource).join(eol);
}

function removeMarkerLine(text: string, marker: string): string {
  let cursor = 0;
  while (cursor <= text.length) {
    const lineStart = cursor;
    let lineEnd = cursor;
    while (lineEnd < text.length && text[lineEnd] !== "\r" && text[lineEnd] !== "\n") lineEnd += 1;
    if (text.slice(lineStart, lineEnd) === marker) {
      let afterLine = lineEnd;
      if (afterLine < text.length && text[afterLine] === "\r" && text[afterLine + 1] === "\n") {
        afterLine += 2;
      } else if (afterLine < text.length) {
        afterLine += 1;
      }
      return `${text.slice(0, lineStart)}${text.slice(afterLine)}`;
    }
    if (lineEnd >= text.length) break;
    cursor = lineEnd + (text[lineEnd] === "\r" && text[lineEnd + 1] === "\n" ? 2 : 1);
  }
  return text;
}

function removeReferenceMarkers(text: string): string {
  // Importing the marker constants indirectly through refreshReferenceList
  // would make the generated region opaque.  These exact literals are the
  // existing v1 contract in reference-list.ts.
  return removeMarkerLine(
    removeMarkerLine(text, "<!-- maginalia:reference-list-start v1 -->"),
    "<!-- maginalia:reference-list-end v1 -->"
  );
}

function hasUnknownReferenceMarker(text: string): boolean {
  const startPrefix = "<!-- maginalia:reference-list-start";
  const endPrefix = "<!-- maginalia:reference-list-end";
  const exact = new Set([
    "<!-- maginalia:reference-list-start v1 -->",
    "<!-- maginalia:reference-list-end v1 -->"
  ]);
  let cursor = 0;
  while (cursor <= text.length) {
    let lineEnd = cursor;
    while (lineEnd < text.length && text[lineEnd] !== "\r" && text[lineEnd] !== "\n") lineEnd += 1;
    const line = text.slice(cursor, lineEnd);
    if (!exact.has(line) && (line.startsWith(startPrefix) || line.startsWith(endPrefix))) return true;
    if (lineEnd >= text.length) break;
    cursor = lineEnd + (text[lineEnd] === "\r" && text[lineEnd + 1] === "\n" ? 2 : 1);
  }
  return false;
}

function hasValidSnapshot(value: ExportDocumentSnapshot): boolean {
  return value !== null
    && typeof value === "object"
    && typeof value.documentId === "string"
    && value.documentId.length > 0
    && Number.isSafeInteger(value.revision)
    && value.revision >= 0
    && typeof value.currentText === "string";
}

function blocked(
  code: ExportRenderBlockCode,
  message: string,
  extra: Partial<Omit<ExportRenderBlocked, "kind" | "code" | "message">> = {}
): ExportRenderBlocked {
  return Object.freeze({ kind: "blocked", code, message, ...extra });
}

function validResolvedOccurrence(
  snapshotText: string,
  item: ResolvedQuoteRef
): boolean {
  const parsed = parseQuoteRef(item.occurrence.marker);
  return item.quoteRef.mode === "normal"
    && typeof item.quoteRef.quoteId === "string"
    && item.quoteRef.quoteId.length > 0
    && parsed?.quoteId === item.quoteRef.quoteId
    && parsed.mode === item.quoteRef.mode
    && Number.isSafeInteger(item.occurrence.offset)
    && item.occurrence.offset >= 0
    && item.occurrence.offset + item.occurrence.marker.length <= snapshotText.length
    && item.occurrence.marker.length > 0
    && snapshotText.slice(item.occurrence.offset, item.occurrence.offset + item.occurrence.marker.length)
      === item.occurrence.marker
    && item.occurrence.quoteRef?.quoteId === item.quoteRef.quoteId
    && item.occurrence.quoteRef?.mode === "normal"
    && typeof item.quotation.quote === "string"
    && item.quotation.quote.length > 0;
}

function sameOccurrence(left: ResolvedQuoteRef, right: ResolvedQuoteRef): boolean {
  return left.occurrence.offset === right.occurrence.offset
    && left.occurrence.marker === right.occurrence.marker;
}

function replaceResolvedQuoteMarkers(
  text: string,
  resolved: readonly ResolvedQuoteRef[],
  eol: string
): string | null {
  const ordered = [...resolved].sort((left, right) => left.occurrence.offset - right.occurrence.offset);
  for (let index = 1; index < ordered.length; index += 1) {
    if (sameOccurrence(ordered[index - 1], ordered[index])) return null;
  }

  let output = text;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const item = ordered[index];
    const start = item.occurrence.offset;
    const end = start + item.occurrence.marker.length;
    output = `${output.slice(0, start)}${renderResolvedQuote(item, eol)}${output.slice(end)}`;
  }
  return output;
}

function resolutionErrorMessage(failure: ReviewerResolutionFailure): string {
  return failure.message.length > 0
    ? failure.message
    : "Quotation resolution failed. The Markdown was not exported.";
}

/**
 * Pure authoring-to-export projection.  It reads a session snapshot and an
 * already-computed Reviewer resolution result, and returns ordinary Markdown
 * or an explicit block.  It never mutates the input snapshot or editor state.
 */
export function renderResolvedMarkdown(
  snapshot: ExportDocumentSnapshot,
  resolution: ReviewerResolutionResult
): ExportRenderResult {
  if (!hasValidSnapshot(snapshot)) {
    return blocked("invalid-snapshot", "The active document snapshot is invalid. The Markdown was not exported.");
  }

  const occurrences = scanExportQuoteRefs(snapshot.currentText);
  const hasQuoteRefMarker = occurrences.length > 0;

  if (resolution.kind === "error") {
    if (hasQuoteRefMarker) {
      return blocked("resolution-error", resolutionErrorMessage(resolution), { resolution });
    }
    const noQuoteResolution: ReviewerResolutionResult = {
      kind: "resolved",
      sources: [],
      resolved: [],
      unresolved: []
    };
    return renderResolvedMarkdown(snapshot, noQuoteResolution);
  }

  if (resolution.unresolved.length > 0) {
    return blocked(
      "unresolved-quote",
      `${resolution.unresolved.length} quotation${resolution.unresolved.length === 1 ? "" : "s"} could not be resolved. The Markdown was not exported.`,
      { unresolved: resolution.unresolved }
    );
  }

  if (occurrences.some((occurrence) => occurrence.quoteRef === null)) {
    return blocked(
      "unresolved-quote",
      "A malformed or unknown QuoteRef was found. The Markdown was not exported."
    );
  }

  const expectedOccurrences = occurrences.filter(
    (occurrence): occurrence is typeof occurrence & { readonly quoteRef: QuoteRef } => occurrence.quoteRef !== null
  );
  if (resolution.resolved.length !== expectedOccurrences.length
    || resolution.resolved.some((item) => !validResolvedOccurrence(snapshot.currentText, item))
    || resolution.resolved.some((item, index) => {
      const expected = expectedOccurrences[index];
      return expected === undefined
        || expected.offset !== item.occurrence.offset
        || expected.marker !== item.occurrence.marker
        || expected.quoteRef.quoteId !== item.quoteRef.quoteId;
    })) {
    return blocked(
      "resolution-incomplete",
      "The quotation resolution did not cover the active document snapshot. The Markdown was not exported."
    );
  }

  const eol = preferredEol(snapshot.currentText);
  const replaced = replaceResolvedQuoteMarkers(snapshot.currentText, resolution.resolved, eol);
  if (replaced === null) {
    return blocked(
      "resolution-incomplete",
      "The quotation resolution contained duplicate or overlapping markers. The Markdown was not exported."
    );
  }

  if (hasUnknownReferenceMarker(replaced)) {
    return blocked(
      "reference-marker-conflict",
      "The Reference List marker version or shape is unknown. Repair the authoring document before exporting."
    );
  }

  const references = refreshReferenceList(replaced, resolution.sources);
  if (references.kind === "conflict") {
    return blocked(
      "reference-marker-conflict",
      "The Reference List markers conflict. Repair the authoring document before exporting.",
      { referenceConflict: references.reason }
    );
  }

  // Project identity is authoring-only.  This final pure pass preserves the
  // visible wording while stripping wiki targets, including in a dirty export
  // snapshot; code spans and fenced code are intentionally left untouched.
  const output = renderInternalLinksForExport(removeReferenceMarkers(references.text));
  const documentModel = createExportDocumentModel(output);
  return Object.freeze({
    kind: "rendered",
    documentId: snapshot.documentId,
    revision: snapshot.revision,
    text: serializeExportDocumentModel(documentModel),
    resolvedCount: resolution.resolved.length,
    sourceCount: dedupeSources(resolution.sources).length
  });
}
