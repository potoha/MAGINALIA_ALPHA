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
    files: buttons.map((button) => button.dataset.manuscriptName ?? button.textContent ?? ""),
    activeFile: active?.dataset.manuscriptName ?? active?.textContent ?? null,
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
  throw new Error(`Project smoke timed out waiting for ${description}. Last state: ${last ? JSON.stringify(last) : "unavailable"}.`);
}

async function runScript(window: BrowserWindow, script: string, description = "renderer action"): Promise<void> {
  const result = await window.webContents.executeJavaScript(script, true) as boolean;
  if (!result) throw new Error(`Project smoke ${description} was unavailable.`);
}

async function assertProjectPanelFits(window: BrowserWindow): Promise<void> {
  const result = await window.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector("#workspace-navigation");
    if (!(panel instanceof HTMLElement)) return { fits: false, reason: "panel-missing" };
    return { fits: panel.scrollWidth <= panel.clientWidth + 1, scrollWidth: panel.scrollWidth, clientWidth: panel.clientWidth };
  })()`, true) as { fits: boolean; scrollWidth?: number; clientWidth?: number; reason?: string };
  if (!result.fits) {
    throw new Error(`Project panel overflow: ${result.reason ?? `${result.scrollWidth} > ${result.clientWidth}`}`);
  }
}

async function setProjectSmokeViewport(window: BrowserWindow): Promise<void> {
  window.setSize(420, 640);
  // A hidden/minimized Electron window may never service a renderer
  // requestAnimationFrame. Force one synchronous layout read, then yield to
  // the host so the resize styles settle without making the smoke hang.
  await window.webContents.executeJavaScript("document.body?.offsetWidth ?? 0", true);
  await delay(50);
}

async function createProjectFileThroughHeader(
  window: BrowserWindow,
  title: string,
  documentType: "memo" | "draft" | "body" | "other",
): Promise<void> {
  const result = await window.webContents.executeJavaScript(`(() => {
    const plus = document.querySelector("#project-new");
    const type = document.querySelector('[data-document-type="${documentType}"]');
    const inline = document.querySelector("#project-inline-create");
    const inlineType = document.querySelector("#project-inline-document-type");
    const menu = document.querySelector("#project-new-menu");
    const fail = (step) => ({ ok: false, step });
    if (!(plus instanceof HTMLButtonElement) || !(type instanceof HTMLButtonElement)
      || !(inline instanceof HTMLElement) || !(inlineType instanceof HTMLElement) || !(menu instanceof HTMLElement)) return fail("elements");
    plus.click(); type.click();
    if (inline.hidden || !menu.hidden || inlineType.textContent !== ${JSON.stringify(documentType)}
      || inline.scrollWidth > inline.clientWidth + 1) {
      const detail = inline.hidden ? "hidden" : "overflow " + inline.scrollWidth + " > " + inline.clientWidth;
      return fail("inline " + detail + " " + inlineType.textContent);
    }
    const titleInput = document.querySelector("#new-file-title");
    if (!(titleInput instanceof HTMLInputElement)) return fail("title-input");
    titleInput.value = ${JSON.stringify(title)};
    titleInput.dispatchEvent(new Event("input", { bubbles: true }));
    titleInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    return { ok: true };
  })()`, true) as { ok: boolean; step?: string };
  if (!result.ok) throw new Error(`Project create-file header smoke failed at ${result.step ?? "unknown"}.`);
}

async function exerciseProjectEscape(window: BrowserWindow): Promise<void> {
  await runScript(window, `(() => {
    const plus = document.querySelector("#project-new");
    const type = document.querySelector('[data-document-type="memo"]');
    const title = document.querySelector("#new-file-title");
    const inline = document.querySelector("#project-inline-create");
    if (!(plus instanceof HTMLButtonElement) || !(type instanceof HTMLButtonElement)
      || !(title instanceof HTMLInputElement) || !(inline instanceof HTMLElement)) return false;
    plus.click(); type.click(); title.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    const overflow = document.querySelector("#project-overflow");
    const overflowMenu = document.querySelector("#project-overflow-menu");
    if (!(overflow instanceof HTMLButtonElement) || !(overflowMenu instanceof HTMLElement)) return false;
    overflow.click(); overflowMenu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    return inline.hidden && !plus.disabled && overflowMenu.hidden
      && overflow.getAttribute("aria-expanded") === "false"
      && document.activeElement === overflow;
  })()`, "escape action");
}

async function exerciseProjectMenuKeyboard(window: BrowserWindow): Promise<void> {
  const result = await window.webContents.executeJavaScript(`(() => {
    const plus = document.querySelector("#project-new");
    const newMenu = document.querySelector("#project-new-menu");
    const overflow = document.querySelector("#project-overflow");
    const overflowMenu = document.querySelector("#project-overflow-menu");
    const fail = (step) => ({ ok: false, step });
    if (!(plus instanceof HTMLButtonElement) || !(newMenu instanceof HTMLElement)
      || !(overflow instanceof HTMLButtonElement) || !(overflowMenu instanceof HTMLElement)) return fail("elements");
    const items = (menu) => [...menu.querySelectorAll('button[role="menuitem"]')];
    const keydown = (element, key) => element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    const newItems = items(newMenu);
    const overflowItems = items(overflowMenu);
    // H adds Workdesk create/open beside the established Project actions;
    // both menus remain keyboard-addressable through the same menu surface.
    if (newItems.length !== 4 || overflowItems.length !== 4) return fail("menu-items");

    plus.focus();
    keydown(plus, "ArrowDown");
    return new Promise((resolve) => queueMicrotask(() => {
      if (newMenu.hidden || plus.getAttribute("aria-expanded") !== "true" || document.activeElement !== newItems[0]) return resolve(fail("new-arrow-down"));
      keydown(newItems[0], "ArrowDown");
      if (document.activeElement !== newItems[1]) return resolve(fail("new-item-arrow-down"));
      keydown(newItems[1], "End");
      if (document.activeElement !== newItems.at(-1)) return resolve(fail("new-end"));
      keydown(newItems.at(-1), "Home");
      if (document.activeElement !== newItems[0]) return resolve(fail("new-home"));
      keydown(newItems[0], "Escape");
      if (!newMenu.hidden || plus.getAttribute("aria-expanded") !== "false" || document.activeElement !== plus) return resolve(fail("new-escape"));

      overflow.focus();
      keydown(overflow, "ArrowUp");
      queueMicrotask(() => {
        if (overflowMenu.hidden || overflow.getAttribute("aria-expanded") !== "true" || document.activeElement !== overflowItems.at(-1)) return resolve(fail("overflow-arrow-up"));
        keydown(overflowItems.at(-1), "Home");
        if (document.activeElement !== overflowItems[0]) return resolve(fail("overflow-home"));
        keydown(overflowItems[0], "End");
        if (document.activeElement !== overflowItems.at(-1)) return resolve(fail("overflow-end"));
        keydown(overflowItems.at(-1), "Escape");
        resolve(overflowMenu.hidden && overflow.getAttribute("aria-expanded") === "false" && document.activeElement === overflow
          ? { ok: true }
          : fail("overflow-escape"));
      });
    }));
  })()`, true) as { ok: boolean; step?: string };
  if (!result.ok) throw new Error(`Project menu keyboard smoke failed at ${result.step ?? "unknown"}.`);
}

async function exerciseProjectRowKeyboard(window: BrowserWindow): Promise<void> {
  await runScript(window, `(() => {
    const buttons = [...document.querySelectorAll("#manuscript-list button[data-manuscript-id]")];
    if (buttons.length < 2 || !(buttons[0] instanceof HTMLButtonElement) || !(buttons.at(-1) instanceof HTMLButtonElement)) return false;
    const activeId = buttons.find((button) => button.getAttribute("aria-current") === "page")?.dataset.manuscriptId;
    const keydown = (element, key) => element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    buttons[0].focus();
    keydown(buttons[0], "ArrowDown");
    if (buttons[0].getAttribute("aria-selected") !== "false" || buttons[1].getAttribute("aria-selected") !== "true") return false;
    keydown(buttons[1], "Home");
    if (buttons[0].getAttribute("aria-selected") !== "true") return false;
    keydown(buttons[0], "End");
    if (buttons.at(-1)?.getAttribute("aria-selected") !== "true") return false;
    return buttons.find((button) => button.dataset.manuscriptId === activeId)?.getAttribute("aria-current") === "page";
  })()`);
}

export async function runProjectSmoke(window: BrowserWindow, fixtureRoot: string): Promise<void> {
  const rootName = path.basename(path.resolve(fixtureRoot));
  const fixture = path.join(fixtureRoot, "starter.md");
  const initialText = await readFile(fixture, "utf8");

  await setProjectSmokeViewport(window);
  await waitForState(window, (state) => state.ready && state.status === "empty", "Project renderer readiness");
  await assertProjectPanelFits(window);
  await runScript(window, `(() => {
    const overflow = document.querySelector("#project-overflow");
    const button = document.querySelector("#open-project");
    if (!(overflow instanceof HTMLButtonElement) || !(button instanceof HTMLButtonElement) || button.disabled) return false;
    overflow.click(); button.click(); return true;
  })()`, "open-project overflow action");
  await waitForState(window, (state) => state.projectName === rootName && state.activeFile === "starter.md" && state.text === initialText, "Project and first file");
  await assertProjectPanelFits(window);
  await exerciseProjectMenuKeyboard(window);

  await createProjectFileThroughHeader(window, "Smoke memo", "memo");
  await waitForState(window, (state) => state.activeFile === "Smoke memo.md" && state.files.includes("Smoke memo.md") && state.status === "saved", "New File open");

  await runScript(window, `(() => { document.querySelector("#editor")?.dispatchEvent(new CustomEvent("maginalia-smoke-append", { detail: "\\n追記" })); return true; })()`);
  await waitForState(window, (state) => state.activeFile === "Smoke memo.md" && state.status === "modified" && state.saveEnabled, "New File edit");
  await window.webContents.executeJavaScript("document.querySelector('#save-markdown')?.click();", true);
  await waitForState(window, (state) => state.activeFile === "Smoke memo.md" && state.status === "saved" && !state.saveEnabled, "New File save");

  const saved = await readFile(path.join(fixtureRoot, "Smoke memo.md"), "utf8");
  if (!saved.includes("type: memo") || !saved.includes("追記")) throw new Error("Project smoke saved file did not retain metadata and edit.");
  await exerciseProjectRowKeyboard(window);
  await runScript(window, `(() => { const button = [...document.querySelectorAll("#manuscript-list button[data-manuscript-id]")].find((candidate) => candidate.dataset.manuscriptName === "starter.md"); if (!(button instanceof HTMLButtonElement)) return false; button.focus(); button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); return true; })()`);
  await waitForState(window, (state) => state.activeFile === "starter.md" && state.text === initialText && state.status === "saved", "existing file reopen");
}

export async function runProjectRestoreSmoke(window: BrowserWindow, fixtureRoot: string): Promise<void> {
  const rootName = path.basename(path.resolve(fixtureRoot));
  const restoredFile = path.join(fixtureRoot, "Smoke memo.md");
  const restoredText = await readFile(restoredFile, "utf8");
  await setProjectSmokeViewport(window);
  await waitForState(
    window,
    (state) => state.ready
      && state.projectName === rootName
      && state.activeFile === "Smoke memo.md"
      && state.text === restoredText
      && state.status === "saved",
    "remembered Project and saved file after restart"
  );
  await runScript(window, `(() => { const button = [...document.querySelectorAll("#manuscript-list button[data-manuscript-id]")].find((candidate) => candidate.dataset.manuscriptName === "Smoke memo.md"); if (!(button instanceof HTMLButtonElement)) return false; button.focus(); button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); return true; })()`);
  await waitForState(window, (state) => state.activeFile === "Smoke memo.md" && state.text === restoredText && state.status === "saved", "reopen saved file after restart");
}

export async function runProjectCreateSmoke(window: BrowserWindow, parentRoot: string): Promise<void> {
  const projectName = "Coffee Smoke";
  await setProjectSmokeViewport(window);
  await waitForState(window, (state) => state.ready && state.status === "empty", "Project renderer readiness");
  await assertProjectPanelFits(window);
  await runScript(window, `(() => {
    const overflow = document.querySelector("#project-overflow");
    const create = document.querySelector("#project-create");
    const plus = document.querySelector("#project-new");
    const title = document.querySelector("#create-project-title");
    const form = document.querySelector("#project-create-form");
    if (!(overflow instanceof HTMLButtonElement) || !(create instanceof HTMLButtonElement)
      || !(plus instanceof HTMLButtonElement)
      || !(title instanceof HTMLInputElement) || !(form instanceof HTMLFormElement)) return false;
    if (!plus.disabled) return false;
    overflow.click(); create.click();
    if (form.hidden) return false;
    form.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    if (!form.hidden || !plus.disabled) return false;
    overflow.click(); create.click();
    title.value = ${JSON.stringify(projectName)}; form.requestSubmit(); return true;
  })()`);
  await waitForState(window, (state) => state.projectName === projectName && state.files.length === 0 && state.status === "empty", "new Project creation");
  await assertProjectPanelFits(window);
  await exerciseProjectMenuKeyboard(window);
  await exerciseProjectEscape(window);
  await createProjectFileThroughHeader(window, "Smoke memo", "memo");
  await waitForState(window, (state) => state.activeFile === "Smoke memo.md" && state.status === "saved", "new Project file");
  await runScript(window, `(() => { document.querySelector("#editor")?.dispatchEvent(new CustomEvent("maginalia-smoke-append", { detail: "\\n作成" })); return true; })()`);
  await waitForState(window, (state) => state.activeFile === "Smoke memo.md" && state.status === "modified" && state.saveEnabled, "new Project edit");
  await window.webContents.executeJavaScript("document.querySelector('#save-markdown')?.click();", true);
  await waitForState(window, (state) => state.activeFile === "Smoke memo.md" && state.status === "saved" && !state.saveEnabled, "new Project save");
  const saved = await readFile(path.join(parentRoot, projectName, "Smoke memo.md"), "utf8");
  if (!saved.includes("type: memo") || !saved.includes("作成")) throw new Error("Project creation smoke did not save metadata and content.");
}
