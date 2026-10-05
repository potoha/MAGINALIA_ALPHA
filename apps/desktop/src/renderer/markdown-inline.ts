import { internalLinkDisplayName, parseInternalLinkAt } from "../project-links";
import { describeEmbed, parseSafeExternalUrl, type EmbedDescriptor } from "./embed-providers";

/** Safe, typed inline nodes. Raw HTML is always plain text. */
export type MarkdownInline =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "strong"; readonly children: readonly MarkdownInline[] }
  | { readonly kind: "emphasis"; readonly children: readonly MarkdownInline[] }
  | { readonly kind: "link"; readonly label: readonly MarkdownInline[]; readonly href: string; readonly embed?: EmbedDescriptor }
  | { readonly kind: "internal-link"; readonly target: string; readonly label: readonly MarkdownInline[]; readonly state: "resolved" | "unresolved"; readonly fileId?: string }
  | { readonly kind: "local-media"; readonly target: string; readonly alt: string; readonly media: PreviewMedia }
  | { readonly kind: "quote-ref"; readonly marker: string; readonly quote: PreviewQuote };

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

export const QUOTE_MARKER_PREFIX = "<!-- maginalia:quote-ref ";
const QUOTE_MARKER_END = "-->";

export function safeExternalHref(value: string): string | null {
  return parseSafeExternalUrl(value)?.href ?? null;
}

function localMediaTarget(value: string): string | null {
  if (value.length === 0 || value.length > 1_024 || value.includes("\\") || /[\u0000-\u001F\u007F]/u.test(value)) return null;
  if (/^(?:[A-Za-z]:|\/|file:|data:|javascript:)/iu.test(value)) return null;
  const segments = value.split("/");
  if (segments.some((part) => part.length === 0 || part === "." || part === "..")) return null;
  return segments.join("/");
}

function localMedia(target: string, alt: string, media: PreviewMediaMap): MarkdownInline {
  return {
    kind: "local-media",
    target,
    alt,
    media: media.get(target) ?? { state: "unresolved", reason: "Project media unavailable." }
  };
}

export function quoteMarkerAt(text: string, start: number): { readonly marker: string; readonly end: number } | null {
  if (!text.startsWith(QUOTE_MARKER_PREFIX, start)) return null;
  const close = text.indexOf(QUOTE_MARKER_END, start + QUOTE_MARKER_PREFIX.length);
  if (close < 0) return { marker: text.slice(start), end: text.length };
  return { marker: text.slice(start, close + QUOTE_MARKER_END.length), end: close + QUOTE_MARKER_END.length };
}

/**
 * A deliberately small Markdown inline AST shared by renderer projections.
 * It creates text nodes rather than HTML strings, so authoring HTML/comments
 * can never execute.
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
