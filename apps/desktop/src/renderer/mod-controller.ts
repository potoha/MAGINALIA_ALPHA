import type {
  InvokeModCommandResult,
  ModCapabilityRequestEvent,
  ModCapabilityResponse,
  ModCommandRequest,
  ModSnapshotResult
} from "../mod-ipc";
import type { MarkdownPreloadApi } from "../preload-api";
import type { WritingController } from "./controller";

export interface ModControllerView {
  setModState(state: ModControllerState): void;
}

export interface ModControllerState {
  readonly snapshot: ModSnapshotResult;
  readonly busy: boolean;
  readonly message: string;
}

export interface ModControllerOptions {
  readonly api: Pick<MarkdownPreloadApi, "loadMods" | "reloadMods" | "openModsFolder" | "invokeModCommand"> & {
    readonly onModCapabilityRequest?: MarkdownPreloadApi["onModCapabilityRequest"];
  };
  readonly writing: WritingController;
  readonly view: ModControllerView;
}

const EMPTY_SNAPSHOT: ModSnapshotResult = Object.freeze({ mods: [], contributions: [] });
const MOD_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/u;
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const VIEW_ID = COMMAND_ID;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeModId(value: unknown): value is string {
  return typeof value === "string" && MOD_ID.test(value);
}

function safeCommandId(value: unknown): value is string {
  return typeof value === "string" && COMMAND_ID.test(value);
}

function normalizeViewRequest(value: unknown): {
  readonly documentId?: string;
  readonly viewType: string;
  readonly region: "main" | "secondary";
  readonly groupId: string;
} | null {
  if (!isRecord(value)) return null;
  const allowed = ["documentId", "viewType", "region", "groupId"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return null;
  if (value.documentId !== undefined && (typeof value.documentId !== "string" || value.documentId.length === 0)) return null;
  if (typeof value.viewType !== "string" || !VIEW_ID.test(value.viewType)) return null;
  if (value.region !== "main" && value.region !== "secondary") return null;
  if (typeof value.groupId !== "string" || value.groupId.length === 0 || value.groupId.length > 64) return null;
  return {
    ...(value.documentId === undefined ? {} : { documentId: value.documentId }),
    viewType: value.viewType,
    region: value.region,
    groupId: value.groupId
  };
}

function errorResponse(message: string): ModCapabilityResponse {
  return { kind: "error", message: message.slice(0, 500) };
}

/**
 * Renderer-side consumer of declarative Mod contributions.
 *
 * It owns no Mod code and receives no Electron/Monaco object.  Capability
 * requests are translated into the public WritingController/Session APIs.
 * D.5 intentionally refuses a second placement for a document that already
 * has a central view; the future multi-pane slice can relax this policy in
 * one place without changing the Mod contract.
 */
export class ModController {
  private readonly api: ModControllerOptions["api"];
  private readonly writing: WritingController;
  private readonly view: ModControllerView;
  private readonly removeCapabilityListener: (() => void) | undefined;
  private snapshotValue: ModSnapshotResult = EMPTY_SNAPSHOT;
  private busy = false;
  private message = "Mods not loaded";

  public constructor(options: ModControllerOptions) {
    this.api = options.api;
    this.writing = options.writing;
    this.view = options.view;
    this.removeCapabilityListener = this.api.onModCapabilityRequest?.((request) => this.handleCapability(request));
    this.render();
  }

  public getState(): ModControllerState {
    return { snapshot: this.snapshotValue, busy: this.busy, message: this.message };
  }

  public async load(): Promise<void> {
    if (this.api.loadMods === undefined) {
      this.message = "Mod host unavailable";
      this.render();
      return;
    }
    this.busy = true;
    this.message = "Loading Mods…";
    this.render();
    try {
      this.snapshotValue = await this.api.loadMods();
      this.message = this.describeSnapshot(this.snapshotValue);
    } catch {
      this.message = "Mods could not be loaded.";
    } finally {
      this.busy = false;
      this.render();
    }
  }

  public async reload(): Promise<void> {
    if (this.api.reloadMods === undefined) {
      this.message = "Mod host unavailable";
      this.render();
      return;
    }
    this.busy = true;
    this.message = "Reloading Mods…";
    this.render();
    try {
      this.snapshotValue = await this.api.reloadMods();
      this.message = this.describeSnapshot(this.snapshotValue);
    } catch {
      this.message = "Mods could not be reloaded.";
    } finally {
      this.busy = false;
      this.render();
    }
  }

  public async openFolder(): Promise<void> {
    if (this.api.openModsFolder === undefined) {
      this.message = "Mod host unavailable";
      this.render();
      return;
    }
    try {
      const result = await this.api.openModsFolder();
      this.message = result.kind === "opened" ? "Opened Mods folder" : result.message;
    } catch {
      this.message = "The Mods folder could not be opened.";
    }
    this.render();
  }

  public async invoke(modId: string, commandId: string): Promise<InvokeModCommandResult | null> {
    if (this.api.invokeModCommand === undefined || !safeModId(modId) || !safeCommandId(commandId)) {
      return null;
    }
    const request: ModCommandRequest = { modId, commandId, args: [] };
    try {
      const result = await this.api.invokeModCommand(request);
      if (result.kind === "error") {
        this.message = result.message;
      } else if (isRecord(result.value)
        && result.value.kind === "error"
        && typeof result.value.message === "string"
        && result.value.message.length > 0) {
        // A command handler may return a declarative, user-facing refusal
        // (for example, the D.5 single-placement policy) as its result
        // value. Keep that message visible instead of reporting a false
        // success for the outer IPC call.
        this.message = result.value.message;
      } else {
        this.message = "Mod command completed";
      }
      this.render();
      return result;
    } catch {
      this.message = "The Mod command could not be completed.";
      this.render();
      return null;
    }
  }

  public dispose(): void {
    this.removeCapabilityListener?.();
  }

  public async handleCapability(request: ModCapabilityRequestEvent): Promise<ModCapabilityResponse> {
    if (!isRecord(request) || !safeModId(request.modId)) return errorResponse("The Mod owner is invalid.");
    if (request.kind === "get-active-document") {
      if (request.value !== null) return errorResponse("The active document request was invalid.");
      const active = this.writing.getDocumentState();
      return active === null
        ? errorResponse("Open a Markdown document before using this Mod.")
        : { kind: "ok", value: { documentId: active.documentId, displayName: active.displayName } };
    }
    if (request.kind === "close-view") {
      return errorResponse("Closing Mod views is unavailable in this single-placement slice.");
    }
    const viewRequest = normalizeViewRequest(request.value);
    if (viewRequest === null) return errorResponse("The document view request was invalid.");
    const documentId = viewRequest.documentId ?? this.writing.getDocumentState()?.documentId;
    if (documentId === undefined) return errorResponse("Open a Markdown document before using this Mod.");
    if (this.writing.getSessionStore().getSession(documentId) === null) {
      return errorResponse("The requested Markdown document is unavailable.");
    }
    const existing = this.writing.getDocumentViews().find((view) => view.documentId === documentId);
    if (existing !== undefined) {
      return errorResponse("This Markdown is already open in the central editor. A second pane is deferred.");
    }
    return errorResponse("Secondary Markdown views are deferred in this slice.");
  }

  private describeSnapshot(snapshot: ModSnapshotResult): string {
    const active = snapshot.mods.filter((mod) => mod.state === "active").length;
    const errors = snapshot.mods.filter((mod) => mod.state === "error").length;
    return errors > 0 ? `${active} Mod${active === 1 ? "" : "s"} active, ${errors} error` : `${active} Mod${active === 1 ? "" : "s"} active`;
  }

  private render(): void {
    this.view.setModState(this.getState());
  }
}
