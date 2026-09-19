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
const smokeMode = quickSmokeMode
  || writingSmoke.requested
  || workspaceSmoke.requested
  || quotationSmoke.requested
  || projectSmoke.requested
  || repositorySmoke.requested
  || shelfSmoke.requested;
const markdownFileService = new MarkdownFileService();
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
    if (workspaceSmoke.requested || quotationSmoke.requested || shelfSmoke.requested) {
      const rootPath = workspaceSmoke.requested
        ? workspaceSmoke.rootPath
        : quotationSmoke.requested
          ? quotationSmoke.documentRoot
          : shelfSmoke.rootPath;
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
  pickProjectFolder: () => ((projectSmoke.requested && !projectSmoke.restore) || shelfSmoke.requested)
    ? Promise.resolve({
      canceled: false,
      filePaths: projectSmoke.requested && !projectSmoke.restore
        ? projectSmoke.rootPath ? [projectSmoke.rootPath] : []
        : shelfSmoke.rootPath ? [shelfSmoke.rootPath] : []
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
let writingSmokeFinished = false;
let workspaceSmokeFinished = false;
let projectSmokeFinished = false;
let quotationSmokeFinished = false;
let repositorySmokeFinished = false;
let shelfSmokeFinished = false;

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
  openMainWindow();
  app.on("activate", openMainWindow);
});

app.on("will-quit", unregisterMarkdownIpc);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
}
