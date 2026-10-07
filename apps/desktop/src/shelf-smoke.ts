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
  readonly libraryErrorMessage: string;
  readonly libraryResultText: string;
  readonly libraryResultHtml: string;
  readonly resultCount: number;
  readonly referencesStatusKind: string;
  readonly referencesStatusMessage: string;
  readonly referencesUnresolved: string;
  readonly referencesRefreshEnabled: boolean;
}

const READ_STATE_SCRIPT = `(() => {
  const editor = document.querySelector("#editor");
  const documentName = document.querySelector("#workspace-document-name");
  const explorerTree = document.querySelector("#explorer-tree");
  const status = document.querySelector("#document-status");
  const save = document.querySelector("#save-markdown");
  const libraryStatus = document.querySelector("#library-status");
  const libraryError = document.querySelector("#library-error");
  const results = document.querySelector("#library-results");
  const referencesStatus = document.querySelector("#references-status");
  const referencesUnresolved = document.querySelector("#references-unresolved");
  const referencesRefresh = document.querySelector("#refresh-references");
  if (!editor || editor.dataset.smokeReady !== "shelf" || !documentName || !explorerTree
    || !status || !save || !libraryStatus || !libraryError || !results || !referencesStatus
    || !referencesUnresolved || !referencesRefresh) return null;
  const manuscriptButtons = [...explorerTree.querySelectorAll("button[data-explorer-file-id]")];
  const active = manuscriptButtons.find((button) => button.getAttribute("aria-current") === "page");
  return {
    smokeReady: true,
    documentName: documentName.textContent ?? "",
    manuscripts: manuscriptButtons.map((button) => button.dataset.explorerFileName ?? button.textContent ?? ""),
    activeManuscript: active?.dataset.explorerFileName ?? active?.textContent ?? null,
    text: editor.dataset.smokeText ?? "",
    statusKind: status.dataset.state ?? "",
    statusMessage: status.textContent ?? "",
    saveEnabled: !save.disabled,
    libraryStatusKind: libraryStatus.dataset.state ?? "",
    libraryStatusMessage: libraryStatus.textContent ?? "",
    libraryErrorMessage: libraryError.textContent ?? "",
    libraryResultText: results.textContent ?? "",
    libraryResultHtml: results.innerHTML ?? "",
    resultCount: results.querySelectorAll(".library-result").length,
    referencesStatusKind: referencesStatus.dataset.state ?? "",
    referencesStatusMessage: referencesStatus.textContent ?? "",
    referencesUnresolved: referencesUnresolved.textContent ?? "",
    referencesRefreshEnabled: !referencesRefresh.disabled
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
    ? ` Last state: document ${lastState.statusKind} (${lastState.statusMessage}), Shelf ${lastState.libraryStatusKind} (${lastState.libraryStatusMessage}; ${lastState.libraryErrorMessage}), References ${lastState.referencesStatusKind} (${lastState.referencesStatusMessage}; ${lastState.referencesUnresolved}), text ${JSON.stringify(lastState.text)}.`
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

async function replaceEditorText(window: BrowserWindow, text: string): Promise<void> {
  await window.webContents.executeJavaScript(
    `document.querySelector("#editor")?.dispatchEvent(new CustomEvent("maginalia-smoke-replace", { detail: ${JSON.stringify(text)} }));`,
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
  const marker = "<!-- maginalia:quote-ref v1 {\"quoteId\":\"ann:01ARZ3NDEKTSV4RRFFQ69G5FAV\",\"mode\":\"normal\"} -->";
  const sameBookMarker = "<!-- maginalia:quote-ref v1 {\"quoteId\":\"ann:01ARZ3NDEKTSV4RRFFQ69G5FAW\",\"mode\":\"normal\"} -->";
  const secondBookMarker = "<!-- maginalia:quote-ref v1 {\"quoteId\":\"ann:01ARZ3NDEKTSV4RRFFQ69G5FAX\",\"mode\":\"normal\"} -->";
  const referenceStart = "<!-- maginalia:reference-list-start v1 -->";
  const referenceEnd = "<!-- maginalia:reference-list-end v1 -->";
  const firstBookTitle = "Shelf Smoke Book";
  const secondBookTitle = "Shelf Smoke Second Book";
  const manualReferenceText = "手書きの参考メモは保持されます。";

  await waitForState(
    window,
    (state) => state.smokeReady
      && state.statusKind === "empty"
      && !state.saveEnabled
      && state.referencesStatusKind === "empty"
      && !state.referencesRefreshEnabled,
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

  await dispatchEditorEvent(window, "maginalia-smoke-cursor-end");
  await search(window, "二つ目");
  const sameBookResult = await waitForState(
    window,
    (state) => state.libraryStatusKind === "ready" && state.resultCount === 1,
    "the same-book Reviewer result"
  );
  assertTrue(sameBookResult.libraryResultText.includes("同じ本からの二つ目の引用です。"), "Shelf omitted the same-book quote");
  await clickInsert(window);
  const sameBookInserted = await waitForState(
    window,
    (state) => state.statusKind === "modified"
      && state.text.includes(sameBookMarker)
      && state.referencesStatusKind === "needs-refresh",
    "the second same-book QuoteRef insertion"
  );
  assertEqual(sameBookInserted.text.split(marker).length - 1, 1, "first same-book QuoteRef marker count");
  assertEqual(sameBookInserted.text.split(sameBookMarker).length - 1, 1, "second same-book QuoteRef marker count");

  await clickButton(window, "#refresh-references", "Refresh References");
  const oneSource = await waitForState(
    window,
    (state) => state.referencesStatusKind === "ready"
      && state.referencesUnresolved === "Unresolved: 0"
      && state.text.includes(referenceStart)
      && state.text.includes(referenceEnd)
      && state.text.includes(firstBookTitle),
    "the derived Reference List for one source"
  );
  assertEqual(oneSource.text.split(firstBookTitle).length - 1, 1, "same-book source deduplication");
  assertTrue(oneSource.text.includes(manualReferenceText), "Reference refresh removed manual text");

  await dispatchEditorEvent(window, "maginalia-smoke-cursor-end");
  await search(window, "別の本");
  const secondBookResult = await waitForState(
    window,
    (state) => state.libraryStatusKind === "ready" && state.resultCount === 1,
    "the second-book Reviewer result"
  );
  assertTrue(secondBookResult.libraryResultText.includes(secondBookTitle), "Shelf omitted the second-book title");
  await clickInsert(window);
  await waitForState(
    window,
    (state) => state.statusKind === "modified"
      && state.text.includes(secondBookMarker)
      && state.referencesStatusKind === "needs-refresh",
    "the second-book QuoteRef insertion"
  );
  await clickButton(window, "#refresh-references", "Refresh References for two sources");
  const twoSources = await waitForState(
    window,
    (state) => state.referencesStatusKind === "ready"
      && state.referencesUnresolved === "Unresolved: 0"
      && state.text.includes(firstBookTitle)
      && state.text.includes(secondBookTitle),
    "the derived Reference List for two sources"
  );
  assertEqual(twoSources.text.split(firstBookTitle).length - 1, 1, "first source remains deduplicated");
  assertEqual(twoSources.text.split(secondBookTitle).length - 1, 1, "second source appears once");
  const twoSourceText = twoSources.text;

  await clickButton(window, "#save-markdown", "Save with derived References");
  const saved = await waitForState(
    window,
    (state) => state.statusKind === "saved" && !state.saveEnabled && state.text === twoSourceText,
    "the derived Reference List save"
  );
  assertEqual(saved.text, await readFile(manuscriptPath, "utf8"), "saved derived Reference List text");

  await reloadRenderer(window);
  await waitForState(
    window,
    (state) => state.statusKind === "empty" && !state.saveEnabled && state.referencesStatusKind === "empty",
    "the reloaded Shelf renderer before reopening"
  );
  await clickButton(window, "#open-markdown", "Open Project after derived Reference save");
  const reopened = await waitForState(
    window,
    (state) => state.statusKind === "saved"
      && !state.saveEnabled
      && state.activeManuscript === "manuscript.md"
      && state.text === twoSourceText
      && state.referencesStatusKind === "needs-refresh",
    "the saved two-source Reference List after reopening"
  );
  assertEqual(reopened.text, twoSourceText, "reopened derived Reference List text");
  await clickButton(window, "#refresh-references", "Repeat Refresh References after reopen");
  const repeated = await waitForState(
    window,
    (state) => state.referencesStatusKind === "ready" && state.text === twoSourceText,
    "the byte-identical Reference List refresh"
  );
  assertEqual(repeated.text, twoSourceText, "repeated Reference List refresh");

  const withoutSecondBook = repeated.text.replace(secondBookMarker, "");
  assertTrue(withoutSecondBook !== repeated.text, "second-book QuoteRef was not present for removal");
  await replaceEditorText(window, withoutSecondBook);
  const deleted = await waitForState(
    window,
    (state) => state.statusKind === "modified"
      && state.referencesStatusKind === "needs-refresh"
      && !state.text.includes(secondBookMarker),
    "the final second-book QuoteRef removal"
  );
  assertTrue(deleted.text.includes(firstBookTitle), "deleting a QuoteRef removed the first source too early");
  await clickButton(window, "#refresh-references", "Refresh References after deleting a source");
  const removedSource = await waitForState(
    window,
    (state) => state.referencesStatusKind === "ready"
      && state.text.includes(firstBookTitle)
      && !state.text.includes(secondBookTitle)
      && state.text.includes(manualReferenceText),
    "the Reference List after removing the final second-book QuoteRef"
  );
  assertEqual(removedSource.text.split(firstBookTitle).length - 1, 1, "remaining source count after deletion");
  assertTrue(!removedSource.text.includes(secondBookTitle), "deleted source remained in generated References");
  await clickButton(window, "#save-markdown", "Save after deleting a source");
  const finalSaved = await waitForState(
    window,
    (state) => state.statusKind === "saved" && !state.saveEnabled,
    "the final derived Reference List save"
  );
  assertEqual(finalSaved.text, await readFile(manuscriptPath, "utf8"), "final saved Reference List text");

  assertTrue(finalSaved.text.includes(marker), "final Markdown lost the first QuoteRef");
  assertTrue(finalSaved.text.includes(sameBookMarker), "final Markdown lost the same-book QuoteRef");
  assertTrue(finalSaved.text.includes(referenceStart) && finalSaved.text.includes(referenceEnd), "final Markdown lost Reference markers");
  assertTrue(finalSaved.text.includes(manualReferenceText), "final Markdown lost manual reference text");
  assertTrue(!finalSaved.text.includes(SHELF_SMOKE_QUOTE), "final Markdown embedded resolved quotation text");
  assertTrue(!finalSaved.text.includes("同じ本からの二つ目の引用です。"), "final Markdown embedded same-book quotation text");
  assertTrue(!finalSaved.text.includes("別の本からの引用です。"), "final Markdown embedded second-book quotation text");

  /*
   * Keep the original Slice C assertions explicit: the authoring document
   * contains stable QuoteRefs, never resolved quotation metadata.
   */
  assertTrue(finalSaved.text.split(marker).length - 1 === 1, "final first QuoteRef marker count");
  assertTrue(finalSaved.text.split(sameBookMarker).length - 1 === 1, "final same-book QuoteRef marker count");
}
