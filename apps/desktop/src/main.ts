import { app, BrowserWindow } from "electron";
import * as path from "node:path";
import { createSecureWebPreferences } from "./security";

const smokeMode = process.argv.includes("--smoke");
let mainWindow: BrowserWindow | null = null;

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 960,
    height: 640,
    show: !smokeMode,
    webPreferences: createSecureWebPreferences(path.join(__dirname, "preload.js"))
  });

  const rendererPath = path.join(__dirname, "..", "renderer", "index.html");

  if (smokeMode) {
    window.webContents.once("did-finish-load", () => {
      console.log("MAGINALIA_ELECTRON_SMOKE_OK");
      app.quit();
    });
    window.webContents.once("did-fail-load", (_event, errorCode, errorDescription) => {
      console.error(`MAGINALIA_ELECTRON_SMOKE_FAILED ${errorCode}: ${errorDescription}`);
      app.exit(1);
    });
  }

  void window.loadFile(rendererPath).catch((error: unknown) => {
    console.error("MAGINALIA renderer failed to load", error);
    if (smokeMode) {
      app.exit(1);
    }
  });

  window.on("closed", () => {
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
  openMainWindow();
  app.on("activate", openMainWindow);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
