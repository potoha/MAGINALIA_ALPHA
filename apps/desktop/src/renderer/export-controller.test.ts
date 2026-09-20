import { openDocument, serializeQuoteRef, type DocumentState } from "@maginalia/writing-core";
import { describe, expect, it, vi } from "vitest";
import type {
  ResolveExportRequest,
  ResolveExportResult,
  WriteExportRequest,
  WriteExportResult
} from "../export-ipc";
import type { ReviewerResolutionResult } from "../reviewer-resolution";
import {
  ExportController,
  type ExportControllerApi,
  type ExportControllerView,
  type ExportViewState,
  type ExportWritingPort
} from "./export-controller";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function resolution(): ReviewerResolutionResult {
  return { kind: "resolved", sources: [], resolved: [], unresolved: [] };
}

function success(exportId = "export-1"): ResolveExportResult {
  return {
    kind: "resolved",
    exportId,
    documentId: "a",
    revision: 1,
    resolution: resolution()
  };
}

function exported(): WriteExportResult {
  return { kind: "exported", fileName: "draft.resolved.md" };
}

class FakeWriting implements ExportWritingPort {
  private document: (DocumentState & { readonly revision: number }) | null;
  private readonly listeners = new Set<(document: DocumentState | null) => void>();

  public constructor(document: { documentId: string; text: string } | null) {
    this.document = document === null
      ? null
      : { ...openDocument({ documentId: document.documentId, displayName: `${document.documentId}.md`, text: document.text }), revision: 1 };
  }

  public getDocumentState(): (DocumentState & { readonly revision: number }) | null {
    return this.document === null ? null : { ...this.document };
  }

  public onDocumentChange(listener: (document: DocumentState | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public setDocument(document: { documentId: string; text: string } | null): void {
    this.document = document === null
      ? null
      : {
        ...openDocument({ documentId: document.documentId, displayName: `${document.documentId}.md`, text: document.text }),
        revision: 1
      };
    for (const listener of this.listeners) listener(this.document);
  }
}

function createHarness(options: {
  writing?: FakeWriting;
  resolve?: (request: ResolveExportRequest) => Promise<ResolveExportResult>;
  write?: (request: WriteExportRequest) => Promise<WriteExportResult>;
} = {}) {
  const writing = options.writing ?? new FakeWriting({ documentId: "a", text: "# A\n" });
  const states: ExportViewState[] = [];
  const view: ExportControllerView = { setExportState: (state) => states.push(state) };
  const api: ExportControllerApi = {
    resolveExport: options.resolve === undefined ? vi.fn(async () => success()) : vi.fn(options.resolve),
    writeExport: options.write === undefined ? vi.fn(async () => exported()) : vi.fn(options.write)
  };
  const controller = new ExportController({ api, writing, view });
  return { controller, api, writing, states };
}

describe("ExportController", () => {
  it("starts disabled and does not call the host without a document", async () => {
    const { controller, api, states } = createHarness({ writing: new FakeWriting(null) });
    await controller.exportMarkdown();

    expect(states[0]).toMatchObject({ status: "empty", enabled: false });
    expect(api.resolveExport).not.toHaveBeenCalled();
  });

  it("captures the active session before resolution and writes that same snapshot after a tab switch", async () => {
    const writing = new FakeWriting({ documentId: "a", text: "# A dirty\n" });
    const pending = deferred<ResolveExportResult>();
    const resolve = vi.fn(async (request: ResolveExportRequest) => {
      expect(request).toMatchObject({ documentId: "a", currentText: "# A dirty\n", revision: 1 });
      return pending.promise;
    });
    const write = vi.fn(async (request: WriteExportRequest) => {
      expect(request).toMatchObject({ documentId: "a", revision: 1, text: "# A dirty\n" });
      return exported();
    });
    const { controller, states } = createHarness({ writing, resolve, write });

    const operation = controller.exportMarkdown();
    writing.setDocument({ documentId: "b", text: "# B\n" });
    pending.resolve(success());
    await operation;

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toMatchObject({ status: "success", enabled: true });
    expect(writing.getDocumentState()?.documentId).toBe("b");
  });

  it("surfaces dialog cancellation without changing the document", async () => {
    const writing = new FakeWriting({ documentId: "a", text: "# A\n" });
    const write = vi.fn(async () => ({ kind: "cancelled" as const }));
    const { controller, states } = createHarness({ writing, write });

    await controller.exportMarkdown();

    expect(write).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toMatchObject({ status: "cancelled", message: "Export canceled." });
    expect(writing.getDocumentState()?.currentText).toBe("# A\n");
  });

  it("blocks unresolved output before asking the host to write", async () => {
    const marker = serializeQuoteRef({ quoteId: "quote-1", mode: "normal" });
    const writing = new FakeWriting({ documentId: "a", text: `${marker}\n` });
    const write = vi.fn(async () => exported());
    const unresolved: ReviewerResolutionResult = {
      kind: "resolved",
      sources: [],
      resolved: [],
      unresolved: [{
        occurrence: { offset: 0, marker, quoteRef: { quoteId: "quote-1", mode: "normal" } },
        quoteRef: { quoteId: "quote-1", mode: "normal" },
        code: "quote-not-found"
      }]
    };
    const { controller, states } = createHarness({
      writing,
      resolve: async () => ({ ...success(), resolution: unresolved }),
      write
    });

    await controller.exportMarkdown();

    expect(write).not.toHaveBeenCalled();
    expect(states.at(-1)).toMatchObject({ status: "error" });
    expect(states.at(-1)?.message).toContain("could not be resolved");
    expect(writing.getDocumentState()?.currentText).toBe(`${marker}\n`);
  });

  it("surfaces resolution and write errors without mutating editor state", async () => {
    const writing = new FakeWriting({ documentId: "a", text: "# A\n" });
    const resolveError = createHarness({
      writing,
      resolve: async () => ({ kind: "error", code: "resolution-failed", message: "Reviewer unavailable." })
    });
    await resolveError.controller.exportMarkdown();
    expect(resolveError.states.at(-1)).toMatchObject({ status: "error", message: "Reviewer unavailable." });

    const writeError = createHarness({
      writing,
      write: async () => ({ kind: "error", code: "write-failed", message: "Destination failed." })
    });
    await writeError.controller.exportMarkdown();
    expect(writeError.states.at(-1)).toMatchObject({ status: "error", message: "Destination failed." });
    expect(writing.getDocumentState()?.currentText).toBe("# A\n");
  });
});
