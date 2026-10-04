export interface MarkdownFence {
  readonly character: "`" | "~";
  readonly minimumLength: number;
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
  const match = /^#\s+(.+)$/u.exec(line);
  return match === null ? null : match[0].length - match[1]!.length;
}

/** Match the Renderer-supported level-one ATX heading grammar. */
export function isMarkdownFirstLevelHeading(line: string): boolean {
  return markdownFirstLevelHeadingContentStart(line) !== null;
}
