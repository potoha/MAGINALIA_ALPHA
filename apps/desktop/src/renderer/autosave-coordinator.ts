import { isDirty, type DocumentId } from "@maginalia/writing-core";
import type {
  DocumentSession,
  DocumentSessionChange
} from "./document-sessions";

/** The initial P0+1 local persistence debounce. */
export const DEFAULT_AUTOSAVE_DELAY_MS = 1_000;

export type AutosaveStatusKind = "scheduled" | "saving" | "saved" | "error";

export interface AutosaveStatus {
  readonly documentId: DocumentId;
  readonly revision: number;
  readonly kind: AutosaveStatusKind;
  readonly message: string;
}

export type AutosaveFlushResult =
  | { readonly kind: "saved"; readonly documentId: DocumentId; readonly revision: number }
  | { readonly kind: "clean"; readonly documentId: DocumentId; readonly revision: number }
  | { readonly kind: "error"; readonly documentId: DocumentId; readonly revision: number; readonly message: string }
  | { readonly kind: "missing"; readonly documentId: DocumentId };

export interface AutosaveStatusChange {
  readonly documentId: DocumentId;
  readonly status: AutosaveStatus;
}

/**
 * The narrow renderer-side save port used by AutosaveCoordinator.
 *
 * WritingController implements this port.  In particular, saveDocument is
 * the existing serialized save pipeline; the coordinator never receives a
 * filesystem path and never creates a second save queue.
 */
export interface AutosaveWritingPort {
  getDocumentSessions(): readonly DocumentSession[];
  getDocumentState(documentId?: DocumentId): DocumentSession | null;
  onSessionChange(listener: (change: DocumentSessionChange) => void): () => void;
  saveDocument(documentId: DocumentId): Promise<void>;
  waitForSave(documentId: DocumentId): Promise<void>;
  getSaveError(documentId: DocumentId): string | undefined;
}

interface TrackedDocument {
  readonly revision: number;
  readonly currentText: string;
}

type AutosaveTimer = ReturnType<typeof globalThis.setTimeout>;

const SAVING_MESSAGE = "Saving…";
const SAVED_MESSAGE = "Saved";
const SCHEDULED_MESSAGE = "Saving soon…";
const DEFAULT_FAILURE_MESSAGE = "The Markdown file could not be saved. Try again.";

function cloneStatus(status: AutosaveStatus): AutosaveStatus {
  return Object.freeze({ ...status });
}

/**
 * Debounces edits per DocumentSession and delegates every write to the
 * WritingController save pipeline.  It intentionally knows nothing about
 * paths, projects, Electron lifecycle, Git, or external synchronization.
 */
export class AutosaveCoordinator {
  private readonly writing: AutosaveWritingPort;
  private readonly delayMs: number;
  private readonly timers = new Map<DocumentId, AutosaveTimer>();
  private readonly tracked = new Map<DocumentId, TrackedDocument>();
  private readonly statuses = new Map<DocumentId, AutosaveStatus>();
  private readonly inFlight = new Map<DocumentId, Promise<AutosaveFlushResult>>();
  private readonly statusListeners = new Set<(change: AutosaveStatusChange) => void>();
  private readonly removeSessionListener: () => void;
  private initialized = false;
  private disposed = false;

  public constructor(options: {
    readonly writing: AutosaveWritingPort;
    readonly delayMs?: number;
  }) {
    this.writing = options.writing;
    this.delayMs = Number.isFinite(options.delayMs) && (options.delayMs ?? 0) >= 0
      ? Math.floor(options.delayMs ?? DEFAULT_AUTOSAVE_DELAY_MS)
      : DEFAULT_AUTOSAVE_DELAY_MS;
    this.removeSessionListener = this.writing.onSessionChange((change) => this.handleSessionChange(change));
  }

  public getStatus(documentId: DocumentId): AutosaveStatus | null {
    const status = this.statuses.get(documentId);
    return status === undefined ? null : cloneStatus(status);
  }

  public onStatusChange(listener: (change: AutosaveStatusChange) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /**
   * Consume a pending debounce and flush one document immediately.
   * Manual Save and lifecycle callers should use this method so they share
   * the same save pipeline and cannot create a duplicate write queue.
   */
  public flushDocument(documentId: DocumentId): Promise<AutosaveFlushResult> {
    this.cancelTimer(documentId);
    const existing = this.inFlight.get(documentId);
    if (existing !== undefined) return existing;

    const operation = this.performFlush(documentId);
    this.inFlight.set(documentId, operation);
    void operation.then(() => {
      if (this.inFlight.get(documentId) === operation) this.inFlight.delete(documentId);
    }, () => {
      if (this.inFlight.get(documentId) === operation) this.inFlight.delete(documentId);
    });
    return operation;
  }

  /** Alias for callers wiring an explicit Manual Save action. */
  public manualSave(documentId: DocumentId): Promise<AutosaveFlushResult> {
    return this.flushDocument(documentId);
  }

  /** Flush all currently known sessions, including inactive tabs. */
  public flushAll(): Promise<readonly AutosaveFlushResult[]> {
    const documentIds = this.writing.getDocumentSessions().map((session) => session.documentId);
    return Promise.all(documentIds.map((documentId) => this.flushDocument(documentId)));
  }

  /**
   * Wait for the current save operation or consume the pending debounce.
   * Returning the flush result lets lifecycle callers block on an error.
   */
  public waitForSave(documentId: DocumentId): Promise<AutosaveFlushResult> {
    return this.flushDocument(documentId);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const documentId of this.timers.keys()) this.cancelTimer(documentId);
    this.removeSessionListener();
    this.tracked.clear();
    this.statuses.clear();
  }

  private handleSessionChange(change: DocumentSessionChange): void {
    const current = new Map(change.sessions.map((session) => [session.documentId, session]));

    // onSessionChange immediately emits the current store snapshot. Existing
    // dirty sessions are intentionally only seeded here; construction never
    // schedules an autosave for pre-existing edits.
    if (!this.initialized) {
      this.initialized = true;
      for (const session of change.sessions) this.remember(session);
      return;
    }

    for (const [documentId, previous] of this.tracked) {
      if (current.has(documentId)) continue;
      this.cancelTimer(documentId);
      this.tracked.delete(documentId);
      this.statuses.delete(documentId);
    }

    for (const session of change.sessions) {
      const previous = this.tracked.get(session.documentId);
      this.tracked.set(session.documentId, {
        revision: session.revision,
        currentText: session.currentText
      });

      // Opening/restore and activation do not count as edits. Only an
      // observed revision change after initialization can schedule a save.
      if (previous === undefined || previous.revision === session.revision) continue;

      if (isDirty(session)) {
        this.schedule(session);
      } else {
        this.cancelTimer(session.documentId);
        this.setStatus({
          documentId: session.documentId,
          revision: session.revision,
          kind: "saved",
          message: SAVED_MESSAGE
        });
      }
    }
  }

  private remember(session: DocumentSession): void {
    this.tracked.set(session.documentId, {
      revision: session.revision,
      currentText: session.currentText
    });
  }

  private schedule(session: DocumentSession): void {
    if (this.disposed) return;
    this.cancelTimer(session.documentId);
    const revision = session.revision;
    const timer = globalThis.setTimeout(() => {
      if (this.timers.get(session.documentId) !== timer) return;
      this.timers.delete(session.documentId);
      const current = this.writing.getDocumentState(session.documentId);
      if (current === null || current.revision !== revision || !isDirty(current)) return;
      void this.flushDocument(session.documentId);
    }, this.delayMs);
    this.timers.set(session.documentId, timer);
    this.setStatus({
      documentId: session.documentId,
      revision,
      kind: "scheduled",
      message: SCHEDULED_MESSAGE
    });
  }

  private cancelTimer(documentId: DocumentId): void {
    const timer = this.timers.get(documentId);
    if (timer === undefined) return;
    globalThis.clearTimeout(timer);
    this.timers.delete(documentId);
  }

  private async performFlush(documentId: DocumentId): Promise<AutosaveFlushResult> {
    let current = this.writing.getDocumentState(documentId);
    if (current === null) return { kind: "missing", documentId };

    while (true) {
      current = this.writing.getDocumentState(documentId);
      if (current === null) return { kind: "missing", documentId };
      if (!isDirty(current)) {
        this.setStatus({ documentId, revision: current.revision, kind: "saved", message: SAVED_MESSAGE });
        return { kind: "clean", documentId, revision: current.revision };
      }

      const revision = current.revision;
      this.setStatus({ documentId, revision, kind: "saving", message: SAVING_MESSAGE });
      try {
        await this.writing.saveDocument(documentId);
        // A save may have completed while another edit arrived. The
        // controller's queued save remains authoritative; this loop only
        // makes lifecycle/manual flush wait for the latest revision too.
        await this.writing.waitForSave(documentId);
      } catch (error: unknown) {
        const message = error instanceof Error && error.message.length > 0
          ? error.message
          : DEFAULT_FAILURE_MESSAGE;
        this.setStatus({ documentId, revision, kind: "error", message });
        return { kind: "error", documentId, revision, message };
      }

      const after = this.writing.getDocumentState(documentId);
      if (after === null) return { kind: "missing", documentId };
      const errorMessage = this.writing.getSaveError(documentId);
      if (errorMessage !== undefined && after.revision === revision) {
        this.setStatus({ documentId, revision, kind: "error", message: errorMessage });
        return { kind: "error", documentId, revision, message: errorMessage };
      }
      if (!isDirty(after)) {
        this.setStatus({ documentId, revision: after.revision, kind: "saved", message: SAVED_MESSAGE });
        return { kind: "saved", documentId, revision: after.revision };
      }

      // A newer edit is still dirty. Consume its timer and immediately use
      // the existing WritingController queue for the follow-up revision.
      this.cancelTimer(documentId);
    }
  }

  private setStatus(status: AutosaveStatus): void {
    const copy = cloneStatus(status);
    this.statuses.set(status.documentId, copy);
    const change = Object.freeze({ documentId: status.documentId, status: copy });
    for (const listener of this.statusListeners) {
      try { listener(change); } catch { /* observers cannot break persistence */ }
    }
  }
}
