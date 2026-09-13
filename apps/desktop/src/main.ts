import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import * as path from "node:path";
import { MarkdownFileService } from "./markdown-file-service";
import { OPEN_MARKDOWN_CHANNEL, SAVE_MARKDOWN_CHANNEL } from "./preload-api";
import {
  isSaveMarkdownRequest,
  type MarkdownFailure,
  type OpenMarkdownResult,
  type SaveMarkdownResult
} from "./markdown-ipc";
import { createSecureWebPreferences } from "./security";
import { parseWritingSmokeMode } from "./smoke-mode";
import { runWritingSmoke } from "./writing-smoke";

const quickSmokeMode = process.argv.includes("--smoke");
const writingSmoke = parseWritingSmokeMode(process.argv);
const smokeMode = quickSmokeMode || writingSmoke.requested;
const markdownFileService = new MarkdownFileService();
const INVALID_REQUEST: MarkdownFailure = {
  kind: "error",
  code: "invalid-request",
  message: "The Markdown save request was invalid."
};
let mainWindow: BrowserWindow | null = null;
let writingSmokeFinished = false;

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
}

function unregisterMarkdownIpc(): void {
  ipcMain.removeHandler(OPEN_MARKDOWN_CHANNEL);
  ipcMain.removeHandler(SAVE_MARKDOWN_CHANNEL);
  markdownFileService.dispose();
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 960,
    height: 640,
    show: writingSmoke.requested || !smokeMode,
    webPreferences: createSecureWebPreferences(path.join(__dirname, "preload.js"))
  });

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

  const loadOptions = writingSmoke.requested ? { query: { smoke: "writing" } } : undefined;
  void window.loadFile(rendererPath, loadOptions).catch((error: unknown) => {
    console.error("MAGINALIA renderer failed to load", error);
    if (writingSmoke.requested) {
      failWritingSmoke(error);
    } else if (quickSmokeMode) {
      app.exit(1);
    }
  });

  window.on("closed", () => {
    if (writingSmoke.requested && !writingSmokeFinished) {
      failWritingSmoke(new Error("Writing smoke window closed before completion."));
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
