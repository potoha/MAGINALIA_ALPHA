import { readFile } from "node:fs/promises";
import * as path from "node:path";
import type { BrowserWindow } from "electron";

const POLL_INTERVAL_MS = 25;
const STATE_TIMEOUT_MS = 15_000;

interface WorkspaceRendererState {
  readonly smokeReady: boolean;
  readonly documentName: string;
  readonly manuscripts: readonly string[];
  readonly activeManuscript: string | null;
  readonly text: string;
  readonly statusKind: string;
  readonly statusMessage: string;
  readonly saveEnabled: boolean;
}

const READ_STATE_SCRIPT = `(() => {
  const editor = document.querySelector("#editor");
  const documentName = document.querySelector("#workspace-document-name");
  const list = document.querySelector("#explorer-tree");
  const status = document.querySelector("#document-status");
  const save = document.querySelector("#save-markdown");
  if (!editor || editor.dataset.smokeReady !== "workspace" || !documentName || !list || !status || !save) return null;
  const buttons = [...list.querySelectorAll("button[data-explorer-file-id]")];
  const active = buttons.find((button) => button.getAttribute("aria-current") === "page");
  return {
    smokeReady: true,
    documentName: documentName.textContent ?? "",
    manuscripts: buttons.map((button) => button.dataset.explorerFileName ?? ""),
    activeManuscript: active?.dataset.explorerFileName ?? null,
    text: editor.dataset.smokeText ?? "",
    statusKind: status.dataset.state ?? "",
    statusMessage: status.textContent ?? "",
    saveEnabled: !save.disabled
  };
})()`;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readRendererState(window: BrowserWindow): Promise<WorkspaceRendererState | null> {
  try {
    return await window.webContents.executeJavaScript(READ_STATE_SCRIPT, true) as WorkspaceRendererState | null;
  } catch (_error: unknown) {
    return null;
  }
}

async function waitForState(
  window: BrowserWindow,
  predicate: (state: WorkspaceRendererState) => boolean,
  description: string
): Promise<WorkspaceRendererState> {
  const deadline = Date.now() + STATE_TIMEOUT_MS;
  let lastState: WorkspaceRendererState | null = null;
  while (Date.now() < deadline) {
    lastState = await readRendererState(window);
    if (lastState && predicate(lastState)) return lastState;
    await delay(POLL_INTERVAL_MS);
  }

  const details = lastState
    ? ` Last state: ${lastState.statusKind} (${lastState.statusMessage}), active ${lastState.activeManuscript ?? "none"}.`
    : " Renderer probe was not available.";
  throw new Error(`Workspace smoke timed out while waiting for ${description}.${details}`);
}

async function clickOpenDocument(window: BrowserWindow): Promise<void> {
  const clicked = await window.webContents.executeJavaScript(`(() => {
    const button = document.querySelector("#open-markdown");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`, true) as boolean;
  if (!clicked) throw new Error("Workspace smoke could not click Open Document.");
}

async function clickManuscript(window: BrowserWindow, displayName: string): Promise<void> {
  const clicked = await window.webContents.executeJavaScript(`(() => {
    const wanted = ${JSON.stringify(displayName)};
    const button = [...document.querySelectorAll("#explorer-tree button[data-explorer-file-id]")]
      .find((candidate) => candidate.dataset.explorerFileName === wanted);
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`, true) as boolean;
  if (!clicked) throw new Error(`Workspace smoke could not select ${displayName}.`);
}

async function queueDecision(window: BrowserWindow, decision: "save" | "discard" | "cancel"): Promise<void> {
  await window.webContents.executeJavaScript(
    `window.dispatchEvent(new CustomEvent("maginalia-smoke-decision", { detail: ${JSON.stringify(decision)} }));`,
    true
  );
}

async function appendText(window: BrowserWindow, text: string): Promise<void> {
  await window.webContents.executeJavaScript(
    `document.querySelector("#editor")?.dispatchEvent(new CustomEvent("maginalia-smoke-append", { detail: ${JSON.stringify(text)} }));`,
    true
  );
}

async function focusEditor(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript(
    "document.querySelector(\"#editor\")?.dispatchEvent(new Event(\"maginalia-smoke-focus\"));",
    true
  );
}

async function sendCtrlS(window: BrowserWindow): Promise<void> {
  window.show();
  window.focus();
  window.webContents.focus();
  await focusEditor(window);
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "S", modifiers: ["control"] });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "S", modifiers: ["control"] });
}

function assertEqual(actual: string, expected: string, description: string): void {
  if (actual !== expected) {
    throw new Error(`${description}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
  }
}

function assertState(state: WorkspaceRendererState, expected: {
  readonly documentName: string;
  readonly manuscripts: readonly string[];
  readonly activeManuscript: string | null;
  readonly text: string;
  readonly statusKind: string;
  readonly saveEnabled: boolean;
}, description: string): void {
  assertEqual(state.documentName, expected.documentName, `${description} Document name`);
  assertEqual(JSON.stringify(state.manuscripts), JSON.stringify(expected.manuscripts), `${description} manuscript list`);
  assertEqual(state.activeManuscript ?? "", expected.activeManuscript ?? "", `${description} active manuscript`);
  assertEqual(state.text, expected.text, `${description} editor text`);
  assertEqual(state.statusKind, expected.statusKind, `${description} status`);
  if (state.saveEnabled !== expected.saveEnabled) {
    throw new Error(`${description} Save enabled state: expected ${expected.saveEnabled}, got ${state.saveEnabled}.`);
  }
}

export async function runWorkspaceSmoke(window: BrowserWindow, fixtureRoot: string): Promise<void> {
  const manuscriptPath = path.join(fixtureRoot, "manuscript.md");
  const notesPath = path.join(fixtureRoot, "notes.md");
  const initialText = await readFile(manuscriptPath, "utf8");
  const notesText = await readFile(notesPath, "utf8");
  const documentName = path.basename(path.resolve(fixtureRoot));
  const explorerTree = ["manuscript.md", "notes.md"];

  await waitForState(
    window,
    (state) => state.statusKind === "empty" && !state.saveEnabled,
    "the workspace renderer to be ready"
  );
  await clickOpenDocument(window);

  const opened = await waitForState(
    window,
    (state) => state.statusKind === "saved"
      && !state.saveEnabled
      && state.documentName === documentName
      && state.manuscripts.length === explorerTree.length
      && state.activeManuscript === "manuscript.md"
      && state.text === initialText,
    "the Document and first manuscript to open"
  );
  assertState(opened, {
    documentName,
    manuscripts: explorerTree,
    activeManuscript: "manuscript.md",
    text: initialText,
    statusKind: "saved",
    saveEnabled: false
  }, "opened state");

  const edit = "追記";
  const expectedText = `${initialText}${edit}`;
  await appendText(window, edit);
  const modified = await waitForState(
    window,
    (state) => state.statusKind === "modified" && state.saveEnabled && state.text === expectedText,
    "the manuscript edit to become Modified"
  );
  assertState(modified, {
    documentName,
    manuscripts: explorerTree,
    activeManuscript: "manuscript.md",
    text: expectedText,
    statusKind: "modified",
    saveEnabled: true
  }, "modified state");

  await queueDecision(window, "cancel");
  await clickManuscript(window, "notes.md");
  await delay(POLL_INTERVAL_MS * 2);
  const cancelled = await readRendererState(window);
  if (!cancelled) throw new Error("Workspace smoke could not read the cancelled-switch state.");
  assertState(cancelled, {
    documentName,
    manuscripts: explorerTree,
    activeManuscript: "manuscript.md",
    text: expectedText,
    statusKind: "modified",
    saveEnabled: true
  }, "cancelled switch state");

  await queueDecision(window, "save");
  await clickManuscript(window, "notes.md");
  const switched = await waitForState(
    window,
    (state) => state.statusKind === "saved"
      && !state.saveEnabled
      && state.activeManuscript === "notes.md"
      && state.text === notesText,
    "the saved manuscript to switch to notes.md"
  );
  assertState(switched, {
    documentName,
    manuscripts: explorerTree,
    activeManuscript: "notes.md",
    text: notesText,
    statusKind: "saved",
    saveEnabled: false
  }, "notes state");
  assertEqual(await readFile(manuscriptPath, "utf8"), expectedText, "manuscript.md disk text after switch save");

  const editedNotesText = `${notesText}追記`;
  await appendText(window, "追記");
  const modifiedNotes = await waitForState(
    window,
    (state) => state.statusKind === "modified"
      && state.saveEnabled
      && state.activeManuscript === "notes.md"
      && state.text === editedNotesText,
    "the notes edit to become Modified"
  );
  assertState(modifiedNotes, {
    documentName,
    manuscripts: explorerTree,
    activeManuscript: "notes.md",
    text: editedNotesText,
    statusKind: "modified",
    saveEnabled: true
  }, "modified notes state");

  await sendCtrlS(window);
  const savedNotes = await waitForState(
    window,
    (state) => state.statusKind === "saved"
      && !state.saveEnabled
      && state.activeManuscript === "notes.md"
      && state.text === editedNotesText,
    "the notes Ctrl+S save to complete"
  );
  assertState(savedNotes, {
    documentName,
    manuscripts: explorerTree,
    activeManuscript: "notes.md",
    text: editedNotesText,
    statusKind: "saved",
    saveEnabled: false
  }, "saved notes state");
  assertEqual(await readFile(notesPath, "utf8"), editedNotesText, "notes.md disk text after Ctrl+S");

  await clickManuscript(window, "manuscript.md");
  const reopened = await waitForState(
    window,
    (state) => state.statusKind === "saved"
      && !state.saveEnabled
      && state.activeManuscript === "manuscript.md"
      && state.text === expectedText,
    "the saved manuscript to reopen"
  );
  assertState(reopened, {
    documentName,
    manuscripts: explorerTree,
    activeManuscript: "manuscript.md",
    text: expectedText,
    statusKind: "saved",
    saveEnabled: false
  }, "reopened state");
  assertEqual(await readFile(manuscriptPath, "utf8"), expectedText, "manuscript.md disk text after reopen");
}
