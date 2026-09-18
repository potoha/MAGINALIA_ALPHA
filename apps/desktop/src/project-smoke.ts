import { readFile } from "node:fs/promises";
import * as path from "node:path";
import type { BrowserWindow } from "electron";

const POLL_INTERVAL_MS = 25;
const STATE_TIMEOUT_MS = 15_000;

interface ProjectRendererState {
  readonly ready: boolean;
  readonly projectName: string;
  readonly files: readonly string[];
  readonly activeFile: string | null;
  readonly text: string;
  readonly status: string;
  readonly saveEnabled: boolean;
}

const READ_STATE_SCRIPT = `(() => {
  const editor = document.querySelector("#editor");
  const project = document.querySelector("#workspace-document-name");
  const list = document.querySelector("#manuscript-list");
  const status = document.querySelector("#document-status");
  const save = document.querySelector("#save-markdown");
  if (!editor || editor.dataset.smokeReady !== "project" || !project || !list || !status || !save) return null;
  const buttons = [...list.querySelectorAll("button[data-manuscript-id]")];
  const active = buttons.find((button) => button.getAttribute("aria-current") === "page");
  return {
    ready: true,
    projectName: project.textContent ?? "",
    files: buttons.map((button) => button.textContent ?? ""),
    activeFile: active?.textContent ?? null,
    text: editor.dataset.smokeText ?? "",
    status: status.dataset.state ?? "",
    saveEnabled: !save.disabled
  };
})()`;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readState(window: BrowserWindow): Promise<ProjectRendererState | null> {
  try {
    return await window.webContents.executeJavaScript(READ_STATE_SCRIPT, true) as ProjectRendererState | null;
  } catch (_error: unknown) {
    return null;
  }
}

async function waitForState(
  window: BrowserWindow,
  predicate: (state: ProjectRendererState) => boolean,
  description: string,
): Promise<ProjectRendererState> {
  const deadline = Date.now() + STATE_TIMEOUT_MS;
  let last: ProjectRendererState | null = null;
  while (Date.now() < deadline) {
    last = await readState(window);
    if (last && predicate(last)) return last;
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Project smoke timed out waiting for ${description}. Last state: ${last?.status ?? "unavailable"}.`);
}

async function runScript(window: BrowserWindow, script: string): Promise<void> {
  const result = await window.webContents.executeJavaScript(script, true) as boolean;
  if (!result) throw new Error("Project smoke renderer action was unavailable.");
}

export async function runProjectSmoke(window: BrowserWindow, fixtureRoot: string): Promise<void> {
  const rootName = path.basename(path.resolve(fixtureRoot));
  const fixture = path.join(fixtureRoot, "starter.md");
  const initialText = await readFile(fixture, "utf8");

  await waitForState(window, (state) => state.ready && state.status === "empty", "Project renderer readiness");
  await runScript(window, `(() => { const button = document.querySelector("#open-markdown"); if (!(button instanceof HTMLButtonElement) || button.disabled) return false; button.click(); return true; })()`);
  await waitForState(window, (state) => state.projectName === rootName && state.activeFile === "starter.md" && state.text === initialText, "Project and first file");

  await runScript(window, `(() => {
    const name = document.querySelector("#new-file-name");
    const title = document.querySelector("#new-file-title");
    const type = document.querySelector("#new-file-type");
    const form = document.querySelector("#new-file-form");
    if (!(name instanceof HTMLInputElement) || !(title instanceof HTMLInputElement) || !(type instanceof HTMLSelectElement) || !(form instanceof HTMLFormElement)) return false;
    name.value = "smoke.md"; title.value = "Smoke memo"; type.value = "memo"; form.requestSubmit(); return true;
  })()`);
  await waitForState(window, (state) => state.activeFile === "smoke.md" && state.files.includes("smoke.md") && state.status === "saved", "New File open");

  await runScript(window, `(() => { document.querySelector("#editor")?.dispatchEvent(new CustomEvent("maginalia-smoke-append", { detail: "\n追記" })); return true; })()`);
  await waitForState(window, (state) => state.activeFile === "smoke.md" && state.status === "modified" && state.saveEnabled, "New File edit");
  await window.webContents.executeJavaScript("document.querySelector('#save-markdown')?.click();", true);
  await waitForState(window, (state) => state.activeFile === "smoke.md" && state.status === "saved" && !state.saveEnabled, "New File save");

  const saved = await readFile(path.join(fixtureRoot, "smoke.md"), "utf8");
  if (!saved.includes("type: memo") || !saved.includes("追記")) throw new Error("Project smoke saved file did not retain metadata and edit.");
  await runScript(window, `(() => { const button = [...document.querySelectorAll("#manuscript-list button[data-manuscript-id]")].find((candidate) => candidate.textContent === "starter.md"); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true; })()`);
  await waitForState(window, (state) => state.activeFile === "starter.md" && state.text === initialText && state.status === "saved", "existing file reopen");
}
