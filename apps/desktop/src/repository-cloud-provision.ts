/**
 * Main-process-only idempotent private-cloud setup.
 *
 * This is only the explicit provisioning state machine. It does not perform
 * Git transport and never accepts or stores a token.
 */

import type {
  GitHubAdapter,
  GitHubOperationOptions,
  UnverifiedPrivateCandidate,
  VerifiedPrivateRemote,
} from "./repository-github";
import {
  PendingCloudCreationError,
  PendingCloudCreationLedger,
  type PendingCloudCreationCandidate,
  type PendingCloudCreationRecord,
} from "./repository-cloud-pending";
import { RepositoryCloudConnectionStore } from "./repository-cloud-connection-store";
import {
  parseRepositoryCloudConnection,
  serializeRepositoryCloudConnection,
  type RepositoryCloudConnection,
} from "./repository-cloud-connection";
import { inspectRepository, type LocalRepositoryInspection } from "./repository-local-history";
import { parseIdentity, storageName } from "@maginalia/repository-core";
import type { RepositoryIdentity } from "@maginalia/repository-core" with { "resolution-mode": "import" };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_TIMEOUT_MS = 60_000;

export type RepositoryCloudProvisionErrorCode =
  | "INVALID_INPUT"
  | "LOCAL_REPOSITORY_INVALID"
  | "LOCAL_IDENTITY_MISMATCH"
  | "ACCOUNT_PREFLIGHT_FAILED"
  | "INSTALLATION_PREFLIGHT_FAILED"
  | "ACCOUNT_MISMATCH"
  | "PENDING_ATTENTION"
  | "PENDING_PERSIST_FAILED"
  | "CREATE_FAILED"
  | "CANDIDATE_UNVERIFIED"
  | "REMOTE_VERIFY_FAILED"
  | "CONNECTION_PERSIST_FAILED"
  | "PENDING_CLEAR_FAILED"
  | "ABORTED"
  | "TIMEOUT"
  | "NETWORK_ERROR";

const ERROR_MESSAGES: Readonly<Record<RepositoryCloudProvisionErrorCode, string>> = Object.freeze({
  INVALID_INPUT: "The private cloud provisioning input is invalid.",
  LOCAL_REPOSITORY_INVALID: "The local repository could not be inspected safely.",
  LOCAL_IDENTITY_MISMATCH: "The local repository identity does not match the requested setup.",
  ACCOUNT_PREFLIGHT_FAILED: "The GitHub account could not be confirmed.",
  INSTALLATION_PREFLIGHT_FAILED: "The GitHub App installation could not be confirmed.",
  ACCOUNT_MISMATCH: "The pending cloud operation belongs to a different GitHub account.",
  PENDING_ATTENTION: "A pending cloud operation needs attention before setup can continue.",
  PENDING_PERSIST_FAILED: "The pending cloud operation could not be stored safely.",
  CREATE_FAILED: "The private GitHub repository could not be created safely.",
  CANDIDATE_UNVERIFIED: "The private GitHub repository candidate could not be verified.",
  REMOTE_VERIFY_FAILED: "The private GitHub repository could not be independently verified.",
  CONNECTION_PERSIST_FAILED: "The local cloud connection could not be stored safely.",
  PENDING_CLEAR_FAILED: "The completed cloud operation could not be cleared safely.",
  ABORTED: "The private cloud provisioning was cancelled.",
  TIMEOUT: "The private cloud provisioning timed out.",
  NETWORK_ERROR: "The private cloud provisioning failed due to a network error.",
});

/** Errors contain fixed local classifications only. */
export class RepositoryCloudProvisionError extends Error {
  public readonly code: RepositoryCloudProvisionErrorCode;
  public readonly userMessage: string;

  public constructor(code: RepositoryCloudProvisionErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "RepositoryCloudProvisionError";
    this.code = code;
    this.userMessage = this.message;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type RepositoryCloudProvisionProvider = Pick<
  GitHubAdapter,
  "account" | "verifyPersonalInstallation" | "createPrivateCandidate" | "verifyCreatedCandidate" | "verifyRemote"
>;

export type RepositoryCloudProvisionLedger = Pick<
  PendingCloudCreationLedger,
  "get" | "begin" | "recordCandidate" | "clearAfterConnection"
>;

export type RepositoryCloudProvisionConnectionStore = Pick<
  RepositoryCloudConnectionStore,
  "read" | "write"
>;

export interface RepositoryCloudProvisionOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export type RepositoryCloudProvisionResult = Readonly<{
  readonly status: "connected" | "already-connected";
}>;

interface NormalizedOptions {
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number | undefined;
}

function fail(code: RepositoryCloudProvisionErrorCode): never {
  throw new RepositoryCloudProvisionError(code);
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

function ownValue(value: Record<string, unknown>, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function hasExactDataKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  try {
    const keys = Reflect.ownKeys(value);
    return keys.length === expected.length
      && keys.every((key) => typeof key === "string" && expected.includes(key))
      && expected.every((key) => ownValue(value, key) !== undefined);
  } catch {
    return false;
  }
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  if (!isRecord(value)) return false;
  try {
    return typeof value.addEventListener === "function"
      && typeof value.removeEventListener === "function"
      && typeof value.aborted === "boolean";
  } catch {
    return false;
  }
}

function normalizeOptions(value: RepositoryCloudProvisionOptions | undefined): NormalizedOptions {
  if (value === undefined) return Object.freeze({ signal: undefined, timeoutMs: undefined });
  if (!isPlainRecord(value)) fail("INVALID_INPUT");
  let keys: (string | symbol)[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    fail("INVALID_INPUT");
  }
  const allowed = new Set(["signal", "timeoutMs"]);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) fail("INVALID_INPUT");
  const signal = ownValue(value, "signal");
  const timeout = ownValue(value, "timeoutMs");
  if (signal !== undefined && !isAbortSignal(signal)) fail("INVALID_INPUT");
  if (timeout !== undefined
    && (typeof timeout !== "number" || !Number.isSafeInteger(timeout)
      || timeout <= 0 || timeout > MAX_TIMEOUT_MS)) fail("INVALID_INPUT");
  return Object.freeze({
    signal: signal as AbortSignal | undefined,
    timeoutMs: timeout as number | undefined,
  });
}

function providerOptions(options: NormalizedOptions): GitHubOperationOptions | undefined {
  if (options.signal === undefined && options.timeoutMs === undefined) return undefined;
  return Object.freeze({
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

function normalizeIdentity(value: unknown): RepositoryIdentity {
  try {
    const identity = parseIdentity(value);
    return Object.freeze({ ...identity, id: identity.id.toLowerCase() });
  } catch {
    fail("INVALID_INPUT");
  }
}

function sameIdentity(left: RepositoryIdentity, right: RepositoryIdentity): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.id.toLowerCase() === right.id.toLowerCase()
    && left.kind === right.kind
    && left.title === right.title
    && left.templateVersion === right.templateVersion;
}

function normalizeAccountId(value: unknown): number {
  if (!isRecord(value)) fail("ACCOUNT_PREFLIGHT_FAILED");
  const id = ownValue(value, "id");
  if (!isPositiveSafeInteger(id)) fail("ACCOUNT_PREFLIGHT_FAILED");
  return id;
}

function validateInstallation(value: unknown, accountId: number): void {
  if (!isRecord(value)) fail("INSTALLATION_PREFLIGHT_FAILED");
  const installationId = ownValue(value, "installationId");
  const observedAccountId = ownValue(value, "accountId");
  const appId = ownValue(value, "appId");
  if (!isPositiveSafeInteger(installationId)
    || !isPositiveSafeInteger(observedAccountId)
    || !isPositiveSafeInteger(appId)
    || observedAccountId !== accountId) {
    fail("INSTALLATION_PREFLIGHT_FAILED");
  }
}

function normalizeCandidate(value: unknown): PendingCloudCreationCandidate {
  if (!hasExactDataKeys(value, ["id", "nodeId", "owner", "name", "url"])) {
    fail("CANDIDATE_UNVERIFIED");
  }
  const fields = {
    id: ownValue(value, "id"),
    nodeId: ownValue(value, "nodeId"),
    owner: ownValue(value, "owner"),
    name: ownValue(value, "name"),
    url: ownValue(value, "url"),
  };
  try {
    const normalized = parseRepositoryCloudConnection(serializeRepositoryCloudConnection({
      ...fields,
      private: true,
    }));
    return Object.freeze({
      id: normalized.id,
      nodeId: normalized.nodeId,
      owner: normalized.owner,
      name: normalized.name,
      url: normalized.url,
    });
  } catch {
    fail("CANDIDATE_UNVERIFIED");
  }
}

function normalizeRemote(value: unknown, code: RepositoryCloudProvisionErrorCode): RepositoryCloudConnection {
  try {
    return parseRepositoryCloudConnection(serializeRepositoryCloudConnection(value));
  } catch {
    fail(code);
  }
}

function sameCandidate(left: PendingCloudCreationCandidate, right: PendingCloudCreationCandidate): boolean {
  return left.id === right.id
    && left.nodeId === right.nodeId
    && left.owner === right.owner
    && left.name === right.name
    && left.url === right.url;
}

function normalizePending(
  value: unknown,
  identity: RepositoryIdentity,
  accountId: number,
): PendingCloudCreationRecord | undefined {
  if (value === undefined) return undefined;
  const record = value as PendingCloudCreationRecord;
  if (!isRecord(value) || (record.state !== "intent" && record.state !== "candidate")) {
    fail("PENDING_PERSIST_FAILED");
  }
  const identityId = ownValue(value, "identityId");
  const storedAccountId = ownValue(value, "accountId");
  if (typeof identityId !== "string"
    || !UUID_PATTERN.test(identityId)
    || identityId.toLowerCase() !== identity.id
    || ownValue(value, "kind") !== identity.kind
    || ownValue(value, "storageName") !== storageName(identity)
    || !isPositiveSafeInteger(storedAccountId)) {
    fail("PENDING_PERSIST_FAILED");
  }
  if (storedAccountId !== accountId) fail("ACCOUNT_MISMATCH");
  if (record.state === "intent") {
    return Object.freeze({
      identityId: identity.id,
      kind: identity.kind,
      storageName: storageName(identity),
      accountId,
      state: "intent" as const,
    });
  }
  const candidate = normalizeCandidate(ownValue(value, "candidate"));
  if (candidate.name !== storageName(identity)) fail("PENDING_PERSIST_FAILED");
  return Object.freeze({
    identityId: identity.id,
    kind: identity.kind,
    storageName: storageName(identity),
    accountId,
    state: "candidate" as const,
    candidate,
  });
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  try {
    return typeof error.code === "string" ? error.code : undefined;
  } catch {
    return undefined;
  }
}

function errorName(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  try {
    return typeof error.name === "string" ? error.name : undefined;
  } catch {
    return undefined;
  }
}

function normalizeFailure(
  error: unknown,
  signal: AbortSignal | undefined,
  fallback: RepositoryCloudProvisionErrorCode,
): RepositoryCloudProvisionError {
  if (error instanceof RepositoryCloudProvisionError) return error;
  if (signal?.aborted || errorName(error) === "AbortError" || errorCode(error) === "ABORT_ERR") {
    return new RepositoryCloudProvisionError("ABORTED");
  }
  if (errorName(error) === "TimeoutError" || errorCode(error) === "ETIMEDOUT") {
    return new RepositoryCloudProvisionError("TIMEOUT");
  }
  const code = errorCode(error);
  if (code === "NETWORK_ERROR" || code === "ECONNRESET" || code === "ENETUNREACH" || code === "ECONNREFUSED") {
    return new RepositoryCloudProvisionError("NETWORK_ERROR");
  }
  if (error instanceof PendingCloudCreationError) {
    if (error.code === "account-mismatch") return new RepositoryCloudProvisionError("ACCOUNT_MISMATCH");
    if (error.code === "already-pending" || error.code === "candidate-already-recorded" || error.code === "not-verified") {
      return new RepositoryCloudProvisionError("PENDING_ATTENTION");
    }
  }
  return new RepositoryCloudProvisionError(fallback);
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) fail("ABORTED");
}

async function call<T>(
  action: () => Promise<T>,
  options: NormalizedOptions,
  fallback: RepositoryCloudProvisionErrorCode,
): Promise<T> {
  try {
    const result = await action();
    checkAborted(options.signal);
    return result;
  } catch (error) {
    throw normalizeFailure(error, options.signal, fallback);
  }
}

/**
 * Network verification can suspend this coordinator for an arbitrary period.
 * Re-inspect the trusted local root immediately before binding metadata so a
 * title/identity or root replacement during that wait cannot be bound to the
 * remote result.
 */
async function recheckBeforeConnectionWrite(
  root: string,
  baseline: LocalRepositoryInspection,
  expectedIdentity: RepositoryIdentity,
  options: NormalizedOptions,
): Promise<void> {
  let current: LocalRepositoryInspection;
  try {
    current = await inspectRepository(root);
  } catch (error) {
    throw normalizeFailure(error, options.signal, "LOCAL_REPOSITORY_INVALID");
  }
  if (current.canonicalRoot !== baseline.canonicalRoot) fail("LOCAL_REPOSITORY_INVALID");
  const currentIdentity = normalizeIdentity(current.identity);
  if (!sameIdentity(currentIdentity, expectedIdentity)
    || !sameIdentity(currentIdentity, normalizeIdentity(baseline.identity))) {
    fail("LOCAL_IDENTITY_MISMATCH");
  }
  checkAborted(options.signal);
}

async function resolveCandidate(
  provider: RepositoryCloudProvisionProvider,
  ledger: RepositoryCloudProvisionLedger,
  connectionStore: RepositoryCloudProvisionConnectionStore,
  root: string,
  baselineInspection: LocalRepositoryInspection,
  identity: RepositoryIdentity,
  accountId: number,
  candidate: PendingCloudCreationCandidate,
  options: NormalizedOptions,
): Promise<RepositoryCloudProvisionResult> {
  const request = providerOptions(options);
  const verifiedCandidate = normalizeRemote(
    await call(
      () => request === undefined
        ? provider.verifyCreatedCandidate(candidate)
        : provider.verifyCreatedCandidate(candidate, request),
      options,
      "CANDIDATE_UNVERIFIED",
    ),
    "CANDIDATE_UNVERIFIED",
  );
  if (!sameCandidate(verifiedCandidate, candidate)) fail("CANDIDATE_UNVERIFIED");

  const verifiedRemote = normalizeRemote(
    await call(
      () => request === undefined
        ? provider.verifyRemote(verifiedCandidate)
        : provider.verifyRemote(verifiedCandidate, request),
      options,
      "REMOTE_VERIFY_FAILED",
    ),
    "REMOTE_VERIFY_FAILED",
  );
  if (verifiedRemote.id !== candidate.id || verifiedRemote.nodeId !== candidate.nodeId) {
    fail("REMOTE_VERIFY_FAILED");
  }

  await recheckBeforeConnectionWrite(root, baselineInspection, identity, options);
  await call(
    () => connectionStore.write(root, verifiedRemote),
    options,
    "CONNECTION_PERSIST_FAILED",
  );
  await call(
    () => ledger.clearAfterConnection(identity.id, accountId, verifiedCandidate),
    options,
    "PENDING_CLEAR_FAILED",
  );
  return Object.freeze({ status: "connected" as const });
}

/**
 * Explicitly provision one local identity. There is exactly one create path:
 * begin() persists intent first, then the returned candidate is persisted
 * before either verification call. Existing/pending state never POSTs.
 */
export async function provisionPrivateCloud(
  provider: RepositoryCloudProvisionProvider,
  ledger: RepositoryCloudProvisionLedger,
  connectionStore: RepositoryCloudProvisionConnectionStore,
  resolvedRepositoryRoot: string,
  expectedIdentity: RepositoryIdentity,
  options?: RepositoryCloudProvisionOptions,
): Promise<RepositoryCloudProvisionResult> {
  if (!isRecord(provider)
    || typeof provider.account !== "function"
    || typeof provider.verifyPersonalInstallation !== "function"
    || typeof provider.createPrivateCandidate !== "function"
    || typeof provider.verifyCreatedCandidate !== "function"
    || typeof provider.verifyRemote !== "function"
    || !isRecord(ledger)
    || typeof ledger.get !== "function"
    || typeof ledger.begin !== "function"
    || typeof ledger.recordCandidate !== "function"
    || typeof ledger.clearAfterConnection !== "function"
    || !isRecord(connectionStore)
    || typeof connectionStore.read !== "function"
    || typeof connectionStore.write !== "function") {
    fail("INVALID_INPUT");
  }
  if (typeof resolvedRepositoryRoot !== "string" || resolvedRepositoryRoot.trim().length === 0) {
    fail("INVALID_INPUT");
  }
  const identity = normalizeIdentity(expectedIdentity);
  const normalizedOptions = normalizeOptions(options);
  checkAborted(normalizedOptions.signal);

  let baselineInspection: LocalRepositoryInspection;
  try {
    baselineInspection = await inspectRepository(resolvedRepositoryRoot);
  } catch (error) {
    throw normalizeFailure(error, normalizedOptions.signal, "LOCAL_REPOSITORY_INVALID");
  }
  const inspectedIdentity = normalizeIdentity(baselineInspection.identity);
  if (!sameIdentity(inspectedIdentity, identity)) fail("LOCAL_IDENTITY_MISMATCH");

  const request = providerOptions(normalizedOptions);
  const accountRaw = await call(
    () => request === undefined ? provider.account() : provider.account(request),
    normalizedOptions,
    "ACCOUNT_PREFLIGHT_FAILED",
  );
  const accountId = normalizeAccountId(accountRaw);
  const installationRaw = await call(
    () => request === undefined
      ? provider.verifyPersonalInstallation(accountId)
      : provider.verifyPersonalInstallation(accountId, request),
    normalizedOptions,
    "INSTALLATION_PREFLIGHT_FAILED",
  );
  validateInstallation(installationRaw, accountId);

  const storedRaw = await call(
    () => connectionStore.read(resolvedRepositoryRoot),
    normalizedOptions,
    "CONNECTION_PERSIST_FAILED",
  );
  const stored = storedRaw === null
    ? null
    : normalizeRemote(storedRaw, "CONNECTION_PERSIST_FAILED");
  if (stored !== null) {
    const pending = normalizePending(
      await call(
        () => ledger.get(identity.id),
        normalizedOptions,
        "PENDING_PERSIST_FAILED",
      ),
      identity,
      accountId,
    );
    if (pending?.state === "intent") fail("PENDING_ATTENTION");
    if (pending?.state === "candidate"
      && (!pending.candidate
        || pending.candidate.id !== stored.id
        || pending.candidate.nodeId !== stored.nodeId)) {
      // A candidate for another stable remote must never be cleared merely
      // because some connection metadata already exists on disk.
      fail("PENDING_ATTENTION");
    }
    const verified = normalizeRemote(
      await call(
        () => request === undefined
          ? provider.verifyRemote(stored)
          : provider.verifyRemote(stored, request),
        normalizedOptions,
        "REMOTE_VERIFY_FAILED",
      ),
      "REMOTE_VERIFY_FAILED",
    );
    if (verified.id !== stored.id || verified.nodeId !== stored.nodeId) fail("REMOTE_VERIFY_FAILED");
    if (pending?.state === "candidate") {
      // The independent GraphQL verification above proves that the stable
      // candidate IDs still identify a private remote.  Keep the pending
      // candidate's original name/url for the ledger proof: the remote may
      // have been renamed after the connection write and before the crash.
      const verifiedCandidate = normalizeRemote(
        { ...pending.candidate, private: true as const },
        "CANDIDATE_UNVERIFIED",
      );
      if (verifiedCandidate.id !== verified.id || verifiedCandidate.nodeId !== verified.nodeId) {
        fail("PENDING_ATTENTION");
      }
      await recheckBeforeConnectionWrite(
        resolvedRepositoryRoot,
        baselineInspection,
        identity,
        normalizedOptions,
      );
      await call(
        () => connectionStore.write(resolvedRepositoryRoot, verified),
        normalizedOptions,
        "CONNECTION_PERSIST_FAILED",
      );
      await call(
        () => ledger.clearAfterConnection(identity.id, accountId, verifiedCandidate),
        normalizedOptions,
        "PENDING_CLEAR_FAILED",
      );
      return Object.freeze({ status: "already-connected" as const });
    }
    await recheckBeforeConnectionWrite(
      resolvedRepositoryRoot,
      baselineInspection,
      identity,
      normalizedOptions,
    );
    await call(
      () => connectionStore.write(resolvedRepositoryRoot, verified),
      normalizedOptions,
      "CONNECTION_PERSIST_FAILED",
    );
    return Object.freeze({ status: "already-connected" as const });
  }

  const pending = normalizePending(
    await call(
      () => ledger.get(identity.id),
      normalizedOptions,
      "PENDING_PERSIST_FAILED",
    ),
    identity,
    accountId,
  );
  if (pending?.state === "intent") fail("PENDING_ATTENTION");
  if (pending?.state === "candidate") {
    if (!pending.candidate) fail("PENDING_PERSIST_FAILED");
    return resolveCandidate(
      provider,
      ledger,
      connectionStore,
      resolvedRepositoryRoot,
      baselineInspection,
      identity,
      accountId,
      pending.candidate,
      normalizedOptions,
    );
  }

  const begun = normalizePending(
    await call(
      () => ledger.begin(identity, accountId),
      normalizedOptions,
      "PENDING_PERSIST_FAILED",
    ),
    identity,
    accountId,
  );
  if (!begun || begun.state !== "intent") fail("PENDING_ATTENTION");
  checkAborted(normalizedOptions.signal);

  const requestedName = storageName(identity);
  const candidate = normalizeCandidate(
    await call(
      () => request === undefined
        ? provider.createPrivateCandidate(requestedName)
        : provider.createPrivateCandidate(requestedName, request),
      normalizedOptions,
      "CREATE_FAILED",
    ),
  );
  if (candidate.name !== requestedName) fail("CANDIDATE_UNVERIFIED");
  const recorded = normalizePending(
    await call(
      () => ledger.recordCandidate(identity.id, accountId, candidate),
      normalizedOptions,
      "PENDING_PERSIST_FAILED",
    ),
    identity,
    accountId,
  );
  if (!recorded || recorded.state !== "candidate" || !recorded.candidate
    || !sameCandidate(recorded.candidate, candidate)) {
    fail("PENDING_PERSIST_FAILED");
  }
  return resolveCandidate(
    provider,
    ledger,
    connectionStore,
    resolvedRepositoryRoot,
    baselineInspection,
    identity,
    accountId,
    recorded.candidate,
    normalizedOptions,
  );
}
