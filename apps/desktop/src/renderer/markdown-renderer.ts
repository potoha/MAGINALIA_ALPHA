import type { ResolvedQuoteRef, UnresolvedQuoteRef } from "../reviewer-resolution";
import type { WritingDirection } from "./renderer-preferences";
import { describeEmbed, parseSafeExternalUrl, type EmbedDescriptor } from "./embed-providers";
import { internalLinkDisplayName, parseInternalLinkAt } from "../project-links";

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
  | { readonly kind: "paragraph"; readonly content: readonly MarkdownInline[] }
  | { readonly kind: "blockquote"; readonly content: readonly MarkdownInline[] }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "list"; readonly ordered: boolean; readonly items: readonly (readonly MarkdownInline[])[] };

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
  const lines = text.replace(/\r\n|\r/gu, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim().length === 0) { index += 1; continue; }
    if (line.startsWith("```")) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading !== null) {
      blocks.push({ kind: "heading", depth: heading[1].length, content: parseMarkdownInlines(heading[2], quotes, internalLinks, media) });
      index += 1;
      continue;
    }
    if (line.startsWith(">")) {
      const quoteLines: string[] = [];
      while (index < lines.length && lines[index].startsWith(">")) {
        quoteLines.push(lines[index].replace(/^>\s?/u, ""));
        index += 1;
      }
      blocks.push({ kind: "blockquote", content: parseMarkdownInlines(quoteLines.join("\n"), quotes, internalLinks, media) });
      continue;
    }
    const list = /^(?:([-*+])\s+|(\d+)\.\s+)(.+)$/u.exec(line);
    if (list !== null) {
      const ordered = list[2] !== undefined;
      const items: (readonly MarkdownInline[])[] = [];
      while (index < lines.length) {
        const item = /^(?:([-*+])\s+|(\d+)\.\s+)(.+)$/u.exec(lines[index]);
        if (item === null || (item[2] !== undefined) !== ordered) break;
        items.push(parseMarkdownInlines(item[3], quotes, internalLinks, media));
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && lines[index].trim().length > 0
      && !lines[index].startsWith("```")
      && !/^(#{1,6})\s+/u.test(lines[index])
      && !lines[index].startsWith(">")
      && !/^(?:[-*+]\s+|\d+\.\s+)/u.test(lines[index])) {
      paragraph.push(lines[index++]);
    }
    blocks.push({ kind: "paragraph", content: parseMarkdownInlines(paragraph.join("\n"), quotes, internalLinks, media) });
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
    if (block.kind !== "code") visit(block.kind === "list" ? block.items.flat() : block.content);
  }
  return Object.freeze([...targets]);
}

export interface MarkdownPreviewRenderOptions {
  /** Bound by the host to main-process validated shell.openExternal only. */
  readonly onOpenExternal?: (url: string) => void;
  /**
   * Preview-only interaction seam for a main-process-approved internal link.
   * This carries an opaque file ID, never a Project path or DOM/editor handle.
   */
  readonly onOpenInternal?: (link: { readonly target: string; readonly fileId: string }) => void;
}

function appendInlines(
  parent: HTMLElement,
  nodes: readonly MarkdownInline[],
  options: MarkdownPreviewRenderOptions
): void {
  for (const node of nodes) {
    switch (node.kind) {
      case "text": parent.append(document.createTextNode(node.text)); break;
      case "code": {
        const code = document.createElement("code"); code.textContent = node.text; parent.append(code); break;
      }
      case "strong": {
        const element = document.createElement("strong"); appendInlines(element, node.children, options); parent.append(element); break;
      }
      case "emphasis": {
        const element = document.createElement("em"); appendInlines(element, node.children, options); parent.append(element); break;
      }
      case "link": {
        if (node.embed !== undefined) {
          const card = document.createElement("span");
          card.className = `rendered-embed-card ${node.embed.kind}`;
          card.dataset.embedKind = node.embed.kind;
          const label = document.createElement("span");
          appendInlines(label, node.label, options);
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
          appendInlines(link, node.label, options); parent.append(link);
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
        appendInlines(link, node.label, options);
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
  const root = document.createElement("article");
  root.className = "markdown-preview-document";
  root.dataset.writingDirection = direction;
  for (const block of parseMarkdownBlocks(text, quotes, internalLinks, media)) {
    let element: HTMLElement;
    switch (block.kind) {
      case "heading": element = document.createElement(`h${block.depth}`); appendInlines(element, block.content, options); break;
      case "paragraph": element = document.createElement("p"); appendInlines(element, block.content, options); break;
      case "blockquote": element = document.createElement("blockquote"); appendInlines(element, block.content, options); break;
      case "code": element = document.createElement("pre"); element.textContent = block.text; break;
      case "list": {
        element = document.createElement(block.ordered ? "ol" : "ul");
        for (const item of block.items) { const li = document.createElement("li"); appendInlines(li, item, options); element.append(li); }
        break;
      }
    }
    root.append(element);
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
