import { describe, expect, it, vi } from "vitest";
import {
  isDirty,
  parseQuoteRef,
  type DocumentState,
  type QuotationInsertionInput,
  type QuoteRef
} from "@maginalia/writing-core";
import type {
  OpenMarkdownSuccess,
  OpenMarkdownResult,
  SaveMarkdownRequest,
  SaveMarkdownResult
} from "../markdown-ipc";
import {
  WritingController,
  type WritingTextRange,
  type WritingStatus,
  type WritingSurface,
  type WritingView
} from "./controller";
import { DocumentSessionStore } from "./document-sessions";

class FakeSurface implements WritingSurface {
  private readonly listeners = new Set<(text: string) => void>();
  public text = "";
  public readonly replacedTexts: string[] = [];
  public selection: WritingTextRange = { start: 0, end: 0 };
  public readonly appliedEdits: Array<{ range: WritingTextRange; text: string; selection: WritingTextRange }> = [];
  public focused = false;

  public replaceDocument(text: string): void {
    this.text = text;
    this.selection = { start: 0, end: 0 };
    this.replacedTexts.push(text);
  }

  public getText(): string {
    return this.text;
  }

  public getSelection(): WritingTextRange {
    return { ...this.selection };
  }

  public applyEdit(range: WritingTextRange, text: string, selection: WritingTextRange): void {
    this.appliedEdits.push({ range: { ...range }, text, selection: { ...selection } });
    this.text = `${this.text.slice(0, range.start)}${text}${this.text.slice(range.end)}`;
    this.selection = { ...selection };
    for (const listener of this.listeners) listener(this.text);
  }

  public onTextChange(listener: (text: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public focus(): void {
    this.focused = true;
  }

  public edit(text: string): void {
    this.text = text;
    this.selection = { start: text.length, end: text.length };
    for (const listener of this.listeners) listener(text);
  }
}

class FakeView implements WritingView {
  public documentName = "";
  public status: WritingStatus = { kind: "empty", message: "" };
  public saveEnabled = false;
  public readonly statuses: WritingStatus[] = [];

  public setDocumentName(name: string): void {
    this.documentName = name;
  }

  public setStatus(status: WritingStatus): void {
    this.status = status;
    this.statuses.push(status);
  }

  public setSaveEnabled(enabled: boolean): void {
    this.saveEnabled = enabled;
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function opened(
  sessionId = "session-1",
  displayName = "notes.md",
  text = "base"
): OpenMarkdownSuccess {
  return { kind: "opened", sessionId, displayName, text };
}

function makeHarness(options: {
  open?: () => Promise<OpenMarkdownResult>;
  save?: (request: SaveMarkdownRequest) => Promise<SaveMarkdownResult>;
  confirmReplace?: (displayName: string) => boolean | Promise<boolean>;
} = {}) {
  const surface = new FakeSurface();
  const view = new FakeView();
  const openMarkdown = options.open ?? (() => Promise.resolve(opened()));
  const saveMarkdown = options.save ?? (() => Promise.resolve({
    kind: "saved",
    sessionId: "session-1",
    displayName: "notes.md",
    text: "changed"
  } as const));
  const controller = new WritingController({
    api: { openMarkdown, saveMarkdown },
    surface,
    view,
    confirmReplace: options.confirmReplace ?? (() => true)
  });
  return { controller, surface, view };
}

async function openDefault(controller: WritingController): Promise<void> {
  await controller.open();
}

const quotation: QuotationInsertionInput = {
  annotationId: "annotation-1",
  sourceId: "source-1",
  title: "A title",
  authors: ["An author"],
  page: 3,
  quote: "**literal** [brackets]"
};

const quoteRef: QuoteRef = {
  quoteId: "reviewer-annotation-1",
  mode: "normal"
};

describe("WritingController", () => {
  it("opens and displays the selected document", async () => {
    const { controller, surface, view } = makeHarness({
      open: () => Promise.resolve(opened("opaque-7", "draft.markdown", "# Draft\r\n\uFEFFbody"))
    });

    await controller.open();

    expect(surface.text).toBe("# Draft\r\n\uFEFFbody");
    expect(surface.replacedTexts).toEqual(["# Draft\r\n\uFEFFbody"]);
    expect(surface.focused).toBe(true);
    expect(view.documentName).toBe("draft.markdown");
    expect(view.status).toEqual({ kind: "saved", message: "Saved" });
    expect(view.saveEnabled).toBe(false);
    expect(controller.getDocumentState()).toMatchObject({
      documentId: "opaque-7",
      displayName: "draft.markdown",
      currentText: "# Draft\r\n\uFEFFbody",
      savedText: "# Draft\r\n\uFEFFbody"
    });
  });

  it("applies an already opened Markdown result without calling the host", () => {
    const { controller, surface, view } = makeHarness();

    controller.applyOpenedDocument({
      kind: "opened",
      sessionId: "session-applied",
      displayName: "applied.md",
      text: "applied\r\n"
    });

    expect(surface.text).toBe("applied\r\n");
    expect(controller.getDocumentState()).toMatchObject({
      documentId: "session-applied",
      currentText: "applied\r\n",
      savedText: "applied\r\n"
    });
    expect(view.status).toEqual({ kind: "saved", message: "Saved" });
  });

  it("clears the active Writing state and editor surface", async () => {
    const { controller, surface, view } = makeHarness();
    await openDefault(controller);
    surface.edit("draft");

    controller.clearDocument();

    expect(controller.getDocumentState()).toBeNull();
    expect(surface.text).toBe("");
    expect(view.status).toEqual({ kind: "empty", message: "No document open" });
    expect(view.saveEnabled).toBe(false);
  });

  it("marks an edit dirty", async () => {
    const { controller, surface, view } = makeHarness();
    await openDefault(controller);

    surface.edit("changed");

    expect(controller.getDocumentState()?.currentText).toBe("changed");
    expect(isDirty(controller.getDocumentState() as DocumentState)).toBe(true);
    expect(view.status).toEqual({ kind: "modified", message: "Modified" });
    expect(view.saveEnabled).toBe(true);
  });

  it("returns to clean when an edit reverts to the saved text", async () => {
    const { controller, surface, view } = makeHarness();
    await openDefault(controller);

    surface.edit("changed");
    surface.edit("base");

    expect(isDirty(controller.getDocumentState() as DocumentState)).toBe(false);
    expect(view.status).toEqual({ kind: "saved", message: "Saved" });
    expect(view.saveEnabled).toBe(false);
  });

  it("confirms a successful save", async () => {
    const save = vi.fn((request: SaveMarkdownRequest) => Promise.resolve({
      kind: "saved",
      sessionId: request.sessionId,
      displayName: "notes.md",
      text: request.text
    } as const));
    const { controller, surface, view } = makeHarness({ save });
    await openDefault(controller);
    surface.edit("changed");

    await controller.save();

    expect(save).toHaveBeenCalledWith({ sessionId: "session-1", text: "changed" });
    expect(controller.getDocumentState()).toMatchObject({
      currentText: "changed",
      savedText: "changed"
    });
    expect(view.status).toEqual({ kind: "saved", message: "Saved" });
    expect(view.saveEnabled).toBe(false);
  });

  it("keeps a newer edit dirty after an in-flight save confirms", async () => {
    const pending = deferred<SaveMarkdownResult>();
    const save = vi.fn(() => pending.promise);
    const { controller, surface, view } = makeHarness({ save });
    await openDefault(controller);
    surface.edit("first");

    const saving = controller.save();
    await Promise.resolve();
    surface.edit("newer");
    expect(view.status).toEqual({ kind: "saving", message: "Saving…" });

    pending.resolve({
      kind: "saved",
      sessionId: "session-1",
      displayName: "notes.md",
      text: "first"
    });
    await saving;

    expect(controller.getDocumentState()).toMatchObject({
      currentText: "newer",
      savedText: "first"
    });
    expect(isDirty(controller.getDocumentState() as DocumentState)).toBe(true);
    expect(view.status).toEqual({ kind: "modified", message: "Modified" });
    expect(view.saveEnabled).toBe(true);
  });

  it("coalesces a second save request and saves the latest text", async () => {
    const first = deferred<SaveMarkdownResult>();
    const second = deferred<SaveMarkdownResult>();
    const requests: SaveMarkdownRequest[] = [];
    const save = vi.fn((request: SaveMarkdownRequest) => {
      requests.push(request);
      return requests.length === 1 ? first.promise : second.promise;
    });
    const { controller, surface, view } = makeHarness({ save });
    await openDefault(controller);
    surface.edit("first");

    const firstSave = controller.save();
    await Promise.resolve();
    surface.edit("second");
    const secondIntent = controller.save();

    expect(secondIntent).toBe(firstSave);
    expect(requests).toEqual([{ sessionId: "session-1", text: "first" }]);

    first.resolve({
      kind: "saved",
      sessionId: "session-1",
      displayName: "notes.md",
      text: "first"
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(requests).toEqual([
      { sessionId: "session-1", text: "first" },
      { sessionId: "session-1", text: "second" }
    ]);

    second.resolve({
      kind: "saved",
      sessionId: "session-1",
      displayName: "notes.md",
      text: "second"
    });
    await firstSave;

    expect(view.status).toEqual({ kind: "saved", message: "Saved" });
    expect(view.saveEnabled).toBe(false);
    expect(controller.getDocumentState()).toMatchObject({
      currentText: "second",
      savedText: "second"
    });
  });

  it("preserves a dirty document when replacement is cancelled", async () => {
    let calls = 0;
    const open = vi.fn(() => {
      calls += 1;
      return Promise.resolve(calls === 1
        ? opened()
        : opened("session-2", "other.md", "other"));
    });
    const confirmReplace = vi.fn(() => false);
    const { controller, surface, view } = makeHarness({ open, confirmReplace });
    await openDefault(controller);
    surface.edit("unsaved");

    await controller.open();

    expect(confirmReplace).toHaveBeenCalledWith("notes.md");
    expect(open).toHaveBeenCalledTimes(1);
    expect(surface.text).toBe("unsaved");
    expect(view.documentName).toBe("notes.md");
    expect(view.status).toEqual({ kind: "modified", message: "Modified" });
  });

  it("captures a cursor and inserts a quotation through one surface edit", async () => {
    const save = vi.fn((request: SaveMarkdownRequest) => Promise.resolve({
      kind: "saved",
      sessionId: request.sessionId,
      displayName: "notes.md",
      text: request.text
    } as const));
    const { controller, surface, view } = makeHarness({ save });
    await openDefault(controller);
    surface.selection = { start: 2, end: 2 };

    const target = controller.captureInsertionTarget();
    expect(target).toMatchObject({ documentId: "session-1", revision: 1, range: { start: 2, end: 2 } });
    const result = controller.insertQuotation(target as NonNullable<typeof target>, quotation);

    expect(result.kind).toBe("inserted");
    expect(surface.appliedEdits).toHaveLength(1);
    expect(surface.appliedEdits[0]).toMatchObject({ range: { start: 2, end: 2 } });
    expect(surface.selection).toEqual({
      start: (result as Extract<typeof result, { kind: "inserted" }>).selectionStart,
      end: (result as Extract<typeof result, { kind: "inserted" }>).selectionEnd
    });
    expect(surface.text).toContain("\\*\\*literal\\*\\* \\[brackets\\]");
    expect(controller.hasUnsavedChanges()).toBe(true);
    expect(view.status).toEqual({ kind: "modified", message: "Modified" });
    expect(view.saveEnabled).toBe(true);

    await controller.save();

    expect(save).toHaveBeenCalledWith({ sessionId: "session-1", text: surface.text });
    expect(controller.hasUnsavedChanges()).toBe(false);
    expect(view.status).toEqual({ kind: "saved", message: "Saved" });
  });

  it("captures a cursor and inserts a QuoteRef through one surface edit", async () => {
    const save = vi.fn((request: SaveMarkdownRequest) => Promise.resolve({
      kind: "saved",
      sessionId: request.sessionId,
      displayName: "notes.md",
      text: request.text
    } as const));
    const { controller, surface, view } = makeHarness({ save });
    await openDefault(controller);
    surface.selection = { start: 2, end: 2 };

    const target = controller.captureInsertionTarget();
    const result = controller.insertQuoteRef(target as NonNullable<typeof target>, quoteRef);

    expect(result.kind).toBe("inserted");
    expect(surface.appliedEdits).toHaveLength(1);
    expect(surface.text).toContain(
      '<!-- maginalia:quote-ref v1 {"quoteId":"reviewer-annotation-1","mode":"normal"} -->'
    );
    expect(surface.text).not.toContain("literal");
    expect(parseQuoteRef(
      '<!-- maginalia:quote-ref v1 {"quoteId":"reviewer-annotation-1","mode":"normal"} -->'
    )).toEqual(quoteRef);
    expect(controller.hasUnsavedChanges()).toBe(true);
    expect(view.status).toEqual({ kind: "modified", message: "Modified" });
    expect(view.saveEnabled).toBe(true);

    await controller.save();

    expect(save).toHaveBeenCalledWith({ sessionId: "session-1", text: surface.text });
    expect(controller.hasUnsavedChanges()).toBe(false);
    expect(view.status).toEqual({ kind: "saved", message: "Saved" });
  });

  it("replaces derived text through one surface edit and saves the result", async () => {
    const save = vi.fn((request: SaveMarkdownRequest) => Promise.resolve({
      kind: "saved",
      sessionId: request.sessionId,
      displayName: "notes.md",
      text: request.text
    } as const));
    const { controller, surface, view } = makeHarness({ save });
    await openDefault(controller);
    surface.selection = { start: 2, end: 2 };
    const changes: Array<string | null> = [];
    controller.onDocumentChange((document) => changes.push(document?.currentText ?? null));

    expect(controller.replaceText("base\n## 参考文献\nentry")).toBe(true);
    expect(surface.appliedEdits).toHaveLength(1);
    expect(surface.appliedEdits[0]).toMatchObject({ range: { start: 0, end: 4 } });
    expect(controller.hasUnsavedChanges()).toBe(true);
    expect(view.saveEnabled).toBe(true);
    expect(changes.at(-1)).toBe("base\n## 参考文献\nentry");

    await controller.save();
    expect(save).toHaveBeenCalledWith({
      sessionId: "session-1",
      text: "base\n## 参考文献\nentry"
    });
    expect(controller.hasUnsavedChanges()).toBe(false);
  });

  it("replaces a captured selection and keeps an invalid insertion non-destructive", async () => {
    const { controller, surface } = makeHarness();
    await openDefault(controller);
    surface.edit("before old after");
    surface.selection = { start: 7, end: 10 };
    const target = controller.captureInsertionTarget();
    expect(target).not.toBeNull();

    const result = controller.insertQuotation(target as NonNullable<typeof target>, {
      ...quotation,
      quote: "replacement"
    });
    expect(result.kind).toBe("inserted");
    expect(surface.text).toContain("replacement");
    expect(surface.text).not.toContain("old");
    expect(surface.appliedEdits).toHaveLength(1);

    const currentTarget = controller.captureInsertionTarget();
    expect(currentTarget).not.toBeNull();
    const invalid = controller.insertQuotation({
      ...(currentTarget as NonNullable<typeof currentTarget>),
      range: { start: 999, end: 999 }
    }, quotation);
    expect(invalid).toMatchObject({ kind: "error", code: "invalid-range" });
    expect(surface.appliedEdits).toHaveLength(1);
  });

  it("rejects a quotation target after an edit", async () => {
    const { controller, surface } = makeHarness();
    await openDefault(controller);
    const target = controller.captureInsertionTarget();
    surface.edit("newer");

    const result = controller.insertQuotation(target as NonNullable<typeof target>, quotation);

    expect(result).toMatchObject({ kind: "error", code: "stale-target" });
    expect(surface.appliedEdits).toHaveLength(0);
    expect(surface.text).toBe("newer");
  });

  it("rejects a quotation target after opening another document", async () => {
    const { controller, surface } = makeHarness();
    await openDefault(controller);
    const target = controller.captureInsertionTarget();
    controller.applyOpenedDocument(opened("session-2", "other.md", "other"));

    const result = controller.insertQuotation(target as NonNullable<typeof target>, quotation);

    expect(result).toMatchObject({ kind: "error", code: "stale-target" });
    expect(surface.appliedEdits).toHaveLength(0);
    expect(surface.text).toBe("other");
  });

  it("rejects a quotation target after clearing the document", async () => {
    const { controller, surface } = makeHarness();
    await openDefault(controller);
    const target = controller.captureInsertionTarget();
    controller.clearDocument();

    const result = controller.insertQuotation(target as NonNullable<typeof target>, quotation);

    expect(result).toMatchObject({ kind: "error", code: "stale-target" });
    expect(surface.appliedEdits).toHaveLength(0);
    expect(surface.text).toBe("");
  });

  it("preserves the current document when opening is cancelled", async () => {
    let calls = 0;
    const open = vi.fn(() => {
      calls += 1;
      return Promise.resolve(calls === 1 ? opened() : { kind: "cancelled" } as const);
    });
    const { controller, surface, view } = makeHarness({ open });
    await openDefault(controller);
    surface.edit("unsaved");

    await controller.open();

    expect(surface.text).toBe("unsaved");
    expect(view.status).toEqual({ kind: "modified", message: "Modified" });
    expect(controller.getDocumentState()?.currentText).toBe("unsaved");
  });

  it("keeps dirty text when central tabs switch and re-activate", () => {
    const { controller, surface } = makeHarness();
    controller.applyOpenedDocument(opened("session-a", "a.md", "A"));
    surface.edit("A edited");
    controller.applyOpenedDocument(opened("session-b", "b.md", "B"));

    expect(surface.text).toBe("B");
    expect(controller.activateDocument("session-a")).toBe(true);
    expect(surface.text).toBe("A edited");
    expect(controller.getDocumentState()?.savedText).toBe("A");
    expect(controller.getDocumentViews()).toHaveLength(2);
  });

  it("rejects a secondary duplicate without deleting the central dirty session", async () => {
    const { controller, surface } = makeHarness();
    controller.applyOpenedDocument(opened("session-a", "a.md", "A"));
    surface.edit("A edited");
    const secondary = controller.getSessionStore().openView("session-a", {
      region: "secondary",
      groupId: "sidebar-group-1"
    });
    expect(secondary).toBeNull();
    expect(controller.getDocumentState()?.currentText).toBe("A edited");
    expect(controller.getDocumentSessions()).toHaveLength(1);
  });

  it("does not create a second view for a document already open centrally", () => {
    const store = new DocumentSessionStore();
    const leftSurface = new FakeSurface();
    const rightSurface = new FakeSurface();
    const leftView = new FakeView();
    const rightView = new FakeView();
    const sharedLeft = new WritingController({
      api: { openMarkdown: async () => ({ kind: "cancelled" as const }), saveMarkdown: async () => ({ kind: "error" as const, code: "save-failed" as const, message: "unused" }) },
      surface: leftSurface,
      view: leftView,
      confirmReplace: () => true,
      sessionStore: store
    });
    const sharedRight = new WritingController({
      api: { openMarkdown: async () => ({ kind: "cancelled" as const }), saveMarkdown: async () => ({ kind: "error" as const, code: "save-failed" as const, message: "unused" }) },
      surface: rightSurface,
      view: rightView,
      confirmReplace: () => true,
      sessionStore: store
    });
    sharedLeft.applyOpenedDocument(opened("session-shared", "shared.md", "base"));
    const secondary = store.openView("session-shared", { region: "secondary", groupId: "sidebar-group-1" });
    expect(secondary).toBeNull();
    expect(sharedRight.activateDocument("session-shared", "secondary")).toBe(false);

    expect(leftSurface.text).toBe("base");
    expect(store.getSession("session-shared")?.currentText).toBe("base");
    sharedLeft.dispose();
    sharedRight.dispose();
  });

  it.each([
    {
      name: "a conflict",
      result: {
        kind: "conflict",
        code: "external-change",
        message: "The file changed on disk."
      } as const
    },
    {
      name: "a save error",
      result: {
        kind: "error",
        code: "save-failed",
        message: "The file could not be saved."
      } as const
    }
  ])("preserves the draft after $name", async ({ result }) => {
    const { controller, surface, view } = makeHarness({
      save: () => Promise.resolve(result)
    });
    await openDefault(controller);
    surface.edit("unsaved");

    await controller.save();

    expect(surface.text).toBe("unsaved");
    expect(controller.getDocumentState()).toMatchObject({
      currentText: "unsaved",
      savedText: "base"
    });
    expect(isDirty(controller.getDocumentState() as DocumentState)).toBe(true);
    expect(view.status).toEqual({ kind: "error", message: result.message });
    expect(view.saveEnabled).toBe(true);
  });
});
