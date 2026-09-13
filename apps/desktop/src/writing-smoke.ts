import { readFile } from "node:fs/promises";
import type { BrowserWindow } from "electron";

const POLL_INTERVAL_MS = 25;
const STATE_TIMEOUT_MS = 15_000;

interface RendererState {
  readonly text: string;
  readonly statusKind: string;
  readonly statusMessage: string;
  readonly saveEnabled: boolean;
}

const READ_STATE_SCRIPT = `(() => {
  const status = document.querySelector("#document-status");
  const save = document.querySelector("#save-markdown");
  const editor = document.querySelector("#editor");
  if (!editor || editor.dataset.smokeReady !== "true" || !status || !save) return null;
  return {
    text: editor.dataset.smokeText ?? "",
    statusKind: status.dataset.state ?? "",
    statusMessage: status.textContent ?? "",
    saveEnabled: !save.disabled
  };
})()`;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readRendererState(window: BrowserWindow): Promise<RendererState | null> {
  try {
    return await window.webContents.executeJavaScript(READ_STATE_SCRIPT, true) as RendererState | null;
  } catch (_error: unknown) {
    return null;
  }
}

async function waitForState(
  window: BrowserWindow,
  predicate: (state: RendererState) => boolean,
  description: string
): Promise<RendererState> {
  const deadline = Date.now() + STATE_TIMEOUT_MS;
  let lastState: RendererState | null = null;
  while (Date.now() < deadline) {
    lastState = await readRendererState(window);
    if (lastState && predicate(lastState)) return lastState;
    await delay(POLL_INTERVAL_MS);
  }

  const details = lastState
    ? ` Last state: ${lastState.statusKind} (${lastState.statusMessage}).`
    : " Renderer probe was not available.";
  throw new Error(`Writing smoke timed out while waiting for ${description}.${details}`);
}

async function clickOpen(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript(
    "document.querySelector(\"#open-markdown\")?.click();",
    true
  );
}

async function appendText(window: BrowserWindow, text: string): Promise<void> {
  await window.webContents.executeJavaScript(
    `document.querySelector("#editor")?.dispatchEvent(new CustomEvent("maginalia-smoke-append", { detail: ${JSON.stringify(text)} }));`,
    true
  );
}

async function reloadRenderer(window: BrowserWindow): Promise<void> {
  const finished = new Promise<void>((resolve) => {
    window.webContents.once("did-finish-load", () => resolve());
  });
  window.webContents.reload();
  await finished;
}

function assertEqual(actual: string, expected: string, description: string): void {
  if (actual !== expected) {
    throw new Error(`${description}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
  }
}

export async function runWritingSmoke(window: BrowserWindow, fixturePath: string): Promise<void> {
  await clickOpen(window);

  const opened = await waitForState(
    window,
    (state) => state.statusKind === "saved" && !state.saveEnabled,
    "the opened document to be Saved"
  );
  const diskText = await readFile(fixturePath, "utf8");
  assertEqual(opened.text, diskText, "opened renderer text must match the fixture");
  if (!opened.text.startsWith("\uFEFF")) throw new Error("opened text lost its UTF-8 BOM");
  if (!opened.text.includes("\r\n")) throw new Error("opened text lost its CRLF line endings");
  if (!/[\u3040-\u30ff]/u.test(opened.text)) throw new Error("opened text lost its Japanese content");

  const edit = "追記";
  const expectedText = `${opened.text}${edit}`;
  await appendText(window, edit);
  const modified = await waitForState(
    window,
    (state) => state.statusKind === "modified" && state.saveEnabled,
    "the edited document to be Modified"
  );
  assertEqual(modified.text, expectedText, "edited renderer text");

  window.show();
  window.focus();
  window.webContents.focus();
  await window.webContents.executeJavaScript(
    "document.querySelector(\"#editor\")?.dispatchEvent(new Event(\"maginalia-smoke-focus\"));",
    true
  );
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "S", modifiers: ["control"] });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "S", modifiers: ["control"] });

  const saved = await waitForState(
    window,
    (state) => state.statusKind === "saved" && !state.saveEnabled,
    "the Ctrl+S save to complete"
  );
  assertEqual(saved.text, expectedText, "saved renderer text");
  assertEqual(await readFile(fixturePath, "utf8"), expectedText, "saved file text");

  await reloadRenderer(window);
  await waitForState(
    window,
    (state) => state.statusKind === "empty" && !state.saveEnabled,
    "the reloaded renderer to be ready"
  );
  await clickOpen(window);
  const reopened = await waitForState(
    window,
    (state) => state.statusKind === "saved" && !state.saveEnabled,
    "the reopened document to be Saved"
  );
  assertEqual(reopened.text, expectedText, "reopened renderer text");
  assertEqual(await readFile(fixturePath, "utf8"), expectedText, "reopened file text");
}
