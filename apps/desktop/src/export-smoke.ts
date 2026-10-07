import { readFile } from "node:fs/promises";
import * as path from "node:path";
import type { BrowserWindow } from "electron";
import { strFromU8, unzipSync } from "fflate";
import { validateDocxArtifactFile } from "./export-docx";

const POLL_INTERVAL_MS = 25;
const STATE_TIMEOUT_MS = 20_000;

export const EXPORT_SMOKE_ANNOTATION_ID = "e5c6d7a8-9012-4b3c-8d7e-6f5a4b3c2d1e";
export const EXPORT_SMOKE_QUOTE = "これはExport smokeの解決済み引用です。";
export const EXPORT_SMOKE_DIRTY_CHILD_ANNOTATION_ID = "f6d7e8a9-0123-4c5d-9e8f-7a6b5c4d3e2f";
export const EXPORT_SMOKE_DIRTY_CHILD_QUOTE = "これはExport smokeの未保存子引用です。";
export const EXPORT_SMOKE_TITLE = "Export Smoke Book";
export const EXPORT_SMOKE_AUTHOR = "Export Smoke Author";
export const EXPORT_SMOKE_PAGE = "42";
export const EXPORT_SMOKE_CAPTURE_ID = "capture-export-smoke";

interface ExportRendererState {
  readonly smokeReady: boolean;
  readonly projectName: string;
  readonly activeFile: string | null;
  readonly text: string;
  readonly status: string;
  readonly saveEnabled: boolean;
  readonly exportStatus: string;
  readonly exportMessage: string;
  readonly exportEnabled: boolean;
  readonly exportPdfEnabled: boolean;
  readonly exportDocxEnabled: boolean;
  readonly exportSettings: {
    readonly available: boolean;
    readonly open: boolean;
    readonly paperSize: string;
    readonly orientation: string;
    readonly paragraphIndent: boolean;
    readonly header: { readonly left: string; readonly center: string; readonly right: string };
    readonly pageNumber: boolean;
  };
  readonly tabs: readonly { readonly name: string; readonly active: boolean }[];
}

interface PreviewRendererState {
  readonly visible: boolean;
  readonly direction: string | null;
  readonly writingMode: string;
  readonly quoteState: string | null;
  readonly internalStates: readonly string[];
  readonly embedKinds: readonly string[];
  readonly imageCount: number;
  readonly videoCount: number;
  readonly headingSizes: readonly number[];
  readonly proseIndent: string | null;
  readonly proseTexts: readonly string[];
  readonly structuralIndent: string | null;
  readonly imageDisplay: string | null;
  readonly imageMaxWidth: string | null;
  readonly mediaWritingModes: readonly string[];
  readonly unresolvedMediaCount: number;
  readonly unresolvedMediaWritingModes: readonly string[];
  readonly unresolvedMediaClientWidths: readonly number[];
  readonly tableCount: number;
  readonly tableImageCount: number;
  readonly tableTagName: string | null;
  readonly tableHeaderTexts: readonly string[];
  readonly tableBodyRowCount: number;
  readonly tableFirstRowCellCount: number;
  readonly tableOverflowX: string | null;
  readonly tableWritingMode: string | null;
  readonly tableClientWidth: number | null;
  readonly tableScrollWidth: number | null;
  readonly tableClientHeight: number | null;
  readonly tableScrollHeight: number | null;
  readonly hasExecutableScript: boolean;
  readonly syncedBlockCount: number;
  readonly syncedBlockTexts: readonly string[];
  readonly syncedBlockQuoteStates: readonly string[];
}

const READ_STATE_SCRIPT = `(() => {
  const editor = document.querySelector("#editor");
  const project = document.querySelector("#workspace-document-name");
  const explorerTree = document.querySelector("#explorer-tree");
  const status = document.querySelector("#document-status");
  const save = document.querySelector("#save-markdown");
  const exportButton = document.querySelector("#export-markdown");
  const exportPdfButton = document.querySelector("#export-pdf");
  const exportDocxButton = document.querySelector("#export-docx");
  const exportSettingsPanel = document.querySelector("#export-settings-panel");
  const exportPaperSize = document.querySelector("#export-paper-size");
  const exportOrientation = document.querySelector("#export-orientation");
  const exportParagraphIndent = document.querySelector("#export-paragraph-indent");
  const exportHeaderLeft = document.querySelector("#export-header-left");
  const exportHeaderCenter = document.querySelector("#export-header-center");
  const exportHeaderRight = document.querySelector("#export-header-right");
  const exportPageNumber = document.querySelector("#export-page-number");
  const exportStatus = document.querySelector("#export-status");
  if (!editor || editor.dataset.smokeReady !== "project" || !project || !explorerTree
    || !status || !save || !exportButton || !exportPdfButton || !exportDocxButton || !exportSettingsPanel
    || !exportPaperSize || !exportOrientation || !exportParagraphIndent || !exportHeaderLeft
    || !exportHeaderCenter || !exportHeaderRight || !exportPageNumber || !exportStatus) return null;
  const active = [...explorerTree.querySelectorAll("button[data-explorer-file-id]")]
    .find((button) => button.getAttribute("aria-current") === "page");
  const tabs = [...document.querySelectorAll("#document-tabs .document-tab")].map((tab) => ({
    name: tab.querySelector(".document-tab-label")?.textContent ?? "",
    active: tab.classList.contains("active")
  }));
  return {
    smokeReady: true,
    projectName: project.textContent ?? "",
    activeFile: active?.dataset.explorerFileName ?? active?.textContent ?? null,
    text: editor.dataset.smokeText ?? "",
    status: status.dataset.state ?? "",
    saveEnabled: !save.disabled,
    exportStatus: exportStatus.dataset.state ?? "",
    exportMessage: exportStatus.textContent ?? "",
    exportEnabled: !exportButton.disabled,
    exportPdfEnabled: !exportPdfButton.disabled,
    exportDocxEnabled: !exportDocxButton.disabled,
    exportSettings: {
      available: exportSettingsPanel instanceof HTMLDetailsElement,
      open: exportSettingsPanel instanceof HTMLDetailsElement && exportSettingsPanel.open,
      paperSize: exportPaperSize instanceof HTMLSelectElement ? exportPaperSize.value : "",
      orientation: exportOrientation instanceof HTMLSelectElement ? exportOrientation.value : "",
      paragraphIndent: exportParagraphIndent instanceof HTMLInputElement && exportParagraphIndent.checked,
      header: {
        left: exportHeaderLeft instanceof HTMLInputElement ? exportHeaderLeft.value : "",
        center: exportHeaderCenter instanceof HTMLInputElement ? exportHeaderCenter.value : "",
        right: exportHeaderRight instanceof HTMLInputElement ? exportHeaderRight.value : ""
      },
      pageNumber: exportPageNumber instanceof HTMLInputElement && exportPageNumber.checked
    },
    tabs
  };
})()`;

const READ_PREVIEW_SCRIPT = `(() => {
  const preview = document.querySelector("#markdown-preview");
  const root = preview?.querySelector(".markdown-preview-document");
  if (!(preview instanceof HTMLElement) || !(root instanceof HTMLElement)) return null;
  return {
    visible: !preview.hidden,
    direction: root.dataset.writingDirection ?? null,
    writingMode: getComputedStyle(root).writingMode,
    quoteState: root.querySelector(".rendered-quote-ref")?.getAttribute("data-quote-state") ?? null,
    internalStates: [...root.querySelectorAll(".rendered-internal-link")].map((link) => link.getAttribute("data-internal-link-state") ?? ""),
    embedKinds: [...root.querySelectorAll(".rendered-embed-card")].map((card) => card.getAttribute("data-embed-kind") ?? ""),
    imageCount: root.querySelectorAll("img.rendered-local-media").length,
    videoCount: root.querySelectorAll("video.rendered-local-media").length,
    headingSizes: [1, 2, 3, 4, 5, 6].map((depth) => {
      const heading = root.querySelector("h" + depth);
      return heading instanceof HTMLElement ? Number.parseFloat(getComputedStyle(heading).fontSize) : 0;
    }),
    proseIndent: root.querySelector(".markdown-prose") instanceof HTMLElement
      ? getComputedStyle(root.querySelector(".markdown-prose")).textIndent
      : null,
    proseTexts: [...root.querySelectorAll(".markdown-prose")].map((paragraph) => paragraph.textContent ?? ""),
    structuralIndent: root.querySelector(".markdown-structural-paragraph") instanceof HTMLElement
      ? getComputedStyle(root.querySelector(".markdown-structural-paragraph")).textIndent
      : null,
    imageDisplay: root.querySelector("img.rendered-local-media") instanceof HTMLElement
      ? getComputedStyle(root.querySelector("img.rendered-local-media")).display
      : null,
    imageMaxWidth: root.querySelector("img.rendered-local-media") instanceof HTMLElement
      ? getComputedStyle(root.querySelector("img.rendered-local-media")).maxWidth
      : null,
    mediaWritingModes: [...root.querySelectorAll("img.rendered-local-media, video.rendered-local-media")]
      .map((media) => getComputedStyle(media).writingMode),
    unresolvedMediaCount: root.querySelectorAll(".rendered-local-media.unresolved").length,
    unresolvedMediaWritingModes: [...root.querySelectorAll(".rendered-local-media.unresolved")]
      .map((media) => getComputedStyle(media).writingMode),
    unresolvedMediaClientWidths: [...root.querySelectorAll(".rendered-local-media.unresolved")]
      .map((media) => media instanceof HTMLElement ? media.clientWidth : 0),
    tableCount: root.querySelectorAll(".markdown-table").length,
    tableImageCount: root.querySelectorAll(".markdown-table img.rendered-local-media").length,
    tableTagName: root.querySelector(".markdown-table")?.tagName.toLowerCase() ?? null,
    tableHeaderTexts: [...root.querySelectorAll(".markdown-table thead th")].map((cell) => cell.textContent ?? ""),
    tableBodyRowCount: root.querySelectorAll(".markdown-table tbody tr").length,
    tableFirstRowCellCount: root.querySelector(".markdown-table tbody tr")?.querySelectorAll("td").length ?? 0,
    tableOverflowX: root.querySelector(".markdown-table-wrapper") instanceof HTMLElement
      ? getComputedStyle(root.querySelector(".markdown-table-wrapper")).overflowX
      : null,
    tableWritingMode: root.querySelector(".markdown-table-wrapper") instanceof HTMLElement
      ? getComputedStyle(root.querySelector(".markdown-table-wrapper")).writingMode
      : null,
    tableClientWidth: root.querySelector(".markdown-table-wrapper") instanceof HTMLElement
      ? root.querySelector(".markdown-table-wrapper").clientWidth
      : null,
    tableScrollWidth: root.querySelector(".markdown-table-wrapper") instanceof HTMLElement
      ? root.querySelector(".markdown-table-wrapper").scrollWidth
      : null,
    tableClientHeight: root.querySelector(".markdown-table-wrapper") instanceof HTMLElement
      ? root.querySelector(".markdown-table-wrapper").clientHeight
      : null,
    tableScrollHeight: root.querySelector(".markdown-table-wrapper") instanceof HTMLElement
      ? root.querySelector(".markdown-table-wrapper").scrollHeight
      : null,
    hasExecutableScript: root.querySelector("script") !== null,
    syncedBlockCount: root.querySelectorAll(".rendered-synced-block").length,
    syncedBlockTexts: [...root.querySelectorAll(".rendered-synced-block-content")].map((block) => block.textContent ?? ""),
    syncedBlockQuoteStates: [...root.querySelectorAll(".rendered-synced-block .rendered-quote-ref")]
      .map((quote) => quote.getAttribute("data-quote-state") ?? "")
  };
})()`;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readState(window: BrowserWindow): Promise<ExportRendererState | null> {
  try {
    return await window.webContents.executeJavaScript(READ_STATE_SCRIPT, true) as ExportRendererState | null;
  } catch {
    return null;
  }
}

async function readPreviewState(window: BrowserWindow): Promise<PreviewRendererState | null> {
  try {
    return await window.webContents.executeJavaScript(READ_PREVIEW_SCRIPT, true) as PreviewRendererState | null;
  } catch {
    return null;
  }
}

async function waitForState(
  window: BrowserWindow,
  predicate: (state: ExportRendererState) => boolean,
  description: string,
  timeoutMs = STATE_TIMEOUT_MS
): Promise<ExportRendererState> {
  const deadline = Date.now() + timeoutMs;
  let last: ExportRendererState | null = null;
  while (Date.now() < deadline) {
    last = await readState(window);
    if (last !== null && predicate(last)) return last;
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(
    `Export smoke timed out waiting for ${description}. Last state: ${last ? JSON.stringify(last) : "unavailable"}.`
  );
}

async function waitForPreviewState(
  window: BrowserWindow,
  predicate: (state: PreviewRendererState) => boolean,
  description: string
): Promise<PreviewRendererState> {
  const deadline = Date.now() + STATE_TIMEOUT_MS;
  let last: PreviewRendererState | null = null;
  while (Date.now() < deadline) {
    last = await readPreviewState(window);
    if (last !== null && predicate(last)) return last;
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Export smoke timed out waiting for ${description}. Last preview: ${last ? JSON.stringify(last) : "unavailable"}.`);
}

async function runScript(window: BrowserWindow, script: string, description: string): Promise<void> {
  const result = await window.webContents.executeJavaScript(script, true) as boolean;
  if (!result) throw new Error(`Export smoke ${description} was unavailable.`);
}

async function clickButton(window: BrowserWindow, selector: string, description: string): Promise<void> {
  await runScript(window, `(() => {
    const button = document.querySelector(${JSON.stringify(selector)});
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`, description);
}

async function clickFile(window: BrowserWindow, name: string): Promise<void> {
  await runScript(window, `(() => {
    const button = [...document.querySelectorAll("#explorer-tree button[data-explorer-file-id]")]
      .find((candidate) => candidate.dataset.explorerFileName === ${JSON.stringify(name)});
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`, `activate ${name}`);
}

async function editActive(window: BrowserWindow, suffix: string): Promise<void> {
  await runScript(window, `(() => {
    const editor = document.querySelector("#editor");
    if (!(editor instanceof HTMLElement)) return false;
    editor.dispatchEvent(new CustomEvent("maginalia-smoke-append", { detail: ${JSON.stringify(suffix)} }));
    return true;
  })()`, "edit active Markdown");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Export smoke assertion failed: ${message}`);
}

function assertIncludes(value: string, expected: string, message: string): void {
  assert(value.includes(expected), `${message}: missing ${JSON.stringify(expected)}`);
}

function assertWideTable(state: PreviewRendererState, direction: string): void {
  assert(
    state.tableClientWidth !== null
      && state.tableScrollWidth !== null
      && state.tableClientWidth > 0
      && state.tableScrollWidth > state.tableClientWidth,
    `${direction} wide table did not expose horizontal scrolling (${state.tableScrollWidth}/${state.tableClientWidth}).`
  );
  assert(
    state.tableClientHeight !== null
      && state.tableScrollHeight !== null
      && state.tableClientHeight > 0
      && state.tableScrollHeight >= state.tableClientHeight,
    `${direction} wide table did not expose usable vertical dimensions (${state.tableScrollHeight}/${state.tableClientHeight}).`
  );
}

/** Verify dirty active-session projection, ordinary Markdown output, and tab selection. */
export async function runExportSmoke(window: BrowserWindow, fixtureRoot: string): Promise<void> {
  const root = path.resolve(fixtureRoot);
  // Some developer hosts do not have Vivliostyle installed. This opt-in keeps
  // the Electron DOCX flow testable independently; the normal smoke still
  // requires and validates a real PDF.
  const skipPdf = process.env.MAGINALIA_EXPORT_SMOKE_SKIP_PDF === "1";
  const firstPath = path.join(root, "a.md");
  const secondPath = path.join(root, "b.md");
  const childPath = path.join(root, "child.md");
  const nestedPath = path.join(root, "nested.md");
  const initialFirst = await readFile(firstPath, "utf8");
  const initialSecond = await readFile(secondPath, "utf8");
  const initialChild = await readFile(childPath, "utf8");
  const initialNested = await readFile(nestedPath, "utf8");
  const quoteMarker = `<!-- maginalia:quote-ref v1 {"quoteId":"${EXPORT_SMOKE_ANNOTATION_ID}","mode":"normal"} -->`;
  const referenceStart = "<!-- maginalia:reference-list-start v1 -->";
  const referenceEnd = "<!-- maginalia:reference-list-end v1 -->";
  const dirtySentinel = "\n\nUnsaved export-only edit.\n";
  const dirtyChildSentinel = `\n\nUnsaved child composition edit.\n\n<!-- maginalia:quote-ref v1 {"quoteId":"${EXPORT_SMOKE_DIRTY_CHILD_ANNOTATION_ID}","mode":"normal"} -->\n`;

  await waitForState(window, (state) => state.smokeReady && state.status === "empty", "Project readiness");
  await clickButton(window, "#open-project", "open Project");
  const opened = await waitForState(
    window,
    (state) => state.projectName === path.basename(root)
      && state.activeFile === "a.md"
      && state.tabs.length === 1
      && state.tabs[0]?.active === true,
    "the first Markdown document"
  );
  assert(opened.saveEnabled === false, "initial document unexpectedly dirty");

  // Slice F is a presentation projection: it must resolve the existing
  // quotation boundary, links and Project media without touching source text.
  const initialPreviewText = opened.text;
  await clickButton(window, "#document-preview-mode", "open Preview");
  const horizontal = await waitForPreviewState(
    window,
    (state) => state.visible
      && state.direction === "horizontal"
      && state.quoteState === "resolved"
      && state.internalStates.includes("resolved")
      && state.internalStates.includes("unresolved")
      && state.embedKinds.includes("generic-web")
      && state.embedKinds.includes("youtube")
      && state.embedKinds.includes("sns")
      && state.imageCount === 3
      && state.videoCount === 1
      && state.tableCount === 1
      && state.tableImageCount === 1
      && state.tableTagName === "table"
      && state.tableBodyRowCount === 1
      && state.tableFirstRowCellCount === 8
      && state.syncedBlockCount === 2
      && state.syncedBlockTexts.some((text) => text.includes("Synced child prose"))
      && state.syncedBlockTexts.some((text) => text.includes("Nested synced prose"))
      && state.syncedBlockQuoteStates.length === 2
      && state.syncedBlockQuoteStates.every((quoteState) => quoteState === "resolved"),
    "resolved horizontal Markdown Preview"
  );
  assert(!horizontal.hasExecutableScript, "authoring HTML created an executable script in Preview");
  assert(horizontal.headingSizes.every((size, index, sizes) => size > 0 && (index === sizes.length - 1 || size > sizes[index + 1]!)), "H1-H6 hierarchy was not visually distinct");
  assert(horizontal.proseIndent !== null && horizontal.proseIndent !== "0px", "ordinary prose did not receive a visual first-line indent");
  assert(horizontal.proseTexts.some((text) => text.startsWith("これは通常の文章です。参考リンク") && text.endsWith("を参照します。")), "ordinary external-link prose lost prose presentation");
  assert(horizontal.proseTexts.some((text) => text.startsWith("本文 YouTube") && text.endsWith("を参照します。")), "mixed prose and embed content lost prose presentation");
  assert(horizontal.structuralIndent === "0px", "media-bearing structural paragraph was incorrectly indented");
  assert(horizontal.imageDisplay === "block" && horizontal.imageMaxWidth === "100%", "Project media did not receive responsive block layout");
  assert(horizontal.tableHeaderTexts.join("|") === "列一|列二|列三|列四|列五|列六|列七|列八", "Japanese table headers were not preserved structurally");
  assert(horizontal.tableOverflowX === "auto", "wide table overflow behavior was not defined");
  assert(!horizontal.syncedBlockTexts.some((text) => text.includes("Child local title")), "Synced Block projection exposed its child H1");
  assert(!horizontal.syncedBlockTexts.some((text) => text.includes("stale child reference")), "Preview retained a child-derived reference list");
  assertWideTable(horizontal, "horizontal");
  await clickButton(window, "#document-vertical", "switch Preview to vertical");
  const vertical = await waitForPreviewState(
    window,
    (state) => state.visible
      && state.direction === "vertical"
      && state.writingMode === "vertical-rl"
      && state.imageCount === 3
      && state.videoCount === 1
      && state.tableCount === 1
      && state.tableImageCount === 1
      && state.unresolvedMediaCount === 1
      && state.mediaWritingModes.length === 4
      && state.mediaWritingModes.every((mode) => mode === "horizontal-tb")
      && state.unresolvedMediaWritingModes.every((mode) => mode === "horizontal-tb")
      && state.tableWritingMode === "horizontal-tb",
    "vertical Markdown Preview"
  );
  assert(vertical.imageCount === 3 && vertical.videoCount === 1, "vertical Preview lost Project media");
  assert(vertical.proseIndent !== null && vertical.proseIndent !== "0px", "vertical prose lost its visual first-line indent");
  assert(vertical.structuralIndent === "0px", "vertical media-bearing structural paragraph was incorrectly indented");
  assert(vertical.unresolvedMediaClientWidths.every((width) => width >= 120), "vertical unresolved media placeholder was too narrow to read");
  assertWideTable(vertical, "vertical");
  await clickButton(window, "#document-horizontal", "switch Preview to horizontal");
  await waitForPreviewState(window, (state) => state.visible && state.direction === "horizontal", "horizontal Markdown Preview restoration");
  await clickButton(window, "#document-edit-mode", "return to Edit");
  const afterPresentation = await waitForState(
    window,
    (state) => state.status === "saved" && !state.saveEnabled && state.text === initialPreviewText,
    "non-mutating Preview presentation"
  );
  assert(afterPresentation.text === initialPreviewText, "Preview changed authoring text");

  await editActive(window, dirtySentinel);
  const dirty = await waitForState(
    window,
    (state) => state.activeFile === "a.md"
      && state.status === "modified"
      && state.saveEnabled
      && state.exportEnabled
      && state.text.includes("Unsaved export-only edit."),
    "the dirty active document"
  );
  const dirtySnapshot = dirty.text;

  await clickFile(window, "child.md");
  await waitForState(
    window,
    (state) => state.activeFile === "child.md" && state.tabs.some((tab) => tab.name.startsWith("child.md") && tab.active),
    "the child source tab"
  );
  await editActive(window, dirtyChildSentinel);
  await waitForState(
    window,
    (state) => state.activeFile === "child.md" && state.text.includes("Unsaved child composition edit."),
    "the dirty child source session"
  );
  assert(await readFile(childPath, "utf8") === initialChild, "child edit reached disk before composition could capture its open session");
  await clickFile(window, "a.md");
  await waitForState(window, (state) => state.activeFile === "a.md", "the parent document after child editing");

  await clickButton(window, "#export-markdown", "export the dirty active document");
  const exportedA = await waitForState(
    window,
    (state) => state.exportStatus === "success"
      && state.status === "modified"
      && state.saveEnabled
      && state.text === dirtySnapshot,
    "the dirty document export"
  );
  assert(exportedA.exportMessage.includes("export-1.resolved.md"), "first export did not use the fixture output");
  const outputA = await readFile(path.join(root, "export-1.resolved.md"), "utf8");
  assertIncludes(outputA, `> ${EXPORT_SMOKE_QUOTE}`, "resolved quotation output");
  assertIncludes(outputA, `> ${EXPORT_SMOKE_DIRTY_CHILD_QUOTE}`, "dirty child-session quotation output");
  assertIncludes(outputA, `（${EXPORT_SMOKE_AUTHOR}『${EXPORT_SMOKE_TITLE}』、p.${EXPORT_SMOKE_PAGE}）`, "human-readable provenance output");
  assertIncludes(outputA, `- ${EXPORT_SMOKE_AUTHOR}『${EXPORT_SMOKE_TITLE}』 Export Smoke Publisher、2024。`, "bibliography output");
  assertIncludes(outputA, dirtySentinel.trim(), "dirty currentText output");
  assertIncludes(outputA, "Synced child prose", "composed child prose output");
  assertIncludes(outputA, "Nested synced prose", "composed nested child prose output");
  assertIncludes(outputA, "Unsaved child composition edit.", "dirty child-session composition output");
  assert(!outputA.includes("stale child reference"), "export retained a child-derived reference region");
  for (const forbidden of [
    quoteMarker,
    "maginalia:synced-block",
    referenceStart,
    referenceEnd,
    EXPORT_SMOKE_ANNOTATION_ID,
    EXPORT_SMOKE_DIRTY_CHILD_ANNOTATION_ID,
    EXPORT_SMOKE_CAPTURE_ID,
    "page-export-smoke",
    "source-page-internal",
    "book:isbn13:"
  ]) {
    assert(!outputA.includes(forbidden), `export leaked ${forbidden}`);
  }
  assert(await readFile(firstPath, "utf8") === initialFirst, "export changed the authoring file bytes");
  assert((await readFile(childPath, "utf8")).startsWith(initialChild), "export rewrote the child authoring source");
  assert(await readFile(nestedPath, "utf8") === initialNested, "export changed the nested authoring file bytes");
  assert(exportedA.status === "modified" && exportedA.saveEnabled, "export cleared the dirty state");

  await clickFile(window, "b.md");
  const openedB = await waitForState(
    window,
    (state) => state.activeFile === "b.md"
      && state.tabs.length >= 3
      && state.tabs.some((tab) => tab.name.startsWith("a.md") && !tab.active)
      && state.tabs.some((tab) => tab.name.startsWith("b.md") && tab.active),
    "the second active Markdown tab"
  );
  assert(openedB.text.includes("B-only document"), "second document was not active");

  const chosenSettings = {
    paperSize: "B4",
    orientation: "landscape",
    paragraphIndent: false,
    header: {
      left: "左側ヘッダー",
      center: "中央ヘッダー",
      right: "右側ヘッダー"
    },
    pageNumber: false
  } as const;
  await selectExportSettings(window, chosenSettings);
  const configured = await waitForState(
    window,
    (state) => state.exportSettings.available
      && state.exportSettings.open
      && state.exportSettings.paperSize === chosenSettings.paperSize
      && state.exportSettings.orientation === chosenSettings.orientation
      && state.exportSettings.paragraphIndent === chosenSettings.paragraphIndent
      && state.exportSettings.header.left === chosenSettings.header.left
      && state.exportSettings.header.center === chosenSettings.header.center
      && state.exportSettings.header.right === chosenSettings.header.right
      && state.exportSettings.pageNumber === chosenSettings.pageNumber,
    "selected Export presentation settings"
  );
  assert(configured.status === "saved" && !configured.saveEnabled, "changing Export settings dirtied the Markdown document");
  assert(configured.text.includes("B-only document"), "changing Export settings changed the active Markdown session");

  await clickButton(window, "#export-markdown", "export only the active second document");
  const exportedB = await waitForState(
    window,
    (state) => state.exportStatus === "success"
      && state.activeFile === "b.md"
      && state.text.includes("B-only document"),
    "the second document export"
  );
  assert(exportedB.exportMessage.includes("export-2.resolved.md"), "second export did not use the fixture output");
  const outputB = await readFile(path.join(root, "export-2.resolved.md"), "utf8");
  assertIncludes(outputB, "B-only document", "second document content");
  for (const headerText of Object.values(chosenSettings.header)) {
    assert(!outputB.includes(headerText), "presentation header settings leaked into resolved Markdown output");
  }
  for (const forbidden of [EXPORT_SMOKE_QUOTE, EXPORT_SMOKE_TITLE, dirtySentinel.trim(), quoteMarker]) {
    assert(!outputB.includes(forbidden), `second export used inactive document content ${forbidden}`);
  }
  assert(await readFile(secondPath, "utf8") === initialSecond, "second export changed its authoring file");

  if (!skipPdf) {
    await clickButton(window, "#export-pdf", "export the active document as PDF");
    const exportedPdf = await waitForState(
      window,
      (state) => state.exportStatus === "success"
        && state.activeFile === "b.md"
        && state.exportMessage.includes("export-3.resolved.pdf"),
      "the PDF export",
      // Vivliostyle can need over a minute to launch its Chromium PDF engine
      // on a cold Windows host; keep that real process path inside a bound.
      120_000
    );
    assert(exportedPdf.exportPdfEnabled, "PDF export was not available for the active document");
    const pdf = await readFile(path.join(root, "export-3.resolved.pdf"));
    assert(pdf.length > 4 && pdf.subarray(0, 4).toString("ascii") === "%PDF", "PDF export did not create a real PDF artifact");
    assert(await readFile(secondPath, "utf8") === initialSecond, "PDF export changed its authoring file");
  }

  await clickButton(window, "#export-docx", "export the active document as DOCX");
  const docxNumber = skipPdf ? 3 : 4;
  const exportedDocx = await waitForState(
    window,
    (state) => state.exportStatus === "success"
      && state.activeFile === "b.md"
      && state.exportMessage.includes(`export-${docxNumber}.resolved.docx`),
    "the DOCX export"
  );
  assert(exportedDocx.exportDocxEnabled, "DOCX export was not available for the active document");
  const docxPath = path.join(root, `export-${docxNumber}.resolved.docx`);
  await validateDocxArtifactFile(docxPath);
  const docxParts = unzipSync(await readFile(docxPath));
  const documentXml = strFromU8(docxParts["word/document.xml"]!);
  const stylesXml = strFromU8(docxParts["word/styles.xml"]!);
  const relationshipsXml = strFromU8(docxParts["word/_rels/document.xml.rels"]!);
  const headerXml = strFromU8(docxParts["word/header1.xml"]!);
  assert(documentXml.includes(`w:w="${Math.round(364 * 1440 / 25.4)}"`), "DOCX did not use the selected JIS B4 landscape width");
  assert(documentXml.includes(`w:h="${Math.round(257 * 1440 / 25.4)}"`), "DOCX did not use the selected JIS B4 landscape height");
  assert(documentXml.includes('w:orient="landscape"'), "DOCX did not use the selected landscape orientation");
  assert(!stylesXml.includes('w:firstLineChars="100"'), "DOCX ignored the selected paragraph-indent setting");
  assert(headerXml.includes("左側ヘッダー") && headerXml.includes("中央ヘッダー") && headerXml.includes("右側ヘッダー"), "DOCX did not receive all selected header slots");
  assert(docxParts["word/footer1.xml"] === undefined, "DOCX included a footer despite page numbers being disabled");
  assert(!relationshipsXml.includes("relationships/footer"), "DOCX retained a page-number footer relationship");
  assert(await readFile(secondPath, "utf8") === initialSecond, "DOCX export changed its authoring file");
}

async function selectExportSettings(
  window: BrowserWindow,
  settings: {
    readonly paperSize: string;
    readonly orientation: string;
    readonly paragraphIndent: boolean;
    readonly header: { readonly left: string; readonly center: string; readonly right: string };
    readonly pageNumber: boolean;
  }
): Promise<void> {
  await runScript(window, `(() => {
    const panel = document.querySelector("#export-settings-panel");
    const paperSize = document.querySelector("#export-paper-size");
    const orientation = document.querySelector("#export-orientation");
    const paragraphIndent = document.querySelector("#export-paragraph-indent");
    const headerLeft = document.querySelector("#export-header-left");
    const headerCenter = document.querySelector("#export-header-center");
    const headerRight = document.querySelector("#export-header-right");
    const pageNumber = document.querySelector("#export-page-number");
    if (!(panel instanceof HTMLDetailsElement)
      || !(paperSize instanceof HTMLSelectElement)
      || !(orientation instanceof HTMLSelectElement)
      || !(paragraphIndent instanceof HTMLInputElement)
      || !(headerLeft instanceof HTMLInputElement)
      || !(headerCenter instanceof HTMLInputElement)
      || !(headerRight instanceof HTMLInputElement)
      || !(pageNumber instanceof HTMLInputElement)) return false;
    panel.open = true;
    paperSize.value = ${JSON.stringify(settings.paperSize)};
    paperSize.dispatchEvent(new Event("change", { bubbles: true }));
    orientation.value = ${JSON.stringify(settings.orientation)};
    orientation.dispatchEvent(new Event("change", { bubbles: true }));
    paragraphIndent.checked = ${JSON.stringify(settings.paragraphIndent)};
    paragraphIndent.dispatchEvent(new Event("change", { bubbles: true }));
    headerLeft.value = ${JSON.stringify(settings.header.left)};
    headerLeft.dispatchEvent(new Event("input", { bubbles: true }));
    headerCenter.value = ${JSON.stringify(settings.header.center)};
    headerCenter.dispatchEvent(new Event("input", { bubbles: true }));
    headerRight.value = ${JSON.stringify(settings.header.right)};
    headerRight.dispatchEvent(new Event("input", { bubbles: true }));
    pageNumber.checked = ${JSON.stringify(settings.pageNumber)};
    pageNumber.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`, "set Export presentation settings");
}
