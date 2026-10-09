import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { BrowserWindow } from "electron";
import { MAGINALIA_APPLICATION_NAME } from "./application-identity";
import { renderBrandProgressHtml } from "./brand-progress";

export interface BrandProgressSmokeOptions {
  readonly splash: BrowserWindow;
  readonly mainWindow: BrowserWindow;
  readonly outputDirectory: string;
  readonly applicationName: string;
  readonly userDataPath: string;
  readonly expectedUserDataPath?: string;
  readonly update: (message: string, progress: number | null) => void;
  readonly complete: () => void;
}

/** Exercise the actual Electron splash DOM, accessible state, animation, and screenshots. */
export async function runBrandProgressElectronSmoke(options: BrandProgressSmokeOptions): Promise<void> {
  const { splash, mainWindow, outputDirectory, applicationName, userDataPath, expectedUserDataPath, update, complete } = options;
  if (splash.isDestroyed() || !splash.isVisible()) {
    throw new Error("The branded splash window was not visible during the Electron smoke.");
  }
  if (applicationName !== MAGINALIA_APPLICATION_NAME || !mainWindow.getTitle().includes(MAGINALIA_APPLICATION_NAME)) {
    throw new Error("The Electron app or main window did not expose the MAGINALIA desktop α1 identity.");
  }
  if (expectedUserDataPath !== undefined && path.resolve(userDataPath) !== path.resolve(expectedUserDataPath)) {
    throw new Error("The branded application identity changed the selected Electron userData path.");
  }
  await mkdir(outputDirectory, { recursive: true });

  const twentyPercent = await inspectProgressAt(splash, update, 0.2);
  await writeFile(path.join(outputDirectory, "brand-progress-20.png"), (await splash.capturePage()).toPNG());
  const eightyPercent = await inspectProgressAt(splash, update, 0.8);
  await writeFile(path.join(outputDirectory, "brand-progress-80.png"), (await splash.capturePage()).toPNG());

  if (twentyPercent.accessibleValue !== "20" || eightyPercent.accessibleValue !== "80") {
    throw new Error("The branded progress bar did not expose its numeric value to assistive technology.");
  }
  if (Math.abs(twentyPercent.messageScale - 0.2) > 0.015 || Math.abs(eightyPercent.messageScale - 0.8) > 0.015) {
    throw new Error("The marker did not visibly fill the startup message from left to right.");
  }
  if (Math.abs(twentyPercent.trackScale - 0.2) > 0.015 || Math.abs(eightyPercent.trackScale - 0.8) > 0.015) {
    throw new Error("The fluorescent marker progress bar did not follow the numeric progress state.");
  }
  await verifyBrandProgressFallback();

  complete();
  await delay(220);
  if (!mainWindow.isVisible() || (!splash.isDestroyed() && splash.isVisible())) {
    throw new Error("The startup splash did not hand over to the ready main window.");
  }
  const wordmark = await mainWindow.webContents.executeJavaScript(`(() => {
    const image = document.querySelector(".brand-wordmark");
    return { loaded: image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0 };
  })()`, true) as { readonly loaded: boolean };
  if (!wordmark.loaded) throw new Error("The supplied header wordmark did not render in the main window.");
  await writeFile(path.join(outputDirectory, "brand-main-window.png"), (await mainWindow.capturePage()).toPNG());
}

async function verifyBrandProgressFallback(): Promise<void> {
  const fallbackWindow = new BrowserWindow({
    width: 460,
    height: 320,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  try {
    const html = renderBrandProgressHtml({ logoDataUrl: null, markerDataUrl: null });
    await fallbackWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`);
    const fallback = await fallbackWindow.webContents.executeJavaScript(`(() => {
      const brand = document.getElementById("brand-fallback");
      const paint = document.querySelector(".message-paint");
      const bar = document.getElementById("startup-progress");
      window.maginaliaBrandProgress.update({ message: "処理中", progress: null });
      return {
        visible: !!brand && getComputedStyle(brand).display !== "none",
        markerFallback: !!paint && getComputedStyle(paint).backgroundImage.includes("linear-gradient"),
        accessibleProgress: bar?.getAttribute("role") === "progressbar",
        indeterminate: document.getElementById("brand-progress")?.classList.contains("is-indeterminate") ?? false,
        valueOmitted: bar !== null && !bar.hasAttribute("aria-valuenow"),
        statusMessage: document.getElementById("startup-message")?.textContent ?? "",
      };
    })()`, true) as {
      readonly visible: boolean;
      readonly markerFallback: boolean;
      readonly accessibleProgress: boolean;
      readonly indeterminate: boolean;
      readonly valueOmitted: boolean;
      readonly statusMessage: string;
    };
    if (!fallback.visible || !fallback.markerFallback || !fallback.accessibleProgress
      || !fallback.indeterminate || !fallback.valueOmitted || fallback.statusMessage !== "処理中") {
      throw new Error("The branded progress fallback did not remain readable and accessible without images.");
    }
  } finally {
    if (!fallbackWindow.isDestroyed()) fallbackWindow.close();
  }
}

async function inspectProgressAt(
  splash: BrowserWindow,
  update: BrandProgressSmokeOptions["update"],
  progress: number,
): Promise<{ readonly accessibleValue: string | null; readonly messageScale: number; readonly trackScale: number }> {
  const percent = Math.round(progress * 100);
  update(`MAGINALIA desktop α1 を起動しています · ${percent}%`, progress);
  await delay(260);
  const result = await splash.webContents.executeJavaScript(`(() => {
    const message = document.getElementById("startup-message");
    const bar = document.getElementById("startup-progress");
    const paint = document.querySelector(".message-paint");
    const stroke = document.querySelector(".progress-stroke");
    const scale = (element) => {
      const transform = getComputedStyle(element).transform;
      return transform === "none" ? 1 : Number(transform.slice(7).split(",")[0]);
    };
    return {
      message: message?.textContent ?? "",
      accessibleValue: bar?.getAttribute("aria-valuenow") ?? null,
      messageScale: paint ? scale(paint) : Number.NaN,
      trackScale: stroke ? scale(stroke) : Number.NaN,
      hasProgressbar: bar?.getAttribute("role") === "progressbar",
    };
  })()`, true) as {
    readonly message: string;
    readonly accessibleValue: string | null;
    readonly messageScale: number;
    readonly trackScale: number;
    readonly hasProgressbar: boolean;
  };
  if (!result.hasProgressbar || !result.message.includes(`${percent}%`)) {
    throw new Error(`The branded progress state was not rendered at ${percent}%.`);
  }
  if (!Number.isFinite(result.messageScale) || !Number.isFinite(result.trackScale)) {
    throw new Error("The branded marker transforms could not be read from the rendered splash.");
  }
  return result;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
