import { readFile } from "node:fs/promises";
import * as path from "node:path";
import type { BrowserWindow } from "electron";

const POLL_INTERVAL_MS = 25;
const STATE_TIMEOUT_MS = 20_000;

export const EXPORT_SMOKE_ANNOTATION_ID = "e5c6d7a8-9012-4b3c-8d7e-6f5a4b3c2d1e";
export const EXPORT_SMOKE_QUOTE = "これはExport smokeの解決済み引用です。";
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
  readonly tabs: readonly { readonly name: string; readonly active: boolean }[];
}

interface PreviewRendererState {
  readonly visible: boolean;
  readonly direction: string | null;
  readonly quoteState: string | null;
  readonly internalStates: readonly string[];
  readonly embedKinds: readonly string[];
  readonly imageCount: number;
  readonly videoCount: number;
  readonly hasExecutableScript: boolean;
}

const READ_STATE_SCRIPT = `(() => {
  const editor = document.querySelector("#editor");
  const project = document.querySelector("#workspace-document-name");
  const manuscriptList = document.querySelector("#manuscript-list");
  const status = document.querySelector("#document-status");
  const save = document.querySelector("#save-markdown");
  const exportButton = document.querySelector("#export-markdown");
  const exportStatus = document.querySelector("#export-status");
  if (!editor || editor.dataset.smokeReady !== "project" || !project || !manuscriptList
    || !status || !save || !exportButton || !exportStatus) return null;
  const active = [...manuscriptList.querySelectorAll("button[data-manuscript-id]")]
    .find((button) => button.getAttribute("aria-current") === "page");
  const tabs = [...document.querySelectorAll("#document-tabs .document-tab")].map((tab) => ({
    name: tab.querySelector(".document-tab-label")?.textContent ?? "",
    active: tab.classList.contains("active")
  }));
  return {
    smokeReady: true,
    projectName: project.textContent ?? "",
    activeFile: active?.dataset.manuscriptName ?? active?.textContent ?? null,
    text: editor.dataset.smokeText ?? "",
    status: status.dataset.state ?? "",
    saveEnabled: !save.disabled,
    exportStatus: exportStatus.dataset.state ?? "",
    exportMessage: exportStatus.textContent ?? "",
    exportEnabled: !exportButton.disabled,
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
    quoteState: root.querySelector(".rendered-quote-ref")?.getAttribute("data-quote-state") ?? null,
    internalStates: [...root.querySelectorAll(".rendered-internal-link")].map((link) => link.getAttribute("data-internal-link-state") ?? ""),
    embedKinds: [...root.querySelectorAll(".rendered-embed-card")].map((card) => card.getAttribute("data-embed-kind") ?? ""),
    imageCount: root.querySelectorAll("img.rendered-local-media").length,
    videoCount: root.querySelectorAll("video.rendered-local-media").length,
    hasExecutableScript: root.querySelector("script") !== null
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
  description: string
): Promise<ExportRendererState> {
  const deadline = Date.now() + STATE_TIMEOUT_MS;
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
    const button = [...document.querySelectorAll("#manuscript-list button[data-manuscript-id]")]
      .find((candidate) => candidate.dataset.manuscriptName === ${JSON.stringify(name)});
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

/** Verify dirty active-session projection, ordinary Markdown output, and tab selection. */
export async function runExportSmoke(window: BrowserWindow, fixtureRoot: string): Promise<void> {
  const root = path.resolve(fixtureRoot);
  const firstPath = path.join(root, "a.md");
  const secondPath = path.join(root, "b.md");
  const initialFirst = await readFile(firstPath, "utf8");
  const initialSecond = await readFile(secondPath, "utf8");
  const quoteMarker = `<!-- maginalia:quote-ref v1 {"quoteId":"${EXPORT_SMOKE_ANNOTATION_ID}","mode":"normal"} -->`;
  const referenceStart = "<!-- maginalia:reference-list-start v1 -->";
  const referenceEnd = "<!-- maginalia:reference-list-end v1 -->";
  const dirtySentinel = "\n\nUnsaved export-only edit.\n";

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
      && state.imageCount === 1
      && state.videoCount === 1,
    "resolved horizontal Markdown Preview"
  );
  assert(!horizontal.hasExecutableScript, "authoring HTML created an executable script in Preview");
  await clickButton(window, "#document-vertical", "switch Preview to vertical");
  const vertical = await waitForPreviewState(
    window,
    (state) => state.visible && state.direction === "vertical" && state.imageCount === 1 && state.videoCount === 1,
    "vertical Markdown Preview"
  );
  assert(vertical.imageCount === 1 && vertical.videoCount === 1, "vertical Preview lost Project media");
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
  assertIncludes(outputA, `（${EXPORT_SMOKE_AUTHOR}『${EXPORT_SMOKE_TITLE}』、p.${EXPORT_SMOKE_PAGE}）`, "human-readable provenance output");
  assertIncludes(outputA, `- ${EXPORT_SMOKE_AUTHOR}『${EXPORT_SMOKE_TITLE}』 Export Smoke Publisher、2024。`, "bibliography output");
  assertIncludes(outputA, dirtySentinel.trim(), "dirty currentText output");
  for (const forbidden of [
    quoteMarker,
    referenceStart,
    referenceEnd,
    EXPORT_SMOKE_ANNOTATION_ID,
    EXPORT_SMOKE_CAPTURE_ID,
    "page-export-smoke",
    "source-page-internal",
    "book:isbn13:"
  ]) {
    assert(!outputA.includes(forbidden), `export leaked ${forbidden}`);
  }
  assert(await readFile(firstPath, "utf8") === initialFirst, "export changed the authoring file bytes");
  assert(exportedA.status === "modified" && exportedA.saveEnabled, "export cleared the dirty state");

  await clickFile(window, "b.md");
  const openedB = await waitForState(
    window,
    (state) => state.activeFile === "b.md"
      && state.tabs.length === 2
      && state.tabs.some((tab) => tab.name.startsWith("a.md") && !tab.active)
      && state.tabs.some((tab) => tab.name.startsWith("b.md") && tab.active),
    "the second active Markdown tab"
  );
  assert(openedB.text.includes("B-only document"), "second document was not active");
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
  for (const forbidden of [EXPORT_SMOKE_QUOTE, EXPORT_SMOKE_TITLE, dirtySentinel.trim(), quoteMarker]) {
    assert(!outputB.includes(forbidden), `second export used inactive document content ${forbidden}`);
  }
  assert(await readFile(secondPath, "utf8") === initialSecond, "second export changed its authoring file");
}
