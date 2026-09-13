import "./style.css";
import { WritingController, type WritingStatus, type WritingView } from "./controller";
import { MonacoMarkdownSurface } from "./monaco-surface";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Renderer root element was not found");
}

app.innerHTML = `
  <main class="workspace" aria-labelledby="title">
    <header class="toolbar">
      <div class="brand">
        <p class="eyebrow">MAGINALIA</p>
        <h1 id="title">Before Kaldi</h1>
      </div>
      <div class="document-controls">
        <button id="open-markdown" type="button">Open</button>
        <button id="save-markdown" type="button" disabled>Save</button>
        <span id="document-name" class="document-name">No document open</span>
        <span id="document-status" class="document-status" data-state="empty" role="status" aria-live="polite">No document open</span>
      </div>
    </header>
    <section id="editor" class="editor" aria-label="Markdown editor"></section>
  </main>
`;

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Renderer element was not found: ${selector}`);
  return element;
}

const openButton = requiredElement<HTMLButtonElement>("#open-markdown");
const saveButton = requiredElement<HTMLButtonElement>("#save-markdown");
const documentName = requiredElement<HTMLElement>("#document-name");
const documentStatus = requiredElement<HTMLElement>("#document-status");
const editorContainer = requiredElement<HTMLElement>("#editor");

const view: WritingView = {
  setDocumentName(name: string): void {
    documentName.textContent = name;
  },
  setStatus(status: WritingStatus): void {
    documentStatus.dataset.state = status.kind;
    documentStatus.textContent = status.message;
  },
  setSaveEnabled(enabled: boolean): void {
    saveButton.disabled = !enabled;
  }
};

const surface = new MonacoMarkdownSurface(editorContainer);
const controller = new WritingController({
  api: window.maginalia,
  surface,
  view,
  confirmReplace: (displayName) => window.confirm(`Open another Markdown file? Unsaved changes to ${displayName} will be replaced.`)
});

let updateSmokeTextForSmoke: (() => void) | undefined;
if (new URLSearchParams(window.location.search).get("smoke") === "writing") {
  const updateSmokeText = (): void => {
    editorContainer.dataset.smokeText = surface.getText();
  };
  updateSmokeTextForSmoke = updateSmokeText;
  editorContainer.dataset.smokeReady = "true";
  editorContainer.addEventListener("maginalia-smoke-append", (event) => {
    const text = (event as CustomEvent<string>).detail;
    if (typeof text === "string") surface.appendTextForSmoke(text);
  });
  editorContainer.addEventListener("maginalia-smoke-focus", () => surface.focus());
  surface.onTextChange(updateSmokeText);
  updateSmokeText();
}

openButton.addEventListener("click", () => {
  void controller.open().then(() => updateSmokeTextForSmoke?.());
});

saveButton.addEventListener("click", () => {
  void controller.save();
});

window.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void controller.save();
  }
}, { capture: true });
