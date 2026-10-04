import type { OpenMarkdownResult } from "./markdown-ipc";
import type {
  ProjectCreateResult,
  ProjectFileCreateResult,
  ProjectFailure,
  ProjectOpened,
  ProjectResult,
  ProjectService,
} from "./project-service";
import { PROJECT_DOCUMENT_TYPES, type ProjectDocumentType } from "./project-metadata";
import type { DocumentWorkspaceFailure } from "./document-workspace";

export const OPEN_PROJECT_CHANNEL = "maginalia:open-project";
export const CREATE_PROJECT_CHANNEL = "maginalia:create-project";
export const RESTORE_PROJECT_CHANNEL = "maginalia:restore-project";
export const OPEN_PROJECT_FILE_CHANNEL = "maginalia:open-project-file";
export const CREATE_PROJECT_FILE_CHANNEL = "maginalia:create-project-file";

export interface ProjectFolderSelection {
  readonly canceled: boolean;
  readonly filePaths: readonly string[];
}

export interface ProjectInvokeEvent {
  readonly sender: object;
}

export interface CreateProjectRequest {
  readonly title: string;
}

export interface OpenProjectFileRequest {
  readonly projectId: string;
  readonly fileId: string;
}

export interface CreateProjectFileRequest {
  readonly projectId: string;
  readonly fileName: string;
  readonly title: string;
  readonly documentType: ProjectDocumentType;
  /** Opaque Explorer folder ID; null creates at the Project root. */
  readonly parentEntryId?: string | null;
}

export interface ProjectCancelled {
  readonly kind: "cancelled";
}

export interface ProjectRestoreNone {
  readonly kind: "none";
}

export type ProjectOpenResult = ProjectResult | ProjectCancelled | ProjectIpcFailure;
export type ProjectCreateResultWithCancel = ProjectCreateResult | ProjectCancelled | ProjectIpcFailure;
export type ProjectRestoreResult = ProjectResult | ProjectRestoreNone | ProjectIpcFailure;
export type ProjectFileOpenResult = OpenMarkdownResult | DocumentWorkspaceFailure | ProjectIpcFailure;
export type ProjectFileCreateResultWithError = ProjectFileCreateResult | ProjectIpcFailure;

export type ProjectIpcFailureCode =
  | "invalid-request"
  | "folder-dialog-failed"
  | "project-open-failed"
  | "project-create-failed"
  | "project-restore-failed"
  | "project-file-open-failed"
  | "project-file-create-failed";

export interface ProjectIpcFailure {
  readonly kind: "error";
  readonly code: ProjectIpcFailureCode;
  readonly message: string;
}

export interface ProjectHandlerDependencies {
  readonly pickProjectFolder: () => Promise<ProjectFolderSelection>;
  readonly pickProjectParent: () => Promise<ProjectFolderSelection>;
  readonly openProjectRoot: (owner: object, rootPath: string) => Promise<ProjectResult>;
  readonly createProject: (owner: object, parentPath: string, title: string) => Promise<ProjectCreateResult>;
  readonly restoreProject: (owner: object) => Promise<ProjectResult | ProjectRestoreNone>;
  readonly openProjectFile: (owner: object, projectId: string, fileId: string) => Promise<OpenMarkdownResult | DocumentWorkspaceFailure>;
  readonly createProjectFile: (
    owner: object,
    request: CreateProjectFileRequest,
  ) => Promise<ProjectFileCreateResult>;
}

export interface ProjectHandlers {
  readonly openProject: (event: ProjectInvokeEvent, ...args: readonly unknown[]) => Promise<ProjectOpenResult>;
  readonly createProject: (event: ProjectInvokeEvent, request: unknown, ...args: readonly unknown[]) => Promise<ProjectCreateResultWithCancel>;
  readonly restoreProject: (event: ProjectInvokeEvent, ...args: readonly unknown[]) => Promise<ProjectRestoreResult>;
  readonly openProjectFile: (event: ProjectInvokeEvent, request: unknown, ...args: readonly unknown[]) => Promise<ProjectFileOpenResult>;
  readonly createProjectFile: (event: ProjectInvokeEvent, request: unknown, ...args: readonly unknown[]) => Promise<ProjectFileCreateResultWithError>;
}

const INVALID_REQUEST: ProjectIpcFailure = {
  kind: "error",
  code: "invalid-request",
  message: "The Project request was invalid."
};

const FOLDER_DIALOG_FAILED: ProjectIpcFailure = {
  kind: "error",
  code: "folder-dialog-failed",
  message: "The Project folder could not be selected. Try again."
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

function isFolderSelection(value: unknown): value is ProjectFolderSelection {
  return isRecord(value)
    && typeof value.canceled === "boolean"
    && Array.isArray(value.filePaths)
    && value.filePaths.every((filePath) => typeof filePath === "string");
}

function isCreateProjectRequest(value: unknown): value is CreateProjectRequest {
  return isExactRecord(value, ["title"]) && typeof value.title === "string";
}

function isOpenProjectFileRequest(value: unknown): value is OpenProjectFileRequest {
  return isExactRecord(value, ["projectId", "fileId"])
    && isOpaqueId(value.projectId)
    && isOpaqueId(value.fileId);
}

function isCreateProjectFileRequest(value: unknown): value is CreateProjectFileRequest {
  if (!isRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (!(keys.length === 4 || keys.length === 5)
    || !["projectId", "fileName", "title", "documentType"].every((key) => keys.includes(key))
    || (keys.length === 5 && !keys.includes("parentEntryId"))) return false;
  return isOpaqueId(value.projectId)
    && typeof value.fileName === "string"
    && typeof value.title === "string"
    && typeof value.documentType === "string"
    && (PROJECT_DOCUMENT_TYPES as readonly string[]).includes(value.documentType)
    && (value.parentEntryId === undefined || value.parentEntryId === null || isOpaqueId(value.parentEntryId));
}

export function createProjectHandlers(dependencies: ProjectHandlerDependencies): ProjectHandlers {
  return {
    openProject: async (event, ...args) => {
      if (args.length !== 0) return INVALID_REQUEST;
      let selection: ProjectFolderSelection;
      try {
        selection = await dependencies.pickProjectFolder();
      } catch (_error: unknown) {
        return FOLDER_DIALOG_FAILED;
      }
      if (!isFolderSelection(selection)) return FOLDER_DIALOG_FAILED;
      if (selection.canceled || selection.filePaths.length === 0) return { kind: "cancelled" };
      if (selection.filePaths.length !== 1) return FOLDER_DIALOG_FAILED;
      try {
        return await dependencies.openProjectRoot(event.sender, selection.filePaths[0]);
      } catch (_error: unknown) {
        return { kind: "error", code: "project-open-failed", message: "The Project folder could not be opened. Choose it again." };
      }
    },
    createProject: async (event, request, ...args) => {
      if (args.length !== 0 || !isCreateProjectRequest(request)) return INVALID_REQUEST;
      let selection: ProjectFolderSelection;
      try {
        selection = await dependencies.pickProjectParent();
      } catch (_error: unknown) {
        return FOLDER_DIALOG_FAILED;
      }
      if (!isFolderSelection(selection)) return FOLDER_DIALOG_FAILED;
      if (selection.canceled || selection.filePaths.length === 0) return { kind: "cancelled" };
      if (selection.filePaths.length !== 1) return FOLDER_DIALOG_FAILED;
      try {
        return await dependencies.createProject(event.sender, selection.filePaths[0], request.title);
      } catch (_error: unknown) {
        return { kind: "error", code: "project-create-failed", message: "The Project could not be created. Try again." };
      }
    },
    restoreProject: async (event, ...args) => {
      if (args.length !== 0) return INVALID_REQUEST;
      try {
        return await dependencies.restoreProject(event.sender);
      } catch (_error: unknown) {
        return { kind: "error", code: "project-restore-failed", message: "The previous Project could not be restored. Choose it again." };
      }
    },
    openProjectFile: async (event, request, ...args) => {
      if (args.length !== 0 || !isOpenProjectFileRequest(request)) return INVALID_REQUEST;
      try {
        return await dependencies.openProjectFile(event.sender, request.projectId, request.fileId);
      } catch (_error: unknown) {
        return { kind: "error", code: "project-file-open-failed", message: "The Markdown file could not be opened. Try again." };
      }
    },
    createProjectFile: async (event, request, ...args) => {
      if (args.length !== 0 || !isCreateProjectFileRequest(request)) return INVALID_REQUEST;
      try {
        return await dependencies.createProjectFile(event.sender, request);
      } catch (_error: unknown) {
        return { kind: "error", code: "project-file-create-failed", message: "The Markdown file could not be created. Try another name." };
      }
    }
  };
}
