import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
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
  normalizeProjectTitle,
  parseProjectMetadata,
  PROJECT_DOCUMENT_TYPES,
  type ProjectDocumentType,
} from "./project-metadata";

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
}

export interface ProjectFileCreated {
  readonly kind: "created";
  readonly project: ProjectSummary;
  readonly files: readonly ProjectFileSummary[];
  readonly file: ProjectFileSummary;
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

export interface ProjectPathStore {
  load(): Promise<string | null>;
  save(canonicalRoot: string): Promise<void>;
}

export class FileProjectPathStore implements ProjectPathStore {
  public constructor(private readonly filePath: string) {}

  public async load(): Promise<string | null> {
    try {
      const text = await readFile(this.filePath, "utf8");
      const value: unknown = JSON.parse(text);
      if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
      const root = (value as { rootPath?: unknown }).rootPath;
      return typeof root === "string" && path.isAbsolute(root) ? root : null;
    } catch (_error: unknown) {
      return null;
    }
  }

  public async save(canonicalRoot: string): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ rootPath: canonicalRoot })}\n`, "utf8");
    await rename(temporary, this.filePath);
  }
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

function isDocumentType(value: unknown): value is ProjectDocumentType {
  return typeof value === "string" && (PROJECT_DOCUMENT_TYPES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRootError(value: unknown): value is DocumentWorkspaceFailure {
  return isRecord(value) && value.kind === "error" && typeof value.code === "string" && typeof value.message === "string";
}

export class ProjectService {
  public constructor(
    private readonly workspace: DocumentWorkspaceService,
    private readonly markdown: MarkdownFileService,
    private readonly pathStore: ProjectPathStore,
  ) {}

  public async openForOwner(owner: object, rootPath: string): Promise<ProjectResult> {
    const opened = await this.workspace.openForOwner(owner, rootPath);
    if (opened.kind !== "opened") return opened;
    const result = await this.enrich(owner, opened);
    if (result.kind === "opened") await this.remember(owner, opened.document.documentId);
    return result;
  }

  public async createForOwner(owner: object, parentPath: string, title: string): Promise<ProjectCreateResult> {
    const normalizedTitle = normalizeProjectTitle(title);
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
    return this.openForOwner(owner, projectRoot);
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
    const resolved = await this.workspace.resolveManuscriptPath(owner, projectId, fileId);
    if (resolved.kind !== "resolved") return resolved;
    return this.markdown.openForOwner(owner, resolved.canonicalPath);
  }

  public async createFileForOwner(
    owner: object,
    projectId: string,
    fileName: string,
    title: string,
    documentType: ProjectDocumentType,
  ): Promise<ProjectFileCreateResult> {
    const normalizedName = normalizeProjectFileName(fileName);
    const normalizedTitle = normalizeProjectTitle(title);
    if (!normalizedName || !normalizedTitle || !isDocumentType(documentType)) return PROJECT_FILE_INVALID;

    const created: CreateManuscriptResult = await this.workspace.createManuscriptForOwner(
      owner,
      projectId,
      normalizedName,
      createProjectMarkdown(normalizedTitle, documentType),
    );
    if (created.kind !== "created") {
      return isRootError(created) ? created : PROJECT_FILE_CREATE_FAILED;
    }

    const refreshed = await this.workspace.refreshForOwner(owner, projectId);
    if (refreshed.kind !== "opened") return refreshed;
    const project = await this.enrich(owner, refreshed);
    if (project.kind !== "opened") return project;
    const file = project.files.find((candidate) => candidate.displayName === normalizedName);
    if (!file) return PROJECT_FILE_CREATE_FAILED;
    return { kind: "created", project: project.project, files: project.files, file };
  }

  private async enrich(owner: object, opened: DocumentWorkspaceOpened): Promise<ProjectOpened | DocumentWorkspaceFailure> {
    const files: ProjectFileSummary[] = [];
    for (const manuscript of opened.manuscripts) {
      const resolved = await this.workspace.resolveManuscriptPath(owner, opened.document.documentId, manuscript.manuscriptId);
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
