import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir, realpath, writeFile } from "node:fs/promises";
import * as path from "node:path";

export interface DocumentSummary {
  readonly documentId: string;
  readonly displayName: string;
}

export interface ManuscriptSummary {
  readonly manuscriptId: string;
  readonly displayName: string;
}

export interface DocumentWorkspaceOpened {
  readonly kind: "opened";
  readonly document: DocumentSummary;
  readonly manuscripts: readonly ManuscriptSummary[];
}

export type DocumentWorkspaceFailureCode =
  | "invalid-owner"
  | "invalid-root"
  | "root-missing"
  | "root-not-directory"
  | "root-unreadable"
  | "invalid-document-id"
  | "document-not-owned"
  | "invalid-manuscript-name"
  | "manuscript-exists"
  | "manuscript-create-failed"
  | "invalid-manuscript-id"
  | "manuscript-not-owned"
  | "manuscript-unavailable";

export interface DocumentWorkspaceFailure {
  readonly kind: "error";
  readonly code: DocumentWorkspaceFailureCode;
  readonly message: string;
}

export type DocumentWorkspaceResult = DocumentWorkspaceOpened | DocumentWorkspaceFailure;

/**
 * This result is intentionally main-process-only. It is never part of the
 * renderer-facing document summary returned by openForOwner.
 */
export interface ResolvedManuscriptPath {
  readonly kind: "resolved";
  readonly canonicalPath: string;
}

export type ResolveManuscriptPathResult = ResolvedManuscriptPath | DocumentWorkspaceFailure;

/** Main-process-only root handle used by the Project adapter. */
export interface ResolvedDocumentRoot {
  readonly kind: "resolved";
  readonly canonicalRoot: string;
}

export type ResolveDocumentRootResult = ResolvedDocumentRoot | DocumentWorkspaceFailure;

export interface CreatedManuscript {
  readonly kind: "created";
  readonly document: DocumentSummary;
  readonly manuscript: ManuscriptSummary;
}

export type CreateManuscriptResult = CreatedManuscript | DocumentWorkspaceFailure;

interface ManuscriptRecord extends ManuscriptSummary {
  readonly canonicalPath: string;
}

interface DocumentRecord extends DocumentSummary {
  readonly owner: object;
  readonly canonicalRoot: string;
  readonly manuscripts: ReadonlyMap<string, ManuscriptRecord>;
}

const INVALID_OWNER: DocumentWorkspaceFailure = {
  kind: "error",
  code: "invalid-owner",
  message: "The Document owner is invalid."
};

const INVALID_ROOT: DocumentWorkspaceFailure = {
  kind: "error",
  code: "invalid-root",
  message: "Choose an absolute Document folder."
};

const ROOT_MISSING: DocumentWorkspaceFailure = {
  kind: "error",
  code: "root-missing",
  message: "The Document folder is no longer available. Choose it again."
};

const ROOT_NOT_DIRECTORY: DocumentWorkspaceFailure = {
  kind: "error",
  code: "root-not-directory",
  message: "The selected Document root is not a directory."
};

const ROOT_UNREADABLE: DocumentWorkspaceFailure = {
  kind: "error",
  code: "root-unreadable",
  message: "The Document folder could not be read. Check its permissions and try again."
};

const DOCUMENT_NOT_OWNED: DocumentWorkspaceFailure = {
  kind: "error",
  code: "document-not-owned",
  message: "That Document is not open for this owner."
};

const MANUSCRIPT_NOT_OWNED: DocumentWorkspaceFailure = {
  kind: "error",
  code: "manuscript-not-owned",
  message: "That manuscript is not open for this Document owner."
};

const MANUSCRIPT_UNAVAILABLE: DocumentWorkspaceFailure = {
  kind: "error",
  code: "manuscript-unavailable",
  message: "The selected Markdown manuscript is no longer available."
};

const INVALID_MANUSCRIPT_NAME: DocumentWorkspaceFailure = {
  kind: "error",
  code: "invalid-manuscript-name",
  message: "Use a Markdown file name without path separators or reserved characters."
};

const MANUSCRIPT_EXISTS: DocumentWorkspaceFailure = {
  kind: "error",
  code: "manuscript-exists",
  message: "A Markdown file with that name already exists. Choose another name."
};

const MANUSCRIPT_CREATE_FAILED: DocumentWorkspaceFailure = {
  kind: "error",
  code: "manuscript-create-failed",
  message: "The Markdown file could not be created. Check the Project folder permissions and try again."
};

const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isOwner(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID.test(value);
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function rootFailure(error: unknown): DocumentWorkspaceFailure {
  switch (errorCode(error)) {
    case "ENOENT":
      return ROOT_MISSING;
    case "ENOTDIR":
      return ROOT_NOT_DIRECTORY;
    default:
      return ROOT_UNREADABLE;
  }
}

function manuscriptFailure(): DocumentWorkspaceFailure {
  return MANUSCRIPT_UNAVAILABLE;
}

function isMarkdownName(name: string): boolean {
  const extension = path.extname(name).toLowerCase();
  return extension === ".md" || extension === ".markdown";
}

function isSafeManuscriptName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const name = value.trim();
  return name.length > 0
    && name !== "."
    && name !== ".."
    && !/[<>:"/\\|?*\u0000-\u001f]/u.test(name)
    && !/[. ]$/u.test(name)
    && /\.(?:md|markdown)$/iu.test(name);
}

function compareNames(left: string, right: string): number {
  const leftLower = left.toLowerCase();
  const rightLower = right.toLowerCase();
  if (leftLower < rightLower) return -1;
  if (leftLower > rightLower) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function manuscriptPriority(name: string): number {
  switch (name.toLowerCase()) {
    case "manuscript.md":
      return 0;
    case "manuscript.markdown":
      return 1;
    default:
      return 2;
  }
}

function compareManuscripts(left: { name: string }, right: { name: string }): number {
  const priorityDifference = manuscriptPriority(left.name) - manuscriptPriority(right.name);
  return priorityDifference === 0 ? compareNames(left.name, right.name) : priorityDifference;
}

function isDirectChild(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath.length > 0
    && relativePath !== ".."
    && !relativePath.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativePath)
    && !relativePath.includes(path.sep);
}

async function listManuscriptEntries(canonicalRoot: string): Promise<Dirent[]> {
  const entries = await readdir(canonicalRoot, { withFileTypes: true, encoding: "utf8" });
  return entries
    .filter((entry) => !entry.name.startsWith("."))
    .filter((entry) => entry.isFile())
    .filter((entry) => !entry.isSymbolicLink())
    .filter((entry) => isMarkdownName(entry.name))
    .sort(compareManuscripts);
}

export class DocumentWorkspaceService {
  private readonly documents = new Map<string, DocumentRecord>();
  private readonly owners = new Map<object, DocumentRecord>();

  /**
   * Canonicalize and retain one selected Document root for this owner. The
   * returned value contains only opaque IDs and display names.
   */
  public async openForOwner(owner: unknown, rootPath: unknown): Promise<DocumentWorkspaceResult> {
    if (!isOwner(owner)) return INVALID_OWNER;
    if (typeof rootPath !== "string" || rootPath.length === 0 || !path.isAbsolute(rootPath)) {
      return INVALID_ROOT;
    }

    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(rootPath);
    } catch (error: unknown) {
      return rootFailure(error);
    }

    let rootStats: Awaited<ReturnType<typeof lstat>>;
    try {
      rootStats = await lstat(canonicalRoot);
    } catch (error: unknown) {
      return rootFailure(error);
    }
    if (!rootStats.isDirectory()) return ROOT_NOT_DIRECTORY;

    let entries: Dirent[];
    try {
      entries = await listManuscriptEntries(canonicalRoot);
    } catch (error: unknown) {
      return rootFailure(error);
    }

    const documentId = randomUUID();
    const manuscriptRecords = entries.map((entry): ManuscriptRecord => ({
      manuscriptId: randomUUID(),
      displayName: entry.name,
      canonicalPath: path.join(canonicalRoot, entry.name)
    }));
    const manuscripts = new Map(
      manuscriptRecords.map((manuscript) => [manuscript.manuscriptId, manuscript] as const)
    );
    const document: DocumentRecord = {
      documentId,
      displayName: path.basename(canonicalRoot) || "Document",
      owner,
      canonicalRoot,
      manuscripts
    };

    const previous = this.owners.get(owner);
    if (previous) this.documents.delete(previous.documentId);
    this.owners.set(owner, document);
    this.documents.set(document.documentId, document);

    return {
      kind: "opened",
      document: {
        documentId: document.documentId,
        displayName: document.displayName
      },
      manuscripts: manuscriptRecords.map(({ manuscriptId, displayName }) => ({
        manuscriptId,
        displayName
      }))
    };
  }

  /** Main-process-only root handle used by the Project adapter. */
  public async resolveDocumentRoot(owner: unknown, documentId: unknown): Promise<ResolveDocumentRootResult> {
    const document = this.findDocument(owner, documentId);
    if ("kind" in document) return document;
    try {
      const currentRoot = await realpath(document.canonicalRoot);
      const rootStats = await lstat(currentRoot);
      if (currentRoot !== document.canonicalRoot || !rootStats.isDirectory() || rootStats.isSymbolicLink()) {
        return ROOT_UNREADABLE;
      }
      return { kind: "resolved", canonicalRoot: currentRoot };
    } catch (error: unknown) {
      return rootFailure(error);
    }
  }

  /** Refresh the root-level Markdown registry while retaining existing IDs. */
  public async refreshForOwner(owner: unknown, documentId: unknown): Promise<DocumentWorkspaceResult> {
    const document = this.findDocument(owner, documentId);
    if ("kind" in document) return document;

    let entries: Dirent[];
    try {
      const root = await this.resolveDocumentRoot(owner, documentId);
      if (root.kind !== "resolved") return root;
      entries = await listManuscriptEntries(root.canonicalRoot);
    } catch (error: unknown) {
      return rootFailure(error);
    }

    const previousByName = new Map(
      [...document.manuscripts.values()].map((manuscript) => [manuscript.displayName, manuscript] as const)
    );
    const manuscriptRecords = entries.map((entry): ManuscriptRecord => {
      const previous = previousByName.get(entry.name);
      return previous ?? {
        manuscriptId: randomUUID(),
        displayName: entry.name,
        canonicalPath: path.join(document.canonicalRoot, entry.name)
      };
    });
    const updated: DocumentRecord = {
      ...document,
      manuscripts: new Map(manuscriptRecords.map((manuscript) => [manuscript.manuscriptId, manuscript] as const))
    };
    this.documents.set(updated.documentId, updated);
    this.owners.set(updated.owner, updated);
    return {
      kind: "opened",
      document: { documentId: updated.documentId, displayName: updated.displayName },
      manuscripts: manuscriptRecords.map(({ manuscriptId, displayName }) => ({ manuscriptId, displayName }))
    };
  }

  /** Create a root-level Markdown file with exclusive creation and refresh. */
  public async createManuscriptForOwner(
    owner: unknown,
    documentId: unknown,
    fileName: unknown,
    contents: unknown
  ): Promise<CreateManuscriptResult> {
    if (!isSafeManuscriptName(fileName) || typeof contents !== "string") return INVALID_MANUSCRIPT_NAME;
    const root = await this.resolveDocumentRoot(owner, documentId);
    if (root.kind !== "resolved") return root;
    const normalizedName = fileName.trim();
    const candidatePath = path.join(root.canonicalRoot, normalizedName);
    if (!isDirectChild(root.canonicalRoot, candidatePath)) return INVALID_MANUSCRIPT_NAME;

    try {
      await writeFile(candidatePath, contents, { encoding: "utf8", flag: "wx" });
    } catch (error: unknown) {
      if (errorCode(error) === "EEXIST") return MANUSCRIPT_EXISTS;
      return MANUSCRIPT_CREATE_FAILED;
    }

    const refreshed = await this.refreshForOwner(owner, documentId);
    if (refreshed.kind !== "opened") return refreshed;
    const manuscript = refreshed.manuscripts.find((candidate) => candidate.displayName === normalizedName);
    if (!manuscript) return MANUSCRIPT_CREATE_FAILED;
    return {
      kind: "created",
      document: refreshed.document,
      manuscript
    };
  }

  /**
   * Resolve a selected manuscript for main-process consumers. IDs are looked
   * up in retained maps; no caller-provided string is ever joined to a path.
   */
  public async resolveManuscriptPath(
    owner: unknown,
    documentId: unknown,
    manuscriptId: unknown
  ): Promise<ResolveManuscriptPathResult> {
    const document = this.findDocument(owner, documentId);
    if ("kind" in document) return document;
    if (!isOpaqueId(manuscriptId)) return {
      kind: "error",
      code: "invalid-manuscript-id",
      message: "The manuscript ID is invalid."
    };

    const manuscript = document.manuscripts.get(manuscriptId);
    if (!manuscript) return MANUSCRIPT_NOT_OWNED;

    try {
      const currentRoot = await realpath(document.canonicalRoot);
      if (currentRoot !== document.canonicalRoot) return MANUSCRIPT_UNAVAILABLE;
      const rootStats = await lstat(document.canonicalRoot);
      if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) return MANUSCRIPT_UNAVAILABLE;

      const manuscriptStats = await lstat(manuscript.canonicalPath);
      if (!manuscriptStats.isFile() || manuscriptStats.isSymbolicLink()) {
        return MANUSCRIPT_UNAVAILABLE;
      }
      const canonicalPath = await realpath(manuscript.canonicalPath);
      if (!isDirectChild(document.canonicalRoot, canonicalPath)) return MANUSCRIPT_UNAVAILABLE;
      return { kind: "resolved", canonicalPath };
    } catch (_error: unknown) {
      return manuscriptFailure();
    }
  }

  public dispose(): void {
    this.documents.clear();
    this.owners.clear();
  }

  private findDocument(owner: unknown, documentId: unknown): DocumentRecord | DocumentWorkspaceFailure {
    if (!isOwner(owner)) return INVALID_OWNER;
    if (!isOpaqueId(documentId)) return {
      kind: "error",
      code: "invalid-document-id",
      message: "The Document ID is invalid."
    };

    const document = this.documents.get(documentId);
    if (!document || document.owner !== owner) return DOCUMENT_NOT_OWNED;
    return document;
  }
}
