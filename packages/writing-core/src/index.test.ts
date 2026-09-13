import { describe, expect, it } from "vitest";
import {
  confirmSave,
  createSaveSnapshot,
  editDocument,
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
});
