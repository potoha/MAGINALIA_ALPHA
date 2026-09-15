import "./style.css";
import { WritingController, type WritingStatus, type WritingView } from "./controller";
import { decideDirtySwitch } from "./dirty-decision";
import {
  LibraryController,
  type LibraryControllerApi,
  type LibraryControllerView,
  type LibraryViewState
} from "./library-controller";
import { MonacoMarkdownSurface } from "./monaco-surface";
import {
  WorkspaceNavigationController,
  type WorkspaceNavigationApi,
  type DirtySwitchDecision,
  type WorkspaceNavigationState,
  type WorkspaceNavigationView
} from "./workspace-controller";
import {
  RepositoryController,
  type RepositoryControllerApi,
  type RepositoryControllerView,
  type RepositoryHistoryViewState,
  type RepositoryKindOption,
  type RepositoryViewState
} from "./repository-controller";

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
    <section id="repository-navigation" class="repository-navigation" aria-labelledby="repository-heading">
      <div class="repository-heading-row">
        <h2 id="repository-heading">Repository</h2>
        <span id="repository-kind-label" class="repository-kind-label">No repository selected</span>
        <strong id="repository-name">No Repository open</strong>
      </div>
      <div class="repository-controls">
        <label for="repository-kind">Kind</label>
        <select id="repository-kind">
          <option value="project">Project</option>
          <option value="workbench">Workbench</option>
          <option value="shelf">Private Shelf</option>
        </select>
        <label for="repository-title">Title</label>
        <input id="repository-title" type="text" maxlength="200" autocomplete="off">
        <button id="create-repository" type="button">Create</button>
        <button id="open-repository" type="button">Open Repository</button>
        <button id="activate-repository" type="button" hidden>Activate</button>
      </div>
      <p id="repository-status" class="repository-status" role="status" aria-live="polite">Create or open a repository.</p>
      <p id="repository-error" class="repository-error" role="alert" aria-live="assertive" hidden></p>
      <section class="repository-history" aria-labelledby="repository-history-heading">
        <div class="repository-history-heading-row">
          <h3 id="repository-history-heading">History</h3>
          <div class="repository-history-actions">
            <button id="record-repository-history" type="button" disabled>Record History</button>
            <button id="refresh-repository-history" type="button" disabled>Refresh</button>
          </div>
        </div>
        <label for="repository-history-entry">Saved History</label>
        <select id="repository-history-entry" disabled>
          <option value="">No saved History</option>
        </select>
        <button id="open-repository-history" type="button" disabled>Open History Copy</button>
        <p id="repository-history-status" class="repository-history-status" role="status" aria-live="polite">Activate a repository to view History.</p>
        <p id="repository-history-error" class="repository-history-error" role="alert" aria-live="assertive" hidden></p>
      </section>
    </section>
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
    <section id="library-navigation" class="library-navigation" aria-labelledby="library-heading">
      <div class="library-heading-row">
        <h2 id="library-heading">Library</h2>
        <button id="choose-library" type="button">Choose Library</button>
        <strong id="library-name">No Library selected</strong>
      </div>
      <form id="library-search-form" class="library-search-form">
        <label for="library-query">Search quotations</label>
        <input id="library-query" type="search" autocomplete="off" disabled>
        <button id="library-search" type="submit" disabled>Search</button>
      </form>
      <p id="library-status" class="library-status" role="status" aria-live="polite">Choose a Library to search quotations.</p>
      <p id="library-error" class="library-error" role="alert" aria-live="assertive" hidden></p>
      <ul id="library-results" class="library-results" aria-label="Quotation references"></ul>
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
const chooseLibraryButton = requiredElement<HTMLButtonElement>("#choose-library");
const libraryName = requiredElement<HTMLElement>("#library-name");
const librarySearchForm = requiredElement<HTMLFormElement>("#library-search-form");
const libraryQuery = requiredElement<HTMLInputElement>("#library-query");
const librarySearchButton = requiredElement<HTMLButtonElement>("#library-search");
const libraryStatus = requiredElement<HTMLElement>("#library-status");
const libraryError = requiredElement<HTMLElement>("#library-error");
const libraryResults = requiredElement<HTMLUListElement>("#library-results");
const editorContainer = requiredElement<HTMLElement>("#editor");
const repositoryNavigation = requiredElement<HTMLElement>("#repository-navigation");
const repositoryKindLabel = requiredElement<HTMLElement>("#repository-kind-label");
const repositoryName = requiredElement<HTMLElement>("#repository-name");
const repositoryKind = requiredElement<HTMLSelectElement>("#repository-kind");
const repositoryTitle = requiredElement<HTMLInputElement>("#repository-title");
const createRepositoryButton = requiredElement<HTMLButtonElement>("#create-repository");
const openRepositoryButton = requiredElement<HTMLButtonElement>("#open-repository");
const activateRepositoryButton = requiredElement<HTMLButtonElement>("#activate-repository");
const repositoryStatus = requiredElement<HTMLElement>("#repository-status");
const repositoryError = requiredElement<HTMLElement>("#repository-error");
const recordRepositoryHistoryButton = requiredElement<HTMLButtonElement>("#record-repository-history");
const refreshRepositoryHistoryButton = requiredElement<HTMLButtonElement>("#refresh-repository-history");
const repositoryHistoryEntry = requiredElement<HTMLSelectElement>("#repository-history-entry");
const openRepositoryHistoryButton = requiredElement<HTMLButtonElement>("#open-repository-history");
const repositoryHistoryStatus = requiredElement<HTMLElement>("#repository-history-status");
const repositoryHistoryError = requiredElement<HTMLElement>("#repository-history-error");

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

const repositoryKindLabels: Record<RepositoryKindOption, string> = {
  project: "Project",
  workbench: "Workbench",
  shelf: "Private Shelf"
};

let repositoryReadyForHistory = false;

function formatHistoryTimestamp(timestampMs: number): string {
  const date = new Date(timestampMs);
  if (!Number.isFinite(timestampMs) || Number.isNaN(date.getTime())) return "Saved History";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function renderRepositoryState(state: RepositoryViewState): void {
  const repository = state.repository;
  repositoryReadyForHistory = repository !== null && state.status === "ready";
  repositoryKindLabel.textContent = repository === null
    ? "No repository selected"
    : repositoryKindLabels[repository.kind];
  repositoryName.textContent = repository?.title ?? "No Repository open";
  repositoryStatus.dataset.state = state.status;
  repositoryStatus.textContent = state.status === "creating"
    ? "Creating…"
    : state.status === "opening"
      ? "Opening…"
      : state.status === "activating"
        ? "Activating…"
        : state.status === "ready"
          ? "Ready"
          : state.status === "pending"
            ? "Activation needed"
            : state.status === "error"
              ? "Action could not be completed"
              : "Create or open a repository.";
  repositoryError.textContent = state.error ?? "";
  repositoryError.hidden = state.error === null;

  const busy = state.status === "creating" || state.status === "opening" || state.status === "activating";
  createRepositoryButton.disabled = busy;
  openRepositoryButton.disabled = busy;
  activateRepositoryButton.hidden = repository === null || state.status === "ready";
  activateRepositoryButton.disabled = busy;
  activateRepositoryButton.textContent = repository?.kind === "shelf"
    ? "Use Private Shelf"
    : "Open in Document";
}

function renderRepositoryHistoryState(state: RepositoryHistoryViewState): void {
  const historyBusy = state.status === "loading"
    || state.status === "recording"
    || state.status === "opening";
  const canUseHistory = repositoryReadyForHistory && !historyBusy;

  repositoryHistoryEntry.replaceChildren();
  if (state.entries.length === 0) {
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "No saved History";
    repositoryHistoryEntry.append(empty);
  } else {
    for (const entry of state.entries) {
      const option = document.createElement("option");
      option.value = entry.historyId;
      option.textContent = formatHistoryTimestamp(entry.timestampMs);
      repositoryHistoryEntry.append(option);
    }
  }
  repositoryHistoryEntry.value = state.selectedHistoryId ?? "";
  repositoryHistoryEntry.disabled = !canUseHistory || state.entries.length === 0;
  recordRepositoryHistoryButton.disabled = !canUseHistory;
  refreshRepositoryHistoryButton.disabled = !canUseHistory;
  openRepositoryHistoryButton.disabled = !canUseHistory || state.selectedHistoryId === null;

  repositoryHistoryStatus.dataset.state = state.status;
  repositoryHistoryStatus.textContent = state.status === "loading"
    ? "Refreshing History…"
    : state.status === "recording"
      ? "Recording History…"
      : state.status === "opening"
        ? "Opening History copy…"
        : state.status === "ready"
          ? `${state.entries.length} saved History version${state.entries.length === 1 ? "" : "s"}`
          : repositoryReadyForHistory
            ? "Refresh History to view saved versions."
            : "Activate a repository to view History.";
  repositoryHistoryError.textContent = state.error ?? "";
  repositoryHistoryError.hidden = state.error === null;
}

const repositoryView: RepositoryControllerView = {
  setRepositoryState(state: RepositoryViewState): void {
    renderRepositoryState(state);
  },
  setRepositoryHistoryState(state: RepositoryHistoryViewState): void {
    renderRepositoryHistoryState(state);
  }
};

function renderLibraryState(state: LibraryViewState): void {
  libraryName.textContent = state.library?.displayName ?? "No Library selected";
  libraryQuery.value = state.query;
  libraryQuery.disabled = state.library === null;
  librarySearchButton.disabled = state.library === null
    || state.status === "opening"
    || state.status === "searching"
    || state.status === "resolving";
  chooseLibraryButton.disabled = state.status === "opening";

  const statusMessage = state.status === "opening"
    ? "Opening Library…"
    : state.status === "searching"
      ? "Searching…"
      : state.status === "resolving"
        ? "Preparing quotation…"
        : state.status === "ready"
          ? `${state.references.length} reference${state.references.length === 1 ? "" : "s"}`
          : state.library === null
            ? "Choose a Library to search quotations."
            : "Ready to search quotations.";
  libraryStatus.dataset.state = state.status;
  libraryStatus.textContent = statusMessage;
  libraryError.textContent = state.error ?? "";
  libraryError.hidden = state.error === null;

  libraryResults.replaceChildren();
  for (const reference of state.references) {
    const item = document.createElement("li");
    item.className = "library-result";

    const details = document.createElement("div");
    details.className = "library-reference";
    const title = document.createElement("strong");
    title.textContent = reference.title;
    details.append(title);
    const metadata = document.createElement("span");
    const authors = reference.authors.join("、");
    metadata.textContent = [
      authors,
      reference.sourceId,
      reference.page === undefined ? "" : `p. ${reference.page}`
    ].filter((part) => part.length > 0).join(" / ");
    details.append(metadata);

    const actions = document.createElement("div");
    actions.className = "library-result-actions";
    const select = document.createElement("button");
    select.type = "button";
    select.textContent = state.selectedAnnotationId === reference.annotationId ? "Selected" : "Select";
    select.setAttribute("aria-pressed", String(state.selectedAnnotationId === reference.annotationId));
    select.addEventListener("click", () => libraryController?.selectReference(reference.annotationId));
    const insert = document.createElement("button");
    insert.type = "button";
    insert.textContent = "Insert";
    insert.addEventListener("click", () => void libraryController?.insertReference(reference.annotationId));
    actions.append(select, insert);
    item.append(details, actions);
    libraryResults.append(item);
  }
}

const libraryView: LibraryControllerView = {
  setLibraryState(state: LibraryViewState): void {
    renderLibraryState(state);
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

function getLibraryApi(): LibraryControllerApi | null {
  const api = window.maginalia;
  if (!api
    || typeof api.openLibrary !== "function"
    || typeof api.searchLibrary !== "function"
    || typeof api.resolveQuotationForInsert !== "function") {
    return null;
  }
  const openLibrary = api.openLibrary;
  const searchLibrary = api.searchLibrary;
  const resolveQuotationForInsert = api.resolveQuotationForInsert;
  return {
    openLibrary: () => openLibrary(),
    searchLibrary: (request) => searchLibrary(request),
    resolveQuotationForInsert: (request) => resolveQuotationForInsert(request)
  };
}

function getRepositoryApi(): RepositoryControllerApi | null {
  const api = window.maginalia;
  if (!api
    || typeof api.createRepository !== "function"
    || typeof api.openRepository !== "function"
    || typeof api.openRepositoryDocument !== "function"
    || typeof api.useRepositoryShelf !== "function"
    || typeof api.createRepositoryHistory !== "function"
    || typeof api.listRepositoryHistory !== "function"
    || typeof api.openRepositoryHistory !== "function") {
    return null;
  }
  const createRepository = api.createRepository;
  const openRepository = api.openRepository;
  const openRepositoryDocument = api.openRepositoryDocument;
  const useRepositoryShelf = api.useRepositoryShelf;
  const createRepositoryHistory = api.createRepositoryHistory;
  const listRepositoryHistory = api.listRepositoryHistory;
  const openRepositoryHistory = api.openRepositoryHistory;
  return {
    createRepository: (request) => createRepository(request),
    openRepository: () => openRepository(),
    openRepositoryDocument: (request) => openRepositoryDocument(request),
    useRepositoryShelf: (request) => useRepositoryShelf(request),
    createRepositoryHistory: (request) => createRepositoryHistory(request),
    listRepositoryHistory: (request) => listRepositoryHistory(request),
    openRepositoryHistory: (request) => openRepositoryHistory(request)
  };
}

let updateSmokeTextForSmoke: (() => void) | undefined;
const smokeQuery = new URLSearchParams(window.location.search).get("smoke");
const writingSmokeMode = smokeQuery === "writing";
const workspaceSmokeMode = smokeQuery === "workspace";
const quotationSmokeMode = smokeQuery === "quotation";
const repositorySmokeMode = smokeQuery === "repository";
const smokeDecisionQueue: DirtySwitchDecision[] = [];
openButton.textContent = writingSmokeMode ? "Open" : "Open Document";
repositoryNavigation.hidden = writingSmokeMode;

let workspaceController: WorkspaceNavigationController | undefined;
if (writingSmokeMode || workspaceSmokeMode || quotationSmokeMode || repositorySmokeMode) {
  const updateSmokeText = (): void => {
    editorContainer.dataset.smokeText = surface.getText();
  };
  updateSmokeTextForSmoke = updateSmokeText;
  editorContainer.dataset.smokeReady = writingSmokeMode
    ? "true"
    : workspaceSmokeMode
      ? "workspace"
      : quotationSmokeMode
        ? "quotation"
        : "repository";
  editorContainer.addEventListener("maginalia-smoke-append", (event) => {
    const text = (event as CustomEvent<string>).detail;
    if (typeof text === "string") surface.appendTextForSmoke(text);
  });
  editorContainer.addEventListener("maginalia-smoke-focus", () => surface.focus());
  if (quotationSmokeMode) {
    editorContainer.addEventListener("maginalia-smoke-cursor-end", () => surface.setCursorToEndForSmoke());
  }
  surface.onTextChange(updateSmokeText);
  updateSmokeText();
}

if (workspaceSmokeMode || quotationSmokeMode || repositorySmokeMode) {
  window.addEventListener("maginalia-smoke-decision", (event) => {
    const decision = (event as CustomEvent<unknown>).detail;
    if (decision === "save" || decision === "discard" || decision === "cancel") {
      smokeDecisionQueue.push(decision);
    }
  });
  window.addEventListener("error", (event) => {
    const smokeLabel = quotationSmokeMode ? "Quotation" : repositorySmokeMode ? "Repository" : "Workspace";
    console.error(`${smokeLabel} smoke page error: ${event.message}`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const smokeLabel = quotationSmokeMode ? "Quotation" : repositorySmokeMode ? "Repository" : "Workspace";
    console.error(`${smokeLabel} smoke unhandled rejection: ${String(event.reason)}`);
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

let libraryController: LibraryController | undefined;
const libraryApi = getLibraryApi();
if (!libraryApi) {
  chooseLibraryButton.disabled = true;
  libraryQuery.disabled = true;
  librarySearchButton.disabled = true;
  libraryStatus.textContent = "Library is unavailable.";
  libraryError.textContent = "The Library bridge is unavailable. Reload MAGINALIA to try again.";
  libraryError.hidden = false;
} else {
  libraryController = new LibraryController({
    api: libraryApi,
    writing: controller,
    view: libraryView
  });
  chooseLibraryButton.addEventListener("click", () => {
    void libraryController?.openLibrary();
  });
  libraryQuery.addEventListener("input", () => {
    libraryController?.setQuery(libraryQuery.value);
  });
  librarySearchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void libraryController?.search();
  });
}

let repositoryController: RepositoryController | undefined;
if (!writingSmokeMode) {
  const repositoryApi = getRepositoryApi();
  if (!repositoryApi || !workspaceController || !libraryController) {
    createRepositoryButton.disabled = true;
    openRepositoryButton.disabled = true;
    activateRepositoryButton.disabled = true;
    recordRepositoryHistoryButton.disabled = true;
    refreshRepositoryHistoryButton.disabled = true;
    repositoryHistoryEntry.disabled = true;
    openRepositoryHistoryButton.disabled = true;
    repositoryStatus.textContent = "Repository is unavailable.";
    repositoryError.textContent = "The Repository bridge is unavailable. Reload MAGINALIA to try again.";
    repositoryError.hidden = false;
  } else {
    repositoryController = new RepositoryController({
      api: repositoryApi,
      workspace: workspaceController,
      library: libraryController,
      view: repositoryView,
      writing: { hasUnsavedChanges: () => controller.hasUnsavedChanges() }
    });
    createRepositoryButton.addEventListener("click", () => {
      void repositoryController?.create(
        repositoryKind.value as RepositoryKindOption,
        repositoryTitle.value
      );
    });
    openRepositoryButton.addEventListener("click", () => {
      void repositoryController?.openRepository();
    });
    activateRepositoryButton.addEventListener("click", () => {
      void repositoryController?.activateRepository();
    });
    recordRepositoryHistoryButton.addEventListener("click", () => {
      void repositoryController?.recordHistory();
    });
    refreshRepositoryHistoryButton.addEventListener("click", () => {
      void repositoryController?.refreshHistory();
    });
    repositoryHistoryEntry.addEventListener("change", () => {
      repositoryController?.selectHistory(repositoryHistoryEntry.value || null);
    });
    openRepositoryHistoryButton.addEventListener("click", () => {
      void repositoryController?.openHistoryCopy();
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
