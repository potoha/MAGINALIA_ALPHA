import type { ProjectSyncedDocumentResult } from "./project-service";

export const RESOLVE_SYNCED_BLOCK_DOCUMENT_CHANNEL = "maginalia:resolve-synced-block-document";

export interface ResolveSyncedBlockDocumentRequest {
  readonly projectId: string;
  readonly target: string;
}

export type ResolveSyncedBlockDocumentIpcResult = ProjectSyncedDocumentResult | {
  readonly kind: "error";
  readonly code: "invalid-request" | "resolve-failed";
  readonly message: string;
};

export interface SyncedBlockInvokeEvent { readonly sender: object; }
export interface SyncedBlockHandlers {
  readonly resolveSyncedBlockDocument: (
    event: SyncedBlockInvokeEvent,
    request: unknown,
    ...args: readonly unknown[]
  ) => Promise<ResolveSyncedBlockDocumentIpcResult>;
}

export interface SyncedBlockDependencies {
  readonly resolveSyncedBlockDocument: (
    owner: object,
    projectId: string,
    target: string,
  ) => Promise<ProjectSyncedDocumentResult>;
}

const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isRequest(value: unknown): value is ResolveSyncedBlockDocumentRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(request);
  return keys.length === 2 && keys.includes("projectId") && keys.includes("target")
    && typeof request.projectId === "string" && OPAQUE_ID.test(request.projectId)
    && typeof request.target === "string" && request.target.length <= 1_024;
}

/** Main-process-only bridge; renderer gets source text and opaque identity, never a path. */
export function createSyncedBlockHandlers(dependencies: SyncedBlockDependencies): SyncedBlockHandlers {
  return {
    async resolveSyncedBlockDocument(event, request, ...args) {
      if (args.length !== 0 || !isRequest(request)) {
        return { kind: "error", code: "invalid-request", message: "The Synced Block request is invalid." };
      }
      try {
        return await dependencies.resolveSyncedBlockDocument(event.sender, request.projectId, request.target);
      } catch {
        return { kind: "error", code: "resolve-failed", message: "The Synced Block document could not be resolved." };
      }
    }
  };
}
