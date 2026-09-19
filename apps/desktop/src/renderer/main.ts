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
  ProjectNavigationController,
  type ProjectNavigationApi,
  type ProjectNavigationState,
  type ProjectNavigationView
} from "./project-controller";
import { PROJECT_DOCUMENT_TYPES, type ProjectDocumentType } from "../project-metadata";
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
import {
  createLocalStorageLayoutStore,
  WorkbenchCore,
  type LayoutState,
  type ViewRegion
} from "./workbench-core";
import { WORKBENCH_VIEW_MANIFEST } from "./workbench-views";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Renderer root element was not found");
}

app.innerHTML = `
  <main id="workbench" class="workspace workbench" aria-labelledby="title" data-editor-only="false">
    <header class="toolbar" id="workbench-toolbar">
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
      <div id="workbench-layout-controls" class="layout-controls" aria-label="Workbench layout controls">
        <button id="toolbar-toggle-activity-bar" data-workbench-command="maginalia.view.toggleActivityBar" type="button" title="Toggle activity bar">Activity</button>
        <button id="toolbar-toggle-primary-sidebar" data-workbench-command="maginalia.view.togglePrimarySidebar" type="button" title="Toggle primary sidebar">Primary</button>
        <button id="toolbar-toggle-secondary-sidebar" data-workbench-command="maginalia.view.toggleSecondarySidebar" type="button" title="Toggle secondary sidebar">Secondary</button>
        <button id="toolbar-toggle-editor-only" data-workbench-command="maginalia.view.toggleEditorOnly" type="button" title="Toggle editor-only mode">Editor only</button>
      </div>
    </header>
    <div class="workbench-body">
      <nav id="activity-bar" class="activity-bar" data-workbench-region="activity-bar" aria-label="Workbench view containers">
        <div id="activity-view-buttons" class="activity-view-buttons"></div>
        <span class="activity-spacer" aria-hidden="true"></span>
        <button id="toggle-primary-sidebar" class="activity-command" data-workbench-command="maginalia.view.togglePrimarySidebar" type="button" title="Toggle primary sidebar" aria-label="Toggle primary sidebar">P</button>
        <button id="toggle-secondary-sidebar" class="activity-command" data-workbench-command="maginalia.view.toggleSecondarySidebar" type="button" title="Toggle secondary sidebar" aria-label="Toggle secondary sidebar">S</button>
        <button id="toggle-activity-bar" class="activity-command" data-workbench-command="maginalia.view.toggleActivityBar" type="button" title="Toggle activity bar" aria-label="Toggle activity bar">A</button>
        <button id="toggle-editor-only" class="activity-command" data-workbench-command="maginalia.view.toggleEditorOnly" type="button" title="Toggle editor-only mode" aria-label="Toggle editor-only mode">E</button>
      </nav>
      <aside id="primary-sidebar" class="workbench-sidebar primary-sidebar" data-workbench-region="primary-sidebar" aria-label="Primary sidebar">
        <div id="primary-sidebar-resizer" class="sidebar-resizer" data-workbench-resize="primary-sidebar" role="separator" aria-label="Resize primary sidebar" aria-orientation="vertical" tabindex="0"></div>
        <div class="view-container primary-view-container">
          <section id="workspace-navigation" class="workspace-navigation view-panel" aria-labelledby="workspace-document-heading">
            <h2 id="workspace-document-heading" class="visually-hidden">Project Registry</h2>
            <div class="workspace-document-heading">
              <span id="workspace-label" class="workspace-label">Project</span>
              <strong id="workspace-document-name">No Project open</strong>
            </div>
            <div class="project-controls">
              <button id="open-project" type="button">Open Project</button>
              <input id="create-project-title" type="text" maxlength="200" autocomplete="off" placeholder="New Project name">
              <button id="create-project" type="button">Create Project</button>
            </div>
            <p id="workspace-error" class="workspace-error" role="alert" aria-live="assertive" hidden></p>
            <form id="new-file-form" class="new-file-form">
              <strong>Registry</strong>
              <label for="new-file-name">Filename</label>
              <input id="new-file-name" type="text" maxlength="240" autocomplete="off" placeholder="idea.md">
              <label for="new-file-title">Title</label>
              <input id="new-file-title" type="text" maxlength="240" autocomplete="off" placeholder="Untitled note">
              <label for="new-file-type">Type</label>
              <select id="new-file-type">
                ${PROJECT_DOCUMENT_TYPES.map((type) => `<option value="${type}">${type}</option>`).join("")}
              </select>
              <button id="new-file" type="submit">New File (.md)</button>
            </form>
            <p id="empty-document-message" class="empty-document-message">Open a Project folder to see its Markdown files.</p>
            <ul id="manuscript-list" class="manuscript-list" aria-label="Markdown manuscripts"></ul>
          </section>
          <section id="repository-navigation" class="repository-navigation view-panel" aria-labelledby="repository-heading">
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
        </div>
      </aside>
      <section class="editor-area" aria-label="Editor Area">
        <section id="editor" class="editor" aria-label="Markdown editor"></section>
      </section>
      <aside id="secondary-sidebar" class="workbench-sidebar secondary-sidebar" data-workbench-region="secondary-sidebar" aria-label="Secondary sidebar">
        <div id="secondary-sidebar-resizer" class="sidebar-resizer" data-workbench-resize="secondary-sidebar" role="separator" aria-label="Resize secondary sidebar" aria-orientation="vertical" tabindex="0"></div>
        <div class="view-container secondary-view-container">
          <section id="library-navigation" class="library-navigation view-panel" aria-labelledby="library-heading">
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
        </div>
      </aside>
    </div>
  </main>
`;

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Renderer element was not found: ${selector}`);
  return element;
}

const activityViewButtonHost = requiredElement<HTMLElement>("#activity-view-buttons");
for (const view of WORKBENCH_VIEW_MANIFEST) {
  const button = document.createElement("button");
  button.id = view.activityButtonId;
  button.className = "activity-button";
  button.type = "button";
  button.dataset.workbenchView = view.id;
  button.dataset.workbenchViewRegion = view.defaultRegion;
  button.setAttribute("aria-pressed", "false");
  button.title = view.title;
  button.textContent = view.title;
  activityViewButtonHost.append(button);

  const panel = requiredElement<HTMLElement>(`#${view.panelId}`);
  panel.dataset.workbenchViewPanel = view.id;
}

const workbenchRoot = requiredElement<HTMLElement>(".workbench");
const workbenchToolbar = requiredElement<HTMLElement>("#workbench-toolbar");
const activityBar = requiredElement<HTMLElement>("#activity-bar");
const primarySidebar = requiredElement<HTMLElement>("#primary-sidebar");
const secondarySidebar = requiredElement<HTMLElement>("#secondary-sidebar");
const primarySidebarResizer = requiredElement<HTMLElement>("#primary-sidebar-resizer");
const secondarySidebarResizer = requiredElement<HTMLElement>("#secondary-sidebar-resizer");
const editorArea = requiredElement<HTMLElement>(".editor-area");
const activityViewButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-workbench-view]")];
const viewPanels = [...document.querySelectorAll<HTMLElement>("[data-workbench-view-panel]")];
const togglePrimarySidebarButton = requiredElement<HTMLButtonElement>("#toggle-primary-sidebar");
const toggleSecondarySidebarButton = requiredElement<HTMLButtonElement>("#toggle-secondary-sidebar");
const toggleActivityBarButton = requiredElement<HTMLButtonElement>("#toggle-activity-bar");
const toggleEditorOnlyButton = requiredElement<HTMLButtonElement>("#toggle-editor-only");
const toolbarToggleActivityBarButton = requiredElement<HTMLButtonElement>("#toolbar-toggle-activity-bar");
const toolbarTogglePrimarySidebarButton = requiredElement<HTMLButtonElement>("#toolbar-toggle-primary-sidebar");
const toolbarToggleSecondarySidebarButton = requiredElement<HTMLButtonElement>("#toolbar-toggle-secondary-sidebar");
const toolbarToggleEditorOnlyButton = requiredElement<HTMLButtonElement>("#toolbar-toggle-editor-only");
const openButton = requiredElement<HTMLButtonElement>("#open-markdown");
const openProjectButton = requiredElement<HTMLButtonElement>("#open-project");
const saveButton = requiredElement<HTMLButtonElement>("#save-markdown");
const documentName = requiredElement<HTMLElement>("#document-name");
const documentStatus = requiredElement<HTMLElement>("#document-status");
const workspaceLabel = requiredElement<HTMLElement>("#workspace-label");
const workspaceDocumentName = requiredElement<HTMLElement>("#workspace-document-name");
const workspaceError = requiredElement<HTMLElement>("#workspace-error");
const emptyDocumentMessage = requiredElement<HTMLElement>("#empty-document-message");
const manuscriptList = requiredElement<HTMLUListElement>("#manuscript-list");
const createProjectTitle = requiredElement<HTMLInputElement>("#create-project-title");
const createProjectButton = requiredElement<HTMLButtonElement>("#create-project");
const newFileForm = requiredElement<HTMLFormElement>("#new-file-form");
const newFileName = requiredElement<HTMLInputElement>("#new-file-name");
const newFileTitle = requiredElement<HTMLInputElement>("#new-file-title");
const newFileType = requiredElement<HTMLSelectElement>("#new-file-type");
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

const workbench = new WorkbenchCore(createLocalStorageLayoutStore());
for (const view of WORKBENCH_VIEW_MANIFEST) workbench.registerView(view);

function updateViewPanels(state: LayoutState): void {
  for (const panel of viewPanels) {
    const id = panel.dataset.workbenchViewPanel;
    const region = panel.closest<HTMLElement>("[data-workbench-region]")?.dataset.workbenchRegion as ViewRegion | undefined;
    const activeId = region === "secondary-sidebar" ? state.activeSecondaryView : state.activePrimaryView;
    const registered = region !== undefined && id !== undefined
      && workbench.getViews(region).some((view) => view.id === id);
    const active = registered && id === activeId;
    panel.classList.toggle("view-panel-active", active);
    panel.setAttribute("aria-hidden", String(!active));
  }
  for (const button of activityViewButtons) {
    const id = button.dataset.workbenchView;
    const region = button.dataset.workbenchViewRegion;
    const active = region === "secondary-sidebar"
      ? id === state.activeSecondaryView
      : id === state.activePrimaryView;
    button.classList.toggle("active", active);
    button.classList.toggle("active-primary", active && region === "primary-sidebar");
    button.classList.toggle("active-secondary", active && region === "secondary-sidebar");
    button.setAttribute("aria-pressed", String(active));
  }
}

function updateWorkbenchLayout(state: LayoutState): void {
  const editorOnly = workbench.isEditorOnly();
  workbenchRoot.dataset.editorOnly = String(editorOnly);
  workbenchRoot.style.setProperty("--primary-sidebar-width", `${state.primarySidebarWidth}px`);
  workbenchRoot.style.setProperty("--secondary-sidebar-width", `${state.secondarySidebarWidth}px`);
  primarySidebar.style.width = `${state.primarySidebarWidth}px`;
  secondarySidebar.style.width = `${state.secondarySidebarWidth}px`;
  primarySidebar.dataset.width = String(state.primarySidebarWidth);
  secondarySidebar.dataset.width = String(state.secondarySidebarWidth);
  primarySidebarResizer.setAttribute("aria-valuemin", "180");
  primarySidebarResizer.setAttribute("aria-valuemax", "800");
  primarySidebarResizer.setAttribute("aria-valuenow", String(state.primarySidebarWidth));
  secondarySidebarResizer.setAttribute("aria-valuemin", "180");
  secondarySidebarResizer.setAttribute("aria-valuemax", "800");
  secondarySidebarResizer.setAttribute("aria-valuenow", String(state.secondarySidebarWidth));
  activityBar.hidden = !state.activityBarVisible;
  primarySidebar.hidden = !state.primarySidebarVisible;
  secondarySidebar.hidden = !state.secondarySidebarVisible;
  workbenchToolbar.hidden = editorOnly;
  editorArea.dataset.editorOnly = String(editorOnly);
  toggleActivityBarButton.setAttribute("aria-pressed", String(state.activityBarVisible));
  togglePrimarySidebarButton.setAttribute("aria-pressed", String(state.primarySidebarVisible));
  toggleSecondarySidebarButton.setAttribute("aria-pressed", String(state.secondarySidebarVisible));
  toggleEditorOnlyButton.setAttribute("aria-pressed", String(editorOnly));
  toolbarToggleActivityBarButton.setAttribute("aria-pressed", String(state.activityBarVisible));
  toolbarTogglePrimarySidebarButton.setAttribute("aria-pressed", String(state.primarySidebarVisible));
  toolbarToggleSecondarySidebarButton.setAttribute("aria-pressed", String(state.secondarySidebarVisible));
  toolbarToggleEditorOnlyButton.setAttribute("aria-pressed", String(editorOnly));
  updateViewPanels(state);
}

const removeWorkbenchListener = workbench.onDidChange(updateWorkbenchLayout);

for (const button of activityViewButtons) {
  button.addEventListener("click", () => {
    const viewId = button.dataset.workbenchView;
    if (!viewId) return;
    const registered = workbench.getViews("primary-sidebar").some((view) => view.id === viewId)
      || workbench.getViews("secondary-sidebar").some((view) => view.id === viewId);
    if (!registered) return;
    workbench.showView(viewId);
  });
}
togglePrimarySidebarButton.addEventListener("click", () => workbench.execute("maginalia.view.togglePrimarySidebar"));
toggleSecondarySidebarButton.addEventListener("click", () => workbench.execute("maginalia.view.toggleSecondarySidebar"));
toggleActivityBarButton.addEventListener("click", () => workbench.execute("maginalia.view.toggleActivityBar"));
toggleEditorOnlyButton.addEventListener("click", () => workbench.execute("maginalia.view.toggleEditorOnly"));
toolbarTogglePrimarySidebarButton.addEventListener("click", () => workbench.execute("maginalia.view.togglePrimarySidebar"));
toolbarToggleSecondarySidebarButton.addEventListener("click", () => workbench.execute("maginalia.view.toggleSecondarySidebar"));
toolbarToggleActivityBarButton.addEventListener("click", () => workbench.execute("maginalia.view.toggleActivityBar"));
toolbarToggleEditorOnlyButton.addEventListener("click", () => workbench.execute("maginalia.view.toggleEditorOnly"));

type ResizeSession = {
  region: ViewRegion;
  startX: number;
  startWidth: number;
};

function beginResize(region: ViewRegion, event: PointerEvent): void {
  if (event.button !== 0) return;
  const current = workbench.getState();
  const session: ResizeSession = {
    region,
    startX: event.clientX,
    startWidth: region === "primary-sidebar" ? current.primarySidebarWidth : current.secondarySidebarWidth
  };
  const onMove = (moveEvent: PointerEvent): void => {
    const delta = moveEvent.clientX - session.startX;
    const nextWidth = session.region === "primary-sidebar"
      ? session.startWidth + delta
      : session.startWidth - delta;
    workbench.resize(session.region, nextWidth);
  };
  const onEnd = (): void => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onEnd);
    document.removeEventListener("pointercancel", onEnd);
    document.body.classList.remove("resizing-sidebar");
  };
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onEnd);
  document.addEventListener("pointercancel", onEnd);
  document.body.classList.add("resizing-sidebar");
  event.preventDefault();
}

function resizeFromKeyboard(region: ViewRegion, event: KeyboardEvent): void {
  const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
  if (direction === 0) return;
  const current = workbench.getState();
  const width = region === "primary-sidebar"
    ? current.primarySidebarWidth + direction * 16
    : current.secondarySidebarWidth - direction * 16;
  workbench.resize(region, width);
  event.preventDefault();
}

primarySidebarResizer.addEventListener("pointerdown", (event) => beginResize("primary-sidebar", event));
secondarySidebarResizer.addEventListener("pointerdown", (event) => beginResize("secondary-sidebar", event));
primarySidebarResizer.addEventListener("keydown", (event) => resizeFromKeyboard("primary-sidebar", event));
secondarySidebarResizer.addEventListener("keydown", (event) => resizeFromKeyboard("secondary-sidebar", event));

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
  workspaceLabel.textContent = "Document";
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

function renderProjectState(state: ProjectNavigationState): void {
  workspaceLabel.textContent = "Project";
  workspaceDocumentName.textContent = state.project?.displayName ?? "No Project open";
  manuscriptList.replaceChildren();

  if (!state.project) {
    emptyDocumentMessage.textContent = "Open or create a Project folder to see its Markdown files.";
    emptyDocumentMessage.hidden = false;
    return;
  }
  if (state.files.length === 0) {
    emptyDocumentMessage.textContent = "This Project has no Markdown files yet. Create one from Registry.";
    emptyDocumentMessage.hidden = false;
    return;
  }

  emptyDocumentMessage.hidden = true;
  for (const file of state.files) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "manuscript-button";
    button.textContent = file.displayName;
    button.dataset.manuscriptId = file.fileId;
    button.dataset.projectFileType = file.documentType;
    if (state.activeFileId === file.fileId) {
      button.classList.add("active");
      button.setAttribute("aria-current", "page");
    }
    const type = document.createElement("small");
    type.className = "project-file-type";
    type.textContent = file.documentType;
    item.append(button, type);
    manuscriptList.append(item);
  }
}

let projectController: ProjectNavigationController | undefined;
let workspaceController: WorkspaceNavigationController | undefined;

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

const projectView: ProjectNavigationView = {
  setProjectState(state: ProjectNavigationState): void {
    renderProjectState(state);
    updateSmokeTextForSmoke?.();
    for (const button of manuscriptList.querySelectorAll<HTMLButtonElement>("button[data-manuscript-id]")) {
      button.addEventListener("click", () => {
        const fileId = button.dataset.manuscriptId;
        if (fileId) void projectController?.openFile(fileId);
      });
    }
  },
  setProjectError(message: string | null): void {
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

function getProjectApi(): ProjectNavigationApi | null {
  const api = window.maginalia;
  if (!api
    || typeof api.openProject !== "function"
    || typeof api.createProject !== "function"
    || typeof api.restoreProject !== "function"
    || typeof api.openProjectFile !== "function"
    || typeof api.createProjectFile !== "function") {
    return null;
  }
  const openProject = api.openProject;
  const createProject = api.createProject;
  const restoreProject = api.restoreProject;
  const openProjectFile = api.openProjectFile;
  const createProjectFile = api.createProjectFile;
  return {
    openProject: () => openProject(),
    createProject: (request) => createProject(request),
    restoreProject: () => restoreProject(),
    openProjectFile: (request) => openProjectFile(request),
    createProjectFile: (request) => createProjectFile(request)
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
const projectSmokeMode = smokeQuery === "project";
const projectRestoreSmokeMode = smokeQuery === "project-restore";
const projectCreateSmokeMode = smokeQuery === "project-create";
const workbenchSmokeMode = smokeQuery === "workbench";
const smokeDecisionQueue: DirtySwitchDecision[] = [];
const legacyWorkspaceMode = workspaceSmokeMode || quotationSmokeMode || repositorySmokeMode;
const projectLikeSmokeMode = projectSmokeMode || projectRestoreSmokeMode || projectCreateSmokeMode;
openButton.textContent = writingSmokeMode ? "Open" : legacyWorkspaceMode ? "Open Document" : "Open Project";
repositoryNavigation.hidden = writingSmokeMode;
newFileForm.hidden = writingSmokeMode || legacyWorkspaceMode || projectRestoreSmokeMode;
createProjectButton.hidden = writingSmokeMode || legacyWorkspaceMode || projectRestoreSmokeMode;
createProjectTitle.hidden = writingSmokeMode || legacyWorkspaceMode || projectRestoreSmokeMode;
openProjectButton.hidden = writingSmokeMode || legacyWorkspaceMode || projectRestoreSmokeMode || projectCreateSmokeMode;

if (writingSmokeMode || workspaceSmokeMode || quotationSmokeMode || repositorySmokeMode || projectLikeSmokeMode) {
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
        : projectLikeSmokeMode
          ? "project"
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

if (workspaceSmokeMode || quotationSmokeMode || repositorySmokeMode || projectLikeSmokeMode) {
  window.addEventListener("maginalia-smoke-decision", (event) => {
    const decision = (event as CustomEvent<unknown>).detail;
    if (decision === "save" || decision === "discard" || decision === "cancel") {
      smokeDecisionQueue.push(decision);
    }
  });
  window.addEventListener("error", (event) => {
    const smokeLabel = quotationSmokeMode ? "Quotation" : repositorySmokeMode ? "Repository" : projectLikeSmokeMode ? "Project" : "Workspace";
    console.error(`${smokeLabel} smoke page error: ${event.message}`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const smokeLabel = quotationSmokeMode ? "Quotation" : repositorySmokeMode ? "Repository" : projectLikeSmokeMode ? "Project" : "Workspace";
    console.error(`${smokeLabel} smoke unhandled rejection: ${String(event.reason)}`);
  });
}

if (legacyWorkspaceMode) {
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
} else if (!writingSmokeMode) {
  const projectApi = getProjectApi();
  if (!projectApi) {
    projectView.setProjectError("Project is unavailable. Reload MAGINALIA to try again.");
    openButton.disabled = true;
    openProjectButton.disabled = true;
    createProjectButton.disabled = true;
    newFileForm.querySelectorAll("input, select, button").forEach((element) => {
      (element as HTMLInputElement | HTMLSelectElement | HTMLButtonElement).disabled = true;
    });
  } else {
    projectController = new ProjectNavigationController({
      api: projectApi,
      writing: controller,
      view: projectView,
      decideDirtySwitch: projectLikeSmokeMode
        ? () => smokeDecisionQueue.shift() ?? "cancel"
        : (context) => decideDirtySwitch(context, (message) => window.confirm(message))
    });
    if ((!projectLikeSmokeMode && !workbenchSmokeMode) || projectRestoreSmokeMode) {
      void projectController.restoreProject();
    }
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
  const documentPort = workspaceController ?? projectController;
  if (!repositoryApi || !documentPort || !libraryController) {
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
      workspace: documentPort,
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
} else if (projectController) {
  openButton.addEventListener("click", () => {
    void projectController?.openProject();
  });
  openProjectButton.addEventListener("click", () => {
    void projectController?.openProject();
  });
}

createProjectButton.addEventListener("click", () => {
  if (!projectController) return;
  void projectController.createProject(createProjectTitle.value);
});

newFileForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!projectController) return;
  void projectController.createFile({
    fileName: newFileName.value,
    title: newFileTitle.value,
    documentType: newFileType.value as ProjectDocumentType
  });
});

saveButton.addEventListener("click", () => {
  void controller.save();
});

window.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.shiftKey) {
    const commandByKey: Record<string, Parameters<WorkbenchCore["execute"]>[0]> = {
      a: "maginalia.view.toggleActivityBar",
      p: "maginalia.view.togglePrimarySidebar",
      s: "maginalia.view.toggleSecondarySidebar",
      e: "maginalia.view.toggleEditorOnly"
    };
    const command = commandByKey[event.key.toLowerCase()];
    if (command) {
      event.preventDefault();
      workbench.execute(command);
      return;
    }
  }
  if (event.key === "Escape" && workbench.isEditorOnly()) {
    event.preventDefault();
    workbench.execute("maginalia.view.toggleEditorOnly");
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void controller.save();
  }
}, { capture: true });
