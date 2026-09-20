export const LOAD_WORKSPACE_STATE_CHANNEL = "maginalia:load-workspace-state";
export const SAVE_WORKSPACE_STATE_CHANNEL = "maginalia:save-workspace-state";

export interface WorkspaceViewPlacement {
  readonly documentId: string;
  readonly viewType: string;
  readonly region: "main" | "secondary";
  readonly groupId: string;
}

/** Renderer-safe workspace state. It contains project-relative opaque IDs only. */
export interface WorkspaceState {
  readonly version: 1;
  readonly projectId: string | null;
  readonly openFileIds: readonly string[];
  readonly activeFileId: string | null;
  readonly viewPlacements: readonly WorkspaceViewPlacement[];
}

export interface WorkspaceStateFailure {
  readonly kind: "error";
  readonly code: "invalid-request" | "load-failed" | "save-failed";
  readonly message: string;
}

export type LoadWorkspaceStateResult = WorkspaceState | WorkspaceStateFailure;
export type SaveWorkspaceStateResult = { readonly kind: "saved" } | WorkspaceStateFailure;

export interface WorkspaceStateInvokeEvent { readonly sender: object; }

export interface WorkspaceStateHandlerDependencies {
  readonly load: () => Promise<WorkspaceState>;
  readonly save: (state: WorkspaceState) => Promise<void>;
}

export interface WorkspaceStateHandlers {
  readonly loadWorkspaceState: (
    event: WorkspaceStateInvokeEvent,
    ...args: readonly unknown[]
  ) => Promise<LoadWorkspaceStateResult>;
  readonly saveWorkspaceState: (
    event: WorkspaceStateInvokeEvent,
    value: unknown,
    ...args: readonly unknown[]
  ) => Promise<SaveWorkspaceStateResult>;
}

const INVALID_REQUEST: WorkspaceStateFailure = {
  kind: "error",
  code: "invalid-request",
  message: "The workspace state request was invalid."
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && /^[A-Za-z0-9._:-]+$/u.test(value);
}

function isPlacement(value: unknown): value is WorkspaceViewPlacement {
  if (!isRecord(value)
    || Object.keys(value).length !== 4
    || !isOpaqueId(value.documentId)
    || !isOpaqueId(value.viewType)
    || !isOpaqueId(value.groupId)
    || (value.region !== "main" && value.region !== "secondary")) return false;
  return true;
}

export function isWorkspaceState(value: unknown): value is WorkspaceState {
  if (!isRecord(value)
    || Object.keys(value).length !== 5
    || value.version !== 1
    || (value.projectId !== null && !isOpaqueId(value.projectId))
    || (value.activeFileId !== null && !isOpaqueId(value.activeFileId))
    || !Array.isArray(value.openFileIds)
    || value.openFileIds.length > 200
    || !value.openFileIds.every(isOpaqueId)
    || !Array.isArray(value.viewPlacements)
    || value.viewPlacements.length > 200
    || !value.viewPlacements.every(isPlacement)) return false;
  return new Set(value.openFileIds).size === value.openFileIds.length;
}

export const EMPTY_WORKSPACE_STATE: WorkspaceState = {
  version: 1,
  projectId: null,
  openFileIds: [],
  activeFileId: null,
  viewPlacements: []
};

export function createWorkspaceStateHandlers(
  dependencies: WorkspaceStateHandlerDependencies
): WorkspaceStateHandlers {
  return {
    loadWorkspaceState: async (_event, ...args) => {
      if (args.length !== 0) return INVALID_REQUEST;
      try {
        const state = await dependencies.load();
        return isWorkspaceState(state) ? state : EMPTY_WORKSPACE_STATE;
      } catch {
        return { kind: "error", code: "load-failed", message: "The saved workspace state could not be read." };
      }
    },
    saveWorkspaceState: async (_event, value, ...args) => {
      if (args.length !== 0 || !isWorkspaceState(value)) return INVALID_REQUEST;
      try {
        await dependencies.save(value);
        return { kind: "saved" };
      } catch {
        return { kind: "error", code: "save-failed", message: "The workspace state could not be saved." };
      }
    }
  };
}
