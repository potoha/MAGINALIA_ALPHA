/**
 * Project-internal Markdown links are deliberately a tiny authoring contract.
 * Paths are never converted to filesystem paths in the renderer.  Main-process
 * resolution maps a validated target to an opaque file id.
 */

export type InternalLinkParseResult =
  | {
    readonly kind: "link";
    readonly raw: string;
    readonly start: number;
    readonly end: number;
    readonly target: string;
    readonly label?: string;
  }
  | {
    readonly kind: "invalid";
    readonly raw: string;
    readonly start: number;
    readonly end: number;
    readonly reason: InternalLinkInvalidReason;
  };

export type InternalLinkInvalidReason =
  | "empty-target"
  | "invalid-target"
  | "invalid-label";

export interface ValidInternalLinkTarget {
  readonly kind: "valid";
  /** Canonical, project-relative POSIX path as authored. */
  readonly target: string;
}

export interface InvalidInternalLinkTarget {
  readonly kind: "invalid";
  readonly reason: "empty" | "absolute" | "traversal" | "syntax" | "extension";
}

export type InternalLinkTargetValidation = ValidInternalLinkTarget | InvalidInternalLinkTarget;

const CONTROL = /[\u0000-\u001F\u007F]/u;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:/u;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u;

/** Strictly validate without normalising: traversal must never become benign. */
export function validateInternalLinkTarget(value: string): InternalLinkTargetValidation {
  if (value.length === 0) return { kind: "invalid", reason: "empty" };
  if (CONTROL.test(value) || value.includes("\\") || value.includes("?") || value.includes("#")) {
    return { kind: "invalid", reason: "syntax" };
  }
  if (value.startsWith("/") || value.startsWith("//") || WINDOWS_ABSOLUTE.test(value) || URL_SCHEME.test(value)) {
    return { kind: "invalid", reason: "absolute" };
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return { kind: "invalid", reason: "traversal" };
  }
  const extension = segments.at(-1)?.match(/\.(?<extension>[^.]+)$/u)?.groups?.extension?.toLowerCase();
  if (extension !== undefined && extension !== "md" && extension !== "markdown") {
    return { kind: "invalid", reason: "extension" };
  }
  return { kind: "valid", target: value };
}

function parsedLink(raw: string, start: number, end: number): InternalLinkParseResult {
  const body = raw.slice(2, -2);
  const separator = body.indexOf("|");
  const target = separator < 0 ? body : body.slice(0, separator);
  const label = separator < 0 ? undefined : body.slice(separator + 1);
  if (separator >= 0 && (label === undefined || label.length === 0 || label.includes("|"))) {
    return { kind: "invalid", raw, start, end, reason: "invalid-label" };
  }
  const validation = validateInternalLinkTarget(target);
  if (validation.kind !== "valid") {
    return { kind: "invalid", raw, start, end, reason: validation.reason === "empty" ? "empty-target" : "invalid-target" };
  }
  return Object.freeze({ kind: "link", raw, start, end, target: validation.target, ...(label === undefined ? {} : { label }) });
}

/** Parse a wiki-link starting at exactly `start`, never treating media as a link. */
export function parseInternalLinkAt(text: string, start: number): InternalLinkParseResult | null {
  if (!text.startsWith("[[", start) || (start > 0 && text[start - 1] === "!")) return null;
  const close = text.indexOf("]]", start + 2);
  if (close < 0) return null;
  const end = close + 2;
  return parsedLink(text.slice(start, end), start, end);
}

/**
 * Return wiki links from authoring Markdown while respecting fenced and inline
 * code.  `![[...]]` is reserved for local media and is intentionally skipped
 * before normal wiki links are considered.
 */
export function parseInternalLinks(markdown: string): readonly InternalLinkParseResult[] {
  const result: InternalLinkParseResult[] = [];
  let cursor = 0;
  let fenced = false;
  while (cursor < markdown.length) {
    const lineEnd = markdown.indexOf("\n", cursor);
    const end = lineEnd < 0 ? markdown.length : lineEnd;
    const line = markdown.slice(cursor, end);
    if (/^\s*```/u.test(line)) {
      fenced = !fenced;
      cursor = lineEnd < 0 ? markdown.length : lineEnd + 1;
      continue;
    }
    if (!fenced) {
      let index = 0;
      let inlineCode = false;
      while (index < line.length) {
        if (line[index] === "`") { inlineCode = !inlineCode; index += 1; continue; }
        if (!inlineCode && line.startsWith("![[", index)) {
          const close = line.indexOf("]]", index + 3);
          index = close < 0 ? line.length : close + 2;
          continue;
        }
        if (!inlineCode && line.startsWith("[[", index)) {
          const parsed = parseInternalLinkAt(line, index);
          if (parsed !== null) {
            result.push({ ...parsed, start: cursor + parsed.start, end: cursor + parsed.end });
            index = parsed.end;
            continue;
          }
        }
        index += 1;
      }
    }
    cursor = lineEnd < 0 ? markdown.length : lineEnd + 1;
  }
  return Object.freeze(result);
}

export function internalLinkDisplayName(target: string): string {
  const fileName = target.slice(target.lastIndexOf("/") + 1);
  return fileName.replace(/\.(?:md|markdown)$/iu, "") || "unresolved link";
}

/** Export only visible labels. Never include a project target in exported Markdown. */
export function renderInternalLinksForExport(markdown: string): string {
  const links = parseInternalLinks(markdown);
  let output = markdown;
  for (let index = links.length - 1; index >= 0; index -= 1) {
    const link = links[index];
    const visible = link.kind === "link"
      ? link.label ?? internalLinkDisplayName(link.target)
      : "unresolved link";
    output = `${output.slice(0, link.start)}${visible}${output.slice(link.end)}`;
  }
  return output;
}
