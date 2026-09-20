import { openDocument, type DocumentState } from "@maginalia/writing-core";
import { adaptBookSource, type IsbnBookSource } from "@maginalia/source-core";
import { describe, expect, it, vi } from "vitest";
import type { ResolveReferencesResult } from "../reference-ipc";
import { REFERENCE_LIST_MARKER_END, REFERENCE_LIST_MARKER_START } from "./reference-list";
import {
  ReferencesController,
  type ReferencesControllerApi,
  type ReferencesViewState,
  type ReferencesWritingPort
} from "./references-controller";

const source = adaptBookSource({
  isbn13: "9780307476463",
  title: "開かれた作品",
  authors: ["ウンベルト・エーコ"],
  publisher: "青土社"
}) as IsbnBookSource;

function resolved(text: string, unresolved: number = 0): ResolveReferencesResult {
  return {
    kind: "resolved",
    sources: [source],
    resolved: [],
    unresolved: Array.from({ length: unresolved }, (_, index) => ({
      occurrence: { offset: index, marker: "marker", quoteRef: null },
      quoteRef: null,
      code: "malformed-marker"
    }))
  };
}

function error(): ResolveReferencesResult {
  return {
    kind: "error",
    code: "reviewer-unavailable",
    message: "offline"
  };
}

class FakeWriting implements ReferencesWritingPort {
  private document: DocumentState | null;
  private readonly listeners = new Set<(document: DocumentState | null) => void>();
  public readonly replaceTextCalls: string[] = [];

  public constructor(text: string | null) {
    this.document = text === null ? null : openDocument({ documentId: "doc-1", displayName: "draft.md", text });
  }

  public getDocumentState(): DocumentState | null {
    return this.document;
  }

  public onDocumentChange(listener: (document: DocumentState | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public replaceText(nextText: string): boolean {
    if (this.document === null) return false;
    this.replaceTextCalls.push(nextText);
    this.document = { ...this.document, currentText: nextText };
    for (const listener of this.listeners) listener(this.document);
    return true;
  }
}

function createController(
  writing: FakeWriting,
  result: ResolveReferencesResult | (() => ResolveReferencesResult | Promise<ResolveReferencesResult>)
) {
  const view = { setReferencesState: vi.fn<(state: ReferencesViewState) => void>() };
  const api: ReferencesControllerApi = {
    resolveReferences: vi.fn(async () => typeof result === "function" ? result() : result)
  };
  const controller = new ReferencesController({ writing, api, view });
  return { controller, api, view };
}

describe("ReferencesController", () => {
  it("applies a successful derived list through WritingController and reports unresolved count", async () => {
    const writing = new FakeWriting("# Draft\n");
    const { controller, view } = createController(writing, resolved("# Draft\n", 2));
    await controller.refresh();
    expect(writing.replaceTextCalls).toHaveLength(1);
    expect(writing.getDocumentState()?.currentText).toContain("開かれた作品");
    expect(view.setReferencesState).toHaveBeenLastCalledWith(expect.objectContaining({
      status: "ready",
      unresolvedCount: 2
    }));
  });

  it("keeps the previous generated region when Reviewer refresh fails", async () => {
    const previous = `# Draft\n${REFERENCE_LIST_MARKER_START}\nold\n${REFERENCE_LIST_MARKER_END}`;
    const writing = new FakeWriting(previous);
    const { controller, view } = createController(writing, error());
    await controller.refresh();
    expect(writing.getDocumentState()?.currentText).toBe(previous);
    expect(writing.replaceTextCalls).toHaveLength(0);
    expect(view.setReferencesState).toHaveBeenLastCalledWith(expect.objectContaining({ status: "error" }));
  });

  it("does not call the API when there is no open document", async () => {
    const writing = new FakeWriting(null);
    const { controller, api, view } = createController(writing, error());
    await controller.refresh();
    expect(api.resolveReferences).not.toHaveBeenCalled();
    expect(view.setReferencesState).toHaveBeenLastCalledWith(expect.objectContaining({ status: "empty" }));
  });

  it("does not apply a stale result after the document changes during refresh", async () => {
    const writing = new FakeWriting("# Draft\n");
    let resolve: ((result: ResolveReferencesResult) => void) | undefined;
    const pending = new Promise<ResolveReferencesResult>((done) => { resolve = done; });
    const { controller, view } = createController(writing, () => pending);
    const refreshing = controller.refresh();
    writing.replaceText("# Changed\n");
    resolve?.(resolved("# Draft\n"));
    await refreshing;
    expect(writing.replaceTextCalls).toEqual(["# Changed\n"]);
    expect(view.setReferencesState).toHaveBeenLastCalledWith(expect.objectContaining({ status: "needs-refresh" }));
  });
});
