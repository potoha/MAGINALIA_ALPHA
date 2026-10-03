import type { DocumentId, DocumentState } from "@maginalia/writing-core";

/** A document's durable authoring state. Views never own a text copy. */
export interface DocumentSession extends DocumentState {
  /** Monotonic revision used to invalidate captured editor targets. */
  readonly revision: number;
}

export type DocumentViewRegion = "main" | "secondary";

/** Placement is intentionally independent from the document session. */
export interface DocumentViewInstance {
  readonly instanceId: string;
  readonly documentId: DocumentId;
  readonly viewType: string;
  readonly region: DocumentViewRegion;
  readonly groupId: string;
}

export interface DocumentSessionSnapshot {
  readonly sessions: readonly DocumentSession[];
  readonly views: readonly DocumentViewInstance[];
  readonly activeDocumentId: DocumentId | null;
  readonly activeViewId: string | null;
}

export type DocumentSessionChange = DocumentSessionSnapshot;

const MAIN_REGION: DocumentViewRegion = "main";
const MAIN_GROUP = "editor-group-1";

function copySession(session: DocumentSession): DocumentSession {
  return { ...session };
}

function copyView(view: DocumentViewInstance): DocumentViewInstance {
  return { ...view };
}

function cloneSnapshot(
  sessions: Map<DocumentId, DocumentSession>,
  views: Map<string, DocumentViewInstance>,
  activeDocumentId: DocumentId | null,
  activeViewId: string | null,
): DocumentSessionSnapshot {
  return {
    sessions: [...sessions.values()].map(copySession),
    views: [...views.values()].map(copyView),
    activeDocumentId,
    activeViewId
  };
}

/**
 * Renderer-local source of truth for open Markdown sessions and placements.
 * It deliberately has no filesystem path or Electron/Monaco dependency.
 */
export class DocumentSessionStore {
  private readonly sessions = new Map<DocumentId, DocumentSession>();
  private readonly views = new Map<string, DocumentViewInstance>();
  private readonly listeners = new Set<(change: DocumentSessionChange) => void>();
  private nextViewId = 1;
  private activeDocumentId: DocumentId | null = null;
  private activeViewId: string | null = null;

  public onDidChange(listener: (change: DocumentSessionChange) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  public snapshot(): DocumentSessionSnapshot {
    return cloneSnapshot(this.sessions, this.views, this.activeDocumentId, this.activeViewId);
  }

  public getSession(documentId: DocumentId): DocumentSession | null {
    const session = this.sessions.get(documentId);
    return session === undefined ? null : copySession(session);
  }

  public getActiveSession(): DocumentSession | null {
    return this.activeDocumentId === null ? null : this.getSession(this.activeDocumentId);
  }

  public getView(instanceId: string): DocumentViewInstance | null {
    const view = this.views.get(instanceId);
    return view === undefined ? null : copyView(view);
  }

  public getViewsForDocument(documentId: DocumentId): readonly DocumentViewInstance[] {
    return [...this.views.values()]
      .filter((view) => view.documentId === documentId)
      .map(copyView);
  }

  public getMainView(documentId: DocumentId): DocumentViewInstance | null {
    const view = [...this.views.values()]
      .find((candidate) => candidate.documentId === documentId && candidate.region === MAIN_REGION);
    return view === undefined ? null : copyView(view);
  }

  /** Register a host-opened document, preserving an existing dirty session. */
  public openSession(document: { documentId: DocumentId; displayName: string; text: string }): DocumentSession {
    const existing = this.sessions.get(document.documentId);
    if (existing !== undefined) {
      if (existing.displayName !== document.displayName) {
        const renamed = { ...existing, displayName: document.displayName };
        this.sessions.set(document.documentId, renamed);
        this.notify();
        return copySession(renamed);
      }
      return copySession(existing);
    }

    const session: DocumentSession = {
      documentId: document.documentId,
      displayName: document.displayName,
      currentText: document.text,
      savedText: document.text,
      // Opening a session invalidates any prior editor target, matching the
      // pre-tabs WritingController revision contract.
      revision: 1
    };
    this.sessions.set(document.documentId, session);
    this.notify();
    return copySession(session);
  }

  public updateText(documentId: DocumentId, text: string): DocumentSession | null {
    const current = this.sessions.get(documentId);
    if (current === undefined) return null;
    if (current.currentText === text) return copySession(current);
    const next = { ...current, currentText: text, revision: current.revision + 1 };
    this.sessions.set(documentId, next);
    this.notify();
    return copySession(next);
  }

  public confirmSave(documentId: DocumentId, text: string): DocumentSession | null {
    const current = this.sessions.get(documentId);
    if (current === undefined) return null;
    if (current.savedText === text) return copySession(current);
    const next = { ...current, savedText: text };
    this.sessions.set(documentId, next);
    this.notify();
    return copySession(next);
  }

  public discardChanges(documentId: DocumentId): DocumentSession | null {
    const current = this.sessions.get(documentId);
    if (current === undefined || current.currentText === current.savedText) return current ? copySession(current) : null;
    const next = { ...current, currentText: current.savedText, revision: current.revision + 1 };
    this.sessions.set(documentId, next);
    this.notify();
    return copySession(next);
  }

  public openView(
    documentId: DocumentId,
    options: Partial<Pick<DocumentViewInstance, "viewType" | "region" | "groupId">> = {}
  ): DocumentViewInstance | null {
    if (!this.sessions.has(documentId)) return null;
    const region = options.region ?? MAIN_REGION;
    const groupId = options.groupId ?? (region === MAIN_REGION ? MAIN_GROUP : "sidebar-group-1");
    const viewType = options.viewType ?? "markdown";
    const existing = [...this.views.values()].find((view) =>
      view.documentId === documentId
      && view.viewType === viewType
      && view.region === region
      && view.groupId === groupId);
    if (existing !== undefined) {
      this.activateView(existing.instanceId);
      return copyView(existing);
    }

    // D.5 temporarily keeps one placement per Markdown document.  A Mod may
    // ask to open a secondary view, but it must not create a second editor
    // with an independent or implicitly shared editing surface.  Returning
    // null lets the semantic Mod capability report a harmless refusal while
    // leaving the existing central tab untouched.
    const alreadyPlaced = [...this.views.values()].find((view) => view.documentId === documentId);
    if (alreadyPlaced !== undefined) return null;

    const view: DocumentViewInstance = {
      instanceId: `document-view-${this.nextViewId++}`,
      documentId,
      viewType,
      region,
      groupId
    };
    this.views.set(view.instanceId, view);
    this.activeDocumentId = documentId;
    this.activeViewId = view.instanceId;
    this.notify();
    return copyView(view);
  }

  public activateDocument(documentId: DocumentId, region: DocumentViewRegion = MAIN_REGION): DocumentViewInstance | null {
    const existing = [...this.views.values()].find((view) => view.documentId === documentId && view.region === region);
    if (existing === undefined) return this.openView(documentId, { region });
    this.activateView(existing.instanceId);
    return copyView(existing);
  }

  public activateView(instanceId: string): boolean {
    const view = this.views.get(instanceId);
    if (view === undefined) return false;
    this.activeViewId = instanceId;
    this.activeDocumentId = view.documentId;
    this.notify();
    return true;
  }

  /** Move one main-editor view before another without changing document state. */
  public moveMainViewBefore(instanceId: string, beforeInstanceId: string): boolean {
    if (instanceId === beforeInstanceId) return false;
    const view = this.views.get(instanceId);
    const before = this.views.get(beforeInstanceId);
    if (view === undefined || before === undefined
      || view.region !== MAIN_REGION || before.region !== MAIN_REGION
      || view.groupId !== MAIN_GROUP || before.groupId !== MAIN_GROUP) return false;

    const ordered = [...this.views.entries()];
    const sourceIndex = ordered.findIndex(([id]) => id === instanceId);
    const targetIndex = ordered.findIndex(([id]) => id === beforeInstanceId);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex - 1) return false;
    const [moved] = ordered.splice(sourceIndex, 1);
    const nextTargetIndex = ordered.findIndex(([id]) => id === beforeInstanceId);
    ordered.splice(nextTargetIndex, 0, moved);
    this.views.clear();
    for (const [id, candidate] of ordered) this.views.set(id, candidate);
    this.notify();
    return true;
  }

  public closeView(instanceId: string): DocumentViewInstance | null {
    const view = this.views.get(instanceId);
    if (view === undefined) return null;
    this.views.delete(instanceId);
    if (this.activeViewId === instanceId) {
      const remainingMain = [...this.views.values()].filter((candidate) => candidate.region === MAIN_REGION);
      const next = remainingMain.at(-1) ?? [...this.views.values()].at(-1);
      this.activeViewId = next?.instanceId ?? null;
      this.activeDocumentId = next?.documentId ?? null;
    }
    this.notify();
    return copyView(view);
  }

  public removeSession(documentId: DocumentId): boolean {
    if ([...this.views.values()].some((view) => view.documentId === documentId)) return false;
    const removed = this.sessions.delete(documentId);
    if (removed) {
      if (this.activeDocumentId === documentId) this.activeDocumentId = null;
      this.notify();
    }
    return removed;
  }

  private notify(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // A UI listener must not interrupt the document state transition.
      }
    }
  }
}

export const DOCUMENT_MAIN_REGION = MAIN_REGION;
export const DOCUMENT_MAIN_GROUP = MAIN_GROUP;
