import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { BrowserWindow } from "electron";

export interface FirstRunSmokeOptions {
  readonly window: BrowserWindow;
  readonly workdeskRoot: string;
  readonly shelfRoot: string;
  readonly downloadsRoot: string;
  readonly userDataRoot: string;
  readonly expectedUserDataRoot?: string;
  readonly outputDirectory: string;
  readonly exit: (code: number) => void;
}

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function capture(window: BrowserWindow, outputPath: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const image = await window.webContents.capturePage();
      await writeFile(outputPath, image.toPNG());
      return;
    } catch (error: unknown) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
  throw new Error(`The Electron window could not be captured: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function waitUntil<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let latest: T;
  do {
    latest = await read();
    if (accept(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`${label} timed out. Last state: ${JSON.stringify(latest!)}`);
}

export async function runFirstRunSmoke(options: FirstRunSmokeOptions): Promise<void> {
  const { window, workdeskRoot, shelfRoot, downloadsRoot, userDataRoot, expectedUserDataRoot, outputDirectory } = options;
  let stage = "checking the isolated profile";
  try {
  if (expectedUserDataRoot && path.resolve(userDataRoot) !== path.resolve(expectedUserDataRoot)) {
    throw new Error("First-run smoke did not use the requested isolated userData directory.");
  }
  await mkdir(outputDirectory, { recursive: true });
  stage = "checking the first-run screen";
  const initial = await window.webContents.executeJavaScript("Boolean(document.querySelector('#first-run-form'))") as boolean;
  ensure(initial, "First-run screen did not render its setup form.");
  stage = "capturing the first-run screen";
  await capture(window, path.join(outputDirectory, "first-run-setup.png"));
  stage = "submitting the setup choices";
  await window.webContents.executeJavaScript("document.querySelector('#first-run-form').requestSubmit()", true);

  stage = "waiting for setup to finish";
  const setupState = await waitUntil(async () => window.webContents.executeJavaScript(`(() => ({
    formHidden: document.querySelector('#first-run-form')?.hidden ?? true,
    openHidden: document.querySelector('#first-run-open')?.hidden ?? true,
    error: document.querySelector('#first-run-error')?.textContent ?? '',
    status: document.querySelector('#first-run-status')?.textContent ?? ''
  }))()`), (state) => !state.openHidden || state.error.length > 0, 90_000, "First-run setup");
  ensure(!setupState.openHidden, `First-run setup failed: ${setupState.error || setupState.status}`);
  stage = "capturing the completed setup screen";
  await capture(window, path.join(outputDirectory, "first-run-complete.png"));

  stage = "validating the created user data";
  const { parseFolderMarkerText } = await import("@maginalia/repository-core");
  const workdeskMarker = parseFolderMarkerText(await readFile(path.join(workdeskRoot, "workdesk.magi"), "utf8"));
  const shelfMarker = parseFolderMarkerText(await readFile(path.join(shelfRoot, "shelf.magi"), "utf8"));
  ensure(workdeskMarker.type === "workdesk", "First-run Workdesk marker has the wrong role.");
  ensure(shelfMarker.type === "shelf", "First-run Shelf marker has the wrong role.");
  const projectRoot = path.join(workdeskRoot, "projects", "MAGINALIA はじめてのプロジェクト");
  const projectMarker = parseFolderMarkerText(await readFile(path.join(projectRoot, "project.magi"), "utf8"));
  ensure(projectMarker.type === "project" && projectMarker.parent === workdeskMarker.id, "Tutorial Project parent identity does not match the Workdesk.");
  ensure((await readdir(path.join(shelfRoot, "books"))).filter((file) => file.endsWith(".json")).length === 3, "Tutorial Shelf seed Books are missing.");
  ensure((await readdir(path.join(shelfRoot, "annotations"))).filter((file) => file.endsWith(".json")).length === 3, "Tutorial Shelf seed Annotations are missing.");
  const journal = JSON.parse(await readFile(path.join(userDataRoot, "first-run-setup.json"), "utf8")) as { stage?: unknown; tutorialProjectIdentityId?: unknown };
  ensure(journal.stage === "complete" && journal.tutorialProjectIdentityId === projectMarker.id, "First-run completion journal is missing its Project identity.");
  ensure((await readdir(downloadsRoot)).some((file) => file.startsWith("MAGINALIA_チュートリアル_宮沢賢治")), "Tutorial image was not copied to Downloads.");

  stage = "opening the Tutorial Project entry document";
  let nextLoadResolve!: () => void;
  const nextLoad = new Promise<void>((resolve) => { nextLoadResolve = resolve; });
  const onLoad = () => {
    window.webContents.removeListener("did-finish-load", onLoad);
    nextLoadResolve();
  };
  window.webContents.on("did-finish-load", onLoad);
  await window.webContents.executeJavaScript("document.querySelector('#first-run-open').click()", true);
  await Promise.race([
    nextLoad,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("The app did not return to its normal screen after first-run setup.")), 20_000)),
  ]);
  const entryState = await waitUntil(async () => window.webContents.executeJavaScript(`({
    name: document.querySelector('#document-name')?.textContent ?? '',
    query: new URLSearchParams(location.search).get('setup')
  })`), (state) => state.name.includes("sample-a_マキナの置き手紙.md") || Boolean(state.query), 30_000, "Tutorial entry document");
  ensure(entryState.name.includes("sample-a_マキナの置き手紙.md"), `Tutorial entry was not opened: ${entryState.name}`);
  stage = "capturing the Tutorial Project screen";
  await capture(window, path.join(outputDirectory, "tutorial-project-open.png"));
  stage = "waiting for the Tutorial Project workspace state to persist";
  await waitUntil(async () => {
    try {
      return JSON.parse(await readFile(path.join(userDataRoot, "workspace-state.json"), "utf8")) as {
        projectId?: unknown;
        activeFileId?: unknown;
        openFileIds?: unknown;
      };
    } catch {
      return null;
    }
  }, (state) => state !== null
    && typeof state.projectId === "string"
    && typeof state.activeFileId === "string"
    && Array.isArray(state.openFileIds)
    && state.openFileIds.includes(state.activeFileId), 30_000, "Tutorial Project workspace persistence");
  console.log("MAGINALIA_FIRST_RUN_SMOKE_OK");
  options.exit(0);
  } catch (error: unknown) {
    throw new Error(`First-run smoke failed while ${stage}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

export async function runFirstRunRestoreSmoke(options: {
  readonly window: BrowserWindow;
  readonly workdeskRoot: string;
  readonly userDataRoot: string;
  readonly expectedUserDataRoot?: string;
  readonly exit: (code: number) => void;
}): Promise<void> {
  const { window, workdeskRoot, userDataRoot, expectedUserDataRoot } = options;
  if (!expectedUserDataRoot || path.resolve(userDataRoot) !== path.resolve(expectedUserDataRoot)) {
    throw new Error("First-run restore smoke did not use the requested isolated userData directory.");
  }
  const canonicalWorkdesk = await realpath(workdeskRoot);
  const state = await waitUntil(async () => window.webContents.executeJavaScript(`(() => ({
    setupVisible: document.querySelector('#first-run-form') !== null,
    documentName: document.querySelector('#document-name')?.textContent ?? '',
  }))()`), (value) => value.documentName.includes("sample-a_マキナの置き手紙.md"), 60_000, "Tutorial Project restore");
  ensure(!state.setupVisible, "Completed first-run setup was shown again after restart.");
  const workdeskMarker = (await import("@maginalia/repository-core")).parseFolderMarkerText(
    await readFile(path.join(canonicalWorkdesk, "workdesk.magi"), "utf8"),
  );
  const journal = JSON.parse(await readFile(path.join(userDataRoot, "first-run-setup.json"), "utf8")) as {
    stage?: unknown;
    tutorialProjectIdentityId?: unknown;
  };
  ensure(journal.stage === "complete" && typeof journal.tutorialProjectIdentityId === "string", "Completed setup identity was not retained after restart.");
  const projectRoot = path.join(canonicalWorkdesk, "projects", "MAGINALIA はじめてのプロジェクト");
  const projectMarker = (await import("@maginalia/repository-core")).parseFolderMarkerText(
    await readFile(path.join(projectRoot, "project.magi"), "utf8"),
  );
  ensure(projectMarker.id === journal.tutorialProjectIdentityId, "The Tutorial Project identity changed across restart.");
  const pathState = JSON.parse(await readFile(path.join(userDataRoot, "workdesk-paths.json"), "utf8")) as {
    primaryWorkdesk?: unknown;
  };
  ensure(typeof pathState.primaryWorkdesk === "string" && path.resolve(pathState.primaryWorkdesk) === canonicalWorkdesk,
    "The primary Workdesk mapping did not survive first-run restart.");
  console.log("MAGINALIA_FIRST_RUN_RESTORE_SMOKE_OK");
  options.exit(0);
}
