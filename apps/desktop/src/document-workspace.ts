import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import * as path from "node:path";

export interface DocumentSummary {
  readonly documentId: string;
  readonly displayName: string;
}

export interface ManuscriptSummary {
  readonly manuscriptId: string;
  readonly displayName: string;
}

/** Safe presentation metadata. Filesystem paths remain in the main process. */
export interface ExplorerEntry {
  readonly entryId: string;
  readonly parentId: string | null;
  readonly displayName: string;
  readonly relativeName: string;
  readonly kind: "folder" | "markdown" | "file";
}

export interface ExplorerListed {
  readonly kind: "listed";
  readonly document: DocumentSummary;
  readonly entries: readonly ExplorerEntry[];
}

export type ExplorerListResult = ExplorerListed | DocumentWorkspaceFailure;
export type CreateFolderResult = { readonly kind: "created"; readonly entry: ExplorerEntry } | DocumentWorkspaceFailure;
export type ResolveExplorerFileResult =
  | { readonly kind: "resolved"; readonly entry: ExplorerEntry; readonly canonicalPath: string }
  | DocumentWorkspaceFailure;

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
  | "manuscript-unavailable"
  | "invalid-folder-name"
  | "folder-exists"
  | "folder-create-failed"
  | "explorer-entry-unavailable";

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

/** Main-process-only nested Markdown resolution for Project wiki links. */
export interface ResolvedProjectManuscript {
  readonly kind: "resolved";
  readonly manuscriptId: string;
  readonly displayName: string;
  readonly canonicalPath: string;
}

/** Main-process-only nested Project Markdown inventory for bounded services. */
export interface ProjectMarkdownRecord {
  readonly manuscriptId: string;
  readonly displayName: string;
  readonly canonicalPath: string;
}

export type ResolveProjectManuscriptResult = ResolvedProjectManuscript | DocumentWorkspaceFailure;

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

/**
 * Workspace state survives an application restart, so the opaque handles
 * exposed by this service must not be regenerated every time a Project is
 * reopened.  Keep the wire shape UUID-like while deriving it only from the
 * canonical filesystem boundary and direct child name.  The path itself is
 * never returned to the renderer.
 */
function stableOpaqueUuid(seed: string): string {
  const digest = createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 32);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-${((Number.parseInt(digest.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0")}${digest.slice(18, 20)}-${digest.slice(20)}`;
}

function stablePathSeed(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function documentIdForRoot(canonicalRoot: string): string {
  return stableOpaqueUuid(`maginalia:document:${stablePathSeed(canonicalRoot)}`);
}

function manuscriptIdForPath(canonicalRoot: string, displayName: string): string {
  return stableOpaqueUuid(`maginalia:manuscript:${stablePathSeed(path.join(canonicalRoot, displayName))}`);
}

function explorerIdForPath(canonicalRoot: string, relativeName: string, kind: ExplorerEntry["kind"]): string {
  return kind === "markdown" ? manuscriptIdForPath(canonicalRoot, relativeName)
    : stableOpaqueUuid(`maginalia:explorer:${kind}:${stablePathSeed(path.join(canonicalRoot, relativeName))}`);
}

const EXPLORER_ENTRY_UNAVAILABLE: DocumentWorkspaceFailure = {
  kind: "error", code: "explorer-entry-unavailable", message: "The selected Explorer entry is no longer available."
};

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

export function isSafeExplorerName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const name = value.trim();
  return name.length > 0
    && !name.startsWith(".")
    && !path.isAbsolute(name)
    && !path.win32.isAbsolute(name)
    && !/[<>:"/\\|?*\u0000-\u001f]/u.test(name)
    && !/[. ]$/u.test(name)
    && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/iu.test(name.split(".")[0].trimEnd());
}

function isSafeManuscriptName(value: unknown): value is string {
  return isSafeExplorerName(value) && /\.(?:md|markdown)$/iu.test(value.trim());
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

function projectRelativeName(rootPath: string, candidatePath: string): string | null {
  const relative = path.relative(rootPath, candidatePath);
  if (relative.length === 0 || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

async function listNestedMarkdownEntries(canonicalRoot: string): Promise<readonly { readonly relativeName: string; readonly canonicalPath: string }[]> {
  const found: { relativeName: string; canonicalPath: string }[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true, encoding: "utf8" });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const candidate = path.join(directory, entry.name);
      // Do not follow a symlink even if Dirent reports a matching type.
      const stats = await lstat(candidate);
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) { await visit(candidate); continue; }
      if (!stats.isFile() || !isMarkdownName(entry.name)) continue;
      const canonicalPath = await realpath(candidate);
      const relativeName = projectRelativeName(canonicalRoot, canonicalPath);
      if (relativeName !== null) found.push({ relativeName, canonicalPath });
    }
  };
  await visit(canonicalRoot);
  return found.sort((left, right) => compareNames(left.relativeName, right.relativeName));
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

interface ExplorerRecord extends ExplorerEntry {
  readonly canonicalPath: string;
}

async function listExplorerEntries(canonicalRoot: string, excludedRelativeRoots: readonly string[] = []): Promise<ExplorerRecord[]> {
  const found: ExplorerRecord[] = [];
  const visit = async (directory: string, parentId: string | null): Promise<void> => {
    const directoryStats = await lstat(directory);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink() || await realpath(directory) !== directory) return;
    const entries = await readdir(directory, { withFileTypes: true, encoding: "utf8" });
    entries.sort((left, right) => compareNames(left.name, right.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const candidate = path.join(directory, entry.name);
      const stats = await lstat(candidate);
      if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) continue;
      // Typed folder markers are identity metadata, not normal Explorer files.
      // Keep directories with the same suffix visible as ordinary folders.
      if (stats.isFile() && path.extname(entry.name).toLowerCase() === ".magi") continue;
      if (stats.isDirectory() && entry.name.startsWith("'")) continue;
      const canonicalPath = await realpath(candidate);
      const relativeName = projectRelativeName(canonicalRoot, canonicalPath);
      if (canonicalPath !== candidate || relativeName === null) continue;
      if (excludedRelativeRoots.some((excluded) => relativeName === excluded || relativeName.startsWith(`${excluded}/`))) continue;
      const kind = stats.isDirectory() ? "folder" : isMarkdownName(entry.name) ? "markdown" : "file";
      const record: ExplorerRecord = {
        entryId: explorerIdForPath(canonicalRoot, relativeName, kind), parentId,
        displayName: entry.name, relativeName, kind, canonicalPath
      };
      found.push(record);
      if (kind === "folder") await visit(canonicalPath, record.entryId);
    }
  };
  await visit(canonicalRoot, null);
  return found;
}

function explorerSummary({ canonicalPath: _canonicalPath, ...entry }: ExplorerRecord): ExplorerEntry {
  return entry;
}

export class DocumentWorkspaceService {
  private readonly documents = new Map<string, DocumentRecord>();
  private readonly owners = new Map<object, DocumentRecord>();

  /** Explorer-only visibility rules never change the physical tree or Project search. */
  public async listExplorerForOwner(
    owner: unknown, documentId: unknown, excludedRelativeRoots: readonly string[] = []
  ): Promise<ExplorerListResult> {
    const document = this.findDocument(owner, documentId);
    if ("kind" in document) return document;
    const root = await this.resolveDocumentRoot(owner, documentId);
    if (root.kind !== "resolved") return root;
    try {
      const entries = await listExplorerEntries(root.canonicalRoot, excludedRelativeRoots);
      return { kind: "listed", document: { documentId: document.documentId, displayName: document.displayName }, entries: entries.map(explorerSummary) };
    } catch (_error: unknown) { return ROOT_UNREADABLE; }
  }

  public async createFolderForOwner(
    owner: unknown, documentId: unknown, parentEntryId: unknown, name: unknown
  ): Promise<CreateFolderResult> {
    if (!isSafeExplorerName(name)) {
      return { kind: "error", code: "invalid-folder-name", message: "Use a folder name without a leading dot, path separators, or reserved characters." };
    }
    const parent = await this.resolveExplorerParent(owner, documentId, parentEntryId);
    if (parent.kind !== "resolved") return parent;
    const normalizedName = name.trim();
    const candidate = path.join(parent.canonicalPath, normalizedName);
    if (!isDirectChild(parent.canonicalPath, candidate)) return EXPLORER_ENTRY_UNAVAILABLE;
    try {
      if (await this.hasNameCollision(parent.canonicalPath, normalizedName)) {
        return { kind: "error", code: "folder-exists", message: "An entry with that name already exists. Choose another name." };
      }
      await mkdir(candidate);
    } catch (error: unknown) {
      return { kind: "error", code: errorCode(error) === "EEXIST" ? "folder-exists" : "folder-create-failed", message: "The folder could not be created. Choose another name or check its permissions." };
    }
    const relativeName = projectRelativeName(parent.canonicalRoot, candidate);
    if (relativeName === null) return EXPLORER_ENTRY_UNAVAILABLE;
    return { kind: "created", entry: { entryId: explorerIdForPath(parent.canonicalRoot, relativeName, "folder"), parentId: parentEntryId as string | null, displayName: normalizedName, relativeName, kind: "folder" } };
  }

  /** Main-process-only resolution for the host Trash coordinator. Directories are never accepted. */
  public async resolveExplorerFilePath(
    owner: unknown, documentId: unknown, entryId: unknown, excludedRelativeRoots: readonly string[] = []
  ): Promise<ResolveExplorerFileResult> {
    const root = await this.resolveDocumentRoot(owner, documentId);
    if (root.kind !== "resolved") return root;
    if (!isOpaqueId(entryId)) return EXPLORER_ENTRY_UNAVAILABLE;
    try {
      const record = (await listExplorerEntries(root.canonicalRoot, excludedRelativeRoots)).find((entry) => entry.entryId === entryId && entry.kind !== "folder");
      if (!record || !await this.revalidateExplorerPath(root.canonicalRoot, record.canonicalPath, false)) return EXPLORER_ENTRY_UNAVAILABLE;
      return { kind: "resolved", entry: explorerSummary(record), canonicalPath: record.canonicalPath };
    } catch (_error: unknown) { return EXPLORER_ENTRY_UNAVAILABLE; }
  }

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

    const documentId = documentIdForRoot(canonicalRoot);
    const manuscriptRecords = entries.map((entry): ManuscriptRecord => ({
      manuscriptId: manuscriptIdForPath(canonicalRoot, entry.name),
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

  /**
   * Resolve an opaque ID from a project-relative Markdown link.  This does not
   * affect the root-only Registry and never exposes a filesystem path outside
   * main-process callers.
   */
  public async resolveProjectManuscriptPath(
    owner: unknown,
    documentId: unknown,
    manuscriptId: unknown
  ): Promise<ResolveProjectManuscriptResult> {
    const document = this.findDocument(owner, documentId);
    if ("kind" in document) return document;
    if (!isOpaqueId(manuscriptId)) return { kind: "error", code: "invalid-manuscript-id", message: "The Project link is invalid." };
    const root = await this.resolveDocumentRoot(owner, documentId);
    if (root.kind !== "resolved") return root;
    let entries: readonly { readonly relativeName: string; readonly canonicalPath: string }[];
    try {
      entries = await listNestedMarkdownEntries(root.canonicalRoot);
    } catch (error: unknown) {
      return rootFailure(error);
    }
    const match = entries.find((entry) => manuscriptIdForPath(root.canonicalRoot, entry.relativeName) === manuscriptId);
    if (match === undefined) return MANUSCRIPT_UNAVAILABLE;
    return {
      kind: "resolved",
      manuscriptId,
      displayName: match.relativeName,
      canonicalPath: match.canonicalPath
    };
  }

  public async resolveProjectManuscriptByRelativeName(
    owner: unknown,
    documentId: unknown,
    relativeName: string
  ): Promise<ResolveProjectManuscriptResult> {
    const document = this.findDocument(owner, documentId);
    if ("kind" in document) return document;
    const root = await this.resolveDocumentRoot(owner, documentId);
    if (root.kind !== "resolved") return root;
    let entries: readonly { readonly relativeName: string; readonly canonicalPath: string }[];
    try {
      entries = await listNestedMarkdownEntries(root.canonicalRoot);
    } catch (error: unknown) {
      return rootFailure(error);
    }
    const exact = entries.filter((entry) => entry.relativeName === relativeName);
    const extensionless = !/\.(?:md|markdown)$/iu.test(relativeName);
    const candidates = extensionless
      ? entries.filter((entry) => entry.relativeName.replace(/\.(?:md|markdown)$/iu, "") === relativeName)
      : exact;
    if (candidates.length !== 1) return MANUSCRIPT_UNAVAILABLE;
    const match = candidates[0];
    return {
      kind: "resolved",
      manuscriptId: manuscriptIdForPath(root.canonicalRoot, match.relativeName),
      displayName: match.relativeName,
      canonicalPath: match.canonicalPath
    };
  }

  /**
   * Return nested Markdown records only to another main-process Project
   * service. The renderer receives neither canonical paths nor this method.
   */
  public async listProjectMarkdownForOwner(
    owner: unknown,
    documentId: unknown
  ): Promise<readonly ProjectMarkdownRecord[] | DocumentWorkspaceFailure> {
    const document = this.findDocument(owner, documentId);
    if ("kind" in document) return document;
    const root = await this.resolveDocumentRoot(owner, documentId);
    if (root.kind !== "resolved") return root;
    let entries: readonly { readonly relativeName: string; readonly canonicalPath: string }[];
    try {
      entries = await listNestedMarkdownEntries(root.canonicalRoot);
    } catch (error: unknown) {
      return rootFailure(error);
    }
    return entries.map((entry) => Object.freeze({
      manuscriptId: manuscriptIdForPath(root.canonicalRoot, entry.relativeName),
      displayName: entry.relativeName,
      canonicalPath: entry.canonicalPath
    }));
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
        manuscriptId: manuscriptIdForPath(document.canonicalRoot, entry.name),
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

  /** Exclusively create Markdown in the root or a revalidated Explorer folder. */
  public async createManuscriptForOwner(
    owner: unknown,
    documentId: unknown,
    fileName: unknown,
    contents: unknown,
    parentEntryId: unknown = null
  ): Promise<CreateManuscriptResult> {
    if (!isSafeManuscriptName(fileName) || typeof contents !== "string") return INVALID_MANUSCRIPT_NAME;
    const parent = await this.resolveExplorerParent(owner, documentId, parentEntryId);
    if (parent.kind !== "resolved") return parent;
    const normalizedName = fileName.trim();
    const candidatePath = path.join(parent.canonicalPath, normalizedName);
    if (!isDirectChild(parent.canonicalPath, candidatePath)) return INVALID_MANUSCRIPT_NAME;

    try {
      if (await this.hasNameCollision(parent.canonicalPath, normalizedName)) return MANUSCRIPT_EXISTS;
      await writeFile(candidatePath, contents, { encoding: "utf8", flag: "wx" });
    } catch (error: unknown) {
      if (errorCode(error) === "EEXIST") return MANUSCRIPT_EXISTS;
      return MANUSCRIPT_CREATE_FAILED;
    }

    const refreshed = await this.refreshForOwner(owner, documentId);
    if (refreshed.kind !== "opened") return refreshed;
    const relativeName = projectRelativeName(parent.canonicalRoot, candidatePath);
    const manuscript = parentEntryId === null
      ? refreshed.manuscripts.find((candidate) => candidate.displayName === normalizedName)
      : relativeName === null ? undefined : { manuscriptId: manuscriptIdForPath(parent.canonicalRoot, relativeName), displayName: relativeName };
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

  private async hasNameCollision(directory: string, name: string): Promise<boolean> {
    return (await readdir(directory)).some((entry) => entry.toLowerCase() === name.toLowerCase());
  }

  private async revalidateExplorerPath(root: string, candidate: string, directory: boolean): Promise<boolean> {
    const relativeName = projectRelativeName(root, candidate);
    if (relativeName === null) return false;
    const components = relativeName.split("/");
    let current = root;
    for (let index = 0; index < components.length; index += 1) {
      current = path.join(current, components[index]);
      const stats = await lstat(current);
      const needsDirectory = index < components.length - 1 || directory;
      if (stats.isSymbolicLink() || (needsDirectory ? !stats.isDirectory() : !stats.isFile()) || await realpath(current) !== current) return false;
    }
    return true;
  }

  private async resolveExplorerParent(owner: unknown, documentId: unknown, parentEntryId: unknown): Promise<
    { readonly kind: "resolved"; readonly canonicalRoot: string; readonly canonicalPath: string } | DocumentWorkspaceFailure
  > {
    const root = await this.resolveDocumentRoot(owner, documentId);
    if (root.kind !== "resolved") return root;
    if (parentEntryId === null) return { kind: "resolved", canonicalRoot: root.canonicalRoot, canonicalPath: root.canonicalRoot };
    if (!isOpaqueId(parentEntryId)) return EXPLORER_ENTRY_UNAVAILABLE;
    try {
      const parent = (await listExplorerEntries(root.canonicalRoot)).find((entry) => entry.entryId === parentEntryId && entry.kind === "folder");
      if (!parent || !await this.revalidateExplorerPath(root.canonicalRoot, parent.canonicalPath, true)) return EXPLORER_ENTRY_UNAVAILABLE;
      return { kind: "resolved", canonicalRoot: root.canonicalRoot, canonicalPath: parent.canonicalPath };
    } catch (_error: unknown) { return EXPLORER_ENTRY_UNAVAILABLE; }
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
