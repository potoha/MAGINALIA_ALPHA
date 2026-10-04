import { isMarkdownFenceClosing, openingMarkdownFence } from "./markdown-fence";

export type TableAlignment = "left" | "center" | "right" | "none";
export type TableRowKind = "header" | "body";

export interface MarkdownTableCellTarget {
  readonly rowKind: TableRowKind;
  readonly rowIndex: number;
  readonly columnIndex: number;
  /** Exact original UTF-16 content range, excluding surrounding cell padding. */
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

export interface MarkdownTableTarget {
  readonly start: number;
  readonly end: number;
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly alignments: readonly TableAlignment[];
  readonly cells: readonly MarkdownTableCellTarget[];
}

export type TableOperation = "addRowAbove" | "addRowBelow" | "deleteRow" | "addColumnBefore" | "addColumnAfter" | "deleteColumn";

interface SourceLine { readonly text: string; readonly start: number; readonly end: number; }

function linesOf(text: string): readonly SourceLine[] {
  const lines: SourceLine[] = [];
  let cursor = 0;
  while (cursor <= text.length) {
    const newline = text.indexOf("\n", cursor);
    const rawEnd = newline < 0 ? text.length : newline;
    const end = rawEnd > cursor && text[rawEnd - 1] === "\r" ? rawEnd - 1 : rawEnd;
    const bom = cursor === 0 && text.startsWith("\uFEFF") ? 1 : 0;
    lines.push({ text: text.slice(cursor + bom, end), start: cursor + bom, end });
    if (newline < 0) break;
    cursor = newline + 1;
  }
  return lines;
}

function alignment(value: string): TableAlignment | null {
  const text = value.trim();
  if (!/^:?-{3,}:?$/u.test(text)) return null;
  if (text.startsWith(":") && text.endsWith(":")) return "center";
  if (text.startsWith(":")) return "left";
  if (text.endsWith(":")) return "right";
  return "none";
}

function trimTableWhitespace(value: string): string {
  return value.replace(/^[\t ]+|[\t ]+$/gu, "");
}

function trailingPipeIsDelimiter(text: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 0;
}

/** Shared table-block boundary rule for rendering and authoring source maps. */
export function isMarkdownTableTerminator(line: string): boolean {
  return line.trim().length === 0
    || /^ {0,3}(`{3,}|~{3,})/u.test(line)
    || /^(#{1,6})\s+/u.test(line)
    || line.startsWith(">")
    || /^(?:[-*+]\s+|\d+\.\s+)/u.test(line);
}

function rowCells(line: SourceLine): readonly { readonly value: string; readonly start: number; readonly end: number }[] | null {
  if (!line.text.includes("|")) return null;
  let start = 0;
  while (start < line.text.length && /[ \t]/u.test(line.text[start]!)) start += 1;
  let end = line.text.length;
  while (end > start && /[ \t]/u.test(line.text[end - 1]!)) end -= 1;
  if (line.text[start] === "|") start += 1;
  const cells: Array<{ value: string; start: number; end: number }> = [];
  let cellStart = start;
  let value = "";
  const pushCell = (cellEnd: number): void => {
    let contentStart = cellStart;
    let contentEnd = cellEnd;
    while (contentStart < contentEnd && /[ \t]/u.test(line.text[contentStart]!)) contentStart += 1;
    while (contentEnd > contentStart && /[ \t]/u.test(line.text[contentEnd - 1]!)) contentEnd -= 1;
    cells.push({ value: trimTableWhitespace(value), start: line.start + contentStart, end: line.start + contentEnd });
    value = "";
  };
  for (let index = start; index < end;) {
    if (line.text[index] === "\\") {
      let runEnd = index + 1;
      while (runEnd < end && line.text[runEnd] === "\\") runEnd += 1;
      const slashCount = runEnd - index;
      if (runEnd < end && line.text[runEnd] === "|") {
        value += "\\".repeat(Math.floor(slashCount / 2));
        if (slashCount % 2 === 1) {
          value += "|";
          index = runEnd + 1;
        } else {
          pushCell(runEnd);
          cellStart = runEnd + 1;
          index = runEnd + 1;
        }
      } else {
        value += "\\".repeat(slashCount);
        index = runEnd;
      }
      continue;
    }
    if (line.text[index] === "|") {
      pushCell(index);
      cellStart = index + 1;
      index += 1;
      continue;
    }
    value += line.text[index]!;
    index += 1;
  }
  pushCell(end);
  if (end > start && line.text[end - 1] === "|" && trailingPipeIsDelimiter(line.text, end - 1)) cells.pop();
  return cells;
}

export function collectMarkdownTables(text: string): readonly MarkdownTableTarget[] {
  const lines = linesOf(text);
  const tables: MarkdownTableTarget[] = [];
  for (let index = 0; index < lines.length;) {
    const fence = openingMarkdownFence(lines[index]!.text);
    if (fence !== null) {
      index += 1;
      while (index < lines.length && !isMarkdownFenceClosing(lines[index]!.text, fence)) index += 1;
      if (index < lines.length) index += 1;
      continue;
    }
    if (index + 1 >= lines.length) break;
    const header = rowCells(lines[index]!);
    const divider = rowCells(lines[index + 1]!);
    const alignments = header === null || divider === null || header.length === 0 || header.length !== divider.length
      ? null : divider.map((cell) => alignment(cell.value));
    if (header === null || alignments === null || alignments.some((item) => item === null)) { index += 1; continue; }
    const rows: Array<readonly { readonly value: string; readonly start: number; readonly end: number }[]> = [];
    let endIndex = index + 2;
    while (endIndex < lines.length) {
      if (isMarkdownTableTerminator(lines[endIndex]!.text)) break;
      const row = rowCells(lines[endIndex]!);
      if (row === null || row.length < header.length) break;
      rows.push(row.slice(0, header.length));
      endIndex += 1;
    }
    const cells: MarkdownTableCellTarget[] = header.map((cell, columnIndex) => ({ ...cell, rowKind: "header", rowIndex: 0, columnIndex }));
    rows.forEach((row, rowIndex) => row.forEach((cell, columnIndex) => cells.push({ ...cell, rowKind: "body", rowIndex, columnIndex })));
    tables.push(Object.freeze({
      start: lines[index]!.start,
      end: lines[Math.max(index + 1, endIndex - 1)]!.end,
      header: header.map((cell) => cell.value),
      rows: rows.map((row) => row.map((cell) => cell.value)),
      alignments: alignments as readonly TableAlignment[],
      cells
    }));
    index = endIndex;
  }
  return Object.freeze(tables);
}

export function escapeTableCell(value: string): string {
  let encoded = "";
  for (let index = 0; index < value.length;) {
    if (value[index] !== "\\") {
      encoded += value[index] === "|" ? "\\|" : value[index];
      index += 1;
      continue;
    }
    let runEnd = index + 1;
    while (runEnd < value.length && value[runEnd] === "\\") runEnd += 1;
    const slashCount = runEnd - index;
    if (value[runEnd] === "|") {
      // A literal pipe after n literal backslashes needs 2n + 1 source
      // backslashes: n escaped literals plus the table-delimiter escape.
      encoded += "\\".repeat(slashCount * 2 + 1) + "|";
      index = runEnd + 1;
    } else {
      encoded += "\\".repeat(slashCount);
      index = runEnd;
    }
  }
  return encoded;
}

function divider(alignment: TableAlignment): string {
  return alignment === "left" ? ":---" : alignment === "center" ? ":---:" : alignment === "right" ? "---:" : "---";
}

export function serializeMarkdownTable(table: Pick<MarkdownTableTarget, "header" | "rows" | "alignments">): string {
  const row = (cells: readonly string[]) => `| ${cells.map(escapeTableCell).join(" | ")} |`;
  return [row(table.header), `| ${table.alignments.map(divider).join(" | ")} |`, ...table.rows.map(row)].join("\n");
}

export function insertMarkdownTable(text: string, start: number, end: number): { readonly replacement: string } {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const prefix = before.length > 0 && !/\n\n$/u.test(before) ? (before.endsWith("\n") ? "\n" : "\n\n") : "";
  const suffix = after.length > 0 && !/^\n\n/u.test(after) ? (after.startsWith("\n") ? "\n" : "\n\n") : "";
  return { replacement: `${prefix}| Column 1 | Column 2 |\n| --- | --- |\n|  |  |${suffix}` };
}

export function transformMarkdownTable(table: MarkdownTableTarget, rowKind: TableRowKind, rowIndex: number, columnIndex: number, operation: TableOperation): string | null {
  const header = [...table.header];
  const rows = table.rows.map((row) => [...row]);
  const alignments = [...table.alignments];
  if (operation === "addRowAbove") {
    if (rowKind === "header") return null;
    rows.splice(rowIndex, 0, Array(header.length).fill(""));
  } else if (operation === "addRowBelow") {
    rows.splice(rowKind === "header" ? 0 : rowIndex + 1, 0, Array(header.length).fill(""));
  } else if (operation === "deleteRow") {
    if (rowKind === "header") return null;
    rows.splice(rowIndex, 1);
  } else if (operation === "addColumnBefore" || operation === "addColumnAfter") {
    const at = operation === "addColumnBefore" ? columnIndex : columnIndex + 1;
    header.splice(at, 0, ""); alignments.splice(at, 0, "none"); rows.forEach((row) => row.splice(at, 0, ""));
  } else if (operation === "deleteColumn") {
    if (header.length <= 1) return null;
    header.splice(columnIndex, 1); alignments.splice(columnIndex, 1); rows.forEach((row) => row.splice(columnIndex, 1));
  }
  return serializeMarkdownTable({ header, rows, alignments });
}
