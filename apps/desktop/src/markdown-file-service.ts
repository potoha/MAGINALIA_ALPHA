import { randomUUID } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import {
  MAX_MARKDOWN_BYTES,
  type MarkdownConflict,
  type MarkdownFailure,
  type OpenMarkdownResult,
  type SaveMarkdownRequest,
  type SaveMarkdownResult
} from "./markdown-ipc";

interface MarkdownSession {
  readonly sessionId: string;
  readonly owner: object;
  readonly filePath: string;
  readonly displayName: string;
  /** Main-process-only Project association used to authorize Project assets during export. */
  projectId?: string;
  savedText: string;
}

/** Main-process-only identity and path for an owner-bound Markdown session. */
export interface MarkdownSessionInfo {
  readonly sessionId: string;
  readonly displayName: string;
  readonly filePath: string;
  /** Opaque owner-bound Project ID; never returned through renderer IPC. */
  readonly projectId?: string;
}

interface ReadMarkdownSuccess {
  readonly kind: "read";
  readonly text: string;
}

type ReadMarkdownResult = ReadMarkdownSuccess | MarkdownFailure;

const INVALID_EXTENSION: MarkdownFailure = {
  kind: "error",
  code: "invalid-extension",
  message: "Choose a Markdown file ending in .md or .markdown."
};

const NOT_REGULAR_FILE: MarkdownFailure = {
  kind: "error",
  code: "not-regular-file",
  message: "The selected Markdown path is not a regular file."
};

const FILE_TOO_LARGE: MarkdownFailure = {
  kind: "error",
  code: "file-too-large",
  message: `The Markdown file must be no larger than ${MAX_MARKDOWN_BYTES.toLocaleString()} bytes.`
};

const MISSING_FILE: MarkdownFailure = {
  kind: "error",
  code: "missing-file",
  message: "The Markdown file is no longer available. Choose it again."
};

const FILE_UNREADABLE: MarkdownFailure = {
  kind: "error",
  code: "file-unreadable",
  message: "The Markdown file could not be read. Check its permissions and try again."
};

const SESSION_NOT_OWNED: MarkdownFailure = {
  kind: "error",
  code: "session-not-owned",
  message: "That Markdown document is not open in this window. Open it again before saving."
};

const CONTENT_TOO_LARGE: MarkdownFailure = {
  kind: "error",
  code: "content-too-large",
  message: `The Markdown content must be no larger than ${MAX_MARKDOWN_BYTES.toLocaleString()} UTF-8 bytes.`
};

const SAVE_FAILED: MarkdownFailure = {
  kind: "error",
  code: "save-failed",
  message: "The Markdown file could not be saved. Check its permissions and try again."
};

const EXTERNAL_CHANGE: MarkdownConflict = {
  kind: "conflict",
  code: "external-change",
  message: "The Markdown file changed outside MAGINALIA. Reload it before saving."
};

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isMarkdownPath(filePath: string): boolean {
  const extension = path.extname(filePath).toLocaleLowerCase();
  return extension === ".md" || extension === ".markdown";
}

async function readMarkdown(filePath: string): Promise<ReadMarkdownResult> {
  let fileStats: Awaited<ReturnType<typeof lstat>>;
  try {
    fileStats = await lstat(filePath);
  } catch (error: unknown) {
    return errorCode(error) === "ENOENT" ? MISSING_FILE : FILE_UNREADABLE;
  }

  if (!fileStats.isFile()) return NOT_REGULAR_FILE;
  if (fileStats.size > MAX_MARKDOWN_BYTES) return FILE_TOO_LARGE;

  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (error: unknown) {
    return errorCode(error) === "ENOENT" ? MISSING_FILE : FILE_UNREADABLE;
  }

  if (bytes.byteLength > MAX_MARKDOWN_BYTES) return FILE_TOO_LARGE;
  return { kind: "read", text: bytes.toString("utf8") };
}

export class MarkdownFileService {
  private readonly sessions = new Map<string, MarkdownSession>();
  private owners = new Map<object, Map<string, MarkdownSession>>();
  private readonly saveQueues = new Map<string, Promise<SaveMarkdownResult>>();

  public async openForOwner(owner: object, filePath: string, projectId?: string): Promise<OpenMarkdownResult> {
    if (!isMarkdownPath(filePath)) return INVALID_EXTENSION;

    const readResult = await readMarkdown(filePath);
    if (readResult.kind !== "read") return readResult;

    let ownerSessions = this.owners.get(owner);
    if (ownerSessions === undefined) {
      ownerSessions = new Map<string, MarkdownSession>();
      this.owners.set(owner, ownerSessions);
    }
    // Opening the same path again is activation, not replacement. Keeping a
    // stable host session lets the renderer switch tabs without losing its
    // DocumentSession's unsaved text or creating duplicate save baselines.
    const existing = ownerSessions.get(filePath);
    if (existing !== undefined) {
      // A generic file open may precede a Project navigation. Upgrade that
      // main-process session with the Project ID supplied only after
      // ProjectService has resolved the file through the owner's workspace.
      // Never replace an existing association with another Project ID.
      if (existing.projectId === undefined && projectId !== undefined) existing.projectId = projectId;
      return {
        kind: "opened",
        sessionId: existing.sessionId,
        displayName: existing.displayName,
        text: existing.savedText
      };
    }

    const session: MarkdownSession = {
      sessionId: randomUUID(),
      owner,
      filePath,
      displayName: path.basename(filePath),
      ...(projectId === undefined ? {} : { projectId }),
      savedText: readResult.text
    };
    ownerSessions.set(filePath, session);
    this.sessions.set(session.sessionId, session);

    return {
      kind: "opened",
      sessionId: session.sessionId,
      displayName: session.displayName,
      text: readResult.text
    };
  }

  public saveForOwner(owner: object, request: SaveMarkdownRequest): Promise<SaveMarkdownResult> {
    const session = this.sessions.get(request.sessionId);
    if (!session || session.owner !== owner) return Promise.resolve(SESSION_NOT_OWNED);

    const previous = this.saveQueues.get(session.sessionId);
    const operation = (previous ? previous.catch(() => undefined) : Promise.resolve(undefined))
      .then(() => this.performSave(session, request));
    const tracked = operation.finally(() => {
      if (this.saveQueues.get(session.sessionId) === tracked) this.saveQueues.delete(session.sessionId);
    });
    this.saveQueues.set(session.sessionId, tracked);
    return tracked;
  }

  /**
   * Resolve an opaque renderer session to its main-process-owned file path.
   * This method is intentionally not exposed through preload; it exists only
   * for other main-process services such as resolved Markdown export.
   */
  public getSessionInfoForOwner(owner: object, sessionId: string): MarkdownSessionInfo | null {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.owner !== owner) return null;
    return Object.freeze({
      sessionId: session.sessionId,
      displayName: session.displayName,
      filePath: session.filePath,
      ...(session.projectId === undefined ? {} : { projectId: session.projectId })
    });
  }

  public dispose(): void {
    this.sessions.clear();
    this.owners = new Map<object, Map<string, MarkdownSession>>();
    this.saveQueues.clear();
  }

  private async performSave(session: MarkdownSession, request: SaveMarkdownRequest): Promise<SaveMarkdownResult> {
    if (Buffer.byteLength(request.text, "utf8") > MAX_MARKDOWN_BYTES) return CONTENT_TOO_LARGE;

    const current = await readMarkdown(session.filePath);
    if (current.kind === "error") {
      return current;
    }
    if (current.text !== session.savedText) {
      return EXTERNAL_CHANGE;
    }

    try {
      await writeFile(session.filePath, Buffer.from(request.text, "utf8"));
    } catch (_error: unknown) {
      return SAVE_FAILED;
    }

    session.savedText = request.text;
    return {
      kind: "saved",
      sessionId: session.sessionId,
      displayName: session.displayName,
      text: request.text
    };
  }
}
