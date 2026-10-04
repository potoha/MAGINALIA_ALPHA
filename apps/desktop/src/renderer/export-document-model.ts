/**
 * Format neutral, disposable representation of a resolved export document.
 *
 * The model is deliberately not a second authoring format: every block keeps
 * its exact resolved Markdown slice, and serialization is lossless. Future
 * document adapters can consume block kinds without knowing about Projects,
 * Synced Blocks, QuoteRefs, or Shelf identities.
 */

export type ExportDocumentBlockKind =
  | "metadata"
  | "heading"
  | "paragraph"
  | "blockquote"
  | "list"
  | "code"
  | "table"
  | "raw";

export interface ExportDocumentBlock {
  readonly kind: ExportDocumentBlockKind;
  readonly markdown: string;
  readonly level?: number;
  readonly ordered?: boolean;
}

export interface ExportDocumentModel {
  readonly kind: "export-document";
  readonly version: 1;
  readonly blocks: readonly ExportDocumentBlock[];
}

interface SourceLine {
  readonly start: number;
  readonly contentEnd: number;
  readonly end: number;
  readonly content: string;
}

function sourceLines(source: string): readonly SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (start < source.length) {
    let contentEnd = start;
    while (contentEnd < source.length && source[contentEnd] !== "\r" && source[contentEnd] !== "\n") contentEnd += 1;
    let end = contentEnd;
    if (source[end] === "\r" && source[end + 1] === "\n") end += 2;
    else if (source[end] === "\r" || source[end] === "\n") end += 1;
    lines.push({ start, contentEnd, end, content: source.slice(start, contentEnd) });
    start = end;
  }
  return lines;
}

function isBlank(line: SourceLine): boolean {
  return line.content.trim().length === 0;
}

function heading(line: SourceLine): number | null {
  const match = /^ {0,3}(#{1,6})(?:\s+|$)/u.exec(line.content);
  return match === null ? null : match[1].length;
}

function list(line: SourceLine): boolean | null {
  const match = /^ {0,3}(?:([-+*])\s+|(\d+)\.\s+)/u.exec(line.content);
  if (match === null) return null;
  return match[2] !== undefined;
}

function isBlockquote(line: SourceLine): boolean {
  return /^ {0,3}>/u.test(line.content);
}

interface Fence {
  readonly marker: "`" | "~";
  readonly length: number;
}

function openingFence(line: SourceLine): Fence | null {
  const match = /^( {0,3})(`{3,}|~{3,})/u.exec(line.content);
  return match === null ? null : { marker: match[2][0] as "`" | "~", length: match[2].length };
}

function closingFence(line: SourceLine, fence: Fence): boolean {
  const match = new RegExp(`^ {0,3}${fence.marker}{${fence.length},}\\s*$`, "u").exec(line.content);
  return match !== null;
}

function tableDelimiter(line: SourceLine): boolean {
  const value = line.content.trim().replace(/^\|/u, "").replace(/\|$/u, "");
  const cells = value.split("|");
  return cells.length > 0 && cells.every((cell) => /^\s*:?-{3,}:?\s*$/u.test(cell));
}

function tableStart(lines: readonly SourceLine[], index: number): boolean {
  const line = lines[index];
  const next = lines[index + 1];
  return line !== undefined && next !== undefined && line.content.includes("|") && tableDelimiter(next);
}

function structuralStart(lines: readonly SourceLine[], index: number): boolean {
  const line = lines[index];
  if (line === undefined) return false;
  return openingFence(line) !== null
    || heading(line) !== null
    || isBlockquote(line)
    || list(line) !== null
    || tableStart(lines, index);
}

function metadataEnd(lines: readonly SourceLine[]): number | null {
  const first = lines[0];
  if (first === undefined || first.content.replace(/^\uFEFF/u, "").trim() !== "---") return null;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].content.trim() === "---" || lines[index].content.trim() === "...") return index;
  }
  return null;
}

function block(
  source: string,
  lines: readonly SourceLine[],
  start: number,
  end: number,
  kind: ExportDocumentBlockKind,
  attributes: { readonly level?: number; readonly ordered?: boolean } = {}
): ExportDocumentBlock {
  return Object.freeze({
    kind,
    markdown: source.slice(lines[start].start, lines[end - 1].end),
    ...attributes
  });
}

/** Build a lossless semantic block view over final resolved Markdown. */
export function createExportDocumentModel(markdown: string): ExportDocumentModel {
  const lines = sourceLines(markdown);
  const blocks: ExportDocumentBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    if (isBlank(lines[index])) {
      const start = index;
      while (index < lines.length && isBlank(lines[index])) index += 1;
      blocks.push(block(markdown, lines, start, index, "raw"));
      continue;
    }

    if (index === 0) {
      const end = metadataEnd(lines);
      if (end !== null) {
        blocks.push(block(markdown, lines, 0, end + 1, "metadata"));
        index = end + 1;
        continue;
      }
    }

    const fence = openingFence(lines[index]);
    if (fence !== null) {
      const start = index;
      index += 1;
      while (index < lines.length && !closingFence(lines[index], fence)) index += 1;
      if (index < lines.length) index += 1;
      blocks.push(block(markdown, lines, start, index, "code"));
      continue;
    }

    const level = heading(lines[index]);
    if (level !== null) {
      blocks.push(block(markdown, lines, index, index + 1, "heading", { level }));
      index += 1;
      continue;
    }

    if (tableStart(lines, index)) {
      const start = index;
      index += 2;
      while (index < lines.length && !isBlank(lines[index]) && lines[index].content.includes("|") && !structuralStart(lines, index)) index += 1;
      blocks.push(block(markdown, lines, start, index, "table"));
      continue;
    }

    if (isBlockquote(lines[index])) {
      const start = index;
      while (index < lines.length && isBlockquote(lines[index])) index += 1;
      blocks.push(block(markdown, lines, start, index, "blockquote"));
      continue;
    }

    const ordered = list(lines[index]);
    if (ordered !== null) {
      const start = index;
      while (index < lines.length && list(lines[index]) === ordered) index += 1;
      blocks.push(block(markdown, lines, start, index, "list", { ordered }));
      continue;
    }

    const start = index;
    index += 1;
    while (index < lines.length && !isBlank(lines[index]) && !structuralStart(lines, index)) index += 1;
    blocks.push(block(markdown, lines, start, index, "paragraph"));
  }

  return Object.freeze({
    kind: "export-document",
    version: 1,
    blocks: Object.freeze(blocks)
  });
}

/** Serialize without changing any resolved Markdown bytes or line endings. */
export function serializeExportDocumentModel(model: ExportDocumentModel): string {
  return model.blocks.map((item) => item.markdown).join("");
}
