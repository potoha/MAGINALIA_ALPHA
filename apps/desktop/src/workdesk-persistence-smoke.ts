import { readFile, realpath } from "node:fs/promises";
import * as path from "node:path";
import type { BrowserWindow } from "electron";

const POLL_INTERVAL_MS = 100;
const STATE_TIMEOUT_MS = 20_000;

interface WorkdeskPersistenceState {
  readonly label: string;
  readonly title: string;
  readonly error: string;
  readonly projectShortcuts: readonly {
    readonly identityId: string;
    readonly title: string;
    readonly type: string;
    readonly rootChild: boolean;
  }[];
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}

async function readRendererState(window: BrowserWindow): Promise<WorkdeskPersistenceState | null> {
  try {
    return await window.webContents.executeJavaScript(`(() => ({
      label: document.querySelector("#workspace-label")?.textContent?.trim() ?? "",
      title: document.querySelector("#workspace-document-name")?.textContent?.trim() ?? "",
      error: document.querySelector("#workspace-error")?.textContent?.trim() ?? "",
      projectShortcuts: [...(document.querySelector("#explorer-tree")?.querySelectorAll(".workdesk-project-shortcut") ?? [])].map((button) => ({
        identityId: button.dataset.workdeskProjectShortcut ?? "",
        title: button.querySelector(".explorer-entry-title")?.textContent?.trim() ?? "",
        type: button.querySelector(".explorer-file-type")?.textContent?.trim() ?? "",
        rootChild: button.closest(".explorer-node")?.parentElement === document.querySelector("#explorer-tree")
      }))
    }))()`, true) as WorkdeskPersistenceState;
  } catch {
    return null;
  }
}

async function readStoredPrimary(filePath: string): Promise<string | null> {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8")) as { primaryWorkdesk?: unknown };
    return typeof value.primaryWorkdesk === "string" ? value.primaryWorkdesk : null;
  } catch {
    return null;
  }
}

/** Wait for the ordinary renderer restore/open path and its existing app-local store. */
export async function runWorkdeskPersistenceSmoke(options: {
  readonly window: BrowserWindow;
  readonly rootPath: string;
  readonly userDataPath: string;
  readonly expectedUserDataPath?: string;
  readonly restore: boolean;
  readonly pickerInvocationCount: () => number;
}): Promise<void> {
  if (!options.expectedUserDataPath || !samePath(options.userDataPath, options.expectedUserDataPath)) {
    throw new Error("Electron did not use the requested userData directory for Workdesk persistence.");
  }

  const canonicalRoot = await realpath(options.rootPath);
  const { parseFolderMarkerText } = await import("@maginalia/repository-core");
  const marker = parseFolderMarkerText(await readFile(path.join(canonicalRoot, "workdesk.magi"), "utf8"));
  if (marker.type !== "workdesk") throw new Error("The Workdesk smoke fixture has an invalid folder marker.");
  const manuscript = await readFile(path.join(canonicalRoot, "manuscript.md"), "utf8");
  const title = /^#\s+(.+?)\s*$/mu.exec(manuscript)?.[1];
  if (!title) throw new Error("The Workdesk smoke fixture has no manuscript heading.");
  let expectedShortcut: { readonly identityId: string; readonly title: string } | null = null;
  if (options.restore) {
    const index = JSON.parse(await readFile(path.join(canonicalRoot, ".maginalia", "workdesk-projects.json"), "utf8")) as {
      projects?: readonly { projectIdentityId?: unknown; title?: unknown }[];
    };
    const firstProject = index.projects?.[0];
    if (!firstProject || typeof firstProject.projectIdentityId !== "string" || typeof firstProject.title !== "string") {
      throw new Error("The Workdesk shortcut smoke fixture has no registered Project.");
    }
    expectedShortcut = { identityId: firstProject.projectIdentityId, title: firstProject.title };
  }
  const storePath = path.join(options.userDataPath, "workdesk-paths.json");
  const expectedPickerCalls = options.restore ? 0 : 1;
  const deadline = Date.now() + STATE_TIMEOUT_MS;
  let lastState: WorkdeskPersistenceState | null = null;
  let storedPrimary: string | null = null;

  while (Date.now() < deadline) {
    if (options.pickerInvocationCount() > expectedPickerCalls) {
      throw new Error(`Workdesk folder picker ran ${options.pickerInvocationCount()} times; expected ${expectedPickerCalls}.`);
    }
    storedPrimary = await readStoredPrimary(storePath);
    lastState = await readRendererState(options.window);
    const stored = storedPrimary !== null && samePath(storedPrimary, canonicalRoot);
    const active = lastState?.label === "Workdesk" && lastState.title === title;
    const shortcutReady = expectedShortcut === null || lastState?.projectShortcuts.some((shortcut) =>
      shortcut.identityId === expectedShortcut?.identityId
        && shortcut.title === expectedShortcut.title
        && shortcut.type === "Project"
        && shortcut.rootChild
    ) === true;
    if (stored && active && shortcutReady && options.pickerInvocationCount() === expectedPickerCalls) {
      if (expectedShortcut) {
        const clicked = await options.window.webContents.executeJavaScript(`(() => {
          const button = [...document.querySelectorAll(".workdesk-project-shortcut")]
            .find((candidate) => candidate.dataset.workdeskProjectShortcut === ${JSON.stringify(expectedShortcut.identityId)});
          if (!button) return false;
          button.click();
          return true;
        })()`, true) as boolean;
        if (!clicked) throw new Error("The registered Workdesk Project shortcut could not be activated.");
        const navigationDeadline = Date.now() + STATE_TIMEOUT_MS;
        while (Date.now() < navigationDeadline) {
          lastState = await readRendererState(options.window);
          if (lastState?.label === "Project" && lastState.title !== title && lastState.projectShortcuts.length === 0) return;
          if (lastState?.error) throw new Error(`Registered Project navigation displayed an error: ${lastState.error}`);
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }
        throw new Error(`Registered Project navigation did not open ${expectedShortcut.title}: ${JSON.stringify(lastState)}.`);
      }
      return;
    }
    if (lastState?.error && !active) {
      throw new Error(`Workdesk startup displayed an error: ${lastState.error}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(`Workdesk persistence smoke timed out. picker calls=${options.pickerInvocationCount()}, stored primary=${storedPrimary ?? "missing"}, renderer=${JSON.stringify(lastState)}.`);
}
