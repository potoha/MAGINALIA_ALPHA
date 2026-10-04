import * as path from "node:path";
import { readFile } from "node:fs/promises";
import type { BrowserWindow } from "electron";

const POLL_MS = 25;
const TIMEOUT_MS = 20_000;

interface State {
  readonly ready: boolean;
  readonly active: string | null;
  readonly text: string;
  readonly status: string;
  readonly tabs: readonly string[];
  readonly preview: boolean;
  readonly direction: string;
}

const READ_STATE = `(() => {
  const editor = document.querySelector("#editor");
  const status = document.querySelector("#document-status");
  const active = [...document.querySelectorAll("#manuscript-list button[data-manuscript-id]")].find((item) => item.getAttribute("aria-current") === "page");
  if (!(editor instanceof HTMLElement) || editor.dataset.smokeReady !== "project" || !(status instanceof HTMLElement)) return null;
  return { ready: true, active: active?.dataset.manuscriptName ?? null, text: editor.dataset.smokeText ?? "", status: status.dataset.state ?? "", tabs: [...document.querySelectorAll("#document-tabs .document-tab-label")].map((item) => item.textContent ?? ""), preview: !document.querySelector("#markdown-preview")?.hidden, direction: document.querySelector(".markdown-preview-document")?.getAttribute("data-writing-direction") ?? "" };
})()`;

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function state(window: BrowserWindow): Promise<State | null> {
  try { return await window.webContents.executeJavaScript(READ_STATE, true) as State | null; } catch { return null; }
}

async function waitFor(window: BrowserWindow, predicate: (value: State) => boolean, description: string): Promise<State> {
  const deadline = Date.now() + TIMEOUT_MS;
  let last: State | null = null;
  while (Date.now() < deadline) {
    last = await state(window);
    if (last !== null && predicate(last)) return last;
    await delay(POLL_MS);
  }
  throw new Error(`G smoke timed out waiting for ${description}: ${last === null ? "unavailable" : JSON.stringify(last)}`);
}

async function script(window: BrowserWindow, source: string, description: string): Promise<void> {
  if (!await window.webContents.executeJavaScript(source, true) as boolean) throw new Error(`G smoke ${description} was unavailable.`);
}

async function waitForScript(window: BrowserWindow, source: string, description: string): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(source, true) as boolean) return;
    await delay(POLL_MS);
  }
  throw new Error(`G smoke timed out waiting for ${description}.`);
}

/** Real Electron coverage of G's command/preview/link/search seams. */
export async function runGSmoke(window: BrowserWindow, fixtureRoot: string): Promise<void> {
  const initialC = await readFile(path.join(fixtureRoot, "c.md"), "utf8");
  await window.webContents.executeJavaScript("document.body?.offsetWidth ?? 0", true);
  await script(window, `(() => { const overflow = document.querySelector("#project-overflow"); const open = document.querySelector("#open-project"); if (!(overflow instanceof HTMLButtonElement) || !(open instanceof HTMLButtonElement)) return false; overflow.click(); open.click(); return true; })()`, "open Project");
  await waitFor(window, (value) => value.ready && value.active === "a.md", "A open");

  await script(window, `window.dispatchEvent(new KeyboardEvent("keydown", { key: "1", ctrlKey: true, bubbles: true, cancelable: true })); true`, "Ctrl+1");
  await waitFor(window, (value) => value.text.startsWith("# "), "heading command");
  await script(window, `(() => { const undo = document.querySelector('[data-command-id="maginalia.editor.undo"]'); if (!(undo instanceof HTMLButtonElement)) return false; undo.click(); return true; })()`, "Undo command surface");
  await waitFor(window, (value) => !value.text.startsWith("# "), "undo restores source");
  await script(window, `window.dispatchEvent(new KeyboardEvent("keydown", { key: "1", ctrlKey: true, bubbles: true, cancelable: true })); true`, "Ctrl+1 again");
  await waitFor(window, (value) => value.text.startsWith("# "), "heading command before Save");
  await script(window, `(() => { const save = document.querySelector('#save-markdown[data-command-id="maginalia.document.save"]'); if (!(save instanceof HTMLButtonElement)) return false; window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true })); return true; })()`, "Save shortcut command");
  await waitFor(window, (value) => value.status === "saved", "Save shortcut completes");
  await script(window, `window.dispatchEvent(new KeyboardEvent("keydown", { key: "0", ctrlKey: true, bubbles: true, cancelable: true })); true`, "Ctrl+0");
  await waitFor(window, (value) => !value.text.startsWith("# ") && value.status === "modified", "paragraph command after Save");
  await script(window, `(() => { const save = document.querySelector('#save-markdown[data-command-id="maginalia.document.save"]'); if (!(save instanceof HTMLButtonElement) || save.disabled) return false; save.click(); return true; })()`, "Save button command");
  await waitFor(window, (value) => value.status === "saved", "Save button completes");

  await script(window, `(() => {
    const show = document.querySelector('#activity-view-properties');
    const panel = document.querySelector('#properties-panel');
    const form = document.querySelector('#properties-form');
    const title = document.querySelector('#properties-title');
    const author = document.querySelector('#properties-author');
    const tags = document.querySelector('#properties-tags');
    const type = document.querySelector('#properties-type');
    const created = document.querySelector('#properties-created');
    if (!(show instanceof HTMLButtonElement) || !(panel instanceof HTMLElement) || !(form instanceof HTMLFormElement)
      || !(title instanceof HTMLInputElement) || !(author instanceof HTMLInputElement) || !(tags instanceof HTMLTextAreaElement)
      || !(type instanceof HTMLSelectElement) || !(created instanceof HTMLInputElement)) return false;
    show.click();
    title.value = 'A Metadata Title'; title.dispatchEvent(new Event('input', { bubbles: true }));
    author.value = '未田3字'; author.dispatchEvent(new Event('input', { bubbles: true }));
    tags.value = '俳句\\n受容美学'; tags.dispatchEvent(new Event('input', { bubbles: true }));
    type.value = 'draft'; type.dispatchEvent(new Event('change', { bubbles: true }));
    created.value = '2026-10-04'; created.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return panel.classList.contains('view-panel-active');
  })()`, "apply Properties through its canonical command");
  await waitFor(window, (value) => value.text.includes('title: A Metadata Title') && value.text.includes('author: 未田3字') && value.text.includes('  - 俳句'), "Properties reaches the active Markdown session");
  await script(window, `(() => {
    const title = document.querySelector('#properties-title');
    if (!(title instanceof HTMLInputElement)) return false;
    title.value = 'Unapplied Properties Title'; title.dispatchEvent(new Event('input', { bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', ctrlKey: true, bubbles: true, cancelable: true }));
    return true;
  })()`, "keep dirty Properties input while prose source changes");
  await waitForScript(window, `(() => {
    const title = document.querySelector('#properties-title');
    const apply = document.querySelector('#properties-apply');
    const reload = document.querySelector('#properties-reload');
    const status = document.querySelector('#properties-status');
    return title instanceof HTMLInputElement && title.value === 'Unapplied Properties Title'
      && apply instanceof HTMLButtonElement && apply.disabled
      && reload instanceof HTMLButtonElement && !reload.disabled
      && status?.textContent?.includes('unapplied Properties changes are preserved');
  })()`, "dirty Properties form becomes stale without losing input");
  await script(window, `(() => { const reload = document.querySelector('#properties-reload'); if (!(reload instanceof HTMLButtonElement) || reload.disabled) return false; reload.click(); return true; })()`, "reload stale Properties through its canonical command");
  await waitForScript(window, `(() => {
    const title = document.querySelector('#properties-title');
    const reload = document.querySelector('#properties-reload');
    return title instanceof HTMLInputElement && title.value === 'A Metadata Title'
      && reload instanceof HTMLButtonElement && reload.disabled;
  })()`, "Reload Properties discards only the stale UI form");
  await script(window, `(() => { const preview = document.querySelector('#document-preview-mode'); if (!(preview instanceof HTMLButtonElement)) return false; preview.click(); return true; })()`, "open Preview after Properties apply");
  await waitFor(window, (value) => value.preview, "Properties Preview");
  await waitForScript(window, `(() => {
    const preview = document.querySelector('.markdown-preview-document');
    return preview instanceof HTMLElement && !preview.textContent?.includes('type: draft') && preview.textContent?.includes('A document.');
  })()`, "Preview hides front matter while retaining prose");
  await script(window, `(() => { const edit = document.querySelector('#document-edit-mode'); if (!(edit instanceof HTMLButtonElement)) return false; edit.click(); return true; })()`, "return to Edit after Properties Preview");

  await script(window, `(() => { const preview = document.querySelector("#document-preview-mode"); if (!(preview instanceof HTMLButtonElement)) return false; preview.click(); return true; })()`, "open horizontal editable Preview");
  await waitFor(window, (value) => value.preview && value.direction === "horizontal", "horizontal Preview");
  await script(window, `(() => { const editable = [...document.querySelectorAll(".markdown-preview-editable-text")].find((item) => item.textContent === "A document."); if (!(editable instanceof HTMLElement)) return false; editable.focus(); editable.textContent = "A Preview document!"; editable.dispatchEvent(new Event("input", { bubbles: true })); editable.textContent = "A Preview document."; editable.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`, "continuously edit horizontal Preview text");
  await waitFor(window, (value) => value.text.includes("A Preview document.") && value.status === "modified", "Preview edit reaches source session");
  await script(window, `(() => { const edit = document.querySelector("#document-edit-mode"); if (!(edit instanceof HTMLButtonElement)) return false; edit.click(); return true; })()`, "return to Edit after Preview edit");
  await waitFor(window, (value) => !value.preview && value.text.includes("A Preview document."), "Edit receives Preview source");
  await script(window, `(() => { const save = document.querySelector('#save-markdown[data-command-id="maginalia.document.save"]'); if (!(save instanceof HTMLButtonElement) || save.disabled) return false; save.click(); return true; })()`, "Save Preview-originated source");
  await waitFor(window, (value) => value.status === "saved", "Preview-originated source is saved through the normal command");
  if (!(await readFile(path.join(fixtureRoot, "a.md"), "utf8")).includes("A Preview document.")) {
    throw new Error("Manual Save did not persist Preview-originated Markdown.");
  }
  await script(window, `(() => { const table = document.querySelector('[data-command-id="maginalia.editor.insertTable"]'); if (!(table instanceof HTMLButtonElement)) return false; table.click(); return true; })()`, "insert table through canonical command");
  await waitFor(window, (value) => value.text.includes("| Column 1 | Column 2 |"), "table command updates Markdown session");

  await script(window, `window.dispatchEvent(new KeyboardEvent("keydown", { key: "P", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })); true`, "open Palette");
  await script(window, `(() => { const input = document.querySelector(".command-palette input"); if (!(input instanceof HTMLInputElement)) return false; input.value = "vertical"; input.dispatchEvent(new Event("input", { bubbles: true })); const result = document.querySelector('.command-palette-item[data-command-id="maginalia.renderer.setVertical"]'); if (!(result instanceof HTMLElement)) return false; result.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); return true; })()`, "execute vertical Palette command");
  await script(window, `(() => { const preview = document.querySelector("#document-preview-mode"); if (!(preview instanceof HTMLButtonElement)) return false; preview.click(); return true; })()`, "open Preview");
  await waitFor(window, (value) => value.preview && value.direction === "vertical", "vertical preview without source mutation");
  await script(window, `(() => { const header = document.querySelector(".markdown-table th .markdown-preview-editable-table-cell"); if (!(header instanceof HTMLElement)) return false; header.focus(); header.textContent = "作品"; header.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`, "edit table header in Preview");
  await waitFor(window, (value) => value.text.includes("| 作品 | Column 2 |"), "table cell edit reaches Markdown source");
  await script(window, `(() => { const header = document.querySelector(".markdown-table th .markdown-preview-editable-table-cell"); if (!(header instanceof HTMLElement)) return false; header.blur(); return true; })()`, "finish table cell edit");
  await delay(50);
  await waitForScript(window, "getComputedStyle(document.querySelector('.markdown-table-wrapper')).writingMode === 'horizontal-tb'", "vertical Preview keeps table horizontal");
  await script(window, `(() => { const editable = [...document.querySelectorAll(".markdown-preview-editable-text")].find((item) => item.textContent === "A Preview document."); if (!(editable instanceof HTMLElement) || editable.firstChild === null) return false; editable.focus(); editable.textContent = "A Preview 日本語 document."; editable.dispatchEvent(new Event("input", { bubbles: true })); const text = editable.firstChild; const start = editable.textContent.indexOf("Preview"); const selection = document.getSelection(); if (start < 0 || selection === null) return false; selection.removeAllRanges(); const range = document.createRange(); range.setStart(text, start); range.setEnd(text, start + "Preview".length); selection.addRange(range); editable.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight", bubbles: true })); window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true, cancelable: true })); const edit = document.querySelector("#document-edit-mode"); const preview = document.querySelector("#document-preview-mode"); if (!(edit instanceof HTMLButtonElement) || !(preview instanceof HTMLButtonElement)) return false; edit.click(); preview.click(); return true; })()`, "edit Japanese text and bold Preview selection vertically");
  await waitFor(window, (value) => value.text.includes("日本語"), "vertical Preview edit reaches UTF-16 source");
  await waitFor(window, (value) => value.text.includes("**Preview**"), "Preview Ctrl+B updates Markdown source");
  await waitForScript(window, "[...document.querySelectorAll('.markdown-preview-document strong')].some((item) => item.textContent === 'Preview')", "bold Preview projection");
  await waitForScript(window, "document.querySelector('.rendered-internal-link.resolved') instanceof HTMLElement", "resolved internal link");

  await script(window, `(() => {
    const title = document.querySelector('#properties-title');
    const link = document.querySelector(".rendered-internal-link.resolved");
    if (!(title instanceof HTMLInputElement) || !(link instanceof HTMLElement)) return false;
    title.value = 'Pending A Properties'; title.dispatchEvent(new Event('input', { bubbles: true }));
    link.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    return true;
  })()`, "open internal link while A Properties form is dirty");
  await waitFor(window, (value) => value.active === "b.md" && value.tabs.length === 2, "B opens once in a tab");
  await waitForScript(window, `(() => {
    const title = document.querySelector('#properties-title');
    const apply = document.querySelector('#properties-apply');
    const reload = document.querySelector('#properties-reload');
    const name = document.querySelector('#properties-document-name');
    return title instanceof HTMLInputElement && title.value === 'Pending A Properties'
      && apply instanceof HTMLButtonElement && apply.disabled
      && reload instanceof HTMLButtonElement && !reload.disabled
      && name?.textContent?.includes('a.md');
  })()`, "dirty A Properties form does not attach to B");
  await script(window, `(() => { const reload = document.querySelector('#properties-reload'); if (!(reload instanceof HTMLButtonElement) || reload.disabled) return false; reload.click(); return true; })()`, "discard stale A Properties before reading B");
  await waitForScript(window, "document.querySelector('#properties-document-name')?.textContent === 'b.md'", "Properties follows the active document tab");
  await script(window, `(() => { const tab = [...document.querySelectorAll("#document-tabs .document-tab")].find((item) => item.querySelector(".document-tab-label")?.textContent?.startsWith("a.md")); const button = tab?.querySelector(".document-tab-label"); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true; })()`, "return to A");
  await waitFor(window, (value) => value.active === "a.md", "A active again");
  await script(window, `(() => { const preview = document.querySelector("#document-preview-mode"); if (!(preview instanceof HTMLButtonElement)) return false; preview.click(); return true; })()`, "reopen A Preview");
  await waitForScript(window, "document.querySelector('.rendered-internal-link.resolved') instanceof HTMLElement", "resolved A link after tab switch");
  await script(window, `(() => { const link = document.querySelector(".rendered-internal-link.resolved"); if (!(link instanceof HTMLElement)) return false; link.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })); return true; })()`, "activate existing internal link target");
  await waitFor(window, (value) => value.active === "b.md" && value.tabs.length === 2, "existing B tab activated without duplicate");

  await script(window, `(() => { const c = [...document.querySelectorAll("#manuscript-list button[data-manuscript-id]")].find((item) => item.dataset.manuscriptName === "c.md"); if (!(c instanceof HTMLButtonElement)) return false; c.click(); return true; })()`, "open C tab");
  await waitFor(window, (value) => value.active === "c.md" && value.tabs.length === 3, "C opens as a third tab");
  await script(window, `(() => { const tabs = [...document.querySelectorAll("#document-tabs .document-tab")]; const source = tabs.find((item) => item.querySelector(".document-tab-label")?.textContent?.startsWith("c.md")); const target = tabs.find((item) => item.querySelector(".document-tab-label")?.textContent?.startsWith("a.md")); if (!(source instanceof HTMLElement) || !(target instanceof HTMLElement) || typeof DataTransfer !== "function" || typeof DragEvent !== "function") return false; const transfer = new DataTransfer(); source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: transfer })); target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer })); target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer })); source.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: transfer })); return true; })()`, "drag C before A");
  await waitFor(window, (value) => value.active === "c.md" && value.status === "saved" && value.tabs.map((tab) => tab.trim()).join("|") === "c.md|a.md|b.md", "reordered tabs without source mutation");
  if (await readFile(path.join(fixtureRoot, "c.md"), "utf8") !== initialC) {
    throw new Error("Tab reordering rewrote c.md.");
  }
  await script(window, `(() => { const editor = document.querySelector("#editor"); if (!(editor instanceof HTMLElement)) return false; editor.dispatchEvent(new CustomEvent("maginalia-smoke-append", { detail: "\\nC tab draft" })); return true; })()`, "edit C after reorder");
  await waitFor(window, (value) => value.active === "c.md" && value.text.includes("C tab draft") && value.status === "modified", "C dirty session");
  await script(window, `(() => { const tab = [...document.querySelectorAll("#document-tabs .document-tab")].find((item) => item.querySelector(".document-tab-label")?.textContent?.startsWith("a.md")); const button = tab?.querySelector(".document-tab-label"); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true; })()`, "switch to A after C edit");
  await waitFor(window, (value) => value.active === "a.md", "A activates without closing C");
  await script(window, `(() => { const tab = [...document.querySelectorAll("#document-tabs .document-tab")].find((item) => item.querySelector(".document-tab-label")?.textContent?.startsWith("c.md")); const button = tab?.querySelector(".document-tab-label"); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true; })()`, "return to dirty C");
  await waitFor(window, (value) => value.active === "c.md" && value.text.includes("C tab draft") && value.tabs.map((tab) => tab.trim()).join("|") === "c.md|a.md|b.md", "C session text and tab order retained");

  await script(window, `(() => { const tab = [...document.querySelectorAll("#document-tabs .document-tab")].find((item) => item.querySelector(".document-tab-label")?.textContent?.startsWith("a.md")); const button = tab?.querySelector(".document-tab-label"); const mode = document.querySelector('[data-unified-search-mode="project"]'); const query = document.querySelector("#library-query"); if (!(button instanceof HTMLButtonElement) || !(mode instanceof HTMLButtonElement) || !(query instanceof HTMLInputElement)) return false; button.click(); mode.click(); query.value = "PROJECT_LITERAL_SENTINEL"; query.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); return true; })()`, "Project search");
  await waitFor(window, (value) => value.active === "a.md", "A active for Project search");
  await waitForScript(window, "document.querySelectorAll('#project-search-results button').length > 0", "Project result");
  await script(window, `(() => { const open = document.querySelector("#project-search-results button"); if (!(open instanceof HTMLButtonElement)) return false; open.click(); const source = document.querySelector("#project-search-source"); const insert = document.querySelector("#project-search-insert"); if (!(source instanceof HTMLTextAreaElement) || !(insert instanceof HTMLButtonElement)) return false; source.selectionStart = 0; source.selectionEnd = source.value.length; insert.click(); return true; })()`, "literal Project insertion");
  await waitFor(window, (value) => value.text.includes("PROJECT_LITERAL_SENTINEL") && value.status === "modified", "literal insertion into destination");
  if (path.basename(path.resolve(fixtureRoot)).length === 0) throw new Error("G smoke fixture root was invalid.");
}

/** Verify that G's ordered tabs survive the existing workspace restore path. */
export async function runGRestoreSmoke(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript("document.body?.offsetWidth ?? 0", true);
  await waitFor(
    window,
    (value) => value.ready
      && value.active === "a.md"
      && value.tabs.map((tab) => tab.trim()).join("|") === "c.md|a.md|b.md",
    "restored C, A, B tab order"
  );
}
