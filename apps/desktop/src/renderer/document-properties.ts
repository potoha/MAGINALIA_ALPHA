import { parseDocument } from "yaml";

import { PROJECT_DOCUMENT_TYPES, type ProjectDocumentType } from "../project-metadata";
import { isMarkdownFenceClosing, openingMarkdownFence } from "./markdown-fence";

export interface FrontMatterBoundary {
  readonly openingStart: number;
  readonly yamlStart: number;
  readonly yamlEnd: number;
  readonly closingStart: number;
  readonly closingEnd: number;
  readonly bodyStart: number;
  readonly lineEnding: "\n" | "\r\n" | "\r";
}

/** Front-matter detection must distinguish absence from an unclosed opener. */
export type FrontMatterScan =
  | { readonly kind: "none" }
  | { readonly kind: "bounded"; readonly boundary: FrontMatterBoundary }
  | { readonly kind: "unterminated"; readonly openingStart: number };

export interface DocumentProperties {
  readonly title: string;
  readonly type: ProjectDocumentType;
  readonly author: string;
  readonly tags: readonly string[];
  readonly created: string;
}

export type DocumentPropertiesState =
  | {
    readonly kind: "ready";
    readonly boundary: FrontMatterBoundary | undefined;
    /** The stored title, if one exists. It is used only for the exact H1 sync rule. */
    readonly metadataTitle: string | undefined;
    readonly properties: DocumentProperties;
  }
  | { readonly kind: "invalid"; readonly boundary: FrontMatterBoundary | undefined; readonly message: string }
  | { readonly kind: "raw-only"; readonly boundary: FrontMatterBoundary; readonly message: string };

export interface SourceEdit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

export type ApplyDocumentPropertiesResult =
  | { readonly kind: "applied"; readonly edit: SourceEdit; readonly properties: DocumentProperties }
  | { readonly kind: "unchanged"; readonly properties: DocumentProperties }
  | { readonly kind: "invalid"; readonly message: string };

interface SourceLine {
  readonly start: number;
  readonly end: number;
  readonly next: number;
  readonly text: string;
  readonly lineEnding: "\n" | "\r\n" | "\r" | undefined;
}

const DOCUMENT_TYPE_SET = new Set<string>(PROJECT_DOCUMENT_TYPES);

function sourceLineAt(source: string, start: number): SourceLine {
  let end = start;
  while (end < source.length && source[end] !== "\r" && source[end] !== "\n") end += 1;
  if (end === source.length) return { start, end, next: end, text: source.slice(start, end), lineEnding: undefined };
  if (source[end] === "\r" && source[end + 1] === "\n") {
    return { start, end, next: end + 2, text: source.slice(start, end), lineEnding: "\r\n" };
  }
  return { start, end, next: end + 1, text: source.slice(start, end), lineEnding: source[end] === "\r" ? "\r" : "\n" };
}

function fallbackTitle(value: string): string {
  return value.replace(/\.(?:md|markdown)$/iu, "") || value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function trimTags(tags: readonly string[]): string[] {
  return tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0);
}

function normalizeRequestedProperties(properties: DocumentProperties, allowBody: boolean): DocumentProperties | undefined {
  const title = properties.title.trim();
  if (!title || title.length > 240 || !DOCUMENT_TYPE_SET.has(properties.type)) return undefined;
  if (!allowBody && properties.type === "body") return undefined;
  const author = properties.author.trim();
  const created = properties.created.trim();
  if (created && !isDate(created)) return undefined;
  return { title, type: properties.type, author, tags: trimTags(properties.tags), created };
}

function yamlValue(value: unknown, key: string): { readonly value: string | undefined } | { readonly message: string } {
  if (value === undefined || value === null) return { value: undefined };
  if (typeof value !== "string") return { message: `${key} requires raw source editing because it is not plain text.` };
  return { value };
}

/**
 * Locates YAML front matter without normalizing BOMs or line endings. All
 * returned offsets use JavaScript UTF-16 string positions in the original
 * Markdown document.
 */
export function scanFrontMatter(source: string): FrontMatterScan {
  const openingStart = source.startsWith("\uFEFF") ? 1 : 0;
  const opening = sourceLineAt(source, openingStart);
  if (!/^---[ \t]*$/u.test(opening.text) || opening.lineEnding === undefined) return { kind: "none" };

  let cursor = opening.next;
  while (cursor < source.length) {
    const line = sourceLineAt(source, cursor);
    if (/^(?:---|\.\.\.)[ \t]*$/u.test(line.text)) {
      return {
        kind: "bounded",
        boundary: {
          openingStart,
          yamlStart: opening.next,
          yamlEnd: line.start,
          closingStart: line.start,
          closingEnd: line.end,
          bodyStart: line.next,
          lineEnding: opening.lineEnding,
        }
      };
    }
    if (line.next === cursor) break;
    cursor = line.next;
  }
  return { kind: "unterminated", openingStart };
}

export function findFrontMatterBoundary(source: string): FrontMatterBoundary | undefined {
  const scan = scanFrontMatter(source);
  return scan.kind === "bounded" ? scan.boundary : undefined;
}

/** Return the body projection while retaining the source offset of that body. */
export function projectMarkdownBody(source: string): { readonly body: string; readonly start: number } {
  const scan = scanFrontMatter(source);
  return scan.kind !== "bounded"
    ? { body: source, start: 0 }
    : { body: source.slice(scan.boundary.bodyStart), start: scan.boundary.bodyStart };
}

export function readDocumentProperties(source: string, fileName: string): DocumentPropertiesState {
  const scan = scanFrontMatter(source);
  const fallback = fallbackTitle(fileName);
  if (scan.kind === "unterminated") {
    return {
      kind: "invalid",
      boundary: undefined,
      message: "Metadata front matter is not closed. Open raw source to repair it."
    };
  }
  if (scan.kind === "none") {
    return {
      kind: "ready",
      boundary: undefined,
      metadataTitle: undefined,
      properties: { title: fallback, type: "other", author: "", tags: [], created: "" },
    };
  }
  const boundary = scan.boundary;

  let document;
  try {
    document = parseDocument(source.slice(boundary.yamlStart, boundary.yamlEnd), { prettyErrors: false, keepSourceTokens: true });
  } catch (_error: unknown) {
    return { kind: "invalid", boundary, message: "Metadata is invalid. Open raw source to repair it." };
  }
  if (document.errors.length > 0) {
    return { kind: "invalid", boundary, message: "Metadata is invalid. Open raw source to repair it." };
  }

  const data = document.toJS();
  if (data !== null && !isRecord(data)) {
    return { kind: "raw-only", boundary, message: "Metadata requires raw source editing because it is not a key/value document." };
  }
  const record = data ?? {};
  const titleResult = yamlValue(record.title, "Title");
  const authorResult = yamlValue(record.author, "Author");
  const createdResult = yamlValue(record.created, "Created");
  if ("message" in titleResult) return { kind: "raw-only", boundary, message: titleResult.message };
  if ("message" in authorResult) return { kind: "raw-only", boundary, message: authorResult.message };
  if ("message" in createdResult) return { kind: "raw-only", boundary, message: createdResult.message };

  const typeValue = record.type;
  if (typeValue !== undefined && (typeof typeValue !== "string" || !DOCUMENT_TYPE_SET.has(typeValue))) {
    return { kind: "raw-only", boundary, message: "Document type requires raw source editing because it is unsupported." };
  }
  const tagsValue = record.tags;
  if (tagsValue !== undefined && tagsValue !== null && (!Array.isArray(tagsValue) || tagsValue.some((tag) => typeof tag !== "string"))) {
    return { kind: "raw-only", boundary, message: "Tags require raw source editing because they are not a plain list." };
  }

  const title = titleResult.value?.trim() || fallback;
  if (titleResult.value !== undefined && !titleResult.value.trim()) {
    return { kind: "raw-only", boundary, message: "Title requires raw source editing because it is empty." };
  }
  if (title.length > 240) {
    return { kind: "raw-only", boundary, message: "Title requires raw source editing because it exceeds the supported length." };
  }
  const created = createdResult.value?.trim() ?? "";
  if (created && !isDate(created)) {
    return { kind: "raw-only", boundary, message: "Created requires raw source editing because it is not a valid date." };
  }
  return {
    kind: "ready",
    boundary,
    metadataTitle: titleResult.value?.trim(),
    properties: {
      title,
      type: (typeValue as ProjectDocumentType | undefined) ?? "other",
      author: authorResult.value?.trim() ?? "",
      tags: (tagsValue as readonly string[] | undefined) ?? [],
      created,
    },
  };
}

function serializeMetadata(source: string, state: Extract<DocumentPropertiesState, { readonly kind: "ready" }>, properties: DocumentProperties): string {
  const boundary = state.boundary;
  const document = boundary === undefined
    ? parseDocument("", { prettyErrors: false, keepSourceTokens: true })
    : parseDocument(source.slice(boundary.yamlStart, boundary.yamlEnd), { prettyErrors: false, keepSourceTokens: true });
  document.set("type", properties.type);
  document.set("title", properties.title);
  if (properties.author) document.set("author", properties.author);
  else document.delete("author");
  if (properties.tags.length > 0) document.set("tags", [...properties.tags]);
  else document.delete("tags");
  if (properties.created) document.set("created", properties.created);
  else document.delete("created");

  const lineEnding = boundary?.lineEnding ?? (source.includes("\r\n") ? "\r\n" : "\n");
  const yaml = document.toString({ lineWidth: 0 }).replace(/\n+$/u, "").replace(/\n/gu, lineEnding);
  if (boundary === undefined) {
    const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
    const body = source.slice(bom.length);
    return `${bom}---${lineEnding}${yaml}${lineEnding}---${lineEnding}${lineEnding}${body}`;
  }
  const closing = source.slice(boundary.closingStart, boundary.closingEnd);
  return `${source.slice(0, boundary.openingStart)}---${lineEnding}${yaml}${lineEnding}${closing}${source.slice(boundary.closingEnd)}`;
}

function firstH1ContentRange(source: string, bodyStart: number): SourceEdit | undefined {
  let cursor = bodyStart;
  let fence: ReturnType<typeof openingMarkdownFence> = null;
  while (cursor < source.length) {
    const line = sourceLineAt(source, cursor);
    if (fence !== null) {
      if (isMarkdownFenceClosing(line.text, fence)) fence = null;
      if (line.next === cursor) break;
      cursor = line.next;
      continue;
    }
    const opening = openingMarkdownFence(line.text);
    if (opening !== null) {
      fence = opening;
      if (line.next === cursor) break;
      cursor = line.next;
      continue;
    }
    const match = /^# ([^\r\n]*)$/u.exec(line.text);
    if (match) {
      return { start: line.start + 2, end: line.end, replacement: "" };
    }
    if (line.next === cursor) break;
    cursor = line.next;
  }
  return undefined;
}

function smallestSourceEdit(before: string, after: string): SourceEdit | undefined {
  if (before === after) return undefined;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  return { start, end: beforeEnd, replacement: after.slice(start, afterEnd) };
}

/**
 * Applies only the H.7.4 supported fields through the YAML document AST.
 * Unknown YAML nodes remain in that AST; the Markdown body is copied verbatim
 * except for the deliberately narrow, exact-match title/H1 synchronization.
 */
export function applyDocumentProperties(
  source: string,
  fileName: string,
  requested: DocumentProperties,
  options: { readonly allowBody: boolean },
): ApplyDocumentPropertiesResult {
  const state = readDocumentProperties(source, fileName);
  if (state.kind !== "ready") return { kind: "invalid", message: state.message };
  const properties = normalizeRequestedProperties(requested, options.allowBody);
  if (properties === undefined) return { kind: "invalid", message: "Complete the required properties with valid values before applying." };

  let next = serializeMetadata(source, state, properties);
  if (state.metadataTitle !== undefined && state.metadataTitle !== properties.title) {
    const previousHeading = firstH1ContentRange(source, state.boundary?.bodyStart ?? 0);
    if (previousHeading !== undefined && source.slice(previousHeading.start, previousHeading.end) === state.metadataTitle) {
      const nextBody = projectMarkdownBody(next);
      const nextHeading = firstH1ContentRange(next, nextBody.start);
      if (nextHeading !== undefined) {
        next = `${next.slice(0, nextHeading.start)}${properties.title}${next.slice(nextHeading.end)}`;
      }
    }
  }
  const edit = smallestSourceEdit(source, next);
  return edit === undefined ? { kind: "unchanged", properties } : { kind: "applied", edit, properties };
}
