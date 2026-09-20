import { describe, expect, it } from "vitest";
import { adaptBookSource, type IsbnBookSource } from "@maginalia/source-core";
import { serializeQuoteRef } from "@maginalia/writing-core";
import type { ReviewerQuotation } from "../reviewer-ipc";
import type { ResolvedQuoteRef, ReviewerResolutionResult } from "../reviewer-resolution";
import {
  renderResolvedMarkdown,
  renderResolvedProvenance,
  renderResolvedQuote,
  renderResolvedReferences,
  type ExportDocumentSnapshot
} from "./export-renderer";
import {
  REFERENCE_LIST_MARKER_END,
  REFERENCE_LIST_MARKER_START
} from "./reference-list";

const ISBN_A = "9780306406157";
const ISBN_B = "9780134685991";
const ANNOTATION_A = "annotation-a";
const ANNOTATION_B = "annotation-b";

const sourceA = adaptBookSource({
  isbn13: ISBN_A,
  title: "開かれた作品",
  authors: ["ウンベルト・エーコ"],
  publisher: "青土社",
  publishedDate: "1990"
}) as IsbnBookSource;
const sourceB = adaptBookSource({
  isbn13: ISBN_B,
  title: "第二の本",
  authors: ["第二著者"],
  publisher: "出版社"
}) as IsbnBookSource;

function quotation(annotationId: string, quote: string, overrides: Partial<ReviewerQuotation> = {}): ReviewerQuotation {
  return {
    annotationId,
    captureId: `capture-${annotationId}`,
    pageId: `page-${annotationId}`,
    sourcePageId: "source-page-internal",
    isbn13: ISBN_A,
    title: "開かれた作品",
    authors: ["ウンベルト・エーコ"],
    quote,
    pageLabel: "42",
    comment: "internal comment must not export",
    reviewState: "APPROVED",
    reviewedAtMs: 1,
    ...overrides
  };
}

function marker(annotationId: string): string {
  return serializeQuoteRef({ quoteId: annotationId, mode: "normal" });
}

function resolved(
  annotationId: string,
  offset: number,
  quote: string,
  source: IsbnBookSource = sourceA,
  overrides: Partial<ReviewerQuotation> = {}
): ResolvedQuoteRef {
  const quoteRef = { quoteId: annotationId, mode: "normal" as const };
  const quotationValue = quotation(annotationId, quote, overrides);
  const markerText = marker(annotationId);
  return {
    occurrence: { offset, marker: markerText, quoteRef },
    quoteRef,
    quotation: quotationValue,
    source
  };
}

function snapshot(currentText: string, revision = 7): ExportDocumentSnapshot {
  return { documentId: "document-a", revision, currentText };
}

function success(
  text: string,
  refs: readonly ResolvedQuoteRef[],
  sources: readonly IsbnBookSource[] = [sourceA]
): ReviewerResolutionResult {
  return { kind: "resolved", sources, resolved: refs, unresolved: [] };
}

describe("resolved Markdown renderer", () => {
  it("renders one QuoteRef as a readable quote with minimal provenance and no internal IDs", () => {
    const quoteMarker = marker(ANNOTATION_A);
    const text = `# Draft\n\n${quoteMarker}\n`;
    const item = resolved(ANNOTATION_A, text.indexOf(quoteMarker), "引用本文");
    const result = renderResolvedMarkdown(snapshot(text), success(text, [item]));

    expect(result.kind).toBe("rendered");
    if (result.kind !== "rendered") return;
    expect(result.text).toContain("> 引用本文");
    expect(result.text).toContain("（ウンベルト・エーコ『開かれた作品』、p.42）");
    expect(result.text).not.toContain(quoteMarker);
    expect(result.text).not.toContain(ANNOTATION_A);
    expect(result.text).not.toContain("source-page-internal");
    expect(result.text).not.toContain("internal comment must not export");
  });

  it("escapes multiline Markdown and raw HTML in quote text", () => {
    const quoteMarker = marker(ANNOTATION_A);
    const text = `${quoteMarker}\n`;
    const quote = "<script>alert(`x`)</script>\n# heading\n- list\n**bold**\n<!-- hidden -->";
    const item = resolved(ANNOTATION_A, 0, quote);
    const result = renderResolvedMarkdown(snapshot(text), success(text, [item]));

    expect(result.kind).toBe("rendered");
    if (result.kind !== "rendered") return;
    const lines = result.text.split("\n").filter((line) => line.length > 0);
    expect(lines.slice(0, 5).every((line) => line.startsWith("> "))).toBe(true);
    expect(result.text).not.toContain("<script>");
    expect(result.text).not.toContain("<!-- hidden -->");
    expect(result.text).toContain("\\# heading");
    expect(result.text).toContain("\\- list");
    expect(result.text).toContain("\\`x\\`");
  });

  it("renders provenance from public metadata only and omits empty fields", () => {
    const item = resolved(ANNOTATION_A, 0, "quote", adaptBookSource({ isbn13: ISBN_A }) as IsbnBookSource, {
      title: null,
      authors: [],
      pageLabel: ""
    });
    expect(renderResolvedProvenance(item)).toBe("");
    expect(renderResolvedQuote(item)).toBe("> quote");
  });

  it("deduplicates and deterministically renders current Sources", () => {
    const rendered = renderResolvedReferences([sourceB, sourceA, sourceA]);
    expect(rendered.match(/開かれた作品/gu)?.length).toBe(1);
    expect(rendered.match(/第二の本/gu)?.length).toBe(1);
    expect(rendered.indexOf("第二の本")).toBeLessThan(rendered.indexOf("開かれた作品"));
    expect(rendered).not.toContain(sourceA.id);
    expect(rendered).not.toContain(sourceB.id);
  });

  it("exports the active dirty snapshot without changing it and removes QuoteRef/reference markers", () => {
    const quoteMarker = marker(ANNOTATION_A);
    const text = `# Draft\n\n${quoteMarker}\n\n## 参考文献\n\n${REFERENCE_LIST_MARKER_START}\nold\n${REFERENCE_LIST_MARKER_END}`;
    const item = resolved(ANNOTATION_A, text.indexOf(quoteMarker), "dirty quote");
    const before = text;
    const result = renderResolvedMarkdown(snapshot(text, 12), success(text, [item]));

    expect(result.kind).toBe("rendered");
    if (result.kind !== "rendered") return;
    expect(result.text).toContain("> dirty quote");
    expect(result.text).toContain("## 参考文献");
    expect(result.text).toContain("- ウンベルト・エーコ『開かれた作品』 青土社、1990。");
    expect(result.text).not.toContain(REFERENCE_LIST_MARKER_START);
    expect(result.text).not.toContain(REFERENCE_LIST_MARKER_END);
    expect(text).toBe(before);
    expect(result.revision).toBe(12);
  });

  it("appends a normal reference heading when the authoring marker is absent", () => {
    const text = `# Draft\n\n${marker(ANNOTATION_A)}`;
    const item = resolved(ANNOTATION_A, text.indexOf(marker(ANNOTATION_A)), "quote");
    const result = renderResolvedMarkdown(snapshot(text), success(text, [item]));

    expect(result.kind).toBe("rendered");
    if (result.kind !== "rendered") return;
    expect(result.text).toContain("## 参考文献");
    expect(result.text).toContain("- ウンベルト・エーコ『開かれた作品』 青土社、1990。");
    expect(result.text).not.toContain("reference-list-");
  });

  it("exports ordinary Markdown without Reviewer when there are no QuoteRefs", () => {
    const text = "# Ordinary\n\nNo quotation markers here.\n";
    const result = renderResolvedMarkdown(snapshot(text), {
      kind: "error",
      code: "reviewer-unavailable",
      message: "Reviewer unavailable"
    });
    expect(result).toMatchObject({ kind: "rendered", text });
  });

  it("blocks unresolved results without producing partial output", () => {
    const quoteMarker = marker(ANNOTATION_A);
    const text = `${quoteMarker}\n`;
    const unresolved = {
      occurrence: { offset: 0, marker: quoteMarker, quoteRef: { quoteId: ANNOTATION_A, mode: "normal" as const } },
      quoteRef: { quoteId: ANNOTATION_A, mode: "normal" as const },
      code: "quote-not-found" as const
    };
    const result = renderResolvedMarkdown(snapshot(text), {
      kind: "resolved",
      sources: [sourceA],
      resolved: [],
      unresolved: [unresolved]
    });

    expect(result).toMatchObject({ kind: "blocked", code: "unresolved-quote" });
    if (result.kind === "blocked") expect(result).not.toHaveProperty("text");
  });

  it("blocks malformed/unknown QuoteRefs and reference marker conflicts", () => {
    const malformed = "<!-- maginalia:quote-ref v9 {\"quoteId\":\"unknown\"} -->";
    const malformedResult = renderResolvedMarkdown(snapshot(malformed), {
      kind: "resolved",
      sources: [],
      resolved: [],
      unresolved: [{
        occurrence: { offset: 0, marker: malformed, quoteRef: null },
        quoteRef: null,
        code: "malformed-marker"
      }]
    });
    expect(malformedResult).toMatchObject({ kind: "blocked", code: "unresolved-quote" });

    const unknownWithApparentlySuccessfulResolution = renderResolvedMarkdown(snapshot(malformed), {
      kind: "resolved",
      sources: [],
      resolved: [],
      unresolved: []
    });
    expect(unknownWithApparentlySuccessfulResolution).toMatchObject({ kind: "blocked", code: "unresolved-quote" });

    const unknownReference = renderResolvedMarkdown(snapshot("# Draft\n\n<!-- maginalia:reference-list-start v2 -->\n"), {
      kind: "resolved",
      sources: [],
      resolved: [],
      unresolved: []
    });
    expect(unknownReference).toMatchObject({ kind: "blocked", code: "reference-marker-conflict" });

    const quoteMarker = marker(ANNOTATION_A);
    const conflictText = `${quoteMarker}\n${REFERENCE_LIST_MARKER_START}\nold`;
    const item = resolved(ANNOTATION_A, 0, "quote");
    const conflictResult = renderResolvedMarkdown(snapshot(conflictText), success(conflictText, [item]));
    expect(conflictResult).toMatchObject({ kind: "blocked", code: "reference-marker-conflict" });
  });

  it("blocks Reviewer errors when the snapshot contains a QuoteRef", () => {
    const text = `${marker(ANNOTATION_A)}\n`;
    const result = renderResolvedMarkdown(snapshot(text), {
      kind: "error",
      code: "reviewer-unavailable",
      message: "Reviewer unavailable"
    });
    expect(result).toMatchObject({ kind: "blocked", code: "resolution-error" });
    if (result.kind === "blocked") expect(result).not.toHaveProperty("text");
  });

  it("is deterministic for repeated exports and supports multiple Sources", () => {
    const firstMarker = marker(ANNOTATION_A);
    const secondMarker = marker(ANNOTATION_B);
    const text = `${firstMarker}\n\n${secondMarker}\n`;
    const first = resolved(ANNOTATION_A, 0, "first");
    const secondOffset = text.indexOf(secondMarker);
    const second = resolved(ANNOTATION_B, secondOffset, "second", sourceB, {
      isbn13: ISBN_B,
      title: "第二の本",
      authors: ["第二著者"],
      pageLabel: "8"
    });
    const firstResult = renderResolvedMarkdown(snapshot(text), success(text, [first, second], [sourceA, sourceB]));
    expect(firstResult.kind).toBe("rendered");
    if (firstResult.kind !== "rendered") return;
    const secondResult = renderResolvedMarkdown(snapshot(text), success(text, [first, second], [sourceB, sourceA, sourceA]));
    expect(secondResult.kind).toBe("rendered");
    if (secondResult.kind !== "rendered") return;
    expect(secondResult.text).toBe(firstResult.text);
  });
});
