import { randomUUID } from "node:crypto";
import { lstat, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { MAX_MARKDOWN_BYTES } from "./markdown-ipc";
import type { MarkdownFileService, MarkdownSessionInfo } from "./markdown-file-service";
import type { ReviewerResolutionResult } from "./reviewer-resolution";
export { RESOLVE_EXPORT_CHANNEL, WRITE_EXPORT_CHANNEL } from "./export-contract";

export const MAX_EXPORT_TEXT_CHARS = MAX_MARKDOWN_BYTES;

export interface ExportDocumentSnapshot {
  readonly documentId: string;
  readonly revision: number;
  readonly currentText: string;
}

export interface ResolveExportRequest extends ExportDocumentSnapshot {}

export interface ResolveExportSuccess {
  readonly kind: "resolved";
  /** Opaque main-process transaction handle required by writeExport. */
  readonly exportId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly resolution: ReviewerResolutionResult;
}

export type ExportResolutionFailureCode =
  | "invalid-request"
  | "session-not-owned"
  | "content-too-large"
  | "resolution-failed";

export interface ExportResolutionFailure {
  readonly kind: "error";
  readonly code: ExportResolutionFailureCode;
  readonly message: string;
}

export type ResolveExportResult = ResolveExportSuccess | ExportResolutionFailure;

export interface WriteExportRequest {
  readonly exportId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly text: string;
}

export interface ExportCancelled {
  readonly kind: "cancelled";
}

export type ExportWriteFailureCode =
  | "invalid-request"
  | "session-not-owned"
  | "stale-export"
  | "content-too-large"
  | "invalid-output"
  | "source-overwrite"
  | "dialog-failed"
  | "write-failed";

export interface ExportWriteFailure {
  readonly kind: "error";
  readonly code: ExportWriteFailureCode;
  readonly message: string;
}

export interface ExportWriteSuccess {
  readonly kind: "exported";
  readonly fileName: string;
}

export type WriteExportResult = ExportWriteSuccess | ExportCancelled | ExportWriteFailure;

export interface ExportInvokeEvent {
  readonly sender: object;
}

export interface ExportSaveDialogResult {
  readonly canceled: boolean;
  readonly filePath?: string;
}

export interface ExportHandlers {
  readonly resolveExport: (
    event: ExportInvokeEvent,
    request: unknown,
    ...args: readonly unknown[]
  ) => Promise<ResolveExportResult>;
  readonly writeExport: (
    event: ExportInvokeEvent,
    request: unknown,
    ...args: readonly unknown[]
  ) => Promise<WriteExportResult>;
}

export interface ExportHandlerDependencies {
  readonly sessions: MarkdownFileService;
  readonly resolve: (owner: object, text: string) => ReviewerResolutionResult | Promise<ReviewerResolutionResult>;
  readonly showSaveDialog: (
    defaultPath: string,
    event: ExportInvokeEvent
  ) => ExportSaveDialogResult | Promise<ExportSaveDialogResult>;
}

interface PendingExport {
  readonly owner: object;
  readonly sessionId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly currentText: string;
  readonly session: MarkdownSessionInfo;
}

const INVALID_RESOLVE_REQUEST: ExportResolutionFailure = Object.freeze({
  kind: "error",
  code: "invalid-request",
  message: "The Markdown export request was invalid."
});

const INVALID_WRITE_REQUEST: ExportWriteFailure = Object.freeze({
  kind: "error",
  code: "invalid-request",
  message: "The Markdown export write request was invalid."
});

const SESSION_NOT_OWNED: ExportResolutionFailure = Object.freeze({
  kind: "error",
  code: "session-not-owned",
  message: "That Markdown document is not open in this window. Open it again before exporting."
});

const SESSION_NOT_OWNED_WRITE: ExportWriteFailure = Object.freeze({
  kind: "error",
  code: "session-not-owned",
  message: "That Markdown document is not open in this window. Open it again before exporting."
});

const CONTENT_TOO_LARGE: ExportResolutionFailure = Object.freeze({
  kind: "error",
  code: "content-too-large",
  message: `The Markdown content must be no larger than ${MAX_MARKDOWN_BYTES.toLocaleString()} bytes.`
});

const CONTENT_TOO_LARGE_WRITE: ExportWriteFailure = Object.freeze({
  kind: "error",
  code: "content-too-large",
  message: `The exported Markdown must be no larger than ${MAX_MARKDOWN_BYTES.toLocaleString()} bytes.`
});

const STALE_EXPORT: ExportWriteFailure = Object.freeze({
  kind: "error",
  code: "stale-export",
  message: "The export snapshot is no longer available. Start Export Markdown again."
});

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  try {
    const keys = Reflect.ownKeys(value);
    return keys.length === expected.length
      && keys.every((key) => typeof key === "string" && expected.includes(key));
  } catch {
    return false;
  }
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isResolveExportRequest(value: unknown): value is ResolveExportRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ["documentId", "revision", "currentText"])
    && typeof value.documentId === "string"
    && value.documentId.length > 0
    && isRevision(value.revision)
    && typeof value.currentText === "string"
    && value.currentText.length <= MAX_EXPORT_TEXT_CHARS;
}

export function isWriteExportRequest(value: unknown): value is WriteExportRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ["exportId", "documentId", "revision", "text"])
    && typeof value.exportId === "string"
    && value.exportId.length > 0
    && typeof value.documentId === "string"
    && value.documentId.length > 0
    && isRevision(value.revision)
    && typeof value.text === "string"
    && value.text.length <= MAX_EXPORT_TEXT_CHARS;
}

function bytesTooLarge(text: string): boolean {
  return Buffer.byteLength(text, "utf8") > MAX_MARKDOWN_BYTES;
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  const value = (error as { readonly code?: unknown }).code;
  return typeof value === "string" ? value : undefined;
}

function pathForCompare(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function canonicalPath(value: string): Promise<string> {
  const resolved = path.resolve(value);
  try {
    return pathForCompare(await realpath(resolved));
  } catch {
    try {
      const parent = await realpath(path.dirname(resolved));
      return pathForCompare(path.join(parent, path.basename(resolved)));
    } catch {
      return pathForCompare(resolved);
    }
  }
}

async function sameFile(left: string, right: string): Promise<boolean> {
  if (pathForCompare(left) === pathForCompare(right)) return true;
  const [leftCanonical, rightCanonical] = await Promise.all([canonicalPath(left), canonicalPath(right)]);
  if (leftCanonical === rightCanonical) return true;

  try {
    const [leftStat, rightStat] = await Promise.all([stat(left), stat(right)]);
    return leftStat.dev !== 0 && rightStat.dev !== 0
      && leftStat.ino !== 0 && rightStat.ino !== 0
      && leftStat.dev === rightStat.dev
      && leftStat.ino === rightStat.ino;
  } catch {
    return false;
  }
}

function defaultExportPath(session: MarkdownSessionInfo): string {
  const extension = path.extname(session.filePath);
  const base = path.basename(session.filePath, extension);
  return path.join(path.dirname(session.filePath), `${base}.resolved.md`);
}

async function atomicWrite(filePath: string, text: string): Promise<void> {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.maginalia-${randomUUID()}.tmp`
  );
  let temporaryCreated = false;
  try {
    await writeFile(temporaryPath, Buffer.from(text, "utf8"), { flag: "wx" });
    temporaryCreated = true;
    try {
      await rename(temporaryPath, filePath);
      temporaryCreated = false;
    } catch (error: unknown) {
      // Node's Windows rename may refuse to replace an existing file.  The
      // destination was explicitly chosen in the save dialog; remove only
      // that chosen regular file, then complete the same-directory replace.
      if (errorCode(error) !== "EEXIST" && errorCode(error) !== "EPERM" && errorCode(error) !== "ENOTEMPTY") {
        throw error;
      }
      const destination = await lstat(filePath);
      if (!destination.isFile()) throw error;
      await rm(filePath, { force: false });
      await rename(temporaryPath, filePath);
      temporaryCreated = false;
    }
  } finally {
    if (temporaryCreated) {
      try {
        await unlink(temporaryPath);
      } catch {
        // Best-effort cleanup must not mask the original export result.
      }
    }
  }
}

function resolutionFailure(message: string): ExportResolutionFailure {
  return Object.freeze({ kind: "error", code: "resolution-failed", message });
}

/** Main-process export transaction and filesystem boundary. */
export class ExportService {
  private readonly pendingByOwner = new WeakMap<object, Map<string, PendingExport>>();

  public constructor(private readonly dependencies: ExportHandlerDependencies) {}

  public async resolveForOwner(
    owner: object,
    request: ResolveExportRequest
  ): Promise<ResolveExportResult> {
    if (bytesTooLarge(request.currentText)) return CONTENT_TOO_LARGE;
    const session = this.dependencies.sessions.getSessionInfoForOwner(owner, request.documentId);
    if (session === null) return SESSION_NOT_OWNED;

    let resolution: ReviewerResolutionResult;
    try {
      resolution = await this.dependencies.resolve(owner, request.currentText);
    } catch {
      return resolutionFailure("Quotation resolution failed. The Markdown was not exported.");
    }

    const exportId = randomUUID();
    let pending = this.pendingByOwner.get(owner);
    if (pending === undefined) {
      pending = new Map<string, PendingExport>();
      this.pendingByOwner.set(owner, pending);
    }
    pending.set(exportId, {
      owner,
      sessionId: request.documentId,
      documentId: request.documentId,
      revision: request.revision,
      currentText: request.currentText,
      session
    });
    return Object.freeze({
      kind: "resolved",
      exportId,
      documentId: request.documentId,
      revision: request.revision,
      resolution
    });
  }

  public async writeForOwner(
    owner: object,
    request: WriteExportRequest,
    event: ExportInvokeEvent
  ): Promise<WriteExportResult> {
    const pending = this.pendingByOwner.get(owner)?.get(request.exportId);
    if (pending === undefined
      || pending.owner !== owner
      || pending.documentId !== request.documentId
      || pending.revision !== request.revision
      || pending.sessionId !== request.documentId) {
      return STALE_EXPORT;
    }

    const session = this.dependencies.sessions.getSessionInfoForOwner(owner, request.documentId);
    if (session === null || session.filePath !== pending.session.filePath) return SESSION_NOT_OWNED_WRITE;
    if (bytesTooLarge(request.text)) return CONTENT_TOO_LARGE_WRITE;

    let dialogResult: ExportSaveDialogResult;
    try {
      dialogResult = await this.dependencies.showSaveDialog(defaultExportPath(session), event);
    } catch {
      return {
        kind: "error",
        code: "dialog-failed",
        message: "The Export Markdown dialog could not be opened."
      };
    }
    if (dialogResult.canceled || dialogResult.filePath === undefined) {
      this.pendingByOwner.get(owner)?.delete(request.exportId);
      return { kind: "cancelled" };
    }

    const outputPath = dialogResult.filePath;
    if (!path.isAbsolute(outputPath) || path.extname(outputPath).toLowerCase() !== ".md") {
      return {
        kind: "error",
        code: "invalid-output",
        message: "Choose an absolute output path ending in .md."
      };
    }
    if (await sameFile(session.filePath, outputPath)) {
      return {
        kind: "error",
        code: "source-overwrite",
        message: "The exported Markdown cannot overwrite the authoring document."
      };
    }

    try {
      await atomicWrite(outputPath, request.text);
    } catch {
      return {
        kind: "error",
        code: "write-failed",
        message: "The exported Markdown could not be written. Check the destination and try again."
      };
    }
    this.pendingByOwner.get(owner)?.delete(request.exportId);
    return { kind: "exported", fileName: path.basename(outputPath) };
  }

  public dispose(): void {
    // WeakMap entries disappear with their renderer owner.  The explicit
    // method documents lifecycle ownership and keeps future cleanup options
    // available without exposing pending paths to the renderer.
  }
}

export function createExportHandlers(dependencies: ExportHandlerDependencies): ExportHandlers {
  const service = new ExportService(dependencies);
  return {
    resolveExport: async (event, request, ...args) => {
      if (args.length !== 0 || !isResolveExportRequest(request)) return INVALID_RESOLVE_REQUEST;
      return service.resolveForOwner(event.sender, request);
    },
    writeExport: async (event, request, ...args) => {
      if (args.length !== 0 || !isWriteExportRequest(request)) return INVALID_WRITE_REQUEST;
      return service.writeForOwner(event.sender, request, event);
    }
  };
}
