import { describe, expect, it, vi } from "vitest";
import { AutosaveCoordinator, type AutosaveWritingPort } from "./autosave-coordinator";
import { DocumentSessionStore, type DocumentSession, type DocumentSessionChange } from "./document-sessions";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

interface SaveCall {
  readonly documentId: string;
  readonly text: string;
  readonly deferred: ReturnType<typeof deferred<void>>;
}

class FakeWriting implements AutosaveWritingPort {
  public readonly store = new DocumentSessionStore();
  public readonly saves: SaveCall[] = [];
  public failNext: string | null = null;
  private readonly saveErrors = new Map<string, string>();

  public open(documentId: string, text: string): void {
    this.store.openSession({ documentId, displayName: `${documentId}.md`, text });
  }

  public edit(documentId: string, text: string): void {
    this.store.updateText(documentId, text);
  }

  public getDocumentSessions(): readonly DocumentSession[] {
    return this.store.snapshot().sessions;
  }

  public getDocumentState(documentId?: string): DocumentSession | null {
    return documentId === undefined ? this.store.getActiveSession() : this.store.getSession(documentId);
  }

  public onSessionChange(listener: (change: DocumentSessionChange) => void): () => void {
    return this.store.onDidChange(listener);
  }

  public saveDocument(documentId: string): Promise<void> {
    const session = this.store.getSession(documentId);
    if (session === null) return Promise.reject(new Error("missing"));
    const operation = deferred<void>();
    this.saves.push({ documentId, text: session.currentText, deferred: operation });
    if (this.failNext !== null) {
      const message = this.failNext;
      this.failNext = null;
      this.saveErrors.set(documentId, message);
      operation.reject(new Error(message));
    }
    return operation.promise.then(() => {
      const latest = this.store.getSession(documentId);
      if (latest !== null && latest.currentText === session.currentText) {
        this.store.confirmSave(documentId, session.currentText);
      }
    });
  }

  public waitForSave(_documentId: string): Promise<void> {
    return Promise.resolve();
  }

  public getSaveError(documentId: string): string | undefined {
    return this.saveErrors.get(documentId);
  }

  public complete(index: number): void {
    this.saves[index]?.deferred.resolve(undefined);
  }
}

describe("AutosaveCoordinator", () => {
  it("does not schedule dirty sessions that existed before initialization", async () => {
    vi.useFakeTimers();
    try {
      const writing = new FakeWriting();
      writing.open("a", "base");
      writing.edit("a", "already dirty");
      const coordinator = new AutosaveCoordinator({ writing });

      await vi.advanceTimersByTimeAsync(2_000);

      expect(writing.saves).toHaveLength(0);
      coordinator.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("debounces rapid edits independently for A and B", async () => {
    vi.useFakeTimers();
    try {
      const writing = new FakeWriting();
      writing.open("a", "A");
      writing.open("b", "B");
      const coordinator = new AutosaveCoordinator({ writing });

      writing.edit("a", "A1");
      writing.edit("b", "B1");
      await vi.advanceTimersByTimeAsync(500);
      writing.edit("a", "A2");
      await vi.advanceTimersByTimeAsync(499);
      expect(writing.saves).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(501);
      expect(writing.saves.map((save) => [save.documentId, save.text])).toEqual([
        ["b", "B1"],
        ["a", "A2"]
      ]);
      writing.complete(0);
      writing.complete(1);
      await vi.runAllTimersAsync();
      coordinator.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for a stale save and follows it with the newer revision", async () => {
    vi.useFakeTimers();
    try {
      const writing = new FakeWriting();
      writing.open("a", "base");
      const coordinator = new AutosaveCoordinator({ writing });

      writing.edit("a", "rev1");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(writing.saves.map((save) => save.text)).toEqual(["rev1"]);

      writing.edit("a", "rev2");
      const flush = coordinator.flushDocument("a");
      writing.complete(0);
      await vi.runAllTimersAsync();
      expect(writing.saves.map((save) => save.text)).toEqual(["rev1", "rev2"]);

      writing.complete(1);
      await expect(flush).resolves.toMatchObject({ kind: "saved", documentId: "a" });
      expect(writing.getDocumentState("a")).toMatchObject({ currentText: "rev2", savedText: "rev2" });
      coordinator.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("manual flush consumes the pending debounce without a duplicate write", async () => {
    vi.useFakeTimers();
    try {
      const writing = new FakeWriting();
      writing.open("a", "base");
      const coordinator = new AutosaveCoordinator({ writing });

      writing.edit("a", "manual");
      const flush = coordinator.manualSave("a");
      expect(writing.saves).toHaveLength(1);
      writing.complete(0);
      await expect(flush).resolves.toMatchObject({ kind: "saved" });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(writing.saves).toHaveLength(1);
      coordinator.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a failed save and keeps the session dirty", async () => {
    const writing = new FakeWriting();
    writing.open("a", "base");
    const coordinator = new AutosaveCoordinator({ writing });
    const statuses: string[] = [];
    coordinator.onStatusChange(({ status }) => statuses.push(status.kind));
    writing.failNext = "The file changed outside MAGINALIA.";
    writing.edit("a", "dirty");

    const result = await coordinator.flushDocument("a");

    expect(result).toMatchObject({ kind: "error", documentId: "a", message: "The file changed outside MAGINALIA." });
    expect(writing.getDocumentState("a")).toMatchObject({ currentText: "dirty", savedText: "base" });
    expect(coordinator.getStatus("a")).toMatchObject({ kind: "error" });
    expect(statuses).toEqual(["scheduled", "saving", "error"]);
    coordinator.dispose();
  });

  it("cancels a document timer when that session is removed", async () => {
    vi.useFakeTimers();
    try {
      const writing = new FakeWriting();
      writing.open("a", "base");
      const coordinator = new AutosaveCoordinator({ writing });
      writing.edit("a", "dirty");
      writing.store.closeView("missing");
      // A session cannot be removed while it has a view; remove the test
      // session directly through the store after the scheduled edit.
      writing.store.removeSession("a");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(writing.saves).toHaveLength(0);
      expect(coordinator.getStatus("a")).toBeNull();
      coordinator.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
