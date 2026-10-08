import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs";
import { promises as fs, type Stats } from "node:fs";
import { join, isAbsolute, parse, relative, sep } from "node:path";
import type {
  RepositoryIdentity,
  RepositoryKind,
} from "@maginalia/repository-core" with { "resolution-mode": "import" };

type RepositoryCore = typeof import("@maginalia/repository-core", { with: { "resolution-mode": "import" } });

let repositoryCorePromise: Promise<RepositoryCore> | undefined;

async function loadRepositoryCore(): Promise<RepositoryCore> {
  repositoryCorePromise ??= import("@maginalia/repository-core");
  return repositoryCorePromise;
}

import {
  assertSafeRoot,
  captureWorkingTree,
  readIdentity,
  validateRepositoryPath,
  RepositoryFilesystemError,
} from "./repository-filesystem.js";
import {
  createHistorySnapshot,
  initializeRepository,
  inspectIncompleteRepository,
  inspectRepository,
  listLocalHistory,
  materializeHistoryCommit,
  LocalRepositoryError,
  type LocalHistoryEntry,
  type LocalRepositoryOptions,
  type LocalRepositoryInspection,
} from "./repository-local-history.js";

export const INCOMPLETE_MARKER = "MAGINALIA-INCOMPLETE.txt" as const;

const INCOMPLETE_MARKER_TEXT = "This application-created folder is incomplete. Do not use it as a repository until the failed operation is retried or the folder is reviewed.\n";
const CREATE_FAILURE_ENV = "MAGINALIA_TEST_REPOSITORY_CREATE_FAILURE";
const OPAQUE_HANDLE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LocalRepositoryServiceErrorCode =
  | "invalid-owner"
  | "invalid-parent"
  | "parent-missing"
  | "parent-not-directory"
  | "parent-unreadable"
  | "invalid-root"
  | "root-missing"
  | "root-not-directory"
  | "root-unreadable"
  | "invalid-kind"
  | "invalid-title"
  | "invalid-repository-id"
  | "invalid-history-id"
  | "repository-not-owned"
  | "history-not-found"
  | "target-exists"
  | "invalid-identity"
  | "unsafe-path"
  | "unsafe-secret"
  | "unsafe-tree"
  | "limits-exceeded"
  | "changed"
  | "incomplete-marker"
  | "unsupported-state"
  | "io-error";

export interface LocalRepositorySummary {
  readonly repositoryId: string;
  readonly kind: RepositoryKind;
  readonly title: string;
  readonly templateVersion: 1;
}

export interface LocalRepositoryOpened {
  readonly kind: "opened";
  readonly repository: LocalRepositorySummary;
}

export interface LocalRepositoryFailure {
  readonly kind: "error";
  readonly code: LocalRepositoryServiceErrorCode;
  readonly message: string;
}

export type LocalRepositoryResult = LocalRepositoryOpened | LocalRepositoryFailure;

/** Main-process-only result for later repository coordinators. */
export interface LocalRepositoryResolved {
  readonly kind: "resolved";
  readonly canonicalRoot: string;
  readonly identity: RepositoryIdentity;
}

export type LocalRepositoryResolveResult = LocalRepositoryResolved | LocalRepositoryFailure;

/** Renderer-safe handle for one bounded History entry. */
export interface LocalHistoryEntrySummary {
  readonly historyId: string;
  readonly timestampMs: number;
}

export interface LocalHistorySnapshotResult {
  readonly kind: "snapshot";
  readonly repositoryId: string;
  readonly created: boolean;
  readonly latest: LocalHistoryEntrySummary;
}

export interface LocalHistoryListResult {
  readonly kind: "history";
  readonly repositoryId: string;
  readonly entries: readonly LocalHistoryEntrySummary[];
  readonly truncated: boolean;
}

/** Main-process-only resolution for the later history materialization task. */
export interface LocalHistoryResolved {
  readonly kind: "resolved";
  readonly canonicalRoot: string;
  readonly identity: RepositoryIdentity;
  readonly oid: string;
}

export type LocalHistoryResolveResult = LocalHistoryResolved | LocalRepositoryFailure;

export interface LocalRepositoryServiceOptions {
  /** Host UUID generation remains outside the portable repository package. */
  readonly uuidFactory?: () => string;
  /** Main-process resolver for validated Workdesk child repository zones. */
  readonly workdeskHistoryExclusionResolver?: (
    canonicalRoot: string,
    identity: RepositoryIdentity,
  ) => Promise<ReadonlySet<string>>;
}

interface ActiveRepository {
  readonly owner: object;
  readonly repositoryId: string;
  readonly canonicalRoot: string;
  readonly identity: RepositoryIdentity;
}

interface ActiveHistoryEntry {
  readonly owner: object;
  readonly repositoryId: string;
  readonly historyId: string;
  readonly oid: string;
}

const FAILURE_MESSAGES: Readonly<Record<LocalRepositoryServiceErrorCode, string>> = Object.freeze({
  "invalid-owner": "The repository owner is invalid.",
  "invalid-parent": "Choose an absolute parent folder for the repository.",
  "parent-missing": "The repository parent folder is no longer available.",
  "parent-not-directory": "The repository parent is not a directory.",
  "parent-unreadable": "The repository parent folder could not be read safely.",
  "invalid-root": "Choose a usable local repository folder.",
  "root-missing": "The repository folder is no longer available.",
  "root-not-directory": "The selected repository path is not a directory.",
  "root-unreadable": "The repository folder could not be read safely.",
  "invalid-kind": "Choose Project, Workbench, or Private Shelf.",
  "invalid-title": "Enter a repository title (200 Unicode characters or fewer).",
  "invalid-repository-id": "The repository handle is invalid.",
  "invalid-history-id": "The History handle is invalid.",
  "repository-not-owned": "That repository is not open for this owner.",
  "history-not-found": "That saved version is no longer available.",
  "target-exists": "A repository with that technical name already exists.",
  "invalid-identity": "The portable repository identity is invalid.",
  "unsafe-path": "The repository contains an unsafe or unsupported path.",
  "unsafe-secret": "A credential or private-key path or marker cannot be captured.",
  "unsafe-tree": "The repository contains an unsafe or unsupported Git tree.",
  "limits-exceeded": "The repository exceeds the supported file or history limits.",
  changed: "Repository data changed while it was being inspected.",
  "incomplete-marker": "This repository folder is marked incomplete and is not ready for normal use.",
  "unsupported-state": "The local repository has unsupported or unfinished state.",
  "io-error": "The local repository operation could not be completed safely.",
});

function failure(code: LocalRepositoryServiceErrorCode): LocalRepositoryFailure {
  return Object.freeze({ kind: "error", code, message: FAILURE_MESSAGES[code] });
}

function isOwner(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === "string" ? value : undefined;
}

function mapError(error: unknown, fallback: LocalRepositoryServiceErrorCode = "io-error"): LocalRepositoryFailure {
  const code = errorCode(error);
  if (code && code in FAILURE_MESSAGES) {
    return failure(code as LocalRepositoryServiceErrorCode);
  }
  if (error instanceof LocalRepositoryError || error instanceof RepositoryFilesystemError) {
    return failure(fallback);
  }
  return failure(fallback);
}

function mapParentError(error: unknown): LocalRepositoryFailure {
  switch (errorCode(error)) {
    case "root-missing": return failure("parent-missing");
    case "root-not-directory": return failure("parent-not-directory");
    case "root-unreadable": return failure("parent-unreadable");
    case "invalid-root": return failure("invalid-parent");
    default: return mapError(error, "parent-unreadable");
  }
}

function isOpaqueHandle(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_HANDLE.test(value);
}

function sameIdentity(left: RepositoryIdentity, right: RepositoryIdentity): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.id.toLowerCase() === right.id.toLowerCase()
    && left.kind === right.kind
    && left.templateVersion === right.templateVersion;
}

function sameIdentityVersion(left: RepositoryIdentity, right: RepositoryIdentity): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.id === right.id
    && left.kind === right.kind
    && left.templateVersion === right.templateVersion;
}

function pathContains(root: string, candidate: string): boolean {
  const left = process.platform === "win32" ? root.toLowerCase() : root;
  const right = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const child = relative(left, right);
  return child === ""
    || (!child.startsWith(".." + sep) && child !== ".." && !parse(child).root);
}

function assertHistoryCopyParentOutsideSource(parent: string, source: string): void {
  if (pathContains(parent, source) || pathContains(source, parent)) {
    throw new LocalRepositoryError("unsafe-path", FAILURE_MESSAGES["unsafe-path"]);
  }
}

function sameCanonicalPath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

interface OwnedHistoryDestination {
  readonly path: string;
  readonly canonicalRoot: string;
  readonly parentRoot: string;
  readonly sourceRoot: string;
  readonly parentDevice: string;
  readonly parentInode: string;
  readonly destinationDevice: string;
  readonly destinationInode: string;
}

function statIdentity(stat: Stats): { readonly device: string; readonly inode: string } {
  return { device: String(stat.dev), inode: String(stat.ino) };
}

function sameStatIdentity(
  stat: Stats,
  device: string,
  inode: string,
): boolean {
  const identity = statIdentity(stat);
  return identity.device === device && identity.inode === inode;
}

async function validateOwnedHistoryDestination(
  destination: string,
  parent: string,
  source: string,
): Promise<OwnedHistoryDestination> {
  const parentReal = await assertSafeRoot(parent);
  if (!sameCanonicalPath(parentReal, parent)) {
    throw new LocalRepositoryError("unsafe-path", FAILURE_MESSAGES["unsafe-path"]);
  }
  const parentStat = await fs.lstat(parentReal);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new LocalRepositoryError("unsafe-path", FAILURE_MESSAGES["unsafe-path"]);
  }

  const destinationStat = await fs.lstat(destination);
  if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) {
    throw new LocalRepositoryError("unsafe-path", FAILURE_MESSAGES["unsafe-path"]);
  }
  const destinationReal = await fs.realpath(destination);
  if (
    !sameCanonicalPath(destinationReal, destination)
    || !pathContains(parentReal, destinationReal)
    || pathContains(source, destinationReal)
    || pathContains(destinationReal, source)
  ) {
    throw new LocalRepositoryError("unsafe-path", FAILURE_MESSAGES["unsafe-path"]);
  }
  const parentIdentity = statIdentity(parentStat);
  const destinationIdentity = statIdentity(destinationStat);
  return Object.freeze({
    path: destination,
    canonicalRoot: destinationReal,
    parentRoot: parentReal,
    sourceRoot: source,
    parentDevice: parentIdentity.device,
    parentInode: parentIdentity.inode,
    destinationDevice: destinationIdentity.device,
    destinationInode: destinationIdentity.inode,
  });
}

/**
 * Revalidate an allocated destination immediately before any marker repair.
 * A failed validation deliberately performs no filesystem write.
 */
async function revalidateOwnedHistoryDestination(
  owned: OwnedHistoryDestination,
): Promise<string | undefined> {
  try {
    const parentReal = await assertSafeRoot(owned.parentRoot);
    if (
      !sameCanonicalPath(parentReal, owned.parentRoot)
      || pathContains(parentReal, owned.sourceRoot)
      || pathContains(owned.sourceRoot, parentReal)
    ) return undefined;
    const parentStat = await fs.lstat(parentReal);
    if (
      !parentStat.isDirectory()
      || parentStat.isSymbolicLink()
      || !sameStatIdentity(parentStat, owned.parentDevice, owned.parentInode)
    ) return undefined;

    const destinationStat = await fs.lstat(owned.path);
    if (
      !destinationStat.isDirectory()
      || destinationStat.isSymbolicLink()
      || !sameStatIdentity(destinationStat, owned.destinationDevice, owned.destinationInode)
    ) return undefined;
    const destinationReal = await fs.realpath(owned.path);
    if (
      !sameCanonicalPath(destinationReal, owned.canonicalRoot)
      || !pathContains(parentReal, destinationReal)
      || pathContains(owned.sourceRoot, destinationReal)
      || pathContains(destinationReal, owned.sourceRoot)
    ) return undefined;
    return destinationReal;
  } catch {
    return undefined;
  }
}

async function repairOwnedHistoryDestinationMarker(owned: OwnedHistoryDestination): Promise<void> {
  const destinationReal = await revalidateOwnedHistoryDestination(owned);
  if (!destinationReal) return;
  await ensureIncompleteMarker(destinationReal);
}

function makeRepositorySummary(repositoryId: string, identity: RepositoryIdentity): LocalRepositorySummary {
  return Object.freeze({
    repositoryId,
    kind: identity.kind,
    title: identity.title,
    templateVersion: identity.templateVersion,
  });
}

function newRepositoryId(
  identityId: string,
  uuidFactory: () => string,
  excludedId?: string,
): string {
  let repositoryId = uuidFactory();
  let attempts = 0;
  while (
    (repositoryId.toLowerCase() === identityId.toLowerCase()
      || (excludedId !== undefined && repositoryId.toLowerCase() === excludedId.toLowerCase()))
    && attempts < 16
  ) {
    repositoryId = uuidFactory();
    attempts += 1;
  }
  if (
    repositoryId.toLowerCase() === identityId.toLowerCase()
    || (excludedId !== undefined && repositoryId.toLowerCase() === excludedId.toLowerCase())
  ) {
    do {
      repositoryId = randomUUID();
    } while (
      repositoryId.toLowerCase() === identityId.toLowerCase()
      || (excludedId !== undefined && repositoryId.toLowerCase() === excludedId.toLowerCase())
    );
  }
  return repositoryId;
}

function newHistoryId(
  uuidFactory: () => string,
  excludedIds: Set<string>,
): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = uuidFactory();
    if (isOpaqueHandle(candidate) && !excludedIds.has(candidate.toLowerCase())) {
      excludedIds.add(candidate.toLowerCase());
      return candidate;
    }
  }
  let fallback = randomUUID();
  while (excludedIds.has(fallback.toLowerCase())) fallback = randomUUID();
  excludedIds.add(fallback.toLowerCase());
  return fallback;
}

function historySummary(historyId: string, entry: LocalHistoryEntry): LocalHistoryEntrySummary {
  return Object.freeze({ historyId, timestampMs: entry.timestampMs });
}

function maybeInjectCreateFailure(point: "before-templates" | "during-initialize" | "before-marker-removal"): void {
  if (process.env[CREATE_FAILURE_ENV] !== point) return;
  delete process.env[CREATE_FAILURE_ENV];
  throw new Error("Injected repository creation failure.");
}

function linkCount(stat: Stats): number {
  return typeof stat.nlink === "bigint" ? Number(stat.nlink) : stat.nlink;
}

async function verifyRegularMarker(root: string): Promise<void> {
  let stat: Stats;
  try {
    stat = await fs.lstat(join(root, INCOMPLETE_MARKER));
  } catch {
    throw new LocalRepositoryError("incomplete-marker", FAILURE_MESSAGES["incomplete-marker"]);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || linkCount(stat) > 1) {
    throw new LocalRepositoryError("incomplete-marker", FAILURE_MESSAGES["incomplete-marker"]);
  }
}

async function writeIncompleteMarker(root: string): Promise<void> {
  const markerPath = join(root, INCOMPLETE_MARKER);
  const handle = await fs.open(markerPath, "wx", 0o600);
  try {
    await handle.writeFile(Buffer.from(INCOMPLETE_MARKER_TEXT, "utf8"));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await verifyRegularMarker(root);
}

async function ensureIncompleteMarker(root: string): Promise<void> {
  try {
    await verifyRegularMarker(root);
    return;
  } catch {
    try {
      await writeIncompleteMarker(root);
    } catch {
      // The destination is intentionally retained even if a best-effort
      // marker repair is unavailable. No authored or administrative content
      // is removed by the failure path.
    }
  }
}

async function ensureDirectory(root: string, segments: readonly string[]): Promise<void> {
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      await fs.mkdir(current);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new LocalRepositoryError("unsafe-path", FAILURE_MESSAGES["unsafe-path"]);
      }
    }
  }
}

async function writeTemplateFiles(
  root: string,
  identity: RepositoryIdentity,
  options: { readonly parentWorkdeskId?: string | null } = {},
): Promise<void> {
  const repositoryCore = await loadRepositoryCore();
  const files = repositoryCore.templateFiles(identity, options);
  const entries = Object.entries(files).sort(([left], [right]) => left.localeCompare(right));
  for (const [pathValue, contents] of entries) {
    const segments = validateRepositoryPath(pathValue);
    await ensureDirectory(root, segments.slice(0, -1));
    const destination = join(root, ...segments);
    await fs.writeFile(destination, Buffer.from(contents, "utf8"), { flag: "wx", mode: 0o644 });
  }
}

async function verifyTemplateFiles(
  root: string,
  identity: RepositoryIdentity,
  inspection: LocalRepositoryInspection,
  options: { readonly parentWorkdeskId?: string | null } = {},
): Promise<void> {
  const repositoryCore = await loadRepositoryCore();
  const expected = repositoryCore.templateFiles(identity, options);
  const expectedPaths = Object.keys(expected).sort();
  const actualPaths = inspection.trackedFiles.map((file) => file.path).sort();
  if (expectedPaths.length !== actualPaths.length || expectedPaths.some((pathValue, index) => pathValue !== actualPaths[index])) {
    throw new LocalRepositoryError("unsupported-state", FAILURE_MESSAGES["unsupported-state"]);
  }
  for (const [pathValue, contents] of Object.entries(expected)) {
    const segments = validateRepositoryPath(pathValue);
    const destination = join(root, ...segments);
    const stat = await fs.lstat(destination);
    if (!stat.isFile() || stat.isSymbolicLink() || linkCount(stat) > 1) {
      throw new LocalRepositoryError("unsupported-state", FAILURE_MESSAGES["unsupported-state"]);
    }
    const actual = await fs.readFile(destination);
    if (!actual.equals(Buffer.from(contents, "utf8"))) {
      throw new LocalRepositoryError("changed", FAILURE_MESSAGES.changed);
    }
  }
}

async function removeIncompleteMarker(root: string): Promise<void> {
  await verifyRegularMarker(root);
  await fs.unlink(join(root, INCOMPLETE_MARKER));
}

/**
 * The final copy publication point must not yield after the marker is removed.
 * Marker validation is performed asynchronously by the caller immediately
 * before this operation.
 */
function removeIncompleteMarkerSync(root: string): void {
  nodeFs.unlinkSync(join(root, INCOMPLETE_MARKER));
}

function historyCopySuffix(uuidFactory: () => string): string {
  const candidate = uuidFactory();
  if (isOpaqueHandle(candidate)) return candidate.replaceAll("-", "").toLowerCase();
  return randomUUID().replaceAll("-", "").toLowerCase();
}

async function allocateHistoryDestination(
  parent: string,
  identity: RepositoryIdentity,
  uuidFactory: () => string,
): Promise<string> {
  const repositoryCore = await loadRepositoryCore();
  const base = repositoryCore.storageName(identity);
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const name = `${base}-history-${historyCopySuffix(uuidFactory)}`;
    validateRepositoryPath(name);
    const destination = join(parent, name);
    try {
      await fs.mkdir(destination);
      return destination;
    } catch (error) {
      if (errorCode(error) === "EEXIST") continue;
      throw error;
    }
  }
  throw new LocalRepositoryError("target-exists", FAILURE_MESSAGES["target-exists"]);
}

export class LocalRepositoryService {
  private readonly repositories = new Map<string, ActiveRepository>();
  private readonly owners = new Map<object, ActiveRepository>();
  private readonly histories = new Map<string, ActiveHistoryEntry>();
  private readonly uuidFactory: () => string;
  private readonly workdeskHistoryExclusionResolver: LocalRepositoryServiceOptions["workdeskHistoryExclusionResolver"];

  public constructor(options: LocalRepositoryServiceOptions = {}) {
    this.uuidFactory = options.uuidFactory ?? randomUUID;
    this.workdeskHistoryExclusionResolver = options.workdeskHistoryExclusionResolver;
  }

  /** Create a new local repository with marker-first publication. */
  public async createForOwner(
    owner: unknown,
    parentRoot: unknown,
    kind: unknown,
    title: unknown,
    options: { readonly parentWorkdeskId?: string | null } = {},
  ): Promise<LocalRepositoryResult> {
    if (!isOwner(owner)) return failure("invalid-owner");
    if (typeof parentRoot !== "string" || !isAbsolute(parentRoot)) return failure("invalid-parent");

    let parent: string;
    let identity: RepositoryIdentity;
    try {
      parent = await assertSafeRoot(parentRoot);
    } catch (error) {
      return mapParentError(error);
    }
    try {
      const repositoryCore = await loadRepositoryCore();
      identity = repositoryCore.createIdentity(kind as RepositoryKind, title as string, this.uuidFactory());
    } catch (error) {
      return mapError(error, "invalid-kind");
    }

    const repositoryCore = await loadRepositoryCore();
    const destination = join(parent, repositoryCore.storageName(identity));
    try {
      validateRepositoryPath(repositoryCore.storageName(identity));
      await fs.mkdir(destination);
    } catch (error) {
      if (errorCode(error) === "EEXIST") return failure("target-exists");
      return mapError(error);
    }

    try {
      await writeIncompleteMarker(destination);
      maybeInjectCreateFailure("before-templates");
      await writeTemplateFiles(destination, identity, options);
      maybeInjectCreateFailure("during-initialize");
      const initialized = await initializeRepository(destination);
      if (!sameIdentity(initialized.identity, identity)) {
        throw new LocalRepositoryError("invalid-identity", FAILURE_MESSAGES["invalid-identity"]);
      }
      await verifyTemplateFiles(destination, identity, initialized, options);
      maybeInjectCreateFailure("before-marker-removal");
      await removeIncompleteMarker(destination);
      const inspection = await inspectRepository(destination);
      if (!sameIdentity(inspection.identity, identity)) {
        throw new LocalRepositoryError("invalid-identity", FAILURE_MESSAGES["invalid-identity"]);
      }
      const repositoryId = newRepositoryId(identity.id, this.uuidFactory);
      this.replaceOwner(owner, {
        owner,
        repositoryId,
        canonicalRoot: inspection.canonicalRoot,
        identity: inspection.identity,
      });
      return {
        kind: "opened",
        repository: makeRepositorySummary(repositoryId, inspection.identity),
      };
    } catch (error) {
      await ensureIncompleteMarker(destination);
      return mapError(error);
    }
  }

  /** Open an existing complete MAGINALIA repository without mutating it. */
  public async openForOwner(owner: unknown, root: unknown): Promise<LocalRepositoryResult> {
    if (!isOwner(owner)) return failure("invalid-owner");
    if (typeof root !== "string" || !isAbsolute(root)) return failure("invalid-root");
    let inspection: LocalRepositoryInspection;
    try {
      inspection = await this.inspectWithWorkdeskBoundaries(root);
    } catch (error) {
      return mapError(error, "invalid-root");
    }
    const repositoryId = newRepositoryId(inspection.identity.id, this.uuidFactory);
    this.replaceOwner(owner, {
      owner,
      repositoryId,
      canonicalRoot: inspection.canonicalRoot,
      identity: inspection.identity,
    });
    return {
      kind: "opened",
      repository: makeRepositorySummary(repositoryId, inspection.identity),
    };
  }

  /** Revalidate and resolve an owner-bound handle for main-process consumers. */
  public async resolveForOwner(owner: unknown, repositoryId: unknown): Promise<LocalRepositoryResolveResult> {
    if (!isOwner(owner)) return failure("invalid-owner");
    if (!isOpaqueHandle(repositoryId)) return failure("invalid-repository-id");
    const active = this.repositories.get(repositoryId);
    if (!active || active.owner !== owner) return failure("repository-not-owned");
    let inspection: LocalRepositoryInspection;
    try {
      inspection = await this.inspectWithWorkdeskBoundaries(active.canonicalRoot);
    } catch (error) {
      return mapError(error);
    }
    if (!sameIdentity(inspection.identity, active.identity)) return failure("invalid-identity");
    return {
      kind: "resolved",
      canonicalRoot: inspection.canonicalRoot,
      identity: inspection.identity,
    };
  }

  /** Create one local History snapshot from the already-saved working tree. */
  public async createHistoryForOwner(
    owner: unknown,
    repositoryId: unknown,
  ): Promise<LocalHistorySnapshotResult | LocalRepositoryFailure> {
    if (!isOwner(owner)) return failure("invalid-owner");
    if (!isOpaqueHandle(repositoryId)) return failure("invalid-repository-id");
    const resolved = await this.resolveForOwner(owner, repositoryId);
    if (resolved.kind === "error") return resolved;
    try {
      const snapshot = await createHistorySnapshot(
        resolved.canonicalRoot,
        await this.historyOptions(resolved.canonicalRoot, resolved.identity),
      );
      const listing = await listLocalHistory(
        resolved.canonicalRoot,
        100,
        await this.historyOptions(resolved.canonicalRoot, resolved.identity),
      );
      if (listing.entries[0]?.oid !== snapshot.head) return failure("changed");
      const entries = this.replaceHistoryHandles(owner, repositoryId, listing.entries);
      const latest = entries[0];
      if (!latest) return failure("history-not-found");
      return Object.freeze({
        kind: "snapshot",
        repositoryId,
        created: snapshot.created,
        latest,
      });
    } catch (error) {
      return mapError(error);
    }
  }

  /** List bounded saved History versions using owner-bound opaque handles. */
  public async listHistoryForOwner(
    owner: unknown,
    repositoryId: unknown,
  ): Promise<LocalHistoryListResult | LocalRepositoryFailure> {
    if (!isOwner(owner)) return failure("invalid-owner");
    if (!isOpaqueHandle(repositoryId)) return failure("invalid-repository-id");
    const resolved = await this.resolveForOwner(owner, repositoryId);
    if (resolved.kind === "error") return resolved;
    try {
      const listing = await listLocalHistory(
        resolved.canonicalRoot,
        100,
        await this.historyOptions(resolved.canonicalRoot, resolved.identity),
      );
      const entries = this.replaceHistoryHandles(owner, repositoryId, listing.entries);
      return Object.freeze({
        kind: "history",
        repositoryId,
        entries: Object.freeze(entries),
        truncated: listing.truncated,
      });
    } catch (error) {
      return mapError(error);
    }
  }

  /**
   * Resolve a current History handle for main-process materialization only.
   * The stored OID is accepted only after the repository and bounded main
   * chain have both been revalidated.
   */
  public async resolveHistoryForOwner(
    owner: unknown,
    repositoryId: unknown,
    historyId: unknown,
  ): Promise<LocalHistoryResolveResult> {
    if (!isOwner(owner)) return failure("invalid-owner");
    if (!isOpaqueHandle(repositoryId)) return failure("invalid-repository-id");
    if (!isOpaqueHandle(historyId)) return failure("invalid-history-id");
    const active = this.repositories.get(repositoryId);
    if (!active || active.owner !== owner) return failure("repository-not-owned");
    const stored = this.histories.get(historyId);
    if (
      !stored
      || stored.owner !== owner
      || stored.repositoryId !== repositoryId
    ) {
      return failure("history-not-found");
    }
    const resolved = await this.resolveForOwner(owner, repositoryId);
    if (resolved.kind === "error") return resolved;
    try {
      const listing = await listLocalHistory(
        resolved.canonicalRoot,
        100,
        await this.historyOptions(resolved.canonicalRoot, resolved.identity),
      );
      if (!listing.entries.some((entry) => entry.oid === stored.oid)) {
        return failure("history-not-found");
      }
      return Object.freeze({
        kind: "resolved",
        canonicalRoot: resolved.canonicalRoot,
        identity: resolved.identity,
        oid: stored.oid,
      });
    } catch (error) {
      return mapError(error);
    }
  }

  /**
   * Materialize one owner-bound History handle into a fresh repository copy.
   * The destination parent is a main-process value supplied by the native
   * folder chooser; no renderer-provided path or OID is accepted here.
   */
  public async openHistoryCopyForOwner(
    owner: unknown,
    repositoryId: unknown,
    historyId: unknown,
    destinationParentRoot: unknown,
  ): Promise<LocalRepositoryResult> {
    if (!isOwner(owner)) return failure("invalid-owner");
    if (!isOpaqueHandle(repositoryId)) return failure("invalid-repository-id");
    if (!isOpaqueHandle(historyId)) return failure("invalid-history-id");
    if (typeof destinationParentRoot !== "string" || !isAbsolute(destinationParentRoot)) {
      return failure("invalid-parent");
    }

    const activeAtStart = this.repositories.get(repositoryId);
    const historyAtStart = this.histories.get(historyId);
    if (
      !activeAtStart
      || activeAtStart.owner !== owner
      || !historyAtStart
      || historyAtStart.owner !== owner
      || historyAtStart.repositoryId !== repositoryId
    ) {
      return failure("repository-not-owned");
    }
    const resolved = await this.resolveHistoryForOwner(owner, repositoryId, historyId);
    if (resolved.kind === "error") return resolved;
    if (!this.isCurrentHistoryCopySession(owner, repositoryId, historyId, activeAtStart, historyAtStart)) {
      return failure("changed");
    }

    let parent: string;
    try {
      parent = await assertSafeRoot(destinationParentRoot);
      assertHistoryCopyParentOutsideSource(parent, resolved.canonicalRoot);
    } catch (error) {
      return mapParentError(error);
    }

    let destination: string | undefined;
    let ownedDestination: OwnedHistoryDestination | undefined;
    try {
      destination = await allocateHistoryDestination(parent, resolved.identity, this.uuidFactory);

      // Re-canonicalize both sides after exclusive allocation.  This closes
      // the simple parent/destination alias window without claiming complete
      // TOCTOU resistance against later filesystem races.
      const parentAfter = await assertSafeRoot(destinationParentRoot);
      const destinationReal = await assertSafeRoot(destination);
      if (!sameCanonicalPath(parentAfter, parent) || !pathContains(parentAfter, destinationReal)) {
        throw new LocalRepositoryError("unsafe-path", FAILURE_MESSAGES["unsafe-path"]);
      }
      assertHistoryCopyParentOutsideSource(parentAfter, resolved.canonicalRoot);
      if (pathContains(resolved.canonicalRoot, destinationReal)) {
        throw new LocalRepositoryError("unsafe-path", FAILURE_MESSAGES["unsafe-path"]);
      }
      ownedDestination = await validateOwnedHistoryDestination(
        destination,
        parentAfter,
        resolved.canonicalRoot,
      );

      await writeIncompleteMarker(destinationReal);
      if (!this.isCurrentHistoryCopySession(owner, repositoryId, historyId, activeAtStart, historyAtStart)) {
        throw new LocalRepositoryError("changed", FAILURE_MESSAGES.changed);
      }
      const materialized = await materializeHistoryCommit(
        resolved.canonicalRoot,
        destinationReal,
        resolved.oid,
        resolved.identity,
      );
      if (!sameCanonicalPath(materialized.canonicalRoot, destinationReal)) {
        throw new LocalRepositoryError("changed", FAILURE_MESSAGES.changed);
      }

      // Verify through the normal main-only inspection boundary while the
      // marker still protects the destination, then independently recapture
      // its portable working tree/fingerprint before publication.
      await verifyRegularMarker(destinationReal);
      const incompleteInspection = await inspectIncompleteRepository(destinationReal);
      if (
        incompleteInspection.head.toLowerCase() !== resolved.oid.toLowerCase()
        || !sameIdentityVersion(incompleteInspection.identity, resolved.identity)
        || !sameIdentityVersion(materialized.identity, incompleteInspection.identity)
      ) {
        throw new LocalRepositoryError("changed", FAILURE_MESSAGES.changed);
      }
      const trackedPaths = new Set(incompleteInspection.trackedFiles.map((file) => file.path));
      const modeHints = new Map(incompleteInspection.trackedFiles.map((file) => [file.path, file.mode] as const));
      const recaptured = await captureWorkingTree(destinationReal, {
        trackedPaths,
        modeHints,
        isIgnored: incompleteInspection.isIgnored,
        allowIncompleteMarker: true,
      });
      if (recaptured.fingerprint !== materialized.fingerprint) {
        throw new LocalRepositoryError("changed", FAILURE_MESSAGES.changed);
      }

      if (!this.isCurrentHistoryCopySession(owner, repositoryId, historyId, activeAtStart, historyAtStart)) {
        throw new LocalRepositoryError("changed", FAILURE_MESSAGES.changed);
      }

      const copyRepositoryId = newRepositoryId(
        incompleteInspection.identity.id,
        this.uuidFactory,
        repositoryId,
      );
      const preparedRepository: ActiveRepository = Object.freeze({
        owner,
        repositoryId: copyRepositoryId,
        canonicalRoot: incompleteInspection.canonicalRoot,
        identity: incompleteInspection.identity,
      });

      // Marker removal is the final publication write.  The ordinary open
      // invariants were already checked above; after this write only the
      // synchronous owner-map activation remains.  Keep this entire final
      // publication point non-yielding so a stale completion cannot leave an
      // externally openable destination between marker removal and activation.
      await verifyRegularMarker(destinationReal);
      if (!this.isCurrentHistoryCopySession(owner, repositoryId, historyId, activeAtStart, historyAtStart)) {
        throw new LocalRepositoryError("changed", FAILURE_MESSAGES.changed);
      }
      removeIncompleteMarkerSync(destinationReal);
      if (!this.isCurrentHistoryCopySession(owner, repositoryId, historyId, activeAtStart, historyAtStart)) {
        throw new LocalRepositoryError("changed", FAILURE_MESSAGES.changed);
      }
      this.replaceOwner(owner, preparedRepository);
      return {
        kind: "opened",
        repository: makeRepositorySummary(copyRepositoryId, preparedRepository.identity),
      };
    } catch (error) {
      if (ownedDestination) await repairOwnedHistoryDestinationMarker(ownedDestination);
      return mapError(error);
    }
  }

  public dispose(): void {
    this.repositories.clear();
    this.owners.clear();
    this.histories.clear();
  }

  private async historyOptions(
    canonicalRoot: string,
    identity: RepositoryIdentity,
  ): Promise<LocalRepositoryOptions> {
    if (identity.kind !== "workbench" || !this.workdeskHistoryExclusionResolver) return {};
    return { excludedDirectories: await this.workdeskHistoryExclusionResolver(canonicalRoot, identity) };
  }

  /** Reuse the same validated exclusions for every parent inspection/open. */
  private async inspectWithWorkdeskBoundaries(root: string): Promise<LocalRepositoryInspection> {
    const canonicalRoot = await assertSafeRoot(root);
    const identity = await readIdentity(canonicalRoot);
    return inspectRepository(canonicalRoot, await this.historyOptions(canonicalRoot, identity));
  }

  private isCurrentHistoryCopySession(
    owner: object,
    repositoryId: string,
    historyId: string,
    repository: ActiveRepository,
    history: ActiveHistoryEntry,
  ): boolean {
    return this.owners.get(owner) === repository
      && this.repositories.get(repositoryId) === repository
      && this.histories.get(historyId) === history
      && history.owner === owner
      && history.repositoryId === repositoryId;
  }

  private replaceOwner(owner: object, active: ActiveRepository): void {
    const previous = this.owners.get(owner);
    if (previous) {
      this.repositories.delete(previous.repositoryId);
      this.invalidateHistoryForRepository(previous.repositoryId);
    }
    this.owners.set(owner, active);
    this.repositories.set(active.repositoryId, active);
  }

  private invalidateHistoryForRepository(repositoryId: string): void {
    for (const [historyId, stored] of this.histories) {
      if (stored.repositoryId === repositoryId) this.histories.delete(historyId);
    }
  }

  private replaceHistoryHandles(
    owner: object,
    repositoryId: string,
    entries: readonly LocalHistoryEntry[],
  ): readonly LocalHistoryEntrySummary[] {
    const excludedIds = new Set<string>([repositoryId.toLowerCase()]);
    const next: ActiveHistoryEntry[] = entries.map((entry) => {
      const historyId = newHistoryId(this.uuidFactory, excludedIds);
      return Object.freeze({ owner, repositoryId, historyId, oid: entry.oid });
    });
    this.invalidateHistoryForRepository(repositoryId);
    for (const entry of next) this.histories.set(entry.historyId, entry);
    return Object.freeze(next.map((entry, index) => historySummary(entry.historyId, entries[index]!)));
  }
}
