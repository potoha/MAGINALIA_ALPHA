import type { ResolvedQuoteRef, UnresolvedQuoteRef } from "../reviewer-resolution";
import type { WritingDirection } from "./renderer-preferences";
import { describeEmbed, parseSafeExternalUrl, type EmbedDescriptor } from "./embed-providers";
import { internalLinkDisplayName, parseInternalLinkAt } from "../project-links";
import { PreviewCompositionGate } from "./preview-editing";
import { collectMarkdownTables, escapeTableCell, isMarkdownTableTerminator, type MarkdownTableCellTarget, type MarkdownTableTarget } from "./markdown-table-commands";
import { projectMarkdownBody } from "./document-properties";
import { isMarkdownFenceClosing, openingMarkdownFence } from "./markdown-fence";
import { isMarkdownBlockquoteLine, parseMarkdownHeading, parseMarkdownListItem } from "./markdown-structure";
import { isSyncedBlockStructuralLine, parseSyncedBlockMarker, type ComposedSyncedBlock } from "./synced-block";

/** Safe, typed inline nodes.  Raw HTML is always plain text. */
export type MarkdownInline =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "strong"; readonly children: readonly MarkdownInline[] }
  | { readonly kind: "emphasis"; readonly children: readonly MarkdownInline[] }
  | { readonly kind: "link"; readonly label: readonly MarkdownInline[]; readonly href: string; readonly embed?: EmbedDescriptor }
  | { readonly kind: "internal-link"; readonly target: string; readonly label: readonly MarkdownInline[]; readonly state: "resolved" | "unresolved"; readonly fileId?: string }
  | { readonly kind: "local-media"; readonly target: string; readonly alt: string; readonly media: PreviewMedia }
  | { readonly kind: "quote-ref"; readonly marker: string; readonly quote: PreviewQuote };

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

export interface PreviewQuote {
  readonly state: "resolved" | "unresolved";
  readonly text?: string;
  readonly provenance?: string;
  readonly reason?: string;
}

export type PreviewQuoteMap = ReadonlyMap<string, PreviewQuote>;
export type PreviewInternalLinkMap = ReadonlyMap<string, { readonly fileId?: string }>;
export interface PreviewMedia {
  readonly state: "resolved" | "unresolved";
  readonly assetKind?: "image" | "video";
  readonly mimeType?: string;
  readonly dataUrl?: string;
  readonly reason?: string;
}
export type PreviewMediaMap = ReadonlyMap<string, PreviewMedia>;

const QUOTE_MARKER_PREFIX = "<!-- maginalia:quote-ref ";
const QUOTE_MARKER_END = "-->";

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

function safeExternalHref(value: string): string | null {
  return parseSafeExternalUrl(value)?.href ?? null;
}

function localMediaTarget(value: string): string | null {
  if (value.length === 0 || value.length > 1_024 || value.includes("\\") || /[\u0000-\u001F\u007F]/u.test(value)) return null;
  if (/^(?:[A-Za-z]:|\/|file:|data:|javascript:)/iu.test(value)) return null;
  const segments = value.split("/");
  if (segments.some((part) => part.length === 0 || part === "." || part === "..")) return null;
  return segments.join("/");
}

function localMedia(
  target: string,
  alt: string,
  media: PreviewMediaMap
): MarkdownInline {
  return {
    kind: "local-media",
    target,
    alt,
    media: media.get(target) ?? { state: "unresolved", reason: "Project media unavailable." }
  };
}

function quoteMarkerAt(text: string, start: number): { readonly marker: string; readonly end: number } | null {
  if (!text.startsWith(QUOTE_MARKER_PREFIX, start)) return null;
  const close = text.indexOf(QUOTE_MARKER_END, start + QUOTE_MARKER_PREFIX.length);
  if (close < 0) return { marker: text.slice(start), end: text.length };
  return { marker: text.slice(start, close + QUOTE_MARKER_END.length), end: close + QUOTE_MARKER_END.length };
}

/**
 * A deliberately small Markdown AST for the renderer.  It creates text nodes
 * rather than HTML strings, so authoring HTML/comments can never execute.
 */
export function parseMarkdownInlines(
  text: string,
  quotes: PreviewQuoteMap = new Map(),
  internalLinks: PreviewInternalLinkMap = new Map(),
  media: PreviewMediaMap = new Map()
): readonly MarkdownInline[] {
  const nodes: MarkdownInline[] = [];
  let cursor = 0;
  const pushText = (value: string): void => {
    if (value.length > 0) nodes.push({ kind: "text", text: value });
  };

  while (cursor < text.length) {
    const marker = quoteMarkerAt(text, cursor);
    if (marker !== null) {
      nodes.push({
        kind: "quote-ref",
        marker: marker.marker,
        quote: quotes.get(marker.marker) ?? { state: "unresolved", reason: "Quotation unresolved." }
      });
      cursor = marker.end;
      continue;
    }
    if (text[cursor] === "`") {
      const end = text.indexOf("`", cursor + 1);
      if (end > cursor + 1) {
        nodes.push({ kind: "code", text: text.slice(cursor + 1, end) });
        cursor = end + 1;
        continue;
      }
    }
    // The canonical Project-asset notation. It is never treated as a wiki
    // link, and the renderer still needs a main-process-approved media map.
    if (text.startsWith("![[", cursor)) {
      const close = text.indexOf("]]", cursor + 3);
      if (close >= 0) {
        const target = localMediaTarget(text.slice(cursor + 3, close));
        if (target === null) pushText(text.slice(cursor, close + 2));
        else nodes.push(localMedia(target, target.split("/").at(-1) ?? "media", media));
        cursor = close + 2;
        continue;
      }
    }
    // Compatibility input for normal Markdown Project-relative images.
    const image = /^!\[([^\]]*)\]\(([^\s)]+)\)/u.exec(text.slice(cursor));
    if (image !== null) {
      const target = localMediaTarget(image[2]);
      if (target !== null) {
        nodes.push(localMedia(target, image[1], media));
        cursor += image[0].length;
        continue;
      }
    }
    const internal = parseInternalLinkAt(text, cursor);
    if (internal !== null) {
      if (internal.kind === "link") {
        const resolved = internalLinks.get(internal.target);
        const label = internal.label ?? internalLinkDisplayName(internal.target);
        nodes.push({
          kind: "internal-link",
          target: internal.target,
          label: parseMarkdownInlines(label, quotes, internalLinks, media),
          state: resolved?.fileId === undefined ? "unresolved" : "resolved",
          ...(resolved?.fileId === undefined ? {} : { fileId: resolved.fileId })
        });
      } else {
        nodes.push({ kind: "text", text: "unresolved link" });
      }
      cursor = internal.end;
      continue;
    }
    const link = /^\[([^\]]+)\]\(([^\s)]+)\)/u.exec(text.slice(cursor));
    if (link !== null) {
      const href = safeExternalHref(link[2]);
      if (href !== null) {
        const embed = describeEmbed(href);
        nodes.push({ kind: "link", label: parseMarkdownInlines(link[1], quotes, internalLinks, media), href, ...(embed === null ? {} : { embed }) });
        cursor += link[0].length;
        continue;
      }
    }
    const wrapped = /^(\*\*|__|\*|_)([^\n]+?)\1/u.exec(text.slice(cursor));
    if (wrapped !== null && wrapped[2].length > 0) {
      nodes.push({
        kind: wrapped[1].length === 2 ? "strong" : "emphasis",
        children: parseMarkdownInlines(wrapped[2], quotes, internalLinks, media)
      });
      cursor += wrapped[0].length;
      continue;
    }
    const nextSpecial = [
      text.indexOf("`", cursor + 1),
      text.indexOf("!", cursor + 1),
      text.indexOf("[", cursor + 1),
      text.indexOf("*", cursor + 1),
      text.indexOf("_", cursor + 1),
      text.indexOf(QUOTE_MARKER_PREFIX, cursor + 1)
    ].filter((value) => value >= 0);
    const end = nextSpecial.length === 0 ? text.length : Math.min(...nextSpecial);
    pushText(text.slice(cursor, end));
    cursor = end;
  }
  return Object.freeze(nodes);
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
}

export interface PreviewEditableOptions {
  readonly revision: number;
  readonly onEdit: (request: { readonly revision: number; readonly range: PreviewEditableTextRange; readonly replacement: string }) =>
    | { readonly kind: "applied"; readonly revision: number; readonly range: { readonly start: number; readonly end: number } }
    | { readonly kind: "error" };
  readonly onEditingChange?: (editing: boolean) => void;
  readonly onSelectionChange?: (range: { readonly start: number; readonly end: number } | null) => void;
}

interface SourceLine { readonly text: string; readonly start: number; }

function sourceLines(text: string, sourceOffset = 0): readonly SourceLine[] {
  const lines: SourceLine[] = [];
  let cursor = 0;
  while (cursor <= text.length) {
    const newline = text.indexOf("\n", cursor);
    const rawEnd = newline < 0 ? text.length : newline;
    const end = rawEnd > cursor && text[rawEnd - 1] === "\r" ? rawEnd - 1 : rawEnd;
    const bom = sourceOffset === 0 && cursor === 0 && text.startsWith("\uFEFF") ? 1 : 0;
    lines.push({ text: text.slice(cursor + bom, end), start: sourceOffset + cursor + bom });
    if (newline < 0) break;
    cursor = newline + 1;
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
function editableInlineRanges(text: string, sourceStart: number): readonly PreviewEditableTextRange[] {
  // Raw HTML/comments, QuoteRefs, media and code remain protected in H.7.2.
  if (/<(?:!--|\/?[A-Za-z])/u.test(text)) return [];
  const ranges: PreviewEditableTextRange[] = [];
  const visit = (value: string, base: number): void => {
    let cursor = 0;
    const push = (start: number, end: number): void => {
      if (end > start) ranges.push({ start: base + start, end: base + end, text: value.slice(start, end) });
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
        if (embed === null || embed.kind === "generic-web") visit(link[1], base + cursor + 1);
        cursor += link[0].length;
        continue;
      }
      const wrapped = /^(\*\*|__|\*|_)([^\n]+?)\1/u.exec(value.slice(cursor));
      if (wrapped !== null && wrapped[2].length > 0) {
        visit(wrapped[2], base + cursor + wrapped[1].length);
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

/**
 * Renderer-local source maps in rendered-block order.  It reads original
 * UTF-16 source offsets (including BOM/CRLF), never normalized preview text.
 */
export function collectEditablePreviewRanges(text: string, sourceOffset = 0): readonly (readonly PreviewEditableTextRange[])[] {
  const lines = sourceLines(text, sourceOffset);
  const values = lines.map((line) => line.text);
  const blocks: (readonly PreviewEditableTextRange[])[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.text.trim().length === 0) { index += 1; continue; }
    const fence = openingMarkdownFence(line.text);
    if (fence !== null) {
      index += 1;
      while (index < lines.length && !isMarkdownFenceClosing(lines[index]!.text, fence)) index += 1;
      if (index < lines.length) index += 1;
      blocks.push(Object.freeze([]));
      continue;
    }
    const heading = parseMarkdownHeading(line.text);
    if (heading !== null) {
      blocks.push(editableInlineRanges(heading.content, line.start + heading.contentStart));
      index += 1;
      continue;
    }
    if (isSyncedBlockStructuralLine(line.text)) {
      blocks.push(Object.freeze([]));
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
      blocks.push(Object.freeze([]));
      continue;
    }
    if (line.text.startsWith(">")) {
      const quote: SourceLine[] = [];
      while (index < lines.length && lines[index]!.text.startsWith(">")) quote.push(lines[index++]!);
      const first = quote[0];
      const prefix = first === undefined ? 0 : (/^>\s?/u.exec(first.text)?.[0].length ?? 1);
      blocks.push(quote.length === 1 && first !== undefined
        ? editableInlineRanges(first.text.slice(prefix), first.start + prefix)
        : Object.freeze([]));
      continue;
    }
    const list = /^(?:([-*+])\s+|(\d+)\.\s+)(.+)$/u.exec(line.text);
    if (list !== null) {
      const ordered = list[2] !== undefined;
      const regions: PreviewEditableTextRange[] = [];
      while (index < lines.length) {
        const item = /^(?:([-*+])\s+|(\d+)\.\s+)(.+)$/u.exec(lines[index]!.text);
        if (item === null || (item[2] !== undefined) !== ordered) break;
        const source = lines[index]!;
        regions.push(...editableInlineRanges(item[3], source.start + item[0].length - item[3].length));
        index += 1;
      }
      blocks.push(Object.freeze(regions));
      continue;
    }
    const paragraph: SourceLine[] = [line];
    index += 1;
    while (index < lines.length && lines[index]!.text.trim().length > 0
      && openingMarkdownFence(lines[index]!.text) === null
      && !/^(#{1,6})\s+/u.test(lines[index]!.text)
      && !isSyncedBlockStructuralLine(lines[index]!.text)
      && !lines[index]!.text.startsWith(">")
      && !/^(?:[-*+]\s+|\d+\.\s+)/u.test(lines[index]!.text)
      && tableStart(values, index) === null) paragraph.push(lines[index++]!);
    // A hard-wrapped paragraph contains non-contiguous source gaps; leave it
    // protected rather than normalize its line endings or Markdown layout.
    blocks.push(paragraph.length === 1 ? editableInlineRanges(line.text, line.start) : Object.freeze([]));
  }
  return Object.freeze(blocks);
}

interface EditableRenderState {
  readonly ranges: readonly PreviewEditableTextRange[];
  cursor: number;
}

function appendEditableText(
  parent: HTMLElement,
  text: string,
  state: EditableRenderState | undefined,
  options: MarkdownPreviewRenderOptions
): void {
  const range = state?.ranges[state.cursor];
  if (range === undefined || range.text !== text || options.editable === undefined) {
    parent.append(document.createTextNode(text));
    return;
  }
  if (state !== undefined) state.cursor += 1;
  const editable = options.editable;
  const element = document.createElement("span");
  element.className = "markdown-preview-editable-text";
  element.contentEditable = "true";
  element.spellcheck = true;
  element.dataset.previewSourceStart = String(range.start);
  element.dataset.previewSourceEnd = String(range.end);
  element.dataset.previewRevision = String(editable.revision);
  element.textContent = text;
  const composition = new PreviewCompositionGate();
  const apply = (compositionFinal = false): void => {
    if (!compositionFinal && !composition.mayCommitInput()) return;
    const replacement = element.textContent ?? "";
    // New block structure needs Edit mode; a text island never guesses it.
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
  parent.append(element);
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
  parent.append(element);
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
  const rangesByBlock = options.editable === undefined ? [] : collectEditablePreviewRanges(projection.body, projection.start);
  const tablesByBlock = options.editable === undefined ? [] : collectMarkdownTables(projection.body, projection.start);
  let tableIndex = 0;
  const blocks = parseMarkdownBlocks(projection.body, quotes, internalLinks, media);
  blocks.forEach((block, blockIndex) => {
    const editableState = options.editable === undefined ? undefined : { ranges: rangesByBlock[blockIndex] ?? [], cursor: 0 };
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
    root.append(element);
  });
  if (options.editable !== undefined) {
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
