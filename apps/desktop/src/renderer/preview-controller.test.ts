import { openDocument, type DocumentState } from "@maginalia/writing-core";
import { describe, expect, it, vi } from "vitest";
import type { ResolveReferencesResult } from "../reference-ipc";
import { DEFAULT_EXPORT_PRESENTATION_SETTINGS } from "../export-presentation-settings";
import { PreviewController, type PreviewView, type PreviewWritingPort } from "./preview-controller";
import type { RendererPreferenceStore } from "./renderer-preferences";

class FakeWriting implements PreviewWritingPort {
  public document: DocumentState | null;
  private readonly listeners = new Set<(document: DocumentState | null) => void>();
  public constructor(text: string | null) {
    this.document = text === null ? null : openDocument({ documentId: "doc-1", displayName: "draft.md", text });
  }
  public getDocumentState(): DocumentState | null { return this.document; }
  public onDocumentChange(listener: (document: DocumentState | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  public setText(text: string): void {
    if (this.document === null) return;
    this.document = { ...this.document, currentText: text };
    for (const listener of this.listeners) listener(this.document);
  }
}

const preferences: RendererPreferenceStore = {
  load: () => ({
    version: 1,
    defaultWritingDirection: "horizontal",
    optimizeDroppedImages: true,
    exportPresentationSettings: DEFAULT_EXPORT_PRESENTATION_SETTINGS
  }),
  save: vi.fn()
};

function success(): ResolveReferencesResult {
  return { kind: "resolved", sources: [], resolved: [], unresolved: [] };
}

describe("PreviewController", () => {
  it("changes only presentation state, not the shared document text", () => {
    const writing = new FakeWriting("# 原稿");
    const view: PreviewView = { setPreviewState: vi.fn() };
    const controller = new PreviewController({ writing, api: { resolveReferences: vi.fn(async () => success()) }, view, preferences });
    const before = writing.getDocumentState();
    controller.setMode("preview");
    controller.setDirection("vertical");
    expect(writing.getDocumentState()).toEqual(before);
    expect(controller.getDirection()).toBe("vertical");
  });

  it("propagates heading edits through the existing document-change refresh path", () => {
    const writing = new FakeWriting("# 初稿");
    const view: PreviewView = { setPreviewState: vi.fn() };
    const controller = new PreviewController({ writing, api: { resolveReferences: vi.fn(async () => success()) }, view, preferences });
    controller.setMode("preview");
    writing.setText("###### 改稿");
    const latest = vi.mocked(view.setPreviewState).mock.calls.at(-1)?.[0];
    expect(latest?.document?.currentText).toBe("###### 改稿");
    expect(writing.getDocumentState()?.savedText).toBe("# 初稿");
  });

  it("defers Preview replacement while an editable text island has focus, then refreshes on blur", () => {
    const writing = new FakeWriting("before");
    const view: PreviewView = { setPreviewState: vi.fn() };
    const controller = new PreviewController({ writing, api: null, view, preferences });
    controller.setMode("preview");
    const before = vi.mocked(view.setPreviewState).mock.calls.length;
    controller.setInlineEditing("doc-1");
    writing.setText("during composition");
    expect(vi.mocked(view.setPreviewState).mock.calls).toHaveLength(before);
    controller.setInlineEditing(null);
    expect(vi.mocked(view.setPreviewState).mock.calls.at(-1)?.[0].document?.currentText).toBe("during composition");
  });

  it("leaves a failed Reviewer lookup as an unresolved preview item", async () => {
    const marker = '<!-- maginalia:quote-ref v1 {"quoteId":"a","mode":"normal"} -->';
    const writing = new FakeWriting(marker);
    const view: PreviewView = { setPreviewState: vi.fn() };
    const controller = new PreviewController({
      writing,
      api: {
        resolveReferences: vi.fn(async (): Promise<ResolveReferencesResult> => ({
          kind: "error",
          code: "reviewer-unavailable",
          message: "offline"
        }))
      },
      view,
      preferences
    });
    controller.setMode("preview");
    await Promise.resolve();
    const latest = vi.mocked(view.setPreviewState).mock.calls.at(-1)?.[0];
    expect(latest?.quoteMap.get(marker)).toMatchObject({ state: "unresolved" });
    expect(writing.getDocumentState()?.currentText).toBe(marker);
  });
});
