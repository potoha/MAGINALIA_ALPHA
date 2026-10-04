import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { RepositoryIdentity } from "@maginalia/repository-core" with { "resolution-mode": "import" };
import { assertSafeRoot, readIdentity } from "./repository-filesystem.js";
import type { LocalRepositoryResult, LocalRepositoryResolveResult } from "./repository-service.js";

/**
 * Slice H's portable Workdesk extension.  The repository identity remains the
 * pre-existing `kind: "workbench"` contract; this file deliberately does not
 * participate in Repository Core identity parsing or template versioning.
 */
export const WORKDESK_PROJECT_INDEX_PATH = ".maginalia/workdesk-projects.json" as const;
export const WORKDESK_PROJECT_INDEX_SCHEMA_VERSION = 1 as const;
export const WORKDESK_PATH_STORE_SCHEMA_VERSION = 1 as const;

export interface WorkdeskProjectIndexEntry {
  readonly projectIdentityId: string;
  readonly title: string;
}

export interface WorkdeskProjectIndex {
  readonly schemaVersion: 1;
  readonly projects: readonly WorkdeskProjectIndexEntry[];
}

export interface WorkdeskLocalProjectMapping {
  readonly rootPath: string;
}

export interface WorkdeskLocalState {
  readonly schemaVersion: 1;
  readonly primaryWorkdesk?: string;
  readonly workdesks: Readonly<Record<string, { readonly projects: Readonly<Record<string, WorkdeskLocalProjectMapping>> }>>;
}

export type WorkdeskBoundaryFailureCode =
  | "invalid-workdesk"
  | "invalid-project"
  | "wrong-kind"
  | "unsafe-path"
  | "not-child-project"
  | "mapping-conflict";

export class WorkdeskBoundaryError extends Error {
  public constructor(
    public readonly code: WorkdeskBoundaryFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkdeskBoundaryError";
  }
}

export interface ValidatedWorkdesk {
  readonly canonicalRoot: string;
  readonly identity: RepositoryIdentity;
}

/** Main-process-only, validated boundary for a child Project scanner exclusion. */
export interface ValidatedChildProjectBoundary {
  readonly workdeskIdentityId: string;
  readonly projectIdentity: RepositoryIdentity;
  readonly canonicalRoot: string;
}

/** Renderer-safe availability summary.  The canonical root never crosses IPC. */
export interface WorkdeskRegisteredProject {
  readonly projectIdentityId: string;
  readonly title: string;
  readonly available: boolean;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isWithin(root: string, candidate: string): boolean {
  const value = path.relative(root, candidate);
  return value === "" || (!value.startsWith(`..${path.sep}`) && value !== ".." && !path.parse(value).root);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

function isTitle(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && Array.from(value).length <= 200
    && !/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u.test(value);
}

function projectIndexEntry(value: unknown): WorkdeskProjectIndexEntry | undefined {
  if (!isPlainObject(value) || Reflect.ownKeys(value).length !== 2) return undefined;
  const projectIdentityId = value.projectIdentityId;
  const title = value.title;
  if (!isUuid(projectIdentityId) || !isTitle(title)) return undefined;
  return Object.freeze({ projectIdentityId, title });
}

/** Missing/corrupt optional index is a safe empty list, never an open failure. */
export function parseWorkdeskProjectIndex(value: unknown): WorkdeskProjectIndex {
  if (!isPlainObject(value) || value.schemaVersion !== WORKDESK_PROJECT_INDEX_SCHEMA_VERSION || !Array.isArray(value.projects)) {
    return Object.freeze({ schemaVersion: 1, projects: Object.freeze([]) });
  }
  const seen = new Set<string>();
  const entries: WorkdeskProjectIndexEntry[] = [];
  for (const valueEntry of value.projects) {
    const entry = projectIndexEntry(valueEntry);
    if (!entry || seen.has(entry.projectIdentityId.toLowerCase())) {
      return Object.freeze({ schemaVersion: 1, projects: Object.freeze([]) });
    }
    seen.add(entry.projectIdentityId.toLowerCase());
    entries.push(entry);
  }
  return Object.freeze({ schemaVersion: 1, projects: Object.freeze(entries) });
}

function parseLocalState(value: unknown): WorkdeskLocalState {
  if (!isPlainObject(value) || value.schemaVersion !== WORKDESK_PATH_STORE_SCHEMA_VERSION || !isPlainObject(value.workdesks)) {
    return EMPTY_WORKDESK_LOCAL_STATE;
  }
  const primary = value.primaryWorkdesk;
  if (primary !== undefined && (typeof primary !== "string" || !path.isAbsolute(primary))) return EMPTY_WORKDESK_LOCAL_STATE;
  const workdesks: Record<string, { readonly projects: Record<string, WorkdeskLocalProjectMapping> }> = {};
  for (const [workdeskId, rawDesk] of Object.entries(value.workdesks)) {
    if (!isUuid(workdeskId) || !isPlainObject(rawDesk) || !isPlainObject(rawDesk.projects)) return EMPTY_WORKDESK_LOCAL_STATE;
    const projects: Record<string, WorkdeskLocalProjectMapping> = {};
    for (const [projectId, rawProject] of Object.entries(rawDesk.projects)) {
      if (!isUuid(projectId) || !isPlainObject(rawProject) || typeof rawProject.rootPath !== "string" || !path.isAbsolute(rawProject.rootPath)) {
        return EMPTY_WORKDESK_LOCAL_STATE;
      }
      projects[projectId] = Object.freeze({ rootPath: rawProject.rootPath });
    }
    workdesks[workdeskId] = Object.freeze({ projects: Object.freeze(projects) });
  }
  return Object.freeze({
    schemaVersion: 1,
    ...(primary ? { primaryWorkdesk: primary } : {}),
    workdesks: Object.freeze(workdesks),
  });
}

export const EMPTY_WORKDESK_LOCAL_STATE: WorkdeskLocalState = Object.freeze({
  schemaVersion: 1,
  workdesks: Object.freeze({}),
});

/** App-local path mapping; no instance is stored in a Workdesk repository. */
export class FileWorkdeskPathStore {
  public constructor(private readonly filePath: string) {}

  public async load(): Promise<WorkdeskLocalState> {
    try {
      return parseLocalState(JSON.parse(await fs.readFile(this.filePath, "utf8")));
    } catch {
      return EMPTY_WORKDESK_LOCAL_STATE;
    }
  }

  public async save(state: WorkdeskLocalState): Promise<void> {
    const checked = parseLocalState(state);
    if (checked === EMPTY_WORKDESK_LOCAL_STATE && state !== EMPTY_WORKDESK_LOCAL_STATE) {
      throw new WorkdeskBoundaryError("invalid-workdesk", "Workdesk local state is invalid.");
    }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(checked)}\n`, { encoding: "utf8", flag: "wx" });
    try {
      await fs.rename(temporary, this.filePath);
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

export class WorkdeskService {
  public constructor(private readonly localStore: FileWorkdeskPathStore) {}

  public async open(root: string): Promise<ValidatedWorkdesk> {
    const canonicalRoot = await assertSafeRoot(root);
    const identity = await readIdentity(canonicalRoot);
    if (identity.kind !== "workbench") {
      throw new WorkdeskBoundaryError("wrong-kind", "Choose a Workdesk repository.");
    }
    return Object.freeze({ canonicalRoot, identity });
  }

  /**
   * Reuse Repository Core creation exactly as it exists today.  The caller
   * owns the renderer-independent owner token and may surface its bounded
   * result through IPC later; this coordinator never invents a repository
   * kind or writes identity/template files itself.
   */
  public async create(
    owner: object,
    parentRoot: string,
    title: string,
    repositories: {
      createForOwner(owner: unknown, parent: unknown, kind: unknown, title: unknown): Promise<LocalRepositoryResult>;
      resolveForOwner(owner: unknown, repositoryId: unknown): Promise<LocalRepositoryResolveResult>;
    },
  ): Promise<ValidatedWorkdesk | LocalRepositoryResult | LocalRepositoryResolveResult> {
    const created = await repositories.createForOwner(owner, parentRoot, "workbench", title);
    if (created.kind === "error") return created;
    const resolved = await repositories.resolveForOwner(owner, created.repository.repositoryId);
    if (resolved.kind === "error") return resolved;
    if (resolved.identity.kind !== "workbench") {
      throw new WorkdeskBoundaryError("invalid-workdesk", "The newly created Workdesk identity is invalid.");
    }
    const workdesk = Object.freeze({ canonicalRoot: resolved.canonicalRoot, identity: resolved.identity });
    await this.setPrimary(workdesk);
    return workdesk;
  }

  public async loadPortableIndex(workdesk: ValidatedWorkdesk): Promise<WorkdeskProjectIndex> {
    const indexPath = path.join(workdesk.canonicalRoot, ...WORKDESK_PROJECT_INDEX_PATH.split("/"));
    try {
      const stat = await fs.lstat(indexPath);
      if (!stat.isFile() || stat.isSymbolicLink()) return parseWorkdeskProjectIndex(undefined);
      return parseWorkdeskProjectIndex(JSON.parse(await fs.readFile(indexPath, "utf8")));
    } catch {
      return parseWorkdeskProjectIndex(undefined);
    }
  }

  public async savePortableIndex(workdesk: ValidatedWorkdesk, index: WorkdeskProjectIndex): Promise<void> {
    const checked = parseWorkdeskProjectIndex(index);
    if (checked !== index && JSON.stringify(checked) !== JSON.stringify(index)) {
      throw new WorkdeskBoundaryError("invalid-workdesk", "Workdesk Project index is invalid.");
    }
    const directory = path.join(workdesk.canonicalRoot, ".maginalia");
    const indexPath = path.join(directory, "workdesk-projects.json");
    await fs.mkdir(directory, { recursive: true });
    const temporary = `${indexPath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(checked, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    try {
      await fs.rename(temporary, indexPath);
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  /**
   * A courtesy for users who use the root Git repository directly.  History
   * safety must still be enforced by the validated child boundary, not this
   * ignore entry. Existing contents remain byte-for-byte intact except for a
   * final newline and one idempotent `projects/` entry when absent.
   */
  public async ensureProjectsGitignore(workdesk: ValidatedWorkdesk): Promise<void> {
    const ignorePath = path.join(workdesk.canonicalRoot, ".gitignore");
    let contents: string;
    try {
      const stat = await fs.lstat(ignorePath);
      if (!stat.isFile() || stat.isSymbolicLink()) return;
      contents = await fs.readFile(ignorePath, "utf8");
    } catch {
      return;
    }
    if (contents.split(/\r?\n/u).some((line) => line.trim() === "projects/")) return;
    const separator = contents.endsWith("\n") ? "" : "\n";
    const temporary = `${ignorePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${contents}${separator}projects/\n`, { encoding: "utf8", flag: "wx" });
    try {
      await fs.rename(temporary, ignorePath);
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  public async restorePrimary(): Promise<ValidatedWorkdesk | undefined> {
    const stored = await this.localStore.load();
    if (!stored.primaryWorkdesk) return undefined;
    try {
      return await this.open(stored.primaryWorkdesk);
    } catch {
      return undefined;
    }
  }

  public async setPrimary(workdesk: ValidatedWorkdesk): Promise<void> {
    const current = await this.localStore.load();
    await this.localStore.save(Object.freeze({
      ...current,
      primaryWorkdesk: workdesk.canonicalRoot,
    }));
  }

  /**
   * Return only direct, registered child Project zones which parent History
   * may exclude.  This deliberately performs a bounded readdir of
   * `projects/`; it never discovers arbitrary external repositories.
   *
   * A nested Git repository which is corrupt, unregistered, symlinked, or
   * whose portable/app-local mapping disagrees makes History fail closed.
   * Capturing a child Project under the parent would be worse than declining
   * to create one parent snapshot.
   */
  public async historyExcludedChildDirectories(
    root: string,
    identity: RepositoryIdentity,
  ): Promise<ReadonlySet<string>> {
    if (identity.kind !== "workbench") return new Set<string>();
    const workdesk = await this.open(root);
    if (!samePath(workdesk.canonicalRoot, root)
      || workdesk.identity.id !== identity.id
      || workdesk.identity.kind !== identity.kind
      || workdesk.identity.schemaVersion !== identity.schemaVersion
      || workdesk.identity.templateVersion !== identity.templateVersion) {
      throw new WorkdeskBoundaryError("invalid-workdesk", "The Workdesk identity changed while preparing History.");
    }

    const projectsRoot = path.join(workdesk.canonicalRoot, "projects");
    let entries: readonly import("node:fs").Dirent[];
    try {
      const projectsStat = await fs.lstat(projectsRoot);
      if (!projectsStat.isDirectory() || projectsStat.isSymbolicLink()) {
        throw new WorkdeskBoundaryError("unsafe-path", "The Workdesk projects folder is unsafe.");
      }
      const canonicalProjectsRoot = await fs.realpath(projectsRoot);
      if (!samePath(canonicalProjectsRoot, projectsRoot) || !isWithin(workdesk.canonicalRoot, canonicalProjectsRoot)) {
        throw new WorkdeskBoundaryError("unsafe-path", "The Workdesk projects folder is unsafe.");
      }
      entries = await fs.readdir(projectsRoot, { withFileTypes: true });
    } catch (error) {
      if (error instanceof WorkdeskBoundaryError) throw error;
      const code = error instanceof Error && "code" in error ? (error as { code?: unknown }).code : undefined;
      if (code === "ENOENT") return new Set<string>();
      throw new WorkdeskBoundaryError("unsafe-path", "The Workdesk projects folder could not be inspected safely.");
    }

    const index = await this.loadPortableIndex(workdesk);
    const local = await this.localStore.load();
    const mappings = local.workdesks[workdesk.identity.id]?.projects ?? {};
    const excluded = new Set<string>();
    for (const entry of entries) {
      const childRoot = path.join(projectsRoot, entry.name);
      let childStat: Awaited<ReturnType<typeof fs.lstat>>;
      try {
        childStat = await fs.lstat(childRoot);
      } catch {
        throw new WorkdeskBoundaryError("unsafe-path", "A Workdesk child changed while History was being prepared.");
      }
      if (childStat.isSymbolicLink()) {
        throw new WorkdeskBoundaryError("unsafe-path", "A symlink cannot be a Workdesk child Project.");
      }
      if (!childStat.isDirectory()) continue;

      const gitRoot = path.join(childRoot, ".git");
      let gitStat: Awaited<ReturnType<typeof fs.lstat>> | undefined;
      try { gitStat = await fs.lstat(gitRoot); }
      catch (error) {
        const code = error instanceof Error && "code" in error ? (error as { code?: unknown }).code : undefined;
        if (code === "ENOENT") continue;
        throw new WorkdeskBoundaryError("unsafe-path", "A Workdesk child could not be inspected safely.");
      }
      if (!gitStat.isDirectory() || gitStat.isSymbolicLink()) {
        throw new WorkdeskBoundaryError("unsafe-path", "A nested repository must be a validated Workdesk Project.");
      }

      let boundary: ValidatedChildProjectBoundary;
      try {
        boundary = await this.validateDirectChildProject(workdesk, childRoot);
      } catch {
        throw new WorkdeskBoundaryError("invalid-project", "A nested repository is not a valid registered Workdesk Project.");
      }
      const portable = index.projects.find((candidate) => candidate.projectIdentityId.toLowerCase() === boundary.projectIdentity.id.toLowerCase());
      const mapping = mappings[boundary.projectIdentity.id];
      if (!portable || portable.title !== boundary.projectIdentity.title || !mapping || !samePath(mapping.rootPath, boundary.canonicalRoot)) {
        throw new WorkdeskBoundaryError("mapping-conflict", "A nested Project is not registered consistently with this Workdesk.");
      }
      excluded.add(`projects/${entry.name}`);
    }
    return excluded;
  }

  /** Validate a registered external Project without persisting a renderer-supplied path. */
  public async validateExternalProject(root: string): Promise<ValidatedChildProjectBoundary> {
    const canonicalRoot = await assertSafeRoot(root);
    const identity = await readIdentity(canonicalRoot);
    if (identity.kind !== "project") {
      throw new WorkdeskBoundaryError("wrong-kind", "Only a complete MAGINALIA Project can be registered.");
    }
    return Object.freeze({ workdeskIdentityId: "", projectIdentity: identity, canonicalRoot });
  }

  /**
   * Validate an immediate `projects/<child>` repository before exposing it as
   * a history-exclusion boundary. This is main-process-only; callers must not
   * turn arbitrary renderer path text into an exclusion.
   */
  public async validateDirectChildProject(
    workdesk: ValidatedWorkdesk,
    childRoot: string,
    expectedProjectIdentityId?: string,
  ): Promise<ValidatedChildProjectBoundary> {
    const projectsRoot = path.join(workdesk.canonicalRoot, "projects");
    let projectsStat: Awaited<ReturnType<typeof fs.lstat>>;
    let childStat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      projectsStat = await fs.lstat(projectsRoot);
      childStat = await fs.lstat(childRoot);
    } catch {
      throw new WorkdeskBoundaryError("not-child-project", "The child Project is unavailable.");
    }
    if (!projectsStat.isDirectory() || projectsStat.isSymbolicLink() || !childStat.isDirectory() || childStat.isSymbolicLink()) {
      throw new WorkdeskBoundaryError("unsafe-path", "The child Project path is unsafe.");
    }
    const canonicalProjectsRoot = await fs.realpath(projectsRoot);
    const canonicalRoot = await fs.realpath(childRoot);
    if (!samePath(canonicalProjectsRoot, projectsRoot) || !isWithin(workdesk.canonicalRoot, canonicalProjectsRoot)
      || path.dirname(canonicalRoot) !== canonicalProjectsRoot || !isWithin(canonicalProjectsRoot, canonicalRoot)) {
      throw new WorkdeskBoundaryError("not-child-project", "A Workdesk child Project must be directly inside projects.");
    }
    const identity = await readIdentity(canonicalRoot);
    if (identity.kind !== "project") {
      throw new WorkdeskBoundaryError("wrong-kind", "A Workdesk child must be a MAGINALIA Project.");
    }
    if (expectedProjectIdentityId && identity.id.toLowerCase() !== expectedProjectIdentityId.toLowerCase()) {
      throw new WorkdeskBoundaryError("mapping-conflict", "The Project identity does not match its Workdesk registration.");
    }
    return Object.freeze({ workdeskIdentityId: workdesk.identity.id, projectIdentity: identity, canonicalRoot });
  }

  public async registerProjectPath(
    workdesk: ValidatedWorkdesk,
    project: ValidatedChildProjectBoundary,
  ): Promise<void> {
    if (project.workdeskIdentityId && project.workdeskIdentityId.toLowerCase() !== workdesk.identity.id.toLowerCase()) {
      throw new WorkdeskBoundaryError("mapping-conflict", "The Project belongs to a different Workdesk boundary.");
    }
    const stored = await this.localStore.load();
    const desk = stored.workdesks[workdesk.identity.id] ?? { projects: {} };
    const existing = desk.projects[project.projectIdentity.id];
    if (existing && !samePath(existing.rootPath, project.canonicalRoot)) {
      throw new WorkdeskBoundaryError("mapping-conflict", "This Project identity is already mapped to another folder.");
    }
    const next: WorkdeskLocalState = Object.freeze({
      ...stored,
      workdesks: Object.freeze({
        ...stored.workdesks,
        [workdesk.identity.id]: Object.freeze({
          projects: Object.freeze({ ...desk.projects, [project.projectIdentity.id]: Object.freeze({ rootPath: project.canonicalRoot }) }),
        }),
      }),
    });
    await this.localStore.save(next);
  }

  /** Merge one identity/title entry without altering other unavailable registrations. */
  public async registerPortableProject(
    workdesk: ValidatedWorkdesk,
    projectIdentity: RepositoryIdentity,
  ): Promise<WorkdeskProjectIndex> {
    if (projectIdentity.kind !== "project") throw new WorkdeskBoundaryError("wrong-kind", "Only Projects can be registered.");
    const existing = await this.loadPortableIndex(workdesk);
    const found = existing.projects.find((entry) => entry.projectIdentityId.toLowerCase() === projectIdentity.id.toLowerCase());
    if (found && found.title !== projectIdentity.title) {
      throw new WorkdeskBoundaryError("mapping-conflict", "The registered Project title no longer matches its identity.");
    }
    const next = found
      ? existing
      : Object.freeze({ schemaVersion: 1 as const, projects: Object.freeze([...existing.projects, Object.freeze({ projectIdentityId: projectIdentity.id, title: projectIdentity.title })]) });
    await this.savePortableIndex(workdesk, next);
    return next;
  }

  /**
   * Remove only the Workdesk membership. The Project directory and its
   * repository remain untouched, whether it is an external registration or
   * a direct child below `projects/`.
   */
  public async unregisterProject(workdesk: ValidatedWorkdesk, projectIdentityId: string): Promise<void> {
    if (!isUuid(projectIdentityId)) {
      throw new WorkdeskBoundaryError("invalid-project", "The Project identity is invalid.");
    }
    const current = await this.loadPortableIndex(workdesk);
    if (!current.projects.some((entry) => entry.projectIdentityId.toLowerCase() === projectIdentityId.toLowerCase())) {
      throw new WorkdeskBoundaryError("invalid-project", "This Project is not registered with the Workdesk.");
    }
    const next = Object.freeze({
      schemaVersion: 1 as const,
      projects: Object.freeze(current.projects.filter((entry) => entry.projectIdentityId.toLowerCase() !== projectIdentityId.toLowerCase()))
    });
    await this.savePortableIndex(workdesk, next);

    const stored = await this.localStore.load();
    const desk = stored.workdesks[workdesk.identity.id];
    if (!desk || !desk.projects[projectIdentityId]) return;
    const projects = { ...desk.projects };
    delete projects[projectIdentityId];
    await this.localStore.save(Object.freeze({
      ...stored,
      workdesks: Object.freeze({
        ...stored.workdesks,
        [workdesk.identity.id]: Object.freeze({ projects: Object.freeze(projects) })
      })
    }));
  }

  /**
   * List only verified immediate children.  Ordinary data in `projects/` is
   * deliberately ignored: it is not silently promoted, moved, or deleted.
   */
  public async discoverDirectChildProjects(workdesk: ValidatedWorkdesk): Promise<readonly ValidatedChildProjectBoundary[]> {
    const projectsRoot = path.join(workdesk.canonicalRoot, "projects");
    let entries: readonly import("node:fs").Dirent[];
    try {
      const stat = await fs.lstat(projectsRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return Object.freeze([]);
      entries = await fs.readdir(projectsRoot, { withFileTypes: true });
    } catch {
      return Object.freeze([]);
    }
    const discovered: ValidatedChildProjectBoundary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      try {
        discovered.push(await this.validateDirectChildProject(workdesk, path.join(projectsRoot, entry.name)));
      } catch {
        // An arbitrary folder or invalid repository is user data, not an
        // error that should make the Workdesk itself unusable.
      }
    }
    return Object.freeze(discovered);
  }

  /**
   * Safe creation guard. Existing `projects/` contents must all already be
   * recognized direct Project repositories; otherwise creation is rejected
   * rather than claiming an ambiguous user directory as our own.
   */
  public async prepareChildProjectDirectory(workdesk: ValidatedWorkdesk): Promise<string> {
    const projectsRoot = path.join(workdesk.canonicalRoot, "projects");
    try {
      const stat = await fs.lstat(projectsRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new WorkdeskBoundaryError("unsafe-path", "The Workdesk projects folder is unsafe.");
      }
      const entries = await fs.readdir(projectsRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          throw new WorkdeskBoundaryError("mapping-conflict", "The existing projects folder contains unregistered user data.");
        }
        try {
          await this.validateDirectChildProject(workdesk, path.join(projectsRoot, entry.name));
        } catch {
          throw new WorkdeskBoundaryError("mapping-conflict", "The existing projects folder contains unregistered user data.");
        }
      }
    } catch (error) {
      if (error instanceof WorkdeskBoundaryError) throw error;
      try {
        await fs.mkdir(projectsRoot, { recursive: false });
      } catch {
        throw new WorkdeskBoundaryError("unsafe-path", "The Workdesk projects folder could not be prepared safely.");
      }
    }
    return projectsRoot;
  }

  /** Return validated availability without exposing the local mapping path. */
  public async listRegisteredProjects(workdesk: ValidatedWorkdesk): Promise<readonly WorkdeskRegisteredProject[]> {
    const index = await this.loadPortableIndex(workdesk);
    const local = await this.localStore.load();
    const mappings = local.workdesks[workdesk.identity.id]?.projects ?? {};
    const result: WorkdeskRegisteredProject[] = [];
    for (const entry of index.projects) {
      const mapping = mappings[entry.projectIdentityId];
      let available = false;
      if (mapping) {
        try {
          const boundary = await this.validateExternalProject(mapping.rootPath);
          available = boundary.projectIdentity.id.toLowerCase() === entry.projectIdentityId.toLowerCase();
        } catch {
          available = false;
        }
      }
      result.push(Object.freeze({ ...entry, available }));
    }
    return Object.freeze(result);
  }

  /** Resolve a portable registered identity through its validated local mapping. */
  public async resolveRegisteredProject(
    workdesk: ValidatedWorkdesk,
    projectIdentityId: string,
  ): Promise<ValidatedChildProjectBoundary> {
    if (!isUuid(projectIdentityId)) throw new WorkdeskBoundaryError("invalid-project", "The Project identity is invalid.");
    const index = await this.loadPortableIndex(workdesk);
    if (!index.projects.some((entry) => entry.projectIdentityId.toLowerCase() === projectIdentityId.toLowerCase())) {
      throw new WorkdeskBoundaryError("invalid-project", "This Project is not registered with the Workdesk.");
    }
    const local = await this.localStore.load();
    const root = local.workdesks[workdesk.identity.id]?.projects[projectIdentityId]?.rootPath;
    if (!root) throw new WorkdeskBoundaryError("invalid-project", "This Project is unavailable on this PC.");
    const project = await this.validateExternalProject(root);
    if (project.projectIdentity.id.toLowerCase() !== projectIdentityId.toLowerCase()) {
      throw new WorkdeskBoundaryError("mapping-conflict", "The local Project no longer matches its Workdesk registration.");
    }
    return project;
  }
}
