import type { DocumentState } from "@maginalia/writing-core";
import type {
  ResolveExportRequest,
  ResolveExportResult,
  WriteExportRequest,
  WriteExportResult
} from "../export-ipc";
import { renderResolvedMarkdown } from "./export-renderer";

export interface ExportControllerApi {
  resolveExport(request: ResolveExportRequest): Promise<ResolveExportResult>;
  writeExport(request: WriteExportRequest): Promise<WriteExportResult>;
}

export interface ExportWritingPort {
  getDocumentState(): (DocumentState & { readonly revision: number }) | null;
  onDocumentChange(listener: (document: DocumentState | null) => void): () => void;
}

export type ExportViewStatus = "empty" | "ready" | "exporting" | "success" | "cancelled" | "error";

export interface ExportViewState {
  readonly status: ExportViewStatus;
  readonly message: string;
  readonly enabled: boolean;
}

export interface ExportControllerView {
  setExportState(state: ExportViewState): void;
}

export interface ExportControllerOptions {
  readonly api: ExportControllerApi;
  readonly writing: ExportWritingPort;
  readonly view: ExportControllerView;
}

const EMPTY_STATE: ExportViewState = Object.freeze({
  status: "empty",
  message: "Open a document to export.",
  enabled: false
});

const READY_STATE: ExportViewState = Object.freeze({
  status: "ready",
  message: "Ready to export Markdown.",
  enabled: true
});

const EXPORTING_STATE: ExportViewState = Object.freeze({
  status: "exporting",
  message: "Exporting Markdown…",
  enabled: false
});

const RESOLUTION_FAILED = "Export failed. The authoring document was not changed.";
const RENDER_FAILED = "Export could not render the Markdown. The authoring document was not changed.";
const WRITE_FAILED = "Export failed. The authoring document was not changed.";

function copyState(state: ExportViewState): ExportViewState {
  return Object.freeze({ ...state });
}

/**
 * Coordinates the renderer-side export projection without owning editor,
 * dialog, or filesystem state.  The document snapshot is captured before
 * the first asynchronous boundary so tab changes cannot mix documents into
 * an in-flight export.
 */
export class ExportController {
  private readonly api: ExportControllerApi;
  private readonly writing: ExportWritingPort;
  private readonly view: ExportControllerView;
  private readonly removeDocumentListener: () => void;
  private state: ExportViewState;
  private exporting = false;

  public constructor(options: ExportControllerOptions) {
    this.api = options.api;
    this.writing = options.writing;
    this.view = options.view;
    this.state = this.writing.getDocumentState() === null ? EMPTY_STATE : READY_STATE;
    this.removeDocumentListener = this.writing.onDocumentChange((document) => {
      // The in-flight operation intentionally keeps its original snapshot and
      // status while the user switches tabs or closes another document.
      if (this.exporting) return;
      this.setState(document === null ? EMPTY_STATE : READY_STATE);
    });
    this.view.setExportState(this.state);
  }

  public getState(): ExportViewState {
    return copyState(this.state);
  }

  public async exportMarkdown(): Promise<void> {
    if (this.exporting) return;

    const document = this.writing.getDocumentState();
    if (document === null) {
      this.setState(EMPTY_STATE);
      return;
    }

    // Keep this object immutable and detached from the live DocumentSession.
    // The main process validates the same semantic snapshot before resolving.
    const snapshot: ResolveExportRequest = Object.freeze({
      documentId: document.documentId,
      revision: document.revision,
      currentText: document.currentText
    });

    this.exporting = true;
    this.setState(EXPORTING_STATE);

    let resolved: ResolveExportResult;
    try {
      resolved = await this.api.resolveExport(snapshot);
    } catch {
      this.finish({
        status: "error",
        message: RESOLUTION_FAILED,
        enabled: true
      });
      return;
    }

    if (resolved.kind === "error") {
      this.finish({
        status: "error",
        message: resolved.message,
        enabled: true
      });
      return;
    }

    let rendered;
    try {
      rendered = renderResolvedMarkdown(snapshot, resolved.resolution);
    } catch {
      this.finish({
        status: "error",
        message: RENDER_FAILED,
        enabled: true
      });
      return;
    }

    if (rendered.kind === "blocked") {
      this.finish({
        status: "error",
        message: rendered.message,
        enabled: true
      });
      return;
    }

    const writeRequest: WriteExportRequest = Object.freeze({
      exportId: resolved.exportId,
      documentId: snapshot.documentId,
      revision: snapshot.revision,
      text: rendered.text
    });

    let written: WriteExportResult;
    try {
      written = await this.api.writeExport(writeRequest);
    } catch {
      this.finish({
        status: "error",
        message: WRITE_FAILED,
        enabled: true
      });
      return;
    }

    if (written.kind === "exported") {
      this.finish({
        status: "success",
        message: `Exported Markdown: ${written.fileName}`,
        enabled: true
      });
    } else if (written.kind === "cancelled") {
      this.finish({
        status: "cancelled",
        message: "Export canceled.",
        enabled: true
      });
    } else {
      this.finish({
        status: "error",
        message: written.message,
        enabled: true
      });
    }
  }

  public dispose(): void {
    this.removeDocumentListener();
  }

  private finish(state: ExportViewState): void {
    this.exporting = false;
    // The operation used its captured snapshot, but availability after it
    // completes follows the current active session rather than the snapshot.
    const current = this.writing.getDocumentState();
    this.setState({
      ...state,
      enabled: current !== null
    });
  }

  private setState(state: ExportViewState): void {
    this.state = copyState(state);
    this.view.setExportState(this.state);
  }
}
