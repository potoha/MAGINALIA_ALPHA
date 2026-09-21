export interface MarkdownCommandResult {
  readonly text: string;
  readonly changed: boolean;
}

function lineBounds(text: string, start: number, end: number): { start: number; end: number } {
  const from = Math.max(0, text.lastIndexOf("\n", Math.max(0, start - 1)) + 1);
  const after = text.indexOf("\n", Math.max(end, start));
  return { start: from, end: after < 0 ? text.length : after };
}

function replaceRange(text: string, start: number, end: number, replacement: string): MarkdownCommandResult {
  const next = `${text.slice(0, start)}${replacement}${text.slice(end)}`;
  return { text: next, changed: next !== text };
}

export function setBlockStyle(text: string, start: number, end: number, level: number): MarkdownCommandResult {
  const bounds = lineBounds(text, start, end);
  const lines = text.slice(bounds.start, bounds.end).split("\n");
  const prefix = level === 0 ? "" : `${"#".repeat(level)} `;
  const formatted = lines.map((line) => `${prefix}${line.replace(/^#{1,6}\s+/u, "")}`).join("\n");
  return replaceRange(text, bounds.start, bounds.end, formatted);
}

export function toggleInline(text: string, start: number, end: number, token: "**" | "*" | "`"): MarkdownCommandResult {
  const selection = text.slice(start, end);
  if (selection.length === 0) return { text, changed: false };
  const wrapped = selection.startsWith(token) && selection.endsWith(token) && selection.length >= token.length * 2
    ? selection.slice(token.length, -token.length)
    : `${token}${selection}${token}`;
  return replaceRange(text, start, end, wrapped);
}

export function toggleLinePrefix(text: string, start: number, end: number, prefix: "- " | "1. " | "> "): MarkdownCommandResult {
  const bounds = lineBounds(text, start, end);
  const lines = text.slice(bounds.start, bounds.end).split("\n");
  const allPrefixed = lines.every((line) => line.startsWith(prefix));
  return replaceRange(text, bounds.start, bounds.end, lines.map((line) => allPrefixed ? line.slice(prefix.length) : `${prefix}${line}`).join("\n"));
}

export function insertLink(text: string, start: number, end: number, type: "internal" | "external", target?: string): MarkdownCommandResult {
  const label = text.slice(start, end) || (type === "internal" ? "link" : "link");
  const replacement = type === "internal"
    ? `[[${target?.trim() || "target"}|${label}]]`
    : `[${label}](${target?.trim() || "https://"})`;
  return replaceRange(text, start, end, replacement);
}
