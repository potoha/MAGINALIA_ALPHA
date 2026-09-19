import { readFile } from "node:fs/promises";
import * as path from "node:path";
import type { BrowserWindow } from "electron";

const POLL_INTERVAL_MS = 25;
const STATE_TIMEOUT_MS = 15_000;

export const SHELF_SMOKE_ANNOTATION_ID = "2b6c4e0c-7268-4da0-9ad3-f5d1c8b7f2a1";
export const SHELF_SMOKE_TITLE = "Shelf Smoke Book";
export const SHELF_SMOKE_AUTHOR = "Shelf Smoke Author";
export const SHELF_SMOKE_PAGE = "42";
export const SHELF_SMOKE_QUOTE = "これは日本語の引用です。";
export const SHELF_SMOKE_COMMENT = "Shelf smoke comment";

interface ShelfRendererState {
  readonly smokeReady: boolean;
  readonly documentName: string;
  readonly manuscripts: readonly string[];
  readonly activeManuscript: string | null;
  readonly text: string;
  readonly statusKind: string;
  readonly statusMessage: string;
  readonly saveEnabled: boolean;
  readonly libraryStatusKind: string;
  readonly libraryStatusMessage: string;
  readonly libraryResultText: string;
  readonly libraryResultHtml: string;
  readonly resultCount: number;
}

const READ_STATE_SCRIPT = `(() => {
  const editor = document.querySelector("#editor");
  const documentName = document.querySelector("#workspace-document-name");
  const manuscriptList = document.querySelector("#manuscript-list");
  const status = document.querySelector("#document-status");
  const save = document.querySelector("#save-markdown");
  const libraryStatus = document.querySelector("#library-status");
  const results = document.querySelector("#library-results");
  if (!editor || editor.dataset.smokeReady !== "shelf" || !documentName || !manuscriptList
    || !status || !save || !libraryStatus || !results) return null;
  const manuscriptButtons = [...manuscriptList.querySelectorAll("button[data-manuscript-id]")];
  const active = manuscriptButtons.find((button) => button.getAttribute("aria-current") === "page");
  return {
    smokeReady: true,
    documentName: documentName.textContent ?? "",
    manuscripts: manuscriptButtons.map((button) => button.dataset.manuscriptName ?? button.textContent ?? ""),
    activeManuscript: active?.dataset.manuscriptName ?? active?.textContent ?? null,
    text: editor.dataset.smokeText ?? "",
    statusKind: status.dataset.state ?? "",
    statusMessage: status.textContent ?? "",
    saveEnabled: !save.disabled,
    libraryStatusKind: libraryStatus.dataset.state ?? "",
    libraryStatusMessage: libraryStatus.textContent ?? "",
    libraryResultText: results.textContent ?? "",
    libraryResultHtml: results.innerHTML ?? "",
    resultCount: results.querySelectorAll(".library-result").length
  };
})()`;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readRendererState(window: BrowserWindow): Promise<ShelfRendererState | null> {
  try {
    return await window.webContents.executeJavaScript(READ_STATE_SCRIPT, true) as ShelfRendererState | null;
  } catch (_error: unknown) {
    return null;
  }
}

async function waitForState(
  window: BrowserWindow,
  predicate: (state: ShelfRendererState) => boolean,
  description: string
): Promise<ShelfRendererState> {
  const deadline = Date.now() + STATE_TIMEOUT_MS;
  let lastState: ShelfRendererState | null = null;
  while (Date.now() < deadline) {
    lastState = await readRendererState(window);
    if (lastState && predicate(lastState)) return lastState;
    await delay(POLL_INTERVAL_MS);
  }
  const details = lastState
    ? ` Last state: document ${lastState.statusKind} (${lastState.statusMessage}), Shelf ${lastState.libraryStatusKind} (${lastState.libraryStatusMessage}), text ${JSON.stringify(lastState.text)}.`
    : " Renderer probe was not available.";
  throw new Error(`Shelf smoke timed out while waiting for ${description}.${details}`);
}

async function clickButton(window: BrowserWindow, selector: string, description: string): Promise<void> {
  const clicked = await window.webContents.executeJavaScript(
    `(() => {
      const button = document.querySelector(${JSON.stringify(selector)});
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.click();
      return true;
    })()`,
    true
  ) as boolean;
  if (!clicked) throw new Error(`Shelf smoke could not click ${description}.`);
}

async function search(window: BrowserWindow, query: string): Promise<void> {
  const submitted = await window.webContents.executeJavaScript(
    `(() => {
      const input = document.querySelector("#library-query");
      const button = document.querySelector("#library-search");
      if (!(input instanceof HTMLInputElement) || !(button instanceof HTMLButtonElement) || button.disabled) return false;
      input.value = ${JSON.stringify(query)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      button.click();
      return true;
    })()`,
    true
  ) as boolean;
  if (!submitted) throw new Error("Shelf smoke could not submit the Reviewer search.");
}

async function clickInsert(window: BrowserWindow): Promise<void> {
  const clicked = await window.webContents.executeJavaScript(
    `(() => {
      const button = [...document.querySelectorAll("#library-results button")]
        .find((candidate) => candidate.textContent?.trim() === "Insert");
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.click();
      return true;
    })()`,
    true
  ) as boolean;
  if (!clicked) throw new Error("Shelf smoke could not click Insert.");
}

async function dispatchEditorEvent(window: BrowserWindow, name: string): Promise<void> {
  await window.webContents.executeJavaScript(
    `document.querySelector("#editor")?.dispatchEvent(new Event(${JSON.stringify(name)}));`,
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

function assertTrue(value: boolean, description: string): void {
  if (!value) throw new Error(description + ".");
}

function assertEqual<T>(actual: T, expected: T, description: string): void {
  if (actual !== expected) {
    throw new Error(`${description}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
  }
}

export async function runShelfSmoke(window: BrowserWindow, smokeRoot: string): Promise<void> {
  const root = path.resolve(smokeRoot);
  const manuscriptPath = path.join(root, "manuscript.md");
  const initialText = await readFile(manuscriptPath, "utf8");
  const expectedDocumentName = path.basename(root);
  const marker = `<!-- maginalia:quote-ref v1 {"quoteId":"${SHELF_SMOKE_ANNOTATION_ID}","mode":"normal"} -->`;

  await waitForState(
    window,
    (state) => state.smokeReady && state.statusKind === "empty" && !state.saveEnabled,
    "the Shelf renderer to be ready"
  );
  await clickButton(window, "#open-markdown", "Open Project");

  const opened = await waitForState(
    window,
    (state) => state.statusKind === "saved"
      && !state.saveEnabled
      && state.documentName === expectedDocumentName
      && JSON.stringify(state.manuscripts) === JSON.stringify(["manuscript.md", "notes.md"])
      && state.activeManuscript === "manuscript.md"
      && state.text === initialText,
    "the Project and Markdown manuscript to open"
  );
  assertTrue(opened.text.startsWith("\uFEFF"), "opened Markdown lost its UTF-8 BOM");
  assertTrue(opened.text.includes("\r\n"), "opened Markdown lost its CRLF line endings");
  await dispatchEditorEvent(window, "maginalia-smoke-cursor-end");

  await search(window, "日本語");
  const searched = await waitForState(
    window,
    (state) => state.libraryStatusKind === "ready" && state.resultCount === 1,
    "the Japanese Reviewer result"
  );
  for (const value of [SHELF_SMOKE_TITLE, SHELF_SMOKE_AUTHOR, `p. ${SHELF_SMOKE_PAGE}`, SHELF_SMOKE_QUOTE, SHELF_SMOKE_COMMENT]) {
    assertTrue(searched.libraryResultText.includes(value), `Shelf result omitted ${value}`);
  }
  assertTrue(searched.libraryResultHtml.includes("library-result"), "Shelf result was not rendered as a compact result row");

  await clickInsert(window);
  const inserted = await waitForState(
    window,
    (state) => state.statusKind === "modified"
      && state.saveEnabled
      && state.activeManuscript === "manuscript.md"
      && state.text.includes(marker),
    "the QuoteRef insertion to make the Markdown dirty"
  );
  assertEqual(inserted.text.split(marker).length - 1, 1, "QuoteRef marker count");
  assertTrue(!inserted.text.includes(SHELF_SMOKE_QUOTE), "Shelf insertion embedded the quotation text");
  assertTrue(!inserted.text.includes(SHELF_SMOKE_TITLE), "Shelf insertion embedded the title");
  assertTrue(!inserted.text.includes(SHELF_SMOKE_AUTHOR), "Shelf insertion embedded the author");

  await clickButton(window, "#save-markdown", "Save");
  const saved = await waitForState(
    window,
    (state) => state.statusKind === "saved" && !state.saveEnabled && state.text.includes(marker),
    "the QuoteRef Markdown save"
  );
  assertEqual(saved.text, await readFile(manuscriptPath, "utf8"), "saved Markdown text");
  const savedText = await readFile(manuscriptPath, "utf8");
  assertEqual(savedText.split(marker).length - 1, 1, "saved QuoteRef marker count");
  assertTrue(!savedText.includes(SHELF_SMOKE_QUOTE), "saved Markdown embedded the quotation text");
  assertTrue(!savedText.includes(SHELF_SMOKE_TITLE), "saved Markdown embedded the title");
  assertTrue(!savedText.includes(SHELF_SMOKE_AUTHOR), "saved Markdown embedded the author");

  await reloadRenderer(window);
  await waitForState(
    window,
    (state) => state.statusKind === "empty" && !state.saveEnabled,
    "the reloaded Shelf renderer"
  );
  await clickButton(window, "#open-markdown", "Open Project after reload");
  const reopened = await waitForState(
    window,
    (state) => state.statusKind === "saved"
      && !state.saveEnabled
      && state.activeManuscript === "manuscript.md"
      && state.text === savedText,
    "the saved QuoteRef after reopening the Project"
  );
  assertEqual(reopened.text.split(marker).length - 1, 1, "reopened QuoteRef marker count");
  assertTrue(!reopened.text.includes(SHELF_SMOKE_QUOTE), "reopened Markdown embedded the quotation text");
}
