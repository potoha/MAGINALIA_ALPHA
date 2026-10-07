import * as path from "node:path";
import { readFile, unlink, writeFile } from "node:fs/promises";
import type { BrowserWindow } from "electron";
import type { ProjectService } from "./project-service.js";
import type { LocalRepositoryService } from "./repository-service.js";
import type { WorkdeskService } from "./workdesk-service.js";

/**
 * Real Electron coverage of Workdesk creation, child Project ownership,
 * parent History isolation, byte-preserving copy, navigation return, and
 * restart restore. UI actions use visible renderer controls; contextBridge
 * APIs stay isolated and are never copied into the main world.
 */
const RENDERER_TIMEOUT_MS = 15_000;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForRenderer(window: BrowserWindow, predicate: string, description: string): Promise<void> {
  const deadline = Date.now() + RENDERER_TIMEOUT_MS;
  let lastValue: unknown;
  while (Date.now() < deadline) {
    lastValue = await window.webContents.executeJavaScript(predicate, true);
    if (lastValue) return;
    await delay(25);
  }
  throw new Error(`Workdesk smoke timed out waiting for ${description}: ${JSON.stringify(lastValue)}.`);
}

async function runRendererAction(window: BrowserWindow, script: string, description: string): Promise<void> {
  const result = await window.webContents.executeJavaScript(script, true);
  if (result !== true) throw new Error(`Workdesk smoke could not perform ${description}.`);
}

export async function runHSmoke(options: {
  readonly window: BrowserWindow;
  readonly fixtureRoot: string;
  readonly restore: boolean;
  readonly workdesks: WorkdeskService;
  readonly repositories: LocalRepositoryService;
  readonly projects: ProjectService;
  readonly workdeskPickerInvocationCount: () => number;
  readonly rememberWorkdeskRoot: (rootPath: string) => void;
}): Promise<void> {
  if (options.restore) {
    const restored = await options.workdesks.restorePrimary();
    if (!restored) throw new Error("The primary Workdesk did not restore.");
    if ("kind" in restored) throw new Error(`The primary Workdesk needs identity recovery: ${restored.message}`);
    const projects = await options.workdesks.listRegisteredProjects(restored);
    const projectB = projects.find((project) => project.title === "H Smoke Project B");
    if (projects.length !== 2 || !projectB) {
      throw new Error("The restored Workdesk did not retain both Project registrations.");
    }
    const lastActive = await options.workdesks.lastActiveContext(restored);
    if (lastActive.kind !== "project" || lastActive.projectIdentityId !== projectB.projectIdentityId) {
      throw new Error("The last active Project context was not persisted across restart.");
    }
    return;
  }

  const owner = Object.freeze({});
  const created = await options.repositories.createForOwner(owner, options.fixtureRoot, "workbench", "H Smoke Desk");
  if (created.kind !== "opened") throw new Error(`Workdesk creation failed: ${created.message}`);
  const resolved = await options.repositories.resolveForOwner(owner, created.repository.repositoryId);
  if (resolved.kind !== "resolved") throw new Error(`Workdesk resolution failed: ${resolved.message}`);
  const workdesk = await options.workdesks.open(resolved.canonicalRoot);
  await options.workdesks.setPrimary(workdesk);
  options.rememberWorkdeskRoot(workdesk.canonicalRoot);

  const loose = await options.projects.openForOwner(owner, workdesk.canonicalRoot);
  if (loose.kind !== "opened") throw new Error(`Workdesk loose documents failed to open: ${loose.message}`);
  const memo = await options.projects.createFileForOwner(owner, loose.project.projectId, "memo.md", "H Smoke Memo", "memo");
  if (memo.kind !== "created") throw new Error(`Workdesk memo creation failed: ${memo.message}`);

  const projectParent = await options.workdesks.prepareChildProjectDirectory(workdesk);
  const createChildProject = async (title: string) => {
    const childOwner = Object.freeze({});
    const childCreated = await options.repositories.createForOwner(childOwner, projectParent, "project", title, {
      parentWorkdeskId: workdesk.identity.id,
    });
    if (childCreated.kind !== "opened") throw new Error(`Child Project creation failed: ${childCreated.message}`);
    const childResolved = await options.repositories.resolveForOwner(childOwner, childCreated.repository.repositoryId);
    if (childResolved.kind !== "resolved") throw new Error(`Child Project resolution failed: ${childResolved.message}`);
    const child = await options.workdesks.validateDirectChildProject(workdesk, childResolved.canonicalRoot);
    await options.workdesks.registerPortableProject(workdesk, child.projectIdentity);
    await options.workdesks.registerProjectPath(workdesk, child);
    return child;
  };
  const projectB = await createChildProject("H Smoke Project B");
  await createChildProject("H Smoke Project A");

  const source = await options.projects.readCopySourceForOwner(owner, loose.project.projectId, memo.file.fileId);
  if (!("text" in source)) throw new Error(`Workdesk copy source failed: ${source.message}`);
  const destinationOwner = Object.freeze({});
  const destination = await options.projects.openForOwner(destinationOwner, projectB.canonicalRoot);
  if (destination.kind !== "opened") throw new Error(`Child Project failed to open: ${destination.message}`);
  const copied = await options.projects.copySourceToProjectForOwner(destinationOwner, destination.project.projectId, source, "memo");
  if (copied.kind !== "created") throw new Error(`Workdesk copy failed: ${copied.message}`);
  const copiedSource = await options.projects.readCopySourceForOwner(destinationOwner, destination.project.projectId, copied.file.fileId);
  if (!("text" in copiedSource) || copiedSource.text !== source.text) {
    throw new Error("The child Project copy did not preserve the source Markdown bytes.");
  }

  const history = await options.repositories.createHistoryForOwner(owner, created.repository.repositoryId);
  if (history.kind !== "snapshot") throw new Error(`Parent Workdesk History did not safely capture: ${history.message}`);
  if (path.dirname(projectB.canonicalRoot) !== path.join(workdesk.canonicalRoot, "projects")) {
    throw new Error("Child Project was created outside the bounded Workdesk projects directory.");
  }

  await waitForRenderer(options.window,
    `document.querySelector("#editor")?.dataset.smokeReady === "workdesk"`,
    "the Workdesk smoke renderer");
  await runRendererAction(options.window,
    `(() => { const open = document.querySelector("#open-workdesk"); if (!(open instanceof HTMLButtonElement)) return false; open.click(); return true; })()`,
    "opening the registered Workdesk through Explorer actions");
  await waitForRenderer(options.window,
    `document.querySelector("#workspace-label")?.textContent === "Workdesk" && document.querySelector("[data-workdesk-project-shortcut]") !== null`,
    "Workdesk shortcuts in the Explorer root");
  await runRendererAction(options.window,
    `(() => { const file = [...document.querySelectorAll("#explorer-tree button[data-explorer-file-name]")].find((button) => button.dataset.explorerFileName === "memo.md"); if (!(file instanceof HTMLButtonElement)) return false; file.click(); return true; })()`,
    "opening the Workdesk memo");
  await waitForRenderer(options.window,
    `document.querySelector("#explorer-tree button[aria-current=page]")?.dataset.explorerFileName === "memo.md"`,
    "the active Workdesk memo");
  try {
    await waitForRenderer(options.window,
      `document.querySelector("#editor")?.dataset.smokeText?.includes("H Smoke Memo")`,
      "the open Workdesk document");
  } catch (error) {
    const diagnostic = await options.window.webContents.executeJavaScript(`(() => ({
      label: document.querySelector("#workspace-label")?.textContent ?? null,
      name: document.querySelector("#workspace-document-name")?.textContent ?? null,
      fileButtons: [...document.querySelectorAll("#explorer-tree button[data-explorer-file-name]")].map((button) => button.dataset.explorerFileName),
      activeFile: document.querySelector("#explorer-tree button[aria-current=page]")?.dataset.explorerFileName ?? null,
      editorText: document.querySelector("#editor")?.dataset.smokeText ?? null,
      documentStatus: document.querySelector("#document-status")?.textContent ?? null,
      error: document.querySelector("#workspace-error")?.textContent ?? null
    }))()`, true);
    throw new Error(`${error instanceof Error ? error.message : String(error)} State: ${JSON.stringify(diagnostic)}.`);
  }

  const parentText = await options.window.webContents.executeJavaScript(
    `document.querySelector("#editor")?.dataset.smokeText ?? null`, true
  ) as string | null;
  if (parentText === null) throw new Error("The Workdesk memo text was unavailable to the smoke harness.");
  const dirtyParentText = `${parentText}\nH Smoke unsaved update`;
  await runRendererAction(options.window,
    `(() => { const editor = document.querySelector("#editor"); if (!(editor instanceof HTMLElement)) return false; editor.dispatchEvent(new CustomEvent("maginalia-smoke-append", { detail: "\\nH Smoke unsaved update" })); return true; })()`,
    "editing the open Workdesk document");
  await waitForRenderer(options.window,
    `document.querySelector("#editor")?.dataset.smokeText === ${JSON.stringify(dirtyParentText)}`,
    "the dirty Workdesk document text");

  await runRendererAction(options.window,
    `(() => { const button = [...document.querySelectorAll("[data-workdesk-project-shortcut]")].find((item) => item.textContent?.includes("H Smoke Project B")); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true; })()`,
    "opening Project B from the Workdesk");
  try {
    await waitForRenderer(options.window,
      `document.querySelector("#workspace-label")?.textContent === "Project" && document.querySelector("#workdesk-home")?.disabled === false`,
      "Project B and the global Home action");
    await waitForRenderer(options.window,
      `[...document.querySelectorAll("#explorer-tree button[data-explorer-file-id]")].some((button) => button.dataset.explorerFileName === "memo.md")`,
      "Project B's uniquely copied memo");
  } catch (error) {
    const diagnostic = await options.window.webContents.executeJavaScript(`(() => ({
      label: document.querySelector("#workspace-label")?.textContent ?? null,
      name: document.querySelector("#workspace-document-name")?.textContent ?? null,
      homeDisabled: document.querySelector("#workdesk-home")?.disabled ?? null,
      shortcuts: [...document.querySelectorAll("[data-workdesk-project-shortcut]")].map((button) => ({
        id: button.dataset.workdeskProjectShortcut,
        text: button.textContent,
      })),
      error: document.querySelector("#workspace-error")?.textContent ?? null,
    }))()`, true);
    throw new Error(`${error instanceof Error ? error.message : String(error)} State: ${JSON.stringify(diagnostic)}.`);
  }
  const projectBDisplayName = await options.window.webContents.executeJavaScript(
    `document.querySelector("#workspace-document-name")?.textContent ?? ""`, true
  ) as string;
  if (!projectBDisplayName) throw new Error("Project B did not expose its active repository name.");
  await runRendererAction(options.window,
    `(() => { const button = document.querySelector("#workdesk-home"); if (!(button instanceof HTMLButtonElement) || button.disabled) return false; button.click(); return true; })()`,
    "returning to Workdesk through the global Home action");
  await waitForRenderer(options.window,
    `document.querySelector("#workspace-label")?.textContent === "Workdesk" && document.querySelector("[data-workdesk-project-shortcut]") !== null && document.querySelector("#workdesk-home")?.disabled === true && document.querySelector("#workdesk-home")?.getAttribute("aria-pressed") === "true"`,
    "the returned Workdesk and its shortcuts");
  await runRendererAction(options.window,
    `(() => { const button = [...document.querySelectorAll("[data-workdesk-project-shortcut]")].find((item) => item.textContent?.includes("H Smoke Project A")); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true; })()`,
    "opening Project A from the Workdesk after returning Home");
  await waitForRenderer(options.window,
    `document.querySelector("#workspace-label")?.textContent === "Project" && document.querySelector("#workspace-document-name")?.textContent !== ${JSON.stringify(projectBDisplayName)} && ![...document.querySelectorAll("#explorer-tree button[data-explorer-file-id]")].some((button) => button.dataset.explorerFileName === "memo.md")`,
    "Project A after returning from Project B");
  await runRendererAction(options.window,
    `(() => { const button = document.querySelector("#workdesk-home"); if (!(button instanceof HTMLButtonElement) || button.disabled) return false; button.click(); return true; })()`,
    "returning to Workdesk before reopening the memo");
  await waitForRenderer(options.window,
    `document.querySelector("#workspace-label")?.textContent === "Workdesk"`,
    "the Workdesk before reactivating the memo");
  await runRendererAction(options.window,
    `(() => { const file = [...document.querySelectorAll("#explorer-tree button[data-explorer-file-name]")].find((button) => button.dataset.explorerFileName === "memo.md"); if (!(file instanceof HTMLButtonElement)) return false; file.click(); return true; })()`,
    "reactivating the Workdesk memo after return");
  try {
    await waitForRenderer(options.window,
      `document.querySelector("#explorer-tree button[aria-current=page]")?.dataset.explorerFileName === "memo.md" && document.querySelector("#editor")?.dataset.smokeText === ${JSON.stringify(dirtyParentText)}`,
      "the unchanged Workdesk memo text after return");
  } catch (error) {
    const diagnostic = await options.window.webContents.executeJavaScript(`(() => ({
      label: document.querySelector("#workspace-label")?.textContent ?? null,
      name: document.querySelector("#workspace-document-name")?.textContent ?? null,
      fileButtons: [...document.querySelectorAll("#explorer-tree button[data-explorer-file-name]")].map((button) => button.dataset.explorerFileName),
      activeFile: document.querySelector("#explorer-tree button[aria-current=page]")?.dataset.explorerFileName ?? null,
      shortcuts: document.querySelectorAll("[data-workdesk-project-shortcut]").length,
      homeDisabled: document.querySelector("#workdesk-home")?.disabled ?? null,
      homeSelected: document.querySelector("#workdesk-home")?.getAttribute("aria-pressed") ?? null,
      editorText: document.querySelector("#editor")?.dataset.smokeText ?? null,
      expectedText: ${JSON.stringify(dirtyParentText)},
      error: document.querySelector("#workspace-error")?.textContent ?? null
    }))()`, true);
    throw new Error(`${error instanceof Error ? error.message : String(error)} State: ${JSON.stringify(diagnostic)}.`);
  }

  await runRendererAction(options.window,
    `(() => { const button = [...document.querySelectorAll("[data-workdesk-project-shortcut]")].find((item) => item.textContent?.includes("H Smoke Project B")); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true; })()`,
    "reopening Project B for unavailable-root coverage");
  await waitForRenderer(options.window,
    `document.querySelector("#workspace-label")?.textContent === "Project" && document.querySelector("#workspace-document-name")?.textContent === ${JSON.stringify(projectBDisplayName)} && document.querySelector("#workdesk-home")?.disabled === false && [...document.querySelectorAll("#explorer-tree button[data-explorer-file-id]")].some((button) => button.dataset.explorerFileName === "memo.md")`,
    "Project B Home action before root invalidation");
  const pickerCountBeforeRestoreFailure = options.workdeskPickerInvocationCount();
  const identityPath = path.join(workdesk.canonicalRoot, "workdesk.magi");
  const identityBytes = await readFile(identityPath);
  await unlink(identityPath);
  await runRendererAction(options.window,
    `(() => { const button = document.querySelector("#workdesk-home"); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true; })()`,
    "returning after the remembered Workdesk loses its marker");
  await waitForRenderer(options.window,
    `document.querySelector("#workspace-error")?.hidden === false && Boolean(document.querySelector("#workspace-error")?.textContent?.trim())`,
    "the visible Workdesk identity recovery message");
  await waitForRenderer(options.window,
    `[...document.querySelectorAll("#explorer-tree button[data-explorer-file-name]")].some((button) => button.dataset.explorerFileName === "memo.md")`,
    "the readable loose Workdesk memo in identity recovery");
  if (options.workdeskPickerInvocationCount() !== pickerCountBeforeRestoreFailure) {
    throw new Error("Returning to a Workdesk missing its marker opened a folder picker.");
  }
  try {
    await readFile(identityPath);
    throw new Error("Ordinary return recreated the missing Workdesk marker.");
  } catch (error) {
    if (!(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  await writeFile(identityPath, identityBytes);
}
