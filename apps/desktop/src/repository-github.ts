/**
 * The desktop-only GitHub repository adapter.
 *
 * This module deliberately has no renderer or Electron dependency.  It is a
 * small provider boundary: the caller supplies an in-memory operation token
 * and (in tests) a fetch implementation, while this module owns endpoint,
 * response, redirect, cancellation, and private-identity checks.
 */

export const GITHUB_REQUEST_TIMEOUT_MS = 10_000;
export const MAX_GITHUB_REQUEST_TIMEOUT_MS = 60_000;
export const MAX_GITHUB_RESPONSE_BYTES = 256 * 1024;

export const GITHUB_API_ORIGIN = "https://api.github.com";
export const GITHUB_API_VERSION = "2022-11-28";

const GITHUB_WEB_ORIGIN = "https://github.com";
const MAX_OWNER_LENGTH = 39;
const MAX_REPOSITORY_NAME_LENGTH = 100;
const MAX_NODE_ID_LENGTH = 512;

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
const NODE_ID_PATTERN = /^[A-Za-z0-9+/=_:.-]+$/;

const VERIFY_REPOSITORY_QUERY = `
query VerifyRepository($nodeId: ID!) {
  node(id: $nodeId) {
    __typename
    ... on Repository {
      id
      databaseId
      name
      owner { login }
      isPrivate
      visibility
      url
    }
  }
}`;

export interface UnverifiedPrivateCandidate {
  readonly id: number;
  readonly nodeId: string;
  readonly owner: string;
  readonly name: string;
  readonly url: string;
}

export interface VerifiedPrivateRemote extends UnverifiedPrivateCandidate {
  readonly private: true;
}

export interface GitHubAccount {
  readonly id: number;
  readonly login: string;
  readonly nodeId?: string;
}

export interface VerifiedPersonalInstallation {
  readonly installationId: number;
  readonly accountId: number;
  readonly appId: number;
}

export type FetchImplementation = (input: string, init?: RequestInit) => Promise<Response>;

export interface GitHubAdapterOptions {
  /** A short-lived token supplied by the current main-process operation. */
  readonly operationToken?: string;
  readonly fetch?: FetchImplementation;
  readonly timeoutMs?: number;
}

export interface GitHubRequestOptions {
  readonly signal?: AbortSignal;
  /** Optional per-operation override; still bounded to the same 60 s cap. */
  readonly timeoutMs?: number;
}

export type GitHubOperationOptions = GitHubRequestOptions | AbortSignal;

export type GitHubAdapterErrorCode =
  | "AUTH_REQUIRED"
  | "AUTH_REVOKED"
  | "PERMISSION_DENIED"
  | "RATE_LIMITED"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "ABORTED"
  | "RESPONSE_TOO_LARGE"
  | "INVALID_INPUT"
  | "INVALID_RESPONSE"
  | "REMOTE_NOT_PRIVATE"
  | "REMOTE_MISMATCH"
  | "REMOTE_NOT_FOUND"
  | "REMOTE_CREATE_UNKNOWN"
  | "REMOTE_REQUEST_FAILED"
  | "REDIRECT_REJECTED"
  | "DISPOSED"
  | "INSTALLATION_NOT_FOUND"
  | "INSTALLATION_PERMISSION_DENIED"
  | "INSTALLATION_SUSPENDED"
  | "INSTALLATION_LOOKUP_INCOMPLETE";

export type GitHubAdapterErrorCategory =
  | "auth"
  | "permission"
  | "rate-limit"
  | "network"
  | "timeout"
  | "aborted"
  | "too-large"
  | "invalid"
  | "not-private"
  | "mismatch"
  | "not-found"
  | "creation-unknown"
  | "request"
  | "redirect"
  | "disposed";

export interface GitHubAdapterErrorOptions {
  readonly recoverable?: boolean;
  readonly status?: number;
  readonly creationUnknown?: boolean;
  readonly tokenMissing?: boolean;
}

const ERROR_MESSAGES: Readonly<Record<GitHubAdapterErrorCode, string>> = Object.freeze({
  AUTH_REQUIRED: "GitHub authentication is required.",
  AUTH_REVOKED: "GitHub authentication was rejected.",
  PERMISSION_DENIED: "GitHub denied the requested permission.",
  RATE_LIMITED: "GitHub rate limit was reached.",
  NETWORK_ERROR: "The GitHub network request failed.",
  TIMEOUT: "The GitHub request timed out.",
  ABORTED: "The GitHub request was cancelled.",
  RESPONSE_TOO_LARGE: "The GitHub response exceeded the safety limit.",
  INVALID_INPUT: "The GitHub request input is invalid.",
  INVALID_RESPONSE: "GitHub returned an invalid response.",
  REMOTE_NOT_PRIVATE: "The GitHub repository is not private.",
  REMOTE_MISMATCH: "The GitHub repository identity did not match the expected remote.",
  REMOTE_NOT_FOUND: "The requested GitHub resource was not found.",
  REMOTE_CREATE_UNKNOWN: "GitHub repository creation result is unknown.",
  REMOTE_REQUEST_FAILED: "GitHub returned an unsuccessful response.",
  REDIRECT_REJECTED: "GitHub redirected a request; the redirect was rejected.",
  DISPOSED: "The GitHub adapter has been disposed.",
  INSTALLATION_NOT_FOUND: "The GitHub App is not installed on this personal account.",
  INSTALLATION_PERMISSION_DENIED: "The GitHub App installation lacks the required permissions.",
  INSTALLATION_SUSPENDED: "The GitHub App installation is suspended.",
  INSTALLATION_LOOKUP_INCOMPLETE: "The GitHub App installation lookup was incomplete.",
});

const ERROR_CATEGORIES: Readonly<Record<GitHubAdapterErrorCode, GitHubAdapterErrorCategory>> = Object.freeze({
  AUTH_REQUIRED: "auth",
  AUTH_REVOKED: "auth",
  PERMISSION_DENIED: "permission",
  RATE_LIMITED: "rate-limit",
  NETWORK_ERROR: "network",
  TIMEOUT: "timeout",
  ABORTED: "aborted",
  RESPONSE_TOO_LARGE: "too-large",
  INVALID_INPUT: "invalid",
  INVALID_RESPONSE: "invalid",
  REMOTE_NOT_PRIVATE: "not-private",
  REMOTE_MISMATCH: "mismatch",
  REMOTE_NOT_FOUND: "not-found",
  REMOTE_CREATE_UNKNOWN: "creation-unknown",
  REMOTE_REQUEST_FAILED: "request",
  REDIRECT_REJECTED: "redirect",
  DISPOSED: "disposed",
  INSTALLATION_NOT_FOUND: "not-found",
  INSTALLATION_PERMISSION_DENIED: "permission",
  INSTALLATION_SUSPENDED: "permission",
  INSTALLATION_LOOKUP_INCOMPLETE: "invalid",
});

/** Adapter errors contain only local classifications and safe status flags. */
export class GitHubAdapterError extends Error {
  public readonly code: GitHubAdapterErrorCode;
  public readonly category: GitHubAdapterErrorCategory;
  public readonly userMessage: string;
  public readonly recoverable: boolean;
  public readonly status: number | undefined;
  public readonly creationUnknown: boolean;
  public readonly tokenMissing: boolean;

  public constructor(
    code: GitHubAdapterErrorCode,
    options: GitHubAdapterErrorOptions = {},
  ) {
    super(ERROR_MESSAGES[code] ?? ERROR_MESSAGES.INVALID_RESPONSE);
    this.name = "GitHubAdapterError";
    this.userMessage = this.message;
    this.code = code;
    this.category = ERROR_CATEGORIES[code] ?? "invalid";
    this.recoverable = options.recoverable ?? code !== "INVALID_INPUT";
    this.status = options.status;
    this.creationUnknown = options.creationUnknown ?? false;
    this.tokenMissing = options.tokenMissing ?? false;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

interface ResponseMetadata {
  readonly status: number;
  readonly headers?: Headers;
}

interface JsonResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Headers | undefined;
}

interface NormalizedRequestOptions {
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number;
}

interface RequestState {
  timedOut: boolean;
  callerAborted: boolean;
  disposed: boolean;
}

interface ActiveRequest {
  readonly controller: AbortController;
  readonly state: RequestState;
}

interface RepositoryExpectation {
  readonly id?: number;
  readonly nodeId?: string;
  readonly owner?: string;
  readonly name?: string;
  readonly url?: string;
}

const defaultFetch: FetchImplementation = (input, init) => {
  const implementation = globalThis.fetch;
  if (typeof implementation !== "function") {
    return Promise.reject(new Error("fetch is unavailable"));
  }
  return implementation(input, init);
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownDataDescriptor(value: Record<string, unknown>, key: string): PropertyDescriptor | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) return undefined;
  return descriptor;
}

function ownValue(value: Record<string, unknown>, key: string): unknown {
  return ownDataDescriptor(value, key)?.value;
}

function hasOwnData(value: Record<string, unknown>, key: string): boolean {
  return ownDataDescriptor(value, key) !== undefined;
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

function invalidInput(): never {
  throw new GitHubAdapterError("INVALID_INPUT", { recoverable: false });
}

function invalidResponse(): never {
  throw new GitHubAdapterError("INVALID_RESPONSE");
}

function mismatch(options: GitHubAdapterErrorOptions = {}): never {
  throw new GitHubAdapterError("REMOTE_MISMATCH", options);
}

function notPrivate(options: GitHubAdapterErrorOptions = {}): never {
  throw new GitHubAdapterError("REMOTE_NOT_PRIVATE", options);
}

function cloneUrlFor(owner: string, name: string): string {
  return `${GITHUB_WEB_ORIGIN}/${owner}/${name}.git`;
}

function webUrlFor(owner: string, name: string): string {
  return `${GITHUB_WEB_ORIGIN}/${owner}/${name}`;
}

function isExactHttpsUrl(value: unknown, expected: string): value is string {
  if (typeof value !== "string" || value !== expected) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && parsed.hostname === "github.com"
      && parsed.port === ""
      && parsed.username === ""
      && parsed.password === ""
      && parsed.search === ""
      && parsed.hash === ""
      && parsed.pathname === new URL(expected).pathname;
  } catch {
    return false;
  }
}

function repositoryApiUrl(owner: string, name: string): string {
  const url = `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  assertApiUrl(url);
  return url;
}

function assertApiUrl(value: string): void {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:"
      || parsed.hostname !== "api.github.com"
      || parsed.port !== ""
      || parsed.username !== ""
      || parsed.password !== ""
      || parsed.search !== ""
      || parsed.hash !== "") {
      invalidInput();
    }
  } catch {
    invalidInput();
  }
}

function validateRepositoryName(value: unknown): string {
  if (!isSafeRepositoryName(value)) invalidInput();
  return value;
}

function validateCandidate(value: unknown): UnverifiedPrivateCandidate {
  if (!isPlainRecord(value)) invalidInput();
  const expectedKeys = ["id", "nodeId", "owner", "name", "url"];
  const ownNames = Object.getOwnPropertyNames(value);
  if (Object.getOwnPropertySymbols(value).length !== 0
    || ownNames.length !== expectedKeys.length
    || expectedKeys.some((key) => !ownNames.includes(key))) invalidInput();
  if (ownNames.some((key) => ownDataDescriptor(value, key) === undefined)) invalidInput();

  const id = ownValue(value, "id");
  const nodeId = ownValue(value, "nodeId");
  const owner = ownValue(value, "owner");
  const name = ownValue(value, "name");
  const url = ownValue(value, "url");
  if (!isPositiveSafeInteger(id) || !isSafeNodeId(nodeId) || !isSafeOwner(owner) || !isSafeRepositoryName(name)) {
    invalidInput();
  }
  if (!isExactHttpsUrl(url, cloneUrlFor(owner, name))) invalidInput();
  return Object.freeze({ id, nodeId, owner, name, url });
}

function validateVerified(value: unknown): VerifiedPrivateRemote {
  if (!isPlainRecord(value)) invalidInput();
  const expectedKeys = ["id", "nodeId", "owner", "name", "url", "private"];
  const ownNames = Object.getOwnPropertyNames(value);
  if (Object.getOwnPropertySymbols(value).length !== 0
    || ownNames.length !== expectedKeys.length
    || expectedKeys.some((key) => !ownNames.includes(key))) invalidInput();
  if (ownNames.some((key) => ownDataDescriptor(value, key) === undefined)) invalidInput();
  if (ownValue(value, "private") !== true) notPrivate();

  const candidate = validateCandidate({
    id: ownValue(value, "id"),
    nodeId: ownValue(value, "nodeId"),
    owner: ownValue(value, "owner"),
    name: ownValue(value, "name"),
    url: ownValue(value, "url"),
  });
  return Object.freeze({ ...candidate, private: true });
}

function parseOwner(body: Record<string, unknown>): string {
  const owner = ownValue(body, "owner");
  const login = isRecord(owner) ? ownValue(owner, "login") : undefined;
  if (!isSafeOwner(login)) invalidResponse();
  return login;
}

function parseRestCandidate(body: unknown, expectation: RepositoryExpectation = {}): UnverifiedPrivateCandidate {
  if (!isRecord(body)) invalidResponse();
  const id = ownValue(body, "id");
  const nodeId = ownValue(body, "node_id");
  const owner = parseOwner(body);
  const name = ownValue(body, "name");
  if (!isPositiveSafeInteger(id) || !isSafeNodeId(nodeId) || !isSafeRepositoryName(name)) invalidResponse();

  // A create/verification response must make its private visibility explicit;
  // absence is not evidence of a private repository.
  if (!hasOwnData(body, "private") || ownValue(body, "private") !== true) notPrivate();
  if (!hasOwnData(body, "visibility") || ownValue(body, "visibility") !== "private") notPrivate();
  if (hasOwnData(body, "full_name")
    && (typeof ownValue(body, "full_name") !== "string" || ownValue(body, "full_name") !== `${owner}/${name}`)) {
    mismatch();
  }

  const rawUrl = hasOwnData(body, "clone_url") ? ownValue(body, "clone_url") : ownValue(body, "url");
  const url = cloneUrlFor(owner, name);
  if (!isExactHttpsUrl(rawUrl, url)) mismatch();

  if (expectation.id !== undefined && id !== expectation.id) mismatch();
  if (expectation.nodeId !== undefined && nodeId !== expectation.nodeId) mismatch();
  if (expectation.owner !== undefined && owner !== expectation.owner) mismatch();
  if (expectation.name !== undefined && name !== expectation.name) mismatch();
  if (expectation.url !== undefined && url !== expectation.url) mismatch();

  return Object.freeze({ id, nodeId, owner, name, url });
}

function parseAccount(body: unknown): GitHubAccount {
  if (!isRecord(body)) invalidResponse();
  const id = ownValue(body, "id");
  const login = ownValue(body, "login");
  if (!isPositiveSafeInteger(id) || !isSafeOwner(login)) invalidResponse();
  if (hasOwnData(body, "node_id")) {
    const nodeId = ownValue(body, "node_id");
    if (!isSafeNodeId(nodeId)) invalidResponse();
    return Object.freeze({ id, login, nodeId });
  }
  return Object.freeze({ id, login });
}

function installationNotFound(): never {
  throw new GitHubAdapterError("INSTALLATION_NOT_FOUND");
}

function installationPermissionDenied(): never {
  throw new GitHubAdapterError("INSTALLATION_PERMISSION_DENIED");
}

function installationSuspended(): never {
  throw new GitHubAdapterError("INSTALLATION_SUSPENDED");
}

function installationLookupIncomplete(): never {
  throw new GitHubAdapterError("INSTALLATION_LOOKUP_INCOMPLETE");
}

interface ParsedInstallation {
  readonly installationId: number;
  readonly appId: number;
  readonly accountId: number;
  readonly targetType: "User" | "Organization";
}

function parseInstallationRecord(body: unknown): ParsedInstallation {
  if (!isRecord(body)) installationLookupIncomplete();
  const targetType = ownValue(body, "target_type");
  if (targetType !== "User" && targetType !== "Organization") installationLookupIncomplete();
  const installationId = ownValue(body, "id");
  const appId = ownValue(body, "app_id");
  const account = ownValue(body, "account");
  const accountId = isRecord(account) ? ownValue(account, "id") : undefined;
  if (!isPositiveSafeInteger(installationId)
    || !isPositiveSafeInteger(appId)
    || !isPositiveSafeInteger(accountId)) {
    installationLookupIncomplete();
  }
  return { installationId, appId, accountId, targetType };
}

function validateMatchingInstallation(body: Record<string, unknown>): void {
  if (!hasOwnData(body, "suspended_at")) installationLookupIncomplete();
  const suspendedAt = ownValue(body, "suspended_at");
  if (suspendedAt !== null) {
    if (typeof suspendedAt !== "string"
      || suspendedAt.length === 0
      || suspendedAt.length > 128
      || /[\u0000-\u001F\u007F-\u009F]/u.test(suspendedAt)) {
      installationLookupIncomplete();
    }
    installationSuspended();
  }

  if (hasOwnData(body, "repository_selection")) {
    const selection = ownValue(body, "repository_selection");
    if (selection !== "all" && selection !== "selected") installationLookupIncomplete();
  }

  const permissions = ownValue(body, "permissions");
  if (!isRecord(permissions)
    || !hasOwnData(permissions, "administration")
    || !hasOwnData(permissions, "contents")) {
    installationLookupIncomplete();
  }
  if (ownValue(permissions, "administration") !== "write"
    || ownValue(permissions, "contents") !== "write") {
    installationPermissionDenied();
  }
}

function parsePersonalInstallation(body: unknown, expectedAccountId: number): VerifiedPersonalInstallation {
  if (!isRecord(body)
    || !hasOwnData(body, "total_count")
    || !hasOwnData(body, "installations")) {
    installationLookupIncomplete();
  }
  const totalCount = ownValue(body, "total_count");
  const installations = ownValue(body, "installations");
  if (typeof totalCount !== "number"
    || !Number.isSafeInteger(totalCount)
    || totalCount < 0
    || !Array.isArray(installations)
    || totalCount < installations.length) {
    installationLookupIncomplete();
  }

  const seenInstallationIds = new Set<number>();
  let matching: VerifiedPersonalInstallation | undefined;
  for (const item of installations) {
    if (!isRecord(item)) installationLookupIncomplete();
    const targetType = ownValue(item, "target_type");
    // Organization installations are outside this personal-account proof;
    // their unrelated fields must not affect the personal lookup.
    if (targetType === "Organization") continue;
    const parsed = parseInstallationRecord(item);
    if (seenInstallationIds.has(parsed.installationId)) installationLookupIncomplete();
    seenInstallationIds.add(parsed.installationId);
    if (parsed.targetType !== "User" || parsed.accountId !== expectedAccountId) continue;
    if (matching !== undefined) installationLookupIncomplete();
    if (!isRecord(item)) installationLookupIncomplete();
    validateMatchingInstallation(item);
    matching = Object.freeze({
      installationId: parsed.installationId,
      accountId: parsed.accountId,
      appId: parsed.appId,
    });
  }

  if (matching !== undefined) return matching;
  if (totalCount !== installations.length) installationLookupIncomplete();
  installationNotFound();
}

function parseGraphQlRemote(body: unknown, expected: VerifiedPrivateRemote): VerifiedPrivateRemote {
  if (!isRecord(body)) invalidResponse();
  const errors = ownValue(body, "errors");
  if (errors !== undefined && (!Array.isArray(errors) || errors.length > 0)) mismatch();
  const data = ownValue(body, "data");
  if (!isRecord(data)) invalidResponse();
  const node = ownValue(data, "node");
  if (node === null) mismatch();
  if (!isRecord(node)) mismatch();

  if (hasOwnData(node, "__typename") && ownValue(node, "__typename") !== "Repository") mismatch();
  const nodeId = ownValue(node, "id");
  const id = ownValue(node, "databaseId");
  if (!isSafeNodeId(nodeId) || !isPositiveSafeInteger(id)) mismatch();
  if (nodeId !== expected.nodeId || id !== expected.id) mismatch();

  if (hasOwnData(node, "private") && ownValue(node, "private") !== true) notPrivate();
  const privateValue = hasOwnData(node, "isPrivate") ? ownValue(node, "isPrivate") : ownValue(node, "private");
  if (privateValue !== true) notPrivate();
  if (hasOwnData(node, "visibility") && ownValue(node, "visibility") !== "PRIVATE") notPrivate();

  const name = ownValue(node, "name");
  if (!isSafeRepositoryName(name)) mismatch();
  const ownerValue = ownValue(node, "owner");
  const ownerLogin = isRecord(ownerValue) ? ownValue(ownerValue, "login") : undefined;
  if (!isSafeOwner(ownerLogin)) mismatch();
  const owner = ownerLogin;

  if (hasOwnData(node, "url") && !isExactHttpsUrl(ownValue(node, "url"), webUrlFor(owner, name))) mismatch();
  return Object.freeze({
    id,
    nodeId,
    owner,
    name,
    url: cloneUrlFor(owner, name),
    private: true,
  });
}

function normalizeRequestOptions(
  value: GitHubOperationOptions | undefined,
  defaultTimeoutMs: number,
): NormalizedRequestOptions {
  const isSignal = value !== undefined
    && value !== null
    && typeof value === "object"
    && typeof (value as AbortSignal).addEventListener === "function"
    && typeof (value as AbortSignal).removeEventListener === "function"
    && typeof (value as AbortSignal).aborted === "boolean";
  const options: GitHubRequestOptions = isSignal
    ? { signal: value as AbortSignal }
    : value as GitHubRequestOptions | undefined ?? {};
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_GITHUB_REQUEST_TIMEOUT_MS) invalidInput();
  if (options.signal !== undefined
    && (typeof options.signal.addEventListener !== "function"
      || typeof options.signal.removeEventListener !== "function"
      || typeof options.signal.aborted !== "boolean")) invalidInput();
  return { signal: options.signal, timeoutMs };
}

function responseHeader(response: ResponseMetadata, name: string): string | null {
  try {
    return response.headers?.get(name) ?? null;
  } catch {
    return null;
  }
}

function validateJsonContentType(response: ResponseMetadata): void {
  const contentType = responseHeader(response, "content-type");
  if (contentType === null || contentType.trim() === "") return;
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  if (mediaType === "application/json" || mediaType.endsWith("+json")) return;
  invalidResponse();
}

function isRateLimited(response: ResponseMetadata): boolean {
  if (response.status === 429) return true;
  const remaining = responseHeader(response, "x-ratelimit-remaining");
  return remaining === "0"
    || responseHeader(response, "retry-after") !== null
    || responseHeader(response, "x-ratelimit-reset") !== null;
}

function tooLarge(): never {
  throw new GitHubAdapterError("RESPONSE_TOO_LARGE");
}

function creationUnknownForError(
  error: GitHubAdapterError,
  operation: "account" | "create" | "verify-created" | "verify-remote" | "installation",
): boolean {
  if (error.code === "REDIRECT_REJECTED") return operation === "create";
  return error.status === undefined || error.status < 400 || error.status >= 500;
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Cancellation is best effort; the bounded check has already stopped use
    // of the response bytes.
  }
}

export async function readResponseBytes(
  response: Response,
  signal: AbortSignal = new AbortController().signal,
): Promise<Uint8Array> {
  const body = response.body;
  const contentLength = responseHeader(response, "content-length");
  if (contentLength !== null && contentLength.trim() !== "") {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > MAX_GITHUB_RESPONSE_BYTES) {
      if (body && typeof body.getReader === "function") {
        const reader = body.getReader();
        await cancelReader(reader);
        reader.releaseLock();
      }
      tooLarge();
    }
  }

  if (signal.aborted) {
    if (body && typeof body.getReader === "function") {
      const reader = body.getReader();
      await cancelReader(reader);
      reader.releaseLock();
    }
    throw new DOMException("The request was aborted.", "AbortError");
  }
  if (!body || typeof body.getReader !== "function") invalidResponse();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let cancelled = false;
  const onAbort = (): void => {
    cancelled = true;
    void cancelReader(reader);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      if (signal.aborted || cancelled) {
        await cancelReader(reader);
        throw new DOMException("The request was aborted.", "AbortError");
      }
      const result = await reader.read();
      if (signal.aborted || cancelled) {
        await cancelReader(reader);
        throw new DOMException("The request was aborted.", "AbortError");
      }
      if (result.done) break;
      const chunk = result.value instanceof Uint8Array ? result.value : new Uint8Array(result.value);
      total += chunk.byteLength;
      if (total > MAX_GITHUB_RESPONSE_BYTES) {
        await cancelReader(reader);
        tooLarge();
      }
      chunks.push(chunk);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function decodeJson(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invalidResponse();
  }
  try {
    return JSON.parse(text);
  } catch {
    invalidResponse();
  }
}

function optionsFromConstructor(
  options: GitHubAdapterOptions,
): { token: string | undefined; fetchImplementation: FetchImplementation; timeoutMs: number } {
  if (!isPlainRecord(options)) invalidInput();
  const optionNames = Object.getOwnPropertyNames(options);
  if (Object.getOwnPropertySymbols(options).length !== 0
    || optionNames.some((name) => !["operationToken", "fetch", "timeoutMs"].includes(name))
    || optionNames.some((name) => ownDataDescriptor(options, name) === undefined)) invalidInput();
  const token = ownValue(options, "operationToken");
  if (token !== undefined && typeof token !== "string") invalidInput();
  const fetchValue = ownValue(options, "fetch");
  const fetchImplementation = fetchValue === undefined ? defaultFetch : fetchValue;
  if (typeof fetchImplementation !== "function") invalidInput();
  const timeoutValue = ownValue(options, "timeoutMs");
  const timeoutMs = timeoutValue === undefined ? GITHUB_REQUEST_TIMEOUT_MS : timeoutValue;
  if (typeof timeoutMs !== "number"
    || !Number.isFinite(timeoutMs)
    || timeoutMs <= 0
    || timeoutMs > MAX_GITHUB_REQUEST_TIMEOUT_MS) invalidInput();
  return { token, fetchImplementation: fetchImplementation as FetchImplementation, timeoutMs };
}

export class GitHubAdapter {
  // ECMAScript private storage prevents JSON serialization or accidental
  // property inspection from exposing the operation token.
  #operationToken: string | undefined;
  readonly #fetchImplementation: FetchImplementation;
  readonly #timeoutMs: number;
  readonly #activeRequests = new Set<ActiveRequest>();
  #disposed = false;

  public constructor(options: GitHubAdapterOptions = {}) {
    const normalized = optionsFromConstructor(options);
    this.#operationToken = normalized.token;
    this.#fetchImplementation = normalized.fetchImplementation;
    this.#timeoutMs = normalized.timeoutMs;
  }

  public dispose(): void {
    this.#operationToken = undefined;
    this.#disposed = true;
    for (const active of this.#activeRequests) {
      active.state.disposed = true;
      active.controller.abort();
    }
  }

  public async account(options?: GitHubOperationOptions): Promise<GitHubAccount> {
    this.assertActive();
    const response = await this.requestJson("https://api.github.com/user", "account", "GET", undefined, options);
    if (response.status !== 200) this.throwHttpError(response, "account");
    return parseAccount(response.body);
  }

  /**
   * Prove that the current GitHub App user token has a personal installation
   * for the independently acquired account ID and both create permissions.
   * This is a read-only preflight; repository creation remains a separate
   * explicit operation.
   */
  public async verifyPersonalInstallation(
    accountId: number,
    options?: GitHubOperationOptions,
  ): Promise<VerifiedPersonalInstallation> {
    this.assertActive();
    if (!isPositiveSafeInteger(accountId)) invalidInput();
    const response = await this.requestJson(
      "https://api.github.com/user/installations",
      "installation",
      "GET",
      undefined,
      options,
    );
    if (response.status !== 200) this.throwHttpError(response, "installation");
    return parsePersonalInstallation(response.body, accountId);
  }

  public async createPrivateCandidate(
    name: string,
    options?: GitHubOperationOptions,
  ): Promise<UnverifiedPrivateCandidate> {
    this.assertActive();
    const requestedName = validateRepositoryName(name);
    const response = await this.requestJson(
      "https://api.github.com/user/repos",
      "create",
      "POST",
      JSON.stringify({ name: requestedName, private: true, auto_init: false }),
      options,
    );
    if (response.status !== 201) this.throwHttpError(response, "create");
    try {
      return parseRestCandidate(response.body, { name: requestedName });
    } catch (error) {
      if (error instanceof GitHubAdapterError) {
        throw new GitHubAdapterError(error.code, {
          recoverable: error.recoverable,
          status: error.status,
          tokenMissing: error.tokenMissing,
          creationUnknown: true,
        });
      }
      throw new GitHubAdapterError("REMOTE_CREATE_UNKNOWN", { creationUnknown: true });
    }
  }

  public async verifyCreatedCandidate(
    candidate: UnverifiedPrivateCandidate,
    options?: GitHubOperationOptions,
  ): Promise<VerifiedPrivateRemote> {
    this.assertActive();
    const input = validateCandidate(candidate);
    const response = await this.requestJson(
      repositoryApiUrl(input.owner, input.name),
      "verify-created",
      "GET",
      undefined,
      options,
    );
    if (response.status !== 200) this.throwHttpError(response, "verify-created");
    const observed = parseRestCandidate(response.body, {
      id: input.id,
      nodeId: input.nodeId,
      owner: input.owner,
      name: input.name,
      url: input.url,
    });
    return Object.freeze({ ...observed, private: true });
  }

  public async verifyRemote(
    verified: VerifiedPrivateRemote,
    options?: GitHubOperationOptions,
  ): Promise<VerifiedPrivateRemote> {
    this.assertActive();
    const input = validateVerified(verified);
    const response = await this.requestJson(
      "https://api.github.com/graphql",
      "verify-remote",
      "POST",
      JSON.stringify({ query: VERIFY_REPOSITORY_QUERY, variables: { nodeId: input.nodeId } }),
      options,
    );
    if (response.status !== 200) this.throwHttpError(response, "verify-remote");
    return parseGraphQlRemote(response.body, input);
  }

  private assertActive(): void {
    if (this.#disposed) throw new GitHubAdapterError("DISPOSED", { recoverable: false });
  }

  private requireToken(): string {
    const token = this.#operationToken;
    if (typeof token !== "string" || token.trim().length === 0) {
      throw new GitHubAdapterError("AUTH_REQUIRED", { recoverable: true, tokenMissing: true });
    }
    return token;
  }

  private requestHeaders(contentType: boolean): Record<string, string> {
    const token = this.requireToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    };
    if (contentType) headers["Content-Type"] = "application/json";
    return headers;
  }

  private async requestJson(
    url: string,
    operation: "account" | "create" | "verify-created" | "verify-remote" | "installation",
    method: "GET" | "POST",
    body: string | undefined,
    operationOptions: GitHubOperationOptions | undefined,
  ): Promise<JsonResponse> {
    assertApiUrl(url);
    const options = normalizeRequestOptions(operationOptions, this.#timeoutMs);
    if (options.signal?.aborted) {
      throw new GitHubAdapterError("ABORTED", {
        recoverable: true,
        creationUnknown: operation === "create" ? false : undefined,
      });
    }

    this.requireToken();
    const controller = new AbortController();
    const state: RequestState = { timedOut: false, callerAborted: false, disposed: false };
    const active: ActiveRequest = { controller, state };
    this.#activeRequests.add(active);

    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeAbortListener: (() => void) | undefined;
    try {
      if (options.signal) {
        const onAbort = (): void => {
          state.callerAborted = true;
          controller.abort();
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
      }
      timer = setTimeout(() => {
        state.timedOut = true;
        controller.abort();
      }, options.timeoutMs);

      const response = await this.#fetchImplementation(url, {
        method,
        headers: this.requestHeaders(method === "POST"),
        ...(body === undefined ? {} : { body }),
        redirect: "error",
        signal: controller.signal,
      });

      if (state.disposed) throw new GitHubAdapterError("DISPOSED", { recoverable: false });
      if (state.timedOut) {
        throw new GitHubAdapterError("TIMEOUT", { recoverable: true, creationUnknown: operation === "create" });
      }
      if (state.callerAborted) {
        throw new GitHubAdapterError("ABORTED", { recoverable: true, creationUnknown: operation === "create" });
      }
      if (!response || !Number.isSafeInteger(response.status) || response.status < 0) invalidResponse();
      if (response.redirected === true
        || response.type === "opaqueredirect"
        || (response.status >= 300 && response.status < 400)) {
        throw new GitHubAdapterError("REDIRECT_REJECTED", { status: response.status });
      }
      if (typeof response.url === "string" && response.url !== "" && response.url !== url) {
        throw new GitHubAdapterError("REDIRECT_REJECTED", { status: response.status });
      }
      if (response.status < 200 || response.status >= 300) this.throwHttpError(response, operation);

      validateJsonContentType(response);
      const bytes = await readResponseBytes(response, controller.signal);
      if (state.disposed) throw new GitHubAdapterError("DISPOSED", { recoverable: false });
      if (state.timedOut) {
        throw new GitHubAdapterError("TIMEOUT", { recoverable: true, creationUnknown: operation === "create" });
      }
      if (state.callerAborted) {
        throw new GitHubAdapterError("ABORTED", { recoverable: true, creationUnknown: operation === "create" });
      }
      return { status: response.status, body: decodeJson(bytes), headers: response.headers };
    } catch (error) {
      if (error instanceof GitHubAdapterError) {
        if (state.disposed && error.code !== "DISPOSED") {
          throw new GitHubAdapterError("DISPOSED", { recoverable: false });
        }
        if (state.timedOut && error.code !== "TIMEOUT" && error.code !== "DISPOSED") {
          throw new GitHubAdapterError("TIMEOUT", {
            recoverable: true,
            creationUnknown: operation === "create",
          });
        }
        if (state.callerAborted && error.code !== "ABORTED" && error.code !== "DISPOSED") {
          throw new GitHubAdapterError("ABORTED", {
            recoverable: true,
            creationUnknown: operation === "create",
          });
        }
        if (operation === "create" && error.code !== "AUTH_REQUIRED" && error.code !== "DISPOSED") {
          throw new GitHubAdapterError(error.code, {
            recoverable: error.recoverable,
            status: error.status,
            tokenMissing: error.tokenMissing,
            creationUnknown: creationUnknownForError(error, operation),
          });
        }
        throw error;
      }
      if (state.disposed) throw new GitHubAdapterError("DISPOSED", { recoverable: false });
      if (state.timedOut) {
        throw new GitHubAdapterError("TIMEOUT", { recoverable: true, creationUnknown: operation === "create" });
      }
      if (state.callerAborted) {
        throw new GitHubAdapterError("ABORTED", { recoverable: true, creationUnknown: operation === "create" });
      }
      throw new GitHubAdapterError("NETWORK_ERROR", { recoverable: true, creationUnknown: operation === "create" });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      removeAbortListener?.();
      this.#activeRequests.delete(active);
    }
  }

  private throwHttpError(
    response: ResponseMetadata,
    operation: "account" | "create" | "verify-created" | "verify-remote" | "installation",
  ): never {
    const status = response.status;
    const creationUnknown = operation === "create"
      && (status < 400 || status >= 500);
    if (status === 401) {
      throw new GitHubAdapterError("AUTH_REVOKED", { status, creationUnknown });
    }
    if (status === 403) {
      throw new GitHubAdapterError(isRateLimited(response) ? "RATE_LIMITED" : "PERMISSION_DENIED", {
        status,
        creationUnknown,
      });
    }
    if (status === 429) {
      throw new GitHubAdapterError("RATE_LIMITED", { status, creationUnknown });
    }
    if (status === 404) {
      throw new GitHubAdapterError(
        operation === "create" ? "REMOTE_REQUEST_FAILED" : "REMOTE_NOT_FOUND",
        { status, creationUnknown },
      );
    }
    if (creationUnknown) {
      throw new GitHubAdapterError("REMOTE_CREATE_UNKNOWN", { status, creationUnknown: true });
    }
    throw new GitHubAdapterError("REMOTE_REQUEST_FAILED", { status });
  }
}
