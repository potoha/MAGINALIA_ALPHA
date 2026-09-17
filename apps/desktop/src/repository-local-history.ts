import * as git from "isomorphic-git";
import type { CommitObject, FsClient, TreeObject } from "isomorphic-git";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs, type Dirent, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, relative, sep } from "node:path";
import type { RepositoryIdentity } from "@maginalia/repository-core" with { "resolution-mode": "import" };
import {
  assertSafeRoot as assertFilesystemRoot,
  captureWorkingTree,
  fingerprint as filesystemFingerprint,
  readIdentity as readFilesystemIdentity,
  validateRepositoryPath,
  type CapturedRepositoryFile,
  type ReadIdentityOptions,
  type RepositoryFileMode,
  type RepositoryFilesystemCaptureOptions,
  type RepositoryFilesystemLimits,
} from "./repository-filesystem.js";
import { RepositoryFilesystemError } from "./repository-filesystem.js";

type ParseIdentity = typeof import("@maginalia/repository-core", { with: { "resolution-mode": "import" } })["parseIdentity"];

let parseIdentityPromise: Promise<ParseIdentity> | undefined;

async function loadParseIdentity(): Promise<ParseIdentity> {
  parseIdentityPromise ??= import("@maginalia/repository-core").then((repositoryCore) => repositoryCore.parseIdentity);
  return parseIdentityPromise;
}

export const MAIN_REF = "refs/heads/main" as const;
export const INCOMPLETE_MARKER = "MAGINALIA-INCOMPLETE.txt" as const;
const IDENTITY_PATH = ".maginalia/repository.json";

export const DEFAULT_LOCAL_HISTORY_LIMITS = Object.freeze({
  maxFiles: 10_000,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxPathBytes: 240,
  maxDepth: 64,
  maxEntries: 100_000,
  maxObjects: 100_000,
}) as Readonly<{
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxPathBytes: number;
  maxDepth: number;
  maxEntries: number;
  maxObjects: number;
}>;

export type LocalHistoryLimits = Readonly<{
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxPathBytes: number;
  maxDepth: number;
  maxEntries: number;
  maxObjects: number;
}>;

export type LocalRepositoryErrorCode =
  | "invalid-root"
  | "root-missing"
  | "root-not-directory"
  | "root-unreadable"
  | "invalid-identity"
  | "invalid-path"
  | "unsafe-path"
  | "unsafe-secret"
  | "unsafe-tree"
  | "limits-exceeded"
  | "changed"
  | "incomplete-marker"
  | "unsupported-state"
  | "lock-held"
  | "target-exists"
  | "io-error";

export class LocalRepositoryError extends Error {
  public readonly userMessage: string;

  public constructor(
    public readonly code: LocalRepositoryErrorCode,
    userMessage: string,
  ) {
    super(userMessage);
    this.name = "LocalRepositoryError";
    this.userMessage = userMessage;
  }
}

export { LocalRepositoryError as RepositoryLocalHistoryError };

export interface LocalRepositoryOptions {
  readonly limits?: Partial<LocalHistoryLimits>;
}

export interface LocalHistorySnapshot {
  readonly head: string;
  readonly fingerprint: string;
  readonly created: boolean;
}

/**
 * A bounded, main-only view of one saved local History commit.
 *
 * The timestamp is the validated Git committer timestamp converted from Unix
 * seconds to safe integer milliseconds.  Commit messages, authors, paths,
 * and file contents intentionally do not cross this adapter boundary.
 */
export interface LocalHistoryEntry {
  readonly oid: string;
  readonly timestampMs: number;
}

export interface LocalHistoryListing {
  readonly entries: readonly LocalHistoryEntry[];
  readonly truncated: boolean;
}

export interface TrackedRepositoryFile {
  readonly path: string;
  readonly mode: RepositoryFileMode;
}

export interface LocalRepositoryInspection {
  readonly canonicalRoot: string;
  readonly identity: RepositoryIdentity;
  readonly head: string;
  readonly trackedFiles: readonly TrackedRepositoryFile[];
  readonly isIgnored: (pathValue: string) => Promise<boolean>;
}

export interface LocalRepositoryInitialization extends LocalRepositoryInspection {
  readonly created: true;
  readonly fingerprint: string;
}

const GIT_FS: FsClient = { promises: fs };
const SHA1 = /^[0-9a-f]{40}$/i;
const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const MAX_ADMIN_ENTRIES = 250_000;
const MAX_ADMIN_DEPTH = 64;

const INVALID_ROOT_MESSAGE = "The repository root is not a usable local directory.";
const ROOT_MISSING_MESSAGE = "The repository root is no longer available.";
const ROOT_NOT_DIRECTORY_MESSAGE = "The repository root is not a directory.";
const ROOT_UNREADABLE_MESSAGE = "The repository root could not be read safely.";
const INVALID_IDENTITY_MESSAGE = "The portable repository identity is invalid.";
const INVALID_PATH_MESSAGE = "The repository contains an invalid relative path.";
const UNSAFE_PATH_MESSAGE = "The repository contains an unsafe or unsupported path.";
const UNSAFE_TREE_MESSAGE = "The repository contains an unsafe or unsupported Git tree.";
const UNSAFE_SECRET_MESSAGE = "A credential or private-key path or marker cannot be captured.";
const LIMIT_MESSAGE = "The repository exceeds the supported file, path, or history limits.";
const CHANGED_MESSAGE = "Repository data changed while it was being inspected.";
const INCOMPLETE_MESSAGE = "This repository folder is marked incomplete and is not ready for normal use.";
const UNSUPPORTED_MESSAGE = "The local repository has unsupported or unfinished state.";
const TARGET_EXISTS_MESSAGE = "The repository root already contains a local Git directory.";
const IO_MESSAGE = "The local repository operation could not be completed safely.";

const SNAPSHOT_JOURNAL_PATH = ".git/maginalia-snapshot.json";
const SNAPSHOT_OPERATION_LOCK_PATH = ".git/maginalia-operation.lock";
const SNAPSHOT_INTERRUPT_ENV = "MAGINALIA_TEST_SNAPSHOT_INTERRUPT";
const SNAPSHOT_PAUSE_ENV = "MAGINALIA_TEST_SNAPSHOT_PAUSE";
const SNAPSHOT_RESUME_ENV = "MAGINALIA_TEST_SNAPSHOT_RESUME";
const SNAPSHOT_PAUSE_READY_ENV = "MAGINALIA_TEST_SNAPSHOT_PAUSE_READY";
const SNAPSHOT_HEAD_ENOSPC_ENV = "MAGINALIA_TEST_SNAPSHOT_HEAD_ENOSPC";
const SNAPSHOT_REF_RENAME_FAILURE_ENV = "MAGINALIA_TEST_SNAPSHOT_REF_RENAME_FAILURE";
const MATERIALIZATION_INTERRUPT_ENV = "MAGINALIA_TEST_MATERIALIZATION_INTERRUPT";

const SECRET_FILE_PATTERNS = [
  /^\.env(?:\..*)?$/i,
  /^(?:\.npmrc|\.netrc|\.pypirc|\.dockerconfigjson)$/i,
  /^(?:credentials?|secrets?|tokens?|auth|service-account)(?:[._-].*)?(?:\.(?:json|ya?ml|toml|ini|cfg|conf|txt))?$/i,
  /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|authorized_keys)$/i,
  /\.(?:pem|key|p12|pfx|jks|kdbx|der)$/i,
];

const SECRET_CONTENT_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\b(?:ghp|gho|ghs|ghr|github_pat)_[A-Za-z0-9_]+\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
];

function fail(code: LocalRepositoryErrorCode, message: string): never {
  throw new LocalRepositoryError(code, message);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code;
}

function isMissing(error: unknown): boolean {
  return isNodeError(error, "ENOENT")
    || isNodeError(error, "ENOTDIR")
    || isNodeError(error, "NotFoundError")
    || isNodeError(error, "NoSuchFileError");
}

function mappedCode(error: RepositoryFilesystemError): LocalRepositoryErrorCode {
  switch (error.code) {
    case "incomplete-marker":
      return "incomplete-marker";
    case "root-missing":
    case "root-not-directory":
    case "root-unreadable":
    case "invalid-root":
    case "invalid-identity":
    case "unsafe-path":
    case "unsafe-secret":
    case "unsafe-tree":
    case "limits-exceeded":
    case "changed":
      return error.code;
    case "invalid-path":
      return "invalid-path";
    default:
      return "io-error";
  }
}

function normalizeUnexpected(
  error: unknown,
  fallback: LocalRepositoryErrorCode = "io-error",
): LocalRepositoryError {
  if (error instanceof LocalRepositoryError) return error;
  if (error instanceof RepositoryFilesystemError) {
    const code = mappedCode(error);
    return new LocalRepositoryError(code, code === "incomplete-marker" ? INCOMPLETE_MESSAGE : error.userMessage);
  }
  return new LocalRepositoryError(fallback, IO_MESSAGE);
}

function mapRootError(error: unknown): never {
  if (error instanceof LocalRepositoryError) throw error;
  if (error instanceof RepositoryFilesystemError) throw normalizeUnexpected(error, "invalid-root");
  if (isMissing(error)) fail("root-missing", ROOT_MISSING_MESSAGE);
  if (isNodeError(error, "EACCES") || isNodeError(error, "EPERM")) {
    fail("root-unreadable", ROOT_UNREADABLE_MESSAGE);
  }
  throw normalizeUnexpected(error, "invalid-root");
}

function statSize(stat: Stats): number {
  return typeof stat.size === "bigint" ? Number(stat.size) : stat.size;
}

function linkCount(stat: Stats): number {
  return typeof stat.nlink === "bigint" ? Number(stat.nlink) : stat.nlink;
}

function rejectHardLink(stat: Stats): void {
  if (stat.isFile() && linkCount(stat) > 1) fail("unsafe-path", UNSAFE_PATH_MESSAGE);
}

function mergeLimits(input?: Partial<LocalHistoryLimits>): LocalHistoryLimits {
  const limits = {
    ...DEFAULT_LOCAL_HISTORY_LIMITS,
    ...(input ?? {}),
  };
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    fail("limits-exceeded", LIMIT_MESSAGE);
  }
  return limits;
}

function assertWithin(root: string, candidate: string): void {
  const child = relative(root, candidate);
  if (
    child === ""
    || (!child.startsWith(".." + sep) && child !== ".." && !parse(child).root)
  ) {
    return;
  }
  fail("unsafe-path", UNSAFE_PATH_MESSAGE);
}

async function assertContained(root: string, candidate: string): Promise<void> {
  try {
    assertWithin(root, await fs.realpath(candidate));
  } catch (error) {
    if (isMissing(error)) fail("changed", CHANGED_MESSAGE);
    throw error;
  }
}

async function lstatOrFail(pathValue: string): Promise<Stats> {
  try {
    return await fs.lstat(pathValue);
  } catch (error) {
    if (isMissing(error)) fail("unsupported-state", UNSUPPORTED_MESSAGE);
    throw error;
  }
}

async function assertMarker(rootReal: string): Promise<void> {
  const markerPath = join(rootReal, INCOMPLETE_MARKER);
  let stat: Stats;
  try {
    stat = await fs.lstat(markerPath);
  } catch (error) {
    if (isMissing(error)) fail("incomplete-marker", INCOMPLETE_MESSAGE);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || linkCount(stat) > 1) {
    fail("incomplete-marker", INCOMPLETE_MESSAGE);
  }
}

async function hasMarker(rootReal: string): Promise<boolean> {
  try {
    await assertMarker(rootReal);
    return true;
  } catch (error) {
    if (error instanceof LocalRepositoryError && error.code === "incomplete-marker") {
      const markerPath = join(rootReal, INCOMPLETE_MARKER);
      try {
        await fs.lstat(markerPath);
        throw error;
      } catch (markerError) {
        if (isMissing(markerError)) return false;
        throw error;
      }
    }
    throw error;
  }
}

async function rejectMarker(rootReal: string): Promise<void> {
  if (await hasMarker(rootReal)) fail("incomplete-marker", INCOMPLETE_MESSAGE);
}

export async function assertSafeRoot(root: string): Promise<string> {
  try {
    return await assertFilesystemRoot(root);
  } catch (error) {
    mapRootError(error);
  }
}

export async function readIdentity(
  root: string,
  options?: ReadIdentityOptions,
): Promise<RepositoryIdentity> {
  try {
    const rootReal = await assertFilesystemRoot(root);
    return await readFilesystemIdentity(rootReal, options);
  } catch (error) {
    throw normalizeUnexpected(error, "invalid-identity");
  }
}

async function listRefs(root: string, filepath: string): Promise<string[]> {
  try {
    const refs = await git.listRefs({ fs: GIT_FS, dir: root, filepath });
    return refs.map((ref) => {
      if (ref.startsWith("refs/")) return ref;
      if (filepath === "refs") return "refs/" + ref;
      return filepath + "/" + ref;
    });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function exists(pathValue: string): Promise<boolean> {
  try {
    await fs.lstat(pathValue);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isUnsafeAdminName(name: string): boolean {
  return name.length === 0
    || name === "."
    || name === ".."
    || name.includes("/")
    || name.includes("\\")
    || name.includes("\0")
    || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(name)
    || /[. ]$/u.test(name);
}

function isLockName(name: string): boolean {
  return name.toLowerCase().endsWith(".lock");
}

async function validateAdministrativeTree(
  rootReal: string,
  gitdir: string,
  allowedLockPaths: ReadonlySet<string> = new Set(),
): Promise<void> {
  const rootStat = await lstatOrFail(gitdir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail("unsupported-state", UNSUPPORTED_MESSAGE);
  }
  await assertContained(rootReal, gitdir);
  let visited = 0;

  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > MAX_ADMIN_DEPTH) fail("limits-exceeded", LIMIT_MESSAGE);
    const directoryStat = await lstatOrFail(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      fail("unsupported-state", UNSUPPORTED_MESSAGE);
    }
    const entries: Dirent[] = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_ADMIN_ENTRIES) fail("limits-exceeded", LIMIT_MESSAGE);
      const candidate = join(directory, entry.name);
      const adminPath = relative(gitdir, candidate).split(sep).join("/");
      if (
        isUnsafeAdminName(entry.name)
        || (isLockName(entry.name) && !allowedLockPaths.has(adminPath))
      ) {
        fail("unsupported-state", UNSUPPORTED_MESSAGE);
      }
      const stat = await lstatOrFail(candidate);
      if (stat.isSymbolicLink()) fail("unsupported-state", UNSUPPORTED_MESSAGE);
      rejectHardLink(stat);
      await assertContained(rootReal, candidate);
      if (stat.isDirectory()) await visit(candidate, depth + 1);
      else if (!stat.isFile()) fail("unsupported-state", UNSUPPORTED_MESSAGE);
    }
  }

  await visit(gitdir, 0);
}

async function assertGitState(
  rootReal: string,
  allowedLockPaths: ReadonlySet<string> = new Set(),
): Promise<void> {
  const gitdir = join(rootReal, ".git");
  await validateAdministrativeTree(rootReal, gitdir, allowedLockPaths);

  const headPath = join(gitdir, "HEAD");
  const headText = await fs.readFile(headPath, "utf8").catch((error: unknown) => {
    if (isMissing(error)) fail("unsupported-state", UNSUPPORTED_MESSAGE);
    throw error;
  });
  if (headText.trim() !== "ref: " + MAIN_REF) {
    fail("unsupported-state", UNSUPPORTED_MESSAGE);
  }

  const refs = (await listRefs(rootReal, "refs"))
    .filter((ref) => !allowedLockPaths.has(ref));
  if (refs.length !== 1 || refs[0] !== MAIN_REF) {
    fail("unsupported-state", UNSUPPORTED_MESSAGE);
  }
  for (const statePath of [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "REBASE_HEAD",
    "BISECT_LOG",
    "BISECT_HEAD",
    "AUTO_MERGE",
    "ORIG_HEAD",
    "sequencer",
    "rebase-merge",
    "rebase-apply",
  ]) {
    if (await exists(join(gitdir, statePath))) fail("unsupported-state", UNSUPPORTED_MESSAGE);
  }
}

interface ParsedIndexEntry {
  readonly path: string;
  readonly oid: string;
  readonly mode: RepositoryFileMode;
  readonly stage: 0;
}

function readIndexUInt32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) fail("unsupported-state", UNSUPPORTED_MESSAGE);
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

function readIndexUInt16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.byteLength) fail("unsupported-state", UNSUPPORTED_MESSAGE);
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0, false);
}

function parseIndexEntries(bytes: Uint8Array): readonly ParsedIndexEntry[] {
  if (bytes.byteLength < 32) fail("unsupported-state", UNSUPPORTED_MESSAGE);
  const checksumOffset = bytes.byteLength - 20;
  const expectedChecksum = createHash("sha1").update(bytes.subarray(0, checksumOffset)).digest("hex");
  const actualChecksum = Buffer.from(bytes.subarray(checksumOffset)).toString("hex");
  if (expectedChecksum !== actualChecksum) fail("unsupported-state", UNSUPPORTED_MESSAGE);
  if (Buffer.from(bytes.subarray(0, 4)).toString("ascii") !== "DIRC") {
    fail("unsupported-state", UNSUPPORTED_MESSAGE);
  }
  const version = readIndexUInt32(bytes, 4);
  if (version !== 2 && version !== 3) fail("unsupported-state", UNSUPPORTED_MESSAGE);
  const count = readIndexUInt32(bytes, 8);
  if (!Number.isSafeInteger(count) || count > MAX_ADMIN_ENTRIES) fail("limits-exceeded", LIMIT_MESSAGE);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries: ParsedIndexEntry[] = [];
  const seen = new Set<string>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    if (offset + 62 > checksumOffset) fail("unsupported-state", UNSUPPORTED_MESSAGE);
    const modeValue = readIndexUInt32(bytes, offset + 24);
    const mode = modeValue === 0o100644
      ? "100644"
      : modeValue === 0o100755
        ? "100755"
        : undefined;
    const flags = readIndexUInt16(bytes, offset + 60);
    const stage = (flags >>> 12) & 0x3;
    const extended = (flags & 0x4000) !== 0;
    if (!mode || stage !== 0 || extended || (flags & 0x8000) !== 0) {
      fail("unsupported-state", UNSUPPORTED_MESSAGE);
    }
    const nameStart = offset + 62;
    let nameEnd = nameStart;
    while (nameEnd < checksumOffset && bytes[nameEnd] !== 0) nameEnd += 1;
    if (nameEnd >= checksumOffset) fail("unsupported-state", UNSUPPORTED_MESSAGE);
    let pathValue: string;
    try {
      pathValue = decoder.decode(bytes.subarray(nameStart, nameEnd));
    } catch {
      fail("unsupported-state", UNSUPPORTED_MESSAGE);
    }
    validateRepositoryPath(pathValue);
    const declaredLength = flags & 0x0fff;
    if (declaredLength !== 0x0fff && declaredLength !== nameEnd - nameStart) {
      fail("unsupported-state", UNSUPPORTED_MESSAGE);
    }
    if (seen.has(pathValue)) fail("unsupported-state", UNSUPPORTED_MESSAGE);
    seen.add(pathValue);
    const oid = Buffer.from(bytes.subarray(offset + 40, offset + 60)).toString("hex");
    if (!SHA1.test(oid)) fail("unsupported-state", UNSUPPORTED_MESSAGE);
    const entrySize = 62 + (nameEnd - nameStart) + 1;
    const nextOffset = offset + ((entrySize + 7) & ~7);
    if (nextOffset <= offset || nextOffset > checksumOffset) fail("unsupported-state", UNSUPPORTED_MESSAGE);
    entries.push(Object.freeze({ path: pathValue, oid, mode, stage: 0 }));
    offset = nextOffset;
  }
  return Object.freeze(entries);
}

function assertIndexEntriesMatchTree(
  bytes: Uint8Array,
  files: readonly { readonly path: string; readonly oid: string; readonly mode: RepositoryFileMode }[],
): void {
  const indexed = parseIndexEntries(bytes);
  if (indexed.length !== files.length) fail("unsupported-state", UNSUPPORTED_MESSAGE);
  const expected = new Map(files.map((file) => [file.path, file] as const));
  for (const entry of indexed) {
    const file = expected.get(entry.path);
    if (!file || file.oid !== entry.oid || file.mode !== entry.mode || entry.stage !== 0) {
      fail("unsupported-state", UNSUPPORTED_MESSAGE);
    }
    expected.delete(entry.path);
  }
  if (expected.size !== 0) fail("unsupported-state", UNSUPPORTED_MESSAGE);
}

async function assertIndexMatchesHead(
  rootReal: string,
  files: readonly { readonly path: string; readonly oid: string; readonly mode: RepositoryFileMode }[],
): Promise<void> {
  const indexPath = join(rootReal, ".git", "index");
  const indexStat = await lstatOrFail(indexPath);
  if (!indexStat.isFile() || indexStat.isSymbolicLink()) {
    fail("unsupported-state", UNSUPPORTED_MESSAGE);
  }
  rejectHardLink(indexStat);
  if (statSize(indexStat) > MAX_INDEX_BYTES) fail("limits-exceeded", LIMIT_MESSAGE);

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await fs.readFile(indexPath));
  } catch {
    fail("unsupported-state", UNSUPPORTED_MESSAGE);
  }
  if (bytes.byteLength !== statSize(indexStat)) fail("changed", CHANGED_MESSAGE);
  assertIndexEntriesMatchTree(bytes, files);
}

interface TreeFile extends TrackedRepositoryFile {
  readonly bytes: Uint8Array;
  readonly oid: string;
}

interface TreeReadResult {
  readonly identity: RepositoryIdentity;
  readonly files: readonly TreeFile[];
}

function isSecretPath(pathValue: string): boolean {
  const fileName = pathValue.split("/").at(-1) ?? "";
  return SECRET_FILE_PATTERNS.some((pattern) => pattern.test(fileName));
}

function containsSecretMarker(bytes: Uint8Array): boolean {
  const text = Buffer.from(bytes).toString("utf8");
  return SECRET_CONTENT_PATTERNS.some((pattern) => pattern.test(text));
}

function checkSecret(pathValue: string, bytes: Uint8Array): void {
  if (isSecretPath(pathValue) || containsSecretMarker(bytes)) {
    fail("unsafe-secret", UNSAFE_SECRET_MESSAGE);
  }
}

async function readHeadTree(
  rootReal: string,
  head: string,
  inputLimits?: Partial<LocalHistoryLimits>,
): Promise<TreeReadResult> {
  const limits = mergeLimits(inputLimits);
  if (!SHA1.test(head)) fail("unsafe-tree", UNSAFE_TREE_MESSAGE);
  let commit: Awaited<ReturnType<typeof git.readCommit>>;
  try {
    commit = await git.readCommit({ fs: GIT_FS, dir: rootReal, oid: head });
  } catch {
    fail("unsafe-tree", UNSAFE_TREE_MESSAGE);
  }
  if (!SHA1.test(commit.commit.tree)) fail("unsafe-tree", UNSAFE_TREE_MESSAGE);

  const files: TreeFile[] = [];
  const seen = new Map<string, string>();
  const totals = { files: 0, bytes: 0 };
  let visited = 0;

  async function visit(treeOid: string, prefix: string): Promise<void> {
    if (!SHA1.test(treeOid)) fail("unsafe-tree", UNSAFE_TREE_MESSAGE);
    const depth = prefix.length === 0 ? 0 : prefix.split("/").length;
    if (depth > limits.maxDepth) fail("limits-exceeded", LIMIT_MESSAGE);
    let entries: Awaited<ReturnType<typeof git.readTree>>["tree"];
    try {
      entries = (await git.readTree({ fs: GIT_FS, dir: rootReal, oid: treeOid })).tree;
    } catch {
      fail("unsafe-tree", UNSAFE_TREE_MESSAGE);
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > limits.maxEntries) fail("limits-exceeded", LIMIT_MESSAGE);
      if (visited > limits.maxObjects) fail("limits-exceeded", LIMIT_MESSAGE);
      if (
        entry.path.length === 0
        || entry.path.includes("/")
        || entry.path.includes("\\")
      ) {
        fail("unsafe-tree", UNSAFE_TREE_MESSAGE);
      }
      const pathValue = prefix.length === 0 ? entry.path : prefix + "/" + entry.path;
      validateRepositoryPath(pathValue);
      if (pathValue === INCOMPLETE_MARKER) fail("unsupported-state", UNSUPPORTED_MESSAGE);
      if (Buffer.byteLength(pathValue, "utf8") > limits.maxPathBytes) {
        fail("limits-exceeded", LIMIT_MESSAGE);
      }
      const key = pathValue.normalize("NFKC").toLowerCase();
      if (seen.has(key)) fail("unsafe-tree", UNSAFE_TREE_MESSAGE);
      seen.set(key, pathValue);
      if (entry.type === "tree") {
        await visit(entry.oid, pathValue);
        continue;
      }
      if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
        fail("unsafe-tree", UNSAFE_TREE_MESSAGE);
      }
      let blob: Uint8Array;
      try {
        blob = new Uint8Array((await git.readBlob({ fs: GIT_FS, dir: rootReal, oid: entry.oid })).blob);
      } catch {
        fail("unsafe-tree", UNSAFE_TREE_MESSAGE);
      }
      if (blob.byteLength > limits.maxFileBytes) fail("limits-exceeded", LIMIT_MESSAGE);
      totals.files += 1;
      totals.bytes += blob.byteLength;
      if (totals.files > limits.maxFiles || totals.bytes > limits.maxTotalBytes) {
        fail("limits-exceeded", LIMIT_MESSAGE);
      }
      checkSecret(pathValue, blob);
      files.push({
        path: pathValue,
        mode: entry.mode as RepositoryFileMode,
        bytes: blob,
        oid: entry.oid,
      });
    }
  }

  await visit(commit.commit.tree, "");
  const identityFile = files.find((file) => file.path === IDENTITY_PATH);
  if (!identityFile) fail("invalid-identity", INVALID_IDENTITY_MESSAGE);
  let identity: RepositoryIdentity;
  try {
    const parseIdentity = await loadParseIdentity();
    identity = parseIdentity(JSON.parse(Buffer.from(identityFile.bytes).toString("utf8")));
  } catch {
    fail("invalid-identity", INVALID_IDENTITY_MESSAGE);
  }
  files.sort((left, right) => left.path.localeCompare(right.path, "en", { sensitivity: "variant" }));
  return { identity, files: Object.freeze(files) };
}

function makeIgnorePredicate(rootReal: string): (pathValue: string) => Promise<boolean> {
  return async (pathValue: string): Promise<boolean> => {
    validateRepositoryPath(pathValue);
    if (pathValue === IDENTITY_PATH) return false;
    try {
      return await git.isIgnored({ fs: GIT_FS, dir: rootReal, filepath: pathValue });
    } catch {
      return false;
    }
  };
}

async function inspectInternal(
  rootReal: string,
  options: LocalRepositoryOptions | undefined,
  allowIncompleteMarker: boolean,
  allowedLockPaths: ReadonlySet<string> = new Set(),
): Promise<LocalRepositoryInspection> {
  if (!allowIncompleteMarker) await rejectMarker(rootReal);
  const identity = await readFilesystemIdentity(rootReal, {
    allowIncompleteMarker,
  });
  await assertGitState(rootReal, allowedLockPaths);

  let head: string;
  try {
    head = await git.resolveRef({ fs: GIT_FS, dir: rootReal, ref: MAIN_REF });
  } catch {
    fail("unsupported-state", UNSUPPORTED_MESSAGE);
  }
  if (!SHA1.test(head)) fail("unsafe-tree", UNSAFE_TREE_MESSAGE);
  const tree = await readHeadTree(rootReal, head, options?.limits);
  if (
    tree.identity.id !== identity.id
    || tree.identity.kind !== identity.kind
    || tree.identity.title !== identity.title
    || tree.identity.schemaVersion !== identity.schemaVersion
    || tree.identity.templateVersion !== identity.templateVersion
  ) {
    fail("invalid-identity", INVALID_IDENTITY_MESSAGE);
  }
  await assertIndexMatchesHead(rootReal, tree.files);

  const trackedFiles = Object.freeze(tree.files.map((file): TrackedRepositoryFile => Object.freeze({
    path: file.path,
    mode: file.mode,
  })));
  const trackedPaths = new Set(trackedFiles.map((file) => file.path));
  const modeHints = new Map(trackedFiles.map((file) => [file.path, file.mode] as const));
  const isIgnored = makeIgnorePredicate(rootReal);
  const captureOptions: RepositoryFilesystemCaptureOptions = {
    limits: options?.limits,
    trackedPaths,
    modeHints,
    isIgnored,
    allowIncompleteMarker,
  };
  await captureWorkingTree(rootReal, captureOptions);
  return Object.freeze({
    canonicalRoot: rootReal,
    identity,
    head,
    trackedFiles,
    isIgnored,
  });
}

export async function inspectRepository(
  root: string,
  options?: LocalRepositoryOptions,
): Promise<LocalRepositoryInspection> {
  try {
    const rootReal = await assertFilesystemRoot(root);
    if (await readSnapshotJournal(rootReal)) {
      fail("unsupported-state", UNSUPPORTED_MESSAGE);
    }
    return await inspectInternal(rootReal, options, false);
  } catch (error) {
    throw normalizeUnexpected(error);
  }
}

/**
 * Inspect a freshly materialized repository while its publication marker is
 * still present.  This is main-process-only; callers must remove the marker
 * only after independently verifying the returned identity, head, index, and
 * working tree.
 */
export async function inspectIncompleteRepository(
  root: string,
  options?: LocalRepositoryOptions,
): Promise<LocalRepositoryInspection> {
  try {
    const rootReal = await assertFilesystemRoot(root);
    await assertMarker(rootReal);
    if (await readSnapshotJournal(rootReal)) {
      fail("unsupported-state", UNSUPPORTED_MESSAGE);
    }
    return await inspectInternal(rootReal, options, true);
  } catch (error) {
    throw normalizeUnexpected(error);
  }
}

export const openRepository = inspectRepository;

/**
 * Preserve the historic identity-only validation name for the next service,
 * while inspectRepository exposes the main-only state needed by snapshots.
 */
export async function validateRepository(
  root: string,
  options?: LocalRepositoryOptions,
): Promise<RepositoryIdentity> {
  return (await inspectRepository(root, options)).identity;
}

export async function currentHead(root: string): Promise<string> {
  return (await inspectRepository(root)).head;
}

export const DEFAULT_LOCAL_HISTORY_LIST_LIMIT = 100;

function validateHistoryListLimit(limit: unknown): number {
  if (
    typeof limit !== "number"
    || !Number.isSafeInteger(limit)
    || limit < 1
    || limit > DEFAULT_LOCAL_HISTORY_LIST_LIMIT
  ) {
    fail("limits-exceeded", LIMIT_MESSAGE);
  }
  return limit;
}

function validatedTimestampMilliseconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail("unsupported-state", UNSUPPORTED_MESSAGE);
  }
  const timestampMs = value * 1000;
  if (!Number.isSafeInteger(timestampMs)) {
    fail("unsupported-state", UNSUPPORTED_MESSAGE);
  }
  return timestampMs;
}

/**
 * Read the bounded first-parent History of the current main ref.
 *
 * This operation is deliberately read-only.  `inspectRepository` performs
 * the complete repository/admin/index/working-tree validation first; a
 * journal, lock, incomplete marker, or unsupported state therefore causes a
 * conservative refusal before `git.log` is called.  The final ref check
 * prevents reporting a chain whose active main ref changed during the read.
 */
export async function listLocalHistory(
  root: string,
  limit: number = DEFAULT_LOCAL_HISTORY_LIST_LIMIT,
  options?: LocalRepositoryOptions,
): Promise<LocalHistoryListing> {
  const boundedLimit = validateHistoryListLimit(limit);
  try {
    const inspection = await inspectRepository(root, options);
    let commits: Awaited<ReturnType<typeof git.log>>;
    try {
      commits = await git.log({
        fs: GIT_FS,
        dir: inspection.canonicalRoot,
        ref: MAIN_REF,
        depth: boundedLimit + 1,
      });
    } catch {
      fail("unsupported-state", UNSUPPORTED_MESSAGE);
    }

    if (commits.length === 0) fail("unsupported-state", UNSUPPORTED_MESSAGE);
    if (commits.length > boundedLimit + 1) fail("limits-exceeded", LIMIT_MESSAGE);

    const entries: LocalHistoryEntry[] = [];
    let previousParent: string | undefined;
    for (const [index, item] of commits.entries()) {
      if (
        item === null
        || typeof item !== "object"
        || !SHA1.test(item.oid)
        || !item.commit
        || !Array.isArray(item.commit.parent)
        || item.commit.parent.length > 1
      ) {
        fail("unsupported-state", UNSUPPORTED_MESSAGE);
      }
      const oid = item.oid.toLowerCase();
      const parent = item.commit.parent[0];
      if (parent !== undefined && !SHA1.test(parent)) {
        fail("unsupported-state", UNSUPPORTED_MESSAGE);
      }
      if (index === 0) {
        if (oid !== inspection.head.toLowerCase()) {
          fail("changed", CHANGED_MESSAGE);
        }
      } else if (!previousParent || previousParent.toLowerCase() !== oid) {
        fail("unsupported-state", UNSUPPORTED_MESSAGE);
      }
      entries.push(Object.freeze({
        oid,
        timestampMs: validatedTimestampMilliseconds(item.commit.committer?.timestamp),
      }));
      previousParent = parent;
    }

    let activeHead: string;
    try {
      activeHead = await git.resolveRef({ fs: GIT_FS, dir: inspection.canonicalRoot, ref: MAIN_REF });
    } catch {
      fail("changed", CHANGED_MESSAGE);
    }
    if (!SHA1.test(activeHead) || activeHead.toLowerCase() !== inspection.head.toLowerCase()) {
      fail("changed", CHANGED_MESSAGE);
    }

    const truncated = commits.length > boundedLimit;
    return Object.freeze({
      entries: Object.freeze(entries.slice(0, boundedLimit)),
      truncated,
    });
  } catch (error) {
    throw normalizeUnexpected(error);
  }
}

/**
 * Main-only result of copying one validated local History commit into a
 * caller-allocated fresh destination.  The destination remains incomplete;
 * the high-level repository service owns the final publication step.
 */
export interface LocalHistoryMaterialization {
  readonly canonicalRoot: string;
  readonly identity: RepositoryIdentity;
  readonly head: string;
  readonly fingerprint: string;
}

export interface MaterializeHistoryOptions extends Omit<LocalRepositoryOptions, "limits"> {
  readonly limits?: Partial<LocalHistoryLimits> & {
    readonly maxObjectBytes?: number;
  };
  /** Maximum total bytes of unique commit/tree/blob payloads retained in the validation graph. */
  readonly maxObjectBytes?: number;
  /**
   * Internal test-only interruption point.  Normal callers do not provide
   * this field; it exists only to prove that a failed copy leaves its marker.
   */
  readonly testFailurePoint?:
    | "after-git-init"
    | "after-object-write"
    | "after-content-write"
    | "after-index-write"
    | "after-ref-write";
}

export interface LocalHistoryObject {
  readonly oid: string;
  readonly type: LocalHistoryObjectType;
  /**
   * A defensive copy of the validated raw Git object bytes.  Typed-array
   * elements cannot be frozen in JavaScript; later staging must revalidate
   * type, size, and the Git OID before writing these bytes.
   */
  readonly bytes: Uint8Array;
}

export interface LocalHistoryObjectGraph {
  readonly identity: RepositoryIdentity;
  readonly head: string;
  /** SHA-256 digest of the validated source .git/index bytes. */
  readonly indexHash: string;
  readonly objects: readonly LocalHistoryObject[];
}

/** Minimal result of validating a history closure in an object-only stage. */
export interface ValidatedLocalHistoryGraph {
  readonly head: string;
  readonly identity: RepositoryIdentity;
  readonly objectCount: number;
  readonly objectBytes: number;
}

export interface ReadLocalHistoryGraphOptions {
  /** Limits may be lowered; the graph's default ceilings remain hard caps. */
  readonly limits?: Partial<LocalHistoryLimits> & {
    readonly maxObjectBytes?: number;
  };
  readonly maxObjectBytes?: number;
}

export const DEFAULT_MATERIALIZATION_MAX_OBJECT_BYTES = 256 * 1024 * 1024;

export type LocalHistoryObjectType = "commit" | "tree" | "blob";

type MaterializationObjectType = LocalHistoryObjectType;

interface MaterializationObject {
  readonly oid: string;
  readonly type: MaterializationObjectType;
  readonly bytes: Uint8Array;
}

interface MaterializationTreeState {
  readonly files: readonly TreeFile[];
  readonly identity: RepositoryIdentity;
}

interface MaterializationCommitState extends MaterializationTreeState {
  readonly oid: string;
  readonly tree: string;
  readonly parent?: string;
}

interface MaterializationGraph {
  readonly objects: Map<string, MaterializationObject>;
  readonly references: Map<string, readonly { readonly oid: string; readonly type: MaterializationObjectType }[]>;
  readonly commits: Map<string, MaterializationCommitState>;
  readonly limits: LocalHistoryLimits;
  readonly maxObjectBytes: number;
  objectBytes: number;
  entries: number;
}

function materializationLimits(options?: MaterializeHistoryOptions): {
  readonly limits: LocalHistoryLimits;
  readonly maxObjectBytes: number;
} {
  const limits = mergeLimits(options?.limits);
  const candidate = options?.maxObjectBytes
    ?? options?.limits?.maxObjectBytes
    ?? DEFAULT_MATERIALIZATION_MAX_OBJECT_BYTES;
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    fail("limits-exceeded", LIMIT_MESSAGE);
  }
  return { limits, maxObjectBytes: candidate };
}

function readGraphLimits(options?: ReadLocalHistoryGraphOptions): {
  readonly limits: LocalHistoryLimits;
  readonly maxObjectBytes: number;
} {
  const requested = materializationLimits(options);
  // The object graph is an in-memory main-process handoff.  Callers may make
  // these ceilings smaller for a particular operation, but cannot raise the
  // repository's established graph bounds through this read-only API.
  const limits = Object.freeze({
    maxFiles: Math.min(requested.limits.maxFiles, DEFAULT_LOCAL_HISTORY_LIMITS.maxFiles),
    maxFileBytes: Math.min(requested.limits.maxFileBytes, DEFAULT_LOCAL_HISTORY_LIMITS.maxFileBytes),
    maxTotalBytes: Math.min(requested.limits.maxTotalBytes, DEFAULT_LOCAL_HISTORY_LIMITS.maxTotalBytes),
    maxPathBytes: Math.min(requested.limits.maxPathBytes, DEFAULT_LOCAL_HISTORY_LIMITS.maxPathBytes),
    maxDepth: Math.min(requested.limits.maxDepth, DEFAULT_LOCAL_HISTORY_LIMITS.maxDepth),
    maxEntries: Math.min(requested.limits.maxEntries, DEFAULT_LOCAL_HISTORY_LIMITS.maxEntries),
    maxObjects: Math.min(requested.limits.maxObjects, DEFAULT_LOCAL_HISTORY_LIMITS.maxObjects),
  });
  return {
    limits,
    maxObjectBytes: Math.min(requested.maxObjectBytes, DEFAULT_MATERIALIZATION_MAX_OBJECT_BYTES),
  };
}

function gitObjectHash(type: MaterializationObjectType, bytes: Uint8Array): string {
  const hash = createHash("sha1");
  hash.update(`${type} ${bytes.byteLength}\0`, "utf8");
  hash.update(bytes);
  return hash.digest("hex");
}

function stableIdentityMatches(
  identity: RepositoryIdentity,
  expected: RepositoryIdentity,
): boolean {
  return identity.schemaVersion === expected.schemaVersion
    && identity.id === expected.id
    && identity.kind === expected.kind
    && identity.templateVersion === expected.templateVersion;
}

function isSafeCommitTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isValidCommitSignature(value: unknown): value is {
  readonly name: string;
  readonly email: string;
  readonly timestamp: number;
  readonly timezoneOffset: number;
} {
  if (value === null || typeof value !== "object") return false;
  const signature = value as Record<string, unknown>;
  return typeof signature.name === "string"
    && typeof signature.email === "string"
    && isSafeCommitTimestamp(signature.timestamp)
    && typeof signature.timezoneOffset === "number"
    && Number.isSafeInteger(signature.timezoneOffset);
}

function materializationObjectType(value: unknown): value is MaterializationObjectType {
  return value === "commit" || value === "tree" || value === "blob";
}

async function readMaterializationObject(
  rootReal: string,
  oidValue: string,
  expectedType: MaterializationObjectType,
  graph: MaterializationGraph,
): Promise<MaterializationObject> {
  const oid = oidValue.toLowerCase();
  if (!SHA1.test(oid)) fail("unsafe-tree", UNSAFE_TREE_MESSAGE);
  const cached = graph.objects.get(oid);
  if (cached) {
    if (cached.type !== expectedType) fail("unsafe-tree", UNSAFE_TREE_MESSAGE);
    return cached;
  }
  if (graph.objects.size >= graph.limits.maxObjects) {
    fail("limits-exceeded", LIMIT_MESSAGE);
  }

  let raw: {
    readonly oid?: unknown;
    readonly type?: unknown;
    readonly format?: unknown;
    readonly object?: unknown;
  };
  try {
    raw = await git.readObject({ fs: GIT_FS, dir: rootReal, oid, format: "content" });
  } catch {
    fail("unsafe-tree", UNSAFE_TREE_MESSAGE);
  }
  if (
    raw.format !== "content"
    || typeof raw.oid !== "string"
    || raw.oid.toLowerCase() !== oid
    || !materializationObjectType(raw.type)
    || raw.type !== expectedType
    || !(raw.object instanceof Uint8Array)
  ) {
    fail("unsafe-tree", UNSAFE_TREE_MESSAGE);
  }
  const bytes = new Uint8Array(raw.object);
  if (gitObjectHash(expectedType, bytes) !== oid) {
    fail("unsafe-tree", UNSAFE_TREE_MESSAGE);
  }
  if (bytes.byteLength > graph.maxObjectBytes - graph.objectBytes) {
    fail("limits-exceeded", LIMIT_MESSAGE);
  }
  if (expectedType === "commit") checkSecret("history-commit", bytes);
  graph.objectBytes += bytes.byteLength;
  const object: MaterializationObject = { oid, type: expectedType, bytes };
  graph.objects.set(oid, object);
  return object;
}

async function parseMaterializationIdentity(files: readonly TreeFile[]): Promise<RepositoryIdentity> {
  const identityFile = files.find((file) => file.path === IDENTITY_PATH);
  if (!identityFile) fail("invalid-identity", INVALID_IDENTITY_MESSAGE);
  try {
    const parseIdentity = await loadParseIdentity();
    return parseIdentity(JSON.parse(Buffer.from(identityFile.bytes).toString("utf8")));
  } catch {
    fail("invalid-identity", INVALID_IDENTITY_MESSAGE);
  }
}

async function readMaterializationTree(
  rootReal: string,
  treeOidValue: string,
  graph: MaterializationGraph,
  prefix = "",
  files: TreeFile[] = [],
  seenPaths = new Map<string, string>(),
  totals = { files: 0, bytes: 0 },
  treeStack = new Set<string>(),
): Promise<MaterializationTreeState> {
  const treeOid = treeOidValue.toLowerCase();
  if (!SHA1.test(treeOid)) fail("unsafe-tree", UNSAFE_TREE_MESSAGE);
  if (treeStack.has(treeOid)) fail("unsafe-tree", UNSAFE_TREE_MESSAGE);
  treeStack.add(treeOid);
  try {
    const raw = await readMaterializationObject(rootReal, treeOid, "tree", graph);
    let treeResult: Awaited<ReturnType<typeof git.readTree>>;
    try {
      treeResult = await git.readTree({ fs: GIT_FS, dir: rootReal, oid: treeOid });
    } catch {
      fail("unsafe-tree", UNSAFE_TREE_MESSAGE);
    }
    if (treeResult.oid.toLowerCase() !== treeOid || !Array.isArray(treeResult.tree)) {
      fail("unsafe-tree", UNSAFE_TREE_MESSAGE);
    }

    graph.entries += treeResult.tree.length;
    if (graph.entries > graph.limits.maxEntries) fail("limits-exceeded", LIMIT_MESSAGE);
    const depth = prefix.length === 0 ? 0 : prefix.split("/").length;
    if (depth > graph.limits.maxDepth) fail("limits-exceeded", LIMIT_MESSAGE);

    for (const entry of treeResult.tree) {
      if (
        typeof entry.path !== "string"
        || entry.path.length === 0
        || entry.path.includes("/")
        || entry.path.includes("\\")
        || !SHA1.test(entry.oid)
      ) {
        fail("unsafe-tree", UNSAFE_TREE_MESSAGE);
      }
      const pathValue = prefix.length === 0 ? entry.path : `${prefix}/${entry.path}`;
      validateRepositoryPath(pathValue);
      if (pathValue.toLowerCase() === INCOMPLETE_MARKER.toLowerCase()) {
        fail("unsupported-state", UNSUPPORTED_MESSAGE);
      }
      if (Buffer.byteLength(pathValue, "utf8") > graph.limits.maxPathBytes) {
        fail("limits-exceeded", LIMIT_MESSAGE);
      }
      const caseKey = pathValue.normalize("NFKC").toLowerCase();
      if (seenPaths.has(caseKey)) fail("unsafe-tree", UNSAFE_TREE_MESSAGE);
      seenPaths.set(caseKey, pathValue);

      if (entry.type === "tree") {
        if (entry.mode !== "040000") fail("unsafe-tree", UNSAFE_TREE_MESSAGE);
        await readMaterializationTree(
          rootReal,
          entry.oid,
          graph,
          pathValue,
          files,
          seenPaths,
          totals,
          treeStack,
        );
        continue;
      }
      if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
        fail("unsafe-tree", UNSAFE_TREE_MESSAGE);
      }
      const blobObject = await readMaterializationObject(rootReal, entry.oid, "blob", graph);
      let blobResult: Awaited<ReturnType<typeof git.readBlob>>;
      try {
        blobResult = await git.readBlob({ fs: GIT_FS, dir: rootReal, oid: entry.oid });
      } catch {
        fail("unsafe-tree", UNSAFE_TREE_MESSAGE);
      }
      const blob = new Uint8Array(blobResult.blob);
      if (!Buffer.from(blob).equals(Buffer.from(blobObject.bytes))) {
        fail("unsafe-tree", UNSAFE_TREE_MESSAGE);
      }
      if (blob.byteLength > graph.limits.maxFileBytes) fail("limits-exceeded", LIMIT_MESSAGE);
      totals.files += 1;
      totals.bytes += blob.byteLength;
      if (totals.files > graph.limits.maxFiles || totals.bytes > graph.limits.maxTotalBytes) {
        fail("limits-exceeded", LIMIT_MESSAGE);
      }
      checkSecret(pathValue, blob);
      files.push({
        path: pathValue,
        mode: entry.mode as RepositoryFileMode,
        // Reuse the bounded object-graph copy instead of duplicating every
        // historical blob in each commit's file list.
        bytes: blobObject.bytes,
        oid: entry.oid.toLowerCase(),
      });
    }
    graph.references.set(
      treeOid,
      treeResult.tree.map((entry) => ({
        oid: entry.oid.toLowerCase(),
        type: entry.type === "tree" ? "tree" : "blob",
      })),
    );
  } finally {
    treeStack.delete(treeOid);
  }

  if (prefix.length !== 0) {
    // The root invocation performs identity parsing after all descendants have
    // been visited.  Recursive invocations only contribute files.
    return { identity: undefined as unknown as RepositoryIdentity, files };
  }
  files.sort((left, right) => left.path.localeCompare(right.path, "en", { sensitivity: "variant" }));
  return { identity: await parseMaterializationIdentity(files), files: Object.freeze(files) };
}

async function readMaterializationCommit(
  rootReal: string,
  oidValue: string,
  graph: MaterializationGraph,
): Promise<MaterializationCommitState> {
  const oid = oidValue.toLowerCase();
  const cached = graph.commits.get(oid);
  if (cached) return cached;
  await readMaterializationObject(rootReal, oid, "commit", graph);
  let parsed: Awaited<ReturnType<typeof git.readCommit>>;
  try {
    parsed = await git.readCommit({ fs: GIT_FS, dir: rootReal, oid });
  } catch {
    fail("unsafe-tree", UNSAFE_TREE_MESSAGE);
  }
  if (
    parsed.oid.toLowerCase() !== oid
    || !parsed.commit
    || typeof parsed.commit.message !== "string"
    || !SHA1.test(parsed.commit.tree)
    || !Array.isArray(parsed.commit.parent)
    || parsed.commit.parent.length > 1
    || !isValidCommitSignature(parsed.commit.author)
    || !isValidCommitSignature(parsed.commit.committer)
  ) {
    fail("unsupported-state", UNSUPPORTED_MESSAGE);
  }
  const parent = parsed.commit.parent[0]?.toLowerCase();
  if (parent !== undefined && !SHA1.test(parent)) fail("unsupported-state", UNSUPPORTED_MESSAGE);
  const tree = await readMaterializationTree(rootReal, parsed.commit.tree, graph);
  const result: MaterializationCommitState = {
    oid,
    tree: parsed.commit.tree.toLowerCase(),
    parent,
    identity: tree.identity,
    files: tree.files,
  };
  graph.references.set(
    oid,
    [
      { oid: result.tree, type: "tree" },
      ...(result.parent ? [{ oid: result.parent, type: "commit" as const }] : []),
    ],
  );
  graph.commits.set(oid, result);
  return result;
}

function reachableMaterializationObjects(
  selectedOid: string,
  graph: MaterializationGraph,
): readonly MaterializationObject[] {
  const reachable = new Set<string>();
  const pending = [selectedOid.toLowerCase()];
  while (pending.length > 0) {
    const oid = pending.pop();
    if (!oid) continue;
    if (reachable.has(oid)) continue;
    const object = graph.objects.get(oid);
    if (!object) fail("unsafe-tree", UNSAFE_TREE_MESSAGE);
    reachable.add(oid);
    if (reachable.size > graph.limits.maxObjects) fail("limits-exceeded", LIMIT_MESSAGE);
    for (const reference of graph.references.get(oid) ?? []) {
      const referencedOid = reference.oid.toLowerCase();
      if (!SHA1.test(referencedOid)) fail("unsafe-tree", UNSAFE_TREE_MESSAGE);
      pending.push(referencedOid);
    }
    if (pending.length > graph.limits.maxObjects) fail("limits-exceeded", LIMIT_MESSAGE);
  }
  return Object.freeze([...reachable].map((oid) => graph.objects.get(oid)!).filter(Boolean));
}

function pathContains(root: string, candidate: string): boolean {
  const left = process.platform === "win32" ? root.toLowerCase() : root;
  const right = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const child = relative(left, right);
  return child === ""
    || (!child.startsWith(".." + sep) && child !== ".." && !parse(child).root);
}

async function assertFreshMaterializationDestination(
  sourceReal: string,
  destination: string,
): Promise<string> {
  const destinationReal = await assertSafeRoot(destination);
  if (pathContains(sourceReal, destinationReal) || pathContains(destinationReal, sourceReal)) {
    fail("unsafe-path", UNSAFE_PATH_MESSAGE);
  }
  let entries: Dirent[];
  try {
    entries = await fs.readdir(destinationReal, { withFileTypes: true });
  } catch {
    fail("root-unreadable", ROOT_UNREADABLE_MESSAGE);
  }
  if (!entries.some((entry) => entry.name === INCOMPLETE_MARKER)) {
    fail("incomplete-marker", INCOMPLETE_MESSAGE);
  }
  if (entries.length !== 1 || entries[0]?.name !== INCOMPLETE_MARKER) {
    fail("target-exists", TARGET_EXISTS_MESSAGE);
  }
  await assertMarker(destinationReal);
  return destinationReal;
}

async function ensureMaterializationDirectory(rootReal: string, directory: string): Promise<void> {
  const segments = validateRepositoryPath(directory);
  let current = rootReal;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      await fs.mkdir(current);
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("unsafe-path", UNSAFE_PATH_MESSAGE);
    await assertContained(rootReal, current);
  }
}

async function writeMaterializationFiles(
  rootReal: string,
  files: readonly TreeFile[],
): Promise<void> {
  for (const file of files) {
    const segments = validateRepositoryPath(file.path);
    const parent = segments.slice(0, -1).join("/");
    if (parent.length > 0) await ensureMaterializationDirectory(rootReal, parent);
    const absolute = join(rootReal, ...segments);
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(
        absolute,
        "wx",
        file.mode === "100755" ? 0o755 : 0o644,
      );
      await handle.writeFile(file.bytes);
      await handle.sync();
    } catch (error) {
      if (isNodeError(error, "EEXIST")) fail("target-exists", TARGET_EXISTS_MESSAGE);
      throw error;
    } finally {
      await handle?.close();
    }
    if (process.platform !== "win32" && file.mode === "100755") {
      await fs.chmod(absolute, 0o755);
    }
    const stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) fail("unsafe-path", UNSAFE_PATH_MESSAGE);
    rejectHardLink(stat);
    const bytes = new Uint8Array(await fs.readFile(absolute));
    if (!Buffer.from(bytes).equals(Buffer.from(file.bytes))) fail("changed", CHANGED_MESSAGE);
  }
}

function maybeInterruptMaterialization(
  point: NonNullable<MaterializeHistoryOptions["testFailurePoint"]>,
  options?: MaterializeHistoryOptions,
): void {
  const envPoint = process.env[MATERIALIZATION_INTERRUPT_ENV];
  if (options?.testFailurePoint !== point && envPoint !== point) return;
  delete process.env[MATERIALIZATION_INTERRUPT_ENV];
  throw new Error("Injected materialization interruption.");
}

/**
 * Validate the complete selected first-parent graph before creating anything
 * in the destination.  The source is read only; the destination is expected
 * to contain exactly one marker and no payload.
 */
export async function materializeHistoryCommit(
  sourceRoot: string,
  destinationRoot: string,
  oidValue: string,
  expectedIdentity: RepositoryIdentity,
  options?: MaterializeHistoryOptions,
): Promise<LocalHistoryMaterialization> {
  try {
    const { limits, maxObjectBytes } = materializationLimits(options);
    const expected = await (async (): Promise<RepositoryIdentity> => {
      try {
        const parseIdentity = await loadParseIdentity();
        return parseIdentity(expectedIdentity);
      } catch {
        fail("invalid-identity", INVALID_IDENTITY_MESSAGE);
      }
    })();
    if (typeof oidValue !== "string" || !SHA1.test(oidValue)) {
      fail("unsafe-tree", UNSAFE_TREE_MESSAGE);
    }
    const selectedOid = oidValue.toLowerCase();
    const sourceReal = await assertSafeRoot(sourceRoot);
    const sourceInspection = await inspectRepository(sourceReal, { limits });
    const sourceIndex = await readIndexBytes(sourceReal);
    if (!sourceIndex.bytes || !sourceIndex.hash) fail("unsupported-state", UNSUPPORTED_MESSAGE);
    if (!stableIdentityMatches(sourceInspection.identity, expected)) {
      fail("invalid-identity", INVALID_IDENTITY_MESSAGE);
    }

    const graph: MaterializationGraph = {
      objects: new Map(),
      references: new Map(),
      commits: new Map(),
      limits,
      maxObjectBytes,
      objectBytes: 0,
      entries: 0,
    };
    const chain: MaterializationCommitState[] = [];
    const visitedCommits = new Set<string>();
    let cursor = sourceInspection.head.toLowerCase();
    while (true) {
      if (visitedCommits.has(cursor)) fail("unsupported-state", UNSUPPORTED_MESSAGE);
      visitedCommits.add(cursor);
      const commit = await readMaterializationCommit(sourceReal, cursor, graph);
      if (!stableIdentityMatches(commit.identity, expected)) {
        fail("invalid-identity", INVALID_IDENTITY_MESSAGE);
      }
      chain.push(commit);
      if (chain.length > limits.maxObjects) fail("limits-exceeded", LIMIT_MESSAGE);
      if (!commit.parent) break;
      cursor = commit.parent;
    }

    const selected = chain.find((commit) => commit.oid === selectedOid);
    if (!selected) fail("unsupported-state", UNSUPPORTED_MESSAGE);

    // The graph walk is intentionally followed by a source-state check.  It
    // prevents a concurrent ref/index change from causing a destination copy
    // based on a state that was no longer the inspected main repository.
    const sourceAfter = await inspectRepository(sourceReal, { limits });
    const sourceIndexAfter = await readIndexBytes(sourceReal);
    if (
      sourceAfter.head.toLowerCase() !== sourceInspection.head.toLowerCase()
      || sourceIndexAfter.hash !== sourceIndex.hash
      || !stableIdentityMatches(sourceAfter.identity, expected)
    ) {
      fail("changed", CHANGED_MESSAGE);
    }

    // Compute the exact selected-commit closure while still in Phase A.  The
    // iterative walk is bounded by the validated object count and cannot
    // overflow the call stack for long supported histories.
    const objects = [...reachableMaterializationObjects(selected.oid, graph)]
      .sort((left, right) => left.oid.localeCompare(right.oid));
    const destinationReal = await assertFreshMaterializationDestination(sourceReal, destinationRoot);
    await git.init({ fs: GIT_FS, dir: destinationReal, defaultBranch: "main" });
    maybeInterruptMaterialization("after-git-init", options);

    for (const object of objects) {
      let written: string;
      try {
        written = await git.writeObject({
          fs: GIT_FS,
          dir: destinationReal,
          type: object.type,
          object: object.bytes,
          format: "content",
        });
      } catch {
        fail("io-error", IO_MESSAGE);
      }
      if (written.toLowerCase() !== object.oid) fail("changed", CHANGED_MESSAGE);
    }
    maybeInterruptMaterialization("after-object-write", options);

    await writeMaterializationFiles(destinationReal, selected.files);
    maybeInterruptMaterialization("after-content-write", options);

    const prepared = await prepareFiles(destinationReal, selected.files);
    await writeInitialIndex(destinationReal, prepared);
    maybeInterruptMaterialization("after-index-write", options);
    await git.writeRef({
      fs: GIT_FS,
      dir: destinationReal,
      ref: MAIN_REF,
      value: selected.oid,
      force: false,
    });
    maybeInterruptMaterialization("after-ref-write", options);

    const verified = await inspectInternal(destinationReal, { limits }, true);
    const verifiedCapture = await captureWorkingTree(destinationReal, {
      limits,
      trackedPaths: new Set(selected.files.map((file) => file.path)),
      modeHints: new Map(selected.files.map((file) => [file.path, file.mode] as const)),
      allowIncompleteMarker: true,
    });
    const verifiedPrepared = await prepareFiles(destinationReal, verifiedCapture.files);
    if (
      verified.head.toLowerCase() !== selected.oid
      || !stableIdentityMatches(verified.identity, expected)
      || !sameTree(verifiedPrepared, selected.files)
      || verifiedCapture.fingerprint !== filesystemFingerprint(selected.files)
    ) {
      fail("changed", CHANGED_MESSAGE);
    }
    await assertMarker(destinationReal);
    return Object.freeze({
      canonicalRoot: destinationReal,
      identity: verified.identity,
      head: selected.oid,
      fingerprint: verifiedCapture.fingerprint,
    });
  } catch (error) {
    throw normalizeUnexpected(error);
  }
}

async function assertObjectRootMaterializationState(
  rootReal: string,
  selectedOid: string,
): Promise<{ readonly head: string; readonly remote: string; readonly refs: readonly string[] }> {
  const gitdir = join(rootReal, ".git");
  await validateAdministrativeTree(rootReal, gitdir);
  const headText = await fs.readFile(join(gitdir, "HEAD"), "utf8").catch(() => {
    fail("unsupported-state", UNSUPPORTED_MESSAGE);
  });
  if (headText.trim() !== "ref: " + MAIN_REF) fail("unsupported-state", UNSUPPORTED_MESSAGE);
  const refs = await listRefs(rootReal, "refs");
  const remoteRef = "refs/remotes/maginalia/main";
  if (
    !refs.includes(MAIN_REF)
    || !refs.includes(remoteRef)
    || refs.some((ref) => ref !== MAIN_REF && ref !== remoteRef)
  ) {
    fail("unsupported-state", UNSUPPORTED_MESSAGE);
  }

  let head: string;
  let remote: string;
  try {
    head = await git.resolveRef({ fs: GIT_FS, dir: rootReal, ref: MAIN_REF });
    remote = await git.resolveRef({ fs: GIT_FS, dir: rootReal, ref: remoteRef });
  } catch {
    fail("changed", CHANGED_MESSAGE);
  }
  if (!SHA1.test(head) || !SHA1.test(remote) || remote !== selectedOid) {
    fail("changed", CHANGED_MESSAGE);
  }
  return Object.freeze({ head, remote, refs: Object.freeze([...refs]) });
}

/**
 * Materialize one selected remote commit from an object-only Git root.  The
 * root must have main and refs/remotes/maginalia/main pinned to the selected
 * OID; callers should normally reach this through the LocalGitStage wrapper.
 * The complete closure is validated before the destination is inspected for
 * the first write, and the destination remains marked incomplete on success.
 */
export async function materializeHistoryCommitFromObjectRoot(
  sourceRoot: string,
  destinationRoot: string,
  oidValue: string,
  expectedIdentity: RepositoryIdentity,
  options?: MaterializeHistoryOptions,
): Promise<LocalHistoryMaterialization> {
  try {
    const { limits, maxObjectBytes } = readGraphLimits(options);
    let expected: RepositoryIdentity;
    try {
      const parseIdentity = await loadParseIdentity();
      expected = parseIdentity(expectedIdentity);
    } catch {
      fail("invalid-identity", INVALID_IDENTITY_MESSAGE);
    }
    if (typeof oidValue !== "string" || !SHA1.test(oidValue) || oidValue !== oidValue.toLowerCase()) {
      fail("unsafe-tree", UNSAFE_TREE_MESSAGE);
    }
    const selectedOid = oidValue;
    const sourceReal = await assertSafeRoot(sourceRoot);
    const stateBefore = await assertObjectRootMaterializationState(sourceReal, selectedOid);

    // This complete object-only walk is deliberately before destination
    // validation/init, so malformed, secret, or incomplete history cannot
    // publish even a partially initialized destination.
    await validateLocalHistoryGraphAtRoot(sourceReal, selectedOid, expected, options);

    const graph: MaterializationGraph = {
      objects: new Map(),
      references: new Map(),
      commits: new Map(),
      limits,
      maxObjectBytes,
      objectBytes: 0,
      entries: 0,
    };
    const visitedCommits = new Set<string>();
    const chain: MaterializationCommitState[] = [];
    let cursor = selectedOid;
    while (true) {
      if (visitedCommits.has(cursor)) fail("unsupported-state", UNSUPPORTED_MESSAGE);
      visitedCommits.add(cursor);
      if (visitedCommits.size > limits.maxObjects) fail("limits-exceeded", LIMIT_MESSAGE);
      const commit = await readMaterializationCommit(sourceReal, cursor, graph);
      if (!stableIdentityMatches(commit.identity, expected)) {
        fail("invalid-identity", INVALID_IDENTITY_MESSAGE);
      }
      chain.push(commit);
      if (!commit.parent) break;
      cursor = commit.parent;
    }
    const selected = chain[0];
    if (!selected) fail("unsupported-state", UNSUPPORTED_MESSAGE);

    const stateAfter = await assertObjectRootMaterializationState(sourceReal, selectedOid);
    if (
      stateAfter.head !== stateBefore.head
      || stateAfter.remote !== stateBefore.remote
      || stateAfter.refs.length !== stateBefore.refs.length
      || stateAfter.refs.some((ref, index) => ref !== stateBefore.refs[index])
    ) {
      fail("changed", CHANGED_MESSAGE);
    }

    const objects = [...reachableMaterializationObjects(selected.oid, graph)]
      .sort((left, right) => left.oid.localeCompare(right.oid));
    const destinationReal = await assertFreshMaterializationDestination(sourceReal, destinationRoot);
    await git.init({ fs: GIT_FS, dir: destinationReal, defaultBranch: "main" });
    maybeInterruptMaterialization("after-git-init", options);

    for (const object of objects) {
      let written: string;
      try {
        written = await git.writeObject({
          fs: GIT_FS,
          dir: destinationReal,
          type: object.type,
          object: object.bytes,
          format: "content",
        });
      } catch {
        fail("io-error", IO_MESSAGE);
      }
      if (written.toLowerCase() !== object.oid) fail("changed", CHANGED_MESSAGE);
    }
    maybeInterruptMaterialization("after-object-write", options);

    await writeMaterializationFiles(destinationReal, selected.files);
    maybeInterruptMaterialization("after-content-write", options);

    const prepared = await prepareFiles(destinationReal, selected.files);
    await writeInitialIndex(destinationReal, prepared);
    maybeInterruptMaterialization("after-index-write", options);
    await git.writeRef({
      fs: GIT_FS,
      dir: destinationReal,
      ref: MAIN_REF,
      value: selected.oid,
      force: false,
    });
    maybeInterruptMaterialization("after-ref-write", options);

    const verified = await inspectInternal(destinationReal, { limits }, true);
    const verifiedCapture = await captureWorkingTree(destinationReal, {
      limits,
      trackedPaths: new Set(selected.files.map((file) => file.path)),
      modeHints: new Map(selected.files.map((file) => [file.path, file.mode] as const)),
      allowIncompleteMarker: true,
    });
    const verifiedPrepared = await prepareFiles(destinationReal, verifiedCapture.files);
    if (
      verified.head.toLowerCase() !== selected.oid
      || !stableIdentityMatches(verified.identity, expected)
      || !sameTree(verifiedPrepared, selected.files)
      || verifiedCapture.fingerprint !== filesystemFingerprint(selected.files)
    ) {
      fail("changed", CHANGED_MESSAGE);
    }
    await assertMarker(destinationReal);
    return Object.freeze({
      canonicalRoot: destinationReal,
      identity: verified.identity,
      head: selected.oid,
      fingerprint: verifiedCapture.fingerprint,
    });
  } catch (error) {
    throw normalizeUnexpected(error);
  }
}

/**
 * Read and export the complete validated object closure reachable from the
 * current pinned refs/heads/main.  This is deliberately the read-only Phase A
 * used by later staging: no destination, FsClient, or Git write is involved.
 * The source HEAD and index hash are checked again after the graph walk so a
 * concurrent source change is never handed off as a validated graph.
 */
export async function readLocalHistoryGraph(
  root: string,
  options?: ReadLocalHistoryGraphOptions,
): Promise<LocalHistoryObjectGraph> {
  try {
    const { limits, maxObjectBytes } = readGraphLimits(options);
    const sourceReal = await assertSafeRoot(root);
    const sourceInspection = await inspectRepository(sourceReal, { limits });
    const sourceIndex = await readIndexBytes(sourceReal);
    const sourceIndexHash = sourceIndex.hash;
    if (!sourceIndex.bytes || !sourceIndexHash) fail("unsupported-state", UNSUPPORTED_MESSAGE);

    const graph: MaterializationGraph = {
      objects: new Map(),
      references: new Map(),
      commits: new Map(),
      limits,
      maxObjectBytes,
      objectBytes: 0,
      entries: 0,
    };
    const visitedCommits = new Set<string>();
    let cursor = sourceInspection.head.toLowerCase();
    while (true) {
      if (visitedCommits.has(cursor)) fail("unsupported-state", UNSUPPORTED_MESSAGE);
      visitedCommits.add(cursor);
      if (visitedCommits.size > limits.maxObjects) fail("limits-exceeded", LIMIT_MESSAGE);
      const commit = await readMaterializationCommit(sourceReal, cursor, graph);
      if (!stableIdentityMatches(commit.identity, sourceInspection.identity)) {
        fail("invalid-identity", INVALID_IDENTITY_MESSAGE);
      }
      if (!commit.parent) break;
      cursor = commit.parent;
    }

    // The graph is tied to the source's pinned main ref and clean index.  A
    // changed ref or index means the bytes must be discarded and re-read.
    const sourceAfter = await inspectRepository(sourceReal, { limits });
    const sourceIndexAfter = await readIndexBytes(sourceReal);
    if (
      sourceAfter.head.toLowerCase() !== sourceInspection.head.toLowerCase()
      || sourceIndexAfter.hash !== sourceIndexHash
      || !stableIdentityMatches(sourceAfter.identity, sourceInspection.identity)
    ) {
      fail("changed", CHANGED_MESSAGE);
    }

    const objects = [...reachableMaterializationObjects(sourceInspection.head, graph)]
      .sort((left, right) => left.oid.localeCompare(right.oid))
      .map((object): LocalHistoryObject => Object.freeze({
        oid: object.oid,
        type: object.type,
        // Keep the graph's bounded bytes private from later caller mutation;
        // the public typed-array copy is intentionally revalidated later.
        bytes: new Uint8Array(object.bytes),
      }));
    const identity = Object.freeze({
      schemaVersion: sourceInspection.identity.schemaVersion,
      id: sourceInspection.identity.id,
      kind: sourceInspection.identity.kind,
      title: sourceInspection.identity.title,
      templateVersion: sourceInspection.identity.templateVersion,
    });
    return Object.freeze({
      identity,
      head: sourceInspection.head.toLowerCase(),
      indexHash: sourceIndexHash,
      objects: Object.freeze(objects),
    });
  } catch (error) {
    throw normalizeUnexpected(error);
  }
}

/**
 * Validate a complete first-parent History closure from an object-only Git
 * directory. Unlike readLocalHistoryGraph/materialization this does not read
 * an index, working tree, or identity file from the root; the expected
 * portable identity is supplied by the trusted caller and the identity file
 * embedded in every validated commit tree must match it.
 */
export async function validateLocalHistoryGraphAtRoot(
  root: string,
  oidValue: string,
  expectedIdentity: RepositoryIdentity,
  options?: ReadLocalHistoryGraphOptions,
): Promise<ValidatedLocalHistoryGraph> {
  try {
    const { limits, maxObjectBytes } = readGraphLimits(options);
    if (typeof oidValue !== "string" || !SHA1.test(oidValue) || oidValue !== oidValue.toLowerCase()) {
      fail("unsafe-tree", UNSAFE_TREE_MESSAGE);
    }
    const selectedOid = oidValue;
    let expected: RepositoryIdentity;
    try {
      const parseIdentity = await loadParseIdentity();
      expected = parseIdentity(expectedIdentity);
    } catch {
      fail("invalid-identity", INVALID_IDENTITY_MESSAGE);
    }

    const rootReal = await assertSafeRoot(root);
    // The stage may contain only the generated main remote-tracking ref in
    // addition to refs/heads/main.  Administrative files are still checked
    // for links, hardlinks, locks, and unsafe names by the existing walker.
    const gitdir = join(rootReal, ".git");
    await validateAdministrativeTree(rootReal, gitdir);
    const headText = await fs.readFile(join(gitdir, "HEAD"), "utf8").catch(() => {
      fail("unsupported-state", UNSUPPORTED_MESSAGE);
    });
    if (headText.trim() !== "ref: " + MAIN_REF) fail("unsupported-state", UNSUPPORTED_MESSAGE);
    const allowedRemoteRef = "refs/remotes/maginalia/main";
    const initialRefs = await listRefs(rootReal, "refs");
    if (
      !initialRefs.includes(MAIN_REF)
      || initialRefs.some((ref) => ref !== MAIN_REF && ref !== allowedRemoteRef)
    ) {
      fail("unsupported-state", UNSUPPORTED_MESSAGE);
    }

    const graph: MaterializationGraph = {
      objects: new Map(),
      references: new Map(),
      commits: new Map(),
      limits,
      maxObjectBytes,
      objectBytes: 0,
      entries: 0,
    };
    const visitedCommits = new Set<string>();
    let cursor = selectedOid;
    let actualIdentity: RepositoryIdentity | undefined;
    while (true) {
      if (visitedCommits.has(cursor)) fail("unsupported-state", UNSUPPORTED_MESSAGE);
      visitedCommits.add(cursor);
      if (visitedCommits.size > limits.maxObjects) fail("limits-exceeded", LIMIT_MESSAGE);
      const commit = await readMaterializationCommit(rootReal, cursor, graph);
      actualIdentity ??= commit.identity;
      if (!stableIdentityMatches(commit.identity, expected)) {
        fail("invalid-identity", INVALID_IDENTITY_MESSAGE);
      }
      if (!commit.parent) break;
      cursor = commit.parent;
    }

    // Ref/config administrative state is checked again after object reads so
    // a concurrent stage mutation cannot turn an incomplete closure into a
    // successful validation result. The object bytes themselves are hashed
    // by readMaterializationObject on every cache miss.
    const finalHead = await fs.readFile(join(gitdir, "HEAD"), "utf8").catch(() => {
      fail("changed", CHANGED_MESSAGE);
    });
    const finalRefs = await listRefs(rootReal, "refs");
    if (
      finalHead.trim() !== headText.trim()
      || finalRefs.length !== initialRefs.length
      || finalRefs.some((ref, index) => ref !== initialRefs[index])
    ) {
      fail("changed", CHANGED_MESSAGE);
    }
    if (!actualIdentity) fail("invalid-identity", INVALID_IDENTITY_MESSAGE);
    return Object.freeze({
      head: selectedOid,
      identity: actualIdentity,
      objectCount: graph.objects.size,
      objectBytes: graph.objectBytes,
    });
  } catch (error) {
    throw normalizeUnexpected(error);
  }
}

async function resolveMainHeadWithoutValidation(rootReal: string): Promise<string | null> {
  try {
    return await git.resolveRef({ fs: GIT_FS, dir: rootReal, ref: MAIN_REF });
  } catch (error) {
    if (
      isMissing(error)
      || (error instanceof Error && /Could not (?:resolve|find)|not found/i.test(error.message))
    ) {
      return null;
    }
    throw error;
  }
}

function treeNode(): TreeNode {
  return { files: new Map(), dirs: new Map() };
}

interface TreeNode {
  readonly files: Map<string, PreparedFile>;
  readonly dirs: Map<string, TreeNode>;
}

interface PreparedFile extends CapturedRepositoryFile {
  readonly oid: string;
}

async function prepareFiles(
  rootReal: string,
  files: readonly CapturedRepositoryFile[],
): Promise<readonly PreparedFile[]> {
  const prepared: PreparedFile[] = [];
  for (const file of files) {
    const { oid } = await git.hashBlob({ object: file.bytes });
    prepared.push({ ...file, oid });
  }
  return prepared;
}

function buildTree(files: readonly PreparedFile[]): TreeNode {
  const root = treeNode();
  for (const file of files) {
    const segments = validateRepositoryPath(file.path);
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      let child = node.dirs.get(segment);
      if (!child) {
        child = treeNode();
        node.dirs.set(segment, child);
      }
      node = child;
    }
    const name = segments.at(-1);
    if (!name || node.dirs.has(name) || node.files.has(name)) {
      fail("unsafe-path", UNSAFE_PATH_MESSAGE);
    }
    node.files.set(name, file);
  }
  return root;
}

async function writeTree(rootReal: string, files: readonly PreparedFile[]): Promise<string> {
  const root = buildTree(files);
  async function writeNode(node: TreeNode): Promise<string> {
    const entries: TreeObject = [];
    const directories = [...node.dirs.entries()].sort(([left], [right]) => left.localeCompare(right));
    for (const [name, child] of directories) {
      entries.push({
        mode: "040000",
        path: name,
        oid: await writeNode(child),
        type: "tree",
      });
    }
    const ordinaryFiles = [...node.files.entries()].sort(([left], [right]) => left.localeCompare(right));
    for (const [name, file] of ordinaryFiles) {
      const actualOid = await git.writeBlob({ fs: GIT_FS, dir: rootReal, blob: file.bytes });
      if (actualOid !== file.oid) fail("changed", CHANGED_MESSAGE);
      entries.push({
        mode: file.mode,
        path: name,
        oid: actualOid,
        type: "blob",
      });
    }
    return git.writeTree({ fs: GIT_FS, dir: rootReal, tree: entries });
  }
  return writeNode(root);
}

function commitAuthor(): CommitObject["author"] {
  return {
    name: "MAGINALIA Repository",
    email: "repository@maginalia.local",
    timestamp: Math.floor(Date.now() / 1000),
    timezoneOffset: new Date().getTimezoneOffset(),
  };
}

async function writeInitialIndex(
  rootReal: string,
  files: readonly PreparedFile[],
): Promise<void> {
  for (const file of files) {
    await git.updateIndex({
      fs: GIT_FS,
      dir: rootReal,
      filepath: file.path,
      oid: file.oid,
      mode: Number.parseInt(file.mode, 8),
      add: true,
    });
  }
}

async function initializeInternal(
  rootReal: string,
  options?: LocalRepositoryOptions,
): Promise<LocalRepositoryInitialization> {
  await assertMarker(rootReal);
  const identity = await readFilesystemIdentity(rootReal, { allowIncompleteMarker: true });
  const gitdir = join(rootReal, ".git");
  if (await exists(gitdir)) fail("target-exists", TARGET_EXISTS_MESSAGE);

  const captured = await captureWorkingTree(rootReal, {
    limits: options?.limits,
    allowIncompleteMarker: true,
  });
  if (!captured.files.some((file) => file.path === IDENTITY_PATH)) {
    fail("invalid-identity", INVALID_IDENTITY_MESSAGE);
  }
  await git.init({ fs: GIT_FS, dir: rootReal, defaultBranch: "main" });
  const prepared = await prepareFiles(rootReal, captured.files);
  const tree = await writeTree(rootReal, prepared);
  await writeInitialIndex(rootReal, prepared);
  const author = commitAuthor();
  const commit = await git.writeCommit({
    fs: GIT_FS,
    dir: rootReal,
    commit: {
      tree,
      parent: [],
      message: "MAGINALIA snapshot",
      author,
      committer: author,
    },
  });
  await git.writeRef({
    fs: GIT_FS,
    dir: rootReal,
    ref: MAIN_REF,
    value: commit,
    force: false,
  });
  const inspection = await inspectInternal(rootReal, options, true);
  if (
    inspection.identity.id !== identity.id
    || inspection.identity.kind !== identity.kind
    || inspection.identity.templateVersion !== identity.templateVersion
  ) {
    fail("invalid-identity", INVALID_IDENTITY_MESSAGE);
  }
  return Object.freeze({
    ...inspection,
    created: true,
    fingerprint: captured.fingerprint,
  });
}

export async function initializeRepository(
  root: string,
  options?: LocalRepositoryOptions,
): Promise<LocalRepositoryInitialization> {
  try {
    const rootReal = await assertFilesystemRoot(root);
    return await initializeInternal(rootReal, options);
  } catch (error) {
    throw normalizeUnexpected(error);
  }
}

export const initializeLocalRepository = initializeRepository;

type SnapshotJournal = Readonly<{
  readonly version: 1;
  readonly operation: "snapshot";
  readonly oldHead: string | null;
  readonly newHead: string;
  readonly newFingerprint: string;
  readonly headTempPath: string;
  readonly oldIndexPath: string | null;
  readonly newIndexPath: string | null;
  readonly oldIndexHash: string | null;
  readonly newIndexHash: string | null;
  readonly oldIndexSize: number;
  readonly newIndexSize: number;
}>;

interface IndexBytes {
  readonly bytes: Uint8Array | null;
  readonly hash: string | null;
}

const OWNED_OPERATION_LOCK = "maginalia-operation.lock";
const OWNED_INDEX_LOCK = "index.lock";
const OWNED_MAIN_REF_LOCK = "refs/heads/main.lock";
const OWNED_LOCK_PATHS = new Set([
  OWNED_OPERATION_LOCK,
  OWNED_INDEX_LOCK,
  OWNED_MAIN_REF_LOCK,
]);
const snapshotQueues = new Map<string, Promise<void>>();

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function snapshotJournalPath(rootReal: string): string {
  return join(rootReal, ".git", "maginalia-snapshot.json");
}

function snapshotArtifactPath(rootReal: string, name: string): string {
  if (!/^maginalia-snapshot-[0-9a-f-]+\.(?:old-index|new-index|main-ref\.tmp)$/i.test(name)) {
    fail("unsupported-state", UNSUPPORTED_MESSAGE);
  }
  return join(rootReal, ".git", name);
}

function mainRefPath(rootReal: string): string {
  return join(rootReal, ".git", "refs", "heads", "main");
}

function validateSnapshotJournal(value: unknown): SnapshotJournal {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("unsupported-state", UNSUPPORTED_MESSAGE);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (
    keys !== "headTempPath,newFingerprint,newHead,newIndexHash,newIndexPath,newIndexSize,oldHead,oldIndexHash,oldIndexPath,oldIndexSize,operation,version"
  ) {
    fail("unsupported-state", UNSUPPORTED_MESSAGE);
  }
  const oid = (candidate: unknown): candidate is string =>
    typeof candidate === "string" && /^[0-9a-f]{40}$/.test(candidate);
  const hash = (candidate: unknown): candidate is string =>
    typeof candidate === "string" && /^[0-9a-f]{64}$/.test(candidate);
  const artifact = (candidate: unknown, suffix: "old-index" | "new-index" | "main-ref.tmp"): candidate is string =>
    typeof candidate === "string"
    && new RegExp(`^maginalia-snapshot-[0-9a-f-]+\\.${suffix.replace(".", "\\.")}$`, "i").test(candidate);

  if (
    record.version !== 1
    || record.operation !== "snapshot"
    || !oid(record.newHead)
    || !oid(record.oldHead)
    || record.oldHead === record.newHead
    || !hash(record.newFingerprint)
    || !artifact(record.headTempPath, "main-ref.tmp")
    || !artifact(record.oldIndexPath, "old-index")
    || !artifact(record.newIndexPath, "new-index")
    || !hash(record.oldIndexHash)
    || !hash(record.newIndexHash)
    || !Number.isSafeInteger(record.oldIndexSize)
    || (record.oldIndexSize as number) < 0
    || (record.oldIndexSize as number) > MAX_INDEX_BYTES
    || !Number.isSafeInteger(record.newIndexSize)
    || (record.newIndexSize as number) < 0
    || (record.newIndexSize as number) > MAX_INDEX_BYTES
    || record.oldIndexSize === 0
    || record.newIndexSize === 0
  ) {
    fail("unsupported-state", UNSUPPORTED_MESSAGE);
  }

  const paths = [record.headTempPath, record.oldIndexPath, record.newIndexPath]
    .filter((candidate): candidate is string => typeof candidate === "string");
  const tokens = paths.map((candidate) => candidate.match(/^maginalia-snapshot-([0-9a-f-]+)\./i)?.[1]);
  if (tokens.some((token) => token === undefined) || new Set(tokens).size !== 1) {
    fail("unsupported-state", UNSUPPORTED_MESSAGE);
  }

  return {
    version: 1,
    operation: "snapshot",
    oldHead: record.oldHead as string,
    newHead: record.newHead as string,
    newFingerprint: record.newFingerprint as string,
    headTempPath: record.headTempPath as string,
    oldIndexPath: record.oldIndexPath as string,
    newIndexPath: record.newIndexPath as string,
    oldIndexHash: record.oldIndexHash as string,
    newIndexHash: record.newIndexHash as string,
    oldIndexSize: record.oldIndexSize as number,
    newIndexSize: record.newIndexSize as number,
  };
}

async function readBoundedIndexFile(pathValue: string, code: LocalRepositoryErrorCode): Promise<Uint8Array> {
  let stat: Stats;
  try {
    stat = await fs.lstat(pathValue);
  } catch (error) {
    if (isMissing(error)) throw error;
    throw new LocalRepositoryError(code, UNSUPPORTED_MESSAGE);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(code, UNSUPPORTED_MESSAGE);
  rejectHardLink(stat);
  if (statSize(stat) > MAX_INDEX_BYTES) fail("limits-exceeded", LIMIT_MESSAGE);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await fs.readFile(pathValue));
  } catch (error) {
    if (isMissing(error)) throw error;
    fail(code, UNSUPPORTED_MESSAGE);
  }
  if (bytes.byteLength !== statSize(stat)) fail("changed", CHANGED_MESSAGE);
  return bytes;
}

async function readIndexBytes(rootReal: string): Promise<IndexBytes> {
  const indexPath = join(rootReal, ".git", "index");
  try {
    const bytes = await readBoundedIndexFile(indexPath, "unsupported-state");
    return { bytes, hash: hashBytes(bytes) };
  } catch (error) {
    if (isMissing(error)) return { bytes: null, hash: null };
    throw error;
  }
}

async function readSnapshotJournal(rootReal: string): Promise<SnapshotJournal | null> {
  const journalPath = snapshotJournalPath(rootReal);
  let stat: Stats;
  try {
    stat = await fs.lstat(journalPath);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail("unsupported-state", UNSUPPORTED_MESSAGE);
  rejectHardLink(stat);
  if (statSize(stat) > 64 * 1024) fail("limits-exceeded", LIMIT_MESSAGE);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await fs.readFile(journalPath));
  } catch {
    fail("unsupported-state", UNSUPPORTED_MESSAGE);
  }
  if (bytes.byteLength !== statSize(stat)) fail("changed", CHANGED_MESSAGE);
  try {
    return validateSnapshotJournal(JSON.parse(Buffer.from(bytes).toString("utf8")));
  } catch (error) {
    if (error instanceof LocalRepositoryError) throw error;
    fail("unsupported-state", UNSUPPORTED_MESSAGE);
  }
}

async function readOptionalSnapshotArtifact(
  rootReal: string,
  pathValue: string,
  expectedHash: string,
  expectedSize: number,
): Promise<Uint8Array | null> {
  try {
    const bytes = await readBoundedIndexFile(
      snapshotArtifactPath(rootReal, pathValue),
      "unsupported-state",
    );
    if (bytes.byteLength !== expectedSize || hashBytes(bytes) !== expectedHash) {
      fail("unsupported-state", UNSUPPORTED_MESSAGE);
    }
    return bytes;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function readOptionalSnapshotHeadArtifact(
  rootReal: string,
  pathValue: string,
  expectedHead: string,
): Promise<boolean> {
  try {
    const bytes = await readBoundedIndexFile(
      snapshotArtifactPath(rootReal, pathValue),
      "unsupported-state",
    );
    return Buffer.from(bytes).equals(Buffer.from(`${expectedHead}\n`, "utf8"));
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function indexMatchesTree(
  bytes: Uint8Array,
  files: readonly { readonly path: string; readonly oid: string; readonly mode: RepositoryFileMode }[],
): boolean {
  const indexed = parseIndexEntries(bytes);
  if (indexed.length !== files.length) return false;
  const expected = new Map(files.map((file) => [file.path, `${file.mode}:${file.oid}`]));
  for (const entry of indexed) {
    if (expected.get(entry.path) !== `${entry.mode}:${entry.oid}`) return false;
    expected.delete(entry.path);
  }
  return expected.size === 0;
}

async function validateSnapshotJournalIntegrity(
  rootReal: string,
  journal: SnapshotJournal,
  currentHead: string | null,
  currentIndex: IndexBytes,
): Promise<void> {
  if (!journal.oldHead || !journal.oldIndexPath || !journal.oldIndexHash || !journal.newIndexPath || !journal.newIndexHash) {
    fail("unsupported-state", UNSUPPORTED_MESSAGE);
  }

  const oldTree = await readHeadTree(rootReal, journal.oldHead);
  let newCommit: Awaited<ReturnType<typeof git.readCommit>>;
  try {
    newCommit = await git.readCommit({ fs: GIT_FS, dir: rootReal, oid: journal.newHead });
  } catch {
    fail("unsupported-state", UNSUPPORTED_MESSAGE);
  }
  if (newCommit.commit.parent.length !== 1 || newCommit.commit.parent[0] !== journal.oldHead) {
    fail("unsupported-state", UNSUPPORTED_MESSAGE);
  }
  const newTree = await readHeadTree(rootReal, journal.newHead);
  if (filesystemFingerprint(newTree.files) !== journal.newFingerprint) {
    fail("unsupported-state", UNSUPPORTED_MESSAGE);
  }

  const oldIndexArtifact = await readOptionalSnapshotArtifact(
    rootReal,
    journal.oldIndexPath,
    journal.oldIndexHash,
    journal.oldIndexSize,
  );
  const newIndexArtifact = await readOptionalSnapshotArtifact(
    rootReal,
    journal.newIndexPath,
    journal.newIndexHash,
    journal.newIndexSize,
  );
  const headArtifactIsValid = await readOptionalSnapshotHeadArtifact(
    rootReal,
    journal.headTempPath,
    journal.newHead,
  );

  const validateOldArtifact = (): void => {
    if (!oldIndexArtifact) fail("unsupported-state", UNSUPPORTED_MESSAGE);
    assertIndexEntriesMatchTree(oldIndexArtifact, oldTree.files);
  };
  const validateNewArtifact = (): void => {
    if (!newIndexArtifact) fail("unsupported-state", UNSUPPORTED_MESSAGE);
    assertIndexEntriesMatchTree(newIndexArtifact, newTree.files);
  };

  if (currentHead !== journal.oldHead && currentHead !== journal.newHead) {
    fail("unsupported-state", UNSUPPORTED_MESSAGE);
  }

  let currentIsOld = false;
  let currentIsNew = false;
  if (currentIndex.bytes !== null) {
    currentIsOld = indexMatchesTree(currentIndex.bytes, oldTree.files);
    currentIsNew = indexMatchesTree(currentIndex.bytes, newTree.files);
    if (!currentIsOld && !currentIsNew) fail("unsupported-state", UNSUPPORTED_MESSAGE);
  }

  if (currentHead === journal.oldHead) {
    if (!currentIsOld) fail("unsupported-state", UNSUPPORTED_MESSAGE);
    validateOldArtifact();
    validateNewArtifact();
    if (!headArtifactIsValid) fail("unsupported-state", UNSUPPORTED_MESSAGE);
    return;
  }

  if (currentIsNew) {
    if (oldIndexArtifact) assertIndexEntriesMatchTree(oldIndexArtifact, oldTree.files);
    if (newIndexArtifact) assertIndexEntriesMatchTree(newIndexArtifact, newTree.files);
    if (await exists(snapshotArtifactPath(rootReal, journal.headTempPath)) && !headArtifactIsValid) {
      fail("unsupported-state", UNSUPPORTED_MESSAGE);
    }
    return;
  }

  if (currentIndex.bytes !== null) {
    if (!currentIsOld) fail("unsupported-state", UNSUPPORTED_MESSAGE);
    validateOldArtifact();
  }
  validateNewArtifact();
}

async function writeDurableBytes(pathValue: string, bytes: Uint8Array): Promise<void> {
  const handle = await fs.open(pathValue, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function unlinkIfPresent(pathValue: string): Promise<void> {
  try {
    await fs.unlink(pathValue);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function removeOwnedArtifact(
  pathValue: string,
  expected: { readonly hash?: string; readonly bytes?: Uint8Array } = {},
): Promise<void> {
  let stat: Stats;
  try {
    stat = await fs.lstat(pathValue);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail("unsupported-state", UNSUPPORTED_MESSAGE);
  rejectHardLink(stat);
  const bytes = new Uint8Array(await fs.readFile(pathValue));
  if (bytes.byteLength !== statSize(stat)) fail("changed", CHANGED_MESSAGE);
  if (expected.hash && hashBytes(bytes) !== expected.hash) fail("unsupported-state", UNSUPPORTED_MESSAGE);
  if (expected.bytes && !Buffer.from(bytes).equals(Buffer.from(expected.bytes))) {
    fail("unsupported-state", UNSUPPORTED_MESSAGE);
  }
  await fs.unlink(pathValue);
}

async function cleanupSnapshotArtifacts(rootReal: string, journal: SnapshotJournal): Promise<void> {
  if (journal.oldIndexPath) {
    await removeOwnedArtifact(
      snapshotArtifactPath(rootReal, journal.oldIndexPath),
      { hash: journal.oldIndexHash ?? undefined },
    );
    maybeInterruptSnapshot("after-cleanup-old");
  }
  if (journal.newIndexPath) {
    await removeOwnedArtifact(
      snapshotArtifactPath(rootReal, journal.newIndexPath),
      { hash: journal.newIndexHash ?? undefined },
    );
  }
  await removeOwnedArtifact(
    snapshotArtifactPath(rootReal, journal.headTempPath),
    { bytes: Buffer.from(`${journal.newHead}\n`, "utf8") },
  );
  const current = await readSnapshotJournal(rootReal);
  if (!current || JSON.stringify(current) !== JSON.stringify(journal)) {
    fail("unsupported-state", UNSUPPORTED_MESSAGE);
  }
  await unlinkIfPresent(snapshotJournalPath(rootReal));
}

function matchesIndex(index: IndexBytes, hash: string | null): boolean {
  return index.hash === hash;
}

function sameTree(
  left: readonly { readonly path: string; readonly oid: string; readonly mode: RepositoryFileMode }[],
  right: readonly { readonly path: string; readonly oid: string; readonly mode: RepositoryFileMode }[],
): boolean {
  if (left.length !== right.length) return false;
  const rightMap = new Map(right.map((file) => [file.path, `${file.mode}:${file.oid}`]));
  return left.every((file) => rightMap.get(file.path) === `${file.mode}:${file.oid}`);
}

async function synchronizeIndex(
  rootReal: string,
  previousFiles: readonly { readonly path: string }[],
  nextFiles: readonly { readonly path: string; readonly oid: string; readonly mode: RepositoryFileMode }[],
  gitdir: string,
): Promise<void> {
  let indexed: string[] = [];
  try {
    indexed = await git.listFiles({ fs: GIT_FS, dir: rootReal, gitdir });
  } catch (error) {
    if (!isMissing(error)) fail("unsupported-state", UNSUPPORTED_MESSAGE);
  }
  const next = new Set(nextFiles.map((file) => file.path));
  const remove = new Set(
    [...indexed, ...previousFiles.map((file) => file.path)].filter((pathValue) => !next.has(pathValue)),
  );
  for (const pathValue of [...remove].sort()) {
    await git.updateIndex({
      fs: GIT_FS,
      dir: rootReal,
      gitdir,
      filepath: pathValue,
      remove: true,
      force: true,
    });
  }
  for (const file of nextFiles) {
    await git.updateIndex({
      fs: GIT_FS,
      dir: rootReal,
      gitdir,
      filepath: file.path,
      oid: file.oid,
      mode: Number.parseInt(file.mode, 8),
      add: true,
    });
  }
}

async function buildExpectedIndex(
  rootReal: string,
  oldIndex: IndexBytes,
  previousFiles: readonly { readonly path: string }[],
  nextFiles: readonly { readonly path: string; readonly oid: string; readonly mode: RepositoryFileMode }[],
): Promise<Uint8Array | null> {
  const temporaryGitdir = await fs.mkdtemp(join(tmpdir(), "maginalia-index-build-"));
  try {
    if (oldIndex.bytes) {
      await fs.writeFile(join(temporaryGitdir, "index"), oldIndex.bytes, { flag: "wx", mode: 0o600 });
    }
    await synchronizeIndex(rootReal, previousFiles, nextFiles, temporaryGitdir);
    try {
      return await readBoundedIndexFile(join(temporaryGitdir, "index"), "unsupported-state");
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  } finally {
    await fs.rm(temporaryGitdir, { recursive: true, force: true });
  }
}

async function prepareSnapshotJournal(
  rootReal: string,
  oldHead: string,
  newHead: string,
  newFingerprint: string,
  oldIndex: IndexBytes,
  previousFiles: readonly { readonly path: string }[],
  nextFiles: readonly { readonly path: string; readonly oid: string; readonly mode: RepositoryFileMode }[],
): Promise<SnapshotJournal> {
  if (await readSnapshotJournal(rootReal)) fail("unsupported-state", UNSUPPORTED_MESSAGE);
  const expectedIndex = await buildExpectedIndex(rootReal, oldIndex, previousFiles, nextFiles);
  const token = randomUUID();
  const oldIndexPath = oldIndex.bytes ? `maginalia-snapshot-${token}.old-index` : null;
  const newIndexPath = expectedIndex ? `maginalia-snapshot-${token}.new-index` : null;
  const journal: SnapshotJournal = {
    version: 1,
    operation: "snapshot",
    oldHead,
    newHead,
    newFingerprint,
    headTempPath: `maginalia-snapshot-${token}.main-ref.tmp`,
    oldIndexPath,
    newIndexPath,
    oldIndexHash: oldIndex.hash,
    newIndexHash: expectedIndex ? hashBytes(expectedIndex) : null,
    oldIndexSize: oldIndex.bytes?.byteLength ?? 0,
    newIndexSize: expectedIndex?.byteLength ?? 0,
  };
  let oldWritten = false;
  let newWritten = false;
  try {
    if (oldIndexPath && oldIndex.bytes) {
      await writeDurableBytes(snapshotArtifactPath(rootReal, oldIndexPath), oldIndex.bytes);
      oldWritten = true;
    }
    if (newIndexPath && expectedIndex) {
      await writeDurableBytes(snapshotArtifactPath(rootReal, newIndexPath), expectedIndex);
      newWritten = true;
    }
    await writeDurableBytes(snapshotJournalPath(rootReal), Buffer.from(`${JSON.stringify(journal)}\n`, "utf8"));
    return journal;
  } catch (error) {
    if (oldWritten && oldIndexPath) await removeOwnedArtifact(snapshotArtifactPath(rootReal, oldIndexPath), { hash: journal.oldIndexHash ?? undefined });
    if (newWritten && newIndexPath) await removeOwnedArtifact(snapshotArtifactPath(rootReal, newIndexPath), { hash: journal.newIndexHash ?? undefined });
    throw error;
  }
}

async function acquireOwnedFileLock(lockPath: string, operation: string): Promise<() => Promise<void>> {
  const token = randomUUID();
  const body = `${JSON.stringify({ token, pid: process.pid, startedAt: new Date().toISOString(), operation })}\n`;
  try {
    await fs.writeFile(lockPath, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (isNodeError(error, "EEXIST")) fail("lock-held", UNSUPPORTED_MESSAGE);
    throw error;
  }
  return async () => {
    try {
      const current = await fs.readFile(lockPath, "utf8");
      if (current !== body) return;
      await fs.unlink(lockPath);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  };
}

async function withSnapshotPublicationLocks<T>(
  rootReal: string,
  operation: string,
  work: () => Promise<T>,
): Promise<T> {
  const gitdir = join(rootReal, ".git");
  const releaseIndexLock = await acquireOwnedFileLock(join(gitdir, "index.lock"), `${operation}-index`);
  let releaseRefLock: (() => Promise<void>) | undefined;
  try {
    releaseRefLock = await acquireOwnedFileLock(join(gitdir, "refs", "heads", "main.lock"), `${operation}-ref`);
    return await work();
  } finally {
    try {
      if (releaseRefLock) await releaseRefLock();
    } finally {
      await releaseIndexLock();
    }
  }
}

function maybeInterruptSnapshot(
  point: "after-head-publication" | "after-index-removal" | "after-index-install" | "after-cleanup-old",
): void {
  if (process.env[SNAPSHOT_INTERRUPT_ENV] !== point) return;
  delete process.env[SNAPSHOT_INTERRUPT_ENV];
  throw new Error("Injected snapshot interruption.");
}

async function maybePauseSnapshot(
  point: "before-publication" | "after-head-publication" | "after-index-publication",
): Promise<void> {
  if (process.env[SNAPSHOT_PAUSE_ENV] !== point) return;
  process.env[SNAPSHOT_PAUSE_READY_ENV] = point;
  while (process.env[SNAPSHOT_RESUME_ENV] !== point) {
    await new Promise<void>((resolvePause) => setTimeout(resolvePause, 5));
  }
  delete process.env[SNAPSHOT_PAUSE_ENV];
  delete process.env[SNAPSHOT_RESUME_ENV];
  delete process.env[SNAPSHOT_PAUSE_READY_ENV];
}

function maybeFailSnapshotHeadPublication(): void {
  if (process.env[SNAPSHOT_HEAD_ENOSPC_ENV] !== "after-temporary-write") return;
  delete process.env[SNAPSHOT_HEAD_ENOSPC_ENV];
  const error = new Error("Injected snapshot publication failure.") as Error & { code?: string };
  error.code = "ENOSPC";
  throw error;
}

function maybeFailSnapshotRefRename(): void {
  if (process.env[SNAPSHOT_REF_RENAME_FAILURE_ENV] !== "before-rename") return;
  delete process.env[SNAPSHOT_REF_RENAME_FAILURE_ENV];
  const error = new Error("Injected snapshot ref rename failure.") as Error & { code?: string };
  error.code = "EIO";
  throw error;
}

async function publishMainHead(rootReal: string, journal: SnapshotJournal): Promise<void> {
  const temporary = snapshotArtifactPath(rootReal, journal.headTempPath);
  await writeDurableBytes(temporary, Buffer.from(`${journal.newHead}\n`, "utf8"));
  maybeFailSnapshotHeadPublication();
  maybeFailSnapshotRefRename();
  await fs.rename(temporary, mainRefPath(rootReal));
  if (await resolveMainHeadWithoutValidation(rootReal) !== journal.newHead) {
    fail("changed", CHANGED_MESSAGE);
  }
}

async function publishSnapshotIndex(
  rootReal: string,
  journal: SnapshotJournal,
  recovering = false,
): Promise<void> {
  const current = await readIndexBytes(rootReal);
  if (!matchesIndex(current, journal.oldIndexHash) && !(recovering && current.bytes === null)) {
    fail("changed", CHANGED_MESSAGE);
  }
  if (journal.newIndexPath) {
    const expected = await readBoundedIndexFile(
      snapshotArtifactPath(rootReal, journal.newIndexPath),
      "unsupported-state",
    );
    if (
      hashBytes(expected) !== journal.newIndexHash
      || expected.byteLength !== journal.newIndexSize
    ) {
      fail("unsupported-state", UNSUPPORTED_MESSAGE);
    }
  } else if (journal.newIndexHash !== null || journal.newIndexSize !== 0) {
    fail("unsupported-state", UNSUPPORTED_MESSAGE);
  }
  const indexPath = join(rootReal, ".git", "index");
  await unlinkIfPresent(indexPath);
  maybeInterruptSnapshot("after-index-removal");
  if (journal.newIndexPath) {
    await fs.rename(snapshotArtifactPath(rootReal, journal.newIndexPath), indexPath);
  }
  maybeInterruptSnapshot("after-index-install");
  const installed = await readIndexBytes(rootReal);
  if (!matchesIndex(installed, journal.newIndexHash)) fail("changed", CHANGED_MESSAGE);
}

async function recoverPendingSnapshot(rootReal: string): Promise<void> {
  const journal = await readSnapshotJournal(rootReal);
  if (!journal) return;
  await assertGitState(rootReal, new Set([OWNED_OPERATION_LOCK]));
  const initialHead = await resolveMainHeadWithoutValidation(rootReal);
  const initialIndex = await readIndexBytes(rootReal);
  await validateSnapshotJournalIntegrity(rootReal, journal, initialHead, initialIndex);
  await withSnapshotPublicationLocks(rootReal, "snapshot-recovery", async () => {
    const currentHead = await resolveMainHeadWithoutValidation(rootReal);
    const currentIndex = await readIndexBytes(rootReal);
    await validateSnapshotJournalIntegrity(rootReal, journal, currentHead, currentIndex);
    if (currentHead === journal.oldHead && currentHead !== journal.newHead) {
      if (!matchesIndex(currentIndex, journal.oldIndexHash)) fail("unsupported-state", UNSUPPORTED_MESSAGE);
      await cleanupSnapshotArtifacts(rootReal, journal);
      return;
    }
    if (currentHead !== journal.newHead) fail("unsupported-state", UNSUPPORTED_MESSAGE);
    if (matchesIndex(currentIndex, journal.newIndexHash)) {
      await cleanupSnapshotArtifacts(rootReal, journal);
      return;
    }
    if (!matchesIndex(currentIndex, journal.oldIndexHash) && currentIndex.bytes !== null) {
      fail("unsupported-state", UNSUPPORTED_MESSAGE);
    }
    await publishSnapshotIndex(rootReal, journal, true);
    await cleanupSnapshotArtifacts(rootReal, journal);
  });
}

async function prepareSnapshotFiles(
  rootReal: string,
  files: readonly CapturedRepositoryFile[],
): Promise<readonly PreparedFile[]> {
  const prepared: PreparedFile[] = [];
  for (const file of files) {
    const oid = await git.writeBlob({ fs: GIT_FS, dir: rootReal, blob: file.bytes });
    prepared.push({ ...file, oid });
  }
  return prepared;
}

async function withRepositoryOperation<T>(
  rootReal: string,
  operation: string,
  work: () => Promise<T>,
): Promise<T> {
  const queueKey = process.platform === "win32" ? rootReal.toLowerCase() : rootReal;
  const previous = snapshotQueues.get(queueKey) ?? Promise.resolve();
  let releaseQueue: (() => void) | undefined;
  const current = new Promise<void>((resolveQueue) => {
    releaseQueue = resolveQueue;
  });
  const queued = previous.then(() => current);
  snapshotQueues.set(queueKey, queued);
  await previous;
  let releaseOperation: (() => Promise<void>) | undefined;
  try {
    await assertGitState(rootReal);
    releaseOperation = await acquireOwnedFileLock(
      join(rootReal, ".git", "maginalia-operation.lock"),
      operation,
    );
    await recoverPendingSnapshot(rootReal);
    return await work();
  } finally {
    try {
      if (releaseOperation) await releaseOperation();
    } finally {
      releaseQueue?.();
      if (snapshotQueues.get(queueKey) === queued) snapshotQueues.delete(queueKey);
    }
  }
}

export async function createHistorySnapshot(
  root: string,
  options?: LocalRepositoryOptions,
): Promise<LocalHistorySnapshot> {
  try {
    const rootReal = await assertFilesystemRoot(root);
    await rejectMarker(rootReal);
    return await withRepositoryOperation(rootReal, "snapshot", async () => {
      return withSnapshotPublicationLocks(rootReal, "snapshot", async () => {
        await assertGitState(rootReal, OWNED_LOCK_PATHS);
        if (await readSnapshotJournal(rootReal)) fail("unsupported-state", UNSUPPORTED_MESSAGE);

        const identity = await readFilesystemIdentity(rootReal);
        const head = await resolveMainHeadWithoutValidation(rootReal);
        if (!head || !SHA1.test(head)) fail("unsupported-state", UNSUPPORTED_MESSAGE);
        const tree = await readHeadTree(rootReal, head, options?.limits);
        if (
          tree.identity.id !== identity.id
          || tree.identity.kind !== identity.kind
          || tree.identity.title !== identity.title
          || tree.identity.schemaVersion !== identity.schemaVersion
          || tree.identity.templateVersion !== identity.templateVersion
        ) {
          fail("invalid-identity", INVALID_IDENTITY_MESSAGE);
        }
        await assertIndexMatchesHead(rootReal, tree.files);
        const oldIndex = await readIndexBytes(rootReal);
        const trackedPaths = new Set(tree.files.map((file) => file.path));
        const modeHints = new Map(tree.files.map((file) => [file.path, file.mode] as const));
        const isIgnored = makeIgnorePredicate(rootReal);
        const captureOptions: RepositoryFilesystemCaptureOptions = {
          limits: options?.limits,
          trackedPaths,
          modeHints,
          isIgnored,
        };
        const captured = await captureWorkingTree(rootReal, captureOptions);
        const prepared = await prepareSnapshotFiles(rootReal, captured.files);
        const existingTree = tree.files.map((file) => ({
          path: file.path,
          oid: file.oid,
          mode: file.mode,
        }));
        const unchanged = sameTree(prepared, existingTree);
        const finalCaptureOptions: RepositoryFilesystemCaptureOptions = {
          ...captureOptions,
          trackedPaths: new Set(prepared.map((file) => file.path)),
          modeHints: new Map(prepared.map((file) => [file.path, file.mode] as const)),
        };

        if (unchanged) {
          const finalCapture = await captureWorkingTree(rootReal, finalCaptureOptions);
          if (finalCapture.fingerprint !== captured.fingerprint) fail("changed", CHANGED_MESSAGE);
          if (await resolveMainHeadWithoutValidation(rootReal) !== head) fail("changed", CHANGED_MESSAGE);
          if (!matchesIndex(await readIndexBytes(rootReal), oldIndex.hash)) fail("changed", CHANGED_MESSAGE);
          return Object.freeze({ head, fingerprint: captured.fingerprint, created: false });
        }

        const treeOid = await writeTree(rootReal, prepared);
        const author = commitAuthor();
        const newHead = await git.writeCommit({
          fs: GIT_FS,
          dir: rootReal,
          commit: {
            tree: treeOid,
            parent: [head],
            message: "MAGINALIA snapshot",
            author,
            committer: author,
          },
        });
        const journal = await prepareSnapshotJournal(
          rootReal,
          head,
          newHead,
          captured.fingerprint,
          oldIndex,
          tree.files,
          prepared,
        );
        let headPublicationStarted = false;
        let indexPublicationStarted = false;
        try {
          await maybePauseSnapshot("before-publication");
          const finalCapture = await captureWorkingTree(rootReal, finalCaptureOptions);
          if (finalCapture.fingerprint !== captured.fingerprint) fail("changed", CHANGED_MESSAGE);
          if (await resolveMainHeadWithoutValidation(rootReal) !== head) fail("changed", CHANGED_MESSAGE);
          if (!matchesIndex(await readIndexBytes(rootReal), oldIndex.hash)) fail("changed", CHANGED_MESSAGE);

          headPublicationStarted = true;
          await publishMainHead(rootReal, journal);
          maybeInterruptSnapshot("after-head-publication");
          await maybePauseSnapshot("after-head-publication");

          indexPublicationStarted = true;
          await publishSnapshotIndex(rootReal, journal);
          await maybePauseSnapshot("after-index-publication");
          const postCapture = await captureWorkingTree(rootReal, finalCaptureOptions);
          if (postCapture.fingerprint !== captured.fingerprint) fail("changed", CHANGED_MESSAGE);
          if (await resolveMainHeadWithoutValidation(rootReal) !== journal.newHead) {
            fail("changed", CHANGED_MESSAGE);
          }
          if (!matchesIndex(await readIndexBytes(rootReal), journal.newIndexHash)) {
            fail("changed", CHANGED_MESSAGE);
          }
          await cleanupSnapshotArtifacts(rootReal, journal);
          return Object.freeze({ head: newHead, fingerprint: captured.fingerprint, created: true });
        } catch (error) {
          if (!headPublicationStarted && !indexPublicationStarted) {
            await cleanupSnapshotArtifacts(rootReal, journal).catch(() => undefined);
          }
          throw error;
        }
      });
    });
  } catch (error) {
    throw normalizeUnexpected(error);
  }
}

export const snapshotRepository = createHistorySnapshot;
export const createSnapshot = createHistorySnapshot;

export function gitFs(): FsClient {
  return GIT_FS;
}

export { captureWorkingTree, validateRepositoryPath };
