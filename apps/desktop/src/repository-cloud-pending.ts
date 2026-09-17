import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, rename, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, parse, resolve } from "node:path";
import { TextDecoder, TextEncoder } from "node:util";
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

/**
 * This module is a main-process-only boundary. The in-process lock protects
 * multiple ledger instances in one Electron process; cross-process safety is
 * deliberately delegated to the later Electron single-instance lock.
 */
export const PENDING_CLOUD_CREATION_FILE_NAME = "maginalia-pending-cloud.json" as const;
export const PENDING_CLOUD_CREATION_SCHEMA_VERSION = 1 as const;
export const MAX_PENDING_CLOUD_CREATIONS = 20;
export const MAX_PENDING_CLOUD_CREATION_BYTES = 64 * 1024;

const PENDING_CLOUD_CREATION_TEMP_SUFFIX = ".tmp";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
const NODE_ID_PATTERN = /^[A-Za-z0-9+/=_:.-]+$/;
const MAX_OWNER_LENGTH = 39;
const MAX_REPOSITORY_NAME_LENGTH = 100;
const MAX_NODE_ID_LENGTH = 512;
const PENDING_RECORD_KEYS = ["identityId", "kind", "storageName", "accountId", "state"] as const;
const PENDING_CANDIDATE_KEYS = ["id", "nodeId", "owner", "name", "url"] as const;
const PENDING_VERIFIED_CANDIDATE_KEYS = [...PENDING_CANDIDATE_KEYS, "private"] as const;
const PENDING_ROOT_KEYS = ["schemaVersion", "records"] as const;
const REPOSITORY_KINDS = new Set<RepositoryKind>(["project", "workbench", "shelf"]);

export type PendingCloudCreationState = "intent" | "candidate";

export interface PendingCloudCreationCandidate {
  readonly id: number;
  readonly nodeId: string;
  readonly owner: string;
  readonly name: string;
  readonly url: string;
}

/**
 * A candidate after independent provider verification and connection binding.
 * The literal marker is required by clearAfterConnection; an unverified POST
 * response cannot clear a pending operation.
 */
export interface PendingCloudCreationVerifiedCandidate extends PendingCloudCreationCandidate {
  readonly private: true;
}

export interface PendingCloudCreationRecord {
  readonly identityId: string;
  readonly kind: RepositoryKind;
  readonly storageName: string;
  readonly accountId: number;
  readonly state: PendingCloudCreationState;
  readonly candidate?: PendingCloudCreationCandidate;
}

export type PendingCloudCreationErrorCode =
  | "invalid-input"
  | "storage-unsafe"
  | "storage-io"
  | "ledger-corrupt"
  | "unsupported-version"
  | "ledger-too-large"
  | "limit-reached"
  | "account-mismatch"
  | "identity-mismatch"
  | "missing-intent"
  | "candidate-already-recorded"
  | "already-pending"
  | "not-verified"
  | "candidate-mismatch";

const ERROR_MESSAGES: Readonly<Record<PendingCloudCreationErrorCode, string>> = Object.freeze({
  "invalid-input": "The pending cloud operation input is invalid.",
  "storage-unsafe": "The pending cloud operation storage is unsafe.",
  "storage-io": "The pending cloud operation could not be stored safely.",
  "ledger-corrupt": "The pending cloud operation ledger is invalid.",
  "unsupported-version": "The pending cloud operation ledger version is unsupported.",
  "ledger-too-large": "The pending cloud operation ledger exceeds the safety limit.",
  "limit-reached": "The pending cloud operation safety limit has been reached.",
  "account-mismatch": "The pending cloud operation belongs to a different GitHub account.",
  "identity-mismatch": "The pending cloud operation does not match this repository identity.",
  "missing-intent": "No pending cloud creation intent exists for this repository.",
  "candidate-already-recorded": "A different candidate is already recorded for this operation.",
  "already-pending": "A pending cloud creation already exists and needs attention.",
  "not-verified": "The pending cloud candidate has not been independently verified and bound.",
  "candidate-mismatch": "The verified cloud connection does not match the pending candidate.",
});

export class PendingCloudCreationError extends Error {
  public readonly code: PendingCloudCreationErrorCode;
  public readonly userMessage: string;

  public constructor(code: PendingCloudCreationErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "PendingCloudCreationError";
    this.code = code;
    this.userMessage = this.message;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

interface IdentityBinding {
  readonly identityId: string;
  readonly kind: RepositoryKind;
  readonly storageName: string;
}

const ledgerLocks = new Map<string, Promise<void>>();

function fail(code: PendingCloudCreationErrorCode): never {
  throw new PendingCloudCreationError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function ownDataDescriptor(value: Record<string, unknown>, key: string): PropertyDescriptor | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor : undefined;
  } catch {
    return undefined;
  }
}

function ownValue(value: Record<string, unknown>, key: string): unknown {
  return ownDataDescriptor(value, key)?.value;
}

function hasExactDataKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  try {
    const keys = Reflect.ownKeys(value);
    return keys.length === expected.length
      && keys.every((key) => typeof key === "string" && expected.includes(key))
      && expected.every((key) => ownDataDescriptor(value, key) !== undefined);
  } catch {
    return false;
  }
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSafeRepositoryKind(value: unknown): value is RepositoryKind {
  return typeof value === "string" && REPOSITORY_KINDS.has(value as RepositoryKind);
}

function isSafeOwner(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_OWNER_LENGTH
    && OWNER_PATTERN.test(value);
}

function isSafeRepositoryName(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_REPOSITORY_NAME_LENGTH
    && value !== "."
    && value !== ".."
    && REPOSITORY_NAME_PATTERN.test(value);
}

function isSafeNodeId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_NODE_ID_LENGTH
    && NODE_ID_PATTERN.test(value);
}

function cloneUrlFor(owner: string, name: string): string {
  return `https://github.com/${owner}/${name}.git`;
}

function isExactCloneUrl(value: unknown, owner: string, name: string): value is string {
  const expected = cloneUrlFor(owner, name);
  if (value !== expected) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && parsed.hostname === "github.com"
      && parsed.port === ""
      && parsed.username === ""
      && parsed.password === ""
      && parsed.search === ""
      && parsed.hash === ""
      && parsed.pathname === `/${owner}/${name}.git`;
  } catch {
    return false;
  }
}

function normalizeIdentityId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) fail("invalid-input");
  return value.toLowerCase();
}

function storageNameFor(kind: RepositoryKind, identityId: string): string {
  return `maginalia-${kind}-${identityId.replaceAll("-", "")}`;
}

async function identityBinding(value: unknown): Promise<IdentityBinding> {
  try {
    const repositoryCore = await loadRepositoryCore();
    const identity = repositoryCore.parseIdentity(value);
    const identityId = normalizeIdentityId(identity.id);
    const expectedStorageName = repositoryCore.storageName(identity);
    if (expectedStorageName !== storageNameFor(identity.kind, identityId)) fail("invalid-input");
    return Object.freeze({
      identityId,
      kind: identity.kind,
      storageName: expectedStorageName,
    });
  } catch (error) {
    if (error instanceof PendingCloudCreationError) throw error;
    fail("invalid-input");
  }
}

function validateAccountId(value: unknown): number {
  if (!isPositiveSafeInteger(value)) fail("invalid-input");
  return value;
}

function validateCandidate(value: unknown, failureCode: PendingCloudCreationErrorCode): PendingCloudCreationCandidate {
  if (!hasExactDataKeys(value, PENDING_CANDIDATE_KEYS)) fail(failureCode);
  const id = ownValue(value, "id");
  const nodeId = ownValue(value, "nodeId");
  const owner = ownValue(value, "owner");
  const name = ownValue(value, "name");
  const url = ownValue(value, "url");
  if (!isPositiveSafeInteger(id)
    || !isSafeNodeId(nodeId)
    || !isSafeOwner(owner)
    || !isSafeRepositoryName(name)
    || !isExactCloneUrl(url, owner, name)) fail(failureCode);
  return Object.freeze({ id, nodeId, owner, name, url });
}

function validateVerifiedCandidate(
  value: unknown,
): PendingCloudCreationVerifiedCandidate {
  if (!hasExactDataKeys(value, PENDING_VERIFIED_CANDIDATE_KEYS)) fail("invalid-input");
  if (ownValue(value, "private") !== true) fail("not-verified");
  const candidate = validateCandidate({
    id: ownValue(value, "id"),
    nodeId: ownValue(value, "nodeId"),
    owner: ownValue(value, "owner"),
    name: ownValue(value, "name"),
    url: ownValue(value, "url"),
  }, "invalid-input");
  return Object.freeze({ ...candidate, private: true as const });
}

function freezeIntent(
  identityId: string,
  kind: RepositoryKind,
  storageName: string,
  accountId: number,
): PendingCloudCreationRecord {
  return Object.freeze({ identityId, kind, storageName, accountId, state: "intent" as const });
}

function freezeCandidateRecord(
  identityId: string,
  kind: RepositoryKind,
  storageName: string,
  accountId: number,
  candidate: PendingCloudCreationCandidate,
): PendingCloudCreationRecord {
  return Object.freeze({
    identityId,
    kind,
    storageName,
    accountId,
    state: "candidate" as const,
    candidate,
  });
}

function parseStoredRecord(value: unknown): PendingCloudCreationRecord {
  if (!isPlainRecord(value)) fail("ledger-corrupt");
  const state = ownValue(value, "state");
  const keys = state === "intent"
    ? PENDING_RECORD_KEYS
    : state === "candidate"
      ? [...PENDING_RECORD_KEYS, "candidate"]
      : [];
  if (keys.length === 0 || !hasExactDataKeys(value, keys)) fail("ledger-corrupt");

  const identityId = ownValue(value, "identityId");
  const kind = ownValue(value, "kind");
  const storageName = ownValue(value, "storageName");
  const accountId = ownValue(value, "accountId");
  if (typeof identityId !== "string"
    || identityId !== identityId.toLowerCase()
    || !UUID_PATTERN.test(identityId)
    || !isSafeRepositoryKind(kind)
    || storageName !== storageNameFor(kind, identityId)
    || !isPositiveSafeInteger(accountId)) {
    fail("ledger-corrupt");
  }

  if (state === "intent") return freezeIntent(identityId, kind, storageName, accountId);
  const candidate = validateCandidate(ownValue(value, "candidate"), "ledger-corrupt");
  return freezeCandidateRecord(identityId, kind, storageName, accountId, candidate);
}

function parseLedger(bytes: Uint8Array): readonly PendingCloudCreationRecord[] {
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    fail("ledger-corrupt");
  }
  if (!hasExactDataKeys(value, PENDING_ROOT_KEYS)) fail("ledger-corrupt");
  const version = ownValue(value, "schemaVersion");
  if (version !== PENDING_CLOUD_CREATION_SCHEMA_VERSION) fail("unsupported-version");
  const rawRecords = ownValue(value, "records");
  if (!Array.isArray(rawRecords)) fail("ledger-corrupt");
  if (rawRecords.length > MAX_PENDING_CLOUD_CREATIONS) fail("limit-reached");

  const seen = new Set<string>();
  const records = rawRecords.map((rawRecord) => {
    const record = parseStoredRecord(rawRecord);
    if (seen.has(record.identityId)) fail("ledger-corrupt");
    seen.add(record.identityId);
    return record;
  });
  return Object.freeze(records);
}

function candidateToJson(candidate: PendingCloudCreationCandidate): Record<string, unknown> {
  return {
    id: candidate.id,
    nodeId: candidate.nodeId,
    owner: candidate.owner,
    name: candidate.name,
    url: candidate.url,
  };
}

function recordToJson(record: PendingCloudCreationRecord): Record<string, unknown> {
  const base = {
    identityId: record.identityId,
    kind: record.kind,
    storageName: record.storageName,
    accountId: record.accountId,
    state: record.state,
  };
  return record.state === "candidate"
    ? { ...base, candidate: candidateToJson(record.candidate!) }
    : base;
}

function encodeLedger(records: readonly PendingCloudCreationRecord[]): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify({
    schemaVersion: PENDING_CLOUD_CREATION_SCHEMA_VERSION,
    records: records.map(recordToJson),
  }) + "\n");
  if (bytes.byteLength > MAX_PENDING_CLOUD_CREATION_BYTES) fail("ledger-too-large");
  return bytes;
}

function nodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  try {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

function storageError(error: unknown): PendingCloudCreationError {
  if (error instanceof PendingCloudCreationError) return error;
  return new PendingCloudCreationError("storage-io");
}

function linkCount(stat: Stats): number {
  return typeof stat.nlink === "bigint" ? Number(stat.nlink) : stat.nlink;
}

function assertDirectoryStat(stat: Stats): void {
  // POSIX directory link counts commonly exceed one, so link count is not a
  // safety signal for directory ancestors. lstat still rejects symlink
  // traversal explicitly.
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail("storage-unsafe");
  }
}

async function assertSafeDirectory(directory: string): Promise<void> {
  let current = directory;
  for (;;) {
    let stat: Stats;
    try {
      stat = await lstat(current);
    } catch {
      fail("storage-unsafe");
    }
    assertDirectoryStat(stat);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function optionalLstat(pathValue: string): Promise<Stats | undefined> {
  try {
    return await lstat(pathValue);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return undefined;
    throw storageError(error);
  }
}

function assertRegularLedgerFile(stat: Stats): void {
  if (stat.isSymbolicLink() || !stat.isFile() || (Number.isSafeInteger(linkCount(stat)) && linkCount(stat) > 1)) {
    fail("storage-unsafe");
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function safeFileSize(value: number | bigint): number {
  const size = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_PENDING_CLOUD_CREATION_BYTES) {
    fail("ledger-too-large");
  }
  return size;
}

const NO_FOLLOW = typeof (fsConstants as { readonly O_NOFOLLOW?: unknown }).O_NOFOLLOW === "number"
  ? (fsConstants as { readonly O_NOFOLLOW: number }).O_NOFOLLOW
  : 0;

async function readLedgerBytes(pathValue: string): Promise<Uint8Array | undefined> {
  const target = await optionalLstat(pathValue);
  if (!target) return undefined;
  assertRegularLedgerFile(target);
  const expectedSize = safeFileSize(target.size);
  let handle: FileHandle | undefined;
  try {
    handle = await open(pathValue, fsConstants.O_RDONLY | NO_FOLLOW);
    const opened = await handle.stat();
    assertRegularLedgerFile(opened);
    // O_NOFOLLOW is unavailable on some Windows builds. Confirm that the
    // opened descriptor is the same file that lstat inspected before reading;
    // this rejects a symlink/file swap that would otherwise cross the target
    // boundary. Cross-process mutation still depends on the Electron lock.
    if (!sameFileIdentity(target, opened)) fail("storage-unsafe");
    const size = safeFileSize(opened.size);
    if (size !== expectedSize) fail("storage-unsafe");
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const result = await handle.read(bytes, offset, size - offset, offset);
      if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead <= 0) fail("ledger-corrupt");
      offset += result.bytesRead;
    }
    const finalStat = await handle.stat();
    if (!sameFileIdentity(target, finalStat) || safeFileSize(finalStat.size) !== size) {
      fail("storage-unsafe");
    }
    return new Uint8Array(bytes);
  } catch (error) {
    if (error instanceof PendingCloudCreationError) throw error;
    throw storageError(error);
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // The bounded read result or safe error above remains authoritative.
      }
    }
  }
}

async function readRecords(directory: string, pathValue: string): Promise<readonly PendingCloudCreationRecord[]> {
  await assertSafeDirectory(directory);
  const bytes = await readLedgerBytes(pathValue);
  return bytes === undefined ? Object.freeze([]) : parseLedger(bytes);
}

async function writeRecords(
  directory: string,
  pathValue: string,
  records: readonly PendingCloudCreationRecord[],
): Promise<void> {
  if (records.length > MAX_PENDING_CLOUD_CREATIONS) fail("limit-reached");
  const bytes = encodeLedger(records);
  await assertSafeDirectory(directory);
  const target = await optionalLstat(pathValue);
  if (target) assertRegularLedgerFile(target);

  const temporaryPath = pathValue + PENDING_CLOUD_CREATION_TEMP_SUFFIX;
  let handle: FileHandle | undefined;
  try {
    // wx refuses an existing file or symlink; stale temporary files are not
    // removed because cleanup would turn an interrupted write into a guess.
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    throw storageError(error);
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // A failed close is reported by rename or the next safe operation.
      }
    }
  }

  try {
    const targetBeforeRename = await optionalLstat(pathValue);
    if (targetBeforeRename) assertRegularLedgerFile(targetBeforeRename);
    await rename(temporaryPath, pathValue);
  } catch (error) {
    throw storageError(error);
  }
}

async function withLedgerLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = ledgerLocks.get(key);
  let release!: () => void;
  const current = new Promise<void>((resolveRelease) => {
    release = resolveRelease;
  });
  ledgerLocks.set(key, current);
  if (previous) await previous;
  try {
    return await action();
  } finally {
    release();
    if (ledgerLocks.get(key) === current) ledgerLocks.delete(key);
  }
}

function lockKey(directory: string): string {
  const normalized = normalize(directory);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sameCandidate(left: PendingCloudCreationCandidate, right: PendingCloudCreationCandidate): boolean {
  return left.id === right.id
    && left.nodeId === right.nodeId
    && left.owner === right.owner
    && left.name === right.name
    && left.url === right.url;
}

export class PendingCloudCreationLedger {
  readonly #directory: string;
  readonly #path: string;
  readonly #lockKey: string;

  public constructor(appDataDirectory: string) {
    if (typeof appDataDirectory !== "string" || !isAbsolute(appDataDirectory)) fail("invalid-input");
    const directory = resolve(appDataDirectory);
    if (directory === parse(directory).root) fail("storage-unsafe");
    this.#directory = directory;
    this.#path = join(directory, PENDING_CLOUD_CREATION_FILE_NAME);
    this.#lockKey = lockKey(directory);
  }

  public async get(identityId: string): Promise<PendingCloudCreationRecord | undefined> {
    const normalizedId = normalizeIdentityId(identityId);
    return withLedgerLock(this.#lockKey, async () => {
      const records = await readRecords(this.#directory, this.#path);
      return records.find((record) => record.identityId === normalizedId);
    });
  }

  public async begin(identity: RepositoryIdentity, accountId: number): Promise<PendingCloudCreationRecord> {
    const binding = await identityBinding(identity);
    const normalizedAccountId = validateAccountId(accountId);
    return withLedgerLock(this.#lockKey, async () => {
      const records = await readRecords(this.#directory, this.#path);
      const existing = records.find((record) => record.identityId === binding.identityId);
      if (existing) {
        if (existing.accountId !== normalizedAccountId) fail("account-mismatch");
        if (existing.kind !== binding.kind || existing.storageName !== binding.storageName) {
          fail("identity-mismatch");
        }
        // Existing intent and candidate records are both attention barriers.
        // Returning either one could let a caller mistake it for a newly
        // persisted intent and issue a second POST.
        fail("already-pending");
      }
      if (records.length >= MAX_PENDING_CLOUD_CREATIONS) fail("limit-reached");
      const intent = freezeIntent(
        binding.identityId,
        binding.kind,
        binding.storageName,
        normalizedAccountId,
      );
      await writeRecords(this.#directory, this.#path, [...records, intent]);
      return intent;
    });
  }

  public async recordCandidate(
    identityId: string,
    accountId: number,
    candidate: PendingCloudCreationCandidate,
  ): Promise<PendingCloudCreationRecord> {
    const normalizedId = normalizeIdentityId(identityId);
    const normalizedAccountId = validateAccountId(accountId);
    const normalizedCandidate = validateCandidate(candidate, "invalid-input");
    return withLedgerLock(this.#lockKey, async () => {
      const records = await readRecords(this.#directory, this.#path);
      const index = records.findIndex((record) => record.identityId === normalizedId);
      if (index < 0) fail("missing-intent");
      const existing = records[index]!;
      if (existing.accountId !== normalizedAccountId) fail("account-mismatch");
      if (existing.state === "candidate") {
        if (sameCandidate(existing.candidate!, normalizedCandidate)) return existing;
        fail("candidate-already-recorded");
      }
      if (normalizedCandidate.name !== existing.storageName) fail("identity-mismatch");
      const recorded = freezeCandidateRecord(
        existing.identityId,
        existing.kind,
        existing.storageName,
        existing.accountId,
        normalizedCandidate,
      );
      const next = records.slice();
      next[index] = recorded;
      await writeRecords(this.#directory, this.#path, next);
      return recorded;
    });
  }

  public async clearAfterConnection(
    identityId: string,
    accountId: number,
    verifiedCandidate: PendingCloudCreationVerifiedCandidate,
  ): Promise<void> {
    const normalizedId = normalizeIdentityId(identityId);
    const normalizedAccountId = validateAccountId(accountId);
    const normalizedVerified = validateVerifiedCandidate(verifiedCandidate);
    return withLedgerLock(this.#lockKey, async () => {
      const records = await readRecords(this.#directory, this.#path);
      const existing = records.find((record) => record.identityId === normalizedId);
      if (!existing) return;
      if (existing.accountId !== normalizedAccountId) fail("account-mismatch");
      if (existing.state !== "candidate") fail("not-verified");
      if (!sameCandidate(existing.candidate!, normalizedVerified)) fail("candidate-mismatch");
      await writeRecords(
        this.#directory,
        this.#path,
        records.filter((record) => record.identityId !== normalizedId),
      );
    });
  }
}
