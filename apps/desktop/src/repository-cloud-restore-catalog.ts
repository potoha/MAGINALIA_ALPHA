/**
 * Main-process-only, owner-bound Restore selection catalog.
 *
 * Discovery returns verified provider data, but that data must not cross the
 * renderer boundary. This short-lived catalog replaces it with opaque IDs
 * and retains the verified values only for the owning main-process object.
 */

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type {
  RepositoryIdentity,
  RepositoryKind,
} from "@maginalia/repository-core" with { "resolution-mode": "import" };
import type {
  RepositoryCloudDiscoveryCandidate,
  RepositoryCloudDiscoveryResult,
} from "./repository-cloud-discovery.js";
import type { VerifiedPrivateRemote } from "./repository-github.js";

export const MAX_RESTORE_CATALOG_ENTRIES = 1_000;

const OPAQUE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_OWNER_LENGTH = 39;
const MAX_REPOSITORY_NAME_LENGTH = 100;
const MAX_NODE_ID_LENGTH = 512;
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u;
const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/u;
const NODE_ID_PATTERN = /^[A-Za-z0-9+/=_:.-]+$/u;
const GITHUB_CLONE_ORIGIN = "https://github.com";

type RepositoryCore = typeof import("@maginalia/repository-core", {
  with: { "resolution-mode": "import" }
});

const repositoryRequire = createRequire(
  typeof __filename === "string" ? __filename : `${process.cwd()}/package.json`,
);
let parseIdentity: RepositoryCore["parseIdentity"] | undefined;

export type RepositoryCloudRestoreCatalogErrorCode =
  | "INVALID_INPUT"
  | "INVALID_OWNER"
  | "INVALID_RESULT"
  | "TOO_MANY_ENTRIES"
  | "DUPLICATE_ID"
  | "INVALID_GENERATOR"
  | "INVALID_ID"
  | "NOT_OWNED"
  | "DISPOSED";

const ERROR_MESSAGES: Readonly<Record<RepositoryCloudRestoreCatalogErrorCode, string>> = Object.freeze({
  INVALID_INPUT: "The Restore catalog input is invalid.",
  INVALID_OWNER: "The Restore catalog owner is invalid.",
  INVALID_RESULT: "The Restore discovery result is invalid.",
  TOO_MANY_ENTRIES: "The Restore catalog exceeded the safety limit.",
  DUPLICATE_ID: "The Restore catalog contained a duplicate opaque ID.",
  INVALID_GENERATOR: "The Restore catalog opaque ID generator is invalid.",
  INVALID_ID: "The Restore catalog selection ID is invalid.",
  NOT_OWNED: "That Restore selection is no longer available for this owner.",
  DISPOSED: "The Restore catalog has been disposed.",
});

export class RepositoryCloudRestoreCatalogError extends Error {
  public readonly userMessage: string;

  public constructor(public readonly code: RepositoryCloudRestoreCatalogErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "RepositoryCloudRestoreCatalogError";
    this.userMessage = this.message;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface RepositoryCloudRestoreCatalogOptions {
  /** Test seam; production uses cryptographically random UUID handles. */
  readonly idFactory?: () => string;
}

/** Exact renderer-safe fields. No remote URL, provider ID, path, or token. */
export interface RestoreCatalogEntry {
  readonly id: string;
  readonly title: string;
  readonly kind: RepositoryKind;
}

/** Main-process-only result used after an owner-bound selection is resolved. */
export interface RestoreCatalogResolved {
  readonly kind: "resolved";
  readonly identity: RepositoryIdentity;
  readonly remote: VerifiedPrivateRemote;
}

interface CatalogRecord extends RestoreCatalogEntry {
  readonly owner: object;
  readonly identity: RepositoryIdentity;
  readonly remote: VerifiedPrivateRemote;
}

interface OwnerCatalog {
  readonly owner: object;
  readonly entries: ReadonlyMap<string, CatalogRecord>;
}

function fail(code: RepositoryCloudRestoreCatalogErrorCode): never {
  throw new RepositoryCloudRestoreCatalogError(code);
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
      && expected.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && "value" in descriptor;
      });
  } catch {
    return false;
  }
}

function isOwner(value: unknown): value is object {
  return value !== null && typeof value === "object";
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

function canonicalRemoteUrl(owner: string, name: string): string {
  return `${GITHUB_CLONE_ORIGIN}/${owner}/${name}.git`;
}

function normalizeRemote(value: unknown): VerifiedPrivateRemote {
  if (!hasExactDataKeys(value, ["id", "nodeId", "owner", "name", "url", "private"])) {
    fail("INVALID_RESULT");
  }
  const id = ownValue(value, "id");
  const nodeId = ownValue(value, "nodeId");
  const owner = ownValue(value, "owner");
  const name = ownValue(value, "name");
  const url = ownValue(value, "url");
  if (!isPositiveSafeInteger(id)
    || !isSafeNodeId(nodeId)
    || !isSafeOwner(owner)
    || !isSafeRepositoryName(name)
    || url !== canonicalRemoteUrl(owner, name)
    || ownValue(value, "private") !== true) {
    fail("INVALID_RESULT");
  }
  return Object.freeze({ id, nodeId, owner, name, url, private: true as const });
}

function normalizeIdentity(value: unknown): RepositoryIdentity {
  try {
    parseIdentity ??= (repositoryRequire("@maginalia/repository-core") as RepositoryCore).parseIdentity;
    return parseIdentity(value);
  } catch {
    fail("INVALID_RESULT");
  }
}

function normalizeDiscoveryResult(value: RepositoryCloudDiscoveryResult): readonly RepositoryCloudDiscoveryCandidate[] {
  if (!hasExactDataKeys(value, ["kind"])) {
    if (!hasExactDataKeys(value, ["kind", "candidates"])) fail("INVALID_RESULT");
    if (ownValue(value, "kind") !== "candidates") fail("INVALID_RESULT");
    const candidates = ownValue(value, "candidates");
    if (!Array.isArray(candidates) || candidates.length === 0) fail("INVALID_RESULT");
    if (candidates.length > MAX_RESTORE_CATALOG_ENTRIES) fail("TOO_MANY_ENTRIES");
    const identities = new Set<string>();
    const normalized: RepositoryCloudDiscoveryCandidate[] = [];
    for (const candidate of candidates) {
      if (!hasExactDataKeys(candidate, ["identity", "remote"])) fail("INVALID_RESULT");
      const identity = normalizeIdentity(ownValue(candidate, "identity"));
      const identityId = identity.id.toLowerCase();
      if (identities.has(identityId)) fail("INVALID_RESULT");
      identities.add(identityId);
      normalized.push(Object.freeze({
        identity,
        remote: normalizeRemote(ownValue(candidate, "remote")),
      }));
    }
    return Object.freeze(normalized);
  }
  if (ownValue(value, "kind") !== "empty") fail("INVALID_RESULT");
  return Object.freeze([]);
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}

function normalizeOptions(value: RepositoryCloudRestoreCatalogOptions): () => string {
  if (!isPlainRecord(value)) fail("INVALID_INPUT");
  let keys: (string | symbol)[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    fail("INVALID_INPUT");
  }
  if (keys.some((key) => typeof key !== "string" || key !== "idFactory")) fail("INVALID_INPUT");
  const idFactory = ownValue(value, "idFactory");
  if (idFactory !== undefined && typeof idFactory !== "function") fail("INVALID_GENERATOR");
  return idFactory === undefined ? randomUUID : idFactory as () => string;
}

function nextOpaqueId(
  factory: () => string,
  issuedIds: ReadonlySet<string>,
): string {
  let candidate: unknown;
  try {
    candidate = factory();
  } catch {
    fail("INVALID_GENERATOR");
  }
  if (!isOpaqueId(candidate)) fail("INVALID_GENERATOR");
  const normalized = candidate.toLowerCase();
  if (issuedIds.has(normalized)) fail("DUPLICATE_ID");
  return candidate;
}

export class RepositoryCloudRestoreCatalog {
  private readonly owners = new Map<object, OwnerCatalog>();
  private readonly issuedIds = new Set<string>();
  private readonly idFactory: () => string;
  private disposed = false;

  public constructor(options: RepositoryCloudRestoreCatalogOptions = {}) {
    this.idFactory = normalizeOptions(options);
  }

  /** Replace this owner's catalog; every previous selection becomes stale. */
  public registerForOwner(
    owner: unknown,
    result: RepositoryCloudDiscoveryResult,
  ): readonly RestoreCatalogEntry[] {
    this.assertActive();
    if (!isOwner(owner)) fail("INVALID_OWNER");
    const candidates = normalizeDiscoveryResult(result);
    const nextRecords: CatalogRecord[] = [];
    const nextIds = new Set<string>();
    for (const candidate of candidates) {
      const id = nextOpaqueId(this.idFactory, this.issuedIds);
      const normalizedId = id.toLowerCase();
      if (nextIds.has(normalizedId)) fail("DUPLICATE_ID");
      nextIds.add(normalizedId);
      nextRecords.push(Object.freeze({
        owner,
        id,
        title: candidate.identity.title,
        kind: candidate.identity.kind,
        identity: candidate.identity,
        remote: candidate.remote,
      }));
    }

    const entries = new Map<string, CatalogRecord>();
    for (const record of nextRecords) {
      this.issuedIds.add(record.id.toLowerCase());
      entries.set(record.id, record);
    }
    this.owners.set(owner, Object.freeze({ owner, entries }));
    return Object.freeze(nextRecords.map(({ id, title, kind }) => Object.freeze({ id, title, kind })));
  }

  /** Resolve a renderer selection only through the original owner object. */
  public resolveForOwner(owner: unknown, id: unknown): RestoreCatalogResolved {
    this.assertActive();
    if (!isOwner(owner)) fail("INVALID_OWNER");
    if (!isOpaqueId(id)) fail("INVALID_ID");
    const catalog = this.owners.get(owner);
    const record = catalog?.entries.get(id);
    if (!record) fail("NOT_OWNED");
    return Object.freeze({
      kind: "resolved" as const,
      identity: record.identity,
      remote: record.remote,
    });
  }

  public clearForOwner(owner: unknown): void {
    this.assertActive();
    if (!isOwner(owner)) fail("INVALID_OWNER");
    this.owners.delete(owner);
  }

  public dispose(): void {
    this.owners.clear();
    this.disposed = true;
  }

  private assertActive(): void {
    if (this.disposed) fail("DISPOSED");
  }
}
