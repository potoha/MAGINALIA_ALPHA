import "./style.css";
import { WritingController, type WritingStatus, type WritingView } from "./controller";
import { AutosaveCoordinator } from "./autosave-coordinator";
import { decideDirtySwitch } from "./dirty-decision";
import {
  LibraryController,
  type LibraryControllerApi,
  type LibraryControllerView,
  type LibraryViewState
} from "./library-controller";
import {
  ShelfController,
  type ShelfControllerApi,
  type ShelfControllerView,
  type ShelfViewState
} from "./shelf-controller";
import { MonacoMarkdownSurface } from "./monaco-surface";
import { renderMarkdownPreview } from "./markdown-renderer";
import { PreviewController } from "./preview-controller";
import { createLocalStorageRendererPreferenceStore } from "./renderer-preferences";
import { resolvePreviewMedia } from "./project-media";
import { resolvePreviewInternalLinks } from "./preview-links";
import { importDroppedImageIntoDocument } from "./dropped-image";
import type { DocumentSessionChange } from "./document-sessions";
import type { WorkspaceState } from "../workspace-state-ipc";
import { ModController, type ModControllerState } from "./mod-controller";
import {
  ReferencesController,
  type ReferencesControllerApi,
  type ReferencesControllerView,
  type ReferencesViewState
} from "./references-controller";
import {
  ExportController,
  type ExportControllerApi,
  type ExportControllerView,
  type ExportViewState
} from "./export-controller";
import {
  ProjectNavigationController,
  type ProjectNavigationApi,
  type ProjectNavigationState,
  type ProjectNavigationView
} from "./project-controller";
import { PROJECT_DOCUMENT_TYPES, type ProjectDocumentType } from "../project-metadata";
import { createProjectFileName } from "./project-ui";
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
        <button id="export-markdown" type="button" disabled>Export Markdown</button>
        <span id="document-name" class="document-name">No document open</span>
        <span id="document-status" class="document-status" data-state="empty" role="status" aria-live="polite">No document open</span>
        <span id="export-status" class="export-status" data-state="empty" role="status" aria-live="polite">Open a document to export.</span>
      </div>
      <div id="workbench-layout-controls" class="layout-controls" aria-label="Workbench layout controls">
        <button id="toolbar-toggle-activity-bar" data-workbench-command="maginalia.view.toggleActivityBar" type="button" title="Toggle activity bar">Activity</button>
        <button id="toolbar-toggle-primary-sidebar" data-workbench-command="maginalia.view.togglePrimarySidebar" type="button" title="Toggle primary sidebar">Primary</button>
        <button id="toolbar-toggle-secondary-sidebar" data-workbench-command="maginalia.view.toggleSecondarySidebar" type="button" title="Toggle secondary sidebar">Secondary</button>
        <button id="toolbar-toggle-editor-only" data-workbench-command="maginalia.view.toggleEditorOnly" type="button" title="Toggle editor-only mode">Editor only</button>
        <button id="open-mods-folder" type="button" title="Open the global Mods folder">Mods</button>
        <button id="reload-mods" type="button" title="Reload installed Mods">Reload Mods</button>
        <span id="mods-status" class="mods-status" role="status" aria-live="polite">Mods not loaded</span>
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
            <div class="project-header">
              <div class="workspace-document-heading">
                <span id="workspace-label" class="workspace-label">Project</span>
                <strong id="workspace-document-name">No Project open</strong>
              </div>
              <div id="project-header-actions" class="project-header-actions">
                <button id="project-new" class="project-header-action" type="button" aria-label="New Markdown file" title="New Markdown file" aria-haspopup="menu" aria-controls="project-new-menu" aria-expanded="false">+</button>
                <button id="project-overflow" class="project-header-action" type="button" aria-label="Project actions" title="Project actions" aria-haspopup="menu" aria-controls="project-overflow-menu" aria-expanded="false">…</button>
              </div>
            </div>
            <div id="project-new-menu" class="project-action-menu" role="menu" aria-label="New Markdown file" hidden>
              <span class="project-action-menu-label">New Markdown</span>
              ${PROJECT_DOCUMENT_TYPES.map((type) => `<button type="button" role="menuitem" data-document-type="${type}">${type}</button>`).join("")}
            </div>
            <div id="project-overflow-menu" class="project-action-menu" role="menu" aria-label="Project actions" hidden>
              <button id="open-project" type="button" role="menuitem">Open Project</button>
              <button id="project-create" type="button" role="menuitem">Create Project</button>
            </div>
            <form id="project-create-form" class="project-create-form" hidden>
              <label class="visually-hidden" for="create-project-title">New Project name</label>
              <input id="create-project-title" type="text" maxlength="200" autocomplete="off" placeholder="New Project name">
              <button id="create-project" type="submit">Create</button>
              <button id="project-create-cancel" type="button">Cancel</button>
            </form>
            <p id="workspace-error" class="workspace-error" role="alert" aria-live="assertive" hidden></p>
            <div id="project-inline-create" class="project-inline-create" hidden>
              <div class="project-inline-create-heading">
                <span>New Markdown</span>
                <strong id="project-inline-document-type"></strong>
              </div>
              <form id="new-file-form" class="new-file-form">
                <input id="new-file-name" type="hidden" maxlength="240" autocomplete="off">
                <label class="visually-hidden" for="new-file-title">Title</label>
                <input id="new-file-title" type="text" maxlength="240" autocomplete="off" placeholder="Title">
                <select id="new-file-type" hidden aria-hidden="true" tabindex="-1">
                ${PROJECT_DOCUMENT_TYPES.map((type) => `<option value="${type}">${type}</option>`).join("")}
                </select>
                <button id="new-file" type="submit" hidden aria-hidden="true">Create</button>
                <button id="project-create-file-submit" type="submit">Create</button>
                <button id="project-create-file-cancel" type="button">Cancel</button>
              </form>
            </div>
            <p id="empty-document-message" class="empty-document-message">Open a Project folder to see its Markdown files.</p>
            <ul id="manuscript-list" class="manuscript-list" role="listbox" aria-label="Markdown manuscripts"></ul>
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
        <nav id="document-tabs" class="document-tabs" role="tablist" aria-label="Open documents"></nav>
        <div id="document-presentation-controls" class="document-presentation-controls" aria-label="Document presentation">
          <button id="document-edit-mode" type="button" aria-pressed="true">Edit</button>
          <button id="document-preview-mode" type="button" aria-pressed="false">Preview</button>
          <span class="presentation-divider" aria-hidden="true"></span>
          <button id="document-horizontal" type="button" aria-pressed="true">Horizontal</button>
          <button id="document-vertical" type="button" aria-pressed="false">Vertical</button>
        </div>
        <section id="editor" class="editor" aria-label="Markdown editor"></section>
        <section id="markdown-preview" class="markdown-preview" aria-label="Markdown preview" hidden></section>
      </section>
      <aside id="secondary-sidebar" class="workbench-sidebar secondary-sidebar" data-workbench-region="secondary-sidebar" aria-label="Secondary sidebar">
        <div id="secondary-sidebar-resizer" class="sidebar-resizer" data-workbench-resize="secondary-sidebar" role="separator" aria-label="Resize secondary sidebar" aria-orientation="vertical" tabindex="0"></div>
        <div class="view-container secondary-view-container">
          <section id="library-navigation" class="library-navigation view-panel" aria-labelledby="library-heading">
            <div class="library-heading-row">
              <h2 id="library-heading">Shelf</h2>
              <strong id="library-name">Reviewer Shelf</strong>
              <button id="choose-library" type="button" hidden aria-hidden="true">Choose local Library</button>
              <button id="refresh-references" type="button" disabled>Refresh References</button>
            </div>
            <form id="library-search-form" class="library-search-form">
              <label class="visually-hidden" for="library-query">Search quotations</label>
              <input id="library-query" type="search" autocomplete="off" placeholder="Search quotations...">
              <button id="library-search" type="submit">Search</button>
            </form>
            <p id="library-status" class="library-status" role="status" aria-live="polite">Search approved Reviewer quotations.</p>
            <p id="library-error" class="library-error" role="alert" aria-live="assertive" hidden></p>
            <p id="references-status" class="references-status" data-state="empty" role="status" aria-live="polite">Open a document to refresh References.</p>
            <p id="references-unresolved" class="references-unresolved">Unresolved: 0</p>
            <ul id="library-results" class="library-results" aria-label="Shelf quotations"></ul>
          </section>
          <section id="mod-contributions" class="mod-contributions" aria-label="Mod contributions">
            <div id="mod-view-host"></div>
            <div id="mod-command-host"></div>
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
const documentTabs = requiredElement<HTMLElement>("#document-tabs");
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
const openModsFolderButton = requiredElement<HTMLButtonElement>("#open-mods-folder");
const reloadModsButton = requiredElement<HTMLButtonElement>("#reload-mods");
const modsStatus = requiredElement<HTMLElement>("#mods-status");
const openButton = requiredElement<HTMLButtonElement>("#open-markdown");
const openProjectButton = requiredElement<HTMLButtonElement>("#open-project");
const saveButton = requiredElement<HTMLButtonElement>("#save-markdown");
const exportButton = requiredElement<HTMLButtonElement>("#export-markdown");
const documentName = requiredElement<HTMLElement>("#document-name");
const documentStatus = requiredElement<HTMLElement>("#document-status");
const exportStatus = requiredElement<HTMLElement>("#export-status");
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
const refreshReferencesButton = requiredElement<HTMLButtonElement>("#refresh-references");
const librarySearchForm = requiredElement<HTMLFormElement>("#library-search-form");
const libraryQuery = requiredElement<HTMLInputElement>("#library-query");
const librarySearchButton = requiredElement<HTMLButtonElement>("#library-search");
const libraryStatus = requiredElement<HTMLElement>("#library-status");
const libraryError = requiredElement<HTMLElement>("#library-error");
const referencesStatus = requiredElement<HTMLElement>("#references-status");
const referencesUnresolved = requiredElement<HTMLElement>("#references-unresolved");
const libraryResults = requiredElement<HTMLUListElement>("#library-results");
const modViewHost = requiredElement<HTMLElement>("#mod-view-host");
const modCommandHost = requiredElement<HTMLElement>("#mod-command-host");
const editorContainer = requiredElement<HTMLElement>("#editor");
const previewContainer = requiredElement<HTMLElement>("#markdown-preview");
const editModeButton = requiredElement<HTMLButtonElement>("#document-edit-mode");
const previewModeButton = requiredElement<HTMLButtonElement>("#document-preview-mode");
const horizontalDirectionButton = requiredElement<HTMLButtonElement>("#document-horizontal");
const verticalDirectionButton = requiredElement<HTMLButtonElement>("#document-vertical");
const projectHeaderActions = requiredElement<HTMLElement>("#project-header-actions");
const projectNewButton = requiredElement<HTMLButtonElement>("#project-new");
const projectNewMenu = requiredElement<HTMLElement>("#project-new-menu");
const projectOverflowButton = requiredElement<HTMLButtonElement>("#project-overflow");
const projectOverflowMenu = requiredElement<HTMLElement>("#project-overflow-menu");
const projectCreateButton = requiredElement<HTMLButtonElement>("#project-create");
const projectCreateForm = requiredElement<HTMLFormElement>("#project-create-form");
const projectCreateCancelButton = requiredElement<HTMLButtonElement>("#project-create-cancel");
const projectInlineCreate = requiredElement<HTMLElement>("#project-inline-create");
const projectInlineDocumentType = requiredElement<HTMLElement>("#project-inline-document-type");
const projectCreateFileCancelButton = requiredElement<HTMLButtonElement>("#project-create-file-cancel");
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

const autosaveCoordinator = new AutosaveCoordinator({ writing: controller });
controller.setAutosaveCoordinator(autosaveCoordinator);

// Declared before PreviewController's immediate initial render. Project
// activation fills it later; previews without a Project show safe fallbacks.
let projectController: ProjectNavigationController | undefined;
const rendererPreferences = createLocalStorageRendererPreferenceStore();
let previewMediaGeneration = 0;

const previewApi = typeof window.maginalia.resolveReferences === "function"
  ? { resolveReferences: (request: { readonly text: string }) => window.maginalia.resolveReferences(request) }
  : null;
const previewController = new PreviewController({
  writing: controller,
  api: previewApi,
  preferences: rendererPreferences,
  view: {
    setPreviewState(state): void {
      const previewing = state.mode === "preview";
      editorContainer.hidden = previewing;
      previewContainer.hidden = !previewing;
      editModeButton.setAttribute("aria-pressed", String(!previewing));
      previewModeButton.setAttribute("aria-pressed", String(previewing));
      horizontalDirectionButton.setAttribute("aria-pressed", String(state.direction === "horizontal"));
      verticalDirectionButton.setAttribute("aria-pressed", String(state.direction === "vertical"));
      horizontalDirectionButton.disabled = state.document === null;
      verticalDirectionButton.disabled = state.document === null;
      if (!previewing) return;
      const text = state.document?.currentText ?? "";
      const generation = ++previewMediaGeneration;
      const projectId = projectController?.getState().project?.projectId ?? null;
      renderMarkdownPreview(previewContainer, text, state.quoteMap, state.direction);
      const linkApi = typeof window.maginalia.resolveInternalLink === "function"
        ? { resolveInternalLink: (request: { readonly projectId: string; readonly target: string }) => window.maginalia.resolveInternalLink(request) }
        : null;
      const mediaApi = typeof window.maginalia.resolveProjectAsset === "function"
        ? { resolveProjectAsset: (request: { readonly projectId: string; readonly relativePath: string }) => window.maginalia.resolveProjectAsset(request) }
        : null;
      void Promise.all([
        resolvePreviewInternalLinks(linkApi, projectId, text),
        resolvePreviewMedia(mediaApi, projectId, text)
      ]).then(([internalLinks, media]) => {
        if (generation !== previewMediaGeneration || previewController.getMode() !== "preview") return;
        const current = controller.getDocumentState();
        if (current?.currentText !== text) return;
        renderMarkdownPreview(previewContainer, text, state.quoteMap, state.direction, {}, internalLinks, media);
      }).catch(() => undefined);
    }
  }
});

editModeButton.addEventListener("click", () => previewController.setMode("edit"));
previewModeButton.addEventListener("click", () => previewController.setMode("preview"));
horizontalDirectionButton.addEventListener("click", () => previewController.setDirection("horizontal"));
verticalDirectionButton.addEventListener("click", () => previewController.setDirection("vertical"));

editorContainer.addEventListener("dragover", (event) => {
  const files = event.dataTransfer?.files;
  if (files !== undefined && files.length > 0) event.preventDefault();
});
editorContainer.addEventListener("drop", (event) => {
  const dropped = event.dataTransfer?.files.item(0);
  const projectId = projectController?.getState().project?.projectId;
  // Prevent Chromium from navigating the Workbench to a dropped local file.
  // The actual source path crosses only the bounded import IPC below.
  if (event.dataTransfer?.files.length) event.preventDefault();
  if (dropped === null || dropped === undefined || projectId === undefined || typeof window.maginalia.importDroppedImageFile !== "function") {
    documentStatus.dataset.state = "error";
    documentStatus.textContent = "Open a Project document before dropping an image.";
    return;
  }
  const droppedFile = dropped;
  void importDroppedImageIntoDocument({
    writing: controller,
    importImage: () => {
      const optimize = rendererPreferences.load().optimizeDroppedImages;
      // Electron 32+ intentionally removed File.path. The preload helper
      // uses webUtils.getPathForFile, so renderer code never receives an
      // absolute filesystem path.
      return window.maginalia.importDroppedImageFile({ projectId, file: droppedFile, optimize });
    }
  }).then((result) => {
    if (result.kind === "inserted") return;
    documentStatus.dataset.state = "error";
    documentStatus.textContent = result.message;
  });
});

async function flushAllAutosave(): Promise<boolean> {
  const results = await autosaveCoordinator.flushAll();
  return results.every((result) => result.kind === "saved" || result.kind === "clean");
}

// Main process shutdown uses this subscription as an explicit awaitable
// handshake. No beforeunload/unload save is attempted.
const removeAutosaveFlushRequest = window.maginalia.onAutosaveFlushRequest?.(
  () => flushAllAutosave()
);

let modController: ModController | undefined;

function renderModState(state: ModControllerState): void {
  modsStatus.dataset.state = state.busy ? "busy" : "ready";
  modsStatus.textContent = state.message;
  openModsFolderButton.disabled = state.busy;
  reloadModsButton.disabled = state.busy;

  modViewHost.replaceChildren();
  modCommandHost.replaceChildren();

  for (const registration of state.snapshot.contributions) {
    const contribution = registration.contribution;
    if (contribution.kind === "view") {
      const view = document.createElement("div");
      view.className = "mod-view-contribution";
      view.dataset.modId = registration.modId;
      view.dataset.modViewId = contribution.id;
      view.textContent = `${contribution.title} · ${contribution.region}`;
      modViewHost.append(view);
      continue;
    }

    const command = document.createElement("button");
    command.type = "button";
    command.className = "mod-command";
    command.dataset.modId = registration.modId;
    command.dataset.modCommandId = contribution.id;
    command.textContent = contribution.title;
    command.disabled = state.busy;
    command.addEventListener("click", () => {
      void modController?.invoke(registration.modId, contribution.id);
    });
    modCommandHost.append(command);
  }
}

const modView: { setModState(state: ModControllerState): void } = {
  setModState: renderModState
};

function renderDocumentTabs(change: DocumentSessionChange): void {
  documentTabs.replaceChildren();
  const mainViews = change.views.filter((view) => view.region === "main" && view.groupId === "editor-group-1");
  for (const view of mainViews) {
    const session = change.sessions.find((candidate) => candidate.documentId === view.documentId);
    if (session === undefined) continue;
    const tab = document.createElement("div");
    tab.className = "document-tab";
    tab.dataset.documentTab = session.documentId;
    tab.dataset.documentViewId = view.instanceId;
    tab.setAttribute("role", "presentation");
    tab.classList.toggle("active", change.activeDocumentId === session.documentId);
    tab.classList.toggle("dirty", session.currentText !== session.savedText);

    const activate = document.createElement("button");
    activate.type = "button";
    activate.className = "document-tab-label";
    activate.setAttribute("role", "tab");
    activate.setAttribute("aria-selected", String(change.activeDocumentId === session.documentId));
    activate.textContent = session.displayName;
    activate.title = session.displayName;
    if (session.currentText !== session.savedText) {
      const dirty = document.createElement("span");
      dirty.className = "document-tab-dirty";
      dirty.textContent = "●";
      dirty.setAttribute("aria-label", "unsaved changes");
      activate.append(dirty);
    }
    activate.addEventListener("click", () => {
      void controller.activateDocument(session.documentId);
    });

    const close = document.createElement("button");
    close.type = "button";
    close.className = "document-tab-close";
    close.setAttribute("aria-label", `Close ${session.displayName}`);
    close.textContent = "×";
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      void controller.closeDocumentView(view.instanceId, async (displayName) => {
        return decideDirtySwitch(
          { currentDisplayName: displayName, target: { kind: "manuscript", displayName: "another document tab" } },
          (message) => window.confirm(message)
        );
      });
    });
    tab.append(activate, close);
    documentTabs.append(tab);
  }
  documentTabs.hidden = mainViews.length === 0;
}

controller.onSessionChange(renderDocumentTabs);

function renderWorkspaceState(state: WorkspaceNavigationState): void {
  workspaceLabel.textContent = "Document";
  workspaceDocumentName.textContent = state.document?.displayName ?? "No Document open";
  manuscriptList.removeAttribute("role");
  manuscriptList.dataset.navigationMode = "workspace";
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

let selectedProjectDocumentType: ProjectDocumentType | null = null;
let selectedProjectFileId: string | null = null;

function renderProjectState(state: ProjectNavigationState): void {
  workspaceLabel.textContent = "Project";
  workspaceDocumentName.textContent = state.project?.displayName ?? "No Project open";
  manuscriptList.setAttribute("role", "listbox");
  manuscriptList.dataset.navigationMode = "project";
  manuscriptList.replaceChildren();
  updateProjectActionAvailability(state.project !== null);

  if (!state.project) {
    selectedProjectFileId = null;
    emptyDocumentMessage.textContent = "Open or create a Project folder to see its Markdown files.";
    emptyDocumentMessage.hidden = false;
    return;
  }
  const selectedFileStillExists = state.files.some((file) => file.fileId === selectedProjectFileId);
  if (!selectedFileStillExists) selectedProjectFileId = state.activeFileId ?? state.files[0]?.fileId ?? null;
  if (state.files.length === 0) {
    emptyDocumentMessage.textContent = "This Project has no Markdown files yet. Use + to create one.";
    emptyDocumentMessage.hidden = false;
    return;
  }

  emptyDocumentMessage.hidden = true;
  for (const file of state.files) {
    const item = document.createElement("li");
    item.className = "project-file-row";
    item.dataset.projectFileId = file.fileId;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "manuscript-button";
    button.setAttribute("role", "option");
    button.dataset.manuscriptId = file.fileId;
    button.dataset.manuscriptName = file.displayName;
    button.dataset.projectFileType = file.documentType;
    button.title = file.displayName;
    button.tabIndex = selectedProjectFileId === file.fileId ? 0 : -1;
    const title = document.createElement("span");
    title.className = "project-file-title";
    title.textContent = file.title;
    const type = document.createElement("small");
    type.className = "project-file-type";
    type.textContent = file.documentType;
    button.append(title, type);
    button.setAttribute("aria-selected", String(selectedProjectFileId === file.fileId));
    if (state.activeFileId === file.fileId) {
      button.classList.add("active");
      button.setAttribute("aria-current", "page");
    }
    item.setAttribute("role", "none");
    item.append(button);
    manuscriptList.append(item);
  }
}

function updateProjectActionAvailability(hasProject: boolean): void {
  projectNewButton.disabled = !hasProject || selectedProjectDocumentType !== null;
  projectOverflowButton.disabled = selectedProjectDocumentType !== null;
}

function updateSelectedProjectFile(buttons: readonly HTMLButtonElement[], fileId: string | null): void {
  selectedProjectFileId = fileId;
  for (const candidate of buttons) {
    candidate.setAttribute("aria-selected", String(candidate.dataset.manuscriptId === fileId));
  }
}

function menuItems(menu: HTMLElement): HTMLButtonElement[] {
  return [...menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')];
}

function focusMenuItem(menu: HTMLElement, index: number): void {
  const items = menuItems(menu);
  if (items.length === 0) return;
  const bounded = (index + items.length) % items.length;
  items[bounded]?.focus();
}

function setProjectMenuOpen(menu: HTMLElement, trigger: HTMLButtonElement, open: boolean): void {
  menu.hidden = !open;
  trigger.setAttribute("aria-expanded", String(open));
}

function cancelProjectFileCreation(restoreFocus = true): void {
  projectInlineCreate.hidden = true;
  selectedProjectDocumentType = null;
  updateProjectActionAvailability(projectController?.getState().project !== null);
  newFileForm.reset();
  if (restoreFocus) projectNewButton.focus();
}

function cancelProjectCreation(restoreFocus = true): void {
  projectCreateForm.hidden = true;
  createProjectTitle.value = "";
  if (restoreFocus) projectOverflowButton.focus();
}

function beginProjectFileCreation(documentType: ProjectDocumentType): void {
  selectedProjectDocumentType = documentType;
  newFileType.value = documentType;
  newFileTitle.value = "";
  newFileName.value = "";
  projectInlineDocumentType.textContent = documentType;
  projectInlineCreate.hidden = false;
  updateProjectActionAvailability(projectController?.getState().project !== null);
  setProjectMenuOpen(projectNewMenu, projectNewButton, false);
  setProjectMenuOpen(projectOverflowMenu, projectOverflowButton, false);
  newFileTitle.focus();
}

function bindProjectFileKeyboard(): void {
  const buttons = [...manuscriptList.querySelectorAll<HTMLButtonElement>("button[data-manuscript-id]")];
  buttons.forEach((button, index) => {
    button.addEventListener("focus", () => {
      updateSelectedProjectFile(buttons, button.dataset.manuscriptId ?? null);
      buttons.forEach((candidate) => { candidate.tabIndex = candidate === button ? 0 : -1; });
    });
    button.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        const selected = buttons.find((candidate) => candidate.dataset.manuscriptId === selectedProjectFileId) ?? button;
        selected.click();
        return;
      }
      const nextIndex = event.key === "ArrowDown"
        ? index + 1
        : event.key === "ArrowUp"
          ? index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : undefined;
      if (nextIndex === undefined) return;
      event.preventDefault();
      buttons.forEach((candidate) => { candidate.tabIndex = -1; });
      const next = buttons[Math.max(0, Math.min(buttons.length - 1, nextIndex))];
      if (next) {
        updateSelectedProjectFile(buttons, next.dataset.manuscriptId ?? null);
        next.tabIndex = 0;
        next.focus();
      }
    });
  });
}

function bindProjectMenuKeyboard(menu: HTMLElement, trigger: HTMLButtonElement): void {
  menu.addEventListener("keydown", (event) => {
    const items = menuItems(menu);
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusMenuItem(menu, currentIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusMenuItem(menu, currentIndex - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusMenuItem(menu, 0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusMenuItem(menu, items.length - 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setProjectMenuOpen(menu, trigger, false);
      trigger.focus();
    } else if (event.key === "Tab") {
      setProjectMenuOpen(menu, trigger, false);
    }
  });
}

function bindProjectMenuTriggerKeyboard(menu: HTMLElement, trigger: HTMLButtonElement): void {
  trigger.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    setProjectMenuOpen(menu, trigger, true);
    const items = menuItems(menu);
    queueMicrotask(() => focusMenuItem(menu, event.key === "ArrowDown" ? 0 : items.length - 1));
  });
}

let workspaceController: WorkspaceNavigationController | undefined;
let persistedWorkspaceState: WorkspaceState | null = null;

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
    void persistWorkspaceState();
    bindProjectFileKeyboard();
    updateSmokeTextForSmoke?.();
    for (const button of manuscriptList.querySelectorAll<HTMLButtonElement>("button[data-manuscript-id]")) {
      button.addEventListener("click", () => {
        const fileId = button.dataset.manuscriptId;
        if (fileId) {
          updateSelectedProjectFile(
            [...manuscriptList.querySelectorAll<HTMLButtonElement>("button[data-manuscript-id]")],
            fileId
          );
          void projectController?.openFile(fileId);
        }
      });
    }
  },
  setProjectError(message: string | null): void {
    workspaceError.textContent = message ?? "";
    workspaceError.hidden = message === null;
  }
};

let workspacePersistChain: Promise<void> = Promise.resolve();

function persistWorkspaceState(): Promise<void> {
  // Session/tab transitions can notify several observers in one turn. Queue
  // the atomic file writes so a late save cannot race an earlier `.tmp`
  // rename and accidentally persist an intermediate one-tab snapshot.
  workspacePersistChain = workspacePersistChain.then(async () => {
    const save = window.maginalia.saveWorkspaceState;
    const project = projectController?.getState().project;
    if (!save || !project) return;
    const state = projectController?.getState();
    if (!state) return;
    const snapshot: WorkspaceState = {
      version: 1,
      projectId: project.projectId,
      openFileIds: projectController?.getOpenedFileIds() ?? [],
      activeFileId: state.activeFileId,
      viewPlacements: controller.getDocumentViews().map((view) => ({
        // Persist project-relative opaque file IDs, not runtime session IDs.
        documentId: projectController?.getFileIdForSession(view.documentId) ?? view.documentId,
        viewType: view.viewType,
        region: view.region,
        groupId: view.groupId
      }))
    };
    try {
      await save(snapshot);
    } catch {
      // Workspace restoration is convenience state and must never block editing.
    }
  }, () => undefined);
  return workspacePersistChain;
}

async function restorePersistedProjectViews(): Promise<void> {
  const current = projectController?.getState();
  const project = current?.project;
  if (!project || persistedWorkspaceState === null || persistedWorkspaceState.projectId !== project.projectId) return;
  const validFileIds = new Set(current?.files.map((file) => file.fileId) ?? []);
  const openFiles = persistedWorkspaceState.openFileIds;
  for (const fileId of openFiles) {
    if (validFileIds.has(fileId)) await projectController?.openFile(fileId);
  }
  if (persistedWorkspaceState.activeFileId !== null && validFileIds.has(persistedWorkspaceState.activeFileId)) {
    await projectController?.openFile(persistedWorkspaceState.activeFileId);
  }
}

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

function renderShelfState(state: ShelfViewState): void {
  libraryName.textContent = "Reviewer Shelf";
  libraryQuery.value = state.query;
  libraryQuery.disabled = state.status === "searching";
  librarySearchButton.disabled = state.status === "searching";

  const statusMessage = state.status === "searching"
    ? "Searching Reviewer…"
    : state.status === "ready"
      ? `${state.results.length} quotation${state.results.length === 1 ? "" : "s"}`
      : "Search approved Reviewer quotations.";
  libraryStatus.dataset.state = state.status;
  libraryStatus.textContent = statusMessage;
  libraryError.textContent = state.error ?? "";
  libraryError.hidden = state.error === null;

  libraryResults.replaceChildren();
  for (const reference of state.results) {
    const item = document.createElement("li");
    item.className = "library-result";

    const details = document.createElement("div");
    details.className = "library-reference";
    const quote = document.createElement("blockquote");
    quote.className = "shelf-quote";
    quote.textContent = `「${reference.quote}」`;
    details.append(quote);
    const title = document.createElement("strong");
    title.textContent = reference.title ?? reference.isbn13 ?? "Untitled work";
    details.append(title);
    const metadata = document.createElement("span");
    const authors = reference.authors.join("、");
    metadata.textContent = [
      authors,
      reference.pageLabel.length > 0 ? `p. ${reference.pageLabel}` : ""
    ].filter((part) => part.length > 0).join(" / ");
    details.append(metadata);
    if (reference.comment.length > 0) {
      const comment = document.createElement("span");
      comment.className = "shelf-comment";
      comment.textContent = reference.comment;
      details.append(comment);
    }

    const actions = document.createElement("div");
    actions.className = "library-result-actions";
    const select = document.createElement("button");
    select.type = "button";
    select.textContent = state.selectedAnnotationId === reference.annotationId ? "Selected" : "Select";
    select.setAttribute("aria-pressed", String(state.selectedAnnotationId === reference.annotationId));
    select.addEventListener("click", () => shelfController?.selectResult(reference.annotationId));
    const insert = document.createElement("button");
    insert.type = "button";
    insert.textContent = "Insert";
    insert.addEventListener("click", () => void shelfController?.insertResult(reference.annotationId));
    actions.append(select, insert);
    item.append(details, actions);
    libraryResults.append(item);
  }
}

function renderReferencesState(state: ReferencesViewState): void {
  referencesStatus.dataset.state = state.status;
  referencesStatus.textContent = state.message;
  referencesUnresolved.textContent = `Unresolved: ${state.unresolvedCount}`;
  refreshReferencesButton.disabled = state.status === "empty" || state.status === "refreshing";
}

/**
 * Keep the owner-bound local Library port usable for repository/legacy flows.
 * Normal Shelf search never calls this renderer; repository handoff and the
 * existing quotation smoke deliberately use the old local backend.
 */
let legacyLibraryActive = false;

function renderLegacyLibraryState(state: LibraryViewState): void {
  legacyLibraryActive = state.library !== null;
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
    metadata.textContent = [
      reference.authors.join("、"),
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

const shelfView: ShelfControllerView = {
  setShelfState(state: ShelfViewState): void {
    renderShelfState(state);
  }
};

// LibraryController remains a local-backend compatibility port for explicit
// repository Shelf handoffs. It never owns the Normal Shelf DOM.
const legacyLibraryView: LibraryControllerView = {
  setLibraryState(state: LibraryViewState): void {
    renderLegacyLibraryState(state);
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

function getShelfApi(): ShelfControllerApi | null {
  const api = window.maginalia;
  if (!api || typeof api.searchShelf !== "function") return null;
  const searchShelf = api.searchShelf;
  return {
    searchShelf: (request) => searchShelf(request)
  };
}

function getReferencesApi(): ReferencesControllerApi | null {
  const api = window.maginalia;
  if (!api || typeof api.resolveReferences !== "function") return null;
  const resolveReferences = api.resolveReferences;
  return {
    resolveReferences: (request) => resolveReferences(request)
  };
}

function getExportApi(): ExportControllerApi | null {
  const api = window.maginalia;
  if (!api || typeof api.resolveExport !== "function" || typeof api.writeExport !== "function") return null;
  const resolveExport = api.resolveExport;
  const writeExport = api.writeExport;
  return {
    resolveExport: (request) => resolveExport(request),
    writeExport: (request) => writeExport(request)
  };
}

function getModApi(): ConstructorParameters<typeof ModController>[0]["api"] | null {
  const api = window.maginalia;
  if (!api
    || typeof api.loadMods !== "function"
    || typeof api.reloadMods !== "function"
    || typeof api.openModsFolder !== "function"
    || typeof api.invokeModCommand !== "function") {
    return null;
  }
  const loadMods = api.loadMods;
  const reloadMods = api.reloadMods;
  const openModsFolder = api.openModsFolder;
  const invokeModCommand = api.invokeModCommand;
  return {
    loadMods: () => loadMods(),
    reloadMods: () => reloadMods(),
    openModsFolder: () => openModsFolder(),
    invokeModCommand: (request) => invokeModCommand(request),
    onModCapabilityRequest: api.onModCapabilityRequest
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

const standaloneWorkbenchSmoke = new URLSearchParams(window.location.search).get("smoke") === "workbench";
const modApi = getModApi();
if (modApi && !standaloneWorkbenchSmoke) {
  modController = new ModController({ api: modApi, writing: controller, view: modView });
  openModsFolderButton.addEventListener("click", () => {
    void modController?.openFolder();
  });
  reloadModsButton.addEventListener("click", () => {
    void modController?.reload();
  });
  void modController.load();
} else {
  openModsFolderButton.disabled = true;
  reloadModsButton.disabled = true;
  modsStatus.dataset.state = "error";
  modsStatus.textContent = "Mod host unavailable";
}

let updateSmokeTextForSmoke: (() => void) | undefined;
const smokeQuery = new URLSearchParams(window.location.search).get("smoke");
const writingSmokeMode = smokeQuery === "writing";
const workspaceSmokeMode = smokeQuery === "workspace";
const quotationSmokeMode = smokeQuery === "quotation";
const repositorySmokeMode = smokeQuery === "repository";
const shelfSmokeMode = smokeQuery === "shelf";
const d5SmokeMode = smokeQuery === "d5" || smokeQuery === "d5-restore";
const exportSmokeMode = smokeQuery === "export";
const projectSmokeMode = smokeQuery === "project";
const projectRestoreSmokeMode = smokeQuery === "project-restore" || smokeQuery === "d5-restore";
const projectCreateSmokeMode = smokeQuery === "project-create";
const workbenchSmokeMode = smokeQuery === "workbench";
const smokeDecisionQueue: DirtySwitchDecision[] = [];
const legacyWorkspaceMode = workspaceSmokeMode || quotationSmokeMode || repositorySmokeMode;
const projectLikeSmokeMode = projectSmokeMode
  || projectRestoreSmokeMode
  || projectCreateSmokeMode
  || shelfSmokeMode
  || d5SmokeMode
  || exportSmokeMode;
openButton.textContent = writingSmokeMode ? "Open" : legacyWorkspaceMode ? "Open Document" : "Open Project";
repositoryNavigation.hidden = writingSmokeMode;
projectHeaderActions.hidden = writingSmokeMode || legacyWorkspaceMode;
projectNewMenu.hidden = true;
projectOverflowMenu.hidden = true;
projectInlineCreate.hidden = true;
projectCreateForm.hidden = true;

bindProjectMenuKeyboard(projectNewMenu, projectNewButton);
bindProjectMenuKeyboard(projectOverflowMenu, projectOverflowButton);
bindProjectMenuTriggerKeyboard(projectNewMenu, projectNewButton);
bindProjectMenuTriggerKeyboard(projectOverflowMenu, projectOverflowButton);

projectNewButton.addEventListener("click", () => {
  const open = Boolean(projectNewMenu.hidden);
  setProjectMenuOpen(projectOverflowMenu, projectOverflowButton, false);
  setProjectMenuOpen(projectNewMenu, projectNewButton, open);
  if (open) queueMicrotask(() => focusMenuItem(projectNewMenu, 0));
});

projectOverflowButton.addEventListener("click", () => {
  const open = Boolean(projectOverflowMenu.hidden);
  setProjectMenuOpen(projectNewMenu, projectNewButton, false);
  setProjectMenuOpen(projectOverflowMenu, projectOverflowButton, open);
  if (open) queueMicrotask(() => focusMenuItem(projectOverflowMenu, 0));
});

for (const button of projectNewMenu.querySelectorAll<HTMLButtonElement>("button[data-document-type]")) {
  button.addEventListener("click", () => {
    const value = button.dataset.documentType;
    if ((PROJECT_DOCUMENT_TYPES as readonly string[]).includes(value ?? "")) {
      beginProjectFileCreation(value as ProjectDocumentType);
    }
  });
}

projectCreateButton.addEventListener("click", () => {
  cancelProjectFileCreation(false);
  setProjectMenuOpen(projectOverflowMenu, projectOverflowButton, false);
  projectCreateForm.hidden = false;
  createProjectTitle.focus();
});

projectCreateCancelButton.addEventListener("click", () => cancelProjectCreation());
projectCreateFileCancelButton.addEventListener("click", () => cancelProjectFileCreation());

projectInlineCreate.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  cancelProjectFileCreation();
});

projectCreateForm.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  cancelProjectCreation();
});

projectNewMenu.addEventListener("keydown", (event) => {
  if (event.key === "Escape") event.stopPropagation();
});

projectOverflowMenu.addEventListener("keydown", (event) => {
  if (event.key === "Escape") event.stopPropagation();
});

document.addEventListener("pointerdown", (event) => {
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (projectNewMenu.contains(target) || projectOverflowMenu.contains(target)
    || projectNewButton.contains(target) || projectOverflowButton.contains(target)) return;
  setProjectMenuOpen(projectNewMenu, projectNewButton, false);
  setProjectMenuOpen(projectOverflowMenu, projectOverflowButton, false);
});

if (writingSmokeMode || workspaceSmokeMode || quotationSmokeMode || repositorySmokeMode || shelfSmokeMode || projectLikeSmokeMode) {
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
        : shelfSmokeMode
            ? "shelf"
            : projectLikeSmokeMode
              ? "project"
            : "repository";
  editorContainer.addEventListener("maginalia-smoke-append", (event) => {
    const text = (event as CustomEvent<string>).detail;
    if (typeof text === "string") surface.appendTextForSmoke(text);
  });
  editorContainer.addEventListener("maginalia-smoke-replace", (event) => {
    const text = (event as CustomEvent<string>).detail;
    if (typeof text === "string") controller.replaceText(text);
  });
  editorContainer.addEventListener("maginalia-smoke-focus", () => surface.focus());
  if (quotationSmokeMode || shelfSmokeMode) {
    editorContainer.addEventListener("maginalia-smoke-cursor-end", () => surface.setCursorToEndForSmoke());
  }
  surface.onTextChange(updateSmokeText);
  updateSmokeText();
}

if (workspaceSmokeMode || quotationSmokeMode || repositorySmokeMode || shelfSmokeMode || projectLikeSmokeMode) {
  window.addEventListener("maginalia-smoke-decision", (event) => {
    const decision = (event as CustomEvent<unknown>).detail;
    if (decision === "save" || decision === "discard" || decision === "cancel") {
      smokeDecisionQueue.push(decision);
    }
  });
  window.addEventListener("error", (event) => {
    const smokeLabel = quotationSmokeMode ? "Quotation" : repositorySmokeMode ? "Repository" : shelfSmokeMode ? "Shelf" : exportSmokeMode ? "Export" : projectLikeSmokeMode ? "Project" : "Workspace";
    console.error(`${smokeLabel} smoke page error: ${event.message}`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const smokeLabel = quotationSmokeMode ? "Quotation" : repositorySmokeMode ? "Repository" : shelfSmokeMode ? "Shelf" : exportSmokeMode ? "Export" : projectLikeSmokeMode ? "Project" : "Workspace";
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
      flushAllDocuments: flushAllAutosave,
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
    projectNewButton.disabled = true;
    projectOverflowButton.disabled = true;
    projectCreateButton.disabled = true;
    createProjectButton.disabled = true;
    newFileForm.querySelectorAll("input, select, button").forEach((element) => {
      (element as HTMLInputElement | HTMLSelectElement | HTMLButtonElement).disabled = true;
    });
  } else {
    projectController = new ProjectNavigationController({
      api: projectApi,
      writing: controller,
      view: projectView,
      // Central tabs keep each DocumentSession alive, so switching files is
      // activation and must not invoke the legacy replacement prompt.
      confirmDocumentSwitch: false,
      flushAllDocuments: flushAllAutosave,
      decideDirtySwitch: projectLikeSmokeMode
        ? () => smokeDecisionQueue.shift() ?? "cancel"
        : (context) => decideDirtySwitch(context, (message) => window.confirm(message))
    });
    if ((!projectLikeSmokeMode && !workbenchSmokeMode) || projectRestoreSmokeMode) {
      const restore = projectController.restoreProject();
      void restore.then(() => restorePersistedProjectViews());
    }
  }
}

if (projectController && !workbenchSmokeMode) {
  const load = window.maginalia.loadWorkspaceState;
  if (load) {
    void load().then((result) => {
      if (!("version" in result) || result.version !== 1) return;
      persistedWorkspaceState = result;
      void restorePersistedProjectViews();
    }).catch(() => undefined);
  }
  controller.onSessionChange((change) => {
    projectController?.syncOpenDocuments(change.views
      .filter((view) => view.region === "main" && view.groupId === "editor-group-1")
      .map((view) => view.documentId));
    projectController?.syncActiveDocument(change.activeDocumentId);
    void persistWorkspaceState();
  });
}

let libraryController: LibraryController | undefined;
const libraryApi = getLibraryApi();
if (libraryApi) {
  // Keep the local LibraryService path alive for repository-owned Shelf
  // activation and its privacy/legacy tests. Normal UI search is below.
  libraryController = new LibraryController({
    api: libraryApi,
    writing: controller,
    view: legacyLibraryView
  });
  chooseLibraryButton.addEventListener("click", () => {
    void libraryController?.openLibrary();
  });
} else {
  chooseLibraryButton.disabled = true;
}

let shelfController: ShelfController | undefined;
const shelfApi = getShelfApi();
if (!shelfApi) {
  libraryQuery.disabled = true;
  librarySearchButton.disabled = true;
  libraryStatus.textContent = "Shelf is unavailable.";
  libraryError.textContent = "Reviewer unavailable. Set MAGINALIA_REVIEWER_BASE_URL and start Reviewer.";
  libraryError.hidden = false;
} else {
  shelfController = new ShelfController({
    api: shelfApi,
    writing: controller,
    view: shelfView
  });
  libraryQuery.addEventListener("input", () => {
    if (legacyLibraryActive) {
      libraryController?.setQuery(libraryQuery.value);
    } else {
      shelfController?.setQuery(libraryQuery.value);
    }
  });
  librarySearchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (legacyLibraryActive) {
      void libraryController?.search();
    } else {
      void shelfController?.search();
    }
  });
}

const referencesView: ReferencesControllerView = {
  setReferencesState(state: ReferencesViewState): void {
    renderReferencesState(state);
  }
};

let referencesController: ReferencesController | undefined;
const referencesApi = getReferencesApi();
if (referencesApi) {
  referencesController = new ReferencesController({
    api: referencesApi,
    writing: controller,
    view: referencesView
  });
  refreshReferencesButton.addEventListener("click", () => {
    void referencesController?.refresh();
  });
} else {
  refreshReferencesButton.disabled = true;
  referencesStatus.dataset.state = "error";
  referencesStatus.textContent = "Reference refresh is unavailable.";
}

const exportView: ExportControllerView = {
  setExportState(state: ExportViewState): void {
    exportButton.disabled = !state.enabled;
    exportStatus.dataset.state = state.status;
    exportStatus.textContent = state.message;
  }
};

let exportController: ExportController | undefined;
const exportApi = getExportApi();
if (exportApi) {
  exportController = new ExportController({
    api: exportApi,
    writing: controller,
    view: exportView
  });
  exportButton.addEventListener("click", () => {
    void exportController?.exportMarkdown();
  });
} else {
  exportButton.disabled = true;
  exportStatus.dataset.state = "error";
  exportStatus.textContent = "Markdown export is unavailable.";
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
    setProjectMenuOpen(projectOverflowMenu, projectOverflowButton, false);
    void projectController?.openProject();
  });
}

newFileTitle.addEventListener("input", () => {
  if (!selectedProjectDocumentType) return;
  const names = projectController?.getState().files.map((file) => file.displayName) ?? [];
  newFileName.value = createProjectFileName(newFileTitle.value, selectedProjectDocumentType, names);
});

newFileTitle.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || !selectedProjectDocumentType) return;
  event.preventDefault();
  newFileForm.requestSubmit();
});

projectCreateForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!projectController) return;
  const previousProjectId = projectController.getState().project?.projectId;
  void projectController.createProject(createProjectTitle.value).then(() => {
    const project = projectController?.getState().project;
    if (project && project.projectId !== previousProjectId) cancelProjectCreation(false);
  });
});

newFileForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!projectController) return;
  const documentType = selectedProjectDocumentType ?? newFileType.value as ProjectDocumentType;
  const fileName = selectedProjectDocumentType
    ? createProjectFileName(
      newFileTitle.value,
      selectedProjectDocumentType,
      projectController.getState().files.map((file) => file.displayName)
    )
    : newFileName.value;
  newFileName.value = fileName;
  void projectController.createFile({ fileName, title: newFileTitle.value, documentType }).then(() => {
    if (selectedProjectDocumentType && projectController?.getState().files.some((file) => file.displayName === fileName)) {
      cancelProjectFileCreation(false);
    }
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
