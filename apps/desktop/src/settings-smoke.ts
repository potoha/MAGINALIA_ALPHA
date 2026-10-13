import { Menu, type BrowserWindow, type MenuItem } from "electron";

const TIMEOUT_MS = 15_000;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function evaluate<T>(window: BrowserWindow, source: string): Promise<T> {
  return await window.webContents.executeJavaScript(source, true) as T;
}

async function waitFor(window: BrowserWindow, source: string, label: string): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await evaluate<boolean>(window, source)) return;
    await delay(30);
  }
  const probe = await evaluate(window, `({dialogOpen:document.querySelector('#settings-center')?.open,active:document.activeElement?.outerHTML?.slice(0,250),status:document.querySelector('.settings-center-status')?.textContent})`);
  throw new Error(`Settings smoke timed out: ${label}; ${JSON.stringify(probe)}`);
}

async function click(window: BrowserWindow, selector: string): Promise<void> {
  const clicked = await evaluate<boolean>(window, `(() => {
    const item = document.querySelector(${JSON.stringify(selector)});
    if (!(item instanceof HTMLElement) || (item instanceof HTMLButtonElement && item.disabled)) return false;
    item.click(); return true;
  })()`);
  if (!clicked) throw new Error(`Settings smoke control unavailable: ${selector}`);
}

async function search(window: BrowserWindow, text: string): Promise<void> {
  await evaluate(window, `(() => {
    const input = document.querySelector('#settings-search');
    if (!(input instanceof HTMLInputElement)) throw new Error('Missing Settings search');
    input.value = ${JSON.stringify(text)}; input.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
}

async function key(window: BrowserWindow, keyCode: string, modifiers: Array<"control" | "shift" | "alt" | "meta"> = []): Promise<void> {
  window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  await delay(100);
}

function menuItem(id: string): MenuItem {
  const item = Menu.getApplicationMenu()?.getMenuItemById(id);
  if (item === undefined || item === null) throw new Error(`Settings smoke menu item missing: ${id}`);
  return item;
}

async function nativeClick(window: BrowserWindow, id: string): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (!menuItem(id).enabled && Date.now() < deadline) await delay(30);
  const item = menuItem(id);
  if (!item.enabled) throw new Error(`Settings smoke menu command is disabled: ${id}`);
  item.click(undefined, window, {});
}

async function closeSettings(window: BrowserWindow): Promise<void> {
  await key(window, "ESCAPE");
  await waitFor(window, "!document.querySelector('#settings-center')?.open", "close Settings with Escape");
}

const commandRow = (id: string): string => `#settings-center [data-command-id="${id}"]`;
const action = (id: string, name: string): string => `${commandRow(id)} [data-action="${name}"]`;
const direction = (expected: string): string => `JSON.parse(localStorage.getItem('maginalia.renderer.preferences.v1') || '{}').defaultWritingDirection === ${JSON.stringify(expected)}`;

/** Real Electron acceptance: native Menu callbacks, renderer IPC, OS key events and a second process profile restore. */
export async function runSettingsSmoke(window: BrowserWindow, restore: boolean): Promise<void> {
  window.show(); window.focus(); window.webContents.focus();
  await waitFor(window, "document.querySelector('#editor')?.dataset.smokeReady === 'true' && !!document.querySelector('#settings-center')", "Workbench and Settings ready");
  const groups = Menu.getApplicationMenu()?.items ?? [];
  if (groups.length < 7) throw new Error("Settings smoke requires all seven application menu groups");
  if (menuItem("maginalia.document.save").enabled) throw new Error("Save was enabled without a document");
  await nativeClick(window, "maginalia.document.open");
  await waitFor(window, "document.querySelector('#document-status')?.dataset.state === 'saved'", "native Open Document handler");
  const originalText = await evaluate<string>(window, "document.querySelector('#editor').dataset.smokeText");
  await nativeClick(window, "maginalia.settings.shortcuts");
  await waitFor(window, "document.querySelector('#settings-center')?.open", "native Shortcut Editor");
  const boundCommand = "maginalia.renderer.setVertical";
  await search(window, boundCommand);
  await waitFor(window, `!!document.querySelector(${JSON.stringify(commandRow(boundCommand))})`, "bindable command without a default");

  if (!restore) {
    console.log("MAGINALIA_SETTINGS_STAGE assign");
    await click(window, action(boundCommand, "record-binding"));
    await waitFor(window, "document.activeElement?.id === 'shortcut-recorder'", "focused key recorder");
    await key(window, "F9", ["control", "shift"]);
    await click(window, "#settings-center [data-action='save-binding']");
    await waitFor(window, `document.querySelector(${JSON.stringify(commandRow(boundCommand))})?.textContent.includes('Ctrl+Shift+F9')`, "saved no-default assignment");
    await closeSettings(window);
    console.log("MAGINALIA_SETTINGS_STAGE shared-commands");
    await evaluate(window, "document.querySelector('#editor').dispatchEvent(new Event('maginalia-smoke-focus'))");
    await key(window, "F9", ["control", "shift"]);
    await waitFor(window, direction("vertical"), "effective binding in Monaco context");
    if (!/^(?:Ctrl|Control)\+Shift\+F9$/u.test(String(menuItem(boundCommand).accelerator))) throw new Error("Native menu did not display the effective shortcut");
    if (menuItem(boundCommand).registerAccelerator) throw new Error("Native accelerator would duplicate renderer key dispatch");

    await nativeClick(window, "maginalia.renderer.setHorizontal");
    await waitFor(window, direction("horizontal"), "native orientation command");
    await key(window, "P", ["control", "shift"]);
    await waitFor(window, "!document.querySelector('.command-palette')?.hidden", "effective palette shortcut");
    await evaluate(window, `(() => { const input = document.querySelector('.command-palette input'); input.value = 'Set Vertical Writing'; input.dispatchEvent(new Event('input', {bubbles:true})); })()`);
    await key(window, "ENTER");
    await waitFor(window, direction("vertical"), "palette shares orientation handler");
    await nativeClick(window, "maginalia.help.cheatSheet");
    await search(window, "Ctrl+Shift+F9");
    await waitFor(window, `document.querySelector(${JSON.stringify(commandRow(boundCommand))})?.textContent.includes('Ctrl+Shift+F9')`, "Cheat Sheet effective assignment search");
    await closeSettings(window);

    console.log("MAGINALIA_SETTINGS_STAGE conflict-cancel");
    await nativeClick(window, "maginalia.settings.shortcuts");
    await search(window, boundCommand);
    await click(window, action(boundCommand, "record-binding"));
    await key(window, "S", ["control"]);
    await click(window, "#settings-center [data-action='save-binding']");
    await waitFor(window, "!!document.querySelector('#settings-center [data-action=replace-binding]')", "explicit shortcut conflict");
    await click(window, "#settings-center [data-action='cancel-binding']");
    await waitFor(window, `document.querySelector(${JSON.stringify(commandRow(boundCommand))})?.textContent.includes('Ctrl+Shift+F9')`, "cancel preserves previous assignment");
    await closeSettings(window);
  } else {
    console.log("MAGINALIA_SETTINGS_STAGE restart-unbind-reset");
    await waitFor(window, `document.querySelector(${JSON.stringify(commandRow(boundCommand))})?.textContent.includes('Ctrl+Shift+F9')`, "override survived process restart");
    await click(window, action(boundCommand, "unbind"));
    await closeSettings(window);
    await nativeClick(window, "maginalia.renderer.setHorizontal");
    await key(window, "F9", ["control", "shift"]);
    if (!await evaluate<boolean>(window, direction("horizontal"))) throw new Error("Unbound shortcut still executed");
    await nativeClick(window, "maginalia.settings.shortcuts");
    await search(window, boundCommand);
    await click(window, action(boundCommand, "reset-binding"));
    await closeSettings(window);
  }

  await nativeClick(window, "maginalia.settings.open");
  await search(window, "用紙");
  await waitFor(window, "!!document.querySelector('#settings-center [data-setting-id]')", "Japanese Settings metadata search");
  const dialogContainsFocus = await evaluate<boolean>(window, "document.querySelector('#settings-center').contains(document.activeElement)");
  if (!dialogContainsFocus) throw new Error("Settings dialog did not receive focus");
  await key(window, "TAB", ["shift"]);
  if (!await evaluate<boolean>(window, "document.querySelector('#settings-center').contains(document.activeElement)")) throw new Error("Keyboard focus escaped the modal");
  await closeSettings(window);
  const finalText = await evaluate<string>(window, "document.querySelector('#editor').dataset.smokeText");
  if (finalText !== originalText) throw new Error("Settings or command discovery modified the manuscript");
  console.log(`MAGINALIA_SETTINGS_EVIDENCE ${JSON.stringify({ restore, nativeMenu: true, keyboard: true, focus: true, unchangedManuscript: true })}`);
}
