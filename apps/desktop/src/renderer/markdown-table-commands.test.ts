import { describe, expect, it } from "vitest";
import {
  collectMarkdownTables,
  escapeTableCell,
  insertMarkdownTable,
  transformMarkdownTable
} from "./markdown-table-commands";

describe("Markdown table authoring transforms", () => {
  const source = "\uFEFFbefore\r\n\r\n| 同じ | 同じ |\r\n| :--- | ---: |\r\n| 同じ | A \\| B |\r\n\r\nafter";

  it("maps each exact UTF-16 cell occurrence without searching visible text", () => {
    const table = collectMarkdownTables(source)[0];
    expect(table?.header).toEqual(["同じ", "同じ"]);
    expect(table?.rows).toEqual([["同じ", "A | B"]]);
    const cells = table?.cells ?? [];
    expect(cells.map((cell) => source.slice(cell.start, cell.end))).toEqual(["同じ", "同じ", "同じ", "A \\| B"]);
    expect(cells[0]?.start).not.toBe(cells[1]?.start);
    expect(cells[0]?.start).toBe(source.indexOf("同じ"));
    expect(cells[2]?.start).toBe(source.lastIndexOf("同じ"));
  });

  it("inserts an isolated ordinary Markdown table without changing surrounding prose", () => {
    const text = "前文\n後文";
    const inserted = insertMarkdownTable(text, 3, 3);
    const next = `${text.slice(0, 3)}${inserted.replacement}${text.slice(3)}`;
    expect(next).toContain("前文\n\n| Column 1 | Column 2 |");
    expect(next).toContain("|  |  |\n\n後文");
  });

  it("rewrites only table block semantics for rows and columns", () => {
    const table = collectMarkdownTables(source)[0]!;
    const rowBelow = transformMarkdownTable(table, "header", 0, 0, "addRowBelow");
    expect(rowBelow).toContain("| 同じ | 同じ |");
    expect(rowBelow).toContain("|  |  |");
    const column = transformMarkdownTable(table, "body", 0, 1, "addColumnAfter");
    expect(column).toContain("| :--- | ---: | --- |");
    expect(column).toContain("| 同じ | A \\| B |  |");
    expect(transformMarkdownTable(table, "header", 0, 0, "deleteRow")).toBeNull();
  });

  it("rejects final-column deletion and safely escapes direct cell values", () => {
    const single = collectMarkdownTables("| A |\n| --- |\n| B |")[0]!;
    expect(transformMarkdownTable(single, "body", 0, 0, "deleteColumn")).toBeNull();
    expect(escapeTableCell("A | B\\C")).toBe("A \\| B\\\\C");
  });
});
