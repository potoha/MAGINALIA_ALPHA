import { describe, expect, it } from "vitest";
import {
  confirmSave,
  createSaveSnapshot,
  editDocument,
  formatQuotationProvenance,
  insertQuotation,
  isDirty,
  openDocument
} from "./index";

describe("Writing Core document state", () => {
  it("starts clean", () => {
    const state = openDocument({ documentId: "doc-1", displayName: "notes.md", text: "draft" });

    expect(state.currentText).toBe("draft");
    expect(state.savedText).toBe("draft");
    expect(isDirty(state)).toBe(false);
  });

  it("becomes dirty after an edit", () => {
    const state = openDocument({ documentId: "doc-1", displayName: "notes.md", text: "draft" });

    expect(isDirty(editDocument(state, "draft\nchanged"))).toBe(true);
  });

  it("becomes clean when edited back to the saved text", () => {
    const state = openDocument({ documentId: "doc-1", displayName: "notes.md", text: "draft" });
    const edited = editDocument(state, "changed");

    expect(isDirty(editDocument(edited, "draft"))).toBe(false);
  });

  it("confirms a successful save", () => {
    const state = openDocument({ documentId: "doc-1", displayName: "notes.md", text: "draft" });
    const edited = editDocument(state, "saved");

    const confirmed = confirmSave(edited, createSaveSnapshot(edited));

    expect(confirmed.savedText).toBe("saved");
    expect(confirmed.currentText).toBe("saved");
    expect(isDirty(confirmed)).toBe(false);
  });

  it("keeps a newer edit dirty when an older save confirms", () => {
    const state = openDocument({ documentId: "doc-1", displayName: "notes.md", text: "draft" });
    const firstEdit = editDocument(state, "first edit");
    const inFlight = createSaveSnapshot(firstEdit);
    const newerEdit = editDocument(firstEdit, "newer edit");

    const confirmed = confirmSave(newerEdit, inFlight);

    expect(confirmed.savedText).toBe("first edit");
    expect(confirmed.currentText).toBe("newer edit");
    expect(isDirty(confirmed)).toBe(true);
  });

  it("ignores confirmation from a replaced document", () => {
    const original = openDocument({ documentId: "doc-1", displayName: "old.md", text: "old" });
    const oldSnapshot = createSaveSnapshot(editDocument(original, "old edit"));
    const replacement = openDocument({ documentId: "doc-2", displayName: "new.md", text: "new" });

    const unchanged = confirmSave(replacement, oldSnapshot);

    expect(unchanged).toBe(replacement);
    expect(unchanged.savedText).toBe("new");
    expect(unchanged.currentText).toBe("new");
    expect(isDirty(unchanged)).toBe(false);
  });

  it("preserves CRLF and a UTF-8 BOM character exactly", () => {
    const text = "\uFEFF# Heading\r\n\r\nBody\r\n";
    const state = openDocument({ documentId: "doc-1", displayName: "notes.md", text });
    const edited = editDocument(state, `${text}追加\r\n`);
    const snapshot = createSaveSnapshot(edited);
    const confirmed = confirmSave(edited, snapshot);

    expect(confirmed.currentText).toBe(`${text}追加\r\n`);
    expect(confirmed.savedText).toBe(`${text}追加\r\n`);
    expect(confirmed.currentText.codePointAt(0)).toBe(0xfeff);
    expect(confirmed.currentText).toContain("\r\n");
  });

  it("inserts a quotation at a cursor using the document's line ending", () => {
    const state = openDocument({ documentId: "doc-1", displayName: "notes.md", text: "Before\nAfter" });
    const result = insertQuotation(state, {
      documentId: "doc-1",
      start: "Before\n".length,
      end: "Before\n".length
    }, {
      annotationId: "annotation-1",
      sourceId: "source-1",
      title: "A title",
      authors: ["An author"],
      page: 12,
      quote: "quoted text"
    });

    expect(result.kind).toBe("inserted");
    if (result.kind !== "inserted") return;
    expect(result.state.currentText).toBe(
      "Before\n\nquoted text\n\n出典: A title / 著者: An author / source: source-1 / p. 12 / annotation: annotation-1\n\nAfter"
    );
    expect(result.state.savedText).toBe("Before\nAfter");
    expect(isDirty(result.state)).toBe(true);
    expect(result.selectionStart).toBe("Before\n\nquoted text\n\n出典: A title / 著者: An author / source: source-1 / p. 12 / annotation: annotation-1\n\n".length);
    expect(result.selectionEnd).toBe(result.selectionStart);
  });

  it("replaces a selection, preserves CRLF, and escapes literal Markdown", () => {
    const state = openDocument({ documentId: "doc-1", displayName: "notes.md", text: "before\r\nold\r\nafter" });
    const result = insertQuotation(state, {
      documentId: "doc-1",
      start: "before\r\n".length,
      end: "before\r\nold".length
    }, {
      annotationId: "annotation-2",
      sourceId: "source-2",
      title: "Title\nwith **markers**",
      authors: ["", "Author [one]"],
      quote: "**literal**\n[brackets] `code`"
    } as const);

    expect(result.kind).toBe("inserted");
    if (result.kind !== "inserted") return;
    expect(result.state.currentText).toBe(
      "before\r\n\r\n\\*\\*literal\\*\\*\r\n\\[brackets\\] \\`code\\`\r\n\r\n出典: Title with \\*\\*markers\\*\\* / 著者: Author \\[one\\] / source: source-2 / annotation: annotation-2\r\n\r\nafter"
    );
    expect(result.state.currentText).toContain("\r\n");
    expect(result.state.currentText).not.toContain("private");
  });

  it("omits missing authors and page from provenance", () => {
    const input = {
      annotationId: "annotation-3",
      sourceId: "source-3",
      title: "Untitled",
      authors: [],
      quote: "quote"
    } as const;

    expect(formatQuotationProvenance(input)).toBe("出典: Untitled / source: source-3 / annotation: annotation-3");
    const state = openDocument({ documentId: "doc-1", displayName: "notes.md", text: "" });
    const result = insertQuotation(state, { documentId: "doc-1", start: 0, end: 0 }, input);
    expect(result.kind).toBe("inserted");
    if (result.kind === "inserted") {
      expect(result.state.currentText).not.toContain("著者:");
      expect(result.state.currentText).not.toContain("p.");
    }
  });

  it("rejects a mismatched document or invalid range without changing state", () => {
    const state = openDocument({ documentId: "doc-1", displayName: "notes.md", text: "draft" });
    const input = {
      annotationId: "annotation-1",
      sourceId: "source-1",
      title: "Title",
      authors: [],
      quote: "quote"
    } as const;

    const mismatch = insertQuotation(state, { documentId: "doc-2", start: 0, end: 0 }, input);
    expect(mismatch).toEqual({
      kind: "error",
      code: "document-mismatch",
      message: "The quotation target belongs to another document."
    });
    const invalid = insertQuotation(state, { documentId: "doc-1", start: 5, end: 3 }, input);
    expect(invalid).toEqual({
      kind: "error",
      code: "invalid-range",
      message: "The quotation selection is outside the current document."
    });
    expect(state.currentText).toBe("draft");
    expect(isDirty(state)).toBe(false);
  });

  it("uses only the public quotation fields when formatting provenance", () => {
    const input = {
      annotationId: "annotation-private",
      sourceId: "source-private",
      title: "Public title",
      authors: ["Public author"],
      quote: "Public quote",
      privateMemo: "PRIVATE_MEMO",
      rawOcr: "PRIVATE_OCR",
      comment: "PRIVATE_COMMENT",
      path: "C:\\private\\book.md",
      captureImage: "PRIVATE_IMAGE",
      deviceMetadata: "PRIVATE_DEVICE"
    } as const;

    const provenance = formatQuotationProvenance(input);
    expect(provenance).toContain("Public title");
    expect(provenance).toContain("annotation-private");
    expect(provenance).not.toContain("PRIVATE");
    expect(provenance).not.toContain("private\\book");
  });

  it("keeps a BOM and UTF-16 cursor offsets while inserting", () => {
    const text = "\uFEFF😀\r\nbody";
    const state = openDocument({ documentId: "doc-1", displayName: "notes.md", text });
    const start = "\uFEFF😀\r\n".length;
    const result = insertQuotation(state, { documentId: "doc-1", start, end: start }, {
      annotationId: "annotation-4",
      sourceId: "source-4",
      title: "Title",
      authors: [],
      quote: "quoted"
    });

    expect(result.kind).toBe("inserted");
    if (result.kind !== "inserted") return;
    expect(result.state.currentText.codePointAt(0)).toBe(0xfeff);
    expect(result.state.currentText).toContain("\r\n");
    expect(result.state.currentText).toContain("quoted");
    expect(result.selectionStart).toBeGreaterThan(start);
  });
});
