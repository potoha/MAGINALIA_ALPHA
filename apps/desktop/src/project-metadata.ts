import { parseDocument, stringify } from "yaml";

export const PROJECT_DOCUMENT_TYPES = ["memo", "draft", "body", "other"] as const;
export type ProjectDocumentType = (typeof PROJECT_DOCUMENT_TYPES)[number];

export interface ParsedProjectMetadata {
  readonly documentType: ProjectDocumentType;
  readonly title: string | undefined;
  readonly valid: boolean;
}

const PROJECT_DOCUMENT_TYPE_SET = new Set<string>(PROJECT_DOCUMENT_TYPES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function withoutBom(value: string): string {
  return value.startsWith("\uFEFF") ? value.slice(1) : value;
}

function frontmatter(value: string): string | undefined {
  const normalized = withoutBom(value).replace(/\r\n|\r/g, "\n");
  if (!normalized.startsWith("---\n") && normalized !== "---") return undefined;
  const openingEnd = normalized.indexOf("\n");
  if (openingEnd < 0) return undefined;
  const closing = /^(?:---|\.\.\.)\s*$/m.exec(normalized.slice(openingEnd + 1));
  if (!closing) return undefined;
  const end = openingEnd + 1 + closing.index;
  return normalized.slice(openingEnd + 1, end);
}

function fallbackTitle(fileName: string): string {
  return fileName.replace(/\.(?:md|markdown)$/iu, "") || fileName;
}

/**
 * Read the optional YAML frontmatter used by ordinary Markdown files. Any
 * malformed or unsupported metadata falls back to `other`; the Markdown body
 * is never parsed as metadata and remains readable by the editor.
 */
export function parseProjectMetadata(value: string, fileName: string): ParsedProjectMetadata {
  const fallback = fallbackTitle(fileName);
  const yaml = frontmatter(value);
  if (yaml === undefined) return { documentType: "other", title: fallback, valid: true };

  try {
    const parsed = parseDocument(yaml, { prettyErrors: false });
    if (parsed.errors.length > 0) return { documentType: "other", title: fallback, valid: false };
    const data = parsed.toJS();
    if (!isRecord(data)) return { documentType: "other", title: fallback, valid: false };

    const type = data.type;
    const title = typeof data.title === "string" && data.title.trim().length > 0
      ? data.title.trim()
      : fallback;
    if (typeof type !== "string" || !PROJECT_DOCUMENT_TYPE_SET.has(type)) {
      return { documentType: "other", title, valid: false };
    }
    return { documentType: type as ProjectDocumentType, title, valid: true };
  } catch (_error: unknown) {
    return { documentType: "other", title: fallback, valid: false };
  }
}

export function normalizeProjectFileName(value: string): string | undefined {
  const name = value.trim();
  if (!name || name === "." || name === "..") return undefined;
  if (/[<>:"/\\|?*\u0000-\u001f]/u.test(name) || /[. ]$/u.test(name)) return undefined;
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(name)) return undefined;
  if (!/\.md$/iu.test(name)) return `${name}.md`;
  return name;
}

export function normalizeProjectFolderName(value: string): string | undefined {
  const name = value.trim();
  if (!name || name === "." || name === "..") return undefined;
  if (/[<>:"/\\|?*\u0000-\u001f]/u.test(name) || /[. ]$/u.test(name)) return undefined;
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(name)) return undefined;
  return name;
}

export function normalizeDocumentTitle(value: string): string | undefined {
  const title = value.trim();
  if (!title || title.length > 240) return undefined;
  return title;
}

export function createProjectMarkdown(title: string, documentType: ProjectDocumentType, created = new Date()): string {
  const createdDate = created.toISOString().slice(0, 10);
  const metadata = stringify({ type: documentType, title, created: createdDate }).trimEnd();
  return `---\n${metadata}\n---\n\n# ${title}\n`;
}
