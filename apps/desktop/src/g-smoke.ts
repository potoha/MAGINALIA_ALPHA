import * as path from "node:path";
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
  await window.webContents.executeJavaScript("document.body?.offsetWidth ?? 0", true);
  await script(window, `(() => { const overflow = document.querySelector("#project-overflow"); const open = document.querySelector("#open-project"); if (!(overflow instanceof HTMLButtonElement) || !(open instanceof HTMLButtonElement)) return false; overflow.click(); open.click(); return true; })()`, "open Project");
  await waitFor(window, (value) => value.ready && value.active === "a.md", "A open");

  await script(window, `window.dispatchEvent(new KeyboardEvent("keydown", { key: "1", ctrlKey: true, bubbles: true, cancelable: true })); true`, "Ctrl+1");
  await waitFor(window, (value) => value.text.startsWith("# "), "heading command");
  await script(window, `(() => { const undo = document.querySelector('[data-command-id="maginalia.editor.undo"]'); if (!(undo instanceof HTMLButtonElement)) return false; undo.click(); return true; })()`, "Undo command surface");
  await waitFor(window, (value) => !value.text.startsWith("# "), "undo restores source");

  await script(window, `window.dispatchEvent(new KeyboardEvent("keydown", { key: "P", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })); true`, "open Palette");
  await script(window, `(() => { const input = document.querySelector(".command-palette input"); if (!(input instanceof HTMLInputElement)) return false; input.value = "vertical"; input.dispatchEvent(new Event("input", { bubbles: true })); const result = document.querySelector('.command-palette-item[data-command-id="maginalia.renderer.setVertical"]'); if (!(result instanceof HTMLElement)) return false; input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); return true; })()`, "execute vertical Palette command");
  await script(window, `(() => { const preview = document.querySelector("#document-preview-mode"); if (!(preview instanceof HTMLButtonElement)) return false; preview.click(); return true; })()`, "open Preview");
  await waitFor(window, (value) => value.preview && value.direction === "vertical", "vertical preview without source mutation");
  await waitForScript(window, "document.querySelector('.rendered-internal-link.resolved') instanceof HTMLElement", "resolved internal link");

  await script(window, `(() => { const link = document.querySelector(".rendered-internal-link.resolved"); if (!(link instanceof HTMLElement)) return false; link.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })); return true; })()`, "open internal link");
  await waitFor(window, (value) => value.active === "b.md" && value.tabs.length === 2, "B opens once in a tab");
  await script(window, `(() => { const tab = [...document.querySelectorAll("#document-tabs .document-tab")].find((item) => item.querySelector(".document-tab-label")?.textContent?.startsWith("a.md")); const button = tab?.querySelector(".document-tab-label"); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true; })()`, "return to A");
  await waitFor(window, (value) => value.active === "a.md", "A active again");
  await script(window, `(() => { const preview = document.querySelector("#document-preview-mode"); if (!(preview instanceof HTMLButtonElement)) return false; preview.click(); return true; })()`, "reopen A Preview");
  await waitForScript(window, "document.querySelector('.rendered-internal-link.resolved') instanceof HTMLElement", "resolved A link after tab switch");
  await script(window, `(() => { const link = document.querySelector(".rendered-internal-link.resolved"); if (!(link instanceof HTMLElement)) return false; link.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })); return true; })()`, "activate existing internal link target");
  await waitFor(window, (value) => value.active === "b.md" && value.tabs.length === 2, "existing B tab activated without duplicate");

  await script(window, `(() => { const tab = [...document.querySelectorAll("#document-tabs .document-tab")].find((item) => item.querySelector(".document-tab-label")?.textContent?.startsWith("a.md")); const button = tab?.querySelector(".document-tab-label"); const mode = document.querySelector('[data-unified-search-mode="project"]'); const query = document.querySelector("#library-query"); if (!(button instanceof HTMLButtonElement) || !(mode instanceof HTMLButtonElement) || !(query instanceof HTMLInputElement)) return false; button.click(); mode.click(); query.value = "PROJECT_LITERAL_SENTINEL"; query.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); return true; })()`, "Project search");
  await waitFor(window, (value) => value.active === "a.md", "A active for Project search");
  await waitForScript(window, "document.querySelectorAll('#project-search-results button').length > 0", "Project result");
  await script(window, `(() => { const open = document.querySelector("#project-search-results button"); if (!(open instanceof HTMLButtonElement)) return false; open.click(); const source = document.querySelector("#project-search-source"); const insert = document.querySelector("#project-search-insert"); if (!(source instanceof HTMLTextAreaElement) || !(insert instanceof HTMLButtonElement)) return false; source.selectionStart = 0; source.selectionEnd = source.value.length; insert.click(); return true; })()`, "literal Project insertion");
  await waitFor(window, (value) => value.text.includes("PROJECT_LITERAL_SENTINEL") && value.status === "modified", "literal insertion into destination");
  if (path.basename(path.resolve(fixtureRoot)).length === 0) throw new Error("G smoke fixture root was invalid.");
}
