/**
 * Main-process-only persistence for the non-secret local cloud connection.
 *
 * `resolvedRoot` must come from trusted main-process repository resolution;
 * this class has no renderer-facing path API.  The root and its `.git`
 * directory are revalidated on every operation before the fixed metadata
 * path is accessed.  Cross-process safety is supplied by Electron's
 * single-instance lock; the small in-process lock below serializes store
 * instances in one process.
 */

import { constants as fsConstants, type Stats } from "node:fs";
import {
  lstat,
  open,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, join, parse, relative, sep } from "node:path";
import { TextDecoder, TextEncoder } from "node:util";
import {
  MAX_REPOSITORY_CLOUD_CONNECTION_BYTES,
  parseRepositoryCloudConnection,
  RepositoryCloudConnectionError,
  serializeRepositoryCloudConnection,
  type RepositoryCloudConnection,
} from "./repository-cloud-connection";
import { assertSafeRoot } from "./repository-filesystem";

export const REPOSITORY_CLOUD_CONNECTION_FILE_NAME = "maginalia-connection.json" as const;

const GIT_DIRECTORY_NAME = ".git";
const TEMPORARY_FILE_SUFFIX = ".tmp";

export type RepositoryCloudConnectionStoreErrorCode =
  | "invalid-root"
  | "storage-unsafe"
  | "storage-io"
  | "connection-invalid"
  | "connection-too-large"
  | "connection-mismatch";

const ERROR_MESSAGES: Readonly<Record<RepositoryCloudConnectionStoreErrorCode, string>> = Object.freeze({
  "invalid-root": "The repository root is invalid.",
  "storage-unsafe": "The repository connection storage is unsafe.",
  "storage-io": "The repository connection could not be stored safely.",
  "connection-invalid": "The repository cloud connection metadata is invalid.",
  "connection-too-large": "The repository cloud connection metadata is too large.",
  "connection-mismatch": "A different repository cloud connection is already stored.",
});

export class RepositoryCloudConnectionStoreError extends Error {
  public readonly code: RepositoryCloudConnectionStoreErrorCode;
  public readonly userMessage: string;

  public constructor(code: RepositoryCloudConnectionStoreErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "RepositoryCloudConnectionStoreError";
    this.code = code;
    this.userMessage = this.message;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function fail(code: RepositoryCloudConnectionStoreErrorCode): never {
  throw new RepositoryCloudConnectionStoreError(code);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  try {
    const code = (error as { readonly code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

function isMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT"
    || code === "ENOTDIR"
    || code === "NotFoundError"
    || code === "NoSuchFileError";
}

function normalizeUnexpected(
  error: unknown,
  fallback: RepositoryCloudConnectionStoreErrorCode = "storage-io",
): RepositoryCloudConnectionStoreError {
  if (error instanceof RepositoryCloudConnectionStoreError) return error;
  if (error instanceof RepositoryCloudConnectionError) {
    return new RepositoryCloudConnectionStoreError(
      error.code === "connection-too-large" ? "connection-too-large" : "connection-invalid",
    );
  }
  return new RepositoryCloudConnectionStoreError(fallback);
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function statSize(stat: Stats): number {
  const size = typeof stat.size === "bigint" ? Number(stat.size) : stat.size;
  if (!Number.isSafeInteger(size) || size < 0) fail("storage-unsafe");
  return size;
}

function linkCount(stat: Stats): number {
  return typeof stat.nlink === "bigint" ? Number(stat.nlink) : stat.nlink;
}

function assertDirectoryStat(stat: Stats): void {
  // Directory link counts are not a useful escape signal on POSIX: normal
  // directories can have more than one link.  Symlinks and non-directories
  // are still rejected explicitly.
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("storage-unsafe");
}

function assertConnectionFileStat(stat: Stats): void {
  const nlink = linkCount(stat);
  if (
    stat.isSymbolicLink()
    || !stat.isFile()
    || !Number.isSafeInteger(nlink)
    || nlink !== 1
  ) {
    fail("storage-unsafe");
  }
}

function assertBoundedSize(stat: Stats): number {
  const size = statSize(stat);
  if (size > MAX_REPOSITORY_CLOUD_CONNECTION_BYTES) fail("connection-too-large");
  return size;
}

const NO_FOLLOW = typeof (fsConstants as { readonly O_NOFOLLOW?: unknown }).O_NOFOLLOW === "number"
  ? (fsConstants as { readonly O_NOFOLLOW: number }).O_NOFOLLOW
  : 0;

async function optionalLstat(pathValue: string): Promise<Stats | undefined> {
  try {
    return await lstat(pathValue);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw normalizeUnexpected(error);
  }
}

interface ResolvedRoot {
  readonly path: string;
  readonly identity: Stats;
}

async function revalidateRoot(root: ResolvedRoot): Promise<void> {
  let current: Stats;
  try {
    current = await lstat(root.path);
    assertDirectoryStat(current);
    const canonical = await realpath(root.path);
    const canonicalStat = await lstat(canonical);
    assertDirectoryStat(canonicalStat);
    if (!sameFileIdentity(root.identity, current) || !sameFileIdentity(root.identity, canonicalStat)) {
      fail("storage-unsafe");
    }
  } catch (error) {
    if (error instanceof RepositoryCloudConnectionStoreError) throw error;
    if (isMissing(error)) fail("storage-unsafe");
    throw normalizeUnexpected(error);
  }
}

async function assertSafeGitDirectory(root: ResolvedRoot): Promise<string> {
  await revalidateRoot(root);
  const gitDirectory = join(root.path, GIT_DIRECTORY_NAME);
  let initial: Stats;
  try {
    initial = await lstat(gitDirectory);
  } catch (error) {
    if (isMissing(error)) fail("storage-unsafe");
    throw normalizeUnexpected(error);
  }
  assertDirectoryStat(initial);

  // Re-check the resolved directory identity.  This catches a replacement
  // between lstat and realpath and rejects a path that escaped the root.
  try {
    const realGitDirectory = await realpath(gitDirectory);
    const child = relative(root.path, realGitDirectory);
    if (
      child !== ""
      && (child.startsWith(".." + sep) || child === ".." || parse(child).root)
    ) {
      fail("storage-unsafe");
    }
    const resolved = await lstat(realGitDirectory);
    assertDirectoryStat(resolved);
    if (!sameFileIdentity(initial, resolved)) fail("storage-unsafe");
  } catch (error) {
    if (error instanceof RepositoryCloudConnectionStoreError) throw error;
    if (isMissing(error)) fail("storage-unsafe");
    throw normalizeUnexpected(error);
  }
  return gitDirectory;
}

async function readConnectionBytes(pathValue: string): Promise<Uint8Array | undefined> {
  const target = await optionalLstat(pathValue);
  if (!target) return undefined;
  assertConnectionFileStat(target);
  const expectedSize = assertBoundedSize(target);
  let handle: FileHandle | undefined;
  try {
    handle = await open(pathValue, fsConstants.O_RDONLY | NO_FOLLOW);
    const opened = await handle.stat();
    assertConnectionFileStat(opened);
    if (!sameFileIdentity(target, opened) || assertBoundedSize(opened) !== expectedSize) {
      fail("storage-unsafe");
    }

    // Never size an allocation from an untrusted file after the initial
    // lstat.  A fixed cap plus one byte detects growth without unbounded
    // arrayBuffer()/text()/readFile fallbacks.
    const bytes = Buffer.alloc(MAX_REPOSITORY_CLOUD_CONNECTION_BYTES + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead < 0) {
        fail("storage-io");
      }
      if (result.bytesRead > bytes.byteLength - offset) {
        fail("storage-io");
      }
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > MAX_REPOSITORY_CLOUD_CONNECTION_BYTES) fail("connection-too-large");

    const latestPathStat = await optionalLstat(pathValue);
    const finalStat = await handle.stat();
    assertConnectionFileStat(finalStat);
    if (!latestPathStat) fail("storage-unsafe");
    assertConnectionFileStat(latestPathStat);
    if (
      !sameFileIdentity(target, latestPathStat)
      || !sameFileIdentity(target, finalStat)
      || assertBoundedSize(latestPathStat) !== expectedSize
      || assertBoundedSize(finalStat) !== expectedSize
      || assertBoundedSize(finalStat) !== offset
    ) {
      fail("storage-unsafe");
    }
    return new Uint8Array(bytes.subarray(0, offset));
  } catch (error) {
    if (error instanceof RepositoryCloudConnectionStoreError) throw error;
    throw normalizeUnexpected(error);
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Preserve the primary safe error/result; the next operation will
        // revalidate the fixed target.
      }
    }
  }
}

async function parseExistingConnection(pathValue: string): Promise<RepositoryCloudConnection | undefined> {
  const bytes = await readConnectionBytes(pathValue);
  if (!bytes) return undefined;
  try {
    return parseRepositoryCloudConnection(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw normalizeUnexpected(error, "connection-invalid");
  }
}

function sameStableRemote(left: RepositoryCloudConnection, right: RepositoryCloudConnection): boolean {
  return left.id === right.id && left.nodeId === right.nodeId;
}

function sameConnection(left: RepositoryCloudConnection, right: RepositoryCloudConnection): boolean {
  return sameStableRemote(left, right)
    && left.owner === right.owner
    && left.name === right.name
    && left.url === right.url
    && left.private === right.private;
}

async function writeTemporaryFile(
  temporaryPath: string,
  bytes: Uint8Array,
): Promise<Stats> {
  let handle: FileHandle | undefined;
  let openedByUs = false;
  let createdIdentity: Stats | undefined;
  let failed = true;
  try {
    // `wx`/O_EXCL makes a stale or attacker-created fixed temp path an error;
    // no cleanup is attempted for a path we did not create.
    handle = await open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    openedByUs = true;
    const opened = await handle.stat();
    createdIdentity = opened;
    assertConnectionFileStat(opened);
    const pathStat = await lstat(temporaryPath);
    assertConnectionFileStat(pathStat);
    if (!sameFileIdentity(opened, pathStat)) fail("storage-unsafe");
    await handle.writeFile(bytes);
    await handle.sync();
    const final = await handle.stat();
    assertConnectionFileStat(final);
    if (!sameFileIdentity(opened, final) || statSize(final) !== bytes.byteLength) {
      fail("storage-unsafe");
    }
    failed = false;
    return final;
  } catch (error) {
    if (error instanceof RepositoryCloudConnectionStoreError) throw error;
    if (errorCode(error) === "EEXIST") fail("storage-unsafe");
    throw normalizeUnexpected(error);
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // The write/rename result remains authoritative.
      }
    }
    if (failed && openedByUs) {
      // The handle is closed before cleanup so this remains usable on
      // Windows.  If the first fstat failed, the ownership proof is
      // incomplete, so leave the fixed temp as an attention barrier rather
      // than risking removal of a path that may have been replaced.
      if (createdIdentity) await removeOwnedTemporaryFile(temporaryPath, createdIdentity);
    }
  }
}

async function removeOwnedTemporaryFile(pathValue: string, expected: Stats | undefined): Promise<void> {
  if (!expected) return;
  try {
    const current = await lstat(pathValue);
    assertConnectionFileStat(current);
    if (!sameFileIdentity(expected, current)) return;
    await unlink(pathValue);
  } catch {
    // Never remove an unverified path.  A stale fixed temp file is itself a
    // safe-stop signal and will be reported by the next operation.
  }
}

const storeLocks = new Map<string, Promise<void>>();

function lockKey(gitDirectory: string): string {
  return process.platform === "win32" ? gitDirectory.toLowerCase() : gitDirectory;
}

async function withStoreLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = storeLocks.get(key);
  let release!: () => void;
  const current = new Promise<void>((resolveRelease) => {
    release = resolveRelease;
  });
  storeLocks.set(key, current);
  if (previous) await previous;
  try {
    return await action();
  } finally {
    release();
    if (storeLocks.get(key) === current) storeLocks.delete(key);
  }
}

async function resolvedRoot(root: string): Promise<ResolvedRoot> {
  if (typeof root !== "string" || root.trim().length === 0 || !isAbsolute(root)) {
    fail("invalid-root");
  }
  try {
    const path = await assertSafeRoot(root);
    const identity = await lstat(path);
    assertDirectoryStat(identity);
    return { path, identity };
  } catch (error) {
    throw normalizeUnexpected(error, "invalid-root");
  }
}

/**
 * Persist/read only the fixed `.git/maginalia-connection.json` record.
 * The caller must provide an independently verified private remote; this
 * store does not authenticate or verify GitHub and never accepts a token.
 */
export class RepositoryCloudConnectionStore {
  public async read(resolvedRepositoryRoot: string): Promise<RepositoryCloudConnection | null> {
    const root = await resolvedRoot(resolvedRepositoryRoot);
    const gitDirectory = await assertSafeGitDirectory(root);
    const pathValue = join(gitDirectory, REPOSITORY_CLOUD_CONNECTION_FILE_NAME);
    return withStoreLock(lockKey(gitDirectory), async () => {
      try {
        await assertSafeGitDirectory(root);
        const connection = await parseExistingConnection(pathValue);
        return connection ?? null;
      } catch (error) {
        throw normalizeUnexpected(error);
      }
    });
  }

  public async write(
    resolvedRepositoryRoot: string,
    verifiedPrivateRemote: RepositoryCloudConnection,
  ): Promise<void> {
    let serialized: string;
    try {
      serialized = serializeRepositoryCloudConnection(verifiedPrivateRemote);
    } catch (error) {
      throw normalizeUnexpected(error, "connection-invalid");
    }
    const bytes = new TextEncoder().encode(serialized);
    if (bytes.byteLength > MAX_REPOSITORY_CLOUD_CONNECTION_BYTES) {
      fail("connection-too-large");
    }

    const root = await resolvedRoot(resolvedRepositoryRoot);
    const gitDirectory = await assertSafeGitDirectory(root);
    const pathValue = join(gitDirectory, REPOSITORY_CLOUD_CONNECTION_FILE_NAME);
    const temporaryPath = pathValue + TEMPORARY_FILE_SUFFIX;
    return withStoreLock(lockKey(gitDirectory), async () => {
      try {
        await assertSafeGitDirectory(root);
        const existing = await parseExistingConnection(pathValue);
        if (existing && !sameStableRemote(existing, verifiedPrivateRemote)) {
          fail("connection-mismatch");
        }
        if (existing && sameConnection(existing, verifiedPrivateRemote)) return;

        const temporaryBefore = await optionalLstat(temporaryPath);
        if (temporaryBefore) fail("storage-unsafe");
        let temporaryIdentity: Stats | undefined;
        try {
          temporaryIdentity = await writeTemporaryFile(temporaryPath, bytes);

          // Revalidate the parent and the target immediately before rename.
          // A target appearing in the meantime is allowed only when it is a
          // valid record for the same stable remote.
          await assertSafeGitDirectory(root);
          const targetBeforeRename = await parseExistingConnection(pathValue);
          if (targetBeforeRename && !sameStableRemote(targetBeforeRename, verifiedPrivateRemote)) {
            fail("connection-mismatch");
          }
          await rename(temporaryPath, pathValue);
          temporaryIdentity = undefined;
        } finally {
          if (temporaryIdentity) await removeOwnedTemporaryFile(temporaryPath, temporaryIdentity);
        }
      } catch (error) {
        throw normalizeUnexpected(error);
      }
    });
  }
}
