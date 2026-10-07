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

async function waitForLastActiveProject(
  workdesks: WorkdeskService,
  workdesk: Awaited<ReturnType<WorkdeskService["open"]>>,
  projectIdentityId: string,
): Promise<void> {
  const deadline = Date.now() + RENDERER_TIMEOUT_MS;
  let lastActive = await workdesks.lastActiveContext(workdesk);
  while (Date.now() < deadline) {
    if (lastActive.kind === "project"
      && lastActive.projectIdentityId.toLowerCase() === projectIdentityId.toLowerCase()) return;
    await delay(25);
    lastActive = await workdesks.lastActiveContext(workdesk);
  }
  throw new Error(`The real Project was not saved as the last active Workdesk context: ${JSON.stringify(lastActive)}.`);
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
  readonly projectPickerInvocationCount: () => number;
  readonly registrationPromptInvocationCount: () => number;
  readonly rememberWorkdeskRoot: (rootPath: string) => void;
  readonly rememberProjectRoot: (rootPath: string) => void;
}): Promise<void> {
  if (options.restore) {
    const restored = await options.workdesks.restorePrimary();
    if (!restored) throw new Error("The primary Workdesk did not restore.");
    if ("kind" in restored) throw new Error(`The primary Workdesk needs identity recovery: ${restored.message}`);
    const projects = await options.workdesks.listRegisteredProjects(restored);
    const projectB = projects.find((project) => project.title === "H Smoke Project B");
    if (projects.length !== 4 || !projectB) {
      throw new Error("The restored Workdesk did not retain its four Project registrations.");
    }
    const lastActive = await options.workdesks.lastActiveContext(restored);
    if (lastActive.kind !== "project" || lastActive.projectIdentityId !== projectB.projectIdentityId) {
      throw new Error("The last active Project context was not persisted across restart.");
    }
    const restoredProjectB = await options.workdesks.resolveRegisteredProject(restored, projectB.projectIdentityId);
    try {
      await waitForRenderer(options.window,
        `document.querySelector("#workspace-label")?.textContent === "Project" && document.querySelector("#workspace-document-name")?.textContent === ${JSON.stringify(path.basename(restoredProjectB.canonicalRoot))}`,
        "Project B restore through the normal startup path");
    } catch (error) {
      const diagnostic = await options.window.webContents.executeJavaScript(`(() => ({
        label: document.querySelector("#workspace-label")?.textContent ?? null,
        name: document.querySelector("#workspace-document-name")?.textContent ?? null,
        error: document.querySelector("#workspace-error")?.textContent ?? null,
        expectedProjectFolder: ${JSON.stringify(path.basename(restoredProjectB.canonicalRoot))}
      }))()`, true);
      throw new Error(`${error instanceof Error ? error.message : String(error)} State: ${JSON.stringify(diagnostic)}.`);
    }
    if (options.workdeskPickerInvocationCount() !== 0 || options.projectPickerInvocationCount() !== 0) {
      throw new Error("Startup restore opened a folder picker.");
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
    await options.workdesks.registerProjectLocation(workdesk, child);
    return child;
  };
  const projectB = await createChildProject("H Smoke Project B");
  await createChildProject("H Smoke Project A");
  const externalCreated = await options.projects.createForWorkdesk(
    options.fixtureRoot,
    "H Smoke 外部 Project",
    workdesk.identity.id,
  );
  if (externalCreated.kind !== "created") throw new Error(`External Project fixture creation failed: ${externalCreated.message}`);
  options.rememberProjectRoot(externalCreated.canonicalRoot);
  const cancelledExternalCreated = await options.projects.createForWorkdesk(
    options.fixtureRoot,
    "H Smoke Cancel Project",
    workdesk.identity.id,
  );
  if (cancelledExternalCreated.kind !== "created") throw new Error(`Cancel Project fixture creation failed: ${cancelledExternalCreated.message}`);
  options.rememberProjectRoot(cancelledExternalCreated.canonicalRoot);
  const unregisteredExternalCreated = await options.projects.createForWorkdesk(
    options.fixtureRoot,
    "H Smoke Unregistered Project",
    workdesk.identity.id,
  );
  if (unregisteredExternalCreated.kind !== "created") throw new Error(`Unregistered Project fixture creation failed: ${unregisteredExternalCreated.message}`);
  options.rememberProjectRoot(unregisteredExternalCreated.canonicalRoot);

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

  const projectPickerCountBeforeNew = options.projectPickerInvocationCount();
  const workdeskPickerCountBeforeNew = options.workdeskPickerInvocationCount();
  await runRendererAction(options.window,
    `(() => { const button = document.querySelector("#workdesk-new-project"); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true; })()`,
    "starting New Project from Workdesk");
  await waitForRenderer(options.window,
    `document.querySelector("#project-create-form")?.hidden === false`,
    "the inline New Project title form");
  await runRendererAction(options.window,
    `(() => { const input = document.querySelector("#create-project-title"); const form = document.querySelector("#project-create-form"); if (!(input instanceof HTMLInputElement) || !(form instanceof HTMLFormElement)) return false; input.value = "H Smoke Project C"; form.requestSubmit(); return true; })()`,
    "creating a Project with the Workdesk title form");
  await waitForRenderer(options.window,
    `document.querySelector("#workspace-label")?.textContent === "Project" && document.querySelector("#workspace-document-name")?.textContent === "H Smoke Project C"`,
    "New Project opening immediately");
  if (options.projectPickerInvocationCount() !== projectPickerCountBeforeNew
    || options.workdeskPickerInvocationCount() !== workdeskPickerCountBeforeNew) {
    throw new Error("New Project opened a folder picker.");
  }
  const registrationsAfterNew = await options.workdesks.listRegisteredProjects(workdesk);
  const projectCEntry = registrationsAfterNew.find((project) => project.title === "H Smoke Project C");
  if (!projectCEntry) throw new Error("New Project was not registered with the Workdesk.");
  const projectC = await options.workdesks.resolveRegisteredProject(workdesk, projectCEntry.projectIdentityId);
  const { parseFolderMarkerText } = await import("@maginalia/repository-core");
  const projectCMarker = parseFolderMarkerText(await readFile(path.join(projectC.canonicalRoot, "project.magi"), "utf8"));
  if (projectCMarker.type !== "project" || projectCMarker.parent !== workdesk.identity.id) {
    throw new Error("New Project did not retain the current Workdesk parent identity.");
  }

  await runRendererAction(options.window,
    `(() => { const button = document.querySelector("#workdesk-home"); if (!(button instanceof HTMLButtonElement) || button.disabled) return false; button.click(); return true; })()`,
    "returning to Workdesk after New Project");
  await waitForRenderer(options.window,
    `document.querySelector("#workspace-label")?.textContent === "Workdesk"`,
    "Workdesk after New Project");
  const projectPickerCountBeforeAdd = options.projectPickerInvocationCount();
  const registrationPromptCountBeforeAdd = options.registrationPromptInvocationCount();
  await runRendererAction(options.window,
    `(() => { const button = document.querySelector("#workdesk-register-project"); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true; })()`,
    "adding an existing Project from Workdesk");
  try {
    await waitForRenderer(options.window,
      `document.querySelector("#workspace-label")?.textContent === "Project" && document.querySelector("#workspace-document-name")?.textContent === "H Smoke 外部 Project"`,
      "opening the added existing Project immediately");
  } catch (error) {
    const diagnostic = await options.window.webContents.executeJavaScript(`(() => ({
      label: document.querySelector("#workspace-label")?.textContent ?? null,
      name: document.querySelector("#workspace-document-name")?.textContent ?? null,
      error: document.querySelector("#workspace-error")?.textContent ?? null,
      projectPickerCount: ${options.projectPickerInvocationCount()},
      shortcuts: [...document.querySelectorAll("[data-workdesk-project-shortcut]")].map((button) => button.textContent)
    }))()`, true);
    throw new Error(`${error instanceof Error ? error.message : String(error)} State: ${JSON.stringify(diagnostic)}.`);
  }
  if (options.projectPickerInvocationCount() !== projectPickerCountBeforeAdd + 1) {
    throw new Error("Add existing Project did not use exactly one folder selection.");
  }
  if (options.registrationPromptInvocationCount() !== registrationPromptCountBeforeAdd + 1) {
    throw new Error("Add existing Project did not ask for Workdesk registration confirmation.");
  }
  const registrationsAfterAdd = await options.workdesks.listRegisteredProjects(workdesk);
  if (registrationsAfterAdd.length !== 4
    || !registrationsAfterAdd.some((project) => project.title === "H Smoke 外部 Project" && project.available)) {
    throw new Error("Add existing Project did not persist its portable registration and local mapping.");
  }
  const projectPickerCountAfterAdd = options.projectPickerInvocationCount();
  await runRendererAction(options.window,
    `(() => { const button = document.querySelector("#workdesk-home"); if (!(button instanceof HTMLButtonElement) || button.disabled) return false; button.click(); return true; })()`,
    "returning to Workdesk after Add existing Project");
  await waitForRenderer(options.window,
    `document.querySelector("#workspace-label")?.textContent === "Workdesk"`,
    "Workdesk after Add existing Project");
  await runRendererAction(options.window,
    `(() => { const button = [...document.querySelectorAll("[data-workdesk-project-shortcut]")].find((item) => item.textContent?.includes("H Smoke 外部 Project")); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true; })()`,
    "reopening the added Project from its Workdesk registration");
  await waitForRenderer(options.window,
    `document.querySelector("#workspace-label")?.textContent === "Project" && document.querySelector("#workspace-document-name")?.textContent === "H Smoke 外部 Project"`,
    "the registered Project opening without a folder picker");
  if (options.projectPickerInvocationCount() !== projectPickerCountAfterAdd) {
    throw new Error("Opening a registered Project prompted for a folder again.");
  }
  await runRendererAction(options.window,
    `(() => { const button = document.querySelector("#workdesk-home"); if (!(button instanceof HTMLButtonElement) || button.disabled) return false; button.click(); return true; })()`,
    "returning to Workdesk after reopening the registered Project");
  await waitForRenderer(options.window,
    `document.querySelector("#workspace-label")?.textContent === "Workdesk"`,
    "Workdesk before the existing navigation checks");

  const registrationsBeforeNo = await options.workdesks.listRegisteredProjects(workdesk);
  const pickerCountBeforeNo = options.projectPickerInvocationCount();
  const promptCountBeforeNo = options.registrationPromptInvocationCount();
  await runRendererAction(options.window,
    `(() => { const button = document.querySelector("#workdesk-register-project"); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true; })()`,
    "choosing No in the existing Project registration prompt");
  await waitForRenderer(options.window,
    `document.querySelector("#workspace-label")?.textContent === "Workdesk"`,
    "staying on Workdesk after choosing No");
  const registrationsAfterNo = await options.workdesks.listRegisteredProjects(workdesk);
  if (options.projectPickerInvocationCount() !== pickerCountBeforeNo + 1
    || options.registrationPromptInvocationCount() !== promptCountBeforeNo + 1
    || registrationsAfterNo.length !== registrationsBeforeNo.length
    || registrationsAfterNo.some((entry) => entry.title === "H Smoke Cancel Project")) {
    throw new Error("Choosing No opened or registered the selected Project.");
  }

  const pickerCountBeforeUnregisteredOpen = options.projectPickerInvocationCount();
  const promptCountBeforeUnregisteredOpen = options.registrationPromptInvocationCount();
  await runRendererAction(options.window,
    `(() => { const button = document.querySelector("#workdesk-register-project"); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true; })()`,
    "choosing Open without registration in the existing Project prompt");
  await waitForRenderer(options.window,
    `document.querySelector("#workspace-label")?.textContent === "Project" && document.querySelector("#workdesk-home")?.disabled === false`,
    "opening a Project without registering it");
  if (options.projectPickerInvocationCount() !== pickerCountBeforeUnregisteredOpen + 1
    || options.registrationPromptInvocationCount() !== promptCountBeforeUnregisteredOpen + 1) {
    throw new Error("Opening without registration skipped folder selection or registration confirmation.");
  }
  const registrationsAfterUnregisteredOpen = await options.workdesks.listRegisteredProjects(workdesk);
  if (registrationsAfterUnregisteredOpen.length !== registrationsBeforeNo.length
    || registrationsAfterUnregisteredOpen.some((entry) => entry.title === "H Smoke Unregistered Project")) {
    throw new Error("Open without registration added the Project to Workdesk.");
  }
  await runRendererAction(options.window,
    `(() => { const button = document.querySelector("#workdesk-home"); if (!(button instanceof HTMLButtonElement) || button.disabled) return false; button.click(); return true; })()`,
    "returning Home after opening an unregistered Project");
  await waitForRenderer(options.window,
    `document.querySelector("#workspace-label")?.textContent === "Workdesk"`,
    "Workdesk after returning from an unregistered Project");
  if ((await options.workdesks.lastActiveContext(workdesk)).kind !== "home") {
    throw new Error("Open without registration did not leave Workdesk as the saved startup context.");
  }

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

/**
 * Acceptance path against caller-provided real folders. The folder picker is
 * injected by the Electron smoke host, while every open/register/navigation
 * action runs through the normal renderer and IPC path.
 */
export async function runHNavigationAcceptanceSmoke(options: {
  readonly window: BrowserWindow;
  readonly workdeskRoot: string;
  readonly projectRoot: string;
  readonly restore: boolean;
  readonly workdesks: WorkdeskService;
  readonly workdeskPickerInvocationCount: () => number;
  readonly projectPickerInvocationCount: () => number;
  readonly registrationPromptInvocationCount: () => number;
}): Promise<void> {
  const workdesk = await options.workdesks.open(options.workdeskRoot);
  const project = await options.workdesks.validateExternalProject(options.projectRoot, {
    expectedWorkdeskIdentityId: workdesk.identity.id,
    requireExistingMarker: true,
  });
  const projectTitle = project.projectIdentity.title;
  const projectId = project.projectIdentity.id;
  if (project.projectIdentity.kind !== "project" || !projectTitle) {
    throw new Error("The real acceptance folder is not a valid Project marker.");
  }

  if (options.restore) {
    const restoredWorkdesk = await options.workdesks.restorePrimary();
    if (!restoredWorkdesk || "kind" in restoredWorkdesk
      || restoredWorkdesk.identity.id !== workdesk.identity.id
      || path.resolve(restoredWorkdesk.canonicalRoot) !== path.resolve(options.workdeskRoot)) {
      throw new Error("The real Workdesk did not restore from the saved local mapping.");
    }
    const registrations = await options.workdesks.listRegisteredProjects(restoredWorkdesk);
    const registered = registrations.find((entry) => entry.projectIdentityId === projectId);
    if (!registered?.available || registrations.filter((entry) => entry.projectIdentityId === projectId).length !== 1) {
      throw new Error("The real Project registration was missing, unavailable, or duplicated after restart.");
    }
    const lastActive = await options.workdesks.lastActiveContext(restoredWorkdesk);
    if (lastActive.kind !== "project" || lastActive.projectIdentityId !== projectId) {
      throw new Error("The last active real Project was not restored after restart.");
    }
    await waitForRenderer(options.window,
      `document.querySelector("#workspace-label")?.textContent === "Project" && document.querySelector("#workdesk-home")?.disabled === false`,
      "the real Project restored on application startup");
    if (options.workdeskPickerInvocationCount() !== 0 || options.projectPickerInvocationCount() !== 0) {
      throw new Error("Startup restore opened a folder picker.");
    }

    await runRendererAction(options.window,
      `(() => { const button = document.querySelector("#workdesk-home"); if (!(button instanceof HTMLButtonElement) || button.disabled) return false; button.click(); return true; })()`,
      "returning to the real Workdesk after restart");
    await waitForRenderer(options.window,
      `document.querySelector("#workspace-label")?.textContent === "Workdesk" && [...document.querySelectorAll("[data-workdesk-project-shortcut]")].some((button) => button.textContent?.includes(${JSON.stringify(projectTitle)}))`,
      "the saved Project in the restored Workdesk list");
    await runRendererAction(options.window,
      `(() => { const button = [...document.querySelectorAll("[data-workdesk-project-shortcut]")].find((item) => item.textContent?.includes(${JSON.stringify(projectTitle)})); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true; })()`,
      "opening the real Project from its saved Workdesk registration");
    await waitForRenderer(options.window,
      `document.querySelector("#workspace-label")?.textContent === "Project" && document.querySelector("#workdesk-home")?.disabled === false`,
      "the real Project opening without a folder picker after restart");
    if (options.workdeskPickerInvocationCount() !== 0 || options.projectPickerInvocationCount() !== 0) {
      throw new Error("Opening a saved Project after restart opened a folder picker.");
    }
    return;
  }

  await waitForRenderer(options.window,
    `document.querySelector("#editor")?.dataset.smokeReady === "workdesk"`,
    "the Workdesk acceptance renderer");
  const workdeskPickersBeforeOpen = options.workdeskPickerInvocationCount();
  await runRendererAction(options.window,
    `(() => { const button = document.querySelector("#open-workdesk"); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true; })()`,
    "opening the real Workdesk");
  await waitForRenderer(options.window,
    `document.querySelector("#workspace-label")?.textContent === "Workdesk" && document.querySelector("#workdesk-register-project") !== null`,
    "the real Workdesk Home");
  if (options.workdeskPickerInvocationCount() !== workdeskPickersBeforeOpen + 1) {
    throw new Error("Opening the real Workdesk did not use exactly one folder picker.");
  }

  const beforeAdd = await options.workdesks.listRegisteredProjects(workdesk);
  const projectPickersBeforeAdd = options.projectPickerInvocationCount();
  const registrationPromptsBeforeAdd = options.registrationPromptInvocationCount();
  await runRendererAction(options.window,
    `(() => { const button = document.querySelector("#workdesk-register-project"); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true; })()`,
    "adding the real Project to Workdesk");
  await waitForRenderer(options.window,
    `document.querySelector("#workspace-label")?.textContent === "Project" && document.querySelector("#workdesk-home")?.disabled === false`,
    "the real Project opening immediately after Add existing Project");
  if (options.projectPickerInvocationCount() !== projectPickersBeforeAdd + 1) {
    throw new Error("Add existing Project did not use exactly one folder picker.");
  }
  if (options.registrationPromptInvocationCount() !== registrationPromptsBeforeAdd + 1) {
    throw new Error("Add existing Project did not ask for Workdesk registration confirmation.");
  }
  const afterAdd = await options.workdesks.listRegisteredProjects(workdesk);
  const registered = afterAdd.filter((entry) => entry.projectIdentityId === projectId);
  if (registered.length !== 1 || !registered[0]?.available
    || afterAdd.length !== beforeAdd.length + (beforeAdd.some((entry) => entry.projectIdentityId === projectId) ? 0 : 1)) {
    throw new Error("Adding the real Project did not persist one available registration.");
  }
  const resolved = await options.workdesks.resolveRegisteredProject(workdesk, projectId);
  if (path.resolve(resolved.canonicalRoot) !== path.resolve(options.projectRoot)) {
    throw new Error("The real Project registration resolved to a different folder.");
  }

  await runRendererAction(options.window,
    `(() => { const button = document.querySelector("#workdesk-home"); if (!(button instanceof HTMLButtonElement) || button.disabled) return false; button.click(); return true; })()`,
    "returning to the real Workdesk");
  await waitForRenderer(options.window,
    `document.querySelector("#workspace-label")?.textContent === "Workdesk" && [...document.querySelectorAll("[data-workdesk-project-shortcut]")].some((button) => button.textContent?.includes(${JSON.stringify(projectTitle)}))`,
    "the registered real Project in the Workdesk list");
  const projectPickersBeforeRegisteredOpen = options.projectPickerInvocationCount();
  await runRendererAction(options.window,
    `(() => { const button = [...document.querySelectorAll("[data-workdesk-project-shortcut]")].find((item) => item.textContent?.includes(${JSON.stringify(projectTitle)})); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true; })()`,
    "opening the registered real Project");
  await waitForRenderer(options.window,
    `document.querySelector("#workspace-label")?.textContent === "Project" && document.querySelector("#workdesk-home")?.disabled === false`,
    "the registered real Project without another picker");
  if (options.projectPickerInvocationCount() !== projectPickersBeforeRegisteredOpen) {
    throw new Error("Opening the registered real Project prompted for a folder again.");
  }
  await waitForLastActiveProject(options.workdesks, workdesk, projectId);
}
