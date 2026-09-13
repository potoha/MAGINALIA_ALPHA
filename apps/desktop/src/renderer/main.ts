import "./style.css";
import { WritingController, type WritingStatus, type WritingView } from "./controller";
import { decideDirtySwitch } from "./dirty-decision";
import { MonacoMarkdownSurface } from "./monaco-surface";
import {
  WorkspaceNavigationController,
  type WorkspaceNavigationApi,
  type DirtySwitchDecision,
  type WorkspaceNavigationState,
  type WorkspaceNavigationView
} from "./workspace-controller";

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
    <section id="workspace-navigation" class="workspace-navigation" aria-labelledby="workspace-document-heading">
      <h2 id="workspace-document-heading" class="visually-hidden">Document manuscripts</h2>
      <div class="workspace-document-heading">
        <span class="workspace-label">Document</span>
        <strong id="workspace-document-name">No Document open</strong>
      </div>
      <p id="workspace-error" class="workspace-error" role="alert" aria-live="assertive" hidden></p>
      <p id="empty-document-message" class="empty-document-message">Open a Document folder to see its Markdown manuscripts.</p>
      <ul id="manuscript-list" class="manuscript-list" aria-label="Markdown manuscripts"></ul>
    </section>
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
const workspaceDocumentName = requiredElement<HTMLElement>("#workspace-document-name");
const workspaceError = requiredElement<HTMLElement>("#workspace-error");
const emptyDocumentMessage = requiredElement<HTMLElement>("#empty-document-message");
const manuscriptList = requiredElement<HTMLUListElement>("#manuscript-list");
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

function renderWorkspaceState(state: WorkspaceNavigationState): void {
  workspaceDocumentName.textContent = state.document?.displayName ?? "No Document open";
  manuscriptList.replaceChildren();

  if (!state.document) {
    emptyDocumentMessage.textContent = "Open a Document folder to see its Markdown manuscripts.";
    emptyDocumentMessage.hidden = false;
    return;
  }
  if (state.manuscripts.length === 0) {
    emptyDocumentMessage.textContent = "This Document has no Markdown manuscripts in its root folder.";
    emptyDocumentMessage.hidden = false;
    return;
  }

  emptyDocumentMessage.hidden = true;
  for (const manuscript of state.manuscripts) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "manuscript-button";
    button.textContent = manuscript.displayName;
    button.dataset.manuscriptId = manuscript.manuscriptId;
    if (state.activeManuscriptId === manuscript.manuscriptId) {
      button.classList.add("active");
      button.setAttribute("aria-current", "page");
    }
    item.append(button);
    manuscriptList.append(item);
  }
}

const workspaceView: WorkspaceNavigationView = {
  setWorkspaceState(state: WorkspaceNavigationState): void {
    renderWorkspaceState(state);
    updateSmokeTextForSmoke?.();
    for (const button of manuscriptList.querySelectorAll<HTMLButtonElement>("button[data-manuscript-id]")) {
      button.addEventListener("click", () => {
        const manuscriptId = button.dataset.manuscriptId;
        if (manuscriptId) void workspaceController?.openManuscript(manuscriptId);
      });
    }
  },
  setWorkspaceError(message: string | null): void {
    workspaceError.textContent = message ?? "";
    workspaceError.hidden = message === null;
  }
};

function getWorkspaceApi(): WorkspaceNavigationApi | null {
  const api = window.maginalia;
  if (!api || typeof api.openDocument !== "function" || typeof api.openManuscript !== "function") {
    return null;
  }
  const openDocument = api.openDocument;
  const openManuscript = api.openManuscript;
  return {
    openDocument: () => openDocument(),
    openManuscript: (request) => openManuscript(request)
  };
}

let updateSmokeTextForSmoke: (() => void) | undefined;
const smokeQuery = new URLSearchParams(window.location.search).get("smoke");
const writingSmokeMode = smokeQuery === "writing";
const workspaceSmokeMode = smokeQuery === "workspace";
const smokeDecisionQueue: DirtySwitchDecision[] = [];
openButton.textContent = writingSmokeMode ? "Open" : "Open Document";

let workspaceController: WorkspaceNavigationController | undefined;
if (writingSmokeMode || workspaceSmokeMode) {
  const updateSmokeText = (): void => {
    editorContainer.dataset.smokeText = surface.getText();
  };
  updateSmokeTextForSmoke = updateSmokeText;
  editorContainer.dataset.smokeReady = writingSmokeMode ? "true" : "workspace";
  editorContainer.addEventListener("maginalia-smoke-append", (event) => {
    const text = (event as CustomEvent<string>).detail;
    if (typeof text === "string") surface.appendTextForSmoke(text);
  });
  editorContainer.addEventListener("maginalia-smoke-focus", () => surface.focus());
  surface.onTextChange(updateSmokeText);
  updateSmokeText();
}

if (workspaceSmokeMode) {
  window.addEventListener("maginalia-smoke-decision", (event) => {
    const decision = (event as CustomEvent<unknown>).detail;
    if (decision === "save" || decision === "discard" || decision === "cancel") {
      smokeDecisionQueue.push(decision);
    }
  });
  window.addEventListener("error", (event) => {
    console.error(`Workspace smoke page error: ${event.message}`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    console.error(`Workspace smoke unhandled rejection: ${String(event.reason)}`);
  });
}

if (!writingSmokeMode) {
  const workspaceApi = getWorkspaceApi();
  if (!workspaceApi) {
    const message = "Document workspace is unavailable. Reload MAGINALIA to try again.";
    workspaceView.setWorkspaceError(message);
    openButton.disabled = true;
    if (workspaceSmokeMode) console.error(message);
  } else {
    workspaceController = new WorkspaceNavigationController({
      api: workspaceApi,
      writing: controller,
      view: workspaceView,
      decideDirtySwitch: workspaceSmokeMode
        ? () => smokeDecisionQueue.shift() ?? "cancel"
        : (context) => decideDirtySwitch(context, (message) => window.confirm(message))
    });
  }
}

if (writingSmokeMode) {
  openButton.addEventListener("click", () => {
    void controller.open().then(() => updateSmokeTextForSmoke?.());
  });
} else if (workspaceController) {
  openButton.addEventListener("click", () => {
    void workspaceController?.openDocument();
  });
}

saveButton.addEventListener("click", () => {
  void controller.save();
});

window.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void controller.save();
  }
}, { capture: true });
