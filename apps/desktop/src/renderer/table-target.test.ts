import { describe, expect, it } from "vitest";
import type { MarkdownTableCellTarget, MarkdownTableTarget } from "./markdown-table-commands";
import { mayDispatchTableTarget, ownsCurrentTableTarget, type ActiveTableTarget } from "./table-target";

const cell: MarkdownTableCellTarget = { rowKind: "body", rowIndex: 0, columnIndex: 0, start: 24, end: 25, value: "A" };
const table: MarkdownTableTarget = { start: 0, end: 27, header: ["Column"], rows: [["A"]], alignments: ["none"], cells: [cell] };
const target: ActiveTableTarget = { documentId: "a.md", revision: 5, table, cell };

describe("active table target ownership", () => {
  it("rejects a table control rendered for an older revision", () => {
    expect(ownsCurrentTableTarget(target, { documentId: "a.md", revision: 6 })).toBe(false);
    expect(mayDispatchTableTarget(target, { documentId: "a.md", revision: 6 }, table, cell)).toBe(false);
  });

  it("does not let a table target cross the active document boundary", () => {
    expect(mayDispatchTableTarget(target, { documentId: "b.md", revision: 5 }, table, cell)).toBe(false);
  });

  it("rejects a target cleared when Preview ownership ends", () => {
    expect(mayDispatchTableTarget(null, { documentId: "a.md", revision: 5 }, table, cell)).toBe(false);
  });
});
