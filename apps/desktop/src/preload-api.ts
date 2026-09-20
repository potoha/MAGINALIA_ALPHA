import {
  type OpenMarkdownResult,
  type SaveMarkdownRequest,
  type SaveMarkdownResult
} from "./markdown-ipc";
import {
  OPEN_DOCUMENT_CHANNEL,
  OPEN_MANUSCRIPT_CHANNEL,
  type OpenDocumentResult,
  type OpenManuscriptRequest,
  type OpenManuscriptResult
} from "./document-workspace-ipc";
import {
  OPEN_LIBRARY_CHANNEL,
  RESOLVE_QUOTATION_FOR_INSERT_CHANNEL,
  SEARCH_LIBRARY_CHANNEL,
  type OpenLibraryResult,
  type ResolveQuotationForInsertRequest,
  type ResolveQuotationForInsertResult,
  type SearchLibraryRequest,
  type SearchLibraryResult
} from "./library-ipc";
import {
  SEARCH_SHELF_CHANNEL,
  type SearchShelfRequest,
  type SearchShelfResult
} from "./reviewer-ipc";
import {
  RESOLVE_REFERENCES_CHANNEL,
  type ResolveReferencesRequest,
  type ResolveReferencesResult
} from "./reference-ipc";
import {
  INVOKE_MOD_COMMAND_CHANNEL,
  LOAD_MODS_CHANNEL,
  MOD_CAPABILITY_REQUEST_CHANNEL,
  OPEN_MODS_FOLDER_CHANNEL,
  RELOAD_MODS_CHANNEL,
  RESPOND_MOD_CAPABILITY_CHANNEL,
  isModCapabilityRequestEvent,
  type InvokeModCommandResult,
  type ModCapabilityRequestEvent,
  type ModCapabilityResponse,
  type ModCapabilityResponseRequest,
  type ModCommandRequest,
  type OpenModsFolderResult,
  type ModSnapshotResult
} from "./mod-ipc";
import {
  LOAD_WORKSPACE_STATE_CHANNEL,
  SAVE_WORKSPACE_STATE_CHANNEL,
  type LoadWorkspaceStateResult,
  type SaveWorkspaceStateResult,
  type WorkspaceState
} from "./workspace-state-ipc";
import {
  CREATE_REPOSITORY_CHANNEL,
  CREATE_REPOSITORY_HISTORY_CHANNEL,
  LIST_REPOSITORY_HISTORY_CHANNEL,
  OPEN_REPOSITORY_CHANNEL,
  OPEN_REPOSITORY_HISTORY_CHANNEL,
  OPEN_REPOSITORY_DOCUMENT_CHANNEL,
  USE_REPOSITORY_SHELF_CHANNEL,
  type CreateRepositoryRequest,
  type CreateRepositoryResult,
  type CreateRepositoryHistoryResult,
  type ListRepositoryHistoryResult,
  type OpenRepositoryDocumentResult,
  type OpenRepositoryHistoryResult,
  type OpenRepositoryResult,
  type RepositoryHandoffRequest,
  type RepositoryHistoryCopyRequest,
  type RepositoryHistoryRequest,
  type UseRepositoryShelfResult
} from "./repository-ipc";
import {
  DISCOVER_PRIVATE_WORKS_CHANNEL,
  CANCEL_PRIVATE_WORKS_DISCOVERY_CHANNEL,
  GITHUB_DEVICE_PROMPT_CHANNEL,
  GITHUB_DEVICE_VERIFICATION_URI,
  type RepositoryCloudDevicePrompt,
  type RepositoryCloudDiscoveryCancelResult,
  type RepositoryCloudDiscoveryIpcResult
} from "./repository-cloud-ipc";
import {
  CREATE_PROJECT_CHANNEL,
  CREATE_PROJECT_FILE_CHANNEL,
  OPEN_PROJECT_CHANNEL,
  OPEN_PROJECT_FILE_CHANNEL,
  RESTORE_PROJECT_CHANNEL,
  type CreateProjectFileRequest,
  type CreateProjectRequest,
  type OpenProjectFileRequest,
  type ProjectCreateResultWithCancel,
  type ProjectFileCreateResultWithError,
  type ProjectFileOpenResult,
  type ProjectOpenResult,
  type ProjectRestoreResult
} from "./project-ipc";

export const OPEN_MARKDOWN_CHANNEL = "maginalia:open-markdown";
export const SAVE_MARKDOWN_CHANNEL = "maginalia:save-markdown";
export { OPEN_DOCUMENT_CHANNEL, OPEN_MANUSCRIPT_CHANNEL } from "./document-workspace-ipc";
export {
  CREATE_PROJECT_CHANNEL,
  CREATE_PROJECT_FILE_CHANNEL,
  OPEN_PROJECT_CHANNEL,
  OPEN_PROJECT_FILE_CHANNEL,
  RESTORE_PROJECT_CHANNEL
} from "./project-ipc";
export {
  OPEN_LIBRARY_CHANNEL,
  SEARCH_LIBRARY_CHANNEL,
  RESOLVE_QUOTATION_FOR_INSERT_CHANNEL
} from "./library-ipc";
export { SEARCH_SHELF_CHANNEL } from "./reviewer-ipc";
export { RESOLVE_REFERENCES_CHANNEL } from "./reference-ipc";
export {
  INVOKE_MOD_COMMAND_CHANNEL,
  LOAD_MODS_CHANNEL,
  MOD_CAPABILITY_REQUEST_CHANNEL,
  OPEN_MODS_FOLDER_CHANNEL,
  RELOAD_MODS_CHANNEL,
  RESPOND_MOD_CAPABILITY_CHANNEL
} from "./mod-ipc";
export { LOAD_WORKSPACE_STATE_CHANNEL, SAVE_WORKSPACE_STATE_CHANNEL } from "./workspace-state-ipc";
export {
  CREATE_REPOSITORY_CHANNEL,
  CREATE_REPOSITORY_HISTORY_CHANNEL,
  LIST_REPOSITORY_HISTORY_CHANNEL,
  OPEN_REPOSITORY_CHANNEL,
  OPEN_REPOSITORY_HISTORY_CHANNEL,
  OPEN_REPOSITORY_DOCUMENT_CHANNEL,
  USE_REPOSITORY_SHELF_CHANNEL
} from "./repository-ipc";
export {
  DISCOVER_PRIVATE_WORKS_CHANNEL,
  CANCEL_PRIVATE_WORKS_DISCOVERY_CHANNEL,
  GITHUB_DEVICE_PROMPT_CHANNEL,
  GITHUB_DEVICE_VERIFICATION_URI
} from "./repository-cloud-ipc";

export type {
  OpenLibraryResult,
  QuotationReference,
  ResolveQuotationForInsertRequest,
  ResolveQuotationForInsertResult,
  SearchLibraryRequest,
  SearchLibraryResult
} from "./library-ipc";
export type {
  ReviewerQuotation,
  SearchShelfRequest,
  SearchShelfResult
} from "./reviewer-ipc";
export type {
  ResolveReferencesRequest,
  ResolveReferencesResult
} from "./reference-ipc";
export type {
  InvokeModCommandResult,
  ModCapabilityRequestEvent,
  ModCapabilityResponse,
  ModCapabilityResponseRequest,
  ModCommandRequest,
  ModSnapshotResult
} from "./mod-ipc";
export type {
  LoadWorkspaceStateResult,
  SaveWorkspaceStateResult,
  WorkspaceState
} from "./workspace-state-ipc";
export type {
  CreateRepositoryRequest,
  CreateRepositoryResult,
  CreateRepositoryHistoryResult,
  ListRepositoryHistoryResult,
  OpenRepositoryDocumentResult,
  OpenRepositoryHistoryResult,
  OpenRepositoryResult,
  RepositoryHandoffRequest,
  RepositoryHistoryCopyRequest,
  RepositoryHistoryRequest,
  UseRepositoryShelfResult
} from "./repository-ipc";
export type {
  RepositoryCloudDevicePrompt,
  RepositoryCloudDiscoveryCancelResult,
  RepositoryCloudDiscoveryIpcResult
} from "./repository-cloud-ipc";
export type {
  CreateProjectFileRequest,
  CreateProjectRequest,
  OpenProjectFileRequest,
  ProjectCreateResultWithCancel,
  ProjectFileCreateResultWithError,
  ProjectFileOpenResult,
  ProjectOpenResult,
  ProjectRestoreResult
} from "./project-ipc";

export type DevicePromptCallback = (prompt: RepositoryCloudDevicePrompt) => void;
export type DevicePromptUnsubscribe = () => void;
export type ModCapabilityCallback = (
  request: ModCapabilityRequestEvent,
) => ModCapabilityResponse | Promise<ModCapabilityResponse>;

export interface MarkdownPreloadApi {
  openMarkdown(): Promise<OpenMarkdownResult>;
  saveMarkdown(request: SaveMarkdownRequest): Promise<SaveMarkdownResult>;
  openDocument?(): Promise<OpenDocumentResult>;
  openManuscript?(request: OpenManuscriptRequest): Promise<OpenManuscriptResult>;
  openProject?(): Promise<ProjectOpenResult>;
  createProject?(request: CreateProjectRequest): Promise<ProjectCreateResultWithCancel>;
  restoreProject?(): Promise<ProjectRestoreResult>;
  openProjectFile?(request: OpenProjectFileRequest): Promise<ProjectFileOpenResult>;
  createProjectFile?(request: CreateProjectFileRequest): Promise<ProjectFileCreateResultWithError>;
  openLibrary?(): Promise<OpenLibraryResult>;
  searchLibrary?(request: SearchLibraryRequest): Promise<SearchLibraryResult>;
  resolveQuotationForInsert?(request: ResolveQuotationForInsertRequest): Promise<ResolveQuotationForInsertResult>;
  searchShelf?(request: SearchShelfRequest): Promise<SearchShelfResult>;
  resolveReferences?(request: ResolveReferencesRequest): Promise<ResolveReferencesResult>;
  loadMods?(): Promise<ModSnapshotResult>;
  reloadMods?(): Promise<ModSnapshotResult>;
  openModsFolder?(): Promise<OpenModsFolderResult>;
  invokeModCommand?(request: ModCommandRequest): Promise<InvokeModCommandResult>;
  onModCapabilityRequest?(callback: ModCapabilityCallback): DevicePromptUnsubscribe;
  loadWorkspaceState?(): Promise<LoadWorkspaceStateResult>;
  saveWorkspaceState?(state: WorkspaceState): Promise<SaveWorkspaceStateResult>;
  createRepository?(request: CreateRepositoryRequest): Promise<CreateRepositoryResult>;
  createRepositoryHistory?(request: RepositoryHistoryRequest): Promise<CreateRepositoryHistoryResult>;
  listRepositoryHistory?(request: RepositoryHistoryRequest): Promise<ListRepositoryHistoryResult>;
  openRepositoryHistory?(request: RepositoryHistoryCopyRequest): Promise<OpenRepositoryHistoryResult>;
  openRepository?(): Promise<OpenRepositoryResult>;
  openRepositoryDocument?(request: RepositoryHandoffRequest): Promise<OpenRepositoryDocumentResult>;
  useRepositoryShelf?(request: RepositoryHandoffRequest): Promise<UseRepositoryShelfResult>;
  discoverPrivateWorks?(): Promise<RepositoryCloudDiscoveryIpcResult>;
  cancelPrivateWorksDiscovery?(): Promise<RepositoryCloudDiscoveryCancelResult>;
  onDevicePrompt?(callback: DevicePromptCallback): DevicePromptUnsubscribe;
}

export type CompleteMarkdownPreloadApi = MarkdownPreloadApi & {
  openDocument(): Promise<OpenDocumentResult>;
  openManuscript(request: OpenManuscriptRequest): Promise<OpenManuscriptResult>;
  openProject(): Promise<ProjectOpenResult>;
  createProject(request: CreateProjectRequest): Promise<ProjectCreateResultWithCancel>;
  restoreProject(): Promise<ProjectRestoreResult>;
  openProjectFile(request: OpenProjectFileRequest): Promise<ProjectFileOpenResult>;
  createProjectFile(request: CreateProjectFileRequest): Promise<ProjectFileCreateResultWithError>;
  openLibrary(): Promise<OpenLibraryResult>;
  searchLibrary(request: SearchLibraryRequest): Promise<SearchLibraryResult>;
  resolveQuotationForInsert(request: ResolveQuotationForInsertRequest): Promise<ResolveQuotationForInsertResult>;
  searchShelf(request: SearchShelfRequest): Promise<SearchShelfResult>;
  resolveReferences(request: ResolveReferencesRequest): Promise<ResolveReferencesResult>;
  loadMods(): Promise<ModSnapshotResult>;
  reloadMods(): Promise<ModSnapshotResult>;
  openModsFolder(): Promise<OpenModsFolderResult>;
  invokeModCommand(request: ModCommandRequest): Promise<InvokeModCommandResult>;
  onModCapabilityRequest(callback: ModCapabilityCallback): DevicePromptUnsubscribe;
  loadWorkspaceState(): Promise<LoadWorkspaceStateResult>;
  saveWorkspaceState(state: WorkspaceState): Promise<SaveWorkspaceStateResult>;
  createRepository(request: CreateRepositoryRequest): Promise<CreateRepositoryResult>;
  createRepositoryHistory(request: RepositoryHistoryRequest): Promise<CreateRepositoryHistoryResult>;
  listRepositoryHistory(request: RepositoryHistoryRequest): Promise<ListRepositoryHistoryResult>;
  openRepositoryHistory(request: RepositoryHistoryCopyRequest): Promise<OpenRepositoryHistoryResult>;
  openRepository(): Promise<OpenRepositoryResult>;
  openRepositoryDocument(request: RepositoryHandoffRequest): Promise<OpenRepositoryDocumentResult>;
  useRepositoryShelf(request: RepositoryHandoffRequest): Promise<UseRepositoryShelfResult>;
  discoverPrivateWorks(): Promise<RepositoryCloudDiscoveryIpcResult>;
  cancelPrivateWorksDiscovery(): Promise<RepositoryCloudDiscoveryCancelResult>;
  onDevicePrompt(callback: DevicePromptCallback): DevicePromptUnsubscribe;
};

export type MarkdownInvoke = (channel: string, ...args: readonly unknown[]) => Promise<unknown>;
export type MarkdownEventSubscribe = (
  channel: string,
  listener: (value: unknown) => void,
) => DevicePromptUnsubscribe;

const DEVICE_USER_CODE_PATTERN = /^[A-Za-z0-9-]+$/u;
const MAX_DEVICE_USER_CODE_LENGTH = 64;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function isExactDataKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  try {
    const keys = Reflect.ownKeys(value);
    return keys.length === expected.length
      && keys.every((key) => typeof key === "string" && expected.includes(key))
      && expected.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && "value" in descriptor;
      });
  } catch {
    return false;
  }
}

function normalizeDevicePrompt(value: unknown): RepositoryCloudDevicePrompt | undefined {
  if (!isPlainRecord(value) || !isExactDataKeys(value, ["userCode", "verificationUri"])) return undefined;
  try {
    const userCode = value.userCode;
    if (typeof userCode !== "string"
      || userCode.length === 0
      || userCode.length > MAX_DEVICE_USER_CODE_LENGTH
      || !DEVICE_USER_CODE_PATTERN.test(userCode)
      || value.verificationUri !== GITHUB_DEVICE_VERIFICATION_URI) {
      return undefined;
    }
    return Object.freeze({
      userCode,
      verificationUri: GITHUB_DEVICE_VERIFICATION_URI,
    });
  } catch {
    return undefined;
  }
}

const noEventSubscription: MarkdownEventSubscribe = () => () => undefined;

export function createMarkdownPreloadApi(
  invoke: MarkdownInvoke,
  subscribe: MarkdownEventSubscribe = noEventSubscription,
): CompleteMarkdownPreloadApi {
  return {
    openMarkdown: () => invoke(OPEN_MARKDOWN_CHANNEL) as Promise<OpenMarkdownResult>,
    saveMarkdown: (request) => invoke(SAVE_MARKDOWN_CHANNEL, request) as Promise<SaveMarkdownResult>,
    openDocument: () => invoke(OPEN_DOCUMENT_CHANNEL) as Promise<OpenDocumentResult>,
    openManuscript: (request) => invoke(OPEN_MANUSCRIPT_CHANNEL, request) as Promise<OpenManuscriptResult>,
    openProject: () => invoke(OPEN_PROJECT_CHANNEL) as Promise<ProjectOpenResult>,
    createProject: (request) => invoke(CREATE_PROJECT_CHANNEL, request) as Promise<ProjectCreateResultWithCancel>,
    restoreProject: () => invoke(RESTORE_PROJECT_CHANNEL) as Promise<ProjectRestoreResult>,
    openProjectFile: (request) => invoke(OPEN_PROJECT_FILE_CHANNEL, request) as Promise<ProjectFileOpenResult>,
    createProjectFile: (request) => invoke(CREATE_PROJECT_FILE_CHANNEL, request) as Promise<ProjectFileCreateResultWithError>,
    openLibrary: () => invoke(OPEN_LIBRARY_CHANNEL) as Promise<OpenLibraryResult>,
    searchLibrary: (request) => invoke(SEARCH_LIBRARY_CHANNEL, request) as Promise<SearchLibraryResult>,
    resolveQuotationForInsert: (request) =>
      invoke(RESOLVE_QUOTATION_FOR_INSERT_CHANNEL, request) as Promise<ResolveQuotationForInsertResult>,
    searchShelf: (request) => invoke(SEARCH_SHELF_CHANNEL, request) as Promise<SearchShelfResult>,
    resolveReferences: (request) =>
      invoke(RESOLVE_REFERENCES_CHANNEL, request) as Promise<ResolveReferencesResult>,
    loadMods: () => invoke(LOAD_MODS_CHANNEL) as Promise<ModSnapshotResult>,
    reloadMods: () => invoke(RELOAD_MODS_CHANNEL) as Promise<ModSnapshotResult>,
    openModsFolder: () => invoke(OPEN_MODS_FOLDER_CHANNEL) as Promise<OpenModsFolderResult>,
    invokeModCommand: (request) => invoke(INVOKE_MOD_COMMAND_CHANNEL, request) as Promise<InvokeModCommandResult>,
    onModCapabilityRequest: (callback) => {
      if (typeof callback !== "function") throw new TypeError("The Mod capability callback is invalid.");
      return subscribe(MOD_CAPABILITY_REQUEST_CHANNEL, (value) => {
        // The main process has already validated the worker envelope. Keep
        // the callback boundary explicit and ensure renderer failures produce
        // a response instead of leaving a worker request pending.
        if (!isModCapabilityRequestEvent(value)) return;
        const request = value;
        let result: ModCapabilityResponse | Promise<ModCapabilityResponse>;
        try {
          result = callback(request);
        } catch (error) {
          result = {
            kind: "error",
            message: error instanceof Error && error.message.length > 0
              ? error.message.slice(0, 500)
              : "The Mod capability failed."
          };
        }
        void Promise.resolve(result).then((response) => {
          const requestValue: ModCapabilityResponseRequest = { requestId: request.requestId, response };
          return invoke(RESPOND_MOD_CAPABILITY_CHANNEL, requestValue);
        }).catch(() => undefined);
      });
    },
    loadWorkspaceState: () =>
      invoke(LOAD_WORKSPACE_STATE_CHANNEL) as Promise<LoadWorkspaceStateResult>,
    saveWorkspaceState: (state) =>
      invoke(SAVE_WORKSPACE_STATE_CHANNEL, state) as Promise<SaveWorkspaceStateResult>,
    createRepository: (request) =>
      invoke(CREATE_REPOSITORY_CHANNEL, request) as Promise<CreateRepositoryResult>,
    createRepositoryHistory: (request) =>
      invoke(CREATE_REPOSITORY_HISTORY_CHANNEL, request) as Promise<CreateRepositoryHistoryResult>,
    listRepositoryHistory: (request) =>
      invoke(LIST_REPOSITORY_HISTORY_CHANNEL, request) as Promise<ListRepositoryHistoryResult>,
    openRepositoryHistory: (request) =>
      invoke(OPEN_REPOSITORY_HISTORY_CHANNEL, request) as Promise<OpenRepositoryHistoryResult>,
    openRepository: () => invoke(OPEN_REPOSITORY_CHANNEL) as Promise<OpenRepositoryResult>,
    openRepositoryDocument: (request) =>
      invoke(OPEN_REPOSITORY_DOCUMENT_CHANNEL, request) as Promise<OpenRepositoryDocumentResult>,
    useRepositoryShelf: (request) =>
      invoke(USE_REPOSITORY_SHELF_CHANNEL, request) as Promise<UseRepositoryShelfResult>,
    discoverPrivateWorks: () =>
      invoke(DISCOVER_PRIVATE_WORKS_CHANNEL) as Promise<RepositoryCloudDiscoveryIpcResult>,
    cancelPrivateWorksDiscovery: () =>
      invoke(CANCEL_PRIVATE_WORKS_DISCOVERY_CHANNEL) as Promise<RepositoryCloudDiscoveryCancelResult>,
    onDevicePrompt: (callback) => {
      if (typeof callback !== "function") throw new TypeError("The Device Flow prompt callback is invalid.");
      return subscribe(GITHUB_DEVICE_PROMPT_CHANNEL, (value) => {
        const prompt = normalizeDevicePrompt(value);
        if (prompt === undefined) return;
        try {
          callback(prompt);
        } catch {
          // Renderer callback failures must not affect the fixed IPC listener.
        }
      });
    },
  };
}
