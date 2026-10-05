import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const desktopRoot = path.resolve(path.dirname(scriptPath), "..");
const repositoryRoot = path.resolve(desktopRoot, "../..");
const electronExecutable = path.join(
  repositoryRoot,
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32"
    ? "electron.exe"
    : process.platform === "darwin"
      ? "Electron.app/Contents/MacOS/Electron"
      : "electron"
);
const marker = "MAGINALIA_ELECTRON_WORKBENCH_UI_SMOKE_OK";
const storageKey = "maginalia.workbench.layout.v1";

function assertTrue(value, message) {
  if (!value) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function runElectron(userDataPath) {
  const child = spawn(electronExecutable, [scriptPath, "--workbench-ui-child", userDataPath], {
    cwd: desktopRoot,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Electron workbench UI smoke timed out."));
    }, 60_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function runParent() {
  let temporaryDirectory;
  try {
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), "maginalia-workbench-ui-smoke-"));
    const result = await runElectron(temporaryDirectory);
    if (result.code !== 0 || !result.stdout.includes(marker)) {
      throw new Error(
        `Electron workbench UI smoke failed (exit ${result.code ?? result.signal}).\n${result.stdout}${result.stderr}`
      );
    }
    process.stdout.write(`${result.stdout}${result.stderr}`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function waitFor(window, predicate, description) {
  const deadline = Date.now() + 15_000;
  let lastValue;
  while (Date.now() < deadline) {
    const value = await window.webContents.executeJavaScript(predicate, true);
    if (value) return;
    lastValue = value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Workbench UI smoke timed out while waiting for ${description}; last value: ${JSON.stringify(lastValue)}.`);
}

async function reload(window) {
  const loaded = new Promise((resolve) => window.webContents.once("did-finish-load", resolve));
  window.webContents.reload();
  await loaded;
  await waitFor(window, "Boolean(document.querySelector('#workbench'))", "the reloaded workbench");
}

async function readState(window) {
  return await window.webContents.executeJavaScript(`(() => {
    const region = (selector) => document.querySelector(selector);
    const visual = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        display: style.display,
        visibility: style.visibility,
        visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0,
        width: rect.width,
        left: rect.left,
        right: rect.right
      };
    };
    const root = region('#workbench');
    const toolbar = region('#workbench-toolbar');
    const activity = region('#activity-bar');
    const primary = region('#primary-sidebar');
    const secondary = region('#secondary-sidebar');
    const secondaryResizer = region('#secondary-sidebar-resizer');
    const editor = region('.editor-area');
    const repositoryPanel = region('#repository-navigation');
    const menuPanel = region('#menu-navigation');
    const secondaryViewTabs = [...document.querySelectorAll('#secondary-view-tabs [role="tab"]')];
    if (!root || !toolbar || !activity || !primary || !secondary || !secondaryResizer || !editor || !repositoryPanel) return null;
    return {
      preloadBridge: typeof window.maginalia?.openMarkdown === 'function',
      editorOnly: root.dataset.editorOnly,
      activityHidden: activity.hidden,
      primaryHidden: primary.hidden,
      secondaryHidden: secondary.hidden,
      primaryWidth: Number(primary.dataset.width),
      secondaryWidth: Number(secondary.dataset.width),
      toolbar: visual(toolbar),
      activity: visual(activity),
      primary: visual(primary),
      secondary: visual(secondary),
      secondaryResizer: visual(secondaryResizer),
      editor: visual(editor),
      activityViewIds: [...document.querySelectorAll('[data-workbench-view]')].map((button) => button.dataset.workbenchView),
      secondaryTabIds: secondaryViewTabs.map((tab) => tab.dataset.secondaryViewTab),
      selectedSecondaryTab: secondaryViewTabs.find((tab) => tab.getAttribute('aria-selected') === 'true')?.dataset.secondaryViewTab ?? null,
      menuPanelVisible: visual(menuPanel).visible,
      menuContainsDocumentActions: Boolean(menuPanel?.querySelector('#open-markdown, #save-markdown, #export-pdf')),
      toolbarContainsDocumentActions: Boolean(toolbar.querySelector('#open-markdown, #save-markdown, #export-pdf')),
      repositoryActivityButton: Boolean(document.querySelector('[data-workbench-view="repository"]')),
      repositoryPanelVisible: visual(repositoryPanel).visible,
      activePrimaryPanel: primary.querySelector('.view-panel-active')?.dataset.workbenchViewPanel ?? null,
      activeSecondaryPanel: secondary.querySelector('.view-panel-active')?.dataset.workbenchViewPanel ?? null,
      viewportWidth: window.innerWidth,
      storedLayout: window.localStorage.getItem(${JSON.stringify(storageKey)})
    };
  })()`, true);
}

async function setStoredLayout(window, state) {
  await window.webContents.executeJavaScript(
    `window.localStorage.setItem(${JSON.stringify(storageKey)}, ${JSON.stringify(JSON.stringify(state))})`,
    true
  );
}

async function clickCommand(window, command) {
  const clicked = await window.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('[data-workbench-command=${JSON.stringify(command)}]');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`, true);
  assertTrue(clicked, `Workbench UI smoke could not click ${command}.`);
}

async function clickSecondaryTab(window, viewId) {
  const clicked = await window.webContents.executeJavaScript(`(() => {
    const tab = document.querySelector('#secondary-view-tabs [data-secondary-view-tab=${JSON.stringify(viewId)}]');
    if (!(tab instanceof HTMLButtonElement)) return false;
    tab.click();
    return true;
  })()`, true);
  assertTrue(clicked, `Workbench UI smoke could not select the ${viewId} secondary tab.`);
  try {
    await waitFor(window,
      `document.querySelector('#secondary-view-tabs [data-secondary-view-tab=${JSON.stringify(viewId)}]')?.getAttribute('aria-selected') === 'true'`,
      `${viewId} secondary tab selection`);
  } catch (error) {
    const state = await window.webContents.executeJavaScript(`(() => ({
      tabs: [...document.querySelectorAll('#secondary-view-tabs [role="tab"]')].map((tab) => ({
        id: tab.dataset.secondaryViewTab, selected: tab.getAttribute('aria-selected')
      })),
      activityMenuPressed: document.querySelector('#activity-view-menu')?.getAttribute('aria-pressed') ?? null,
      documentStatus: document.querySelector('#document-status')?.textContent ?? null,
      activePanel: document.querySelector('#secondary-sidebar .view-panel-active')?.dataset.workbenchViewPanel ?? null,
      storedLayout: window.localStorage.getItem(${JSON.stringify(storageKey)})
    }))()`, true);
    throw new Error(`${error instanceof Error ? error.message : String(error)} Diagnostic: ${JSON.stringify(state)}`);
  }
}

async function checkExplorerActionLayout(window) {
  const result = await window.webContents.executeJavaScript(`(() => {
    const list = document.createElement('ul');
    list.className = 'manuscript-list';
    list.dataset.navigationMode = 'project';
    list.style.cssText = 'position:fixed;left:0;top:0;width:260px;z-index:9999;background:#fff';
    const row = document.createElement('li');
    row.className = 'project-file-row';
    const file = document.createElement('button');
    file.className = 'manuscript-button';
    file.type = 'button';
    file.innerHTML = '<span class="project-file-title">A very long Unicode filename — 日本語の文書タイトル.md</span><small class="project-file-type">MEMO</small>';
    const actions = document.createElement('div');
    actions.className = 'explorer-row-actions';
    const sync = document.createElement('button');
    sync.className = 'project-header-action explorer-row-action';
    sync.type = 'button';
    sync.textContent = 'Sync';
    const remove = document.createElement('button');
    remove.className = 'project-header-action explorer-row-action';
    remove.type = 'button';
    remove.textContent = 'Delete';
    actions.append(sync, remove);
    row.append(file, actions);
    list.append(row);
    document.body.append(list);
    const hiddenByDefault = getComputedStyle(actions).display === 'none';
    file.focus();
    const visibleOnFocusWithin = getComputedStyle(actions).display === 'flex';
    const fileRect = file.getBoundingClientRect();
    const actionRect = actions.getBoundingClientRect();
    const noOverlap = fileRect.right <= actionRect.left + 1;
    const compactActions = [...actions.querySelectorAll('button')].every((button) => Number.parseFloat(getComputedStyle(button).fontSize) <= 12);
    list.remove();
    return { hiddenByDefault, visibleOnFocusWithin, noOverlap, compactActions };
  })()`, true);
  assertTrue(result.hiddenByDefault, 'Explorer row actions must be quiet by default.');
  assertTrue(result.visibleOnFocusWithin, 'Explorer row actions must appear for keyboard focus within the row.');
  assertTrue(result.noOverlap, 'Explorer row actions must not overlap the file button.');
  assertTrue(result.compactActions, 'Explorer row action typography must remain compact.');
}

async function resize(window, region, startX, endX) {
  const resized = await window.webContents.executeJavaScript(`(() => {
    const handle = document.querySelector('[data-workbench-resize=${JSON.stringify(region)}]');
    if (!(handle instanceof HTMLElement)) return false;
    handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: ${startX} }));
    document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: ${endX} }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: ${endX} }));
    return true;
  })()`, true);
  assertTrue(resized, `Workbench UI smoke could not resize ${region}.`);
}

async function press(window, key, options = {}) {
  await window.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown', {
    key: ${JSON.stringify(key)}, bubbles: true, cancelable: true,
    ctrlKey: ${Boolean(options.ctrlKey)}, shiftKey: ${Boolean(options.shiftKey)}
  }))`, true);
}

async function runChild(userDataPath) {
  const { app, BrowserWindow } = await import("electron");
  app.setPath("userData", userDataPath);
  await app.whenReady();

  const createWindow = () => new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(desktopRoot, "dist", "main", "preload.js")
    }
  });
  let window = createWindow();

  try {
    await window.loadFile(path.join(desktopRoot, "dist", "renderer", "index.html"), {
      query: { smoke: "workbench" }
    });
    await waitFor(window, "Boolean(document.querySelector('#workbench'))", "the workbench");
    await waitFor(window, "Boolean(document.querySelector('.command-palette'))", "Workbench command registration");

    let state = await readState(window);
    assertTrue(state?.preloadBridge, "Workbench did not receive the existing preload bridge.");
    assertEqual(state.primaryWidth, 300, "Initial primary sidebar width");
    assertEqual(state.secondaryWidth, 300, "Initial secondary sidebar width");
    assertEqual(state.toolbar.visible, true, "Initial toolbar visibility");
    assertEqual(state.activity.visible, true, "Initial activity bar visibility");
    assertEqual(state.primary.visible, true, "Initial primary sidebar visibility");
    assertEqual(state.secondary.visible, true, "Initial secondary sidebar visibility");
    assertTrue(state.editor.visible && state.editor.width > 0, "Initial editor area must have visible width.");
    assertEqual(JSON.stringify(state.activityViewIds), JSON.stringify(["workspace", "library", "menu", "properties"]), "Normal Activity Bar views");
    assertEqual(JSON.stringify(state.secondaryTabIds), JSON.stringify(["library", "menu", "properties"]), "Secondary sidebar tabs");
    assertEqual(state.selectedSecondaryTab, "library", "Initial Shelf tab selection");
    assertEqual(state.menuContainsDocumentActions, true, "Document operations must be mounted in Menu");
    assertEqual(state.toolbarContainsDocumentActions, false, "The top toolbar must not duplicate document operations");
    assertEqual(state.repositoryActivityButton, false, "Repository must not have a normal Activity Bar button");
    assertEqual(state.repositoryPanelVisible, false, "Repository panel must be hidden from normal UI");

    await clickSecondaryTab(window, "menu");
    state = await readState(window);
    assertEqual(state.activeSecondaryPanel, "menu", "Menu tab must activate the Menu view");
    assertEqual(state.menuPanelVisible, true, "Menu tab must display its panel");
    await window.webContents.executeJavaScript(`(() => {
      const tab = document.querySelector('#secondary-view-tabs [data-secondary-view-tab="menu"]');
      tab.focus();
      tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    })()`, true);
    await waitFor(window, `document.querySelector('#secondary-view-tabs [data-secondary-view-tab="properties"]')?.getAttribute('aria-selected') === 'true'`, "keyboard tab navigation to Properties");
    await window.webContents.executeJavaScript(`(() => {
      const tab = document.querySelector('#secondary-view-tabs [data-secondary-view-tab="properties"]');
      tab.focus();
      tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    })()`, true);
    await waitFor(window, `document.querySelector('#secondary-view-tabs [data-secondary-view-tab="library"]')?.getAttribute('aria-selected') === 'true'`, "keyboard tab navigation back to Shelf");
    await checkExplorerActionLayout(window);

    await setStoredLayout(window, {
      activityBarVisible: true,
      primarySidebarVisible: true,
      primarySidebarWidth: 300,
      secondarySidebarVisible: true,
      secondarySidebarWidth: 300,
      activePrimaryView: "repository",
      activeSecondaryView: "removed-secondary-view"
    });
    await reload(window);
    state = await readState(window);
    const normalizedUnknownViews = JSON.parse(state.storedLayout ?? "null");
    assertEqual(normalizedUnknownViews.activePrimaryView, "workspace", "Repository view fallback after manifest removal");
    assertEqual(normalizedUnknownViews.activeSecondaryView, "library", "Unknown persisted secondary view fallback");
    assertEqual(state.activePrimaryPanel, "workspace", "Unknown primary view must show the fallback panel");
    assertEqual(state.activeSecondaryPanel, "library", "Unknown secondary view must show the fallback panel");

    await resize(window, "primary-sidebar", 100, 221);
    await resize(window, "secondary-sidebar", 800, 740);
    state = await readState(window);
    assertEqual(state.primaryWidth, 421, "Resized primary sidebar width");
    assertEqual(state.secondaryWidth, 360, "Resized secondary sidebar width");

    await clickCommand(window, "maginalia.view.togglePrimarySidebar");
    state = await readState(window);
    assertEqual(state.primaryHidden, true, "Primary sidebar toggle");
    assertEqual(state.secondaryHidden, false, "Primary toggle must leave secondary sidebar visible");
    assertEqual(state.primary.display, "none", "Primary sidebar must be visually removed");
    assertEqual(state.secondary.visible, true, "Secondary sidebar must remain visually present");

    await clickCommand(window, "maginalia.view.toggleSecondarySidebar");
    state = await readState(window);
    assertEqual(state.primaryHidden, true, "Secondary toggle must preserve primary sidebar state");
    assertEqual(state.secondaryHidden, true, "Secondary sidebar toggle");
    assertEqual(state.primary.display, "none", "Primary sidebar remains visually removed");
    assertEqual(state.secondary.display, "none", "Secondary sidebar must be visually removed");

    await clickCommand(window, "maginalia.view.toggleActivityBar");
    state = await readState(window);
    assertEqual(state.activityHidden, true, "Activity bar toggle");
    assertEqual(state.editorOnly, "true", "All regions hidden should reduce to editor-only mode");
    assertEqual(state.activity.display, "none", "Activity bar must be visually removed");
    assertTrue(state.editor.visible && state.editor.width > 0, "Editor-only mode must retain a visible editor area.");
    const persisted = JSON.parse(state.storedLayout ?? "null");
    assertEqual(persisted.primarySidebarWidth, 421, "Persisted primary sidebar width");
    assertEqual(persisted.secondarySidebarWidth, 360, "Persisted secondary sidebar width");

    await reload(window);
    state = await readState(window);
    assertEqual(state.activityHidden, true, "Reloaded activity bar visibility");
    assertEqual(state.primaryHidden, true, "Reloaded primary sidebar visibility");
    assertEqual(state.secondaryHidden, true, "Reloaded secondary sidebar visibility");
    assertEqual(state.primaryWidth, 421, "Reloaded primary sidebar width");
    assertEqual(state.secondaryWidth, 360, "Reloaded secondary sidebar width");
    assertEqual(state.toolbar.display, "none", "Reloaded editor-only toolbar visibility");
    assertEqual(state.activity.display, "none", "Reloaded editor-only activity visibility");
    assertEqual(state.primary.display, "none", "Reloaded editor-only primary visibility");
    assertEqual(state.secondary.display, "none", "Reloaded editor-only secondary visibility");
    assertTrue(state.editor.visible && state.editor.width > 0, "Reloaded editor-only mode must retain a visible editor area.");

    await press(window, "Escape");
    state = await readState(window);
    assertEqual(state.editorOnly, "false", "Escape must exit a manually hidden shell");
    assertTrue(state.editor.visible && state.editor.width > 0, "Manual-shell Escape must not leave a blank editor.");
    assertTrue(state.toolbar.visible || state.activity.visible, "Manual-shell Escape must restore a usable shell control.");

    await clickCommand(window, "maginalia.view.togglePrimarySidebar");
    await clickCommand(window, "maginalia.view.toggleEditorOnly");
    state = await readState(window);
    assertEqual(state.editorOnly, "true", "Editor-only command");
    assertEqual(state.toolbar.display, "none", "Editor-only command must hide toolbar");
    assertEqual(state.activity.display, "none", "Editor-only command must hide activity bar");
    assertEqual(state.primary.display, "none", "Editor-only command must hide primary sidebar");
    assertEqual(state.secondary.display, "none", "Editor-only command must hide secondary sidebar");
    assertTrue(state.editor.visible && state.editor.width > 0, "Editor-only command must leave only a visible editor area.");

    await press(window, "Escape");
    state = await readState(window);
    assertEqual(state.editorOnly, "false", "Editor-only restoration");
    assertEqual(state.activityHidden, false, "Editor-only restores activity visibility");
    assertEqual(state.primaryHidden, true, "Editor-only restores primary visibility");
    assertEqual(state.secondaryHidden, false, "Editor-only restores secondary visibility");
    assertEqual(state.toolbar.visible, true, "Editor-only restoration must show toolbar");
    assertEqual(state.activity.visible, true, "Editor-only restoration must show activity bar");
    assertEqual(state.primary.display, "none", "Editor-only restoration must preserve primary hidden state");
    assertEqual(state.secondary.visible, true, "Editor-only restoration must preserve secondary visible state");
    assertTrue(state.editor.visible && state.editor.width > 0, "Editor-only restoration must retain editor width.");

    await clickCommand(window, "maginalia.view.togglePrimarySidebar");
    const previousWindow = window;
    window = createWindow();
    await window.loadFile(path.join(desktopRoot, "dist", "renderer", "index.html"), {
      query: { smoke: "workbench" }
    });
    await waitFor(window, "Boolean(document.querySelector('#workbench'))", "the recreated workbench");
    previousWindow.destroy();
    state = await readState(window);
    assertEqual(state.activityHidden, false, "Final activity bar persistence");
    assertEqual(state.primaryHidden, false, "Final primary sidebar persistence");
    assertEqual(state.secondaryHidden, false, "Final secondary sidebar persistence");
    assertEqual(state.primaryWidth, 421, "Final primary width persistence");
    assertEqual(state.secondaryWidth, 360, "Final secondary width persistence");
    assertEqual(state.toolbar.visible, true, "Final toolbar visibility");
    assertEqual(state.activity.visible, true, "Final activity bar visibility");
    assertEqual(state.primary.visible, true, "Final primary sidebar visibility");
    assertEqual(state.secondary.visible, true, "Final secondary sidebar visibility");
    assertTrue(state.editor.visible && state.editor.width > 0, "Final restored editor area must have visible width.");

    window.setSize(420, 480);
    await window.webContents.executeJavaScript("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))", true);
    state = await readState(window);
    assertTrue(state.viewportWidth <= 420, "Tiny-window viewport width");
    assertTrue(
      state.editor.visible && state.editor.width > 0 && state.editor.left < state.viewportWidth && state.editor.right > 0,
      "Tiny window must retain an editor area visible within the viewport."
    );
    const secondaryWithinViewport = state.secondary.right <= state.viewportWidth + 1;
    const secondaryResizerReachable = state.secondaryResizer.visible
      && state.secondaryResizer.left >= 0
      && state.secondaryResizer.right <= state.viewportWidth;
    assertTrue(
      secondaryWithinViewport && secondaryResizerReachable,
      `Tiny window secondary geometry: sidebar=[${state.secondary.left},${state.secondary.right}], `
        + `resizer=[${state.secondaryResizer.left},${state.secondaryResizer.right}], viewport=${state.viewportWidth} (1px edge tolerance).`
    );

    process.stdout.write(`${marker}\n`);
  } finally {
    if (!window.isDestroyed()) window.destroy();
    app.quit();
  }
}

if (process.argv.includes("--workbench-ui-child")) {
  const userDataPath = process.argv.at(-1);
  if (!userDataPath || userDataPath === "--workbench-ui-child") {
    process.stderr.write("Workbench UI smoke user-data path was not provided.\n");
    process.exitCode = 1;
  } else {
    runChild(userDataPath).catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  }
} else {
  await runParent();
}
