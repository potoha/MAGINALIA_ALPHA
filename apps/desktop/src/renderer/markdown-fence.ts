export interface MarkdownFence {
  readonly character: "`" | "~";
  readonly minimumLength: number;
}

export interface MarkdownHeading {
  readonly level: number;
  /** UTF-16 offset of the visible heading content within the line. */
  readonly contentStart: number;
  readonly content: string;
}

/** Match the Renderer-supported ATX heading grammar. Empty `#` is not a heading. */
export function parseMarkdownHeading(line: string): MarkdownHeading | null {
  const match = /^(#{1,6})\s+(.+)$/u.exec(line);
  return match === null
    ? null
    : { level: match[1]!.length, contentStart: match[0].length - match[2]!.length, content: match[2]! };
}

/** Match the small fenced-code grammar used by the MAGINALIA renderer. */
export function openingMarkdownFence(line: string): MarkdownFence | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
  if (match === null) return null;
  return {
    character: match[1]![0] as MarkdownFence["character"],
    minimumLength: match[1]!.length,
  };
}

/** A closer must use the same marker character and be at least as long. */
export function isMarkdownFenceClosing(line: string, fence: MarkdownFence): boolean {
  const match = /^ {0,3}(`+|~+)[ \t]*$/u.exec(line);
  return match !== null && match[1]![0] === fence.character && match[1]!.length >= fence.minimumLength;
}

/** Return the visible content offset for a Renderer-supported H1, if any. */
export function markdownFirstLevelHeadingContentStart(line: string): number | null {
  const match = parseMarkdownHeading(line);
  return match?.level === 1 ? match.contentStart : null;
}

/** Match the Renderer-supported level-one ATX heading grammar. */
export function isMarkdownFirstLevelHeading(line: string): boolean {
  return markdownFirstLevelHeadingContentStart(line) !== null;
}
