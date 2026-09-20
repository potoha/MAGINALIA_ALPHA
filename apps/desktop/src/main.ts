import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  type WebContents
} from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { DocumentWorkspaceService } from "./document-workspace";
import {
  createDocumentWorkspaceHandlers,
  OPEN_DOCUMENT_CHANNEL,
  OPEN_MANUSCRIPT_CHANNEL
} from "./document-workspace-ipc";
import { MarkdownFileService } from "./markdown-file-service";
import {
  CREATE_PROJECT_CHANNEL,
  CREATE_PROJECT_FILE_CHANNEL,
  OPEN_PROJECT_CHANNEL,
  OPEN_PROJECT_FILE_CHANNEL,
  RESTORE_PROJECT_CHANNEL,
  createProjectHandlers
} from "./project-ipc";
import { FileProjectPathStore, ProjectService } from "./project-service";
import {
  OPEN_LIBRARY_CHANNEL,
  OPEN_MARKDOWN_CHANNEL,
  RESOLVE_QUOTATION_FOR_INSERT_CHANNEL,
  RESOLVE_REFERENCES_CHANNEL,
  SAVE_MARKDOWN_CHANNEL,
  SEARCH_LIBRARY_CHANNEL,
  SEARCH_SHELF_CHANNEL
} from "./preload-api";
import {
  isSaveMarkdownRequest,
  type MarkdownFailure,
  type OpenMarkdownResult,
  type SaveMarkdownResult
} from "./markdown-ipc";
import { LibraryService } from "./library-service";
import { createLibraryHandlers } from "./library-ipc";
import { createReviewerHandlers, createReviewerSearchAdapter } from "./reviewer-ipc";
import { createReferenceHandlers } from "./reference-ipc";
import { createReviewerResolutionAdapter } from "./reviewer-resolution";
import {
  RESOLVE_EXPORT_CHANNEL,
  WRITE_EXPORT_CHANNEL,
  createExportHandlers
} from "./export-ipc";
import {
  INVOKE_MOD_COMMAND_CHANNEL,
  LOAD_MODS_CHANNEL,
  MOD_CAPABILITY_REQUEST_CHANNEL,
  OPEN_MODS_FOLDER_CHANNEL,
  RELOAD_MODS_CHANNEL,
  RESPOND_MOD_CAPABILITY_CHANNEL,
  isModCapabilityResponseRequest,
  isModCommandRequest,
  type ModCapabilityResponse,
  type ModCapabilityResponseRequest
} from "./mod-ipc";
import { ModHost } from "./mod-host";
import {
  CREATE_REPOSITORY_CHANNEL,
  CREATE_REPOSITORY_HISTORY_CHANNEL,
  LIST_REPOSITORY_HISTORY_CHANNEL,
  OPEN_REPOSITORY_CHANNEL,
  OPEN_REPOSITORY_HISTORY_CHANNEL,
  OPEN_REPOSITORY_DOCUMENT_CHANNEL,
  USE_REPOSITORY_SHELF_CHANNEL,
  createRepositoryHandlers
} from "./repository-ipc";
import { LocalRepositoryService } from "./repository-service";
import { createSecureWebPreferences } from "./security";
import {
  parseQuotationSmokeMode,
  parseD5SmokeMode,
  parseExportSmokeMode,
  parseProjectSmokeMode,
  parseRepositorySmokeMode,
  parseShelfSmokeMode,
  parseWritingSmokeMode,
  parseWorkspaceSmokeMode
} from "./smoke-mode";
import { runQuotationSmoke } from "./quotation-smoke";
import { runProjectCreateSmoke, runProjectRestoreSmoke, runProjectSmoke } from "./project-smoke";
import { runRepositorySmoke } from "./repository-smoke";
import { runShelfSmoke } from "./shelf-smoke";
import { runWorkspaceSmoke } from "./workspace-smoke";
import { runWritingSmoke } from "./writing-smoke";
import { runD5Smoke, runD5RestoreSmoke } from "./d5-smoke";
import { runExportSmoke } from "./export-smoke";
import {
  LOAD_WORKSPACE_STATE_CHANNEL,
  SAVE_WORKSPACE_STATE_CHANNEL,
  createWorkspaceStateHandlers
} from "./workspace-state-ipc";
import { FileWorkspaceStateStore } from "./workspace-state-service";
import {
  createRepositoryCloudDiscoveryCancellationHandlers,
  createRepositoryCloudDiscoveryHandlers,
  CANCEL_PRIVATE_WORKS_DISCOVERY_CHANNEL,
  DISCOVER_PRIVATE_WORKS_CHANNEL,
  GITHUB_DEVICE_PROMPT_CHANNEL,
  GITHUB_DEVICE_VERIFICATION_URI,
  type CloudDiscoveryOperation
} from "./repository-cloud-ipc";
import { discoverAuthenticatedRestoreRepositories } from "./repository-cloud-discover-operation";
import { RepositoryCloudCoordinator } from "./repository-cloud-coordinator";
import type { GitHubDeviceVerificationCallback, GitHubDeviceVerificationPrompt } from "./repository-github-auth";

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  // Do not construct services, register IPC, or touch app state in a second
  // process. The first process remains the sole owner of the app data root.
  app.quit();
} else {
const quickSmokeMode = process.argv.includes("--smoke");
const writingSmoke = parseWritingSmokeMode(process.argv);
const workspaceSmoke = parseWorkspaceSmokeMode(process.argv);
const quotationSmoke = parseQuotationSmokeMode(process.argv);
const projectSmoke = parseProjectSmokeMode(process.argv);
const repositorySmoke = parseRepositorySmokeMode(process.argv);
const shelfSmoke = parseShelfSmokeMode(process.argv);
const d5Smoke = parseD5SmokeMode(process.argv);
const exportSmoke = parseExportSmokeMode(process.argv);
const smokeMode = quickSmokeMode
  || writingSmoke.requested
  || workspaceSmoke.requested
  || quotationSmoke.requested
  || projectSmoke.requested
  || repositorySmoke.requested
  || shelfSmoke.requested
  || d5Smoke.requested
  || exportSmoke.requested;
const markdownFileService = new MarkdownFileService();
const workspaceStateStore = new FileWorkspaceStateStore(path.join(app.getPath("userData"), "workspace-state.json"));
const workspaceStateHandlers = createWorkspaceStateHandlers({
  load: () => workspaceStateStore.load(),
  save: (state) => workspaceStateStore.save(state)
});
const documentWorkspaceService = new DocumentWorkspaceService();
const projectService = new ProjectService(
  documentWorkspaceService,
  markdownFileService,
  new FileProjectPathStore(path.join(app.getPath("userData"), "last-project.json"))
);
const libraryService = new LibraryService();
const repositoryService = new LocalRepositoryService();
let quotationResolveCount = 0;

const REPOSITORY_SMOKE_BOOK_ID = "isbn:9781234567890";
const REPOSITORY_SMOKE_ANNOTATION_ID = "ann:01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REPOSITORY_SMOKE_PRIVATE_MEMO = "REPOSITORY_SMOKE_PRIVATE_MEMO_SENTINEL";
const REPOSITORY_SMOKE_RAW_OCR = "REPOSITORY_SMOKE_PRIVATE_RAW_OCR_SENTINEL";
const REPOSITORY_SMOKE_LOCAL_PATH = "REPOSITORY_SMOKE_PRIVATE_PATH_SENTINEL";

async function seedRepositorySmokeShelf(owner: object, repositoryId: string): Promise<void> {
  const resolved = await repositoryService.resolveForOwner(owner, repositoryId);
  if (resolved.kind === "error") throw new Error(resolved.message);
  await mkdir(path.join(resolved.canonicalRoot, "books"), { recursive: true });
  await mkdir(path.join(resolved.canonicalRoot, "annotations"), { recursive: true });
  await writeFile(
    path.join(resolved.canonicalRoot, "books", "smoke-book.json"),
    JSON.stringify({
      type: "book",
      version: "0.1",
      id: REPOSITORY_SMOKE_BOOK_ID,
      title: "Repository Smoke Book",
      authors: ["Repository Smoke Author"],
      isbn13: "9781234567890",
    }) + "\n",
    "utf8",
  );
  await writeFile(
    path.join(resolved.canonicalRoot, "annotations", "smoke-annotation.json"),
    JSON.stringify({
      type: "annotation",
      version: "0.1",
      id: REPOSITORY_SMOKE_ANNOTATION_ID,
      source: REPOSITORY_SMOKE_BOOK_ID,
      location: { page: 17, path: "pages/p17" },
      quote: "Repository smoke quotation",
      privateMemo: REPOSITORY_SMOKE_PRIVATE_MEMO,
      rawOcr: REPOSITORY_SMOKE_RAW_OCR,
      localPath: REPOSITORY_SMOKE_LOCAL_PATH,
    }) + "\n",
    "utf8",
  );
}
const documentWorkspaceHandlers = createDocumentWorkspaceHandlers({
  pickDocumentFolder: async () => {
    if (workspaceSmoke.requested || quotationSmoke.requested || shelfSmoke.requested || d5Smoke.requested) {
      const rootPath = workspaceSmoke.requested
        ? workspaceSmoke.rootPath
        : quotationSmoke.requested
          ? quotationSmoke.documentRoot
          : shelfSmoke.requested
            ? shelfSmoke.rootPath
            : d5Smoke.rootPath;
      return {
        canceled: false,
        filePaths: rootPath ? [rootPath] : []
      };
    }
    return dialog.showOpenDialog({
      title: "Open Document",
      properties: ["openDirectory"]
    });
  },
  openDocumentRoot: (owner, rootPath) => documentWorkspaceService.openForOwner(owner, rootPath),
  resolveManuscriptPath: (owner, documentId, manuscriptId) =>
    documentWorkspaceService.resolveManuscriptPath(owner, documentId, manuscriptId),
  openMarkdown: (owner, filePath) => markdownFileService.openForOwner(owner, filePath)
});
const projectHandlers = createProjectHandlers({
  pickProjectFolder: () => ((projectSmoke.requested && !projectSmoke.restore)
      || shelfSmoke.requested
      || (d5Smoke.requested && !d5Smoke.restore)
      || exportSmoke.requested)
    ? Promise.resolve({
      canceled: false,
      filePaths: projectSmoke.requested && !projectSmoke.restore
        ? projectSmoke.rootPath ? [projectSmoke.rootPath] : []
        : shelfSmoke.requested
          ? shelfSmoke.rootPath ? [shelfSmoke.rootPath] : []
          : d5Smoke.requested
            ? d5Smoke.rootPath ? [d5Smoke.rootPath] : []
            : exportSmoke.rootPath ? [exportSmoke.rootPath] : []
    })
    : dialog.showOpenDialog({
      title: "Open Project",
      properties: ["openDirectory"]
    }),
  pickProjectParent: () => projectSmoke.requested && projectSmoke.create
    ? Promise.resolve({ canceled: false, filePaths: projectSmoke.rootPath ? [projectSmoke.rootPath] : [] })
    : dialog.showOpenDialog({
      title: "Choose a folder for the new Project",
      properties: ["openDirectory"]
    }),
  openProjectRoot: (owner, rootPath) => projectService.openForOwner(owner, rootPath),
  createProject: (owner, parentPath, title) => projectService.createForOwner(owner, parentPath, title),
  restoreProject: (owner) => projectService.restoreForOwner(owner),
  openProjectFile: (owner, projectId, fileId) => projectService.openFileForOwner(owner, projectId, fileId),
  createProjectFile: (owner, request) => projectService.createFileForOwner(
    owner,
    request.projectId,
    request.fileName,
    request.title,
    request.documentType
  )
});
const libraryHandlers = createLibraryHandlers({
  pickLibraryFolder: () => quotationSmoke.requested
    ? Promise.resolve({
      canceled: false,
      filePaths: quotationSmoke.libraryRoot ? [quotationSmoke.libraryRoot] : []
    })
    : dialog.showOpenDialog({
      title: "Choose Library",
      properties: ["openDirectory"]
    }),
  openLibraryRoot: (owner, rootPath) => libraryService.openForOwner(owner, rootPath),
  searchLibrary: (owner, libraryId, query) => libraryService.searchForOwner(owner, libraryId, query),
  resolveQuotationForInsert: (owner, libraryId, annotationId) => {
    if (quotationSmoke.requested) quotationResolveCount += 1;
    return libraryService.resolveQuotationForInsertForOwner(owner, libraryId, annotationId);
  }
});
const reviewerSearch = createReviewerSearchAdapter({
  // This value is main-process configuration. The renderer can provide only
  // the search string and can never select a destination URL or DB path.
  baseUrl: process.env.MAGINALIA_REVIEWER_BASE_URL
});
const reviewerHandlers = createReviewerHandlers({ search: reviewerSearch });
const referenceResolution = createReviewerResolutionAdapter({
  // This value is main-process configuration. The renderer supplies document
  // text only and cannot select a URL, port, or Reviewer database path.
  baseUrl: process.env.MAGINALIA_REVIEWER_BASE_URL
});
const referenceHandlers = createReferenceHandlers({ resolve: referenceResolution });
let exportDialogSequence = 0;
const exportHandlers = createExportHandlers({
  sessions: markdownFileService,
  resolve: referenceResolution,
  showSaveDialog: (defaultPath, event) => {
    if (exportSmoke.requested && exportSmoke.rootPath) {
      exportDialogSequence += 1;
      return Promise.resolve({
        canceled: false,
        filePath: path.join(exportSmoke.rootPath, `export-${exportDialogSequence}.resolved.md`)
      });
    }
    const ownerWindow = BrowserWindow.fromWebContents(event.sender as WebContents);
    const options = {
      title: "Export Markdown",
      defaultPath,
      filters: [{ name: "Markdown", extensions: ["md"] }]
    };
    return ownerWindow === null
      ? dialog.showSaveDialog(options)
      : dialog.showSaveDialog(ownerWindow, options);
  }
});
const repositoryHandlers = createRepositoryHandlers({
  pickParentFolder: () => repositorySmoke.requested
    ? Promise.resolve({
      canceled: false,
      filePaths: repositorySmoke.rootPath
        ? [path.join(repositorySmoke.rootPath, "repository-parent")]
        : []
    })
    : dialog.showOpenDialog({
      title: "Create Repository",
      properties: ["openDirectory"]
    }),
  pickRepositoryFolder: () => repositorySmoke.requested
    ? Promise.resolve({ canceled: true, filePaths: [] })
    : dialog.showOpenDialog({
      title: "Open Repository",
      properties: ["openDirectory"]
    }),
  createRepository: async (owner, parentRoot, kind, title) => {
    const result = await repositoryService.createForOwner(owner, parentRoot, kind, title);
    if (repositorySmoke.requested && kind === "shelf" && result.kind === "opened") {
      await seedRepositorySmokeShelf(owner, result.repository.repositoryId);
    }
    return result;
  },
  openRepository: (owner, root) => repositoryService.openForOwner(owner, root),
  resolveRepository: (owner, repositoryId) => repositoryService.resolveForOwner(owner, repositoryId),
  createHistory: (owner, repositoryId) => repositoryService.createHistoryForOwner(owner, repositoryId),
  listHistory: (owner, repositoryId) => repositoryService.listHistoryForOwner(owner, repositoryId),
  pickHistoryDestinationParent: () => repositorySmoke.requested
    ? Promise.resolve({
      canceled: false,
      filePaths: repositorySmoke.rootPath
        ? [path.join(repositorySmoke.rootPath, "history-destination")]
        : []
    })
    : dialog.showOpenDialog({
      title: "Open History Copy",
      properties: ["openDirectory"]
    }),
  openHistoryCopy: (owner, repositoryId, historyId, destinationParentRoot) => {
    return repositoryService.openHistoryCopyForOwner(owner, repositoryId, historyId, destinationParentRoot);
  },
  openDocument: (owner, root) => documentWorkspaceService.openForOwner(owner, root),
  openLibrary: (owner, root) => libraryService.openForOwner(owner, root)
});
const INVALID_REQUEST: MarkdownFailure = {
  kind: "error",
  code: "invalid-request",
  message: "The Markdown save request was invalid."
};
let mainWindow: BrowserWindow | null = null;
type PendingModCapability = {
  readonly modId: string;
  readonly resolve: (response: ModCapabilityResponse) => void;
  readonly timer: NodeJS.Timeout;
};

const pendingModCapabilities = new Map<string, PendingModCapability>();
let modCapabilitySequence = 0;

function resolveModCapability(requestId: string, response: ModCapabilityResponse): boolean {
  const pending = pendingModCapabilities.get(requestId);
  if (pending === undefined) return false;
  pendingModCapabilities.delete(requestId);
  clearTimeout(pending.timer);
  pending.resolve(response);
  return true;
}

function requestRendererModCapability(
  modId: string,
  request: { readonly kind: "open-document-view" | "close-view" | "get-active-document"; readonly requestId: string; readonly value: unknown }
): Promise<ModCapabilityResponse> {
  const window = mainWindow;
  if (window === null || window.isDestroyed()) {
    return Promise.resolve({ kind: "error", message: "The editor window is unavailable." });
  }
  const requestId = `renderer-${Date.now()}-${modCapabilitySequence++}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingModCapabilities.delete(requestId);
      resolve({ kind: "error", message: "The Mod capability request timed out." });
    }, 5_000);
    pendingModCapabilities.set(requestId, { modId, resolve, timer });
    try {
      window.webContents.send(MOD_CAPABILITY_REQUEST_CHANNEL, {
        modId,
        kind: request.kind,
        requestId,
        value: request.value
      });
    } catch {
      clearTimeout(timer);
      pendingModCapabilities.delete(requestId);
      resolve({ kind: "error", message: "The editor window is unavailable." });
    }
  });
}

const modHost = new ModHost({
  userDataPath: app.getPath("userData"),
  onCapabilityRequest: (modId, request) => requestRendererModCapability(modId, request),
  onError: (message, error) => console.error(
    `MAGINALIA_MOD_ERROR ${message}${error instanceof Error ? ` ${error.message}` : error === undefined ? "" : ` ${JSON.stringify(error)}`}`
  )
});
// The renderer may request the initial snapshot as soon as its preload is
// ready. Keep that request behind the one startup discovery pass so a valid
// first-party Mod cannot appear to be missing merely because utility-process
// activation is still in flight.
let modHostReady: Promise<unknown> | undefined;

let writingSmokeFinished = false;
let workspaceSmokeFinished = false;
let projectSmokeFinished = false;
let quotationSmokeFinished = false;
let repositorySmokeFinished = false;
let shelfSmokeFinished = false;
let d5SmokeFinished = false;
let exportSmokeFinished = false;

const CLOUD_USER_CODE_PATTERN = /^[A-Za-z0-9-]+$/u;
const MAX_CLOUD_USER_CODE_LENGTH = 64;

function isLiveMainWindowSender(owner: object): owner is WebContents {
  const window = mainWindow;
  if (window === null || window.isDestroyed()) return false;
  const sender = window.webContents;
  return sender === owner && !sender.isDestroyed();
}

function isDeviceVerificationPrompt(value: unknown): value is GitHubDeviceVerificationPrompt {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2
      || !keys.every((key) => key === "userCode" || key === "verificationUri")) {
      return false;
    }
    const userCodeDescriptor = Object.getOwnPropertyDescriptor(value, "userCode");
    const verificationUriDescriptor = Object.getOwnPropertyDescriptor(value, "verificationUri");
    if (userCodeDescriptor === undefined
      || !("value" in userCodeDescriptor)
      || verificationUriDescriptor === undefined
      || !("value" in verificationUriDescriptor)) {
      return false;
    }
    const userCode = userCodeDescriptor.value;
    return typeof userCode === "string"
      && userCode.length > 0
      && userCode.length <= MAX_CLOUD_USER_CODE_LENGTH
      && CLOUD_USER_CODE_PATTERN.test(userCode)
      && verificationUriDescriptor.value === GITHUB_DEVICE_VERIFICATION_URI;
  } catch {
    return false;
  }
}

function createCloudVerificationCallback(owner: object): GitHubDeviceVerificationCallback {
  if (!isLiveMainWindowSender(owner)) throw new Error("The cloud discovery owner is not active.");
  const sender = owner;
  return (prompt) => {
    if (!isLiveMainWindowSender(sender) || !isDeviceVerificationPrompt(prompt)) {
      throw new Error("The cloud verification prompt could not be delivered.");
    }
    sender.send(GITHUB_DEVICE_PROMPT_CHANNEL, {
      userCode: prompt.userCode,
      verificationUri: GITHUB_DEVICE_VERIFICATION_URI,
    });
  };
}

const cloudCoordinator = new RepositoryCloudCoordinator({
  isLiveOwner: isLiveMainWindowSender,
  registerOwnerLifecycle: (owner, onClose) => {
    const sender = owner as WebContents;
    sender.once("destroyed", onClose);
    return () => sender.removeListener("destroyed", onClose);
  },
  discover: (request) => discoverAuthenticatedRestoreRepositories(request),
});

const cloudDiscoveryOperation: CloudDiscoveryOperation = (owner, onVerification) =>
  cloudCoordinator.discoverForOwner(owner, onVerification);

const cloudDiscoveryHandlers = createRepositoryCloudDiscoveryHandlers({
  discover: cloudDiscoveryOperation,
  createVerificationCallback: createCloudVerificationCallback,
  catalog: cloudCoordinator.catalog,
});

const cloudCancellationHandlers = createRepositoryCloudDiscoveryCancellationHandlers({
  isCurrentOwner: (owner) => cloudCoordinator.isCurrentOwner(owner),
  cancelForOwner: (owner) => cloudCoordinator.cancelForOwner(owner),
});

app.on("second-instance", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

function failWritingSmoke(error: unknown): void {
  if (writingSmokeFinished) return;
  writingSmokeFinished = true;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`MAGINALIA_ELECTRON_WRITING_SMOKE_FAILED ${message}`);
  app.exit(1);
}

function completeWritingSmoke(): void {
  if (writingSmokeFinished) return;
  writingSmokeFinished = true;
  console.log("MAGINALIA_ELECTRON_WRITING_SMOKE_OK");
  app.quit();
}

function failWorkspaceSmoke(error: unknown): void {
  if (workspaceSmokeFinished) return;
  workspaceSmokeFinished = true;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`MAGINALIA_ELECTRON_WORKSPACE_SMOKE_FAILED ${message}`);
  app.exit(1);
}

function completeWorkspaceSmoke(): void {
  if (workspaceSmokeFinished) return;
  workspaceSmokeFinished = true;
  console.log("MAGINALIA_ELECTRON_WORKSPACE_SMOKE_OK");
  app.quit();
}

function failProjectSmoke(error: unknown): void {
  if (projectSmokeFinished) return;
  projectSmokeFinished = true;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`MAGINALIA_ELECTRON_PROJECT_SMOKE_FAILED ${message}`);
  app.exit(1);
}

function completeProjectSmoke(): void {
  if (projectSmokeFinished) return;
  projectSmokeFinished = true;
  console.log("MAGINALIA_ELECTRON_PROJECT_SMOKE_OK");
  app.quit();
}

function failQuotationSmoke(error: unknown): void {
  if (quotationSmokeFinished) return;
  quotationSmokeFinished = true;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`MAGINALIA_ELECTRON_QUOTATION_SMOKE_FAILED ${message}`);
  app.exit(1);
}

function completeQuotationSmoke(): void {
  if (quotationSmokeFinished) return;
  quotationSmokeFinished = true;
  console.log("MAGINALIA_ELECTRON_QUOTATION_SMOKE_OK");
  app.quit();
}

function failRepositorySmoke(error: unknown): void {
  if (repositorySmokeFinished) return;
  repositorySmokeFinished = true;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`MAGINALIA_ELECTRON_REPOSITORY_SMOKE_FAILED ${message}`);
  app.exit(1);
}

function completeRepositorySmoke(): void {
  if (repositorySmokeFinished) return;
  repositorySmokeFinished = true;
  console.log("MAGINALIA_ELECTRON_REPOSITORY_SMOKE_OK");
  app.quit();
}

function failShelfSmoke(error: unknown): void {
  if (shelfSmokeFinished) return;
  shelfSmokeFinished = true;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`MAGINALIA_ELECTRON_SHELF_SMOKE_FAILED ${message}`);
  app.exit(1);
}

function completeShelfSmoke(): void {
  if (shelfSmokeFinished) return;
  shelfSmokeFinished = true;
  console.log("MAGINALIA_ELECTRON_SHELF_SMOKE_OK");
  app.quit();
}

function failD5Smoke(error: unknown): void {
  if (d5SmokeFinished) return;
  d5SmokeFinished = true;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`MAGINALIA_ELECTRON_D5_SMOKE_FAILED ${message}`);
  app.exit(1);
}

function completeD5Smoke(): void {
  if (d5SmokeFinished) return;
  d5SmokeFinished = true;
  console.log("MAGINALIA_ELECTRON_D5_SMOKE_OK");
  app.quit();
}

function failExportSmoke(error: unknown): void {
  if (exportSmokeFinished) return;
  exportSmokeFinished = true;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`MAGINALIA_ELECTRON_EXPORT_SMOKE_FAILED ${message}`);
  app.exit(1);
}

function completeExportSmoke(): void {
  if (exportSmokeFinished) return;
  exportSmokeFinished = true;
  console.log("MAGINALIA_ELECTRON_EXPORT_SMOKE_OK");
  app.quit();
}

async function handleOpenMarkdown(event: IpcMainInvokeEvent): Promise<OpenMarkdownResult> {
  if (writingSmoke.requested) {
    if (!writingSmoke.filePath) {
      return {
        kind: "error",
        code: "invalid-request",
        message: "The writing smoke fixture path was not provided."
      };
    }
    return markdownFileService.openForOwner(event.sender, writingSmoke.filePath);
  }

  const selection = await dialog.showOpenDialog({
    title: "Open Markdown",
    properties: ["openFile"],
    filters: [{ name: "Markdown", extensions: ["md", "markdown"] }]
  });
  if (selection.canceled || selection.filePaths.length === 0) return { kind: "cancelled" };
  return markdownFileService.openForOwner(event.sender, selection.filePaths[0]);
}

function handleSaveMarkdown(event: IpcMainInvokeEvent, value: unknown): Promise<SaveMarkdownResult> {
  if (!isSaveMarkdownRequest(value)) return Promise.resolve(INVALID_REQUEST);
  return markdownFileService.saveForOwner(event.sender, value);
}

async function handleLoadMods(event: IpcMainInvokeEvent, ...args: readonly unknown[]) {
  if (args.length !== 0 || !isLiveMainWindowSender(event.sender)) {
    return modHost.snapshot();
  }
  await modHostReady;
  return modHost.snapshot();
}

async function handleReloadMods(event: IpcMainInvokeEvent, ...args: readonly unknown[]) {
  if (args.length !== 0 || !isLiveMainWindowSender(event.sender)) {
    return modHost.snapshot();
  }
  await modHostReady;
  return modHost.reload();
}

async function handleOpenModsFolder(event: IpcMainInvokeEvent, ...args: readonly unknown[]) {
  if (args.length !== 0 || !isLiveMainWindowSender(event.sender)) {
    return { kind: "error" as const, message: "The Mods request was invalid." };
  }
  try {
    await modHost.openModsFolder();
    return { kind: "opened" as const };
  } catch {
    return { kind: "error" as const, message: "The Mods folder could not be opened." };
  }
}

async function handleInvokeModCommand(event: IpcMainInvokeEvent, value: unknown, ...args: readonly unknown[]) {
  if (args.length !== 0 || !isLiveMainWindowSender(event.sender) || !isModCommandRequest(value)) {
    return { kind: "error" as const, code: "invalid-request" as const, message: "The Mod request was invalid." };
  }
  try {
    const result = await modHost.invokeCommand(value.modId, value.commandId, value.args);
    return { kind: "result" as const, value: result };
  } catch {
    return { kind: "error" as const, code: "mod-unavailable" as const, message: "The Mod command is unavailable." };
  }
}

async function handleRespondModCapability(
  event: IpcMainInvokeEvent,
  value: unknown,
  ...args: readonly unknown[]
) {
  if (args.length !== 0
    || !isLiveMainWindowSender(event.sender)
    || !isModCapabilityResponseRequest(value)) {
    return { kind: "error" as const, message: "The Mod capability response was invalid." };
  }
  const accepted = resolveModCapability(value.requestId, value.response);
  return accepted
    ? { kind: "accepted" as const }
    : { kind: "error" as const, message: "The Mod capability request is no longer pending." };
}

function registerMarkdownIpc(): void {
  ipcMain.handle(OPEN_MARKDOWN_CHANNEL, handleOpenMarkdown);
  ipcMain.handle(SAVE_MARKDOWN_CHANNEL, handleSaveMarkdown);
  ipcMain.handle(OPEN_DOCUMENT_CHANNEL, documentWorkspaceHandlers.openDocument);
  ipcMain.handle(OPEN_MANUSCRIPT_CHANNEL, documentWorkspaceHandlers.openManuscript);
  ipcMain.handle(OPEN_PROJECT_CHANNEL, projectHandlers.openProject);
  ipcMain.handle(CREATE_PROJECT_CHANNEL, projectHandlers.createProject);
  ipcMain.handle(RESTORE_PROJECT_CHANNEL, projectHandlers.restoreProject);
  ipcMain.handle(OPEN_PROJECT_FILE_CHANNEL, projectHandlers.openProjectFile);
  ipcMain.handle(CREATE_PROJECT_FILE_CHANNEL, projectHandlers.createProjectFile);
  ipcMain.handle(OPEN_LIBRARY_CHANNEL, libraryHandlers.openLibrary);
  ipcMain.handle(SEARCH_LIBRARY_CHANNEL, libraryHandlers.searchLibrary);
  ipcMain.handle(RESOLVE_QUOTATION_FOR_INSERT_CHANNEL, libraryHandlers.resolveQuotationForInsert);
  ipcMain.handle(SEARCH_SHELF_CHANNEL, reviewerHandlers.searchShelf);
  ipcMain.handle(RESOLVE_REFERENCES_CHANNEL, referenceHandlers.resolveReferences);
  ipcMain.handle(RESOLVE_EXPORT_CHANNEL, exportHandlers.resolveExport);
  ipcMain.handle(WRITE_EXPORT_CHANNEL, exportHandlers.writeExport);
  ipcMain.handle(LOAD_MODS_CHANNEL, handleLoadMods);
  ipcMain.handle(RELOAD_MODS_CHANNEL, handleReloadMods);
  ipcMain.handle(OPEN_MODS_FOLDER_CHANNEL, handleOpenModsFolder);
  ipcMain.handle(INVOKE_MOD_COMMAND_CHANNEL, handleInvokeModCommand);
  ipcMain.handle(RESPOND_MOD_CAPABILITY_CHANNEL, handleRespondModCapability);
  ipcMain.handle(LOAD_WORKSPACE_STATE_CHANNEL, workspaceStateHandlers.loadWorkspaceState);
  ipcMain.handle(SAVE_WORKSPACE_STATE_CHANNEL, workspaceStateHandlers.saveWorkspaceState);
  ipcMain.handle(CREATE_REPOSITORY_CHANNEL, repositoryHandlers.createRepository);
  ipcMain.handle(CREATE_REPOSITORY_HISTORY_CHANNEL, repositoryHandlers.createRepositoryHistory);
  ipcMain.handle(LIST_REPOSITORY_HISTORY_CHANNEL, repositoryHandlers.listRepositoryHistory);
  ipcMain.handle(OPEN_REPOSITORY_CHANNEL, repositoryHandlers.openRepository);
  ipcMain.handle(OPEN_REPOSITORY_HISTORY_CHANNEL, repositoryHandlers.openRepositoryHistory);
  ipcMain.handle(OPEN_REPOSITORY_DOCUMENT_CHANNEL, repositoryHandlers.openRepositoryDocument);
  ipcMain.handle(USE_REPOSITORY_SHELF_CHANNEL, repositoryHandlers.useRepositoryShelf);
  ipcMain.handle(DISCOVER_PRIVATE_WORKS_CHANNEL, (event, ...args) =>
    cloudDiscoveryHandlers.discoverPrivateWorks(event, ...args));
  ipcMain.handle(CANCEL_PRIVATE_WORKS_DISCOVERY_CHANNEL, (event, ...args) =>
    cloudCancellationHandlers.cancelPrivateWorksDiscovery(event, ...args));
}

function unregisterMarkdownIpc(): void {
  ipcMain.removeHandler(OPEN_MARKDOWN_CHANNEL);
  ipcMain.removeHandler(SAVE_MARKDOWN_CHANNEL);
  ipcMain.removeHandler(OPEN_DOCUMENT_CHANNEL);
  ipcMain.removeHandler(OPEN_MANUSCRIPT_CHANNEL);
  ipcMain.removeHandler(OPEN_PROJECT_CHANNEL);
  ipcMain.removeHandler(CREATE_PROJECT_CHANNEL);
  ipcMain.removeHandler(RESTORE_PROJECT_CHANNEL);
  ipcMain.removeHandler(OPEN_PROJECT_FILE_CHANNEL);
  ipcMain.removeHandler(CREATE_PROJECT_FILE_CHANNEL);
  ipcMain.removeHandler(OPEN_LIBRARY_CHANNEL);
  ipcMain.removeHandler(SEARCH_LIBRARY_CHANNEL);
  ipcMain.removeHandler(RESOLVE_QUOTATION_FOR_INSERT_CHANNEL);
  ipcMain.removeHandler(SEARCH_SHELF_CHANNEL);
  ipcMain.removeHandler(RESOLVE_REFERENCES_CHANNEL);
  ipcMain.removeHandler(RESOLVE_EXPORT_CHANNEL);
  ipcMain.removeHandler(WRITE_EXPORT_CHANNEL);
  ipcMain.removeHandler(LOAD_MODS_CHANNEL);
  ipcMain.removeHandler(RELOAD_MODS_CHANNEL);
  ipcMain.removeHandler(OPEN_MODS_FOLDER_CHANNEL);
  ipcMain.removeHandler(INVOKE_MOD_COMMAND_CHANNEL);
  ipcMain.removeHandler(RESPOND_MOD_CAPABILITY_CHANNEL);
  ipcMain.removeHandler(LOAD_WORKSPACE_STATE_CHANNEL);
  ipcMain.removeHandler(SAVE_WORKSPACE_STATE_CHANNEL);
  ipcMain.removeHandler(CREATE_REPOSITORY_CHANNEL);
  ipcMain.removeHandler(CREATE_REPOSITORY_HISTORY_CHANNEL);
  ipcMain.removeHandler(LIST_REPOSITORY_HISTORY_CHANNEL);
  ipcMain.removeHandler(OPEN_REPOSITORY_CHANNEL);
  ipcMain.removeHandler(OPEN_REPOSITORY_HISTORY_CHANNEL);
  ipcMain.removeHandler(OPEN_REPOSITORY_DOCUMENT_CHANNEL);
  ipcMain.removeHandler(USE_REPOSITORY_SHELF_CHANNEL);
  ipcMain.removeHandler(DISCOVER_PRIVATE_WORKS_CHANNEL);
  ipcMain.removeHandler(CANCEL_PRIVATE_WORKS_DISCOVERY_CHANNEL);
  cloudCoordinator.dispose();
  markdownFileService.dispose();
  documentWorkspaceService.dispose();
  libraryService.dispose();
  repositoryService.dispose();
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 960,
    height: 640,
    show: writingSmoke.requested
      || workspaceSmoke.requested
      || projectSmoke.requested
      || quotationSmoke.requested
      || repositorySmoke.requested
      || shelfSmoke.requested
      || d5Smoke.requested
      || exportSmoke.requested
      || !smokeMode,
    webPreferences: createSecureWebPreferences(path.join(__dirname, "preload.js"))
  });
  const cloudOwner = window.webContents;

  const rendererPath = path.join(__dirname, "..", "renderer", "index.html");

  if (writingSmoke.requested) {
    if (!writingSmoke.filePath) {
      failWritingSmoke(new Error("The writing smoke fixture path was not provided."));
    } else {
      window.webContents.once("did-finish-load", () => {
        void runWritingSmoke(window, writingSmoke.filePath!).then(
          () => completeWritingSmoke(),
          (error: unknown) => failWritingSmoke(error)
        );
      });
      window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
        if (isMainFrame) failWritingSmoke(new Error(`Renderer load failed (${errorCode}): ${errorDescription}`));
      });
      window.webContents.on("preload-error", (_event, preloadPath, error) => {
        failWritingSmoke(new Error(`Preload failed (${preloadPath}): ${error.message}`));
      });
      window.webContents.on("render-process-gone", (_event, details) => {
        failWritingSmoke(new Error(`Renderer process exited: ${details.reason}`));
      });
      window.webContents.on("unresponsive", () => {
        failWritingSmoke(new Error("Renderer became unresponsive."));
      });
      window.webContents.on("console-message", (event) => {
        if (event.level === "error") {
          failWritingSmoke(new Error(
            `Renderer console error at ${event.sourceId}:${event.lineNumber}: ${event.message}`
          ));
        }
      });
    }
  } else if (workspaceSmoke.requested) {
    if (!workspaceSmoke.rootPath) {
      failWorkspaceSmoke(new Error("The workspace smoke fixture root was not provided."));
    } else {
      window.webContents.once("did-finish-load", () => {
        void runWorkspaceSmoke(window, workspaceSmoke.rootPath!).then(
          () => completeWorkspaceSmoke(),
          (error: unknown) => failWorkspaceSmoke(error)
        );
      });
      window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
        if (isMainFrame) failWorkspaceSmoke(new Error(`Renderer load failed (${errorCode}): ${errorDescription}`));
      });
      window.webContents.on("preload-error", (_event, preloadPath, error) => {
        failWorkspaceSmoke(new Error(`Preload failed (${preloadPath}): ${error.message}`));
      });
      window.webContents.on("render-process-gone", (_event, details) => {
        failWorkspaceSmoke(new Error(`Renderer process exited: ${details.reason}`));
      });
      window.webContents.on("unresponsive", () => {
        failWorkspaceSmoke(new Error("Renderer became unresponsive."));
      });
      window.webContents.on("console-message", (event) => {
        if (event.level === "error") {
          failWorkspaceSmoke(new Error(
            `Renderer console error at ${event.sourceId}:${event.lineNumber}: ${event.message}`
          ));
        }
      });
    }
  } else if (projectSmoke.requested) {
    if (!projectSmoke.rootPath) {
      failProjectSmoke(new Error("The project smoke fixture root was not provided."));
    } else {
      window.webContents.once("did-finish-load", () => {
        const smoke = projectSmoke.restore
          ? runProjectRestoreSmoke(window, projectSmoke.rootPath!)
          : projectSmoke.create
            ? runProjectCreateSmoke(window, projectSmoke.rootPath!)
            : runProjectSmoke(window, projectSmoke.rootPath!);
        void smoke.then(
          () => completeProjectSmoke(),
          (error: unknown) => failProjectSmoke(error)
        );
      });
      window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
        if (isMainFrame) failProjectSmoke(new Error(`Renderer load failed (${errorCode}): ${errorDescription}`));
      });
      window.webContents.on("preload-error", (_event, preloadPath, error) => {
        failProjectSmoke(new Error(`Preload failed (${preloadPath}): ${error.message}`));
      });
      window.webContents.on("render-process-gone", (_event, details) => {
        failProjectSmoke(new Error(`Renderer process exited: ${details.reason}`));
      });
      window.webContents.on("unresponsive", () => {
        failProjectSmoke(new Error("Renderer became unresponsive."));
      });
      window.webContents.on("console-message", (event) => {
        if (event.level === "error") {
          failProjectSmoke(new Error(
            `Renderer console error at ${event.sourceId}:${event.lineNumber}: ${event.message}`
          ));
        }
      });
    }
  } else if (quotationSmoke.requested) {
    if (!quotationSmoke.documentRoot || !quotationSmoke.libraryRoot) {
      failQuotationSmoke(new Error("The quotation smoke fixture roots were not provided."));
    } else {
      window.webContents.once("did-finish-load", () => {
        void runQuotationSmoke(
          window,
          quotationSmoke.documentRoot!,
          quotationSmoke.libraryRoot!,
          () => quotationResolveCount
        ).then(
          () => completeQuotationSmoke(),
          (error: unknown) => failQuotationSmoke(error)
        );
      });
      window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
        if (isMainFrame) failQuotationSmoke(new Error(`Renderer load failed (${errorCode}): ${errorDescription}`));
      });
      window.webContents.on("preload-error", (_event, preloadPath, error) => {
        failQuotationSmoke(new Error(`Preload failed (${preloadPath}): ${error.message}`));
      });
      window.webContents.on("render-process-gone", (_event, details) => {
        failQuotationSmoke(new Error(`Renderer process exited: ${details.reason}`));
      });
      window.webContents.on("unresponsive", () => {
        failQuotationSmoke(new Error("Renderer became unresponsive."));
      });
      window.webContents.on("console-message", (event) => {
        if (event.level === "error") {
          failQuotationSmoke(new Error(
            `Renderer console error at ${event.sourceId}:${event.lineNumber}: ${event.message}`
          ));
        }
      });
    }
  } else if (repositorySmoke.requested) {
    if (!repositorySmoke.rootPath) {
      failRepositorySmoke(new Error("The repository smoke fixture root was not provided."));
    } else {
      const security = createSecureWebPreferences(path.join(__dirname, "preload.js"));
      if (!security.contextIsolation || security.nodeIntegration || !security.sandbox) {
        failRepositorySmoke(new Error("Repository smoke security preferences are not strict."));
      }
      window.webContents.once("did-finish-load", () => {
        void runRepositorySmoke(window, repositorySmoke.rootPath!).then(
          () => completeRepositorySmoke(),
          (error: unknown) => failRepositorySmoke(error)
        );
      });
      window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
        if (isMainFrame) failRepositorySmoke(new Error(`Renderer load failed (${errorCode}): ${errorDescription}`));
      });
      window.webContents.on("preload-error", (_event, preloadPath, error) => {
        failRepositorySmoke(new Error(`Preload failed (${preloadPath}): ${error.message}`));
      });
      window.webContents.on("render-process-gone", (_event, details) => {
        failRepositorySmoke(new Error(`Renderer process exited: ${details.reason}`));
      });
      window.webContents.on("unresponsive", () => {
        failRepositorySmoke(new Error("Renderer became unresponsive."));
      });
      window.webContents.on("console-message", (event) => {
        if (event.level === "error") {
          failRepositorySmoke(new Error(
            `Renderer console error at ${event.sourceId}:${event.lineNumber}: ${event.message}`
          ));
        }
      });
    }
  } else if (shelfSmoke.requested) {
    if (!shelfSmoke.rootPath) {
      failShelfSmoke(new Error("The Shelf smoke fixture root was not provided."));
    } else {
      window.webContents.once("did-finish-load", () => {
        void runShelfSmoke(window, shelfSmoke.rootPath!).then(
          () => completeShelfSmoke(),
          (error: unknown) => failShelfSmoke(error)
        );
      });
      window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
        if (isMainFrame) failShelfSmoke(new Error(`Renderer load failed (${errorCode}): ${errorDescription}`));
      });
      window.webContents.on("preload-error", (_event, preloadPath, error) => {
        failShelfSmoke(new Error(`Preload failed (${preloadPath}): ${error.message}`));
      });
      window.webContents.on("render-process-gone", (_event, details) => {
        failShelfSmoke(new Error(`Renderer process exited: ${details.reason}`));
      });
      window.webContents.on("unresponsive", () => {
        failShelfSmoke(new Error("Renderer became unresponsive."));
      });
      window.webContents.on("console-message", (event) => {
        if (event.level === "error") {
          failShelfSmoke(new Error(
            `Renderer console error at ${event.sourceId}:${event.lineNumber}: ${event.message}`
          ));
        }
      });
    }
  } else if (d5Smoke.requested) {
    if (!d5Smoke.rootPath) {
      failD5Smoke(new Error("The D.5 smoke fixture root was not provided."));
    } else {
      window.webContents.once("did-finish-load", () => {
        const smoke = d5Smoke.restore
          ? runD5RestoreSmoke(window, d5Smoke.rootPath!, modHost.modsDirectory)
          : runD5Smoke(window, d5Smoke.rootPath!, modHost.modsDirectory);
        void smoke.then(
          () => completeD5Smoke(),
          (error: unknown) => failD5Smoke(error)
        );
      });
      window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
        if (isMainFrame) failD5Smoke(new Error(`Renderer load failed (${errorCode}): ${errorDescription}`));
      });
      window.webContents.on("preload-error", (_event, preloadPath, error) => {
        failD5Smoke(new Error(`Preload failed (${preloadPath}): ${error.message}`));
      });
      window.webContents.on("render-process-gone", (_event, details) => {
        failD5Smoke(new Error(`Renderer process exited: ${details.reason}`));
      });
      window.webContents.on("unresponsive", () => {
        failD5Smoke(new Error("Renderer became unresponsive."));
      });
      window.webContents.on("console-message", (event) => {
        if (event.level === "error") {
          failD5Smoke(new Error(
            `Renderer console error at ${event.sourceId}:${event.lineNumber}: ${event.message}`
          ));
        }
      });
    }
  } else if (exportSmoke.requested) {
    if (!exportSmoke.rootPath) {
      failExportSmoke(new Error("The Export smoke fixture root was not provided."));
    } else {
      window.webContents.once("did-finish-load", () => {
        void runExportSmoke(window, exportSmoke.rootPath!).then(
          () => completeExportSmoke(),
          (error: unknown) => failExportSmoke(error)
        );
      });
      window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
        if (isMainFrame) failExportSmoke(new Error(`Renderer load failed (${errorCode}): ${errorDescription}`));
      });
      window.webContents.on("preload-error", (_event, preloadPath, error) => {
        failExportSmoke(new Error(`Preload failed (${preloadPath}): ${error.message}`));
      });
      window.webContents.on("render-process-gone", (_event, details) => {
        failExportSmoke(new Error(`Renderer process exited: ${details.reason}`));
      });
      window.webContents.on("unresponsive", () => {
        failExportSmoke(new Error("Renderer became unresponsive."));
      });
      window.webContents.on("console-message", (event) => {
        if (event.level === "error") {
          failExportSmoke(new Error(
            `Renderer console error at ${event.sourceId}:${event.lineNumber}: ${event.message}`
          ));
        }
      });
    }
  } else if (quickSmokeMode) {
    window.webContents.once("did-finish-load", () => {
      console.log("MAGINALIA_ELECTRON_SMOKE_OK");
      app.quit();
    });
    window.webContents.once("did-fail-load", (_event, errorCode, errorDescription) => {
      console.error(`MAGINALIA_ELECTRON_SMOKE_FAILED ${errorCode}: ${errorDescription}`);
      app.exit(1);
    });
  }

  const loadOptions = writingSmoke.requested
    ? { query: { smoke: "writing" } }
    : workspaceSmoke.requested
      ? { query: { smoke: "workspace" } }
      : projectSmoke.requested
        ? { query: { smoke: projectSmoke.restore ? "project-restore" : projectSmoke.create ? "project-create" : "project" } }
      : quotationSmoke.requested
      ? { query: { smoke: "quotation" } }
        : repositorySmoke.requested
          ? { query: { smoke: "repository" } }
          : shelfSmoke.requested
            ? { query: { smoke: "shelf" } }
            : d5Smoke.requested
              ? { query: { smoke: d5Smoke.restore ? "d5-restore" : "d5" } }
              : exportSmoke.requested
                ? { query: { smoke: "export" } }
                : undefined;
  void window.loadFile(rendererPath, loadOptions).catch((error: unknown) => {
    console.error("MAGINALIA renderer failed to load", error);
    if (writingSmoke.requested) {
      failWritingSmoke(error);
    } else if (workspaceSmoke.requested) {
      failWorkspaceSmoke(error);
    } else if (projectSmoke.requested) {
      failProjectSmoke(error);
    } else if (quotationSmoke.requested) {
      failQuotationSmoke(error);
    } else if (repositorySmoke.requested) {
      failRepositorySmoke(error);
    } else if (shelfSmoke.requested) {
      failShelfSmoke(error);
    } else if (d5Smoke.requested) {
      failD5Smoke(error);
    } else if (exportSmoke.requested) {
      failExportSmoke(error);
    } else if (quickSmokeMode) {
      app.exit(1);
    }
  });

  window.on("closed", () => {
    cloudCoordinator.closeOwner(cloudOwner);
    if (writingSmoke.requested && !writingSmokeFinished) {
      failWritingSmoke(new Error("Writing smoke window closed before completion."));
    }
    if (workspaceSmoke.requested && !workspaceSmokeFinished) {
      failWorkspaceSmoke(new Error("Workspace smoke window closed before completion."));
    }
    if (projectSmoke.requested && !projectSmokeFinished) {
      failProjectSmoke(new Error("Project smoke window closed before completion."));
    }
    if (quotationSmoke.requested && !quotationSmokeFinished) {
      failQuotationSmoke(new Error("Quotation smoke window closed before completion."));
    }
    if (repositorySmoke.requested && !repositorySmokeFinished) {
      failRepositorySmoke(new Error("Repository smoke window closed before completion."));
    }
    if (shelfSmoke.requested && !shelfSmokeFinished) {
      failShelfSmoke(new Error("Shelf smoke window closed before completion."));
    }
    if (d5Smoke.requested && !d5SmokeFinished) {
      failD5Smoke(new Error("D.5 smoke window closed before completion."));
    }
    if (exportSmoke.requested && !exportSmokeFinished) {
      failExportSmoke(new Error("Export smoke window closed before completion."));
    }
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  return window;
}

function openMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return;
  }

  mainWindow = createMainWindow();
}

void app.whenReady().then(() => {
  registerMarkdownIpc();
  modHostReady = modHost.start().catch((error: unknown) => {
    console.error("MAGINALIA_MOD_START_FAILED", error);
    return modHost.snapshot();
  });
  openMainWindow();
  app.on("activate", openMainWindow);
});

app.on("will-quit", () => {
  void modHost.dispose();
  unregisterMarkdownIpc();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
}
