import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import {
  DocumentWorkspaceService,
  type DocumentWorkspaceFailure,
  type DocumentWorkspaceOpened,
  type CreateManuscriptResult,
} from "./document-workspace";
import type { OpenMarkdownResult } from "./markdown-ipc";
import { MarkdownFileService } from "./markdown-file-service";
import {
  createProjectMarkdown,
  normalizeProjectFileName,
  normalizeDocumentTitle,
  normalizeProjectFolderName,
  parseProjectMetadata,
  PROJECT_DOCUMENT_TYPES,
  type ProjectDocumentType,
} from "./project-metadata";
import { validateInternalLinkTarget } from "./project-links";
import { createFolderMarker, FolderMarkerError, resolveFolderMarker } from "./folder-identity.js";

export interface ProjectSummary {
  readonly projectId: string;
  readonly displayName: string;
}

export interface ProjectFileSummary {
  readonly fileId: string;
  readonly displayName: string;
  readonly documentType: ProjectDocumentType;
  readonly title: string;
}

export interface ProjectOpened {
  readonly kind: "opened";
  readonly project: ProjectSummary;
  readonly files: readonly ProjectFileSummary[];
  /** Present when identity needs explicit recovery; authored files remain open. */
  readonly folderIdentityRecovery?: { readonly code: string; readonly message: string };
}

export interface ProjectFileCreated {
  readonly kind: "created";
  readonly project: ProjectSummary;
  readonly files: readonly ProjectFileSummary[];
  readonly file: ProjectFileSummary;
}

/** Main-process-only source snapshot used by the Workdesk copy coordinator. */
export interface ProjectFileCopySource {
  readonly displayName: string;
  readonly text: string;
  readonly title: string;
  readonly documentType: ProjectDocumentType;
}

export interface ProjectFailure {
  readonly kind: "error";
  readonly code:
    | "project-name-invalid"
    | "project-create-failed"
    | "project-state-unavailable"
    | "project-not-remembered"
    | "project-file-invalid"
    | "project-file-create-failed";
  readonly message: string;
}

export type ProjectResult = ProjectOpened | DocumentWorkspaceFailure | ProjectFailure;
export type ProjectCreateResult = ProjectOpened | DocumentWorkspaceFailure | ProjectFailure;
export type ProjectFileCreateResult = ProjectFileCreated | DocumentWorkspaceFailure | ProjectFailure;

/** Main-process-only result for creating a child under a Workdesk. */
export interface ProjectCreatedForWorkdesk {
  readonly kind: "created";
  readonly canonicalRoot: string;
}

export type ProjectWorkdeskCreateResult = ProjectCreatedForWorkdesk | DocumentWorkspaceFailure | ProjectFailure;

export type ProjectInternalLinkResult =
  | { readonly kind: "resolved"; readonly fileId: string; readonly displayName: string }
  | { readonly kind: "missing"; readonly message: string }
  | { readonly kind: "invalid"; readonly message: string };

/** Renderer-safe composition source; canonical paths remain in main only. */
export type ProjectSyncedDocumentResult =
  | { readonly kind: "resolved"; readonly target: string; readonly fileId: string; readonly displayName: string; readonly text: string }
  | { readonly kind: "missing" | "invalid" | "unavailable"; readonly message: string };

export interface ProjectSearchMatch {
  readonly fileId: string;
  /** Project-relative display name; never an absolute filesystem path. */
  readonly displayName: string;
  readonly excerpt: string;
  /** Raw Markdown is returned only for a selected file in the current Project. */
  readonly text: string;
}

export interface ProjectSearchResult {
  readonly kind: "results";
  readonly results: readonly ProjectSearchMatch[];
  readonly total: number;
}

export interface ProjectPathStore {
  load(): Promise<string | null>;
  save(canonicalRoot: string): Promise<void>;
}

export class FileProjectPathStore implements ProjectPathStore {
  private writes: Promise<void> = Promise.resolve();

  public constructor(private readonly filePath: string) {}

  public async load(): Promise<string | null> {
    const snapshot = await this.readSettings();
    if (snapshot.kind !== "valid") return null;
    const root = snapshot.value.rootPath;
    return typeof root === "string" ? root : null;
  }

  public async save(canonicalRoot: string): Promise<void> {
    await this.serialize(async () => {
      const snapshot = await this.readSettings();
      if (snapshot.kind === "invalid") throw new Error("Project path settings cannot be safely updated.");
      const value: Record<string, unknown> = snapshot.kind === "valid"
        ? { ...snapshot.value }
        : {};
      value.rootPath = canonicalRoot;
      if (!Object.prototype.hasOwnProperty.call(value, "defaultCreationParent")) {
        value.defaultCreationParent = null;
      }
      if (snapshot.kind === "missing") {
        await this.writeNewSettings(value);
      } else {
        await this.replaceSettings(snapshot.text, value);
      }
    });
  }

  /**
   * Ensure the app-local Project creation preference has an explicit empty
   * value. Existing last-opened roots and configured parents are retained.
   */
  public async ensureDefaultCreationParentPlaceholder(): Promise<void> {
    await this.serialize(async () => {
      const snapshot = await this.readSettings();
      if (snapshot.kind === "invalid") throw new Error("Project path settings cannot be safely initialized.");
      if (snapshot.kind === "valid" && Object.prototype.hasOwnProperty.call(snapshot.value, "defaultCreationParent")) {
        return;
      }

      if (snapshot.kind === "missing") {
        await mkdir(path.dirname(this.filePath), { recursive: true });
        await this.writeNewSettings({ defaultCreationParent: null });
        return;
      }

      await this.replaceSettings(snapshot.text, {
        ...snapshot.value,
        defaultCreationParent: null
      });
    });
  }

  private async readSettings(): Promise<
    | { readonly kind: "missing" }
    | { readonly kind: "invalid" }
    | { readonly kind: "valid"; readonly text: string; readonly value: Record<string, unknown> }
  > {
    let stats;
    try {
      stats = await lstat(this.filePath);
    } catch (error: unknown) {
      if (isMissingPathError(error)) return { kind: "missing" };
      return { kind: "invalid" };
    }
    if (!stats.isFile() || stats.isSymbolicLink()) return { kind: "invalid" };

    let text: string;
    let parsed: unknown;
    try {
      text = await readFile(this.filePath, "utf8");
      parsed = JSON.parse(text);
    } catch (_error: unknown) {
      return { kind: "invalid" };
    }
    if (!isValidProjectPathSettings(parsed)) return { kind: "invalid" };
    return { kind: "valid", text, value: parsed };
  }

  private async writeNewSettings(value: Record<string, unknown>): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    // Exclusive creation means a concurrently appearing config is never
    // replaced by this bootstrap placeholder.
    await writeFile(this.filePath, serializeProjectPathSettings(value), { encoding: "utf8", flag: "wx" });
  }

  private async replaceSettings(previousText: string, value: Record<string, unknown>): Promise<void> {
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serializeProjectPathSettings(value), { encoding: "utf8", flag: "wx" });
      const current = await this.readSettings();
      if (current.kind !== "valid" || current.text !== previousText) {
        throw new Error("Project path settings changed during update.");
      }
      await rename(temporary, this.filePath);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(operation, operation);
    this.writes = result.then(() => undefined, () => undefined);
    return result;
  }
}

function isMissingPathError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function isValidProjectPathSettings(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "rootPath") &&
    (typeof value.rootPath !== "string" || !path.isAbsolute(value.rootPath))) return false;
  if (Object.prototype.hasOwnProperty.call(value, "defaultCreationParent") &&
    value.defaultCreationParent !== null &&
    (typeof value.defaultCreationParent !== "string" || !path.isAbsolute(value.defaultCreationParent))) return false;
  return true;
}

function serializeProjectPathSettings(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`;
}

export class MemoryProjectPathStore implements ProjectPathStore {
  private value: string | null = null;

  public async load(): Promise<string | null> {
    return this.value;
  }

  public async save(canonicalRoot: string): Promise<void> {
    this.value = canonicalRoot;
  }
}

const PROJECT_NOT_REMEMBERED: ProjectFailure = {
  kind: "error",
  code: "project-not-remembered",
  message: "No previously used Project is available. Choose a Project folder to begin."
};

const PROJECT_STATE_UNAVAILABLE: ProjectFailure = {
  kind: "error",
  code: "project-state-unavailable",
  message: "The previous Project folder is no longer available. Choose a Project folder again."
};

const PROJECT_NAME_INVALID: ProjectFailure = {
  kind: "error",
  code: "project-name-invalid",
  message: "Use a Project name without path separators or reserved characters."
};

const PROJECT_CREATE_FAILED: ProjectFailure = {
  kind: "error",
  code: "project-create-failed",
  message: "The Project could not be created. Check the selected folder permissions and try again."
};

const PROJECT_FILE_INVALID: ProjectFailure = {
  kind: "error",
  code: "project-file-invalid",
  message: "Enter a Markdown file name, title, and document type."
};

const PROJECT_FILE_CREATE_FAILED: ProjectFailure = {
  kind: "error",
  code: "project-file-create-failed",
  message: "The Markdown file could not be created. Try another name."
};

const PROJECT_SEARCH_FAILED: ProjectFailure = {
  kind: "error",
  code: "project-state-unavailable",
  message: "The Project Markdown could not be searched. Check the Project folder and try again."
};

const PROJECT_SEARCH_LIMIT = 100;

function normalizedSearch(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase();
}

function projectSearchExcerpt(text: string, query: string): string {
  const normalized = normalizedSearch(text);
  const index = normalized.indexOf(query);
  if (index < 0) return text.slice(0, 240);
  const start = Math.max(0, index - 80);
  const end = Math.min(text.length, index + query.length + 160);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

function isDocumentType(value: unknown): value is ProjectDocumentType {
  return typeof value === "string" && (PROJECT_DOCUMENT_TYPES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRootError(value: unknown): value is DocumentWorkspaceFailure {
  return isRecord(value) && value.kind === "error" && typeof value.code === "string" && typeof value.message === "string";
}

function copyCandidateName(sourceName: string, index: number): string {
  const normalized = normalizeProjectFileName(sourceName);
  const base = (normalized ?? "document.md").replace(/\.md$/iu, "");
  return index === 0 ? `${base}.md` : `${base}-${String(index).padStart(3, "0")}.md`;
}

/**
 * Change only the frontmatter `type` field for an explicit cross-type copy.
 * The original text is returned byte-for-byte for the normal same-type path.
 */
export function withCopiedDocumentType(source: string, type: ProjectDocumentType): string {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom ? source.slice(1) : source;
  const closing = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/u.exec(body);
  if (!closing) return `${bom}---${newline}type: ${type}${newline}---${newline}${newline}${body}`;
  const frontmatter = closing[1] ?? "";
  const nextFrontmatter = /^([ \t]*type[ \t]*:[^\r\n]*)(\r?\n|$)/imu.test(frontmatter)
    ? frontmatter.replace(/^([ \t]*type[ \t]*:)[^\r\n]*(\r?\n|$)/imu, `$1 ${type}$2`)
    : `type: ${type}${newline}${frontmatter}`;
  return `${bom}---${newline}${nextFrontmatter}${newline}---${body.slice(closing[0].length - (closing[0].endsWith("\n") ? 1 : 0))}`;
}

export class ProjectService {
  private readonly validationOwner = Object.freeze({});

  public constructor(
    private readonly workspace: DocumentWorkspaceService,
    private readonly markdown: MarkdownFileService,
    private readonly pathStore: ProjectPathStore,
  ) {}

  public async openForOwner(
    owner: object,
    rootPath: string,
    options: { readonly parentWorkdeskId?: string | null } = {},
  ): Promise<ProjectResult> {
    const identityRecovery = await this.prepareFolderIdentity(rootPath, options.parentWorkdeskId);
    return this.openWorkspaceForOwner(owner, rootPath, identityRecovery);
  }

  /** Open Workdesk loose documents without treating the Workdesk root as a Project. */
  public async openWorkdeskLooseFilesForOwner(
    owner: object,
    rootPath: string,
    options: { readonly rememberAsProject?: boolean } = {},
  ): Promise<ProjectResult> {
    return this.openWorkspaceForOwner(owner, rootPath, undefined, options.rememberAsProject !== false);
  }

  private async openWorkspaceForOwner(
    owner: object,
    rootPath: string,
    identityRecovery: { readonly code: string; readonly message: string } | undefined,
    rememberAsProject = true,
  ): Promise<ProjectResult> {
    const opened = await this.workspace.openForOwner(owner, rootPath);
    if (opened.kind !== "opened") return opened;
    let result = await this.enrich(owner, opened);
    if (result.kind === "opened" && identityRecovery) {
      result = Object.freeze({ ...result, folderIdentityRecovery: identityRecovery });
    }
    if (result.kind === "opened" && rememberAsProject) await this.remember(owner, opened.document.documentId);
    return result;
  }

  /**
   * Check a Project root without replacing a renderer owner's active Project
   * or changing its remembered restore location. Workdesk uses this before it
   * commits an external membership.
   */
  public async validateProjectRoot(rootPath: string): Promise<ProjectResult> {
    const identityRecovery = await this.prepareFolderIdentity(rootPath);
    const opened = await this.workspace.openForOwner(this.validationOwner, rootPath);
    if (opened.kind !== "opened") return opened;
    const result = await this.enrich(this.validationOwner, opened);
    return result.kind === "opened" && identityRecovery
      ? Object.freeze({ ...result, folderIdentityRecovery: identityRecovery })
      : result;
  }

  public async createForOwner(owner: object, parentPath: string, title: string): Promise<ProjectCreateResult> {
    const projectRoot = await this.createProjectRoot(parentPath, title);
    if (typeof projectRoot !== "string") return projectRoot;
    try {
      await createFolderMarker(projectRoot, "project");
    } catch (error: unknown) {
      return {
        kind: "error",
        code: "project-create-failed",
        message: error instanceof Error ? error.message : "The Project marker could not be created safely.",
      };
    }
    return this.openForOwner(owner, projectRoot);
  }

  /** Create an owned child folder with a typed parent relationship, without Git initialization. */
  public async createForWorkdesk(
    parentPath: string,
    title: string,
    parentWorkdeskId: string,
  ): Promise<ProjectWorkdeskCreateResult> {
    const projectRoot = await this.createProjectRoot(parentPath, title);
    if (typeof projectRoot !== "string") return projectRoot;
    try {
      await createFolderMarker(projectRoot, "project", { parentWorkdeskId });
      return Object.freeze({ kind: "created", canonicalRoot: projectRoot });
    } catch (error: unknown) {
      return {
        kind: "error",
        code: "project-create-failed",
        message: error instanceof Error ? error.message : "The Project marker could not be created safely.",
      };
    }
  }

  private async createProjectRoot(parentPath: string, title: string): Promise<string | ProjectFailure> {
    const normalizedTitle = normalizeProjectFolderName(title);
    if (!normalizedTitle || !path.isAbsolute(parentPath)) return PROJECT_NAME_INVALID;

    let parentRoot: string;
    try {
      parentRoot = await realpath(parentPath);
      const stats = await lstat(parentRoot);
      if (!stats.isDirectory() || stats.isSymbolicLink()) return PROJECT_CREATE_FAILED;
    } catch (_error: unknown) {
      return PROJECT_CREATE_FAILED;
    }

    const projectRoot = path.join(parentRoot, normalizedTitle);
    try {
      await mkdir(projectRoot, { recursive: false });
    } catch (_error: unknown) {
      return PROJECT_CREATE_FAILED;
    }
    return projectRoot;
  }

  public async restoreForOwner(owner: object): Promise<ProjectResult | { readonly kind: "none" }> {
    const remembered = await this.pathStore.load();
    if (remembered === null) return { kind: "none" };
    try {
      const stats = await lstat(remembered);
      if (!stats.isDirectory() || stats.isSymbolicLink()) return PROJECT_STATE_UNAVAILABLE;
    } catch (_error: unknown) {
      return PROJECT_STATE_UNAVAILABLE;
    }
    const result = await this.openForOwner(owner, remembered);
    if (result.kind === "error" && (result.code === "root-missing" || result.code === "root-not-directory")) {
      return PROJECT_STATE_UNAVAILABLE;
    }
    return result;
  }

  public async openFileForOwner(
    owner: object,
    projectId: string,
    fileId: string,
  ): Promise<OpenMarkdownResult | DocumentWorkspaceFailure> {
    const resolved = await this.workspace.resolveProjectManuscriptPath(owner, projectId, fileId);
    if (resolved.kind !== "resolved") return resolved;
    return this.markdown.openForOwner(owner, resolved.canonicalPath, projectId);
  }

  /** Literal, current-Project-only Markdown search. No paths cross this API. */
  public async searchMarkdownForOwner(
    owner: object,
    projectId: string,
    query: string
  ): Promise<ProjectSearchResult> {
    const needle = normalizedSearch(query);
    const records = await this.workspace.listProjectMarkdownForOwner(owner, projectId);
    if (!Array.isArray(records)) {
      const failure = records as DocumentWorkspaceFailure;
      throw new Error(failure.message);
    }
    const matches: ProjectSearchMatch[] = [];
    let total = 0;
    for (const record of records) {
      let text: string;
      try {
        text = await readFile(record.canonicalPath, "utf8");
      } catch {
        // A concurrently removed file is not a search failure for the rest of
        // the Project. It simply cannot contribute a stale result.
        continue;
      }
      if (needle.length > 0 && !normalizedSearch(text).includes(needle)) continue;
      total += 1;
      if (matches.length >= PROJECT_SEARCH_LIMIT) continue;
      matches.push(Object.freeze({
        fileId: record.manuscriptId,
        displayName: record.displayName,
        excerpt: projectSearchExcerpt(text, needle),
        text
      }));
    }
    return Object.freeze({ kind: "results", results: Object.freeze(matches), total });
  }

  /** Resolve a validated authoring link to an opaque file ID, never a path. */
  public async resolveInternalLinkForOwner(
    owner: object,
    projectId: string,
    target: string
  ): Promise<ProjectInternalLinkResult> {
    const validation = validateInternalLinkTarget(target);
    if (validation.kind !== "valid") {
      return { kind: "invalid", message: "That internal link target is not a Project-relative Markdown path." };
    }
    const resolved = await this.workspace.resolveProjectManuscriptByRelativeName(owner, projectId, validation.target);
    if (resolved.kind !== "resolved") return { kind: "missing", message: "The linked Markdown document was not found in this Project." };
    return { kind: "resolved", fileId: resolved.manuscriptId, displayName: resolved.displayName };
  }

  /** Read a Project-local Markdown source without opening a document session. */
  public async resolveSyncedDocumentForOwner(
    owner: object,
    projectId: string,
    target: string,
  ): Promise<ProjectSyncedDocumentResult> {
    const validation = validateInternalLinkTarget(target);
    if (validation.kind !== "valid" || !/\.(?:md|markdown)$/iu.test(validation.target)) {
      return { kind: "invalid", message: "That Synced Block target is not a Project-relative Markdown path." };
    }
    const resolved = await this.workspace.resolveProjectManuscriptByRelativeName(owner, projectId, validation.target);
    if (resolved.kind !== "resolved") {
      return { kind: "missing", message: "The Synced Block document is unavailable in this Project." };
    }
    try {
      const text = await readFile(resolved.canonicalPath, "utf8");
      return { kind: "resolved", target: resolved.displayName, fileId: resolved.manuscriptId, displayName: resolved.displayName, text };
    } catch {
      return { kind: "unavailable", message: "The Synced Block document could not be read." };
    }
  }

  /** Open a target which was previously represented by an opaque resolver ID. */
  public async openInternalLinkedFileForOwner(
    owner: object,
    projectId: string,
    fileId: string
  ): Promise<OpenMarkdownResult | DocumentWorkspaceFailure> {
    const resolved = await this.workspace.resolveProjectManuscriptPath(owner, projectId, fileId);
    if (resolved.kind !== "resolved") return resolved;
    return this.markdown.openForOwner(owner, resolved.canonicalPath, projectId);
  }

  public async createFileForOwner(
    owner: object,
    projectId: string,
    fileName: string,
    title: string,
    documentType: ProjectDocumentType,
    parentEntryId: string | null = null,
  ): Promise<ProjectFileCreateResult> {
    const normalizedName = normalizeProjectFileName(fileName);
    const normalizedTitle = normalizeDocumentTitle(title);
    if (!normalizedName || !normalizedTitle || !isDocumentType(documentType)) return PROJECT_FILE_INVALID;

    const created: CreateManuscriptResult = await this.workspace.createManuscriptForOwner(
      owner,
      projectId,
      normalizedName,
      createProjectMarkdown(normalizedTitle, documentType),
      parentEntryId,
    );
    if (created.kind !== "created") {
      return isRootError(created) ? created : PROJECT_FILE_CREATE_FAILED;
    }

    const refreshed = await this.workspace.refreshForOwner(owner, projectId);
    if (refreshed.kind !== "opened") return refreshed;
    const project = await this.enrich(owner, refreshed);
    if (project.kind !== "opened") return project;
    const file = project.files.find((candidate) => candidate.fileId === created.manuscript.manuscriptId);
    if (!file) return PROJECT_FILE_CREATE_FAILED;
    return { kind: "created", project: project.project, files: project.files, file };
  }

  /** Read a current owner-bound root-level file without exposing its path. */
  public async readCopySourceForOwner(
    owner: object,
    projectId: string,
    fileId: string,
  ): Promise<ProjectFileCopySource | DocumentWorkspaceFailure | ProjectFailure> {
    const resolved = await this.workspace.resolveProjectManuscriptPath(owner, projectId, fileId);
    if (resolved.kind !== "resolved") return resolved;
    try {
      const text = await readFile(resolved.canonicalPath, "utf8");
      const metadata = parseProjectMetadata(text, path.basename(resolved.canonicalPath));
      return Object.freeze({
        displayName: path.basename(resolved.canonicalPath),
        text,
        title: metadata.title ?? path.basename(resolved.canonicalPath).replace(/\.(?:md|markdown)$/iu, ""),
        documentType: metadata.documentType,
      });
    } catch {
      return PROJECT_FILE_CREATE_FAILED;
    }
  }

  /**
   * Exclusive-create a separate Project file from a main-process source
   * snapshot. This never overwrites an existing destination or mutates source.
   */
  public async copySourceToProjectForOwner(
    owner: object,
    destinationProjectId: string,
    source: ProjectFileCopySource,
    targetType: ProjectDocumentType,
  ): Promise<ProjectFileCreateResult> {
    if (!isDocumentType(targetType)) return PROJECT_FILE_INVALID;
    const contents = targetType === source.documentType ? source.text : withCopiedDocumentType(source.text, targetType);
    for (let index = 0; index < 1000; index += 1) {
      const fileName = copyCandidateName(source.displayName, index);
      const created = await this.workspace.createManuscriptForOwner(owner, destinationProjectId, fileName, contents);
      if (created.kind !== "created") {
        if (isRootError(created) && created.code === "manuscript-exists") continue;
        return isRootError(created) ? created : PROJECT_FILE_CREATE_FAILED;
      }
      const refreshed = await this.workspace.refreshForOwner(owner, destinationProjectId);
      if (refreshed.kind !== "opened") return refreshed;
      const project = await this.enrich(owner, refreshed);
      if (project.kind !== "opened") return project;
      const file = project.files.find((candidate) => candidate.displayName === fileName);
      return file ? { kind: "created", project: project.project, files: project.files, file } : PROJECT_FILE_CREATE_FAILED;
    }
    return PROJECT_FILE_CREATE_FAILED;
  }

  private async enrich(owner: object, opened: DocumentWorkspaceOpened): Promise<ProjectOpened | DocumentWorkspaceFailure> {
    const files: ProjectFileSummary[] = [];
    const records = await this.workspace.listProjectMarkdownForOwner(owner, opened.document.documentId);
    if (!Array.isArray(records)) return records as DocumentWorkspaceFailure;
    for (const manuscript of records) {
      const resolved = await this.workspace.resolveProjectManuscriptPath(owner, opened.document.documentId, manuscript.manuscriptId);
      if (resolved.kind !== "resolved") {
        files.push({
          fileId: manuscript.manuscriptId,
          displayName: manuscript.displayName,
          documentType: "other",
          title: manuscript.displayName.replace(/\.(?:md|markdown)$/iu, "")
        });
        continue;
      }
      let metadata;
      try {
        metadata = parseProjectMetadata(await readFile(resolved.canonicalPath, "utf8"), manuscript.displayName);
      } catch (_error: unknown) {
        metadata = { documentType: "other" as const, title: manuscript.displayName.replace(/\.(?:md|markdown)$/iu, ""), valid: false };
      }
      files.push({
        fileId: manuscript.manuscriptId,
        displayName: manuscript.displayName,
        documentType: metadata.documentType,
        title: metadata.title ?? manuscript.displayName
      });
    }
    return {
      kind: "opened",
      project: {
        projectId: opened.document.documentId,
        displayName: opened.document.displayName
      },
      files
    };
  }

  private async prepareFolderIdentity(
    rootPath: string,
    parentWorkdeskId?: string | null,
  ): Promise<{ readonly code: string; readonly message: string } | undefined> {
    try {
      await resolveFolderMarker(rootPath, "project", parentWorkdeskId === undefined ? {} : { parentWorkdeskId });
      return undefined;
    } catch (error: unknown) {
      if (error instanceof FolderMarkerError) {
        return Object.freeze({ code: error.code, message: error.message });
      }
      // Folder identity is advisory for opening authored Project files. The
      // workspace open below remains responsible for path and access errors.
      return undefined;
    }
  }

  private async remember(owner: object, projectId: string): Promise<void> {
    const root = await this.workspace.resolveDocumentRoot(owner, projectId);
    if (root.kind !== "resolved") return;
    try {
      await this.pathStore.save(root.canonicalRoot);
    } catch (_error: unknown) {
      // Persistence is a convenience; a successfully opened Project remains usable.
    }
  }
}
