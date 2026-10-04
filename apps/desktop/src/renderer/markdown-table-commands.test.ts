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
    expect(escapeTableCell("A | B\\C")).toBe("A \\| B\\C");
    expect(escapeTableCell("A\\|B")).toBe("A\\\\\\|B");
  });

  it.each([
    ["heading", "# Heading | text"],
    ["blockquote", "> quote | text"],
    ["bullet list", "- item | text"],
    ["ordered list", "1. item | text"],
    ["fenced code", "```txt\nfenced | content\n```"]
  ])("stops source mapping before a following %s block", (_name, following) => {
    const tableSource = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    const source = `${tableSource}\n${following}`;
    const table = collectMarkdownTables(source)[0]!;
    const suffix = source.slice(tableSource.length + 1);
    expect(table.end).toBe(tableSource.length);
    const replacement = transformMarkdownTable(table, "body", 0, 0, "addColumnAfter")!;
    const next = `${source.slice(0, table.start)}${replacement}${source.slice(table.end)}`;
    expect(next.slice(next.indexOf("\n", replacement.length) + 1)).toBe(suffix);
  });

  it("round-trips unchanged logical values without multiplying ordinary backslashes", () => {
    const paths = ["C:\\Users", "regex\\d+", "foo\\bar", "\\leading", "trailing\\", "日本\\語", "A \\| B", "A\\\\\\|B"];
    const source = ["| Value |", "| --- |", ...paths.map((value) => `| ${value} |`)].join("\n");
    const table = collectMarkdownTables(source)[0]!;
    expect(table.rows.map(([value]) => value)).toEqual(["C:\\Users", "regex\\d+", "foo\\bar", "\\leading", "trailing\\", "日本\\語", "A | B", "A\\|B"]);

    const replacement = transformMarkdownTable(table, "body", 0, 0, "addColumnAfter")!;
    const rewritten = collectMarkdownTables(replacement)[0]!;
    expect(rewritten.rows.map(([value]) => value)).toEqual(table.rows.map(([value]) => value));
    expect(replacement).toContain("| C:\\Users |  |");
    expect(replacement).toContain("| A \\| B |  |");
  });

  it("ignores table-looking code fences so a real table keeps the first authoring target", () => {
    const fake = ["```md", "| Fake | Table |", "| --- | --- |", "| A | B |", "```"].join("\n");
    const real = ["| Real | Table |", "| --- | --- |", "| C | D |"].join("\n");
    const source = `${fake}\n\n${real}`;
    const tables = collectMarkdownTables(source);

    expect(tables).toHaveLength(1);
    expect(tables[0]?.start).toBe(source.indexOf(real));
    expect(tables[0]?.header).toEqual(["Real", "Table"]);

    const replacement = transformMarkdownTable(tables[0]!, "body", 0, 1, "addColumnAfter")!;
    const next = `${source.slice(0, tables[0]!.start)}${replacement}${source.slice(tables[0]!.end)}`;
    expect(next.slice(0, fake.length)).toBe(fake);
    expect(next).toContain("| Real | Table |  |");
  });

  it.each([
    ["tilde fence", "~~~\n| fake | table |\n| --- | --- |\n~~~"],
    ["longer fence with a shorter non-closing run", "````\n| fake | table |\n| --- | --- |\n```\nstill code\n````"],
    ["unterminated fence", "```md\n| fake | table |\n| --- | --- |\n\n| also | still-code |\n| --- | --- |"]
  ])("does not collect table syntax inside a %s", (_name, fenced) => {
    expect(collectMarkdownTables(fenced)).toEqual([]);
  });

  it("resumes collection after a closed fence", () => {
    const source = "~~~~\n| fake | table |\n| --- | --- |\n~~~~\n\n| real | table |\n| --- | --- |";
    expect(collectMarkdownTables(source).map((table) => table.header)).toEqual([["real", "table"]]);
  });
});
