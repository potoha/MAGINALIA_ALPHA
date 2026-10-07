import type { ResolvedQuoteRef, UnresolvedQuoteRef } from "../reviewer-resolution";
import type { WritingDirection } from "./renderer-preferences";
import {
  parseMarkdownInlines,
  quoteMarkerAt,
  safeExternalHref,
  QUOTE_MARKER_PREFIX,
  type MarkdownInline,
  type PreviewInternalLinkMap,
  type PreviewMediaMap,
  type PreviewQuote,
  type PreviewQuoteMap
} from "./markdown-inline";
import { parseInternalLinkAt } from "../project-links";
import { describeEmbed } from "./embed-providers";
import { PreviewCompositionGate } from "./preview-editing";
import { collectMarkdownTables, escapeTableCell, isMarkdownTableTerminator, type MarkdownTableCellTarget, type MarkdownTableTarget } from "./markdown-table-commands";
import { findFrontMatterBoundary, projectMarkdownBody } from "./document-properties";
import { isMarkdownFenceClosing, openingMarkdownFence } from "./markdown-fence";
import { isMarkdownBlockquoteLine, parseMarkdownHeading, parseMarkdownListItem } from "./markdown-structure";
import { isSyncedBlockStructuralLine, parseSyncedBlockMarker, type ComposedSyncedBlock } from "./synced-block";

export {
  parseMarkdownInlines,
  type MarkdownInline,
  type PreviewInternalLinkMap,
  type PreviewMedia,
  type PreviewMediaMap,
  type PreviewQuote,
  type PreviewQuoteMap
} from "./markdown-inline";

export type MarkdownBlock =
  | { readonly kind: "heading"; readonly depth: number; readonly content: readonly MarkdownInline[] }
  | { readonly kind: "paragraph"; readonly content: readonly MarkdownInline[]; readonly presentation: "prose" | "structural" }
  | { readonly kind: "blockquote"; readonly content: readonly MarkdownInline[] }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "list"; readonly ordered: boolean; readonly items: readonly (readonly MarkdownInline[])[] }
  | { readonly kind: "synced-block"; readonly marker: string; readonly valid: boolean }
  | {
    readonly kind: "table";
    readonly alignments: readonly MarkdownTableAlignment[];
    readonly header: readonly (readonly MarkdownInline[])[];
    readonly rows: readonly (readonly (readonly MarkdownInline[])[])[];
  };

export type MarkdownTableAlignment = "left" | "center" | "right" | "none";

function trimTableWhitespace(value: string): string {
  return value.replace(/^[\t ]+|[\t ]+$/gu, "");
}

function parseTableRow(line: string): readonly string[] | null {
  if (!line.includes("|")) return null;
  let source = trimTableWhitespace(line);
  if (source.startsWith("|")) source = source.slice(1);
  const hasTrailingPipe = source.endsWith("|") && (() => {
    let backslashes = 0;
    for (let index = source.length - 2; index >= 0 && source[index] === "\\"; index -= 1) backslashes += 1;
    return backslashes % 2 === 0;
  })();
  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < source.length;) {
    const character = source[index];
    if (character === "\\") {
      let end = index + 1;
      while (source[end] === "\\") end += 1;
      const slashCount = end - index;
      if (source[end] === "|") {
        cell += "\\".repeat(Math.floor(slashCount / 2));
        if (slashCount % 2 === 1) cell += "|";
        else {
          cells.push(trimTableWhitespace(cell));
          cell = "";
        }
        index = end + 1;
      } else {
        cell += "\\".repeat(slashCount);
        index = end;
      }
    } else if (character === "|") {
      cells.push(trimTableWhitespace(cell));
      cell = "";
      index += 1;
    } else {
      cell += character;
      index += 1;
    }
  }
  cells.push(trimTableWhitespace(cell));
  if (hasTrailingPipe) cells.pop();
  return cells.length > 0 ? cells : null;
}

function tableAlignment(value: string): MarkdownTableAlignment | null {
  const trimmed = trimTableWhitespace(value);
  if (!/^:?-{3,}:?$/u.test(trimmed)) return null;
  if (trimmed.startsWith(":") && trimmed.endsWith(":")) return "center";
  if (trimmed.endsWith(":")) return "right";
  if (trimmed.startsWith(":")) return "left";
  return "none";
}

function tableStart(lines: readonly string[], index: number): {
  readonly header: readonly string[];
  readonly alignments: readonly MarkdownTableAlignment[];
} | null {
  const header = parseTableRow(lines[index] ?? "");
  const divider = parseTableRow(lines[index + 1] ?? "");
  if (header === null || divider === null || header.length === 0 || divider.length !== header.length) return null;
  const alignments = divider.map(tableAlignment);
  return alignments.some((alignment) => alignment === null)
    ? null
    : { header, alignments: alignments as readonly MarkdownTableAlignment[] };
}

function isStructuralInline(node: MarkdownInline): boolean {
  if (node.kind === "local-media" || node.kind === "quote-ref") return true;
  if (node.kind === "link") return node.embed !== undefined;
  if (node.kind === "strong" || node.kind === "emphasis") {
    return node.children.length > 0 && node.children.every(isStructuralInline);
  }
  return node.kind === "text" && /^\s*$/u.test(node.text);
}

function isStructuralParagraph(nodes: readonly MarkdownInline[]): boolean {
  return nodes.some((node) => isStructuralInline(node) && node.kind !== "text")
    && nodes.every(isStructuralInline);
}

export function parseMarkdownBlocks(
  text: string,
  quotes: PreviewQuoteMap = new Map(),
  internalLinks: PreviewInternalLinkMap = new Map(),
  media: PreviewMediaMap = new Map()
): readonly MarkdownBlock[] {
  const lines = text.replace(/^\uFEFF/u, "").replace(/\r\n|\r/gu, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim().length === 0) { index += 1; continue; }
    const fence = openingMarkdownFence(line);
    if (fence !== null) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !isMarkdownFenceClosing(lines[index], fence)) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const heading = parseMarkdownHeading(line);
    if (heading !== null) {
      blocks.push({ kind: "heading", depth: heading.level, content: parseMarkdownInlines(heading.content, quotes, internalLinks, media) });
      index += 1;
      continue;
    }
    const synced = parseSyncedBlockMarker(line);
    if (synced !== null) {
      blocks.push({ kind: "synced-block", marker: line, valid: synced.kind === "valid" });
      index += 1;
      continue;
    }
    const table = tableStart(lines, index);
    if (table !== null) {
      const columnCount = table.header.length;
      const rows: (readonly (readonly MarkdownInline[])[])[] = [];
      index += 2;
      while (index < lines.length) {
        if (isMarkdownTableTerminator(lines[index])) break;
        const row = parseTableRow(lines[index]);
        if (row === null) break;
        const cells = row.slice(0, columnCount);
        while (cells.length < columnCount) cells.push("");
        rows.push(cells.map((cell) => parseMarkdownInlines(cell, quotes, internalLinks, media)));
        index += 1;
      }
      blocks.push({
        kind: "table",
        alignments: table.alignments,
        header: table.header.map((cell) => parseMarkdownInlines(cell, quotes, internalLinks, media)),
        rows
      });
      continue;
    }
    if (isMarkdownBlockquoteLine(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && isMarkdownBlockquoteLine(lines[index])) {
        quoteLines.push(lines[index].replace(/^>\s?/u, ""));
        index += 1;
      }
      blocks.push({ kind: "blockquote", content: parseMarkdownInlines(quoteLines.join("\n"), quotes, internalLinks, media) });
      continue;
    }
    const list = parseMarkdownListItem(line);
    if (list !== null) {
      const ordered = list.ordered;
      const items: (readonly MarkdownInline[])[] = [];
      while (index < lines.length) {
        const item = parseMarkdownListItem(lines[index]);
        if (item === null || item.ordered !== ordered) break;
        items.push(parseMarkdownInlines(item.content, quotes, internalLinks, media));
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && lines[index].trim().length > 0
      && openingMarkdownFence(lines[index]) === null
      && parseMarkdownHeading(lines[index]) === null
      && !isSyncedBlockStructuralLine(lines[index])
      && !isMarkdownBlockquoteLine(lines[index])
      && parseMarkdownListItem(lines[index]) === null
      && tableStart(lines, index) === null) {
      paragraph.push(lines[index++]);
    }
    const content = parseMarkdownInlines(paragraph.join("\n"), quotes, internalLinks, media);
    blocks.push({ kind: "paragraph", content, presentation: isStructuralParagraph(content) ? "structural" : "prose" });
  }
  return Object.freeze(blocks);
}

/** Add only the line break boundary needed before a new trailing Markdown block. */
export function minimumPreviewTrailingSeparator(
  text: string,
  lastBlock: MarkdownBlock | undefined,
  defaultLineEnding: "\n" | "\r\n" | "\r" = "\n"
): string {
  if (lastBlock === undefined) {
    const frontMatter = findFrontMatterBoundary(text);
    return frontMatter?.closingEnd === text.length ? defaultLineEnding : "";
  }
  const needsBlankLine = lastBlock.kind === "paragraph" || lastBlock.kind === "blockquote"
    || lastBlock.kind === "list" || lastBlock.kind === "table";
  const requiredLineBreaks = needsBlankLine ? 2 : 1;
  let trailingLineBreaks = 0;
  let cursor = text.length;
  while (cursor > 0) {
    if (text.slice(cursor - 2, cursor) === "\r\n") {
      trailingLineBreaks += 1;
      cursor -= 2;
    } else if (text[cursor - 1] === "\r" || text[cursor - 1] === "\n") {
      trailingLineBreaks += 1;
      cursor -= 1;
    } else {
      break;
    }
  }
  let lineEnding = defaultLineEnding;
  for (const match of text.matchAll(/\r\n|\n|\r/gu)) {
    if (match[0] === "\r\n" || match[0] === "\n" || match[0] === "\r") lineEnding = match[0];
  }
  return lineEnding.repeat(Math.max(0, requiredLineBreaks - trailingLineBreaks));
}

/** Collect only parsed Project media nodes; code spans/fences remain inert. */
export function scanLocalMediaTargets(text: string): readonly string[] {
  const targets = new Set<string>();
  const visit = (nodes: readonly MarkdownInline[]): void => {
    for (const node of nodes) {
      if (node.kind === "local-media") targets.add(node.target);
      else if (node.kind === "strong" || node.kind === "emphasis") visit(node.children);
    }
  };
  for (const block of parseMarkdownBlocks(text)) {
    if (block.kind === "code") continue;
    if (block.kind === "list") visit(block.items.flat());
    else if (block.kind === "table") {
      visit(block.header.flat());
      for (const row of block.rows) visit(row.flat());
    } else if (block.kind !== "synced-block") visit(block.content);
  }
  return Object.freeze([...targets]);
}

export interface MarkdownPreviewRenderOptions {
  /** Raw documents hide front matter; composed children have already projected it. */
  readonly sourceMode?: "document" | "already-projected";
  /** Bound by the host to main-process validated shell.openExternal only. */
  readonly onOpenExternal?: (url: string) => void;
  /**
   * Preview-only interaction seam for a main-process-approved internal link.
   * This carries an opaque file ID, never a Project path or DOM/editor handle.
   */
  readonly onOpenInternal?: (link: { readonly target: string; readonly fileId: string }) => void;
  /** Safe text-only authoring callback; HTML/DOM never becomes Markdown authority. */
  readonly editable?: PreviewEditableOptions;
  /** Table authoring remains a Renderer projection over exact Markdown spans. */
  readonly onTableTarget?: (target: MarkdownTableTarget, cell: MarkdownTableCellTarget) => void;
  readonly onTableCommand?: (commandId: string, target: MarkdownTableTarget, cell: MarkdownTableCellTarget) => void;
  /** Renderer-only composed child document models; never durable source text. */
  readonly syncedBlocks?: ReadonlyMap<string, PreviewSyncedBlock>;
  /** Opens a resolved child through the existing Project document/session path. */
  readonly onOpenSyncedBlock?: (block: { readonly fileId: string; readonly target: string }) => void;
}

export interface PreviewSyncedBlock extends ComposedSyncedBlock {
  readonly internalLinks?: PreviewInternalLinkMap;
  readonly media?: PreviewMediaMap;
  /** Child QuoteRefs resolve against child source, never parent offsets. */
  readonly quotes?: PreviewQuoteMap;
}

export interface PreviewEditableTextRange {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /** Enter may insert a source line break at this range without guessing Markdown structure. */
  readonly allowEnter?: boolean;
}

export interface PreviewEditableOptions {
  readonly revision: number;
  readonly defaultLineEnding?: "\n" | "\r\n" | "\r";
  readonly onEdit: (request: { readonly revision: number; readonly range: PreviewEditableTextRange; readonly replacement: string }) =>
    | { readonly kind: "applied"; readonly revision: number; readonly range: { readonly start: number; readonly end: number } }
    | { readonly kind: "error" };
  readonly onEditingChange?: (editing: boolean) => void;
  readonly onSelectionChange?: (range: { readonly start: number; readonly end: number } | null) => void;
  readonly onEnterApplied?: (result: { readonly revision: number; readonly offset: number }) => void;
  readonly onEnterFallback?: () => void;
  /** One renderer-local caret target consumed by the render that owns this revision. */
  readonly restoreCaretOffset?: number;
}

interface SourceLine {
  readonly text: string;
  /** First source offset belonging to the line text, after a possible BOM. */
  readonly start: number;
  /** Raw line start, before a possible BOM. */
  readonly sourceStart: number;
  /** Source offset immediately after line text and before its line ending. */
  readonly end: number;
  /** Source offset after the exact LF, CRLF, or CR line ending. */
  readonly sourceEnd: number;
}

function sourceLines(text: string, sourceOffset = 0): readonly SourceLine[] {
  const lines: SourceLine[] = [];
  let cursor = 0;
  while (cursor <= text.length) {
    let rawEnd = cursor;
    while (rawEnd < text.length && text[rawEnd] !== "\n" && text[rawEnd] !== "\r") rawEnd += 1;
    let sourceEnd = rawEnd;
    if (text[rawEnd] === "\r" && text[rawEnd + 1] === "\n") sourceEnd += 2;
    else if (text[rawEnd] === "\r" || text[rawEnd] === "\n") sourceEnd += 1;
    const bom = sourceOffset === 0 && cursor === 0 && text.startsWith("\uFEFF") ? 1 : 0;
    lines.push({
      text: text.slice(cursor + bom, rawEnd),
      start: sourceOffset + cursor + bom,
      sourceStart: sourceOffset + cursor,
      end: sourceOffset + rawEnd,
      sourceEnd: sourceOffset + sourceEnd
    });
    if (sourceEnd === rawEnd) break;
    cursor = sourceEnd;
  }
  return lines;
}

/** Apply front-matter projection once for raw documents, never for child bodies. */
export function projectMarkdownPreviewSource(
  text: string,
  sourceMode: "document" | "already-projected" = "document",
): { readonly body: string; readonly start: number } {
  return sourceMode === "document" ? projectMarkdownBody(text) : { body: text, start: 0 };
}

/** Collect only source ranges whose visible Markdown text is unambiguous. */
function editableInlineRanges(text: string, sourceStart: number, allowEnter = true): readonly PreviewEditableTextRange[] {
  // Raw HTML/comments, QuoteRefs, media and code remain protected in H.7.2.
  if (/<(?:!--|\/?[A-Za-z])/u.test(text)) return [];
  const ranges: PreviewEditableTextRange[] = [];
  const visit = (value: string, base: number, canInsertLineBreak = allowEnter): void => {
    let cursor = 0;
    const push = (start: number, end: number): void => {
      if (end > start) ranges.push({ start: base + start, end: base + end, text: value.slice(start, end), allowEnter: canInsertLineBreak });
    };
    while (cursor < value.length) {
      const marker = quoteMarkerAt(value, cursor);
      if (marker !== null) { cursor = marker.end; continue; }
      if (value[cursor] === "`") {
        const end = value.indexOf("`", cursor + 1);
        if (end > cursor + 1) { cursor = end + 1; continue; }
      }
      if (value.startsWith("![[", cursor)) {
        const end = value.indexOf("]]", cursor + 3);
        if (end >= 0) { cursor = end + 2; continue; }
      }
      const image = /^!\[[^\]]*\]\([^\s)]+\)/u.exec(value.slice(cursor));
      if (image !== null) { cursor += image[0].length; continue; }
      const internal = parseInternalLinkAt(value, cursor);
      if (internal !== null) { cursor = internal.end; continue; }
      const link = /^\[([^\]]+)\]\(([^\s)]+)\)/u.exec(value.slice(cursor));
      const href = link === null ? null : safeExternalHref(link[2]);
      if (link !== null && href !== null) {
        // A generic external-link card is still an ordinary Markdown link:
        // only the label is editable, never its destination. Provider embeds
        // remain protected presentation structures.
        const embed = describeEmbed(href);
        if (embed === null || embed.kind === "generic-web") visit(link[1], base + cursor + 1, false);
        cursor += link[0].length;
        continue;
      }
      const wrapped = /^(\*\*|__|\*|_)([^\n]+?)\1/u.exec(value.slice(cursor));
      if (wrapped !== null && wrapped[2].length > 0) {
        visit(wrapped[2], base + cursor + wrapped[1].length, false);
        cursor += wrapped[0].length;
        continue;
      }
      const specials = ["`", "!", "[", "*", "_", "<"].map((character) => value.indexOf(character, cursor + 1)).filter((index) => index >= 0);
      const end = specials.length === 0 ? value.length : Math.min(...specials);
      push(cursor, end);
      cursor = end;
    }
  };
  visit(text, sourceStart);
  return Object.freeze(ranges);
}

interface PreviewSourceLineBreak {
  readonly start: number;
  readonly end: number;
}

interface PreviewBlockDescriptor {
  readonly start: number;
  readonly end: number;
  readonly editableRanges: readonly PreviewEditableTextRange[];
  readonly lineBreaks: readonly PreviewSourceLineBreak[];
}

/**
 * Renderer-local source descriptors in parsed-block order. All positions are
 * measured against the original UTF-16 source, including BOM and CRLF width.
 */
function collectPreviewBlockDescriptors(text: string, sourceOffset = 0): readonly PreviewBlockDescriptor[] {
  const lines = sourceLines(text, sourceOffset);
  const values = lines.map((line) => line.text);
  const blocks: PreviewBlockDescriptor[] = [];
  const push = (startIndex: number, endIndex: number, editableRanges: readonly PreviewEditableTextRange[], lineBreaks: readonly PreviewSourceLineBreak[] = []): void => {
    const first = lines[startIndex];
    const last = lines[endIndex];
    if (first === undefined || last === undefined) return;
    blocks.push(Object.freeze({
      start: first.sourceStart,
      end: last.end,
      editableRanges: Object.freeze([...editableRanges]),
      lineBreaks: Object.freeze([...lineBreaks])
    }));
  };
  let index = 0;
  while (index < lines.length) {
    const startIndex = index;
    const line = lines[index]!;
    if (line.text.trim().length === 0) { index += 1; continue; }
    const fence = openingMarkdownFence(line.text);
    if (fence !== null) {
      index += 1;
      while (index < lines.length && !isMarkdownFenceClosing(lines[index]!.text, fence)) index += 1;
      if (index < lines.length) index += 1;
      push(startIndex, index - 1, []);
      continue;
    }
    const heading = parseMarkdownHeading(line.text);
    if (heading !== null) {
      push(startIndex, startIndex, editableInlineRanges(heading.content, line.start + heading.contentStart, false));
      index += 1;
      continue;
    }
    if (isSyncedBlockStructuralLine(line.text)) {
      push(startIndex, startIndex, []);
      index += 1;
      continue;
    }
    const table = tableStart(values, index);
    if (table !== null) {
      const count = table.header.length;
      index += 2;
      while (index < lines.length) {
        if (isMarkdownTableTerminator(lines[index]!.text)) break;
        const row = parseTableRow(lines[index]!.text);
        if (row === null) break;
        index += 1;
        if (row.length < count) continue;
      }
      push(startIndex, Math.max(startIndex, index - 1), []);
      continue;
    }
    if (isMarkdownBlockquoteLine(line.text)) {
      const quote: SourceLine[] = [];
      while (index < lines.length && isMarkdownBlockquoteLine(lines[index]!.text)) quote.push(lines[index++]!);
      const first = quote[0];
      const prefix = first === undefined ? 0 : (/^>\s?/u.exec(first.text)?.[0].length ?? 1);
      push(startIndex, index - 1, quote.length === 1 && first !== undefined
        ? editableInlineRanges(first.text.slice(prefix), first.start + prefix, false)
        : []);
      continue;
    }
    const list = parseMarkdownListItem(line.text);
    if (list !== null) {
      const ordered = list.ordered;
      const regions: PreviewEditableTextRange[] = [];
      while (index < lines.length) {
        const item = parseMarkdownListItem(lines[index]!.text);
        if (item === null || item.ordered !== ordered) break;
        const source = lines[index]!;
        regions.push(...editableInlineRanges(item.content, source.start + item.contentStart, false));
        index += 1;
      }
      push(startIndex, index - 1, regions);
      continue;
    }
    const paragraph: SourceLine[] = [line];
    index += 1;
    while (index < lines.length && lines[index]!.text.trim().length > 0
      && openingMarkdownFence(lines[index]!.text) === null
      && parseMarkdownHeading(lines[index]!.text) === null
      && !isSyncedBlockStructuralLine(lines[index]!.text)
      && !isMarkdownBlockquoteLine(lines[index]!.text)
      && parseMarkdownListItem(lines[index]!.text) === null
      && tableStart(values, index) === null) paragraph.push(lines[index++]!);
    const lineBreaks = paragraph.slice(0, -1)
      .filter((source) => source.sourceEnd > source.end)
      .map((source) => Object.freeze({ start: source.end, end: source.sourceEnd }));
    push(startIndex, index - 1, paragraph.flatMap((source) => editableInlineRanges(source.text, source.start)), lineBreaks);
  }
  return Object.freeze(blocks);
}

/** Preserve the range projection API used by existing Preview consumers. */
export function collectEditablePreviewRanges(text: string, sourceOffset = 0): readonly (readonly PreviewEditableTextRange[])[] {
  return Object.freeze(collectPreviewBlockDescriptors(text, sourceOffset).map((block) => block.editableRanges));
}

interface EditableRenderState {
  readonly ranges: readonly PreviewEditableTextRange[];
  readonly lineBreaks: readonly PreviewSourceLineBreak[];
  readonly renderSourceLineBreaks: boolean;
  cursor: number;
  lineBreakCursor: number;
}

function sourceRangeAtSelection(element: HTMLElement): PreviewEditableTextRange | null {
  const selection = document.getSelection();
  const anchor = selection?.anchorNode;
  const focus = selection?.focusNode;
  if (selection === null || anchor === null || focus === null || anchor === undefined || focus === undefined
    || !element.contains(anchor) || !element.contains(focus)) return null;
  try {
    const offset = (node: Node, value: number): number => {
      const range = document.createRange();
      range.selectNodeContents(element);
      range.setEnd(node, value);
      return range.toString().length;
    };
    const startOffset = offset(anchor, selection.anchorOffset);
    const endOffset = offset(focus, selection.focusOffset);
    const start = Number(element.dataset.previewSourceStart);
    const end = Number(element.dataset.previewSourceEnd);
    const localStart = Math.min(startOffset, endOffset);
    const localEnd = Math.max(startOffset, endOffset);
    if (!Number.isInteger(start) || !Number.isInteger(end) || localEnd > end - start) return null;
    return {
      start: start + localStart,
      end: start + localEnd,
      text: (element.textContent ?? "").slice(localStart, localEnd)
    };
  } catch {
    return null;
  }
}

function installPreviewEnterHandling(
  element: HTMLElement,
  composition: PreviewCompositionGate,
  editable: PreviewEditableOptions,
  allowEnter: boolean
): void {
  let keyboardEnterHandled = false;
  const fallback = (): void => editable.onEnterFallback?.();
  const handle = (): void => {
    if (!allowEnter) { fallback(); return; }
    const range = sourceRangeAtSelection(element);
    if (range === null) { fallback(); return; }
    const revision = Number(element.dataset.previewRevision);
    const result = editable.onEdit({
      revision,
      range,
      replacement: editable.defaultLineEnding ?? "\n"
    });
    if (result.kind !== "applied") { fallback(); return; }
    element.dataset.previewSourceEnd = String(result.range.end);
    element.dataset.previewRevision = String(result.revision);
    editable.onEnterApplied?.({ revision: result.revision, offset: result.range.end });
  };
  element.addEventListener("beforeinput", (event) => {
    const input = event as InputEvent;
    if (input.inputType !== "insertParagraph" && input.inputType !== "insertLineBreak") return;
    if (input.isComposing || composition.isComposing) return;
    event.preventDefault();
    if (keyboardEnterHandled) {
      keyboardEnterHandled = false;
      return;
    }
    handle();
  });
  element.addEventListener("keydown", (event) => {
    if (event.keyCode === 229 || event.isComposing || composition.isComposing) return;
    if (event.key !== "Enter" || event.defaultPrevented) return;
    event.preventDefault();
    keyboardEnterHandled = true;
    queueMicrotask(() => { keyboardEnterHandled = false; });
    handle();
  });
}

function createEditableTextIsland(
  range: PreviewEditableTextRange,
  editable: PreviewEditableOptions,
  allowEnter = range.allowEnter === true
): HTMLSpanElement {
  const element = document.createElement("span");
  element.className = "markdown-preview-editable-text";
  element.contentEditable = "true";
  element.spellcheck = true;
  element.dataset.previewSourceStart = String(range.start);
  element.dataset.previewSourceEnd = String(range.end);
  element.dataset.previewRevision = String(editable.revision);
  element.textContent = range.text;
  const composition = new PreviewCompositionGate();
  const apply = (compositionFinal = false): void => {
    if (!compositionFinal && !composition.mayCommitInput()) return;
    const replacement = element.textContent ?? "";
    // New block structure is handled only by the explicit Enter transaction.
    if (/\r|\n/u.test(replacement)) return;
    const result = editable.onEdit({
      revision: Number(element.dataset.previewRevision),
      range: {
        start: Number(element.dataset.previewSourceStart),
        end: Number(element.dataset.previewSourceEnd),
        text: range.text
      },
      replacement
    });
    if (result.kind !== "applied") return;
    element.dataset.previewSourceEnd = String(result.range.end);
    element.dataset.previewRevision = String(result.revision);
  };
  element.addEventListener("compositionstart", () => composition.start());
  element.addEventListener("compositionend", () => { if (composition.end()) apply(true); });
  element.addEventListener("input", () => apply());
  element.addEventListener("focus", () => editable.onEditingChange?.(true));
  element.addEventListener("blur", () => editable.onEditingChange?.(false));
  installPreviewEnterHandling(element, composition, editable, allowEnter);
  return element;
}

function appendEditableText(
  parent: HTMLElement,
  text: string,
  state: EditableRenderState | undefined,
  options: MarkdownPreviewRenderOptions
): void {
  for (const part of text.split(/(\n)/u)) {
    if (part === "") continue;
    if (part === "\n") {
      // Editable prose displays hard-wrapped source lines without making the
      // separator part of any contenteditable island or serialized Markdown.
      if (state?.renderSourceLineBreaks === true) {
        const sourceBreak = state.lineBreaks[state.lineBreakCursor++];
        const lineBreak = document.createElement("br");
        lineBreak.contentEditable = "false";
        lineBreak.className = "markdown-preview-source-line-break";
        if (sourceBreak !== undefined) {
          lineBreak.dataset.previewSourceStart = String(sourceBreak.start);
          lineBreak.dataset.previewSourceEnd = String(sourceBreak.end);
        }
        parent.append(lineBreak);
      } else {
        parent.append(document.createTextNode(part));
      }
      continue;
    }
    const range = state?.ranges[state.cursor];
    if (range !== undefined && range.text === part && options.editable !== undefined) {
      state!.cursor += 1;
      parent.append(createEditableTextIsland(range, options.editable));
    } else {
      parent.append(document.createTextNode(part));
    }
  }
}

function appendEditableTableCell(
  parent: HTMLElement,
  nodes: readonly MarkdownInline[],
  cell: MarkdownTableCellTarget | undefined,
  options: MarkdownPreviewRenderOptions
): void {
  if (cell === undefined || options.editable === undefined || nodes.length !== 1 || nodes[0]?.kind !== "text" || nodes[0].text !== cell.value) {
    appendInlines(parent, nodes, options);
    return;
  }
  const editable = options.editable;
  const element = document.createElement("span");
  element.className = "markdown-preview-editable-text markdown-preview-editable-table-cell";
  element.contentEditable = "true";
  element.spellcheck = true;
  element.dataset.previewSourceStart = String(cell.start);
  element.dataset.previewSourceEnd = String(cell.end);
  element.dataset.previewRevision = String(editable.revision);
  element.textContent = cell.value;
  const composition = new PreviewCompositionGate();
  const apply = (compositionFinal = false): void => {
    if (!compositionFinal && !composition.mayCommitInput()) return;
    const value = element.textContent ?? "";
    if (/\r|\n/u.test(value)) return;
    const result = editable.onEdit({
      revision: Number(element.dataset.previewRevision),
      range: { start: Number(element.dataset.previewSourceStart), end: Number(element.dataset.previewSourceEnd), text: cell.value },
      replacement: escapeTableCell(value)
    });
    if (result.kind !== "applied") return;
    element.dataset.previewSourceEnd = String(result.range.end);
    element.dataset.previewRevision = String(result.revision);
  };
  element.addEventListener("compositionstart", () => composition.start());
  element.addEventListener("compositionend", () => { if (composition.end()) apply(true); });
  element.addEventListener("input", () => apply());
  element.addEventListener("focus", () => editable.onEditingChange?.(true));
  element.addEventListener("blur", () => editable.onEditingChange?.(false));
  installPreviewEnterHandling(element, composition, editable, false);
  parent.append(element);
}

function appendTrailingEditablePosition(
  root: HTMLElement,
  sourceText: string,
  lastBlock: MarkdownBlock | undefined,
  editable: PreviewEditableOptions
): HTMLParagraphElement {
  const element = document.createElement("p");
  element.className = "markdown-preview-editable-text markdown-preview-trailing-insertion";
  element.contentEditable = "true";
  element.spellcheck = true;
  element.setAttribute("role", "textbox");
  element.setAttribute("aria-label", "Add text after document");
  element.setAttribute("aria-multiline", "true");
  element.dataset.previewSourceStart = String(sourceText.length);
  element.dataset.previewSourceEnd = String(sourceText.length);
  element.dataset.previewRevision = String(editable.revision);
  const restoredAtEnd = editable.restoreCaretOffset === sourceText.length;
  element.dataset.previewTrailingActive = String(restoredAtEnd);

  const composition = new PreviewCompositionGate();
  const placeCaretAtEnd = (): void => {
    const selection = document.getSelection();
    if (selection === null) return;
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  };
  const activate = (): boolean => {
    if (element.dataset.previewTrailingActive === "true") return true;
    const separator = minimumPreviewTrailingSeparator(sourceText, lastBlock, editable.defaultLineEnding);
    let insertionOffset = sourceText.length;
    if (separator.length > 0) {
      const result = editable.onEdit({
        revision: Number(element.dataset.previewRevision),
        range: { start: sourceText.length, end: sourceText.length, text: "" },
        replacement: separator
      });
      if (result.kind !== "applied") return false;
      insertionOffset = result.range.end;
      element.dataset.previewRevision = String(result.revision);
    }
    element.dataset.previewSourceStart = String(insertionOffset);
    element.dataset.previewSourceEnd = String(insertionOffset);
    element.dataset.previewTrailingActive = "true";
    editable.onSelectionChange?.({ start: insertionOffset, end: insertionOffset });
    placeCaretAtEnd();
    return true;
  };
  const apply = (compositionFinal = false): void => {
    if (element.dataset.previewTrailingActive !== "true"
      || (!compositionFinal && !composition.mayCommitInput())) return;
    const replacement = element.textContent ?? "";
    if (/\r|\n/u.test(replacement)) return;
    const start = Number(element.dataset.previewSourceStart);
    const result = editable.onEdit({
      revision: Number(element.dataset.previewRevision),
      range: { start, end: Number(element.dataset.previewSourceEnd), text: "" },
      replacement
    });
    if (result.kind !== "applied") return;
    element.dataset.previewSourceEnd = String(result.range.end);
    element.dataset.previewRevision = String(result.revision);
  };
  element.addEventListener("compositionstart", () => composition.start());
  element.addEventListener("compositionend", () => { if (composition.end()) apply(true); });
  element.addEventListener("input", () => apply());
  element.addEventListener("focus", () => {
    editable.onEditingChange?.(true);
    activate();
  });
  element.addEventListener("blur", () => editable.onEditingChange?.(false));
  element.addEventListener("click", () => {
    if (document.activeElement !== element) element.focus();
    if (element.dataset.previewTrailingActive !== "true") activate();
  });
  installPreviewEnterHandling(element, composition, editable, true);
  root.append(element);
  return element;
}

function addRendererOnlyCaretIsland(
  root: HTMLElement,
  trailing: HTMLElement,
  offset: number,
  editable: PreviewEditableOptions
): HTMLElement {
  const block = document.createElement("p");
  block.className = "markdown-prose markdown-preview-empty-line";
  const island = createEditableTextIsland({ start: offset, end: offset, text: "", allowEnter: true }, editable, true);
  island.dataset.previewCaretOnly = "true";
  block.append(island);
  const nextBlock = Array.from(root.children).find((candidate) => {
    if (candidate === trailing) return false;
    const sourceStart = Number((candidate as HTMLElement).dataset.previewBlockSourceStart);
    return Number.isInteger(sourceStart) && sourceStart >= offset;
  });
  root.insertBefore(block, nextBlock ?? trailing);
  return island;
}

function restorePreviewCaret(
  root: HTMLElement,
  trailing: HTMLElement,
  offset: number,
  editable: PreviewEditableOptions
): void {
  const candidates = Array.from(root.querySelectorAll<HTMLElement>(".markdown-preview-editable-text"))
    .filter((item) => item.dataset.previewRevision === String(editable.revision))
    .filter((item) => {
      const start = Number(item.dataset.previewSourceStart);
      const end = Number(item.dataset.previewSourceEnd);
      return Number.isInteger(start) && Number.isInteger(end) && start <= offset && offset <= end;
    })
    .sort((left, right) => {
      const leftStart = Number(left.dataset.previewSourceStart);
      const rightStart = Number(right.dataset.previewSourceStart);
      return Number(rightStart === offset) - Number(leftStart === offset);
    });
  const target = candidates[0] ?? addRendererOnlyCaretIsland(root, trailing, offset, editable);
  target.focus();
  const selection = document.getSelection();
  if (selection !== null) {
    const range = document.createRange();
    const start = Number(target.dataset.previewSourceStart);
    const localOffset = Math.max(0, Math.min(offset - start, (target.textContent ?? "").length));
    if (target.firstChild?.nodeType === Node.TEXT_NODE) {
      range.setStart(target.firstChild, localOffset);
    } else {
      range.setStart(target, 0);
    }
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  editable.onSelectionChange?.({ start: offset, end: offset });
}

function appendTableControls(parent: HTMLElement, target: MarkdownTableTarget, currentCell: () => MarkdownTableCellTarget | undefined, options: MarkdownPreviewRenderOptions): void {
  if (options.onTableCommand === undefined) return;
  const controls = document.createElement("div");
  controls.className = "markdown-table-controls";
  controls.setAttribute("aria-label", "Table controls");
  const buttons = new Map<string, HTMLButtonElement>();
  const refreshAvailability = (): void => {
    const cell = currentCell();
    const headerCell = cell?.rowKind === "header";
    buttons.get("maginalia.table.addRowAbove")!.disabled = headerCell || cell === undefined;
    buttons.get("maginalia.table.addRowBelow")!.disabled = cell === undefined;
    buttons.get("maginalia.table.deleteRow")!.disabled = !cell || headerCell;
    buttons.get("maginalia.table.addColumnBefore")!.disabled = cell === undefined;
    buttons.get("maginalia.table.addColumnAfter")!.disabled = cell === undefined;
    buttons.get("maginalia.table.deleteColumn")!.disabled = cell === undefined || target.header.length <= 1;
  };
  for (const [id, label] of [
    ["maginalia.table.addRowAbove", "Add row above"],
    ["maginalia.table.addRowBelow", "Add row below"],
    ["maginalia.table.deleteRow", "Delete row"],
    ["maginalia.table.addColumnBefore", "Add column before"],
    ["maginalia.table.addColumnAfter", "Add column after"],
    ["maginalia.table.deleteColumn", "Delete column"]
  ] as const) {
    const button = document.createElement("button");
    button.type = "button"; button.textContent = label; button.dataset.commandId = id;
    button.addEventListener("click", () => {
      const cell = currentCell();
      if (cell !== undefined) options.onTableCommand?.(id, target, cell);
    });
    buttons.set(id, button);
    controls.append(button);
  }
  parent.addEventListener("mouseover", refreshAvailability);
  controls.addEventListener("focusin", refreshAvailability);
  refreshAvailability();
  parent.append(controls);
}

function appendInlines(
  parent: HTMLElement,
  nodes: readonly MarkdownInline[],
  options: MarkdownPreviewRenderOptions,
  editableState?: EditableRenderState
): void {
  for (const node of nodes) {
    switch (node.kind) {
      case "text": appendEditableText(parent, node.text, editableState, options); break;
      case "code": {
        const code = document.createElement("code"); code.textContent = node.text; parent.append(code); break;
      }
      case "strong": {
        const element = document.createElement("strong"); appendInlines(element, node.children, options, editableState); parent.append(element); break;
      }
      case "emphasis": {
        const element = document.createElement("em"); appendInlines(element, node.children, options, editableState); parent.append(element); break;
      }
      case "link": {
        if (node.embed !== undefined) {
          const card = document.createElement("span");
          card.className = `rendered-embed-card ${node.embed.kind}`;
          card.dataset.embedKind = node.embed.kind;
          const label = document.createElement("span");
          appendInlines(label, node.label, options, editableState);
          card.append(label);
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = "Open externally";
          button.addEventListener("click", () => options.onOpenExternal?.(node.href));
          card.append(button);
          parent.append(card);
        } else {
          const link = document.createElement("a");
          link.href = node.href; link.rel = "noreferrer noopener"; link.target = "_blank";
          link.addEventListener("click", (event) => {
            if (event.target instanceof Element && event.target.closest(".markdown-preview-editable-text") !== null) event.preventDefault();
          });
          appendInlines(link, node.label, options, editableState); parent.append(link);
        }
        break;
      }
      case "internal-link": {
        const link = document.createElement("span");
        link.className = `rendered-internal-link ${node.state}`;
        link.dataset.internalLinkState = node.state;
        if (node.state === "unresolved") link.title = "Linked document unavailable";
        if (node.state === "resolved" && node.fileId !== undefined) {
          link.dataset.internalLinkTarget = node.target;
          link.addEventListener("dblclick", (event) => {
            event.preventDefault();
            options.onOpenInternal?.({ target: node.target, fileId: node.fileId as string });
          });
        }
        appendInlines(link, node.label, options, editableState);
        parent.append(link);
        break;
      }
      case "local-media": {
        if (node.media.state !== "resolved" || node.media.dataUrl === undefined || node.media.assetKind === undefined) {
          const unavailable = document.createElement("span");
          unavailable.className = "rendered-local-media unresolved";
          unavailable.textContent = node.media.reason ?? `Media unavailable: ${node.target}`;
          parent.append(unavailable);
          break;
        }
        if (node.media.assetKind === "image") {
          const image = document.createElement("img");
          image.className = "rendered-local-media";
          image.src = node.media.dataUrl;
          image.alt = node.alt;
          image.loading = "lazy";
          image.decoding = "async";
          parent.append(image);
        } else {
          const video = document.createElement("video");
          video.className = "rendered-local-media";
          video.src = node.media.dataUrl;
          video.controls = true;
          video.preload = "metadata";
          video.setAttribute("playsinline", "");
          parent.append(video);
        }
        break;
      }
      case "quote-ref": {
        const quote = document.createElement("aside");
        quote.className = `rendered-quote-ref ${node.quote.state}`;
        quote.dataset.quoteState = node.quote.state;
        if (node.quote.state === "resolved" && node.quote.text !== undefined) {
          const body = document.createElement("blockquote"); body.textContent = node.quote.text; quote.append(body);
          if (node.quote.provenance) { const cue = document.createElement("p"); cue.className = "quote-provenance"; cue.textContent = node.quote.provenance; quote.append(cue); }
        } else {
          quote.textContent = node.quote.reason ?? "Quotation unresolved.";
        }
        parent.append(quote); break;
      }
    }
  }
}

export function renderMarkdownPreview(
  container: HTMLElement,
  text: string,
  quotes: PreviewQuoteMap = new Map(),
  direction: WritingDirection = "horizontal",
  options: MarkdownPreviewRenderOptions = {},
  internalLinks: PreviewInternalLinkMap = new Map(),
  media: PreviewMediaMap = new Map()
): void {
  const projection = projectMarkdownPreviewSource(text, options.sourceMode);
  const root = document.createElement("article");
  root.className = "markdown-preview-document";
  root.dataset.writingDirection = direction;
  const blockDescriptors = collectPreviewBlockDescriptors(projection.body, projection.start);
  const tablesByBlock = options.editable === undefined ? [] : collectMarkdownTables(projection.body, projection.start);
  let tableIndex = 0;
  let lastRenderedBlock: HTMLElement | undefined;
  let trailingEditable: HTMLParagraphElement | undefined;
  const blocks = parseMarkdownBlocks(projection.body, quotes, internalLinks, media);
  blocks.forEach((block, blockIndex) => {
    const descriptor = blockDescriptors[blockIndex];
    const editableState = options.editable === undefined || descriptor === undefined ? undefined : {
      ranges: descriptor.editableRanges,
      lineBreaks: descriptor.lineBreaks,
      renderSourceLineBreaks: block.kind === "paragraph" && block.presentation === "prose",
      cursor: 0,
      lineBreakCursor: 0
    };
    let element: HTMLElement;
    switch (block.kind) {
      case "heading": element = document.createElement(`h${block.depth}`); appendInlines(element, block.content, options, editableState); break;
      case "paragraph": {
        element = document.createElement(block.presentation === "prose" ? "p" : "div");
        element.className = block.presentation === "prose" ? "markdown-prose" : "markdown-structural-paragraph";
        appendInlines(element, block.content, options, editableState);
        break;
      }
      case "blockquote": element = document.createElement("blockquote"); appendInlines(element, block.content, options, editableState); break;
      case "code": element = document.createElement("pre"); element.textContent = block.text; break;
      case "list": {
        element = document.createElement(block.ordered ? "ol" : "ul");
        for (const item of block.items) { const li = document.createElement("li"); appendInlines(li, item, options, editableState); element.append(li); }
        break;
      }
      case "synced-block": {
        const resolved = options.syncedBlocks?.get(block.marker);
        element = document.createElement("section");
        element.className = "rendered-synced-block";
        element.dataset.syncedBlockState = resolved?.kind ?? (block.valid ? "unresolved" : "invalid");
        const header = document.createElement("header");
        header.className = "rendered-synced-block-header";
        const label = document.createElement("span");
        label.textContent = resolved?.displayName ?? resolved?.target ?? "Synced document";
        header.append(label);
        if (resolved?.kind === "resolved" && resolved.fileId !== undefined && resolved.target !== undefined) {
          const open = document.createElement("button");
          open.type = "button";
          open.className = "rendered-synced-block-open-source";
          open.textContent = "Open source";
          open.addEventListener("click", () => options.onOpenSyncedBlock?.({ fileId: resolved.fileId!, target: resolved.target! }));
          header.append(open);
        }
        element.append(header);
        if (resolved?.kind === "resolved" && resolved.markdown !== undefined) {
          const content = document.createElement("div");
          content.className = "rendered-synced-block-content";
          // Child projections are deliberately read-only in their parent. They
          // receive ordinary rendering callbacks but never parent source maps
          // or table targets.
          renderMarkdownPreview(content, resolved.markdown, resolved.quotes ?? quotes, direction, {
            sourceMode: "already-projected",
            onOpenExternal: options.onOpenExternal,
            onOpenInternal: options.onOpenInternal,
            onOpenSyncedBlock: options.onOpenSyncedBlock,
            syncedBlocks: resolved.children,
          }, resolved.internalLinks, resolved.media);
          element.append(content);
        } else {
          const message = document.createElement("p");
          message.className = "rendered-synced-block-message";
          message.textContent = resolved?.message ?? (block.valid ? "Synced document unavailable." : "Synced Block marker is invalid.");
          element.append(message);
        }
        break;
      }
      case "table": {
        const tableTarget = tablesByBlock[tableIndex++];
        let selectedTableCell = tableTarget?.cells[0];
        element = document.createElement("div");
        element.className = "markdown-table-wrapper";
        const table = document.createElement("table");
        table.className = "markdown-table";
        const head = document.createElement("thead");
        const headerRow = document.createElement("tr");
        block.header.forEach((cell, index) => {
          const header = document.createElement("th");
          header.scope = "col";
          header.dataset.alignment = block.alignments[index];
          const targetCell = tableTarget?.cells.find((candidate) => candidate.rowKind === "header" && candidate.columnIndex === index);
          if (tableTarget !== undefined && targetCell !== undefined) {
            header.addEventListener("focusin", () => { selectedTableCell = targetCell; options.onTableTarget?.(tableTarget, targetCell); });
            header.addEventListener("mouseenter", () => { selectedTableCell = targetCell; options.onTableTarget?.(tableTarget, targetCell); });
          }
          appendEditableTableCell(header, cell, targetCell, options);
          headerRow.append(header);
        });
        head.append(headerRow);
        table.append(head);
        const body = document.createElement("tbody");
        for (const [rowIndex, cells] of block.rows.entries()) {
          const row = document.createElement("tr");
          cells.forEach((cell, index) => {
            const data = document.createElement("td");
            data.dataset.alignment = block.alignments[index];
            const targetCell = tableTarget?.cells.find((candidate) => candidate.rowKind === "body" && candidate.rowIndex === rowIndex && candidate.columnIndex === index);
            if (tableTarget !== undefined && targetCell !== undefined) {
              data.addEventListener("focusin", () => { selectedTableCell = targetCell; options.onTableTarget?.(tableTarget, targetCell); });
              data.addEventListener("mouseenter", () => { selectedTableCell = targetCell; options.onTableTarget?.(tableTarget, targetCell); });
            }
            appendEditableTableCell(data, cell, targetCell, options);
            row.append(data);
          });
          body.append(row);
        }
        table.append(body);
        element.append(table);
        if (tableTarget !== undefined) appendTableControls(element, tableTarget, () => selectedTableCell, options);
        break;
      }
    }
    if (descriptor !== undefined) {
      element.dataset.previewBlockSourceStart = String(descriptor.start);
      element.dataset.previewBlockSourceEnd = String(descriptor.end);
    }
    root.append(element);
    lastRenderedBlock = element;
  });
  if (options.editable !== undefined) {
    const trailing = appendTrailingEditablePosition(root, text, blocks.at(-1), options.editable);
    trailingEditable = trailing;
    root.addEventListener("click", (event) => {
      if (event.target !== root) return;
      const lastBounds = lastRenderedBlock?.getBoundingClientRect();
      const afterLastBlock = lastBounds === undefined || (direction === "vertical"
        ? event.clientX <= lastBounds.left
        : event.clientY >= lastBounds.bottom);
      if (afterLastBlock && !trailing.contains(document.activeElement)) trailing.click();
    });
    const selection = (): void => {
      const selected = document.getSelection();
      if (selected === null) {
        options.editable?.onSelectionChange?.(null);
        return;
      }
      const anchor = selected.anchorNode;
      const focus = selected.focusNode;
      const anchorElement = anchor instanceof Element ? anchor.closest(".markdown-preview-editable-text") : anchor?.parentElement?.closest(".markdown-preview-editable-text");
      const focusElement = focus instanceof Element ? focus.closest(".markdown-preview-editable-text") : focus?.parentElement?.closest(".markdown-preview-editable-text");
      if (!(anchorElement instanceof HTMLElement) || anchorElement !== focusElement || anchor === null || focus === null) {
        options.editable?.onSelectionChange?.(null);
        return;
      }
      const offset = (node: Node, value: number): number => {
        const range = document.createRange();
        range.setStart(anchorElement, 0);
        range.setEnd(node, value);
        return range.toString().length;
      };
      try {
        const base = Number(anchorElement.dataset.previewSourceStart);
        const start = base + offset(anchor, selected.anchorOffset);
        const end = base + offset(focus, selected.focusOffset);
        options.editable?.onSelectionChange?.({ start: Math.min(start, end), end: Math.max(start, end) });
      } catch { options.editable?.onSelectionChange?.(null); }
    };
    root.addEventListener("mouseup", selection);
    root.addEventListener("keyup", selection);
    root.addEventListener("focusin", selection);
  }
  container.replaceChildren(root);
  if (options.editable !== undefined && options.editable.restoreCaretOffset !== undefined && trailingEditable !== undefined) {
    restorePreviewCaret(root, trailingEditable, options.editable.restoreCaretOffset, options.editable);
  }
}

function clean(value: string | null | undefined): string {
  return value?.replace(/[\u0000-\u001F\u007F]/gu, " ").replace(/\s+/gu, " ").trim() ?? "";
}

/** Map the existing Reviewer-resolution result to a renderer-only display model. */
export function createPreviewQuoteMap(
  resolved: readonly ResolvedQuoteRef[],
  unresolved: readonly UnresolvedQuoteRef[],
  failureMessage?: string
): PreviewQuoteMap {
  const quotes = new Map<string, PreviewQuote>();
  for (const item of resolved) {
    const authors = item.quotation.authors.map(clean).filter(Boolean).join("、");
    const title = clean(item.quotation.title);
    const page = clean(item.quotation.pageLabel);
    const cue = [authors, title ? `『${title}』` : "", page ? `p.${page}` : ""].filter(Boolean).join("、");
    quotes.set(item.occurrence.marker, Object.freeze({ state: "resolved", text: item.quotation.quote, provenance: cue || undefined }));
  }
  for (const item of unresolved) {
    quotes.set(item.occurrence.marker, Object.freeze({ state: "unresolved", reason: "Quotation unresolved." }));
  }
  if (failureMessage !== undefined) {
    // Resolution errors affect only visible QuoteRef placeholders, never the rest of the document.
    for (const block of scanQuoteMarkersFromText([...quotes.keys()].join("\n"))) {
      if (!quotes.has(block)) quotes.set(block, Object.freeze({ state: "unresolved", reason: failureMessage }));
    }
  }
  return quotes;
}

export function scanQuoteMarkersFromText(text: string): readonly string[] {
  const markers: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(QUOTE_MARKER_PREFIX, cursor);
    if (start < 0) break;
    const marker = quoteMarkerAt(text, start);
    if (marker === null) break;
    markers.push(marker.marker);
    cursor = marker.end;
  }
  return Object.freeze(markers);
}
