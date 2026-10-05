import { readFile } from "node:fs/promises";
import * as path from "node:path";
import type { BrowserWindow } from "electron";

const POLL_INTERVAL_MS = 25;
const STATE_TIMEOUT_MS = 15_000;

export const QUOTATION_SMOKE_BOOK_TITLE = "Smoke Book Title";
export const QUOTATION_SMOKE_AUTHOR = "Smoke Author";
export const QUOTATION_SMOKE_SOURCE_ID = "isbn:9781234567890";
export const QUOTATION_SMOKE_ANNOTATION_ID = "ann:01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const QUOTATION_SMOKE_QUOTE = "これは引用 QUOTATIONTEXTSENTINEL";
export const QUOTATION_SMOKE_MEMO = "PRIVATE_MEMO_ONLY_SENTINEL";
export const QUOTATION_SMOKE_RAW_OCR = "PRIVATE_RAW_OCR_SENTINEL";
export const QUOTATION_SMOKE_CAPTURE_IMAGE = "PRIVATE_CAPTURE_IMAGE_SENTINEL";
export const QUOTATION_SMOKE_LOCAL_PATH = "PRIVATE_LOCAL_PATH_SENTINEL";
export const QUOTATION_SMOKE_DEVICE_METADATA = "PRIVATE_DEVICE_METADATA_SENTINEL";
export const QUOTATION_SMOKE_COMMENT = "PRIVATE_COMMENT_SENTINEL";
export const QUOTATION_SMOKE_ATTRIBUTION = "PRIVATE_ATTRIBUTION_SENTINEL";
export const QUOTATION_SMOKE_UNPUBLISHED = "PRIVATE_UNPUBLISHED_SENTINEL";

export const QUOTATION_SMOKE_PRIVATE_SENTINELS = Object.freeze([
  QUOTATION_SMOKE_MEMO,
  QUOTATION_SMOKE_RAW_OCR,
  QUOTATION_SMOKE_CAPTURE_IMAGE,
  QUOTATION_SMOKE_LOCAL_PATH,
  QUOTATION_SMOKE_DEVICE_METADATA,
  QUOTATION_SMOKE_COMMENT,
  QUOTATION_SMOKE_ATTRIBUTION,
  QUOTATION_SMOKE_UNPUBLISHED
]);

interface QuotationRendererState {
  readonly smokeReady: boolean;
  readonly documentName: string;
  readonly manuscripts: readonly string[];
  readonly activeManuscript: string | null;
  readonly text: string;
  readonly statusKind: string;
  readonly statusMessage: string;
  readonly saveEnabled: boolean;
  readonly libraryName: string;
  readonly libraryStatusKind: string;
  readonly libraryStatusMessage: string;
  readonly libraryResultText: string;
  readonly libraryResultHtml: string;
  readonly resultCount: number;
}

const READ_STATE_SCRIPT = [
  "(() => {",
  "  const editor = document.querySelector('#editor');",
  "  const documentName = document.querySelector('#workspace-document-name');",
  "  const manuscriptList = document.querySelector('#manuscript-list');",
  "  const status = document.querySelector('#document-status');",
  "  const save = document.querySelector('#save-markdown');",
  "  const libraryName = document.querySelector('#library-name');",
  "  const libraryStatus = document.querySelector('#library-status');",
  "  const results = document.querySelector('#library-results');",
  "  if (!editor || editor.dataset.smokeReady !== 'quotation' || !documentName || !manuscriptList",
  "    || !status || !save || !libraryName || !libraryStatus || !results) return null;",
  "  const manuscriptButtons = [...manuscriptList.querySelectorAll('button[data-manuscript-id]')];",
  "  const active = manuscriptButtons.find((button) => button.getAttribute('aria-current') === 'page');",
  "  return {",
  "    smokeReady: true,",
  "    documentName: documentName.textContent ?? '',",
  "    manuscripts: manuscriptButtons.map((button) => button.textContent ?? ''),",
  "    activeManuscript: active?.textContent ?? null,",
  "    text: editor.dataset.smokeText ?? '',",
  "    statusKind: status.dataset.state ?? '',",
  "    statusMessage: status.textContent ?? '',",
  "    saveEnabled: !save.disabled,",
  "    libraryName: libraryName.textContent ?? '',",
  "    libraryStatusKind: libraryStatus.dataset.state ?? '',",
  "    libraryStatusMessage: libraryStatus.textContent ?? '',",
  "    libraryResultText: results.textContent ?? '',",
  "    libraryResultHtml: results.innerHTML ?? '',",
  "    resultCount: results.querySelectorAll('.library-result').length",
  "  };",
  "})()"
].join("\n");

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readRendererState(window: BrowserWindow): Promise<QuotationRendererState | null> {
  try {
    return await window.webContents.executeJavaScript(READ_STATE_SCRIPT, true) as QuotationRendererState | null;
  } catch (_error: unknown) {
    return null;
  }
}

async function waitForState(
  window: BrowserWindow,
  predicate: (state: QuotationRendererState) => boolean,
  description: string
): Promise<QuotationRendererState> {
  const deadline = Date.now() + STATE_TIMEOUT_MS;
  let lastState: QuotationRendererState | null = null;
  while (Date.now() < deadline) {
    lastState = await readRendererState(window);
    if (lastState && predicate(lastState)) return lastState;
    await delay(POLL_INTERVAL_MS);
  }
  const details = lastState
    ? " Last state: " + lastState.statusKind + " (" + lastState.statusMessage + "), library "
      + lastState.libraryStatusKind + " (" + lastState.libraryStatusMessage + "), text length "
      + lastState.text.length + ": " + JSON.stringify(lastState.text) + "."
    : " Renderer probe was not available.";
  throw new Error("Quotation smoke timed out while waiting for " + description + "." + details);
}

async function clickButton(window: BrowserWindow, selector: string, description: string): Promise<void> {
  const clicked = await window.webContents.executeJavaScript(
    "(() => {"
      + " const button = document.querySelector(" + JSON.stringify(selector) + ");"
      + " if (!(button instanceof HTMLButtonElement) || button.disabled) return false;"
      + " button.click(); return true;"
      + "})()",
    true
  ) as boolean;
  if (!clicked) throw new Error("Quotation smoke could not click " + description + ".");
}

async function search(window: BrowserWindow, query: string): Promise<void> {
  const submitted = await window.webContents.executeJavaScript(
    "(() => {"
      + " const input = document.querySelector('#library-query');"
      + " const button = document.querySelector('#library-search');"
      + " if (!(input instanceof HTMLInputElement) || !(button instanceof HTMLButtonElement) || button.disabled) return false;"
      + " input.value = " + JSON.stringify(query) + ";"
      + " input.dispatchEvent(new Event('input', { bubbles: true }));"
      + " button.click(); return true;"
      + "})()",
    true
  ) as boolean;
  if (!submitted) throw new Error("Quotation smoke could not submit the Library search.");
}

async function clickResultAction(window: BrowserWindow, action: "Select" | "Insert"): Promise<void> {
  const clicked = await window.webContents.executeJavaScript(
    "(() => {"
      + " const wanted = " + JSON.stringify(action) + ";"
      + " const button = [...document.querySelectorAll('#library-results button')]"
      + "   .find((candidate) => candidate.textContent?.trim() === wanted);"
      + " if (!(button instanceof HTMLButtonElement) || button.disabled) return false;"
      + " button.click(); return true;"
      + "})()",
    true
  ) as boolean;
  if (!clicked) throw new Error("Quotation smoke could not click the quotation " + action + " action.");
}

async function dispatchEditorEvent(window: BrowserWindow, name: string): Promise<void> {
  await window.webContents.executeJavaScript(
    "document.querySelector('#editor')?.dispatchEvent(new Event("
      + JSON.stringify(name) + "));",
    true
  );
}

async function sendEditorKey(window: BrowserWindow, keyCode: "S" | "Z"): Promise<void> {
  window.show();
  window.focus();
  window.webContents.focus();
  await dispatchEditorEvent(window, "maginalia-smoke-focus");
  window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers: ["control"] });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers: ["control"] });
}

async function reloadRenderer(window: BrowserWindow): Promise<void> {
  const finished = new Promise<void>((resolve) => {
    window.webContents.once("did-finish-load", () => resolve());
  });
  window.webContents.reload();
  await finished;
}

function assertEqual<T>(actual: T, expected: T, description: string): void {
  if (actual !== expected) {
    throw new Error(description + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual) + ".");
  }
}

function assertTrue(value: boolean, description: string): void {
  if (!value) throw new Error(description + ".");
}

function assertAbsent(text: string, values: readonly string[], description: string): void {
  for (const value of values) {
    if (text.includes(value)) throw new Error(description + " contained private evidence.");
  }
}

function assertReferenceOnly(state: QuotationRendererState): void {
  const publicValues = [
    QUOTATION_SMOKE_BOOK_TITLE,
    QUOTATION_SMOKE_AUTHOR,
    QUOTATION_SMOKE_SOURCE_ID,
    "p. 17"
  ];
  for (const value of publicValues) assertTrue(state.libraryResultText.includes(value), "reference result omitted public metadata");
  assertTrue(state.libraryResultText.includes(QUOTATION_SMOKE_MEMO), "Private Shelf search omitted its searchable personal memo");
  assertTrue(state.libraryResultText.includes(QUOTATION_SMOKE_QUOTE), "Private Shelf result omitted its quotation");
  assertAbsent(
    state.libraryResultText + state.libraryResultHtml,
    [QUOTATION_SMOKE_RAW_OCR, QUOTATION_SMOKE_CAPTURE_IMAGE, QUOTATION_SMOKE_LOCAL_PATH,
      QUOTATION_SMOKE_DEVICE_METADATA, QUOTATION_SMOKE_COMMENT, QUOTATION_SMOKE_ATTRIBUTION,
      QUOTATION_SMOKE_UNPUBLISHED, "rawOcr", "captureImage", "localPath", "deviceMetadata",
      "unpublishedComments", "comment", "attribution"],
    "reference result"
  );
}

export async function runQuotationSmoke(
  window: BrowserWindow,
  documentRoot: string,
  libraryRoot: string
): Promise<void> {
  const canonicalDocumentRoot = path.resolve(documentRoot);
  const canonicalLibraryRoot = path.resolve(libraryRoot);
  assertTrue(canonicalDocumentRoot !== canonicalLibraryRoot, "quotation smoke requires separate Document and Library roots");

  const manuscriptPath = path.join(canonicalDocumentRoot, "manuscript.md");
  const initialText = await readFile(manuscriptPath, "utf8");
  const documentName = path.basename(canonicalDocumentRoot);
  const quoteRef = `<!-- maginalia:quote-ref v1 ${JSON.stringify({
    quoteId: QUOTATION_SMOKE_ANNOTATION_ID,
    mode: "normal"
  })} -->`;

  await waitForState(
    window,
    (state) => state.smokeReady && state.statusKind === "empty" && !state.saveEnabled,
    "the quotation renderer to be ready"
  );
  await clickButton(window, "#open-markdown", "Open Document");

  const opened = await waitForState(
    window,
    (state) => state.statusKind === "saved"
      && !state.saveEnabled
      && state.documentName === documentName
      && JSON.stringify(state.manuscripts) === JSON.stringify(["manuscript.md", "notes.md"])
      && state.activeManuscript === "manuscript.md"
      && state.text === initialText,
    "the Document and first Manuscript to open"
  );
  assertTrue(opened.text.startsWith("\uFEFF"), "opened Document lost its UTF-8 BOM");
  assertTrue(opened.text.includes("\r\n"), "opened Document lost its CRLF line endings");
  assertTrue(/[\u3040-\u30ff]/u.test(opened.text), "opened Document lost its Japanese content");
  await dispatchEditorEvent(window, "maginalia-smoke-cursor-end");

  await waitForState(
    window,
    (state) => state.libraryName === "Private Shelf"
      && state.libraryStatusKind === "idle",
    "the configured Private Shelf to be ready"
  );

  await search(window, QUOTATION_SMOKE_MEMO);
  const searched = await waitForState(
    window,
    (state) => state.libraryStatusKind === "ready" && state.resultCount === 1,
    "the memo-only reference result"
  );
  assertReferenceOnly(searched);

  await clickResultAction(window, "Select");
  await waitForState(
    window,
    (state) => state.resultCount === 1 && state.libraryResultText.includes("Selected"),
    "the reference selection"
  );

  await clickResultAction(window, "Insert");
  const inserted = await waitForState(
    window,
    (state) => state.statusKind === "modified"
      && state.saveEnabled
      && state.activeManuscript === "manuscript.md"
      && state.text.startsWith(initialText)
      && state.text.includes(quoteRef),
    "the QuoteRef insertion to make the Manuscript dirty"
  );
  assertTrue(inserted.text.includes(QUOTATION_SMOKE_ANNOTATION_ID), "inserted QuoteRef omitted the opaque Shelf annotationId");
  assertTrue(!inserted.text.includes(QUOTATION_SMOKE_QUOTE), "QuoteRef insertion copied the quotation into Markdown");
  assertAbsent(inserted.text, QUOTATION_SMOKE_PRIVATE_SENTINELS, "inserted Document");
  assertReferenceOnly(inserted);
  const expectedText = inserted.text;

  await sendEditorKey(window, "Z");
  const undone = await waitForState(
    window,
    (state) => state.statusKind === "saved"
      && !state.saveEnabled
      && state.text === initialText,
    "the Monaco quotation edit to undo"
  );
  assertEqual(undone.text, initialText, "undo result");

  await dispatchEditorEvent(window, "maginalia-smoke-cursor-end");
  await clickResultAction(window, "Insert");
  await waitForState(
    window,
    (state) => state.statusKind === "modified"
      && state.saveEnabled
      && state.text === expectedText,
    "the quotation to be inserted again after undo"
  );

  await sendEditorKey(window, "S");
  const saved = await waitForState(
    window,
    (state) => state.statusKind === "saved"
      && !state.saveEnabled
      && state.text === expectedText,
    "the quotation save to complete"
  );
  assertEqual(saved.text, expectedText, "saved renderer text");
  const savedBytes = await readFile(manuscriptPath);
  assertTrue(savedBytes.equals(Buffer.from(expectedText, "utf8")), "saved manuscript bytes did not match expected UTF-8 content");
  assertTrue(savedBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), "saved manuscript lost its UTF-8 BOM bytes");
  assertTrue(savedBytes.includes(Buffer.from("\r\n", "utf8")), "saved manuscript lost its CRLF bytes");
  assertAbsent(savedBytes.toString("utf8"), QUOTATION_SMOKE_PRIVATE_SENTINELS, "saved manuscript");

  await reloadRenderer(window);
  await waitForState(
    window,
    (state) => state.statusKind === "empty" && !state.saveEnabled,
    "the reloaded quotation renderer"
  );
  await clickButton(window, "#open-markdown", "Open Document after reload");
  const reopened = await waitForState(
    window,
    (state) => state.statusKind === "saved"
      && !state.saveEnabled
      && state.activeManuscript === "manuscript.md"
      && state.text === expectedText,
    "the saved quotation after reload"
  );
  assertAbsent(reopened.text, QUOTATION_SMOKE_PRIVATE_SENTINELS, "reopened manuscript");
  assertTrue((await readFile(manuscriptPath)).equals(Buffer.from(expectedText, "utf8")), "reopened manuscript bytes did not persist");
}
