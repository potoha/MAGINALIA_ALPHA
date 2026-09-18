export type ViewRegion = "primary-sidebar" | "secondary-sidebar";

export interface WorkbenchView {
  id: string;
  title: string;
  defaultRegion: ViewRegion;
}

export interface LayoutState {
  activityBarVisible: boolean;
  primarySidebarVisible: boolean;
  primarySidebarWidth: number;
  secondarySidebarVisible: boolean;
  secondarySidebarWidth: number;
  activePrimaryView: string;
  activeSecondaryView: string;
}

export interface LayoutStore {
  load(): unknown;
  save(state: LayoutState): void;
}

export const WORKBENCH_LAYOUT_STORAGE_KEY = "maginalia.workbench.layout.v1";

/**
 * A best-effort browser backed store. Layout is a convenience preference, so
 * a blocked or unavailable storage implementation must not prevent the
 * editor from starting.
 */
export function createLocalStorageLayoutStore(
  storageKey = WORKBENCH_LAYOUT_STORAGE_KEY
): LayoutStore {
  return {
    load(): unknown {
      try {
        if (typeof globalThis.localStorage === "undefined") return null;
        const raw = globalThis.localStorage.getItem(storageKey);
        return raw === null ? null : JSON.parse(raw) as unknown;
      } catch {
        return null;
      }
    },
    save(state: LayoutState): void {
      try {
        if (typeof globalThis.localStorage === "undefined") return;
        globalThis.localStorage.setItem(storageKey, JSON.stringify(state));
      } catch {
        // Persistence is intentionally non-blocking for a desktop shell.
      }
    }
  };
}

export const DEFAULT_LAYOUT: LayoutState = {
  activityBarVisible: true,
  primarySidebarVisible: true,
  primarySidebarWidth: 300,
  secondarySidebarVisible: true,
  secondarySidebarWidth: 300,
  activePrimaryView: "",
  activeSecondaryView: ""
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validWidth(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(180, Math.min(800, Math.round(value)))
    : fallback;
}

export function restoreLayout(value: unknown): LayoutState {
  if (!isRecord(value)) return { ...DEFAULT_LAYOUT };
  return {
    activityBarVisible: typeof value.activityBarVisible === "boolean" ? value.activityBarVisible : true,
    primarySidebarVisible: typeof value.primarySidebarVisible === "boolean" ? value.primarySidebarVisible : true,
    primarySidebarWidth: validWidth(value.primarySidebarWidth, DEFAULT_LAYOUT.primarySidebarWidth),
    secondarySidebarVisible: typeof value.secondarySidebarVisible === "boolean" ? value.secondarySidebarVisible : true,
    secondarySidebarWidth: validWidth(value.secondarySidebarWidth, DEFAULT_LAYOUT.secondarySidebarWidth),
    activePrimaryView: typeof value.activePrimaryView === "string" ? value.activePrimaryView : DEFAULT_LAYOUT.activePrimaryView,
    activeSecondaryView: typeof value.activeSecondaryView === "string" ? value.activeSecondaryView : DEFAULT_LAYOUT.activeSecondaryView
  };
}

export type WorkbenchCommand =
  | "maginalia.view.togglePrimarySidebar"
  | "maginalia.view.toggleSecondarySidebar"
  | "maginalia.view.toggleActivityBar"
  | "maginalia.view.toggleEditorOnly";

export class WorkbenchCore {
  private state: LayoutState;
  private readonly views = new Map<string, WorkbenchView>();
  private readonly listeners = new Set<(state: LayoutState) => void>();
  private beforeEditorOnly: Pick<LayoutState, "activityBarVisible" | "primarySidebarVisible" | "secondarySidebarVisible"> | null = null;

  public constructor(private readonly store: LayoutStore) {
    try {
      this.state = restoreLayout(store.load());
    } catch {
      this.state = { ...DEFAULT_LAYOUT };
    }
  }

  public registerView(view: WorkbenchView): void {
    if (this.views.has(view.id)) throw new Error(`View already registered: ${view.id}`);
    this.views.set(view.id, view);
    this.notify();
  }

  public getViews(region: ViewRegion): WorkbenchView[] {
    return [...this.views.values()].filter((view) => view.defaultRegion === region);
  }

  public getState(): LayoutState {
    this.validateActiveViews();
    return this.snapshotState();
  }

  public onDidChange(listener: (state: LayoutState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  public execute(command: WorkbenchCommand): void {
    switch (command) {
      case "maginalia.view.togglePrimarySidebar":
        this.update({ primarySidebarVisible: !this.state.primarySidebarVisible });
        break;
      case "maginalia.view.toggleSecondarySidebar":
        this.update({ secondarySidebarVisible: !this.state.secondarySidebarVisible });
        break;
      case "maginalia.view.toggleActivityBar":
        this.update({ activityBarVisible: !this.state.activityBarVisible });
        break;
      case "maginalia.view.toggleEditorOnly":
        if (this.isEditorOnly()) {
          // Independently hiding every region has no editor-only snapshot;
          // Escape/toggle returns a usable shell in that case.
          this.update(this.beforeEditorOnly ?? {
            activityBarVisible: true,
            primarySidebarVisible: true,
            secondarySidebarVisible: true
          });
          this.beforeEditorOnly = null;
        } else {
          this.beforeEditorOnly = {
            activityBarVisible: this.state.activityBarVisible,
            primarySidebarVisible: this.state.primarySidebarVisible,
            secondarySidebarVisible: this.state.secondarySidebarVisible
          };
          this.update({ activityBarVisible: false, primarySidebarVisible: false, secondarySidebarVisible: false });
        }
        break;
    }
  }

  public showView(id: string): void {
    const view = this.views.get(id);
    if (!view) throw new Error(`Unknown view: ${id}`);
    if (view.defaultRegion === "primary-sidebar") {
      this.update({ activePrimaryView: id, primarySidebarVisible: true });
    } else {
      this.update({ activeSecondaryView: id, secondarySidebarVisible: true });
    }
  }

  public resize(region: ViewRegion, width: number): void {
    const fallback = region === "primary-sidebar" ? this.state.primarySidebarWidth : this.state.secondarySidebarWidth;
    const normalized = validWidth(width, fallback);
    this.update(region === "primary-sidebar"
      ? { primarySidebarWidth: normalized }
      : { secondarySidebarWidth: normalized });
  }

  public isEditorOnly(): boolean {
    return !this.state.activityBarVisible && !this.state.primarySidebarVisible && !this.state.secondarySidebarVisible;
  }

  private update(change: Partial<LayoutState>): void {
    this.state = { ...this.state, ...change };
    try {
      this.store.save(this.getState());
    } catch {
      // A persistence failure must not break view commands or the editor.
    }
    this.notify();
  }

  private notify(): void {
    const state = this.snapshotState();
    for (const listener of this.listeners) listener(state);
  }

  private snapshotState(): LayoutState {
    return { ...this.state };
  }

  /** Keep persisted view selections usable after a view is removed or renamed. */
  private validateActiveViews(): void {
    const primaryViews = this.getViews("primary-sidebar");
    const secondaryViews = this.getViews("secondary-sidebar");
    const primaryValid = primaryViews.some((view) => view.id === this.state.activePrimaryView);
    const secondaryValid = secondaryViews.some((view) => view.id === this.state.activeSecondaryView);
    const fallback: Partial<LayoutState> = {};
    if (!primaryValid && primaryViews[0]) fallback.activePrimaryView = primaryViews[0].id;
    if (!secondaryValid && secondaryViews[0]) fallback.activeSecondaryView = secondaryViews[0].id;
    if (Object.keys(fallback).length === 0) return;

    this.state = { ...this.state, ...fallback };
    try {
      this.store.save(this.snapshotState());
    } catch {
      // A persistence failure must not block startup with a valid view.
    }
  }
}
