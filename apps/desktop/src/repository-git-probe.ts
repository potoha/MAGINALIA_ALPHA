/**
 * Main-process-only read probe for one verified private GitHub repository.
 *
 * This boundary asks isomorphic-git for the remote advertisement only.  It
 * does not accept a directory, create an FsClient, or perform any Git
 * mutation.  The caller supplies the short-lived token for this operation;
 * the token is retained only by the auth callback closure while the probe is
 * running.
 */

import * as git from "isomorphic-git";
import type { AuthCallback, GitHttpRequest, HttpClient } from "isomorphic-git";
import {
  createRepositoryAuthCallback,
  createRepositoryHttpClient,
  RepositoryGitHttpError,
} from "./repository-git-http";
import {
  parseRepositoryCloudConnection,
  serializeRepositoryCloudConnection,
  type RepositoryCloudConnection,
} from "./repository-cloud-connection";
import type { VerifiedPrivateRemote } from "./repository-github";

const MAIN_SYMREF = "refs/heads/main";
const SHA1_PATTERN = /^[0-9a-f]{40}$/u;
const MAX_CAPABILITY_LENGTH = 1024;
const MAX_CAPABILITIES = 256;

export type RepositoryGitProbeErrorCode =
  | "INVALID_REMOTE"
  | "INVALID_INPUT"
  | "INVALID_REMOTE_STATE"
  | "ABORTED"
  | "TIMEOUT"
  | "NETWORK_ERROR";

const ERROR_MESSAGES: Readonly<Record<RepositoryGitProbeErrorCode, string>> = Object.freeze({
  INVALID_REMOTE: "The selected remote is not a verified private GitHub repository.",
  INVALID_INPUT: "The GitHub remote probe input is invalid.",
  INVALID_REMOTE_STATE: "The GitHub remote did not advertise a safe main-only state.",
  ABORTED: "The GitHub remote probe was cancelled.",
  TIMEOUT: "The GitHub remote probe timed out.",
  NETWORK_ERROR: "The GitHub remote probe failed.",
});

/** Errors expose only a fixed local classification, never provider data. */
export class RepositoryGitProbeError extends Error {
  public readonly code: RepositoryGitProbeErrorCode;
  public readonly userMessage: string;

  public constructor(code: RepositoryGitProbeErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "RepositoryGitProbeError";
    this.code = code;
    this.userMessage = this.message;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface RepositoryRemoteMainProbeResult {
  readonly remoteHead: string | null;
}

export interface RepositoryGitProbeOptions {
  /** Inject the isomorphic-git call in tests; production uses isomorphic-git. */
  readonly gitClient?: Pick<typeof git, "getRemoteInfo">;
  /** Inject only the strict boundary's upstream HTTP transport in tests. */
  readonly upstream?: HttpClient;
  /** Per-operation request deadline, bounded by the strict HTTP boundary. */
  readonly timeoutMs?: number;
  /** Caller cancellation is attached to every HTTP request made by Git. */
  readonly signal?: AbortSignal;
}

function fail(code: RepositoryGitProbeErrorCode): never {
  throw new RepositoryGitProbeError(code);
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

interface OwnSlot {
  readonly present: boolean;
  readonly value: unknown;
}

function ownSlot(value: Record<string, unknown>, key: string): OwnSlot {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    fail("INVALID_REMOTE_STATE");
  }
  if (!descriptor) return { present: false, value: undefined };
  // Accessors are not JSON data and are rejected so parsing cannot execute a
  // provider-supplied getter while deciding the remote identity.
  if (!("value" in descriptor)) fail("INVALID_REMOTE_STATE");
  return { present: true, value: descriptor.value };
}

function hasOnlyStringKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  let keys: (string | symbol)[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return false;
  }
  return keys.every((key) => typeof key === "string" && allowed.includes(key));
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

function errorName(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  try {
    return typeof error.name === "string" ? error.name : undefined;
  } catch {
    return undefined;
  }
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  try {
    return typeof error.code === "string" ? error.code : undefined;
  } catch {
    return undefined;
  }
}

function normalizeRemote(value: VerifiedPrivateRemote): RepositoryCloudConnection {
  try {
    // Round-tripping through the strict non-secret codec reconstructs a
    // frozen DTO and rejects credentials, alternate hosts, and extra fields.
    return parseRepositoryCloudConnection(serializeRepositoryCloudConnection(value));
  } catch {
    fail("INVALID_REMOTE");
  }
}

function validateProbeOptions(value: RepositoryGitProbeOptions | undefined): RepositoryGitProbeOptions {
  if (value === undefined) return {};
  if (!isPlainRecord(value)) fail("INVALID_INPUT");
  let keys: (string | symbol)[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    fail("INVALID_INPUT");
  }
  const allowed = ["gitClient", "upstream", "timeoutMs", "signal"] as const;
  if (!keys.every((key) => typeof key === "string" && allowed.includes(key as typeof allowed[number]))) {
    fail("INVALID_INPUT");
  }
  for (const key of keys) {
    if (typeof key !== "string") fail("INVALID_INPUT");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) fail("INVALID_INPUT");
  }
  const signal = ownSlot(value, "signal");
  if (signal.present && signal.value !== undefined && !isAbortSignal(signal.value)) {
    fail("INVALID_INPUT");
  }
  const timeout = ownSlot(value, "timeoutMs");
  if (timeout.present && timeout.value !== undefined
    && (typeof timeout.value !== "number" || !Number.isSafeInteger(timeout.value) || timeout.value <= 0)) {
    fail("INVALID_INPUT");
  }
  const client = ownSlot(value, "gitClient");
  if (client.present && client.value !== undefined
    && (!isRecord(client.value) || typeof client.value.getRemoteInfo !== "function")) {
    fail("INVALID_INPUT");
  }
  const upstream = ownSlot(value, "upstream");
  if (upstream.present && upstream.value !== undefined
    && (!isRecord(upstream.value) || typeof upstream.value.request !== "function")) {
    fail("INVALID_INPUT");
  }
  return value;
}

function validateCapabilities(value: unknown): void {
  if (!Array.isArray(value) || value.length > MAX_CAPABILITIES) fail("INVALID_REMOTE_STATE");
  let keys: (string | symbol)[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    fail("INVALID_REMOTE_STATE");
  }
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^\d+$/u.test(key)) fail("INVALID_REMOTE_STATE");
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= value.length) {
      fail("INVALID_REMOTE_STATE");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string"
      || descriptor.value.length > MAX_CAPABILITY_LENGTH) {
      fail("INVALID_REMOTE_STATE");
    }
  }
  // JSON arrays cannot contain holes.  Rejecting them also keeps mocked
  // objects from being interpreted as a complete advertisement accidentally.
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, String(index))) fail("INVALID_REMOTE_STATE");
  }
}

function parseHeads(value: unknown): string | null {
  if (!isPlainRecord(value) || !hasOnlyStringKeys(value, ["main"])) {
    fail("INVALID_REMOTE_STATE");
  }
  const main = ownSlot(value, "main");
  if (!main.present) return null;
  if (typeof main.value !== "string" || !SHA1_PATTERN.test(main.value)) {
    fail("INVALID_REMOTE_STATE");
  }
  return main.value;
}

function parseMainSymref(value: unknown): void {
  if (value !== MAIN_SYMREF) fail("INVALID_REMOTE_STATE");
}

function parseRefs(value: unknown): string | null {
  // The installed runtime nests advertised branches under refs.heads.  Its
  // symbolic HEAD is emitted at the top level, not under refs; accepting
  // other declaration-only layouts would turn an unknown state into a claim.
  if (!isPlainRecord(value) || !hasOnlyStringKeys(value, ["heads"])) {
    fail("INVALID_REMOTE_STATE");
  }
  const heads = ownSlot(value, "heads");
  return heads.present ? parseHeads(heads.value) : null;
}

function parseRemoteInfo(value: unknown): RepositoryRemoteMainProbeResult {
  if (!isPlainRecord(value)
    || !hasOnlyStringKeys(value, ["capabilities", "refs", "HEAD"])) {
    fail("INVALID_REMOTE_STATE");
  }
  const capabilities = ownSlot(value, "capabilities");
  if (!capabilities.present) fail("INVALID_REMOTE_STATE");
  validateCapabilities(capabilities.value);

  const refs = ownSlot(value, "refs");
  const topSymref = ownSlot(value, "HEAD");

  let main: string | null = null;
  if (refs.present) {
    main = parseRefs(refs.value);
  }

  const topSymrefPresent = topSymref.present;
  if (topSymrefPresent) parseMainSymref(topSymref.value);
  if (topSymrefPresent && main === null) {
    // A symbolic HEAD without its advertised main object is incomplete, not
    // an empty repository.
    fail("INVALID_REMOTE_STATE");
  }
  return Object.freeze({ remoteHead: main });
}

function bindCallerSignal(http: HttpClient, signal: AbortSignal | undefined): HttpClient {
  if (signal === undefined) return http;
  return {
    request: (request: GitHttpRequest) => {
      const fetchOptions = isRecord(request.fetchOptions)
        ? { ...request.fetchOptions, signal }
        : { signal };
      return http.request({ ...request, fetchOptions });
    },
  };
}

function normalizeProbeFailure(error: unknown, signal: AbortSignal | undefined): RepositoryGitProbeError {
  if (signal?.aborted) return new RepositoryGitProbeError("ABORTED");
  const name = errorName(error);
  const code = errorCode(error);
  if (name === "AbortError" || code === "ABORT_ERR") return new RepositoryGitProbeError("ABORTED");
  if (name === "TimeoutError" || code === "ETIMEDOUT") return new RepositoryGitProbeError("TIMEOUT");
  return new RepositoryGitProbeError("NETWORK_ERROR");
}

/**
 * Read the verified remote's advertisement and return its main tip, or null
 * only for an actually empty advertisement.  The strict HTTP module remains
 * responsible for endpoint, redirect, auth, deadline, and stream controls.
 */
export async function probeRemoteMain(
  verifiedPrivateRemote: VerifiedPrivateRemote,
  operationToken: string,
  options?: RepositoryGitProbeOptions,
): Promise<RepositoryRemoteMainProbeResult> {
  const normalizedOptions = validateProbeOptions(options);
  const remote = normalizeRemote(verifiedPrivateRemote);
  const signal = normalizedOptions.signal;
  if (signal?.aborted) fail("ABORTED");

  let http: HttpClient;
  let auth: AuthCallback;
  try {
    http = createRepositoryHttpClient(remote, {
      upstream: normalizedOptions.upstream,
      timeoutMs: normalizedOptions.timeoutMs,
    });
    auth = createRepositoryAuthCallback(remote, operationToken);
  } catch (error) {
    if (error instanceof RepositoryGitHttpError) throw error;
    fail("INVALID_INPUT");
  }
  http = bindCallerSignal(http, signal);

  const gitClient = normalizedOptions.gitClient ?? git;
  try {
    const info = await gitClient.getRemoteInfo({
      http,
      url: remote.url,
      onAuth: auth,
    });
    return parseRemoteInfo(info);
  } catch (error) {
    if (error instanceof RepositoryGitProbeError || error instanceof RepositoryGitHttpError) {
      throw error;
    }
    throw normalizeProbeFailure(error, signal);
  }
}
