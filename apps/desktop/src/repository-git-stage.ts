/**
 * Main-process-only staging of one already validated local History graph.
 *
 * The stage is deliberately a fresh temporary isomorphic-git repository. It
 * has no working-tree files, copied configuration, alternates, credentials,
 * or connection to the source repository. The returned handle keeps its path
 * private and only permits an ownership-checked disposal.
 */

import * as git from "isomorphic-git";
import type { FsClient } from "isomorphic-git";
import { createHash } from "node:crypto";
import { promises as fs, type Dirent, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, relative, sep } from "node:path";
import type { RepositoryIdentity } from "@maginalia/repository-core" with { "resolution-mode": "import" };
import {
  DEFAULT_MATERIALIZATION_MAX_OBJECT_BYTES,
  MAIN_REF,
  type LocalHistoryObject,
  type LocalHistoryObjectGraph,
  type LocalHistoryObjectType,
} from "./repository-local-history.js";
import { assertSafeRoot, validateRepositoryPath } from "./repository-filesystem.js";

const GIT_FS: FsClient = { promises: fs };
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const STAGE_PREFIX = "maginalia-git-stage-";
const MAX_STAGE_OBJECTS = 100_000;
const MAX_STAGE_OBJECT_BYTES = DEFAULT_MATERIALIZATION_MAX_OBJECT_BYTES;
const STAGE_ERROR_MESSAGES = Object.freeze({
  "invalid-graph": "The local History graph is invalid for staging.",
  "limits-exceeded": "The local History graph exceeds the staging safety limit.",
  "oid-mismatch": "A local History object failed its integrity check.",
  "stage-unsafe": "The temporary staging repository is no longer safely owned.",
  "stage-io": "The temporary staging repository could not be prepared.",
} satisfies Record<RepositoryGitStageErrorCode, string>);

export type RepositoryGitStageErrorCode =
  | "invalid-graph"
  | "limits-exceeded"
  | "oid-mismatch"
  | "stage-unsafe"
  | "stage-io";

export class RepositoryGitStageError extends Error {
  public readonly userMessage: string;

  public constructor(public readonly code: RepositoryGitStageErrorCode) {
    super(STAGE_ERROR_MESSAGES[code]);
    this.name = "RepositoryGitStageError";
    this.userMessage = this.message;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface LocalGitStageOptions {
  /**
   * An existing, main-supplied temporary parent. Renderer paths are not
   * accepted. Tests may inject a private parent; normal callers use OS temp.
   */
  readonly parentDirectory?: string;
}

interface FileIdentity {
  readonly dev: string;
  readonly ino: string;
}

interface OwnedStageDirectory {
  readonly path: string;
  readonly parent: string;
  readonly parentIdentity: FileIdentity;
  readonly identity: FileIdentity;
}

interface PreparedGraph {
  readonly identity: RepositoryIdentity;
  readonly head: string;
  readonly objects: readonly LocalHistoryObject[];
  readonly byOid: ReadonlyMap<string, LocalHistoryObject>;
}

type ParseIdentity = typeof import("@maginalia/repository-core", {
  with: { "resolution-mode": "import" }
})["parseIdentity"];

let parseIdentityPromise: Promise<ParseIdentity> | undefined;

async function loadParseIdentity(): Promise<ParseIdentity> {
  parseIdentityPromise ??= import("@maginalia/repository-core")
    .then((repositoryCore) => repositoryCore.parseIdentity);
  return parseIdentityPromise;
}

function fail(code: RepositoryGitStageErrorCode): never {
  throw new RepositoryGitStageError(code);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function hasExactDataKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  let keys: (string | symbol)[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return false;
  }
  if (keys.length !== expected.length || keys.some((key) => typeof key !== "string" || !expected.includes(key))) {
    return false;
  }
  try {
    return expected.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && "value" in descriptor;
    });
  } catch {
    return false;
  }
}

function readData(value: Record<string, unknown>, key: string): unknown {
  try {
    return value[key];
  } catch {
    fail("invalid-graph");
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && Buffer.from(left).equals(Buffer.from(right));
}

function gitObjectHash(type: LocalHistoryObjectType, bytes: Uint8Array): string {
  const hash = createHash("sha1");
  hash.update(`${type} ${bytes.byteLength}\0`, "utf8");
  hash.update(bytes);
  return hash.digest("hex");
}

function normalizeError(error: unknown, fallback: RepositoryGitStageErrorCode = "stage-io"): RepositoryGitStageError {
  if (error instanceof RepositoryGitStageError) return error;
  return new RepositoryGitStageError(fallback);
}

function objectType(value: unknown): value is LocalHistoryObjectType {
  return value === "commit" || value === "tree" || value === "blob";
}

function validateOid(value: unknown): value is string {
  return typeof value === "string" && SHA1.test(value);
}

function validateGraphRecord(value: unknown): value is Record<string, unknown> {
  return hasExactDataKeys(value, ["identity", "head", "indexHash", "objects"]);
}

async function prepareGraph(graph: LocalHistoryObjectGraph): Promise<PreparedGraph> {
  if (!validateGraphRecord(graph)) fail("invalid-graph");

  const headValue = readData(graph, "head");
  const indexHashValue = readData(graph, "indexHash");
  const objectsValue = readData(graph, "objects");
  const identityValue = readData(graph, "identity");
  if (!validateOid(headValue) || !SHA256.test(typeof indexHashValue === "string" ? indexHashValue : "")) {
    fail("invalid-graph");
  }
  let objectArrayKeys: (string | symbol)[] = [];
  try {
    objectArrayKeys = Array.isArray(objectsValue) ? Reflect.ownKeys(objectsValue) : [];
  } catch {
    fail("invalid-graph");
  }
  const objectArrayShapeIsStrict = Array.isArray(objectsValue)
    && objectArrayKeys.length === objectsValue.length + 1
    && objectArrayKeys.includes("length")
    && objectArrayKeys.every((key) => key === "length" || (
      typeof key === "string"
      && /^(?:0|[1-9][0-9]*)$/.test(key)
      && Number(key) < objectsValue.length
      && Object.prototype.hasOwnProperty.call(objectsValue, key)
    ));
  if (
    !Array.isArray(objectsValue)
    || !objectArrayShapeIsStrict
    || objectsValue.length === 0
    || objectsValue.length > MAX_STAGE_OBJECTS
  ) {
    fail(objectsValue && Array.isArray(objectsValue) && objectsValue.length > MAX_STAGE_OBJECTS
      ? "limits-exceeded"
      : "invalid-graph");
  }

  let identity: RepositoryIdentity;
  try {
    const parseIdentity = await loadParseIdentity();
    identity = parseIdentity(identityValue);
  } catch {
    fail("invalid-graph");
  }

  const byOid = new Map<string, LocalHistoryObject>();
  let totalBytes = 0;
  const copied: LocalHistoryObject[] = [];
  for (const value of objectsValue) {
    if (!hasExactDataKeys(value, ["oid", "type", "bytes"])) fail("invalid-graph");
    const record = value;
    const oidValue = readData(record, "oid");
    const typeValue = readData(record, "type");
    const bytesValue = readData(record, "bytes");
    if (!validateOid(oidValue) || !objectType(typeValue) || !(bytesValue instanceof Uint8Array)) {
      fail("invalid-graph");
    }
    if (bytesValue.byteLength > MAX_STAGE_OBJECT_BYTES || totalBytes > MAX_STAGE_OBJECT_BYTES - bytesValue.byteLength) {
      fail("limits-exceeded");
    }
    if (byOid.has(oidValue)) fail("invalid-graph");
    const bytes = new Uint8Array(bytesValue);
    const object: LocalHistoryObject = Object.freeze({ oid: oidValue, type: typeValue, bytes });
    byOid.set(oidValue, object);
    copied.push(object);
    totalBytes += bytes.byteLength;
  }
  const headObject = byOid.get(headValue);
  if (!headObject || headObject.type !== "commit") fail("invalid-graph");
  return {
    identity,
    head: headValue,
    objects: Object.freeze(copied.sort((left, right) => left.oid.localeCompare(right.oid))),
    byOid,
  };
}

function statIdentity(stat: Stats): FileIdentity {
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("stage-unsafe");
  const dev = String(stat.dev);
  const ino = String(stat.ino);
  // A platform that does not expose a stable positive identity cannot prove
  // ownership before recursive disposal, so fail closed.
  if (dev === "0" || ino === "0" || dev === "NaN" || ino === "NaN") fail("stage-unsafe");
  return Object.freeze({ dev, ino });
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function pathKey(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function assertDirectStageChild(parent: string, candidate: string): void {
  const child = relative(parent, candidate);
  if (child === "" || parse(child).root || child === ".." || child.startsWith(".." + sep) || child.includes(sep)) {
    fail("stage-unsafe");
  }
  if (!child.startsWith(STAGE_PREFIX)) fail("stage-unsafe");
}

async function safeLstatDirectory(pathValue: string): Promise<{ readonly stat: Stats; readonly identity: FileIdentity }> {
  let stat: Stats;
  try {
    stat = await fs.lstat(pathValue);
  } catch {
    fail("stage-unsafe");
  }
  return { stat, identity: statIdentity(stat) };
}

async function createOwnedStage(parentDirectory?: string): Promise<OwnedStageDirectory> {
  const parent = await assertSafeRoot(parentDirectory ?? tmpdir()).catch((error: unknown) => {
    throw normalizeError(error, "stage-unsafe");
  });
  const parentInfo = await safeLstatDirectory(parent);
  const pathValue = await fs.mkdtemp(join(parent, STAGE_PREFIX)).catch(() => fail("stage-io"));
  try {
    const stageInfo = await safeLstatDirectory(pathValue);
    const canonical = await fs.realpath(pathValue);
    if (pathKey(canonical) !== pathKey(pathValue)) fail("stage-unsafe");
    assertDirectStageChild(parent, canonical);
    const canonicalInfo = await safeLstatDirectory(canonical);
    if (!sameIdentity(stageInfo.identity, canonicalInfo.identity)) fail("stage-unsafe");
    return Object.freeze({
      path: canonical,
      parent,
      parentIdentity: parentInfo.identity,
      identity: canonicalInfo.identity,
    });
  } catch (error) {
    // Ownership is proven for mkdtemp's exact path only when the checks above
    // succeeded. If they did not, leave the partial directory for attention.
    throw normalizeError(error, "stage-unsafe");
  }
}

async function removeOwnedStage(stage: OwnedStageDirectory): Promise<void> {
  try {
    const parentInfo = await safeLstatDirectory(stage.parent);
    const parentReal = await fs.realpath(stage.parent);
    if (pathKey(parentReal) !== pathKey(stage.parent) || !sameIdentity(parentInfo.identity, stage.parentIdentity)) {
      fail("stage-unsafe");
    }
  } catch (error) {
    throw normalizeError(error, "stage-unsafe");
  }

  let stageInfo: { readonly stat: Stats; readonly identity: FileIdentity };
  try {
    stageInfo = await safeLstatDirectory(stage.path);
  } catch (error) {
    const cause = error as NodeJS.ErrnoException;
    if (cause?.code === "ENOENT") return;
    throw normalizeError(error, "stage-unsafe");
  }
  if (!sameIdentity(stageInfo.identity, stage.identity)) fail("stage-unsafe");
  const canonical = await fs.realpath(stage.path).catch(() => fail("stage-unsafe"));
  if (pathKey(canonical) !== pathKey(stage.path)) fail("stage-unsafe");
  assertDirectStageChild(stage.parent, canonical);

  try {
    await fs.rm(stage.path, { recursive: true, force: false });
  } catch (error) {
    const cause = error as NodeJS.ErrnoException;
    if (cause?.code !== "ENOENT") throw normalizeError(error, "stage-io");
  }
  try {
    await fs.lstat(stage.path);
    fail("stage-unsafe");
  } catch (error) {
    const cause = error as NodeJS.ErrnoException;
    if (cause?.code !== "ENOENT") throw normalizeError(error, "stage-unsafe");
  }
}

async function assertOwnedStage(stage: OwnedStageDirectory): Promise<void> {
  try {
    const parentInfo = await safeLstatDirectory(stage.parent);
    const parentReal = await fs.realpath(stage.parent);
    if (pathKey(parentReal) !== pathKey(stage.parent) || !sameIdentity(parentInfo.identity, stage.parentIdentity)) {
      fail("stage-unsafe");
    }
    const stageInfo = await safeLstatDirectory(stage.path);
    if (!sameIdentity(stageInfo.identity, stage.identity)) fail("stage-unsafe");
    const canonical = await fs.realpath(stage.path);
    if (pathKey(canonical) !== pathKey(stage.path)) fail("stage-unsafe");
    assertDirectStageChild(stage.parent, canonical);
  } catch (error) {
    throw normalizeError(error, "stage-unsafe");
  }
}

async function ensureFreshGitShape(stagePath: string): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(stagePath, { withFileTypes: true });
  } catch {
    fail("stage-io");
  }
  if (entries.length !== 1 || entries[0]?.name !== ".git" || !entries[0].isDirectory() || entries[0].isSymbolicLink()) {
    fail("invalid-graph");
  }
  const alternates = join(stagePath, ".git", "objects", "info", "alternates");
  try {
    const stat = await fs.lstat(alternates);
    // Even a symlink is unsafe; isomorphic-git did not create this file.
    if (stat.isSymbolicLink() || !stat.isFile()) fail("invalid-graph");
    fail("invalid-graph");
  } catch (error) {
    const cause = error as NodeJS.ErrnoException;
    if (cause?.code !== "ENOENT") throw normalizeError(error, "stage-io");
  }
}

interface RawObject {
  readonly oid?: unknown;
  readonly type?: unknown;
  readonly format?: unknown;
  readonly object?: unknown;
}

function validRawObject(raw: RawObject, expected: LocalHistoryObject): raw is RawObject & {
  readonly oid: string;
  readonly type: LocalHistoryObjectType;
  readonly format: "content";
  readonly object: Uint8Array;
} {
  return raw.format === "content"
    && raw.oid === expected.oid
    && raw.type === expected.type
    && raw.object instanceof Uint8Array
    && gitObjectHash(expected.type, raw.object) === expected.oid
    && sameBytes(raw.object, expected.bytes);
}

function isTreeEntry(value: unknown): value is { readonly mode: unknown; readonly path: unknown; readonly oid: unknown; readonly type: unknown } {
  return hasExactDataKeys(value, ["mode", "path", "oid", "type"]);
}

async function verifyClosure(stagePath: string, graph: PreparedGraph): Promise<void> {
  const reached = new Set<string>();
  const pending = [graph.head];
  while (pending.length > 0) {
    const oid = pending.pop();
    if (!oid || reached.has(oid)) continue;
    const expected = graph.byOid.get(oid);
    if (!expected) fail("invalid-graph");
    reached.add(oid);
    let raw: RawObject;
    try {
      raw = await git.readObject({ fs: GIT_FS, dir: stagePath, oid, format: "content" }) as RawObject;
    } catch {
      fail("invalid-graph");
    }
    if (!validRawObject(raw, expected)) fail("oid-mismatch");

    if (expected.type === "commit") {
      let parsed: Awaited<ReturnType<typeof git.readCommit>>;
      try {
        parsed = await git.readCommit({ fs: GIT_FS, dir: stagePath, oid });
      } catch {
        fail("invalid-graph");
      }
      const commit = parsed.commit;
      if (
        parsed.oid !== oid
        || !commit
        || typeof commit.tree !== "string"
        || !SHA1.test(commit.tree)
        || !Array.isArray(commit.parent)
        || commit.parent.length > 1
        || commit.parent.some((parent) => typeof parent !== "string" || !SHA1.test(parent))
      ) {
        fail("invalid-graph");
      }
      pending.push(commit.tree, ...commit.parent);
    } else if (expected.type === "tree") {
      let parsed: Awaited<ReturnType<typeof git.readTree>>;
      try {
        parsed = await git.readTree({ fs: GIT_FS, dir: stagePath, oid });
      } catch {
        fail("invalid-graph");
      }
      if (parsed.oid !== oid || !Array.isArray(parsed.tree)) fail("invalid-graph");
      const paths = new Set<string>();
      for (const entry of parsed.tree) {
        if (!isTreeEntry(entry)) fail("invalid-graph");
        const mode = readData(entry, "mode");
        const path = readData(entry, "path");
        const child = readData(entry, "oid");
        const type = readData(entry, "type");
        if (
          typeof path !== "string"
          || path.length === 0
          || path.includes("/")
          || path.includes("\\")
          || !validateOid(child)
          || (type === "tree" ? mode !== "040000" : type !== "blob" || (mode !== "100644" && mode !== "100755"))
        ) {
          fail("invalid-graph");
        }
        try {
          validateRepositoryPath(path);
        } catch {
          fail("invalid-graph");
        }
        const pathKeyValue = path.normalize("NFKC").toLowerCase();
        if (paths.has(pathKeyValue)) fail("invalid-graph");
        paths.add(pathKeyValue);
        pending.push(child);
      }
    }
    if (reached.size > MAX_STAGE_OBJECTS || pending.length > MAX_STAGE_OBJECTS) fail("limits-exceeded");
  }
  if (reached.size !== graph.objects.length) fail("invalid-graph");
}

async function verifyMainRef(stagePath: string, head: string): Promise<void> {
  let resolved: string;
  let refs: string[];
  try {
    resolved = await git.resolveRef({ fs: GIT_FS, dir: stagePath, ref: MAIN_REF });
    refs = await git.listRefs({ fs: GIT_FS, dir: stagePath, filepath: "refs" });
  } catch {
    fail("invalid-graph");
  }
  if (resolved !== head || refs.length !== 1 || refs[0] !== "heads/main") fail("invalid-graph");
}

/**
 * Import one validated read-only graph into a fresh temporary repository.
 * Every object is copied and rehashed immediately before its write. A graph
 * that has been mutated, has missing/unreachable objects, or produces a
 * different main ref never yields a successful stage handle.
 */
export async function stageLocalHistoryGraph(
  graph: LocalHistoryObjectGraph,
  options?: LocalGitStageOptions,
): Promise<LocalGitStage> {
  const prepared = await prepareGraph(graph);
  const stage = await createOwnedStage(options?.parentDirectory);
  try {
    await git.init({ fs: GIT_FS, dir: stage.path, defaultBranch: "main" });
    await ensureFreshGitShape(stage.path);

    for (const object of prepared.objects) {
      // Re-read the values from the validated private copy at the write
      // boundary. This catches accidental mutation between validation/writes.
      if (!validateOid(object.oid) || !objectType(object.type) || !(object.bytes instanceof Uint8Array)) {
        fail("invalid-graph");
      }
      if (gitObjectHash(object.type, object.bytes) !== object.oid) fail("oid-mismatch");
      let written: string;
      try {
        written = await git.writeObject({
          fs: GIT_FS,
          dir: stage.path,
          type: object.type,
          object: object.bytes,
          format: "content",
          oid: object.oid,
        });
      } catch {
        fail("stage-io");
      }
      if (written !== object.oid) fail("oid-mismatch");
    }
    try {
      await git.writeRef({ fs: GIT_FS, dir: stage.path, ref: MAIN_REF, value: prepared.head, force: false });
    } catch {
      fail("stage-io");
    }
    await verifyMainRef(stage.path, prepared.head);
    await verifyClosure(stage.path, prepared);
    await ensureFreshGitShape(stage.path);
    return LocalGitStage.create(stage, prepared.head, prepared.objects.length);
  } catch (error) {
    const safeError = normalizeError(error);
    await removeOwnedStage(stage).catch(() => undefined);
    throw safeError;
  }
}

/** Opaque main-only handle for a successfully imported temporary repository. */
export class LocalGitStage {
  #disposed = false;
  #disposing = false;
  #activeOperations = 0;
  #idleWaiters: Array<() => void> = [];
  #disposePromise: Promise<void> | undefined;
  #owned: OwnedStageDirectory;

  public static create(owned: OwnedStageDirectory, head: string, objectCount: number): LocalGitStage {
    return new LocalGitStage(owned, head, objectCount);
  }

  private constructor(
    owned: OwnedStageDirectory,
    public readonly head: string,
    public readonly objectCount: number,
  ) {
    this.#owned = owned;
    Object.freeze(this);
  }

  /**
   * Run trusted main-process work with the stage directory after checking its
   * exact parent/path/inode ownership. The path is never part of the public
   * handle and is not suitable for renderer or untrusted input.
   */
  public async withOwnedDirectory<T>(operation: (directory: string) => Promise<T>): Promise<T> {
    if (this.#disposed || this.#disposing || typeof operation !== "function") fail("stage-unsafe");
    this.#activeOperations += 1;
    try {
      await assertOwnedStage(this.#owned);
      const result = await operation(this.#owned.path);
      await assertOwnedStage(this.#owned);
      return result;
    } finally {
      this.#activeOperations -= 1;
      if (this.#activeOperations === 0) {
        const waiters = this.#idleWaiters.splice(0);
        for (const resolve of waiters) resolve();
      }
    }
  }

  public dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    if (this.#disposed) return Promise.resolve();
    this.#disposing = true;
    this.#disposePromise = (async () => {
      if (this.#activeOperations > 0) {
        await new Promise<void>((resolve) => this.#idleWaiters.push(resolve));
      }
      await removeOwnedStage(this.#owned);
      this.#disposed = true;
    })();
    return this.#disposePromise;
  }
}
