import type { DocumentWorkspaceResult } from "./document-workspace.js";
import type {
  LocalRepositoryFailure,
  LocalHistoryListResult,
  LocalHistorySnapshotResult,
  LocalRepositoryOpened,
  LocalRepositoryResolveResult,
  LocalRepositoryResult,
} from "./repository-service.js";
import type { LibraryOpenResult } from "./library-service.js";
import type { RepositoryKind } from "@maginalia/repository-core" with { "resolution-mode": "import" };

export const CREATE_REPOSITORY_CHANNEL = "maginalia:create-repository";
export const OPEN_REPOSITORY_CHANNEL = "maginalia:open-repository";
export const OPEN_REPOSITORY_DOCUMENT_CHANNEL = "maginalia:open-repository-document";
export const USE_REPOSITORY_SHELF_CHANNEL = "maginalia:use-repository-shelf";
export const CREATE_REPOSITORY_HISTORY_CHANNEL = "maginalia:create-repository-history";
export const LIST_REPOSITORY_HISTORY_CHANNEL = "maginalia:list-repository-history";
export const OPEN_REPOSITORY_HISTORY_CHANNEL = "maginalia:open-repository-history";

export interface CreateRepositoryRequest {
  readonly kind: RepositoryKind;
  readonly title: string;
}

export interface RepositoryHandoffRequest {
  readonly repositoryId: string;
}

export interface RepositoryHistoryRequest {
  readonly repositoryId: string;
}

export interface RepositoryHistoryCopyRequest {
  readonly repositoryId: string;
  readonly historyId: string;
}

export interface RepositoryFolderSelection {
  readonly canceled: boolean;
  readonly filePaths: readonly string[];
}

export interface RepositoryCancelled {
  readonly kind: "cancelled";
}

export type RepositoryIpcFailureCode =
  | "invalid-request"
  | "parent-folder-dialog-failed"
  | "repository-folder-dialog-failed"
  | "repository-create-failed"
  | "repository-open-failed"
  | "repository-handoff-failed"
  | "repository-history-failed"
  | "history-destination-folder-dialog-failed"
  | "repository-history-copy-failed"
  | "wrong-repository-kind";

export interface RepositoryIpcFailure {
  readonly kind: "error";
  readonly code: RepositoryIpcFailureCode;
  readonly message: string;
}

export type CreateRepositoryResult = LocalRepositoryOpened | LocalRepositoryFailure | RepositoryCancelled | RepositoryIpcFailure;
export type OpenRepositoryResult = LocalRepositoryOpened | LocalRepositoryFailure | RepositoryCancelled | RepositoryIpcFailure;
export type OpenRepositoryDocumentResult = DocumentWorkspaceResult | LocalRepositoryFailure | RepositoryIpcFailure;
export type UseRepositoryShelfResult = LibraryOpenResult | LocalRepositoryFailure | RepositoryIpcFailure;
export type CreateRepositoryHistoryResult = LocalHistorySnapshotResult | LocalRepositoryFailure | RepositoryIpcFailure;
export type ListRepositoryHistoryResult = LocalHistoryListResult | LocalRepositoryFailure | RepositoryIpcFailure;
export type OpenRepositoryHistoryResult = LocalRepositoryResult | RepositoryIpcFailure | RepositoryCancelled;

export interface RepositoryInvokeEvent {
  readonly sender: object;
}

export interface RepositoryHandlerDependencies {
  readonly pickParentFolder: () => Promise<RepositoryFolderSelection>;
  readonly pickRepositoryFolder: () => Promise<RepositoryFolderSelection>;
  readonly pickHistoryDestinationParent: () => Promise<RepositoryFolderSelection>;
  readonly createRepository: (
    owner: object,
    parentRoot: string,
    kind: RepositoryKind,
    title: string,
  ) => Promise<LocalRepositoryResult>;
  readonly openRepository: (owner: object, root: string) => Promise<LocalRepositoryResult>;
  readonly resolveRepository: (owner: object, repositoryId: string) => Promise<LocalRepositoryResolveResult>;
  readonly openDocument: (owner: object, root: string) => Promise<DocumentWorkspaceResult>;
  readonly openLibrary: (owner: object, root: string) => Promise<LibraryOpenResult>;
  readonly createHistory: (
    owner: object,
    repositoryId: string,
  ) => Promise<LocalHistorySnapshotResult | LocalRepositoryFailure>;
  readonly listHistory: (
    owner: object,
    repositoryId: string,
  ) => Promise<LocalHistoryListResult | LocalRepositoryFailure>;
  readonly openHistoryCopy: (
    owner: object,
    repositoryId: string,
    historyId: string,
    destinationParentRoot: string,
  ) => Promise<LocalRepositoryResult>;
}

export interface RepositoryHandlers {
  readonly createRepository: (
    event: RepositoryInvokeEvent,
    request: unknown,
    ...args: readonly unknown[]
  ) => Promise<CreateRepositoryResult>;
  readonly openRepository: (
    event: RepositoryInvokeEvent,
    ...args: readonly unknown[]
  ) => Promise<OpenRepositoryResult>;
  readonly openRepositoryDocument: (
    event: RepositoryInvokeEvent,
    request: unknown,
    ...args: readonly unknown[]
  ) => Promise<OpenRepositoryDocumentResult>;
  readonly useRepositoryShelf: (
    event: RepositoryInvokeEvent,
    request: unknown,
    ...args: readonly unknown[]
  ) => Promise<UseRepositoryShelfResult>;
  readonly createRepositoryHistory: (
    event: RepositoryInvokeEvent,
    request: unknown,
    ...args: readonly unknown[]
  ) => Promise<CreateRepositoryHistoryResult>;
  readonly listRepositoryHistory: (
    event: RepositoryInvokeEvent,
    request: unknown,
    ...args: readonly unknown[]
  ) => Promise<ListRepositoryHistoryResult>;
  readonly openRepositoryHistory: (
    event: RepositoryInvokeEvent,
    request: unknown,
    ...args: readonly unknown[]
  ) => Promise<OpenRepositoryHistoryResult>;
}

const INVALID_REQUEST: RepositoryIpcFailure = {
  kind: "error",
  code: "invalid-request",
  message: "The repository request was invalid.",
};

const PARENT_FOLDER_DIALOG_FAILED: RepositoryIpcFailure = {
  kind: "error",
  code: "parent-folder-dialog-failed",
  message: "The repository parent folder could not be selected. Try again.",
};

const REPOSITORY_FOLDER_DIALOG_FAILED: RepositoryIpcFailure = {
  kind: "error",
  code: "repository-folder-dialog-failed",
  message: "The repository folder could not be selected. Try again.",
};

const REPOSITORY_CREATE_FAILED: RepositoryIpcFailure = {
  kind: "error",
  code: "repository-create-failed",
  message: "The repository could not be created safely. Try again.",
};

const REPOSITORY_OPEN_FAILED: RepositoryIpcFailure = {
  kind: "error",
  code: "repository-open-failed",
  message: "The repository could not be opened. Choose it again.",
};

const REPOSITORY_HANDOFF_FAILED: RepositoryIpcFailure = {
  kind: "error",
  code: "repository-handoff-failed",
  message: "The repository could not be activated for this workspace.",
};

const WRONG_REPOSITORY_KIND: RepositoryIpcFailure = {
  kind: "error",
  code: "wrong-repository-kind",
  message: "That repository kind cannot be activated for this workspace.",
};

const REPOSITORY_HISTORY_FAILED: RepositoryIpcFailure = {
  kind: "error",
  code: "repository-history-failed",
  message: "Repository History could not be read or saved safely. Try again.",
};

const HISTORY_DESTINATION_FOLDER_DIALOG_FAILED: RepositoryIpcFailure = {
  kind: "error",
  code: "history-destination-folder-dialog-failed",
  message: "The History destination folder could not be selected. Try again.",
};

const REPOSITORY_HISTORY_COPY_FAILED: RepositoryIpcFailure = {
  kind: "error",
  code: "repository-history-copy-failed",
  message: "The selected History version could not be opened as a copy.",
};

const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = new Set<RepositoryKind>(["project", "workbench", "shelf"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function exactDataKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  let keys: (string | symbol)[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return false;
  }
  if (keys.length !== expected.length || keys.some((key) => typeof key !== "string" || !expected.includes(key))) return false;
  try {
    return expected.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && "value" in descriptor;
    });
  } catch {
    return false;
  }
}

function isTitle(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.trim().length > 0
    && Array.from(value).length <= 200
    && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value);
}

export function isCreateRepositoryRequest(value: unknown): value is CreateRepositoryRequest {
  if (!isPlainRecord(value) || !exactDataKeys(value, ["kind", "title"])) return false;
  return typeof value.kind === "string" && KINDS.has(value.kind as RepositoryKind) && isTitle(value.title);
}

export function isRepositoryHandoffRequest(value: unknown): value is RepositoryHandoffRequest {
  if (!isPlainRecord(value) || !exactDataKeys(value, ["repositoryId"])) return false;
  return typeof value.repositoryId === "string" && OPAQUE_ID.test(value.repositoryId);
}

export function isRepositoryHistoryRequest(value: unknown): value is RepositoryHistoryRequest {
  return isRepositoryHandoffRequest(value);
}

export function isRepositoryHistoryCopyRequest(value: unknown): value is RepositoryHistoryCopyRequest {
  if (!isPlainRecord(value) || !exactDataKeys(value, ["repositoryId", "historyId"])) return false;
  return typeof value.repositoryId === "string"
    && OPAQUE_ID.test(value.repositoryId)
    && typeof value.historyId === "string"
    && OPAQUE_ID.test(value.historyId);
}

function isFolderSelection(value: unknown): value is RepositoryFolderSelection {
  return isPlainRecord(value)
    && exactDataKeys(value, ["canceled", "filePaths"])
    && typeof value.canceled === "boolean"
    && Array.isArray(value.filePaths)
    && value.filePaths.every((filePath) => typeof filePath === "string");
}

function selectedPath(
  selection: RepositoryFolderSelection,
  failure: RepositoryIpcFailure,
): string | RepositoryCancelled | RepositoryIpcFailure {
  if (selection.canceled || selection.filePaths.length === 0) return { kind: "cancelled" };
  if (selection.filePaths.length !== 1) return failure;
  return selection.filePaths[0];
}

export function createRepositoryHandlers(dependencies: RepositoryHandlerDependencies): RepositoryHandlers {
  return {
    createRepository: async (event, request, ...args) => {
      if (args.length !== 0 || !isCreateRepositoryRequest(request)) return INVALID_REQUEST;
      let selection: RepositoryFolderSelection;
      try {
        selection = await dependencies.pickParentFolder();
      } catch {
        return PARENT_FOLDER_DIALOG_FAILED;
      }
      if (!isFolderSelection(selection)) return PARENT_FOLDER_DIALOG_FAILED;
      const selected = selectedPath(selection, PARENT_FOLDER_DIALOG_FAILED);
      if (typeof selected !== "string") return selected;
      try {
        return await dependencies.createRepository(event.sender, selected, request.kind, request.title);
      } catch {
        return REPOSITORY_CREATE_FAILED;
      }
    },
    openRepository: async (event, ...args) => {
      if (args.length !== 0) return INVALID_REQUEST;
      let selection: RepositoryFolderSelection;
      try {
        selection = await dependencies.pickRepositoryFolder();
      } catch {
        return REPOSITORY_FOLDER_DIALOG_FAILED;
      }
      if (!isFolderSelection(selection)) return REPOSITORY_FOLDER_DIALOG_FAILED;
      const selected = selectedPath(selection, REPOSITORY_FOLDER_DIALOG_FAILED);
      if (typeof selected !== "string") return selected;
      try {
        return await dependencies.openRepository(event.sender, selected);
      } catch {
        return REPOSITORY_OPEN_FAILED;
      }
    },
    openRepositoryDocument: async (event, request, ...args) => {
      if (args.length !== 0 || !isRepositoryHandoffRequest(request)) return INVALID_REQUEST;
      let resolved: LocalRepositoryResolveResult;
      try {
        resolved = await dependencies.resolveRepository(event.sender, request.repositoryId);
      } catch {
        return REPOSITORY_HANDOFF_FAILED;
      }
      if (resolved.kind === "error") return resolved;
      if (resolved.identity.kind !== "project" && resolved.identity.kind !== "workbench") {
        return WRONG_REPOSITORY_KIND;
      }
      try {
        return await dependencies.openDocument(event.sender, resolved.canonicalRoot);
      } catch {
        return REPOSITORY_HANDOFF_FAILED;
      }
    },
    useRepositoryShelf: async (event, request, ...args) => {
      if (args.length !== 0 || !isRepositoryHandoffRequest(request)) return INVALID_REQUEST;
      let resolved: LocalRepositoryResolveResult;
      try {
        resolved = await dependencies.resolveRepository(event.sender, request.repositoryId);
      } catch {
        return REPOSITORY_HANDOFF_FAILED;
      }
      if (resolved.kind === "error") return resolved;
      if (resolved.identity.kind !== "shelf") return WRONG_REPOSITORY_KIND;
      try {
        return await dependencies.openLibrary(event.sender, resolved.canonicalRoot);
      } catch {
        return REPOSITORY_HANDOFF_FAILED;
      }
    },
    createRepositoryHistory: async (event, request, ...args) => {
      if (args.length !== 0 || !isRepositoryHistoryRequest(request)) return INVALID_REQUEST;
      try {
        return await dependencies.createHistory(event.sender, request.repositoryId);
      } catch {
        return REPOSITORY_HISTORY_FAILED;
      }
    },
    listRepositoryHistory: async (event, request, ...args) => {
      if (args.length !== 0 || !isRepositoryHistoryRequest(request)) return INVALID_REQUEST;
      try {
        return await dependencies.listHistory(event.sender, request.repositoryId);
      } catch {
        return REPOSITORY_HISTORY_FAILED;
      }
    },
    openRepositoryHistory: async (event, request, ...args) => {
      if (args.length !== 0 || !isRepositoryHistoryCopyRequest(request)) return INVALID_REQUEST;
      let selection: RepositoryFolderSelection;
      try {
        selection = await dependencies.pickHistoryDestinationParent();
      } catch {
        return HISTORY_DESTINATION_FOLDER_DIALOG_FAILED;
      }
      if (!isFolderSelection(selection)) return HISTORY_DESTINATION_FOLDER_DIALOG_FAILED;
      const selected = selectedPath(selection, HISTORY_DESTINATION_FOLDER_DIALOG_FAILED);
      if (typeof selected !== "string") return selected;
      try {
        return await dependencies.openHistoryCopy(
          event.sender,
          request.repositoryId,
          request.historyId,
          selected,
        );
      } catch {
        return REPOSITORY_HISTORY_COPY_FAILED;
      }
    },
  };
}
