import { readFile, rm } from "node:fs/promises";
import * as path from "node:path";
import type { BrowserWindow } from "electron";

const POLL_INTERVAL_MS = 25;
const STATE_TIMEOUT_MS = 20_000;
const FIRST_MOD_ID = "dev.maginalia.secondary-markdown";
const SECONDARY_MARKDOWN_COMMAND_ID = `${FIRST_MOD_ID}.open-active-document-in-secondary`;

interface D5TabState {
  readonly documentId: string;
  readonly name: string;
  readonly active: boolean;
  readonly dirty: boolean;
}

interface D5RendererState {
  readonly ready: boolean;
  readonly projectName: string;
  readonly activeFile: string | null;
  readonly text: string;
  readonly status: string;
  readonly tabs: readonly D5TabState[];
  readonly modsStatus: string;
  readonly modCommandIds: readonly string[];
  readonly modViewIds: readonly string[];
  readonly referencesStatus: string;
  readonly hasShelf: boolean;
}

const READ_STATE_SCRIPT = `(() => {
  const editor = document.querySelector("#editor");
  const project = document.querySelector("#workspace-document-name");
  const list = document.querySelector("#manuscript-list");
  const status = document.querySelector("#document-status");
  const mods = document.querySelector("#mods-status");
  const references = document.querySelector("#references-status");
  const shelf = document.querySelector("#library-navigation");
  if (!editor || editor.dataset.smokeReady !== "project" || !project || !list || !status || !mods || !references || !shelf) return null;
  const active = [...list.querySelectorAll("button[data-manuscript-id]")].find((button) => button.getAttribute("aria-current") === "page");
  const tabs = [...document.querySelectorAll("#document-tabs .document-tab")].map((tab) => {
    const button = tab.querySelector(".document-tab-label");
    return {
      documentId: tab.dataset.documentTab ?? "",
      name: button?.textContent ?? "",
      active: tab.classList.contains("active"),
      dirty: tab.classList.contains("dirty")
    };
  });
  return {
    ready: true,
    projectName: project.textContent ?? "",
    activeFile: active?.dataset.manuscriptName ?? active?.textContent ?? null,
    text: editor.dataset.smokeText ?? "",
    status: status.dataset.state ?? "",
    tabs,
    modsStatus: mods.textContent ?? "",
    modCommandIds: [...document.querySelectorAll("#mod-command-host button[data-mod-command-id]")].map((button) => button.dataset.modCommandId ?? ""),
    modViewIds: [...document.querySelectorAll("#mod-view-host [data-mod-view-id]")].map((element) => element.dataset.modViewId ?? ""),
    referencesStatus: references.dataset.state ?? "",
    hasShelf: !shelf.hidden
  };
})()`;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForFileContains(filePath: string, expected: string, description: string): Promise<void> {
  const deadline = Date.now() + STATE_TIMEOUT_MS;
  let last = "";
  while (Date.now() < deadline) {
    try {
      last = await readFile(filePath, "utf8");
      if (last.includes(expected)) return;
    } catch {
      // The Project file may not be observable until the first save attempt.
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`D.5 smoke timed out waiting for ${description}. Last file text: ${JSON.stringify(last)}`);
}

async function readState(window: BrowserWindow): Promise<D5RendererState | null> {
  try {
    return await window.webContents.executeJavaScript(READ_STATE_SCRIPT, true) as D5RendererState | null;
  } catch {
    return null;
  }
}

async function waitForState(
  window: BrowserWindow,
  predicate: (state: D5RendererState) => boolean,
  description: string,
): Promise<D5RendererState> {
  const deadline = Date.now() + STATE_TIMEOUT_MS;
  let last: D5RendererState | null = null;
  while (Date.now() < deadline) {
    last = await readState(window);
    if (last !== null && predicate(last)) return last;
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`D.5 smoke timed out waiting for ${description}. Last state: ${last ? JSON.stringify(last) : "unavailable"}.`);
}

async function runScript(window: BrowserWindow, script: string, description: string): Promise<void> {
  const result = await window.webContents.executeJavaScript(script, true) as boolean;
  if (!result) throw new Error(`D.5 smoke ${description} was unavailable.`);
}

async function clickFile(window: BrowserWindow, name: string): Promise<void> {
  await runScript(window, `(() => {
    const button = [...document.querySelectorAll("#manuscript-list button[data-manuscript-id]")]
      .find((candidate) => candidate.dataset.manuscriptName === ${JSON.stringify(name)});
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`, `click ${name}`);
}

async function clickTab(window: BrowserWindow, name: string): Promise<void> {
  await runScript(window, `(() => {
    const tab = [...document.querySelectorAll("#document-tabs .document-tab")]
      .find((candidate) => candidate.querySelector(".document-tab-label")?.textContent?.startsWith(${JSON.stringify(name)}));
    const button = tab?.querySelector(".document-tab-label");
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`, `activate ${name} tab`);
}

async function clickButton(window: BrowserWindow, selector: string, description: string): Promise<void> {
  await runScript(window, `(() => {
    const button = document.querySelector(${JSON.stringify(selector)});
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`, description);
}

async function openProject(window: BrowserWindow): Promise<void> {
  await waitForState(window, (state) => state.ready && state.status === "empty", "Project renderer readiness");
  await runScript(window, `(() => {
    const overflow = document.querySelector("#project-overflow");
    const open = document.querySelector("#open-project");
    if (!(overflow instanceof HTMLButtonElement) || !(open instanceof HTMLButtonElement)) return false;
    overflow.click();
    open.click();
    return true;
  })()`, "open Project");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`D.5 smoke assertion failed: ${message}`);
}

async function setConfirm(window: BrowserWindow, answer: boolean): Promise<void> {
  await runScript(window, `(() => {
    window.confirm = () => ${answer ? "true" : "false"};
    return true;
  })()`, "set close decision");
}

async function restoreConfirm(window: BrowserWindow): Promise<void> {
  await runScript(window, `(() => {
    delete window.confirm;
    return true;
  })()`, "restore close decision");
}

async function editActive(window: BrowserWindow, suffix: string): Promise<void> {
  await runScript(window, `(() => {
    const editor = document.querySelector("#editor");
    if (!(editor instanceof HTMLElement)) return false;
    editor.dispatchEvent(new CustomEvent("maginalia-smoke-append", { detail: ${JSON.stringify(suffix)} }));
    return true;
  })()`, "edit active Markdown");
}

async function waitForModContribution(window: BrowserWindow): Promise<D5RendererState> {
  return waitForState(
    window,
    (state) => state.modsStatus.includes("1 Mod active")
      && state.modCommandIds.includes(SECONDARY_MARKDOWN_COMMAND_ID)
      && state.modViewIds.includes("secondary-markdown"),
    "the first-party Secondary Markdown Mod contribution"
  );
}

/** Exercise the D.5 tab, single-placement, and Mod reload boundary. */
export async function runD5Smoke(
  window: BrowserWindow,
  fixtureRoot: string,
  modsDirectory: string,
): Promise<void> {
  const rootName = path.basename(path.resolve(fixtureRoot));
  await window.webContents.executeJavaScript("document.body?.offsetWidth ?? 0", true);
  await delay(50);
  await openProject(window);

  const first = await waitForState(
    window,
    (state) => state.projectName === rootName
      && state.activeFile === "first.md"
      && state.tabs.length === 1
      && state.tabs[0]?.active === true,
    "the first Project Markdown tab"
  );
  assert(first.hasShelf, "Shelf disappeared while Project tabs were enabled");
  const firstText = first.text;

  await clickFile(window, "second.md");
  await waitForState(
    window,
    (state) => state.activeFile === "second.md"
      && state.tabs.length === 2
      && state.tabs.some((tab) => tab.name.startsWith("first.md"))
      && state.tabs.some((tab) => tab.name.startsWith("second.md") && tab.active),
    "the second central Markdown tab"
  );

  await clickTab(window, "first.md");
  await waitForState(window, (state) => state.activeFile === "first.md" && state.text === firstText, "switch back to first tab");
  await editActive(window, "\nD5 tab edit");
  const dirtyFirst = await waitForState(
    window,
    (state) => state.activeFile === "first.md"
      && state.status === "modified"
      && state.tabs.length === 2
      && state.tabs.some((tab) => tab.name.startsWith("first.md") && tab.dirty),
    "the first tab dirty state"
  );

  await clickTab(window, "second.md");
  await waitForState(window, (state) => state.activeFile === "second.md" && state.text.includes("Second"), "switch to second tab");
  // An inactive document still owns an independent debounce timer. Editing A
  // and activating B immediately must not prevent A's local autosave.
  await clickTab(window, "first.md");
  await editActive(window, "\nD5 inactive autosave");
  await clickTab(window, "second.md");
  await waitForState(window, (state) => state.activeFile === "second.md" && state.status === "saved", "switch away from inactive dirty tab");
  await waitForFileContains(path.join(fixtureRoot, "first.md"), "D5 inactive autosave", "inactive tab autosave");
  await clickTab(window, "first.md");
  await waitForState(
    window,
    (state) => state.activeFile === "first.md" && state.text.includes("D5 tab edit") && state.tabs.length === 2,
    "dirty text retention after tab switching"
  );

  // Opening the already active file again must activate its existing tab,
  // never create a duplicate central tab.
  await clickFile(window, "first.md");
  const duplicate = await waitForState(
    window,
    (state) => state.activeFile === "first.md" && state.tabs.length === 2,
    "duplicate-open tab activation"
  );
  assert(duplicate.tabs.filter((tab) => tab.name.startsWith("first.md")).length === 1, "duplicate first tab was created");

  // The first tab was persisted by its inactive-tab debounce above. Verify
  // the normal Save state is already clean instead of forcing a disabled
  // button click after Autosave has consumed the dirty revision.
  await waitForState(
    window,
    (state) => state.activeFile === "first.md"
      && state.status === "saved"
      && !state.tabs.some((tab) => tab.name.startsWith("first.md") && tab.dirty),
    "first tab autosave"
  );
  assert((await readFile(path.join(fixtureRoot, "first.md"), "utf8")).includes("D5 tab edit"), "first tab edit was not saved");

  // Autosave now gets the first chance to flush a dirty tab. A successful
  // flush closes the tab without prompting; the reopened tab below verifies
  // that the latest text survived that lifecycle boundary.
  await editActive(window, "\nD5 close autosave");
  await waitForState(window, (state) => state.status === "modified" && state.tabs.length === 2, "dirty close fixture");
  await setConfirm(window, false);
  await clickButton(window, "#document-tabs .document-tab:first-child .document-tab-close", "autosaved dirty tab close");
  await waitForState(
    window,
    (state) => state.activeFile === "second.md" && state.tabs.length === 1 && state.status === "saved",
    "autosaved dirty tab close"
  );
  await restoreConfirm(window);
  await clickFile(window, "first.md");
  await waitForState(
    window,
    (state) => state.activeFile === "first.md"
      && state.tabs.length === 2
      && state.status === "saved"
      && state.text.includes("D5 close autosave"),
    "reopen after autosaved close"
  );

  // Complete the smoke with a dirty edit immediately before the main-process
  // quit path. The Electron before-quit handshake must flush it even though
  // the one-second debounce has not elapsed.
  await editActive(window, "\nD5 shutdown autosave");
  await waitForState(window, (state) => state.activeFile === "first.md" && state.status === "modified", "shutdown autosave fixture");

  const contribution = await waitForModContribution(window);
  assert(contribution.hasShelf && contribution.referencesStatus !== "error", "Shelf or References disappeared with the Mod");
  await clickButton(window, `#mod-command-host button[data-mod-command-id='${SECONDARY_MARKDOWN_COMMAND_ID}']`, "invoke Secondary Markdown");
  const rejected = await waitForState(
    window,
    (state) => state.modsStatus.includes("already open in the central editor")
      || state.modsStatus.includes("second pane is deferred"),
    "the explicit single-placement Mod refusal"
  );
  assert(rejected.tabs.length === 2, "Secondary command created a duplicate central view");

  // Removing the direct child from the global Mods folder and reloading must
  // remove only the contribution, leaving the core workbench usable.
  await rm(path.join(modsDirectory, "dev.maginalia.secondary-markdown"), { recursive: true, force: true });
  await clickButton(window, "#reload-mods", "reload Mods after removal");
  const removed = await waitForState(
    window,
    (state) => state.modsStatus.includes("0 Mods active")
      && state.modCommandIds.length === 0
      && state.modViewIds.length === 0
      && state.tabs.length === 2
      && state.hasShelf,
    "Mod removal with core workbench intact"
  );
  assert(removed.projectName === rootName && removed.referencesStatus !== "error", "core Project/Shelf/References state was damaged by Mod removal");

  // Let the asynchronous workspace-state write settle before the Electron
  // process exits; the restore run verifies tabs and active-file recovery.
  await delay(150);
}

/** Verify persisted central tabs and safe restore after the Mod was removed. */
export async function runD5RestoreSmoke(
  window: BrowserWindow,
  fixtureRoot: string,
  _modsDirectory: string,
): Promise<void> {
  const rootName = path.basename(path.resolve(fixtureRoot));
  const restored = await waitForState(
    window,
    (state) => state.projectName === rootName
      && state.activeFile === "first.md"
      && state.tabs.length === 2
      && state.tabs.some((tab) => tab.name.startsWith("first.md") && tab.active)
      && state.tabs.some((tab) => tab.name.startsWith("second.md")),
    "persisted central tabs after restart"
  );
  assert(restored.hasShelf, "Shelf disappeared during safe workspace restore");
  assert(restored.modCommandIds.length === 0 && restored.modViewIds.length === 0, "removed Mod contribution was restored unexpectedly");
  assert(restored.modsStatus.includes("0 Mods active"), "removed Mod remained active after restart");
}
