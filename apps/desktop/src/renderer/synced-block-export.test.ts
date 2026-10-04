import type { Annotation, Book } from "@maginalia/format";
import { serializeQuoteRef } from "@maginalia/writing-core";
import { describe, expect, it } from "vitest";

import { resolveShelfQuoteRefs, type CanonicalShelfEntities } from "../shelf-resolution";
import { renderResolvedMarkdown } from "./export-renderer";
import { REFERENCE_LIST_MARKER_START } from "./reference-list";
import {
  linearizeProjectComposition,
  resolveProjectComposition,
  serializeSyncedBlock
} from "./synced-block";

const BOOK_A = "isbn:9780306406157";
const BOOK_B = "isbn:9780134685991";
const QUOTE_A = "ann:01J0A1B2C3D4E5F6G7H8J9K0M1";
const QUOTE_B = "ann:01J0A1B2C3D4E5F6G7H8J9K0M2";

function quote(quoteId: string): string {
  return serializeQuoteRef({ quoteId, mode: "normal" });
}

const shelf: CanonicalShelfEntities = {
  books: [
    { type: "book", version: "0.1", id: BOOK_A, isbn13: "9780306406157", title: "Direct source", authors: ["A"], publisher: "P", year: 1990 },
    { type: "book", version: "0.1", id: BOOK_B, isbn13: "9780134685991", title: "Nested source", authors: ["B"], publisher: "P", year: 1991 },
  ] as readonly Book[],
  annotations: [
    { type: "annotation", version: "0.1", id: QUOTE_A, source: BOOK_A, location: { page: 1 }, quote: "Direct quotation" },
    { type: "annotation", version: "0.1", id: QUOTE_B, source: BOOK_B, location: { page: 2 }, quote: "Nested quotation" },
  ] as readonly Annotation[],
};

describe("Synced Block citation/export projection", () => {
  it("resolves direct and nested QuoteRefs from one linear snapshot and emits one final reference list", async () => {
    const childReferenceList = `## 参考文献\n\n${REFERENCE_LIST_MARKER_START}\n- stale child source\n<!-- maginalia:reference-list-end v1 -->\n`;
    const sources = new Map<string, string>([
      ["parent.md", `# Parent\n\n${quote(QUOTE_A)}\n\n${serializeSyncedBlock("child.md")}\n`],
      ["child.md", `---\ntitle: Child\n---\n# Child\n${quote(QUOTE_B)}\n${serializeSyncedBlock("nested.md")}\n${childReferenceList}`],
      ["nested.md", `# Nested\n${quote(QUOTE_A)}\n`],
    ]);
    const composition = await resolveProjectComposition(sources.get("parent.md")!, {
      rootTarget: "parent.md",
      resolve: async (target) => ({ kind: "resolved", target, fileId: target, displayName: target, text: sources.get(target)! }),
    });
    const linear = linearizeProjectComposition(sources.get("parent.md")!, composition);
    expect(linear.kind).toBe("linear");
    if (linear.kind !== "linear") return;
    expect(linear.markdown).not.toContain("maginalia:synced-block");
    expect(linear.markdown).toContain(quote(QUOTE_A));
    expect(linear.markdown).toContain(quote(QUOTE_B));
    expect(linear.markdown).not.toContain("stale child source");

    const resolution = await resolveShelfQuoteRefs(linear.markdown, shelf);
    expect(resolution).toMatchObject({ kind: "resolved", unresolved: [] });
    if (resolution.kind !== "resolved") return;
    expect(resolution.resolved).toHaveLength(3);
    expect(resolution.sources).toHaveLength(2);

    const rendered = renderResolvedMarkdown({ documentId: "parent", revision: 7, currentText: linear.markdown }, resolution);
    expect(rendered.kind).toBe("rendered");
    if (rendered.kind !== "rendered") return;
    expect(rendered.text).toContain("Direct quotation");
    expect(rendered.text).toContain("Nested quotation");
    expect(rendered.text).not.toContain("maginalia:synced-block");
    expect(rendered.text.match(/## 参考文献/gu)).toHaveLength(1);
    expect(sources.get("parent.md")).toContain(serializeSyncedBlock("child.md"));
  });
});
