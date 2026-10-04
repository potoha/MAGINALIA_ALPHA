/**
 * Format neutral, disposable representation of a resolved export document.
 *
 * The model is deliberately not a second authoring format: every block keeps
 * its exact resolved Markdown slice, and serialization is lossless. Future
 * document adapters can consume block kinds without knowing about Projects,
 * Synced Blocks, QuoteRefs, or Shelf identities.
 */

import { scanFrontMatter } from "./document-properties";
import { isMarkdownFenceClosing, openingMarkdownFence } from "./markdown-fence";
import { collectMarkdownTables } from "./markdown-table-commands";
import { isMarkdownBlockquoteLine, parseMarkdownHeading, parseMarkdownListItem } from "./markdown-structure";

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
  readonly contentStart: number;
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
    const bom = start === 0 && source.startsWith("\uFEFF") ? 1 : 0;
    lines.push({ start, contentStart: start + bom, contentEnd, end, content: source.slice(start + bom, contentEnd) });
    start = end;
  }
  return lines;
}

function isBlank(line: SourceLine): boolean {
  return line.content.trim().length === 0;
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
  const tables = collectMarkdownTables(markdown);
  const tableByStart = new Map(tables.map((table) => [table.start, table] as const));
  const frontMatter = scanFrontMatter(markdown);
  const boundedMetadataEnd = frontMatter.kind === "bounded" ? frontMatter.boundary.closingEnd : null;
  const blocks: ExportDocumentBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    if (isBlank(lines[index])) {
      const start = index;
      while (index < lines.length && isBlank(lines[index])) index += 1;
      blocks.push(block(markdown, lines, start, index, "raw"));
      continue;
    }

    if (index === 0 && boundedMetadataEnd !== null) {
      let end = 0;
      while (end < lines.length && lines[end]!.end < boundedMetadataEnd) end += 1;
      if (end < lines.length) {
        blocks.push(block(markdown, lines, 0, end + 1, "metadata"));
        index = end + 1;
        continue;
      }
    }

    const fence = openingMarkdownFence(lines[index]!.content);
    if (fence !== null) {
      const start = index;
      index += 1;
      while (index < lines.length && !isMarkdownFenceClosing(lines[index]!.content, fence)) index += 1;
      if (index < lines.length) index += 1;
      blocks.push(block(markdown, lines, start, index, "code"));
      continue;
    }

    const heading = parseMarkdownHeading(lines[index]!.content);
    if (heading !== null) {
      blocks.push(block(markdown, lines, index, index + 1, "heading", { level: heading.level }));
      index += 1;
      continue;
    }

    const table = tableByStart.get(lines[index]!.contentStart);
    if (table !== undefined) {
      const start = index;
      while (index < lines.length && lines[index]!.end < table.end) index += 1;
      if (index < lines.length) index += 1;
      blocks.push(block(markdown, lines, start, index, "table"));
      continue;
    }

    if (isMarkdownBlockquoteLine(lines[index]!.content)) {
      const start = index;
      while (index < lines.length && isMarkdownBlockquoteLine(lines[index]!.content)) index += 1;
      blocks.push(block(markdown, lines, start, index, "blockquote"));
      continue;
    }

    const list = parseMarkdownListItem(lines[index]!.content);
    if (list !== null) {
      const start = index;
      while (index < lines.length) {
        const item = parseMarkdownListItem(lines[index]!.content);
        if (item === null || item.ordered !== list.ordered) break;
        index += 1;
      }
      blocks.push(block(markdown, lines, start, index, "list", { ordered: list.ordered }));
      continue;
    }

    const start = index;
    index += 1;
    while (index < lines.length && !isBlank(lines[index]!)) {
      const next = lines[index]!;
      if (openingMarkdownFence(next.content) !== null
        || parseMarkdownHeading(next.content) !== null
        || isMarkdownBlockquoteLine(next.content)
        || parseMarkdownListItem(next.content) !== null
        || tableByStart.has(next.contentStart)) break;
      index += 1;
    }
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
