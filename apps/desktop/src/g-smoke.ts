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
  const active = [...document.querySelectorAll("#explorer-tree button[data-explorer-file-id]")].find((item) => item.getAttribute("aria-current") === "page");
  if (!(editor instanceof HTMLElement) || editor.dataset.smokeReady !== "project" || !(status instanceof HTMLElement)) return null;
  return { ready: true, active: active?.dataset.explorerFileName ?? null, text: editor.dataset.smokeText ?? "", status: status.dataset.state ?? "", tabs: [...document.querySelectorAll("#document-tabs .document-tab-label")].map((item) => item.textContent ?? ""), preview: !document.querySelector("#markdown-preview")?.hidden, direction: document.querySelector(".markdown-preview-document")?.getAttribute("data-writing-direction") ?? "" };
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

async function pressEnter(window: BrowserWindow): Promise<void> {
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "ENTER" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "ENTER" });
}

async function waitForScript(window: BrowserWindow, source: string, description: string): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(source, true) as boolean) return;
    await delay(POLL_MS);
  }
  throw new Error(`G smoke timed out waiting for ${description}.`);
}

async function exerciseTrailingPreviewInsertion(
  window: BrowserWindow,
  displayName: string,
  initialSource: string,
  separator: string,
  insertedText: string
): Promise<void> {
  await script(window, `(() => {
    const source = [...document.querySelectorAll('#explorer-tree button[data-explorer-file-id]')]
      .find((item) => item.dataset.explorerFileName === ${JSON.stringify(displayName)});
    if (!(source instanceof HTMLButtonElement)) return false;
    source.click();
    const preview = document.querySelector('#document-preview-mode');
    if (!(preview instanceof HTMLButtonElement)) return false;
    if (preview.getAttribute('aria-pressed') !== 'true') preview.click();
    return true;
  })()`, `open ${displayName} in Preview`);
  await waitFor(window, (value) => value.active === displayName && value.preview, `${displayName} Preview`);
  await waitForScript(window, `document.querySelector('.markdown-preview-trailing-insertion') instanceof HTMLParagraphElement`, `${displayName} trailing Preview position`);
  if (initialSource.includes("maginalia:synced-block")) {
    await waitForScript(window, `document.querySelector('.rendered-synced-block[data-synced-block-state="resolved"]') instanceof HTMLElement`, `${displayName} resolved Synced Block`);
  }
  const trailingClickPoint = await window.webContents.executeJavaScript(`(() => {
    const root = document.querySelector('.markdown-preview-document');
    const trailing = document.querySelector('.markdown-preview-trailing-insertion');
    if (!(root instanceof HTMLElement) || !(trailing instanceof HTMLParagraphElement)) return null;
    const rootBounds = root.getBoundingClientRect();
    const trailingBounds = trailing.getBoundingClientRect();
    const lastBlock = [...root.children].filter((item) => item !== trailing).at(-1);
    if (!(lastBlock instanceof HTMLElement)) return null;
    const lastBounds = lastBlock.getBoundingClientRect();
    const vertical = getComputedStyle(root).writingMode.startsWith('vertical');
    const x = Math.floor(rootBounds.left + 4);
    const availableBelow = rootBounds.bottom - trailingBounds.bottom;
    const y = vertical
      ? Math.floor(rootBounds.top + rootBounds.height / 2)
      : Math.floor(trailingBounds.bottom + Math.min(8, availableBelow - 2));
    const afterLastBlock = vertical ? x <= lastBounds.left : y >= lastBounds.bottom;
    return (vertical || availableBelow >= 4) && afterLastBlock && document.elementFromPoint(x, y) === root ? { x, y } : null;
  })()`, true) as { readonly x: number; readonly y: number } | null;
  if (trailingClickPoint === null) throw new Error(`G smoke could not locate blank Preview canvas below ${displayName}.`);
  await script(window, `(() => {
    const root = document.querySelector('.markdown-preview-document');
    if (!(root instanceof HTMLElement)) return false;
    root.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: ${trailingClickPoint.x}, clientY: ${trailingClickPoint.y} }));
    return true;
  })()`, `click blank Preview canvas below ${displayName}`);
  const lineBreakVariants = ["\n", "\r\n", "\r"];
  const boundarySources = lineBreakVariants.map((lineBreak) => `${initialSource}${separator.replace(/\n/gu, lineBreak)}`);
  const boundaryState = await waitFor(window, (value) => value.active === displayName && boundarySources.includes(value.text), `${displayName} source boundary`);
  const boundarySource = boundaryState.text;
  const caretReady = await window.webContents.executeJavaScript(`(() => {
    const trailing = document.querySelector('.markdown-preview-trailing-insertion');
    const editor = document.querySelector('#editor');
    const selection = document.getSelection();
    if (!(trailing instanceof HTMLParagraphElement) || !(editor instanceof HTMLElement) || selection === null) return false;
    const source = editor.dataset.smokeText ?? '';
    const start = Number(trailing.dataset.previewSourceStart);
    const end = Number(trailing.dataset.previewSourceEnd);
    const anchor = selection.anchorNode;
    return document.activeElement === trailing
      && trailing.dataset.previewTrailingActive === 'true'
      && start === source.length && end === source.length
      && selection.isCollapsed && (anchor === trailing || (anchor instanceof Node && trailing.contains(anchor)))
      && !/[\\u200b-\\u200d\\u2060]/u.test(source);
  })()`, true) as boolean;
  if (!caretReady) throw new Error(`G smoke did not map the ${displayName} trailing caret to the end of source.`);

  await script(window, `(() => { const trailing = document.querySelector('.markdown-preview-trailing-insertion'); if (!(trailing instanceof HTMLParagraphElement)) return false; trailing.click(); return true; })()`, `repeat ${displayName} trailing click`);
  const repeatedClick = await state(window);
  if (repeatedClick?.text !== boundarySource) throw new Error(`G smoke repeated ${displayName} trailing click added another source boundary.`);

  await window.webContents.insertText(insertedText);
  const expectedSource = `${boundarySource}${insertedText}`;
  await waitFor(window, (value) => value.active === displayName && value.text === expectedSource, `${displayName} trailing source edit`);
  const hasNoPlaceholder = await window.webContents.executeJavaScript(`(() => {
    const editor = document.querySelector('#editor');
    return editor instanceof HTMLElement && !/[\\u200b-\\u200d\\u2060]/u.test(editor.dataset.smokeText ?? '');
  })()`, true) as boolean;
  if (!hasNoPlaceholder) throw new Error(`G smoke persisted a Preview placeholder in ${displayName}.`);
}

async function exercisePreviewEnter(
  window: BrowserWindow,
  displayName: string,
  initialSource: string,
  lineEnding: "\n" | "\r\n"
): Promise<void> {
  await script(window, `(() => {
    const source = [...document.querySelectorAll('#explorer-tree button[data-explorer-file-id]')]
      .find((item) => item.dataset.explorerFileName === ${JSON.stringify(displayName)});
    const preview = document.querySelector('#document-preview-mode');
    if (!(source instanceof HTMLButtonElement) || !(preview instanceof HTMLButtonElement)) return false;
    source.click();
    if (preview.getAttribute('aria-pressed') !== 'true') preview.click();
    return true;
  })()`, `open ${displayName} for Enter smoke`);
  await waitFor(window, (value) => value.active === displayName && value.preview && value.text === initialSource, `${displayName} initial Preview`);
  await script(window, `(() => {
    const editable = [...document.querySelectorAll('.markdown-preview-editable-text')].find((item) => item.textContent === '前🌸日本語後続');
    if (!(editable instanceof HTMLElement) || editable.firstChild === null) return false;
    editable.focus();
    const selection = document.getSelection();
    if (selection === null) return false;
    const range = document.createRange();
    range.setStart(editable.firstChild, '前🌸'.length);
    range.setEnd(editable.firstChild, '前🌸日本語'.length);
    selection.removeAllRanges(); selection.addRange(range);
    editable.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    const replacement = document.createTextNode('日本語確定');
    range.deleteContents(); range.insertNode(replacement);
    range.setStartAfter(replacement); range.collapse(true);
    selection.removeAllRanges(); selection.addRange(range);
    editable.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: '日本語確定', isComposing: true, bubbles: true }));
    const composing = new InputEvent('beforeinput', { inputType: 'insertParagraph', isComposing: true, bubbles: true, cancelable: true });
    editable.dispatchEvent(composing);
    const legacyImeEnter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    Object.defineProperty(legacyImeEnter, 'keyCode', { value: 229 });
    editable.dispatchEvent(legacyImeEnter);
    const compositionend = new CompositionEvent('compositionend', { bubbles: true, data: '日本語確定' });
    editable.dispatchEvent(compositionend);
    const editor = document.querySelector('#editor');
    const expected = ${JSON.stringify(initialSource.replace("日本語", "日本語確定"))};
    return editor instanceof HTMLElement && editor.dataset.smokeText === expected
      && !composing.defaultPrevented && !legacyImeEnter.defaultPrevented
      && document.activeElement === editable && editable.textContent === '前🌸日本語確定後続';
  })()`, `${displayName} commits Japanese composition without an Enter and ignores composing Enter`);

  const composedSource = initialSource.replace("日本語", "日本語確定");
  const splitAt = "前🌸日本語確定";
  const line = "前🌸日本語確定後続";
  const lineIndex = composedSource.indexOf(line);
  if (lineIndex < 0) throw new Error(`G smoke ${displayName} fixture is missing the Japanese line.`);
  const enteredSource = `${composedSource.slice(0, lineIndex)}${splitAt}${lineEnding}${composedSource.slice(lineIndex + splitAt.length)}`;
  await script(window, `(() => {
    const editable = [...document.querySelectorAll('.markdown-preview-editable-text')].find((item) => item.textContent === '前🌸日本語確定後続');
    if (!(editable instanceof HTMLElement) || editable.firstChild === null) return false;
    editable.normalize();
    editable.focus();
    const selection = document.getSelection();
    if (selection === null) return false;
    const range = document.createRange();
    range.setStart(editable.firstChild, '前🌸日本語確定'.length);
    range.collapse(true);
    selection.removeAllRanges(); selection.addRange(range);
    return true;
  })()`, `${displayName} positions the source caret for native Enter`);
  await pressEnter(window);
  await waitFor(window, (value) => value.active === displayName && value.text === enteredSource, `${displayName} exact line-break source edit`);
  const caretReady = await window.webContents.executeJavaScript(`(() => {
    const preview = document.querySelector('#markdown-preview');
    const editor = document.querySelector('#editor');
    const target = document.activeElement;
    const selection = document.getSelection();
    if (!(preview instanceof HTMLElement) || preview.hidden || !(editor instanceof HTMLElement)
      || !(target instanceof HTMLElement) || !target.classList.contains('markdown-preview-editable-text')
      || selection === null || !selection.isCollapsed || selection.anchorNode === null) return false;
    const relative = document.createRange();
    relative.selectNodeContents(target);
    relative.setEnd(selection.anchorNode, selection.anchorOffset);
    const sourceCaret = Number(target.dataset.previewSourceStart) + relative.toString().length;
    const expectedCaret = ${JSON.stringify(enteredSource)}.indexOf(${JSON.stringify(`${splitAt}${lineEnding}`)}) + ${JSON.stringify(`${splitAt}${lineEnding}`)}.length;
    const visibleBreak = [...preview.querySelectorAll('br.markdown-preview-source-line-break')].find((item) => Number(item.dataset.previewSourceStart) === expectedCaret - ${lineEnding.length});
    return sourceCaret === expectedCaret && editor.dataset.smokeText === ${JSON.stringify(enteredSource)}
      && visibleBreak instanceof HTMLBRElement && visibleBreak.getAttribute('contenteditable') === 'false'
      && Number(visibleBreak.dataset.previewSourceEnd) - Number(visibleBreak.dataset.previewSourceStart) === ${lineEnding.length};
  })()`, true) as boolean;
  if (!caretReady) throw new Error(`G smoke did not show the source-mapped ${displayName} line break and restore its caret after Enter.`);

  const emptyLineSource = enteredSource.replace(`${splitAt}${lineEnding}`, `${splitAt}${lineEnding}${lineEnding}`);
  await script(window, `(() => {
    const editable = [...document.querySelectorAll('.markdown-preview-editable-text')].find((item) => item.textContent === ${JSON.stringify(splitAt)});
    if (!(editable instanceof HTMLElement) || editable.firstChild === null) return false;
    editable.focus();
    const selection = document.getSelection();
    if (selection === null) return false;
    const range = document.createRange();
    range.setStart(editable.firstChild, editable.textContent.length);
    range.collapse(true);
    selection.removeAllRanges(); selection.addRange(range);
    return true;
  })()`, `${displayName} positions Enter before an existing source line break`);
  await pressEnter(window);
  await waitFor(window, (value) => value.text === emptyLineSource, `${displayName} renderer-local empty line`);
  const emptyLineCaretReady = await window.webContents.executeJavaScript(`(() => {
    const target = document.activeElement;
    const editor = document.querySelector('#editor');
    const selection = document.getSelection();
    if (!(target instanceof HTMLElement) || target.dataset.previewCaretOnly !== 'true'
      || target.textContent !== '' || !(editor instanceof HTMLElement) || selection === null || !selection.isCollapsed) return false;
    const relative = document.createRange();
    relative.selectNodeContents(target);
    if (selection.anchorNode === null) return false;
    relative.setEnd(selection.anchorNode, selection.anchorOffset);
    const sourceCaret = Number(target.dataset.previewSourceStart) + relative.toString().length;
    const expectedCaret = ${JSON.stringify(emptyLineSource)}.indexOf(${JSON.stringify(`${splitAt}${lineEnding}${lineEnding}`)}) + ${JSON.stringify(`${splitAt}${lineEnding}`)}.length;
    return sourceCaret === expectedCaret && editor.dataset.smokeText === ${JSON.stringify(emptyLineSource)}
      && !/[\\u200b-\\u200d\\u2060]/u.test(editor.dataset.smokeText ?? '');
  })()`, true) as boolean;
  if (!emptyLineCaretReady) throw new Error(`G smoke did not use a renderer-only source-mapped empty caret in ${displayName}.`);
  await window.webContents.insertText("空行");
  const filledEmptyLineSource = emptyLineSource.replace(`${splitAt}${lineEnding}${lineEnding}`, `${splitAt}${lineEnding}空行${lineEnding}`);
  await waitFor(window, (value) => value.text === filledEmptyLineSource, `${displayName} typing into the empty Preview line`);
  await window.webContents.insertText("挿入");
  const continuedSource = filledEmptyLineSource.replace("空行", "空行挿入");
  await waitFor(window, (value) => value.text === continuedSource, `${displayName} continued Preview typing`);
  await script(window, `(() => { const edit = document.querySelector('#document-edit-mode'); if (!(edit instanceof HTMLButtonElement)) return false; edit.click(); return true; })()`, `return ${displayName} to Edit`);
  await waitFor(window, (value) => value.active === displayName && !value.preview && value.text === continuedSource, `${displayName} Edit round-trip`);
  await script(window, `(() => { const preview = document.querySelector('#document-preview-mode'); if (!(preview instanceof HTMLButtonElement)) return false; preview.click(); return true; })()`, `return ${displayName} to Preview`);
  await waitFor(window, (value) => value.preview && value.text === continuedSource, `${displayName} Preview round-trip`);
}

async function exercisePreviewEnterAtEnd(
  window: BrowserWindow,
  displayName: string,
  initialSource: string
): Promise<void> {
  await script(window, `(() => {
    const source = [...document.querySelectorAll('#explorer-tree button[data-explorer-file-id]')]
      .find((item) => item.dataset.explorerFileName === ${JSON.stringify(displayName)});
    const preview = document.querySelector('#document-preview-mode');
    if (!(source instanceof HTMLButtonElement) || !(preview instanceof HTMLButtonElement)) return false;
    source.click();
    if (preview.getAttribute('aria-pressed') !== 'true') preview.click();
    return true;
  })()`, `open ${displayName} for trailing Enter smoke`);
  await waitFor(window, (value) => value.active === displayName && value.preview && value.text === initialSource, `${displayName} initial Preview`);
  await script(window, `(() => {
    const editable = [...document.querySelectorAll('.markdown-preview-editable-text')].find((item) => item.textContent === ${JSON.stringify(initialSource)});
    if (!(editable instanceof HTMLElement) || editable.firstChild === null) return false;
    editable.focus();
    const selection = document.getSelection();
    if (selection === null) return false;
    const range = document.createRange();
    range.setStart(editable.firstChild, editable.textContent.length);
    range.collapse(true);
    selection.removeAllRanges(); selection.addRange(range);
    return true;
  })()`, `${displayName} positions Enter at document end`);
  await pressEnter(window);
  const firstState = await waitFor(window, (value) => value.active === displayName
    && (value.text === `${initialSource}\n` || value.text === `${initialSource}\r\n`), `${displayName} first trailing line break`);
  const lineEnding = firstState.text.slice(initialSource.length);
  const afterFirst = firstState.text;
  await script(window, `(() => {
    const trailing = document.querySelector('.markdown-preview-trailing-insertion');
    const editor = document.querySelector('#editor');
    return trailing instanceof HTMLParagraphElement && editor instanceof HTMLElement
      && trailing.dataset.previewTrailingActive === 'true'
      && Number(trailing.dataset.previewSourceStart) === editor.dataset.smokeText?.length
      && Number(trailing.dataset.previewSourceEnd) === editor.dataset.smokeText?.length;
  })()`, `${displayName} maps the end caret without another separator`);
  await script(window, `(() => {
    const trailing = document.querySelector('.markdown-preview-trailing-insertion');
    if (!(trailing instanceof HTMLParagraphElement) || document.activeElement !== trailing) return false;
    return true;
  })()`, `${displayName} positions repeated trailing Enter`);
  await pressEnter(window);
  const afterSecond = `${afterFirst}${lineEnding}`;
  await waitFor(window, (value) => value.active === displayName && value.text === afterSecond, `${displayName} repeated line break`);
  await script(window, `(() => { const trailing = document.querySelector('.markdown-preview-trailing-insertion'); if (!(trailing instanceof HTMLParagraphElement)) return false; trailing.click(); return true; })()`, `${displayName} repeated trailing click`);
  if ((await state(window))?.text !== afterSecond) throw new Error(`G smoke repeated ${displayName} trailing click added a separator.`);
  await window.webContents.insertText("次");
  const continued = `${afterSecond}次`;
  await waitFor(window, (value) => value.active === displayName && value.text === continued, `${displayName} continued typing after repeated Enter`);
  const noPlaceholder = await window.webContents.executeJavaScript(`(() => {
    const editor = document.querySelector('#editor');
    return editor instanceof HTMLElement && !/[\\u200b-\\u200d\\u2060]/u.test(editor.dataset.smokeText ?? '');
  })()`, true) as boolean;
  if (!noPlaceholder) throw new Error(`G smoke persisted a Preview caret placeholder in ${displayName}.`);
}

async function exercisePreviewEnterBeforeProtected(
  window: BrowserWindow,
  displayName: string,
  sourceText: string,
  prose: string,
  marker: string,
  objectSelector: string
): Promise<void> {
  await script(window, `(() => {
    const source = [...document.querySelectorAll('#explorer-tree button[data-explorer-file-id]')]
      .find((item) => item.dataset.explorerFileName === ${JSON.stringify(displayName)});
    const preview = document.querySelector('#document-preview-mode');
    if (!(source instanceof HTMLButtonElement) || !(preview instanceof HTMLButtonElement)) return false;
    source.click();
    if (preview.getAttribute('aria-pressed') !== 'true') preview.click();
    return true;
  })()`, `open ${displayName} for protected-object Enter smoke`);
  await waitFor(window, (value) => value.active === displayName && value.preview && value.text === sourceText, `${displayName} initial Preview`);
  await waitForScript(window, `document.querySelector(${JSON.stringify(objectSelector)}) instanceof HTMLElement`, `${displayName} protected object projection`);
  await script(window, `(() => {
    const editable = [...document.querySelectorAll('.markdown-preview-editable-text')].find((item) => item.textContent === ${JSON.stringify(prose)});
    if (!(editable instanceof HTMLElement) || editable.firstChild === null) return false;
    editable.focus();
    const selection = document.getSelection();
    if (selection === null) return false;
    const range = document.createRange();
    range.setStart(editable.firstChild, editable.textContent.length);
    range.collapse(true);
    selection.removeAllRanges(); selection.addRange(range);
    return true;
  })()`, `${displayName} positions Enter before its protected object`);
  await pressEnter(window);
  const enteredSource = sourceText.replace(`${prose}\n${marker}`, `${prose}\n\n${marker}`);
  await waitFor(window, (value) => value.active === displayName && value.text === enteredSource, `${displayName} source line break before protected object`);
  const mappedBeforeObject = await window.webContents.executeJavaScript(`(() => {
    const root = document.querySelector('.markdown-preview-document');
    const editor = document.querySelector('#editor');
    const caret = document.activeElement;
    const object = root?.querySelector(${JSON.stringify(objectSelector)});
    const objectBlock = object?.closest('[data-preview-block-source-start]');
    const selection = document.getSelection();
    if (!(root instanceof HTMLElement) || !(editor instanceof HTMLElement) || !(caret instanceof HTMLElement)
      || caret.dataset.previewCaretOnly !== 'true' || caret.textContent !== '' || !(object instanceof HTMLElement)
      || !(objectBlock instanceof HTMLElement) || selection === null || !selection.isCollapsed) return false;
    const caretIndex = Array.prototype.indexOf.call(root.children, caret.parentElement);
    const objectIndex = Array.prototype.indexOf.call(root.children, objectBlock);
    const source = editor.dataset.smokeText ?? '';
    return caretIndex >= 0 && objectIndex === caretIndex + 1
      && Number(objectBlock.dataset.previewBlockSourceStart) === source.indexOf(${JSON.stringify(marker)})
      && source === ${JSON.stringify(enteredSource)} && source.split(${JSON.stringify(marker)}).length === 2
      && object.querySelector('.markdown-preview-editable-text') === null
      && !/[\\u200b-\\u200d\\u2060]/u.test(source);
  })()`, true) as boolean;
  if (!mappedBeforeObject) throw new Error(`G smoke did not restore the ${displayName} caret directly before its unchanged protected object.`);
}

async function exercisePreviewEnterUndoRedo(window: BrowserWindow, displayName: string, sourceText: string): Promise<void> {
  await script(window, `(() => {
    const source = [...document.querySelectorAll('#explorer-tree button[data-explorer-file-id]')]
      .find((item) => item.dataset.explorerFileName === ${JSON.stringify(displayName)});
    const preview = document.querySelector('#document-preview-mode');
    if (!(source instanceof HTMLButtonElement) || !(preview instanceof HTMLButtonElement)) return false;
    source.click();
    if (preview.getAttribute('aria-pressed') !== 'true') preview.click();
    return true;
  })()`, `open ${displayName} for source-edit undo/redo`);
  await waitFor(window, (value) => value.active === displayName && value.preview && value.text === sourceText, `${displayName} initial Preview`);
  await script(window, `(() => {
    const editable = [...document.querySelectorAll('.markdown-preview-editable-text')].find((item) => item.textContent === ${JSON.stringify(sourceText)});
    if (!(editable instanceof HTMLElement) || editable.firstChild === null) return false;
    editable.focus();
    const selection = document.getSelection();
    if (selection === null) return false;
    const range = document.createRange();
    range.setStart(editable.firstChild, 'Undo前'.length);
    range.collapse(true);
    selection.removeAllRanges(); selection.addRange(range);
    return true;
  })()`, `${displayName} positions a source-mapped Enter`);
  await pressEnter(window);
  const beforeCaret = sourceText.slice(0, 'Undo前'.length);
  const afterCaret = sourceText.slice('Undo前'.length);
  const entered = await waitFor(window, (value) => value.active === displayName
    && ["\n", "\r\n", "\r"].some((lineEnding) => value.text === `${beforeCaret}${lineEnding}${afterCaret}`), `${displayName} source-edit Enter`);
  const afterEnter = entered.text;
  await script(window, `(() => { const undo = document.querySelector('[data-command-id="maginalia.editor.undo"]'); if (!(undo instanceof HTMLButtonElement)) return false; undo.click(); return true; })()`, `${displayName} Undo command`);
  await waitFor(window, (value) => value.active === displayName && value.text === sourceText, `${displayName} source-edit undo`);
  await script(window, `(() => { const redo = document.querySelector('[data-command-id="maginalia.editor.redo"]'); if (!(redo instanceof HTMLButtonElement)) return false; redo.click(); return true; })()`, `${displayName} Redo command`);
  await waitFor(window, (value) => value.active === displayName && value.text === afterEnter, `${displayName} source-edit redo`);
}

async function exerciseStructuralEnterFallback(window: BrowserWindow, displayName: string, sourceText: string): Promise<void> {
  await script(window, `(() => {
    const source = [...document.querySelectorAll('#explorer-tree button[data-explorer-file-id]')]
      .find((item) => item.dataset.explorerFileName === ${JSON.stringify(displayName)});
    const preview = document.querySelector('#document-preview-mode');
    if (!(source instanceof HTMLButtonElement) || !(preview instanceof HTMLButtonElement)) return false;
    source.click();
    if (preview.getAttribute('aria-pressed') !== 'true') preview.click();
    return true;
  })()`, `open ${displayName} for structural Enter smoke`);
  await waitFor(window, (value) => value.active === displayName && value.preview && value.text === sourceText, `${displayName} initial Preview`);
  await waitForScript(window, `(() => {
    const quote = document.querySelector('.rendered-quote-ref');
    return quote instanceof HTMLElement && quote.querySelector('.markdown-preview-editable-text') === null;
  })()`, `${displayName} protected QuoteRef projection`);
  for (const [selector, description] of [
    ['h1 .markdown-preview-editable-text', 'heading'],
    ['li .markdown-preview-editable-text', 'list item'],
    ['blockquote .markdown-preview-editable-text', 'blockquote'],
    ['strong .markdown-preview-editable-text', 'syntax-wrapped label'],
    ['.markdown-table th .markdown-preview-editable-table-cell', 'table cell']
  ] as const) {
    await script(window, `(() => {
      const editable = document.querySelector(${JSON.stringify(selector)});
      if (!(editable instanceof HTMLElement) || editable.firstChild === null) return false;
      editable.focus();
      const selection = document.getSelection();
      if (selection === null) return false;
      const range = document.createRange();
      range.setStart(editable.firstChild, Math.min(1, editable.textContent.length));
      range.collapse(true);
      selection.removeAllRanges(); selection.addRange(range);
      return true;
    })()`, `${displayName} positions Enter in ${description}`);
    await pressEnter(window);
    await waitFor(window, (value) => value.active === displayName && !value.preview && value.text === sourceText, `${displayName} ${description} Edit fallback`);
    await script(window, `(() => { const preview = document.querySelector('#document-preview-mode'); if (!(preview instanceof HTMLButtonElement)) return false; preview.click(); return true; })()`, `reopen ${displayName} Preview after ${description}`);
    await waitFor(window, (value) => value.active === displayName && value.preview, `${displayName} Preview after ${description}`);
  }
}

/** Real Electron coverage of G's command/preview/link/search seams. */
export async function runGSmoke(window: BrowserWindow, fixtureRoot: string): Promise<void> {
  const initialC = await readFile(path.join(fixtureRoot, "c.md"), "utf8");
  const trailingQuoteRef = '<!-- maginalia:quote-ref v1 {"quoteId":"00000000-0000-4000-8000-000000000044","mode":"normal"} -->';
  const trailingSyncedBlock = '<!-- maginalia:synced-block v1 {"target":"section.md"} -->';
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
  await script(window, `(() => { const tab = [...document.querySelectorAll("#document-tabs .document-tab")].find((item) => item.querySelector(".document-tab-label")?.textContent?.startsWith("a.md")); const button = tab?.querySelector(".document-tab-label"); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true; })()`, "return to A");
  await waitFor(window, (value) => value.active === "a.md", "A active again");
  await waitForScript(window, `(() => {
    const title = document.querySelector('#properties-title');
    const apply = document.querySelector('#properties-apply');
    const reload = document.querySelector('#properties-reload');
    const name = document.querySelector('#properties-document-name');
    return title instanceof HTMLInputElement && title.value === 'Pending A Properties'
      && apply instanceof HTMLButtonElement && apply.disabled
      && reload instanceof HTMLButtonElement && !reload.disabled
      && name?.textContent?.includes('a.md');
  })()`, "returning to A preserves its stale Properties form");
  await script(window, `(() => { const reload = document.querySelector('#properties-reload'); if (!(reload instanceof HTMLButtonElement) || reload.disabled) return false; reload.click(); return true; })()`, "discard stale A Properties only through Reload");
  await waitForScript(window, `(() => {
    const title = document.querySelector('#properties-title');
    const reload = document.querySelector('#properties-reload');
    return document.querySelector('#properties-document-name')?.textContent === 'a.md'
      && title instanceof HTMLInputElement && title.value === 'A Metadata Title'
      && reload instanceof HTMLButtonElement && reload.disabled;
  })()`, "Reload binds clean Properties to A source");
  await script(window, `(() => { const preview = document.querySelector("#document-preview-mode"); if (!(preview instanceof HTMLButtonElement)) return false; preview.click(); return true; })()`, "reopen A Preview");
  await waitForScript(window, "document.querySelector('.rendered-internal-link.resolved') instanceof HTMLElement", "resolved A link after tab switch");
  await script(window, `(() => { const link = document.querySelector(".rendered-internal-link.resolved"); if (!(link instanceof HTMLElement)) return false; link.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })); return true; })()`, "activate existing internal link target");
  await waitFor(window, (value) => value.active === "b.md" && value.tabs.length === 2, "existing B tab activated without duplicate");

  await script(window, `(() => {
    const edit = document.querySelector('#document-edit-mode');
    const parent = [...document.querySelectorAll('#document-tabs .document-tab')].find((item) => item.querySelector('.document-tab-label')?.textContent?.startsWith('a.md'))?.querySelector('.document-tab-label');
    const source = [...document.querySelectorAll('#explorer-tree button[data-explorer-file-id]')].find((item) => item.dataset.explorerFileName === 'chapter.md');
    const editor = document.querySelector('#editor');
    if (!(edit instanceof HTMLButtonElement) || !(parent instanceof HTMLButtonElement) || !(source instanceof HTMLElement) || !(editor instanceof HTMLElement)
      || typeof DataTransfer !== 'function' || typeof DragEvent !== 'function') return false;
    parent.click(); edit.click();
    const transfer = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    editor.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    editor.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    return true;
  })()`, "drag Project document into authoring source as a Synced Block");
  await waitFor(window, (value) => value.active === "a.md" && value.text.includes('maginalia:synced-block v1 {"target":"chapter.md"}'), "Synced Block marker remains durable parent source");
  await script(window, `(() => {
    const source = [...document.querySelectorAll('#document-tabs .document-tab')].find((item) => item.querySelector('.document-tab-label')?.textContent?.startsWith('b.md'));
    const editor = document.querySelector('#editor');
    if (!(source instanceof HTMLElement) || !(editor instanceof HTMLElement) || typeof DataTransfer !== 'function' || typeof DragEvent !== 'function') return false;
    const transfer = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    if (transfer.getData('application/x-maginalia-project-document').includes('project-root')) return false;
    editor.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    return true;
  })()`, "drag a Project-backed tab into authoring source without an absolute-path payload");
  await waitFor(window, (value) => value.text.includes('maginalia:synced-block v1 {"target":"b.md"}'), "Project-tab drag inserts only a durable marker");
  await script(window, `(() => { const preview = document.querySelector('#document-preview-mode'); if (!(preview instanceof HTMLButtonElement)) return false; preview.click(); return true; })()`, "open composed Preview");
  await waitForScript(window, `(() => {
    const block = document.querySelector('.rendered-synced-block');
    return block instanceof HTMLElement && block.textContent?.includes('Chapter prose.') && block.textContent?.includes('Section prose.')
      && !block.textContent?.includes('title: Chapter') && !block.textContent?.includes('# Chapter');
  })()`, "compose nested child Markdown without front matter or first H1");
  await script(window, `(() => { const open = document.querySelector('.rendered-synced-block-open-source'); if (!(open instanceof HTMLButtonElement)) return false; open.click(); return true; })()`, "open Synced Block source through its command");
  await waitFor(window, (value) => value.active === "chapter.md", "Synced Block source opens as a normal Project tab");
  await script(window, `(() => { const edit = document.querySelector('#document-edit-mode'); const editor = document.querySelector('#editor'); if (!(edit instanceof HTMLButtonElement) || !(editor instanceof HTMLElement)) return false; edit.click(); editor.dispatchEvent(new CustomEvent('maginalia-smoke-append', { detail: '\\nDirty chapter update.' })); return true; })()`, "edit open child source without copying it into parent");
  await waitFor(window, (value) => value.active === "chapter.md" && value.text.includes('Dirty chapter update.'), "child session updates");
  await script(window, `(() => { const tab = [...document.querySelectorAll('#document-tabs .document-tab')].find((item) => item.querySelector('.document-tab-label')?.textContent?.startsWith('a.md')); const button = tab?.querySelector('.document-tab-label'); if (!(button instanceof HTMLButtonElement)) return false; button.click(); const preview = document.querySelector('#document-preview-mode'); if (!(preview instanceof HTMLButtonElement)) return false; preview.click(); return true; })()`, "return to parent composed Preview");
  await waitForScript(window, "document.querySelector('.rendered-synced-block')?.textContent?.includes('Dirty chapter update.') === true", "dirty open child session overlays disk composition");
  await script(window, `(() => {
    const edit = document.querySelector('#document-edit-mode');
    const chapter = [...document.querySelectorAll('#document-tabs .document-tab')].find((item) => item.querySelector('.document-tab-label')?.textContent?.startsWith('chapter.md'))?.querySelector('.document-tab-label');
    if (!(edit instanceof HTMLButtonElement) || !(chapter instanceof HTMLButtonElement)) return false;
    chapter.click(); edit.click();
    const source = [...document.querySelectorAll('#explorer-tree button[data-explorer-file-id]')].find((item) => item.dataset.explorerFileName === 'a.md');
    const editor = document.querySelector('#editor');
    if (!(source instanceof HTMLElement) || !(editor instanceof HTMLElement) || typeof DataTransfer !== 'function' || typeof DragEvent !== 'function') return false;
    const transfer = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    editor.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    return true;
  })()`, "reject a Synced Block cycle before mutation");
  await delay(120);
  await waitFor(window, (value) => value.active === "chapter.md" && !value.text.includes('"target":"a.md"'), "cycle attempt leaves child source unchanged");

  await script(window, `(() => { const c = [...document.querySelectorAll("#explorer-tree button[data-explorer-file-id]")].find((item) => item.dataset.explorerFileName === "c.md"); if (!(c instanceof HTMLButtonElement)) return false; c.click(); return true; })()`, "open C tab");
  await waitFor(window, (value) => value.active === "c.md" && value.tabs.length === 4, "C opens after the composed child source tab");
  await script(window, `(() => { const tabs = [...document.querySelectorAll("#document-tabs .document-tab")]; const source = tabs.find((item) => item.querySelector(".document-tab-label")?.textContent?.startsWith("c.md")); const target = tabs.find((item) => item.querySelector(".document-tab-label")?.textContent?.startsWith("a.md")); if (!(source instanceof HTMLElement) || !(target instanceof HTMLElement) || typeof DataTransfer !== "function" || typeof DragEvent !== "function") return false; const transfer = new DataTransfer(); source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: transfer })); target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer })); target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer })); source.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: transfer })); return true; })()`, "drag C before A");
  await waitFor(window, (value) => value.active === "c.md" && value.status === "saved" && value.tabs.map((tab) => tab.trim()).join("|") === "c.md|a.md|b.md|chapter.md", "reordered tabs without source mutation");
  if (await readFile(path.join(fixtureRoot, "c.md"), "utf8") !== initialC) {
    throw new Error("Tab reordering rewrote c.md.");
  }
  await script(window, `(() => { const editor = document.querySelector("#editor"); if (!(editor instanceof HTMLElement)) return false; editor.dispatchEvent(new CustomEvent("maginalia-smoke-append", { detail: "\\nC tab draft" })); return true; })()`, "edit C after reorder");
  await waitFor(window, (value) => value.active === "c.md" && value.text.includes("C tab draft") && value.status === "modified", "C dirty session");
  await script(window, `(() => { const tab = [...document.querySelectorAll("#document-tabs .document-tab")].find((item) => item.querySelector(".document-tab-label")?.textContent?.startsWith("a.md")); const button = tab?.querySelector(".document-tab-label"); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true; })()`, "switch to A after C edit");
  await waitFor(window, (value) => value.active === "a.md", "A activates without closing C");
  await script(window, `(() => { const tab = [...document.querySelectorAll("#document-tabs .document-tab")].find((item) => item.querySelector(".document-tab-label")?.textContent?.startsWith("c.md")); const button = tab?.querySelector(".document-tab-label"); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true; })()`, "return to dirty C");
  await waitFor(window, (value) => value.active === "c.md" && value.text.includes("C tab draft") && value.tabs.map((tab) => tab.trim()).join("|") === "c.md|a.md|b.md|chapter.md", "C session text and tab order retained");

  await script(window, `(() => { const tab = [...document.querySelectorAll("#document-tabs .document-tab")].find((item) => item.querySelector(".document-tab-label")?.textContent?.startsWith("a.md")); const button = tab?.querySelector(".document-tab-label"); const mode = document.querySelector('[data-unified-search-mode="project"]'); const query = document.querySelector("#library-query"); if (!(button instanceof HTMLButtonElement) || !(mode instanceof HTMLButtonElement) || !(query instanceof HTMLInputElement)) return false; button.click(); mode.click(); query.value = "PROJECT_LITERAL_SENTINEL"; query.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); return true; })()`, "Project search");
  await waitFor(window, (value) => value.active === "a.md", "A active for Project search");
  await waitForScript(window, "document.querySelector('#project-search-results [data-project-search-sync]') instanceof HTMLButtonElement", "Project result Sync action");
  await script(window, `(() => {
    const sync = document.querySelector('#project-search-results [data-project-search-sync]');
    return sync instanceof HTMLButtonElement && sync.dataset.target === 'b.md' && sync.textContent === 'Sync' && (sync.click(), true);
  })()`, "click Project search Sync action");
  await waitFor(window, (value) => value.active === "a.md"
    && value.text.split('maginalia:synced-block v1 {"target":"b.md"}').length >= 3
    && !value.text.includes("PROJECT_LITERAL_SENTINEL"), "Project search Sync inserts only a canonical marker");
  await script(window, `(() => {
    const result = document.querySelector("#project-search-results .project-search-open");
    const editor = document.querySelector("#editor");
    if (!(result instanceof HTMLElement) || !(editor instanceof HTMLElement) || typeof DataTransfer !== "function" || typeof DragEvent !== "function") return false;
    const transfer = new DataTransfer();
    result.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    const payload = transfer.getData("application/x-maginalia-project-document");
    if (!payload.includes('"target":"b.md"') || payload.includes("PROJECT_LITERAL_SENTINEL") || /[A-Za-z]:\\\\/u.test(payload)) return false;
    editor.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    editor.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    return true;
  })()`, "drag Project search result into authoring source as a Synced Block");
  await waitFor(window, (value) => value.text.split('maginalia:synced-block v1 {"target":"b.md"}').length >= 4, "Project search drag remains a canonical marker insertion");
  await script(window, `(() => { const open = document.querySelector("#project-search-results .project-search-open"); if (!(open instanceof HTMLButtonElement)) return false; open.click(); const source = document.querySelector("#project-search-source"); const insert = document.querySelector("#project-search-insert"); if (!(source instanceof HTMLTextAreaElement) || !(insert instanceof HTMLButtonElement) || insert.textContent !== "テキストとして挿入") return false; source.selectionStart = 0; source.selectionEnd = source.value.length; insert.click(); return true; })()`, "literal Project text insertion");
  await waitFor(window, (value) => value.text.includes("PROJECT_LITERAL_SENTINEL") && value.status === "modified", "literal insertion into destination");

  await script(window, `(() => {
    const query = document.querySelector("#library-query");
    if (!(query instanceof HTMLInputElement)) return false;
    query.value = "PROJECT_NESTED_SYNC_SENTINEL";
    query.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    return true;
  })()`, "search for a nested Project Markdown result");
  await waitForScript(window, `(() => {
    const sync = document.querySelector('#project-search-results [data-project-search-sync]');
    return sync instanceof HTMLButtonElement && sync.dataset.target === 'nested/notes.md';
  })()`, "nested Project result keeps its relative target");
  await script(window, `(() => {
    const sync = document.querySelector('#project-search-results [data-project-search-sync]');
    if (!(sync instanceof HTMLButtonElement) || sync.dataset.target !== 'nested/notes.md') return false;
    sync.click();
    return true;
  })()`, "click Sync for a nested Project result");
  await waitFor(window, (value) => value.active === "a.md"
    && value.text.includes('maginalia:synced-block v1 {"target":"nested/notes.md"}')
    && !value.text.includes("PROJECT_NESTED_SYNC_SENTINEL"), "nested Sync inserts a marker without copying the source");

  await exerciseTrailingPreviewInsertion(window, "trailing-heading.md", "# H1 only", "\n", "H1 trailing text");
  await exerciseTrailingPreviewInsertion(window, "trailing-paragraph.md", "ordinary final paragraph", "\n\n", "Paragraph trailing text");
  await exerciseTrailingPreviewInsertion(window, "trailing-quote.md", trailingQuoteRef, "\n\n", "Quote trailing text");
  await exerciseTrailingPreviewInsertion(window, "trailing-synced.md", trailingSyncedBlock, "\n", "Synced trailing text");
  const enterCrlfSource = "# 見出し\r\n\r\n前🌸日本語後続\r\n次の行\r\n";
  await exercisePreviewEnter(window, "preview-enter-crlf.md", enterCrlfSource, "\r\n");
  const enterLfSource = "# 見出し\n\n前🌸日本語後続\n次の行\n";
  await exercisePreviewEnter(window, "preview-enter-lf.md", enterLfSource, "\n");
  await exercisePreviewEnterAtEnd(window, "preview-enter-tail.md", "末尾の文");
  const protectedProse = "保護対象前";
  await exercisePreviewEnterBeforeProtected(window, "preview-enter-protected-quote.md",
    `${protectedProse}\n${trailingQuoteRef}`, protectedProse, trailingQuoteRef, ".rendered-quote-ref");
  const protectedImage = "![[assets/preview-enter.png]]";
  await exercisePreviewEnterBeforeProtected(window, "preview-enter-protected-image.md",
    `${protectedProse}\n${protectedImage}`, protectedProse, protectedImage, ".rendered-local-media");
  await exercisePreviewEnterBeforeProtected(window, "preview-enter-protected-synced.md",
    `${protectedProse}\n${trailingSyncedBlock}`, protectedProse, trailingSyncedBlock, ".rendered-synced-block");
  await exercisePreviewEnterUndoRedo(window, "preview-enter-undo.md", "Undo前後");
  const enterStructuralSource = [
    "# 見出し",
    "",
    "- 項目",
    "",
    "> 引用",
    "",
    "本文 **強調** [リンク](https://example.test)",
    "",
    trailingQuoteRef,
    "",
    "| A | B |",
    "| --- | --- |",
    "| 1 | 2 |"
  ].join("\n");
  await exerciseStructuralEnterFallback(window, "preview-enter-structural.md", enterStructuralSource);
  await script(window, `(() => { const tab = [...document.querySelectorAll('#document-tabs .document-tab')].find((item) => item.querySelector('.document-tab-label')?.textContent?.startsWith('a.md')); const button = tab?.querySelector('.document-tab-label'); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true; })()`, "restore A as active Preview tab");
  await waitFor(window, (value) => value.active === "a.md", "A active after trailing Preview coverage");
  if (path.basename(path.resolve(fixtureRoot)).length === 0) throw new Error("G smoke fixture root was invalid.");
}

/** Verify that G's ordered tabs survive the existing workspace restore path. */
export async function runGRestoreSmoke(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript("document.body?.offsetWidth ?? 0", true);
  await waitFor(
    window,
    (value) => value.ready
      && value.active === "a.md"
      && value.tabs.map((tab) => tab.trim()).join("|") === "c.md|a.md|b.md|chapter.md|trailing-heading.md|trailing-paragraph.md|trailing-quote.md|trailing-synced.md|preview-enter-crlf.md|preview-enter-lf.md|preview-enter-tail.md|preview-enter-protected-quote.md|preview-enter-protected-image.md|preview-enter-protected-synced.md|preview-enter-undo.md|preview-enter-structural.md",
    "restored C, A, B, and composed-source tab order"
  );
}
