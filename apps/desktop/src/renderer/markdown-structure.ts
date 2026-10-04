import { parseMarkdownHeading } from "./markdown-fence";

export interface MarkdownListItem {
  readonly ordered: boolean;
  readonly contentStart: number;
  readonly content: string;
}

/** Renderer-authoring structural predicates shared by export projections. */
export function parseMarkdownListItem(line: string): MarkdownListItem | null {
  const match = /^(?:([-*+])\s+|(\d+)\.\s+)(.+)$/u.exec(line);
  return match === null
    ? null
    : {
      ordered: match[2] !== undefined,
      contentStart: match[0].length - match[3]!.length,
      content: match[3]!
    };
}

export function isMarkdownBlockquoteLine(line: string): boolean {
  return line.startsWith(">");
}

export { parseMarkdownHeading };
