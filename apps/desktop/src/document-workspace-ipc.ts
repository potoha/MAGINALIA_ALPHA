import type {
  DocumentWorkspaceFailure,
  DocumentWorkspaceOpened,
  DocumentWorkspaceResult,
  ExplorerListResult,
  CreateFolderResult,
  ResolveManuscriptPathResult
} from "./document-workspace";
import type { OpenMarkdownResult } from "./markdown-ipc";

export const OPEN_DOCUMENT_CHANNEL = "maginalia:open-document";
export const OPEN_MANUSCRIPT_CHANNEL = "maginalia:open-manuscript";
export const LIST_EXPLORER_CHANNEL = "maginalia:explorer-list";
export const CREATE_EXPLORER_FOLDER_CHANNEL = "maginalia:explorer-create-folder";
export const DELETE_EXPLORER_FILE_CHANNEL = "maginalia:explorer-delete-file";

export interface ExplorerListRequest {
  readonly documentId: string;
}

export interface ExplorerCreateFolderRequest extends ExplorerListRequest {
  readonly parentEntryId: string | null;
  readonly name: string;
}

export interface ExplorerDeleteFileRequest extends ExplorerListRequest {
  readonly entryId: string;
}

export type ExplorerDeleteFileResult = { readonly kind: "deleted"; readonly entryId: string } | DocumentWorkspaceFailure;

export interface ExplorerHandlerDependencies {
  readonly listExplorer: (owner: object, documentId: string) => Promise<ExplorerListResult>;
  readonly createFolder: (owner: object, documentId: string, parentEntryId: string | null, name: string) => Promise<CreateFolderResult>;
  readonly deleteFile: (owner: object, documentId: string, entryId: string) => Promise<ExplorerDeleteFileResult>;
}

export interface DocumentWorkspaceCancelled {
  readonly kind: "cancelled";
}

export interface DocumentFolderSelection {
  readonly canceled: boolean;
  readonly filePaths: readonly string[];
}

export interface DocumentWorkspaceInvokeEvent {
  readonly sender: object;
}

export interface OpenManuscriptRequest {
  readonly documentId: string;
  readonly manuscriptId: string;
}

export type DocumentWorkspaceIpcFailureCode =
  | "invalid-request"
  | "folder-dialog-failed"
  | "document-open-failed"
  | "manuscript-open-failed";

export interface DocumentWorkspaceIpcFailure {
  readonly kind: "error";
  readonly code: DocumentWorkspaceIpcFailureCode;
  readonly message: string;
}

export type OpenDocumentResult =
  | DocumentWorkspaceOpened
  | DocumentWorkspaceCancelled
  | DocumentWorkspaceFailure
  | DocumentWorkspaceIpcFailure;

export type OpenManuscriptResult =
  | OpenMarkdownResult
  | DocumentWorkspaceFailure
  | DocumentWorkspaceIpcFailure;

export interface DocumentWorkspaceHandlerDependencies {
  readonly pickDocumentFolder: () => Promise<DocumentFolderSelection>;
  readonly openDocumentRoot: (owner: object, rootPath: string) => Promise<DocumentWorkspaceResult>;
  readonly resolveManuscriptPath: (
    owner: object,
    documentId: string,
    manuscriptId: string
  ) => Promise<ResolveManuscriptPathResult>;
  readonly openMarkdown: (owner: object, filePath: string) => Promise<OpenMarkdownResult>;
}

export interface DocumentWorkspaceHandlers {
  readonly openDocument: (
    event: DocumentWorkspaceInvokeEvent,
    ...args: readonly unknown[]
  ) => Promise<OpenDocumentResult>;
  readonly openManuscript: (
    event: DocumentWorkspaceInvokeEvent,
    request: unknown,
    ...args: readonly unknown[]
  ) => Promise<OpenManuscriptResult>;
}

const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INVALID_REQUEST: DocumentWorkspaceIpcFailure = {
  kind: "error",
  code: "invalid-request",
  message: "The Document workspace request was invalid."
};

const FOLDER_DIALOG_FAILED: DocumentWorkspaceIpcFailure = {
  kind: "error",
  code: "folder-dialog-failed",
  message: "The Document folder could not be selected. Try again."
};

const DOCUMENT_OPEN_FAILED: DocumentWorkspaceIpcFailure = {
  kind: "error",
  code: "document-open-failed",
  message: "The Document folder could not be opened. Choose it again."
};

const MANUSCRIPT_OPEN_FAILED: DocumentWorkspaceIpcFailure = {
  kind: "error",
  code: "manuscript-open-failed",
  message: "The Markdown manuscript could not be opened. Choose it again."
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID.test(value);
}

export function isExplorerListRequest(value: unknown): value is ExplorerListRequest {
  return isRecord(value) && Reflect.ownKeys(value).length === 1 && isOpaqueId(value.documentId);
}

export function isExplorerCreateFolderRequest(value: unknown): value is ExplorerCreateFolderRequest {
  if (!isRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === 3 && keys.includes("documentId") && keys.includes("parentEntryId") && keys.includes("name")
    && isOpaqueId(value.documentId) && (value.parentEntryId === null || isOpaqueId(value.parentEntryId)) && typeof value.name === "string";
}

export function isExplorerDeleteFileRequest(value: unknown): value is ExplorerDeleteFileRequest {
  return isRecord(value) && Reflect.ownKeys(value).length === 2
    && isOpaqueId(value.documentId) && isOpaqueId(value.entryId);
}

export function createExplorerHandlers(dependencies: ExplorerHandlerDependencies) {
  const failed: DocumentWorkspaceIpcFailure = { kind: "error", code: "document-open-failed", message: "The Explorer operation could not be completed. Try again." };
  return {
    listExplorer: async (event: DocumentWorkspaceInvokeEvent, request: unknown, ...args: readonly unknown[]): Promise<ExplorerListResult | DocumentWorkspaceIpcFailure> => {
      if (args.length !== 0 || !isExplorerListRequest(request)) return INVALID_REQUEST;
      try { return await dependencies.listExplorer(event.sender, request.documentId); }
      catch (_error: unknown) { return failed; }
    },
    createFolder: async (event: DocumentWorkspaceInvokeEvent, request: unknown, ...args: readonly unknown[]): Promise<CreateFolderResult | DocumentWorkspaceIpcFailure> => {
      if (args.length !== 0 || !isExplorerCreateFolderRequest(request)) return INVALID_REQUEST;
      try { return await dependencies.createFolder(event.sender, request.documentId, request.parentEntryId, request.name); }
      catch (_error: unknown) { return failed; }
    },
    deleteFile: async (event: DocumentWorkspaceInvokeEvent, request: unknown, ...args: readonly unknown[]): Promise<ExplorerDeleteFileResult | DocumentWorkspaceIpcFailure> => {
      if (args.length !== 0 || !isExplorerDeleteFileRequest(request)) return INVALID_REQUEST;
      try { return await dependencies.deleteFile(event.sender, request.documentId, request.entryId); }
      catch (_error: unknown) { return failed; }
    }
  };
}

function isFolderSelection(value: unknown): value is DocumentFolderSelection {
  return isRecord(value)
    && typeof value.canceled === "boolean"
    && Array.isArray(value.filePaths)
    && value.filePaths.every((filePath) => typeof filePath === "string");
}

export function isOpenManuscriptRequest(value: unknown): value is OpenManuscriptRequest {
  if (!isRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === 2
    && keys.includes("documentId")
    && keys.includes("manuscriptId")
    && isOpaqueId(value.documentId)
    && isOpaqueId(value.manuscriptId);
}

export function createDocumentWorkspaceHandlers(
  dependencies: DocumentWorkspaceHandlerDependencies
): DocumentWorkspaceHandlers {
  return {
    openDocument: async (event, ...args) => {
      if (args.length !== 0) return INVALID_REQUEST;

      let selection: DocumentFolderSelection;
      try {
        selection = await dependencies.pickDocumentFolder();
      } catch (_error: unknown) {
        return FOLDER_DIALOG_FAILED;
      }
      if (!isFolderSelection(selection)) return FOLDER_DIALOG_FAILED;
      if (selection.canceled || selection.filePaths.length === 0) return { kind: "cancelled" };
      if (selection.filePaths.length !== 1) return FOLDER_DIALOG_FAILED;

      try {
        return await dependencies.openDocumentRoot(event.sender, selection.filePaths[0]);
      } catch (_error: unknown) {
        return DOCUMENT_OPEN_FAILED;
      }
    },
    openManuscript: async (event, request, ...args) => {
      if (args.length !== 0 || !isOpenManuscriptRequest(request)) return INVALID_REQUEST;

      let resolved: ResolveManuscriptPathResult;
      try {
        resolved = await dependencies.resolveManuscriptPath(
          event.sender,
          request.documentId,
          request.manuscriptId
        );
      } catch (_error: unknown) {
        return MANUSCRIPT_OPEN_FAILED;
      }
      if (resolved.kind !== "resolved") return resolved;

      try {
        return await dependencies.openMarkdown(event.sender, resolved.canonicalPath);
      } catch (_error: unknown) {
        return MANUSCRIPT_OPEN_FAILED;
      }
    }
  };
}
