import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import type { FolderMarker, RepositoryIdentity } from "@maginalia/repository-core" with { "resolution-mode": "import" };
import { assertSafeRoot } from "./repository-filesystem.js";
import { ensureFolderMarker, FolderMarkerError, inspectFolderMarkers, repositoryIdentityFromMarker } from "./folder-identity.js";

type RepositoryCore = typeof import("@maginalia/repository-core", { with: { "resolution-mode": "import" } });
let repositoryCorePromise: Promise<RepositoryCore> | undefined;

function loadRepositoryCore(): Promise<RepositoryCore> {
  repositoryCorePromise ??= import("@maginalia/repository-core");
  return repositoryCorePromise;
}

/**
 * Workdesk identity is a typed `.magi` marker. Existing Workdesk registration
 * and History adapters retain their internal `kind: "workbench"` shape.
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

export type WorkdeskLastActiveContext =
  | { readonly kind: "home" }
  | { readonly kind: "project"; readonly projectIdentityId: string };

export interface WorkdeskLocalState {
  readonly schemaVersion: 1;
  readonly primaryWorkdesk?: string;
  readonly workdesks: Readonly<Record<string, {
    readonly projects: Readonly<Record<string, WorkdeskLocalProjectMapping>>;
    readonly lastActiveContext?: WorkdeskLastActiveContext;
  }>>;
}

export interface WorkdeskAdoptionCandidate { readonly kind: "workdesk-adoption-candidate"; }

export interface AdoptedWorkdesk {
  readonly workdesk: ValidatedWorkdesk;
}

export type WorkdeskBoundaryFailureCode =
  | "invalid-workdesk"
  | "marker-conflict"
  | "missing-marker"
  | "legacy-kind-conflict"
  | "marker-write-failed"
  | "local-state-corrupt"
  | "local-state-unreadable"
  | "remembered-workdesk-unavailable"
  | "invalid-project"
  | "wrong-kind"
  | "unsafe-path"
  | "not-child-project"
  | "mapping-conflict"
  | "adoption-not-allowed"
  | "adoption-changed"
  | "adoption-failed"
  | "create-failed";

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
  readonly folderMarker: FolderMarker;
}

export type WorkdeskIdentityRecoveryCode = "marker-conflict" | "missing-marker" | "legacy-kind-conflict";

/** Main-process-only recovery boundary for a Workdesk identity failure. */
export interface WorkdeskIdentityRecoveryRoot {
  readonly kind: "identity-recovery";
  readonly canonicalRoot: string;
  readonly title: string;
  readonly code: WorkdeskIdentityRecoveryCode;
  readonly message: string;
}

export type WorkdeskOpenBoundary = ValidatedWorkdesk | WorkdeskIdentityRecoveryRoot;

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

function sameIdentity(left: RepositoryIdentity, right: RepositoryIdentity): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.id.toLowerCase() === right.id.toLowerCase()
    && left.kind === right.kind
    && left.templateVersion === right.templateVersion;
}

function asFolderMarkerBoundaryError(error: FolderMarkerError, defaultCode: "invalid-workdesk" | "invalid-project"): WorkdeskBoundaryError {
  const code: WorkdeskBoundaryFailureCode = error.code === "marker-conflict" ? "marker-conflict"
    : error.code === "wrong-type" ? "wrong-kind"
      : error.code === "legacy-kind-conflict" ? "legacy-kind-conflict"
        : error.code === "missing-marker" ? "missing-marker"
          : error.code === "marker-write-failed" ? "marker-write-failed"
            : defaultCode;
  return new WorkdeskBoundaryError(code, error.message);
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

function parseLastActiveContext(value: unknown): WorkdeskLastActiveContext | undefined {
  if (!isPlainObject(value)) return undefined;
  if (value.kind === "home" && Reflect.ownKeys(value).length === 1) {
    return Object.freeze({ kind: "home" });
  }
  if (value.kind === "project" && Reflect.ownKeys(value).length === 2 && isUuid(value.projectIdentityId)) {
    return Object.freeze({ kind: "project", projectIdentityId: value.projectIdentityId });
  }
  return undefined;
}

function isTitle(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && Array.from(value).length <= 200
    && !/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u.test(value);
}

interface PreparedWorkdeskAdoption {
  readonly canonicalRoot: string;
  readonly contentFingerprint: string;
}

/** Read-only adoption preflight. Git administrative directories are excluded. */
async function fingerprintAdoptionContents(root: string): Promise<string> {
  const hash = createHash("sha256");
  const normalizedNames = new Map<string, string>();
  let fileCount = 0;
  let totalBytes = 0;

  const visit = async (directory: string, segments: readonly string[]): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      throw new WorkdeskBoundaryError("adoption-not-allowed", "This folder cannot be inspected safely for Workdesk adoption.");
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, "en", { sensitivity: "variant" }));
    for (const entry of entries) {
      if (entry.name.toLocaleLowerCase("en-US") === ".git") continue;
      const relativePath = [...segments, entry.name].join("/");
      if (entry.name.length === 0 || entry.name === "." || entry.name === ".."
        || entry.name.includes("/") || entry.name.includes("\\") || entry.name.includes("\0")
        || Buffer.byteLength(relativePath, "utf8") > 240) {
        throw new WorkdeskBoundaryError("unsafe-path", "This folder contains a path that cannot be adopted safely.");
      }
      const normalized = relativePath.normalize("NFKC").toLocaleLowerCase("en-US");
      const previous = normalizedNames.get(normalized);
      if (previous && previous !== relativePath) {
        throw new WorkdeskBoundaryError("unsafe-path", "This folder contains paths that collide on supported filesystems.");
      }
      normalizedNames.set(normalized, relativePath);
      const absolutePath = path.join(directory, entry.name);
      let stat: Awaited<ReturnType<typeof fs.lstat>>;
      try {
        stat = await fs.lstat(absolutePath);
      } catch {
        throw new WorkdeskBoundaryError("adoption-changed", "Folder contents changed while adoption was being prepared.");
      }
      if (stat.isSymbolicLink()) {
        throw new WorkdeskBoundaryError("unsafe-path", "This folder contains a symbolic link and cannot be adopted safely.");
      }
      hash.update(`${stat.isDirectory() ? "directory" : "file"}\0${relativePath}\0`);
      if (stat.isDirectory()) {
        await visit(absolutePath, [...segments, entry.name]);
        continue;
      }
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024 || stat.nlink > 1) {
        throw new WorkdeskBoundaryError("unsafe-path", "This folder contains a file that cannot be adopted safely.");
      }
      fileCount += 1;
      totalBytes += stat.size;
      if (fileCount > 10_000 || totalBytes > 128 * 1024 * 1024) {
        throw new WorkdeskBoundaryError("unsafe-path", "This folder exceeds the supported Workdesk adoption limits.");
      }
      let bytes: Buffer;
      try {
        bytes = await fs.readFile(absolutePath);
      } catch {
        throw new WorkdeskBoundaryError("adoption-changed", "Folder contents changed while adoption was being prepared.");
      }
      let after: Awaited<ReturnType<typeof fs.lstat>>;
      try {
        after = await fs.lstat(absolutePath);
      } catch {
        throw new WorkdeskBoundaryError("adoption-changed", "Folder contents changed while adoption was being prepared.");
      }
      if (!after.isFile() || after.isSymbolicLink() || after.size !== stat.size
        || after.dev !== stat.dev || after.ino !== stat.ino || bytes.byteLength !== stat.size) {
        throw new WorkdeskBoundaryError("adoption-changed", "Folder contents changed while adoption was being prepared.");
      }
      hash.update(String(bytes.byteLength));
      hash.update("\0");
      hash.update(bytes);
    }
  };

  await visit(root, []);
  return hash.digest("hex");
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

function parseValidLocalState(value: unknown): WorkdeskLocalState | undefined {
  if (!isPlainObject(value) || value.schemaVersion !== WORKDESK_PATH_STORE_SCHEMA_VERSION || !isPlainObject(value.workdesks)) {
    return undefined;
  }
  const primary = value.primaryWorkdesk;
  if (primary !== undefined && (typeof primary !== "string" || !path.isAbsolute(primary))) return undefined;
  const workdesks: Record<string, {
    readonly projects: Record<string, WorkdeskLocalProjectMapping>;
    readonly lastActiveContext?: WorkdeskLastActiveContext;
  }> = {};
  for (const [workdeskId, rawDesk] of Object.entries(value.workdesks)) {
    if (!isUuid(workdeskId) || !isPlainObject(rawDesk) || !isPlainObject(rawDesk.projects)) return undefined;
    const lastActiveContext = rawDesk.lastActiveContext === undefined
      ? undefined
      : parseLastActiveContext(rawDesk.lastActiveContext);
    if (rawDesk.lastActiveContext !== undefined && lastActiveContext === undefined) return undefined;
    const projects: Record<string, WorkdeskLocalProjectMapping> = {};
    for (const [projectId, rawProject] of Object.entries(rawDesk.projects)) {
      if (!isUuid(projectId) || !isPlainObject(rawProject) || typeof rawProject.rootPath !== "string" || !path.isAbsolute(rawProject.rootPath)) {
        return undefined;
      }
      projects[projectId] = Object.freeze({ rootPath: rawProject.rootPath });
    }
    workdesks[workdeskId] = Object.freeze({
      projects: Object.freeze(projects),
      ...(lastActiveContext ? { lastActiveContext } : {}),
    });
  }
  return Object.freeze({
    schemaVersion: 1,
    ...(primary ? { primaryWorkdesk: primary } : {}),
    workdesks: Object.freeze(workdesks),
  });
}

function parseLocalState(value: unknown): WorkdeskLocalState {
  return parseValidLocalState(value) ?? EMPTY_WORKDESK_LOCAL_STATE;
}

export const EMPTY_WORKDESK_LOCAL_STATE: WorkdeskLocalState = Object.freeze({
  schemaVersion: 1,
  workdesks: Object.freeze({}),
});

/** App-local path mapping; no instance is stored in a Workdesk repository. */
export class FileWorkdeskPathStore {
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly filePath: string) {}

  public async load(): Promise<WorkdeskLocalState> {
    try {
      return parseLocalState(JSON.parse(await fs.readFile(this.filePath, "utf8")));
    } catch {
      return EMPTY_WORKDESK_LOCAL_STATE;
    }
  }

  /** Strict startup read: only a genuinely absent state file means first run. */
  public async loadForRestore(): Promise<WorkdeskLocalState | undefined> {
    try {
      const entry = await fs.lstat(this.filePath);
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new WorkdeskBoundaryError(
          "local-state-unreadable",
          "Saved Workdesk information could not be read. Use Open Workdesk to choose another folder."
        );
      }
    } catch (error) {
      if (error instanceof WorkdeskBoundaryError) throw error;
      const code = error instanceof Error && "code" in error ? (error as { code?: unknown }).code : undefined;
      if (code === "ENOENT") return undefined;
      throw new WorkdeskBoundaryError(
        "local-state-unreadable",
        "Saved Workdesk information could not be read. Use Open Workdesk to choose another folder."
      );
    }

    let contents: string;
    try {
      contents = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      throw new WorkdeskBoundaryError(
        "local-state-unreadable",
        "Saved Workdesk information could not be read. Use Open Workdesk to choose another folder."
      );
    }

    let value: unknown;
    try {
      value = JSON.parse(contents);
    } catch {
      throw new WorkdeskBoundaryError(
        "local-state-corrupt",
        "Saved Workdesk information is damaged. Use Open Workdesk to choose another folder."
      );
    }
    const state = parseValidLocalState(value);
    if (!state) {
      throw new WorkdeskBoundaryError(
        "local-state-corrupt",
        "Saved Workdesk information is invalid. Use Open Workdesk to choose another folder."
      );
    }
    return state;
  }

  public async save(state: WorkdeskLocalState): Promise<void> {
    const checked = parseValidLocalState(state);
    if (!checked) {
      throw new WorkdeskBoundaryError("invalid-workdesk", "Workdesk local state is invalid.");
    }
    await this.enqueue(() => this.write(checked));
  }

  /** Serialize read-modify-write updates so simultaneous context changes do not lose fields. */
  public async update(
    transform: (state: WorkdeskLocalState) => WorkdeskLocalState,
    options: { readonly allowCorruptRecovery?: boolean } = {},
  ): Promise<WorkdeskLocalState> {
    return this.enqueue(async () => {
      let current: WorkdeskLocalState;
      try {
        current = await this.loadForRestore() ?? EMPTY_WORKDESK_LOCAL_STATE;
      } catch (error) {
        if (!options.allowCorruptRecovery) throw error;
        current = EMPTY_WORKDESK_LOCAL_STATE;
      }
      const next = parseValidLocalState(transform(current));
      if (!next) throw new WorkdeskBoundaryError("invalid-workdesk", "Workdesk local state is invalid.");
      await this.write(next);
      return next;
    });
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.writeQueue.then(operation, operation);
    this.writeQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async write(checked: WorkdeskLocalState): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const current = await fs.lstat(this.filePath);
      if (!current.isFile() || current.isSymbolicLink()) {
        throw new WorkdeskBoundaryError("local-state-unreadable", "Saved Workdesk information could not be read safely.");
      }
    } catch (error) {
      if (error instanceof WorkdeskBoundaryError) throw error;
      const code = error instanceof Error && "code" in error ? (error as { code?: unknown }).code : undefined;
      if (code !== "ENOENT") throw error;
    }
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
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
  private readonly adoptionCandidates = new WeakMap<object, PreparedWorkdeskAdoption>();
  private readonly adoptionLocks = new Map<string, Promise<void>>();

  public constructor(private readonly localStore: FileWorkdeskPathStore) {}

  public async open(root: string, options: { readonly repairMissingIdentity?: boolean } = {}): Promise<ValidatedWorkdesk> {
    const canonicalRoot = await assertSafeRoot(root);
    let ensured: Awaited<ReturnType<typeof ensureFolderMarker>>;
    try {
      ensured = await ensureFolderMarker(canonicalRoot, "workdesk", { createIfMissing: options.repairMissingIdentity === true });
    } catch (error: unknown) {
      if (error instanceof FolderMarkerError) throw asFolderMarkerBoundaryError(error, "invalid-workdesk");
      throw error;
    }
    const identity = await repositoryIdentityFromMarker(canonicalRoot, ensured.marker, ensured.legacyIdentity);
    if (identity.kind !== "workbench") throw new WorkdeskBoundaryError("wrong-kind", "Choose a Workdesk folder.");
    return Object.freeze({ canonicalRoot, identity, folderMarker: ensured.marker });
  }

  /**
   * Open a Workdesk identity when it is unambiguous, or return a read-only
   * recovery boundary for conflicting valid markers. No marker is selected
   * and no folder or Git state is changed by this inspection path.
   */
  public async openForActivation(
    root: string,
    options: { readonly repairMissingIdentity?: boolean } = {},
  ): Promise<WorkdeskOpenBoundary> {
    try {
      return await this.open(root, options);
    } catch (error) {
      if (!(error instanceof WorkdeskBoundaryError) || error.code !== "marker-conflict") throw error;
      const recovery = await this.inspectIdentityRecoveryForActivation(root, error);
      if (recovery) return recovery;
      throw error;
    }
  }

  /** Inspect known identity failures without inferring or creating an identity. */
  public async inspectIdentityRecoveryForActivation(
    root: string,
    cause: unknown,
  ): Promise<WorkdeskIdentityRecoveryRoot | undefined> {
    if (!(cause instanceof WorkdeskBoundaryError)
      || (cause.code !== "marker-conflict" && cause.code !== "missing-marker" && cause.code !== "legacy-kind-conflict")) return undefined;
    const canonicalRoot = await assertSafeRoot(root);
    const markers = await inspectFolderMarkers(canonicalRoot);
    if (cause.code === "marker-conflict" && markers.kind !== "conflict") return undefined;
    if (cause.code !== "marker-conflict" && markers.kind !== "missing") return undefined;
    const message = cause.code === "marker-conflict"
      ? "This folder contains conflicting valid .magi markers. The readable Workdesk documents are open in recovery mode; resolve the marker conflict before using Projects."
      : cause.code === "legacy-kind-conflict"
        ? "The legacy identity describes a different folder role. Readable documents are open in recovery mode; resolve the legacy identity conflict before adopting this folder as a Workdesk."
        : "This folder has no valid Workdesk identity. Readable documents are open in recovery mode; reopen this folder and choose Adopt to add a Workdesk marker.";
    return Object.freeze({
      kind: "identity-recovery",
      canonicalRoot,
      title: path.basename(canonicalRoot) || "Workdesk",
      code: cause.code,
      message,
    });
  }

  /**
   * Prepare an explicit adoption candidate without changing the selected
   * folder. The returned handle is main-process-only and single-use.
   */
  public async prepareAdoption(root: string): Promise<WorkdeskAdoptionCandidate> {
    if (!path.isAbsolute(root)) {
      throw new WorkdeskBoundaryError("adoption-not-allowed", "Choose an absolute folder to adopt as a Workdesk.");
    }
    const canonicalRoot = await assertSafeRoot(root);
    const markers = await inspectFolderMarkers(canonicalRoot);
    if (markers.kind === "conflict") {
      throw new WorkdeskBoundaryError("marker-conflict", "This folder contains conflicting valid .magi markers. Resolve the marker conflict before continuing.");
    }
    if (markers.kind === "valid") {
      throw new WorkdeskBoundaryError("wrong-kind", markers.marker.type === "workdesk"
        ? "This folder already has a Workdesk identity. Open it again to continue."
        : `This folder is already marked as ${markers.marker.type}.`);
    }
    const contentFingerprint = await fingerprintAdoptionContents(canonicalRoot);
    const candidate: WorkdeskAdoptionCandidate = Object.freeze({ kind: "workdesk-adoption-candidate" });
    this.adoptionCandidates.set(candidate, Object.freeze({ canonicalRoot, contentFingerprint }));
    return candidate;
  }

  /**
   * Adopt only a folder which passed main-process preflight and an explicit
   * user confirmation. Existing files and Git state are left untouched; only
   * the canonical Workdesk folder marker is added.
   */
  public async adoptPreparedFolder(
    candidate: WorkdeskAdoptionCandidate,
  ): Promise<AdoptedWorkdesk> {
    const prepared = this.adoptionCandidates.get(candidate);
    if (!prepared) throw new WorkdeskBoundaryError("adoption-not-allowed", "The Workdesk adoption choice is no longer valid.");
    const key = process.platform === "win32" ? prepared.canonicalRoot.toLocaleLowerCase("en-US") : prepared.canonicalRoot;
    const previous = this.adoptionLocks.get(key);
    let release!: () => void;
    const lock = new Promise<void>((resolve) => { release = resolve; });
    this.adoptionLocks.set(key, lock);
    if (previous) await previous;
    try {
      const current = this.adoptionCandidates.get(candidate);
      if (!current) throw new WorkdeskBoundaryError("adoption-not-allowed", "This Workdesk folder is already being adopted.");
      this.adoptionCandidates.delete(candidate);
      return await this.publishAdoption(current);
    } finally {
      release();
      if (this.adoptionLocks.get(key) === lock) this.adoptionLocks.delete(key);
    }
  }

  private async publishAdoption(
    prepared: PreparedWorkdeskAdoption,
  ): Promise<AdoptedWorkdesk> {
    try {
      const currentRoot = await assertSafeRoot(prepared.canonicalRoot);
      if (!samePath(currentRoot, prepared.canonicalRoot)) {
        throw new WorkdeskBoundaryError("adoption-changed", "The selected Workdesk folder changed after confirmation.");
      }
      const currentMarkers = await inspectFolderMarkers(currentRoot);
      if (currentMarkers.kind !== "missing") {
        throw new WorkdeskBoundaryError(currentMarkers.kind === "conflict" ? "marker-conflict" : "adoption-changed",
          "Folder identity metadata changed after the Workdesk folder was confirmed.");
      }
      if (await fingerprintAdoptionContents(currentRoot) !== prepared.contentFingerprint) {
        throw new WorkdeskBoundaryError("adoption-changed", "Folder contents changed after the Workdesk adoption was confirmed.");
      }
      const ensured = await ensureFolderMarker(currentRoot, "workdesk");
      if (ensured.source === "marker") {
        throw new WorkdeskBoundaryError("adoption-changed", "A Workdesk marker appeared after the folder was confirmed.");
      }
      const workdesk = await this.open(currentRoot);
      const expectedIdentity = await repositoryIdentityFromMarker(currentRoot, ensured.marker, ensured.legacyIdentity);
      if (!sameIdentity(workdesk.identity, expectedIdentity)) {
        throw new WorkdeskBoundaryError("adoption-failed", "The adopted Workdesk identity changed before it could be opened.");
      }
      return Object.freeze({ workdesk });
    } catch (error) {
      if (error instanceof WorkdeskBoundaryError) throw error;
      if (error instanceof FolderMarkerError) {
        const code: WorkdeskBoundaryFailureCode = error.code === "marker-conflict" ? "marker-conflict"
          : error.code === "wrong-type" ? "wrong-kind"
            : error.code === "legacy-kind-conflict" ? "legacy-kind-conflict"
              : "adoption-failed";
        throw new WorkdeskBoundaryError(code, error.message);
      }
      throw new WorkdeskBoundaryError("adoption-failed", error instanceof Error ? error.message : "The Workdesk folder could not be adopted safely.");
    }
  }

  /** Create the ordinary Workdesk files and typed marker without initializing Git. */
  public async create(parentRoot: string, title: string): Promise<ValidatedWorkdesk> {
    let canonicalParent: string;
    let repositoryCore: RepositoryCore;
    let identity: RepositoryIdentity;
    try {
      canonicalParent = await assertSafeRoot(parentRoot);
      repositoryCore = await loadRepositoryCore();
      identity = repositoryCore.createIdentity("workbench", title, randomUUID());
    } catch (error: unknown) {
      throw new WorkdeskBoundaryError("invalid-workdesk", error instanceof Error ? error.message : "The Workdesk name or parent folder is invalid.");
    }

    const folderName = repositoryCore.storageName(identity);
    if (path.basename(folderName) !== folderName || folderName.includes("/") || folderName.includes("\\")) {
      throw new WorkdeskBoundaryError("invalid-workdesk", "The Workdesk folder name is invalid.");
    }
    const destination = path.join(canonicalParent, folderName);
    try {
      await fs.mkdir(destination);
    } catch (error: unknown) {
      throw new WorkdeskBoundaryError("create-failed", error instanceof Error ? error.message : "The Workdesk folder could not be created.");
    }

    try {
      const markerFilename = repositoryCore.canonicalFolderMarkerFilename("workdesk");
      const files = repositoryCore.templateFiles(identity);
      for (const [relativePath, contents] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right))) {
        if (relativePath === markerFilename) continue;
        const segments = relativePath.split("/");
        if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment.includes("\\"))) {
          throw new Error("The Workdesk template contains an unsafe path.");
        }
        let current = destination;
        for (const segment of segments.slice(0, -1)) {
          current = path.join(current, segment);
          try {
            await fs.mkdir(current);
          } catch (error: unknown) {
            const code = error !== null && typeof error === "object" && "code" in error
              ? (error as { readonly code?: unknown }).code
              : undefined;
            if (code !== "EEXIST") throw error;
            const stats = await fs.lstat(current);
            if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("The Workdesk template path is unsafe.");
          }
        }
        await fs.writeFile(path.join(current, segments.at(-1)!), contents, { encoding: "utf8", flag: "wx", mode: 0o644 });
      }
      const ensured = await ensureFolderMarker(destination, "workdesk", { uuidFactory: () => identity.id });
      if (ensured.marker.id.toLowerCase() !== identity.id.toLowerCase()) {
        throw new WorkdeskBoundaryError("create-failed", "The new Workdesk marker did not retain its generated identity.");
      }
      const workdesk = await this.open(destination);
      await this.setPrimary(workdesk);
      return workdesk;
    } catch (error: unknown) {
      if (error instanceof WorkdeskBoundaryError) throw error;
      throw new WorkdeskBoundaryError("create-failed", error instanceof Error ? error.message : "The Workdesk files could not be created safely.");
    }
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
    const stored = await this.localStore.loadForRestore();
    if (!stored || !stored.primaryWorkdesk) return undefined;
    try {
      return await this.open(stored.primaryWorkdesk, { repairMissingIdentity: true });
    } catch {
      throw new WorkdeskBoundaryError(
        "remembered-workdesk-unavailable",
        "The remembered Workdesk is no longer available or valid. Use Open Workdesk to choose another folder."
      );
    }
  }

  /** Restore the remembered root while keeping a marker conflict recoverable. */
  public async restorePrimaryForActivation(): Promise<WorkdeskOpenBoundary | undefined> {
    const stored = await this.localStore.loadForRestore();
    if (!stored || !stored.primaryWorkdesk) return undefined;
    try {
      return await this.openForActivation(stored.primaryWorkdesk, { repairMissingIdentity: true });
    } catch (error) {
      const recovery = await this.inspectIdentityRecoveryForActivation(stored.primaryWorkdesk, error).catch(() => undefined);
      if (recovery) return recovery;
      throw new WorkdeskBoundaryError(
        "remembered-workdesk-unavailable",
        "The remembered Workdesk is no longer available or valid. Use Open Workdesk to choose another folder."
      );
    }
  }

  public async setPrimary(workdesk: ValidatedWorkdesk): Promise<void> {
    await this.localStore.update((current) => Object.freeze({
      ...current,
      primaryWorkdesk: workdesk.canonicalRoot,
    }), { allowCorruptRecovery: true });
  }

  public async lastActiveContext(workdesk: ValidatedWorkdesk): Promise<WorkdeskLastActiveContext> {
    const state = await this.localStore.load();
    return state.workdesks[workdesk.identity.id]?.lastActiveContext ?? Object.freeze({ kind: "home" });
  }

  public async setLastActiveContext(
    workdesk: ValidatedWorkdesk,
    context: WorkdeskLastActiveContext,
  ): Promise<void> {
    const checked = parseLastActiveContext(context);
    if (!checked) throw new WorkdeskBoundaryError("invalid-workdesk", "The saved Workdesk context is invalid.");
    if (checked.kind === "project") {
      const registrations = await this.loadPortableIndex(workdesk);
      if (!registrations.projects.some((entry) => entry.projectIdentityId.toLowerCase() === checked.projectIdentityId.toLowerCase())) {
        throw new WorkdeskBoundaryError("invalid-project", "Only a registered Workdesk Project can be saved as the active context.");
      }
    }
    await this.localStore.update((current) => {
      const desk = current.workdesks[workdesk.identity.id] ?? { projects: Object.freeze({}) };
      return Object.freeze({
        ...current,
        workdesks: Object.freeze({
          ...current.workdesks,
          [workdesk.identity.id]: Object.freeze({ ...desk, lastActiveContext: checked }),
        }),
      });
    });
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
    let ensured: Awaited<ReturnType<typeof ensureFolderMarker>>;
    try {
      ensured = await ensureFolderMarker(canonicalRoot, "project");
    } catch (error: unknown) {
      if (error instanceof FolderMarkerError) throw asFolderMarkerBoundaryError(error, "invalid-project");
      throw error;
    }
    const identity = await repositoryIdentityFromMarker(canonicalRoot, ensured.marker, ensured.legacyIdentity);
    if (identity.kind !== "project") {
      throw new WorkdeskBoundaryError("wrong-kind", "Only a MAGINALIA Project can be registered.");
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
    let ensured: Awaited<ReturnType<typeof ensureFolderMarker>>;
    try {
      ensured = await ensureFolderMarker(canonicalRoot, "project", {
        parentWorkdeskId: workdesk.identity.id,
        createIfMissing: false,
      });
    } catch (error: unknown) {
      if (error instanceof FolderMarkerError) throw asFolderMarkerBoundaryError(error, "invalid-project");
      throw error;
    }
    const identity = await repositoryIdentityFromMarker(canonicalRoot, ensured.marker, ensured.legacyIdentity);
    if (identity.kind !== "project") {
      throw new WorkdeskBoundaryError("wrong-kind", "A Workdesk child must be a MAGINALIA Project.");
    }
    if (ensured.marker.type !== "project"
      || ensured.marker.parent?.toLowerCase() !== workdesk.identity.id.toLowerCase()) {
      throw new WorkdeskBoundaryError("mapping-conflict", "A direct Workdesk Project marker must reference this Workdesk identity.");
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
    await this.localStore.update((stored) => {
      const desk = stored.workdesks[workdesk.identity.id] ?? { projects: Object.freeze({}) };
      const existing = desk.projects[project.projectIdentity.id];
      if (existing && !samePath(existing.rootPath, project.canonicalRoot)) {
        throw new WorkdeskBoundaryError("mapping-conflict", "This Project identity is already mapped to another folder.");
      }
      return Object.freeze({
        ...stored,
        workdesks: Object.freeze({
          ...stored.workdesks,
          [workdesk.identity.id]: Object.freeze({
            ...desk,
            projects: Object.freeze({ ...desk.projects, [project.projectIdentity.id]: Object.freeze({ rootPath: project.canonicalRoot }) }),
          }),
        }),
      });
    });
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

    await this.localStore.update((stored) => {
      const desk = stored.workdesks[workdesk.identity.id];
      if (!desk || !desk.projects[projectIdentityId]) return stored;
      const projects = { ...desk.projects };
      delete projects[projectIdentityId];
      return Object.freeze({
        ...stored,
        workdesks: Object.freeze({
          ...stored.workdesks,
          [workdesk.identity.id]: Object.freeze({
            ...desk,
            projects: Object.freeze(projects),
            ...(desk.lastActiveContext?.kind === "project"
              && desk.lastActiveContext.projectIdentityId.toLowerCase() === projectIdentityId.toLowerCase()
              ? { lastActiveContext: Object.freeze({ kind: "home" as const }) }
              : {}),
          }),
        }),
      });
    });
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
