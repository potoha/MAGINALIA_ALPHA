import { access, readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import type { BrowserWindow } from "electron";
import { gitFs, MAIN_REF } from "./repository-local-history";
import * as git from "isomorphic-git";

const POLL_INTERVAL_MS = 25;
const STATE_TIMEOUT_MS = 20_000;
const INCOMPLETE_MARKER = "MAGINALIA-INCOMPLETE.txt";

interface RepositoryRendererState {
  readonly smokeReady: boolean;
  readonly repositoryKind: string;
  readonly repositoryName: string;
  readonly repositoryStatus: string;
  readonly repositoryError: string;
  readonly documentName: string;
  readonly activeManuscript: string | null;
  readonly documentText: string;
  readonly documentStatus: string;
  readonly saveEnabled: boolean;
  readonly historyStatus: string;
  readonly historyCount: number;
  readonly historyValues: readonly string[];
  readonly historySelection: string;
  readonly bodyText: string;
  readonly bodyHtml: string;
}

const READ_STATE_SCRIPT = `(() => {
  const editor = document.querySelector('#editor');
  const repositoryKind = document.querySelector('#repository-kind-label');
  const repositoryName = document.querySelector('#repository-name');
  const repositoryStatus = document.querySelector('#repository-status');
  const repositoryError = document.querySelector('#repository-error');
  const documentName = document.querySelector('#workspace-document-name');
  const manuscriptList = document.querySelector('#manuscript-list');
  const documentStatus = document.querySelector('#document-status');
  const save = document.querySelector('#save-markdown');
  const historyStatus = document.querySelector('#repository-history-status');
  const history = document.querySelector('#repository-history-entry');
  if (!editor || editor.dataset.smokeReady !== 'repository' || !repositoryKind || !repositoryName
    || !repositoryStatus || !repositoryError || !documentName || !manuscriptList || !documentStatus
    || !save || !historyStatus || !history) return null;
  const active = [...manuscriptList.querySelectorAll('button[data-manuscript-id]')]
    .find((button) => button.getAttribute('aria-current') === 'page');
  return {
    smokeReady: true,
    repositoryKind: repositoryKind.textContent ?? '',
    repositoryName: repositoryName.textContent ?? '',
    repositoryStatus: repositoryStatus.dataset.state ?? '',
    repositoryError: repositoryError.textContent ?? '',
    documentName: documentName.textContent ?? '',
    activeManuscript: active?.textContent ?? null,
    documentText: editor.dataset.smokeText ?? '',
    documentStatus: documentStatus.dataset.state ?? '',
    saveEnabled: !save.disabled,
    historyStatus: historyStatus.dataset.state ?? '',
    historyCount: history.options.length,
    historyValues: [...history.options].map((option) => option.value),
    historySelection: history.value,
    bodyText: document.body.textContent ?? '',
    bodyHtml: document.body.innerHTML ?? ''
  };
})()`;

interface RepositoryIdentityOnDisk {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
}

interface RepositorySnapshot {
  readonly identityId: string;
  readonly head: string;
  readonly index: Buffer;
  readonly manuscript: Buffer;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readRendererState(window: BrowserWindow): Promise<RepositoryRendererState | null> {
  try {
    return await window.webContents.executeJavaScript(READ_STATE_SCRIPT, true) as RepositoryRendererState | null;
  } catch (_error: unknown) {
    return null;
  }
}

async function waitForState(
  window: BrowserWindow,
  predicate: (state: RepositoryRendererState) => boolean,
  description: string,
): Promise<RepositoryRendererState> {
  const deadline = Date.now() + STATE_TIMEOUT_MS;
  let lastState: RepositoryRendererState | null = null;
  while (Date.now() < deadline) {
    lastState = await readRendererState(window);
    if (lastState && predicate(lastState)) return lastState;
    await delay(POLL_INTERVAL_MS);
  }
  const details = lastState
    ? ` Last state: repository ${lastState.repositoryStatus} (${lastState.repositoryKind}/${lastState.repositoryName}; ${lastState.repositoryError}), document ${lastState.documentStatus} ${lastState.activeManuscript} ${JSON.stringify(lastState.documentText)}, History ${lastState.historyStatus}.`
    : " Renderer probe was not available.";
  throw new Error(`Repository smoke timed out while waiting for ${description}.${details}`);
}

async function clickButton(window: BrowserWindow, selector: string, description: string): Promise<void> {
  const clicked = await window.webContents.executeJavaScript(
    `(() => {
      const button = document.querySelector(${JSON.stringify(selector)});
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.click();
      return true;
    })()`,
    true,
  ) as boolean;
  if (!clicked) throw new Error(`Repository smoke could not click ${description}.`);
}

async function setInput(window: BrowserWindow, selector: string, value: string): Promise<void> {
  const changed = await window.webContents.executeJavaScript(
    `(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      if (!(input instanceof HTMLInputElement) && !(input instanceof HTMLSelectElement)) return false;
      input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`,
    true,
  ) as boolean;
  if (!changed) throw new Error(`Repository smoke could not set ${selector}.`);
}

async function appendEditorText(window: BrowserWindow, text: string): Promise<void> {
  await window.webContents.executeJavaScript(
    `document.querySelector('#editor')?.dispatchEvent(new CustomEvent('maginalia-smoke-append', { detail: ${JSON.stringify(text)} }));`,
    true,
  );
}

async function selectFirstAuthoredHistory(window: BrowserWindow): Promise<void> {
  const selected = await window.webContents.executeJavaScript(
    `(() => {
      const select = document.querySelector('#repository-history-entry');
      if (!(select instanceof HTMLSelectElement) || select.options.length < 3 || select.disabled) return false;
      select.selectedIndex = 1;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`,
    true,
  ) as boolean;
  if (!selected) throw new Error("Repository smoke could not select the first authored History version.");
}

async function saveEditor(window: BrowserWindow): Promise<void> {
  await clickButton(window, "#save-markdown", "Save");
  await waitForState(
    window,
    (state) => state.documentStatus === "saved" && !state.saveEnabled,
    "the manuscript to be Saved",
  );
}

function assertTrue(value: boolean, description: string): void {
  if (!value) throw new Error(description + ".");
}

function assertEqual<T>(actual: T, expected: T, description: string): void {
  if (actual !== expected) {
    throw new Error(`${description}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
  }
}

async function readIdentity(root: string): Promise<RepositoryIdentityOnDisk | null> {
  try {
    return JSON.parse(await readFile(path.join(root, ".maginalia", "repository.json"), "utf8")) as RepositoryIdentityOnDisk;
  } catch (_error: unknown) {
    return null;
  }
}

async function findRepository(
  parent: string,
  kind: string,
  title: string,
): Promise<{ readonly root: string; readonly identity: RepositoryIdentityOnDisk }> {
  const entries = await readdir(parent, { withFileTypes: true });
  const observed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const root = path.join(parent, entry.name);
    const identity = await readIdentity(root);
    observed.push(`${entry.name}:${identity ? `${identity.kind}/${identity.title}/${identity.id}` : "no identity"}`);
    if (identity && identity.kind === kind && identity.title === title) {
      return { root, identity };
    }
  }
  throw new Error(`Repository smoke could not find the ${kind} repository in ${parent}; observed ${observed.join(", ") || "no directories"}.`);
}

async function readSnapshot(root: string): Promise<RepositorySnapshot> {
  const identity = await readIdentity(root);
  if (!identity) throw new Error("Repository smoke could not read the repository identity.");
  const head = await git.resolveRef({ fs: gitFs(), dir: root, ref: MAIN_REF });
  return {
    identityId: identity.id,
    head,
    index: await readFile(path.join(root, ".git", "index")),
    manuscript: await readFile(path.join(root, "manuscript.md")),
  };
}

async function markerExists(root: string): Promise<boolean> {
  try {
    await access(path.join(root, INCOMPLETE_MARKER));
    return true;
  } catch (_error: unknown) {
    return false;
  }
}

function assertSourceUnchanged(before: RepositorySnapshot, after: RepositorySnapshot): void {
  assertEqual(after.identityId, before.identityId, "source identity changed");
  assertEqual(after.head, before.head, "source History head changed");
  assertTrue(after.index.equals(before.index), "source index changed");
  assertTrue(after.manuscript.equals(before.manuscript), "source manuscript changed");
}

function assertRendererPrivacy(state: RepositoryRendererState, sourceRoot: string, head: string): void {
  const rendered = state.bodyText + state.bodyHtml;
  for (const privateValue of [sourceRoot, head, ".git", "MAGINALIA-INCOMPLETE.txt"]) {
    assertTrue(!rendered.includes(privateValue), `renderer exposed private repository evidence ${privateValue}`);
  }
  assertTrue(!/\b(?:oid|commit|head)\b/i.test(rendered), "renderer exposed local History implementation wording");
}

export async function runRepositorySmoke(window: BrowserWindow, smokeRoot: string): Promise<void> {
  const root = path.resolve(smokeRoot);
  const parent = path.join(root, "repository-parent");
  const destinationParent = path.join(root, "history-destination");
  assertTrue(parent !== destinationParent, "repository smoke requires separate repository and History parents");

  await waitForState(
    window,
    (state) => state.smokeReady && state.repositoryStatus === "idle" && state.documentStatus === "empty",
    "the repository renderer to be ready",
  );
  await setInput(window, "#repository-kind", "project");
  await setInput(window, "#repository-title", "Repository Smoke Project");
  await clickButton(window, "#create-repository", "Create Project");

  const projectOpened = await waitForState(
    window,
    (state) => state.repositoryKind === "Project"
      && state.repositoryName === "Repository Smoke Project"
      && state.repositoryStatus === "ready"
      && state.activeManuscript === "manuscript.md"
      && state.documentStatus === "saved"
      && !state.saveEnabled,
    "the Project and manuscript to activate",
  );
  const initialText = projectOpened.documentText;
  assertTrue(initialText.startsWith("# Repository Smoke Project"), "Project template text was not opened");

  const firstText = `${initialText}\nFIRST_HISTORY_VERSION`;
  await appendEditorText(window, "\nFIRST_HISTORY_VERSION");
  await waitForState(window, (state) => state.documentText === firstText && state.saveEnabled, "the first manuscript edit");
  await saveEditor(window);

  await clickButton(window, "#record-repository-history", "Record the first History version");
  await waitForState(window, (state) => state.historyStatus === "ready" && state.historyCount === 2, "the first authored History version");
  const project = await findRepository(parent, "project", "Repository Smoke Project");
  const firstSnapshot = await readSnapshot(project.root);
  assertRendererPrivacy(projectOpened, project.root, firstSnapshot.head);

  const secondText = `${firstText}\nSECOND_HISTORY_VERSION`;
  await appendEditorText(window, "\nSECOND_HISTORY_VERSION");
  await waitForState(window, (state) => state.documentText === secondText && state.saveEnabled, "the second manuscript edit");
  await saveEditor(window);
  await clickButton(window, "#record-repository-history", "Record the second History version");
  await waitForState(window, (state) => state.historyStatus === "ready" && state.historyCount === 3, "the second authored History version");
  const sourceBeforeCopy = await readSnapshot(project.root);

  await selectFirstAuthoredHistory(window);
  const selected = await waitForState(
    window,
    (state) => state.historySelection.length > 0 && state.historyCount === 3,
    "the first authored History selection",
  );
  assertTrue(selected.historySelection !== selected.historyValues[0], "History list was not newest-first");
  await clickButton(window, "#open-repository-history", "Open the older History copy");

  const copyOpened = await waitForState(
    window,
    (state) => state.repositoryStatus === "ready"
      && state.repositoryKind === "Project"
      && state.activeManuscript === "manuscript.md"
      && state.documentStatus === "saved"
      && !state.saveEnabled
      && state.documentText === firstText,
    "the older History copy as a fresh Project",
  );
  assertEqual(copyOpened.documentText, firstText, "History copy content");
  const copy = await findRepository(destinationParent, "project", "Repository Smoke Project");
  const copySnapshot = await readSnapshot(copy.root);
  assertEqual(copySnapshot.head, firstSnapshot.head, "History copy selected version");
  assertTrue(copySnapshot.manuscript.equals(firstSnapshot.manuscript), "History copy manuscript bytes");
  // The portable identity remains stable across a historical copy; the
  // owner-bound session handle is intentionally different and is covered by
  // the controller/API tests without exposing it in this renderer probe.
  assertEqual(copy.identity.id, project.identity.id, "History copy changed portable repository identity");
  assertTrue(!(await markerExists(copy.root)), "History copy still has its incomplete marker");
  assertSourceUnchanged(sourceBeforeCopy, await readSnapshot(project.root));
  assertRendererPrivacy(copyOpened, project.root, sourceBeforeCopy.head);
}
