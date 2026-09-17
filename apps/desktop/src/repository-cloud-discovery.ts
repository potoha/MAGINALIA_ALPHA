/**
 * Main-process-only Restore discovery. This deliberately has no renderer or
 * filesystem surface: it consumes the bounded GitHub adapter results and
 * returns only verified portable identities with private remote metadata.
 */

import type { RepositoryIdentity } from "@maginalia/repository-core" with { "resolution-mode": "import" };
import type {
  GitHubOperationOptions,
  GitHubRepositoryCandidate,
  GitHubRepositoryCandidateResult,
  GitHubRestoreIdentityResult,
  VerifiedPrivateRemote,
} from "./repository-github.js";

export const MAX_RESTORE_DISCOVERY_CANDIDATES = 1_000;

const MAX_OWNER_LENGTH = 39;
const MAX_REPOSITORY_NAME_LENGTH = 100;
const MAX_NODE_ID_LENGTH = 512;
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u;
const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/u;
const NODE_ID_PATTERN = /^[A-Za-z0-9+/=_:.-]+$/u;
const GITHUB_CLONE_ORIGIN = "https://github.com";

export type RepositoryCloudDiscoveryErrorCode =
  | "INVALID_INPUT"
  | "INVALID_RESULT"
  | "TOO_MANY_CANDIDATES"
  | "DUPLICATE_IDENTITY"
  | "ABORTED";

const ERROR_MESSAGES: Readonly<Record<RepositoryCloudDiscoveryErrorCode, string>> = Object.freeze({
  INVALID_INPUT: "The cloud discovery input is invalid.",
  INVALID_RESULT: "The cloud discovery result was invalid.",
  TOO_MANY_CANDIDATES: "The cloud discovery result exceeded the safety limit.",
  DUPLICATE_IDENTITY: "The cloud discovery result contained an ambiguous identity.",
  ABORTED: "The cloud discovery request was cancelled.",
});

export class RepositoryCloudDiscoveryError extends Error {
  public readonly userMessage: string;

  public constructor(public readonly code: RepositoryCloudDiscoveryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "RepositoryCloudDiscoveryError";
    this.userMessage = this.message;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface RepositoryCloudDiscoveryProvider {
  readonly listPrivateRepositoryCandidates: (
    accountId: number,
    options?: GitHubOperationOptions,
  ) => Promise<GitHubRepositoryCandidateResult>;
  readonly readRestoreCandidateIdentity: (
    candidate: GitHubRepositoryCandidate,
    options?: GitHubOperationOptions,
  ) => Promise<GitHubRestoreIdentityResult>;
}

export type RepositoryCloudDiscoveryOptions = GitHubOperationOptions;

export interface RepositoryCloudDiscoveryCandidate {
  readonly identity: RepositoryIdentity;
  readonly remote: VerifiedPrivateRemote;
}

export type RepositoryCloudDiscoveryResult = Readonly<
  | { readonly kind: "empty" }
  | { readonly kind: "candidates"; readonly candidates: readonly RepositoryCloudDiscoveryCandidate[] }
>;

type ParseIdentity = typeof import("@maginalia/repository-core", {
  with: { "resolution-mode": "import" }
})["parseIdentity"];

let parseIdentityPromise: Promise<ParseIdentity> | undefined;

function loadParseIdentity(): Promise<ParseIdentity> {
  parseIdentityPromise ??= import("@maginalia/repository-core").then((repositoryCore) => repositoryCore.parseIdentity);
  return parseIdentityPromise;
}

function invalidInput(): never {
  throw new RepositoryCloudDiscoveryError("INVALID_INPUT");
}

function invalidResult(): never {
  throw new RepositoryCloudDiscoveryError("INVALID_RESULT");
}

function tooManyCandidates(): never {
  throw new RepositoryCloudDiscoveryError("TOO_MANY_CANDIDATES");
}

function duplicateIdentity(): never {
  throw new RepositoryCloudDiscoveryError("DUPLICATE_IDENTITY");
}

function aborted(): never {
  throw new RepositoryCloudDiscoveryError("ABORTED");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownValue(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownNames = Object.getOwnPropertyNames(value);
  return Object.getOwnPropertySymbols(value).length === 0
    && ownNames.length === keys.length
    && keys.every((key) => ownNames.includes(key))
    && ownNames.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && "value" in descriptor;
    });
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
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
  return `${GITHUB_CLONE_ORIGIN}/${owner}/${name}.git`;
}

function normalizeCandidate(value: unknown): GitHubRepositoryCandidate {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ["id", "nodeId", "owner", "name", "url"])) invalidResult();
  const id = ownValue(value, "id");
  const nodeId = ownValue(value, "nodeId");
  const owner = ownValue(value, "owner");
  const name = ownValue(value, "name");
  const url = ownValue(value, "url");
  if (!isPositiveSafeInteger(id)
    || !isSafeNodeId(nodeId)
    || !isSafeOwner(owner)
    || !isSafeRepositoryName(name)
    || url !== cloneUrlFor(owner, name)) invalidResult();
  return Object.freeze({ id, nodeId, owner, name, url });
}

function normalizeRemote(value: unknown): VerifiedPrivateRemote {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ["id", "nodeId", "owner", "name", "url", "private"])) invalidResult();
  const id = ownValue(value, "id");
  const nodeId = ownValue(value, "nodeId");
  const owner = ownValue(value, "owner");
  const name = ownValue(value, "name");
  const url = ownValue(value, "url");
  if (ownValue(value, "private") !== true
    || !isPositiveSafeInteger(id)
    || !isSafeNodeId(nodeId)
    || !isSafeOwner(owner)
    || !isSafeRepositoryName(name)
    || url !== cloneUrlFor(owner, name)) invalidResult();
  return Object.freeze({ id, nodeId, owner, name, url, private: true });
}

async function normalizeIdentity(value: unknown): Promise<RepositoryIdentity> {
  try {
    const parseIdentity = await loadParseIdentity();
    return parseIdentity(value);
  } catch {
    invalidResult();
  }
}

async function normalizeIdentityResult(
  value: unknown,
  expectedCandidate: GitHubRepositoryCandidate,
): Promise<Readonly<{ readonly kind: "not-maginalia"; readonly remote: VerifiedPrivateRemote } | {
  readonly kind: "identity";
  readonly identity: RepositoryIdentity;
  readonly remote: VerifiedPrivateRemote;
}>> {
  if (!isPlainRecord(value)) invalidResult();
  const kind = ownValue(value, "kind");
  if (kind === "not-maginalia") {
    if (!hasExactKeys(value, ["kind", "remote"])) invalidResult();
    const remote = normalizeRemote(ownValue(value, "remote"));
    if (!sameRemote(expectedCandidate, remote)) invalidResult();
    return Object.freeze({ kind: "not-maginalia" as const, remote });
  }
  if (kind !== "identity" || !hasExactKeys(value, ["kind", "identity", "remote"])) invalidResult();
  const remote = normalizeRemote(ownValue(value, "remote"));
  if (!sameRemote(expectedCandidate, remote)) invalidResult();
  return Object.freeze({
    kind: "identity" as const,
    identity: await normalizeIdentity(ownValue(value, "identity")),
    remote,
  });
}

function sameRemote(candidate: GitHubRepositoryCandidate, remote: VerifiedPrivateRemote): boolean {
  return candidate.id === remote.id
    && candidate.nodeId === remote.nodeId
    && candidate.owner === remote.owner
    && candidate.name === remote.name
    && candidate.url === remote.url;
}

function signalFrom(options: RepositoryCloudDiscoveryOptions | undefined): AbortSignal | undefined {
  if (options === undefined) return undefined;
  const isSignal = typeof options === "object"
    && options !== null
    && typeof (options as AbortSignal).addEventListener === "function"
    && typeof (options as AbortSignal).removeEventListener === "function"
    && typeof (options as AbortSignal).aborted === "boolean";
  return isSignal ? options as AbortSignal : (options as { readonly signal?: AbortSignal }).signal;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) aborted();
}

function validateProvider(provider: RepositoryCloudDiscoveryProvider): void {
  if (provider === null || typeof provider !== "object") invalidInput();
  try {
    if (typeof provider.listPrivateRepositoryCandidates !== "function"
      || typeof provider.readRestoreCandidateIdentity !== "function") invalidInput();
  } catch {
    invalidInput();
  }
}

function validateCandidateResult(value: unknown): GitHubRepositoryCandidateResult {
  if (!isPlainRecord(value)) invalidResult();
  const kind = ownValue(value, "kind");
  if (kind === "empty") {
    if (!hasExactKeys(value, ["kind"])) invalidResult();
    return Object.freeze({ kind: "empty" as const });
  }
  if (kind !== "candidates" || !hasExactKeys(value, ["kind", "candidates"])) invalidResult();
  const candidates = ownValue(value, "candidates");
  if (!Array.isArray(candidates) || candidates.length === 0) invalidResult();
  if (candidates.length > MAX_RESTORE_DISCOVERY_CANDIDATES) tooManyCandidates();
  return Object.freeze({
    kind: "candidates" as const,
    candidates: Object.freeze(candidates.map(normalizeCandidate)),
  });
}

/**
 * Enumerate only private repositories whose fixed main identity is valid.
 * `empty` means no confirmed MAGINALIA identity in the accessible bounded
 * installation set, never that the account has no such repository globally.
 */
export async function discoverPrivateRepositories(
  provider: RepositoryCloudDiscoveryProvider,
  accountId: number,
  options?: RepositoryCloudDiscoveryOptions,
): Promise<RepositoryCloudDiscoveryResult> {
  validateProvider(provider);
  if (!isPositiveSafeInteger(accountId)) invalidInput();
  const signal = signalFrom(options);
  throwIfAborted(signal);

  const listed = validateCandidateResult(
    await provider.listPrivateRepositoryCandidates(accountId, options),
  );
  throwIfAborted(signal);
  if (listed.kind === "empty") return Object.freeze({ kind: "empty" as const });

  const identities = new Set<string>();
  const discovered: RepositoryCloudDiscoveryCandidate[] = [];
  for (const candidate of listed.candidates) {
    throwIfAborted(signal);
    const identityResult = await normalizeIdentityResult(
      await provider.readRestoreCandidateIdentity(candidate, options),
      candidate,
    );
    throwIfAborted(signal);
    if (identityResult.kind === "not-maginalia") continue;
    const identityId = identityResult.identity.id.toLowerCase();
    if (identities.has(identityId)) duplicateIdentity();
    identities.add(identityId);
    discovered.push(Object.freeze({
      identity: identityResult.identity,
      remote: identityResult.remote,
    }));
  }

  throwIfAborted(signal);
  if (discovered.length === 0) return Object.freeze({ kind: "empty" as const });
  return Object.freeze({
    kind: "candidates" as const,
    candidates: Object.freeze(discovered.slice()),
  });
}
