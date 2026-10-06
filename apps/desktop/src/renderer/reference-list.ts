import type { Source } from "@maginalia/source-core";

export const REFERENCE_LIST_MARKER_START = "<!-- maginalia:reference-list-start v1 -->";
export const REFERENCE_LIST_MARKER_END = "<!-- maginalia:reference-list-end v1 -->";
export const REFERENCE_LIST_HEADING = "## 参考文献";

export type ReferenceListConflictReason =
  | "missing-end-marker"
  | "missing-start-marker"
  | "duplicate-markers"
  | "reversed-markers";

export type ReferenceListRefreshResult =
  | {
      readonly kind: "changed";
      readonly text: string;
    }
  | {
      readonly kind: "unchanged";
      readonly text: string;
    }
  | {
      readonly kind: "conflict";
      readonly text: string;
      readonly reason: ReferenceListConflictReason;
    };

/**
 * Removes only a document's existing derived reference region from a
 * disposable composition/export projection.  It never touches authoring
 * source.  A malformed marker pair cannot be safely distinguished from
 * user-authored text, so callers must fail closed.
 */
export type ReferenceListStripResult =
  | { readonly kind: "stripped" | "unchanged"; readonly text: string }
  | { readonly kind: "conflict"; readonly text: string; readonly reason: ReferenceListConflictReason };

interface Line {
  readonly content: string;
  readonly start: number;
  readonly end: number;
  readonly eol: string;
}

interface MarkerPair {
  readonly start: Line;
  readonly end: Line;
  readonly interiorStart: number;
  readonly interiorEnd: number;
}

function linesOf(text: string): readonly Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start <= text.length) {
    let end = start;
    while (end < text.length && text[end] !== "\r" && text[end] !== "\n") end += 1;
    let eol = "";
    if (end < text.length) {
      if (text[end] === "\r" && text[end + 1] === "\n") {
        eol = "\r\n";
      } else {
        eol = text[end] ?? "";
      }
    }
    lines.push({ content: text.slice(start, end), start, end, eol });
    if (end >= text.length) break;
    start = end + eol.length;
  }
  return lines;
}

interface MarkerConflict {
  readonly kind: "conflict";
  readonly reason: ReferenceListConflictReason;
}

function markerPair(text: string): MarkerPair | MarkerConflict | null {
  const lines = linesOf(text);
  const starts = lines.filter((line) => line.content === REFERENCE_LIST_MARKER_START);
  const ends = lines.filter((line) => line.content === REFERENCE_LIST_MARKER_END);

  if (starts.length === 0 && ends.length === 0) return null;
  if (starts.length !== 1 || ends.length !== 1) {
    return {
      kind: "conflict",
      reason: starts.length === 0 ? "missing-start-marker"
        : ends.length === 0 ? "missing-end-marker"
          : "duplicate-markers"
    };
  }

  const start = starts[0];
  const end = ends[0];
  if (start.start >= end.start) return { kind: "conflict", reason: "reversed-markers" };
  return {
    start,
    end,
    interiorStart: start.end + start.eol.length,
    interiorEnd: end.start
  };
}

/**
 * Drop a nested document's generated References section before it is inserted
 * into a larger linear composition.  The parent composition receives one
 * final derived list from its actual QuoteRef occurrences.  The heading is
 * removed only when it has the exact generated placement immediately before
 * the markers; user-authored headings remain untouched.
 */
export function stripDerivedReferenceList(text: string): ReferenceListStripResult {
  const current = typeof text === "string" ? text : "";
  const pair = markerPair(current);
  if (pair === null) return Object.freeze({ kind: "unchanged", text: current });
  if (isMarkerConflict(pair)) return Object.freeze({ kind: "conflict", text: current, reason: pair.reason });

  const lines = linesOf(current);
  const startIndex = lines.findIndex((line) => line.start === pair.start.start);
  const headingIndex = startIndex >= 2
    && lines[startIndex - 1]?.content === ""
    && lines[startIndex - 2]?.content === REFERENCE_LIST_HEADING
    ? startIndex - 2
    : -1;
  const removeStart = headingIndex >= 0 ? lines[headingIndex]!.start : pair.start.start;
  const removeEnd = pair.end.end + pair.end.eol.length;
  return Object.freeze({
    kind: "stripped",
    text: current.slice(0, removeStart) + current.slice(removeEnd)
  });
}

function isMarkerConflict(value: MarkerPair | MarkerConflict): value is MarkerConflict {
  return "kind" in value && value.kind === "conflict";
}

function preferredEol(text: string): string {
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (text[index] === "\n") return index > 0 && text[index - 1] === "\r" ? "\r\n" : "\n";
    if (text[index] === "\r") return "\r";
  }
  return "\n";
}

function appendPrefix(text: string, eol: string): string {
  if (text.length === 0) return "";
  if (text.endsWith(eol + eol)) return "";
  if (text.endsWith(eol)) return eol;
  return eol + eol;
}

/**
 * Convert provider metadata to one stable, simple Japanese bibliography line.
 * This intentionally is not a citation-style engine.
 */
export function formatReferenceSource(source: Source): string {
  const authors = source.authors
    .map(normalizeExternalText)
    .filter((author) => author.length > 0)
    .join("、");
  const title = normalizeExternalText(source.title);
  const publisher = normalizeExternalText(source.publisher);
  const publishedDate = normalizeExternalText(source.publishedDate);

  const url = normalizeExternalText(source.url);
  const isbn = source.identifiers?.isbn13;
  if (authors.length === 0 && title.length === 0 && publisher.length === 0 && publishedDate.length === 0) {
    if (typeof isbn === "string") return `- ISBN ${escapeMarkdown(isbn)}。`;
    if (url.length > 0) return `- ${escapeMarkdown(url)}。`;
    return "- 原資料。";
  }

  let line = "- ";
  if (authors.length > 0) line += `${escapeMarkdown(authors)}`;
  if (title.length > 0) line += `『${escapeMarkdown(title)}』`;
  if (publisher.length > 0) {
    if (line !== "- ") line += " ";
    line += escapeMarkdown(publisher);
  }
  if (publishedDate.length > 0) {
    line += line === "- " ? escapeMarkdown(publishedDate) : `、${escapeMarkdown(publishedDate)}`;
  }
  if (url.length > 0) line += `（${escapeMarkdown(url)}）`;
  return `${line}。`;
}

function normalizeExternalText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_[\]{}()#+.!|>]/gu, "\\$&");
}

function sourceLines(sources: readonly Source[], eol: string): string {
  const unique = new Map<string, Source>();
  for (const source of sources) {
    if (!unique.has(source.id)) unique.set(source.id, source);
  }
  return [...unique.values()]
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    .map(formatReferenceSource)
    .join(eol);
}

function generatedBlock(sources: readonly Source[], eol: string): string {
  const entries = sourceLines(sources, eol);
  return `${REFERENCE_LIST_HEADING}${eol}${eol}${REFERENCE_LIST_MARKER_START}${eol}`
    + (entries.length > 0 ? `${entries}${eol}` : "")
    + REFERENCE_LIST_MARKER_END;
}

/**
 * Apply only the derived reference region. The input text is returned byte
 * for byte when there are no sources and no marker, or when marker structure
 * is ambiguous. Manual text outside the generated region is never changed.
 */
export function refreshReferenceList(
  text: string,
  sources: readonly Source[]
): ReferenceListRefreshResult {
  const current = typeof text === "string" ? text : "";
  const eol = preferredEol(current);
  const pair = markerPair(current);

  if (pair !== null && isMarkerConflict(pair)) {
    return Object.freeze({ kind: "conflict", text: current, reason: pair.reason });
  }

  if (pair === null) {
    if (sources.length === 0) return Object.freeze({ kind: "unchanged", text: current });
    const next = current + appendPrefix(current, eol) + generatedBlock(sources, eol);
    return Object.freeze({ kind: next === current ? "unchanged" : "changed", text: next });
  }

  const interior = sourceLines(sources, eol);
  const generatedInterior = interior.length > 0 ? `${interior}${eol}` : "";
  const next = current.slice(0, pair.interiorStart)
    + generatedInterior
    + current.slice(pair.interiorEnd);
  return Object.freeze({ kind: next === current ? "unchanged" : "changed", text: next });
}
