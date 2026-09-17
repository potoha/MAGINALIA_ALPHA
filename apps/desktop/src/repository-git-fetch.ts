/**
 * Main-process-only stage fetch boundary. This fetches one already probed
 * GitHub main tip into a disposable LocalGitStage; it never reads or writes
 * the active repository and it does not claim that fetched objects are safe
 * until the later graph-validation phase.
 */

import * as git from "isomorphic-git";
import type { AuthCallback, GitHttpRequest, HttpClient } from "isomorphic-git";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { VerifiedPrivateRemote } from "./repository-github.js";
import {
  createRepositoryAuthCallback,
  createRepositoryHttpClient,
  RepositoryGitHttpError,
} from "./repository-git-http.js";
import { LocalGitStage } from "./repository-git-stage.js";
import {
  parseRepositoryCloudConnection,
  serializeRepositoryCloudConnection,
  type RepositoryCloudConnection,
} from "./repository-cloud-connection.js";

const SHA1 = /^[0-9a-f]{40}$/u;
const REMOTE_NAME = "maginalia";
const REMOTE_REF = "refs/heads/main";
const LOCAL_REF = "main";
const REMOTE_REFSPEC = "+refs/heads/main:refs/remotes/maginalia/main";
const GIT_FS = { promises: fs };

export type RepositoryGitFetchErrorCode =
  | "INVALID_REMOTE"
  | "INVALID_INPUT"
  | "AUTH_REQUIRED"
  | "ABORTED"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "REMOTE_HEAD_MISMATCH"
  | "STAGE_REF_CHANGED"
  | "FETCH_FAILED";

const ERROR_MESSAGES: Readonly<Record<RepositoryGitFetchErrorCode, string>> = Object.freeze({
  INVALID_REMOTE: "The selected remote is not a verified private GitHub repository.",
  INVALID_INPUT: "The GitHub stage fetch input is invalid.",
  AUTH_REQUIRED: "GitHub authentication is required for the stage fetch.",
  ABORTED: "The GitHub stage fetch was cancelled.",
  TIMEOUT: "The GitHub stage fetch timed out.",
  NETWORK_ERROR: "The GitHub stage fetch failed due to a network error.",
  REMOTE_HEAD_MISMATCH: "The GitHub remote changed during the stage fetch.",
  STAGE_REF_CHANGED: "The temporary stage changed unexpectedly during the fetch.",
  FETCH_FAILED: "The GitHub stage fetch could not be completed safely.",
});

export class RepositoryGitFetchError extends Error {
  public readonly userMessage: string;

  public constructor(public readonly code: RepositoryGitFetchErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "RepositoryGitFetchError";
    this.userMessage = this.message;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface RepositoryGitFetchOptions {
  /** Inject only isomorphic-git's fetch operation in tests. */
  readonly gitClient?: Pick<typeof git, "fetch">;
  /** Inject the strict GitHub smart-HTTP upstream in tests. */
  readonly upstream?: HttpClient;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface StageFetchResult {
  readonly remoteHead: string | null;
  /** True only when one exact main tip was fetched into the disposable stage. */
  readonly fetched: boolean;
}

function fail(code: RepositoryGitFetchErrorCode): never {
  throw new RepositoryGitFetchError(code);
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
    if (!descriptor) return undefined;
    if (!("value" in descriptor)) fail("INVALID_INPUT");
    return descriptor.value;
  } catch (error) {
    if (error instanceof RepositoryGitFetchError) throw error;
    fail("INVALID_INPUT");
  }
}

function validateOptions(value: RepositoryGitFetchOptions | undefined): RepositoryGitFetchOptions {
  if (value === undefined) return {};
  if (!isPlainRecord(value)) fail("INVALID_INPUT");
  let keys: (string | symbol)[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    fail("INVALID_INPUT");
  }
  const allowed = new Set(["gitClient", "upstream", "timeoutMs", "signal"]);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) fail("INVALID_INPUT");
  for (const key of keys) {
    if (typeof key !== "string") fail("INVALID_INPUT");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) fail("INVALID_INPUT");
  }
  const gitClient = ownValue(value, "gitClient");
  if (gitClient !== undefined && (!isRecord(gitClient) || typeof gitClient.fetch !== "function")) {
    fail("INVALID_INPUT");
  }
  const upstream = ownValue(value, "upstream");
  if (upstream !== undefined && (!isRecord(upstream) || typeof upstream.request !== "function")) {
    fail("INVALID_INPUT");
  }
  const timeout = ownValue(value, "timeoutMs");
  if (timeout !== undefined && (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout <= 0)) {
    fail("INVALID_INPUT");
  }
  const signal = ownValue(value, "signal");
  if (
    signal !== undefined
    && (!isRecord(signal)
      || typeof signal.addEventListener !== "function"
      || typeof signal.removeEventListener !== "function"
      || typeof signal.aborted !== "boolean")
  ) {
    fail("INVALID_INPUT");
  }
  return value;
}

function normalizeRemote(value: VerifiedPrivateRemote): RepositoryCloudConnection {
  try {
    return parseRepositoryCloudConnection(serializeRepositoryCloudConnection(value));
  } catch {
    fail("INVALID_REMOTE");
  }
}

function validateInputs(
  stage: LocalGitStage,
  remoteHead: string | null,
  operationToken: string,
): void {
  if (!(stage instanceof LocalGitStage) || !SHA1.test(stage.head)) fail("INVALID_INPUT");
  if (remoteHead !== null && !SHA1.test(remoteHead)) fail("INVALID_INPUT");
  if (typeof operationToken !== "string" || operationToken.length === 0) fail("AUTH_REQUIRED");
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

function normalizeFailure(error: unknown, signal: AbortSignal | undefined): RepositoryGitFetchError {
  if (error instanceof RepositoryGitFetchError) return error;
  if (signal?.aborted) return new RepositoryGitFetchError("ABORTED");
  if (error instanceof RepositoryGitHttpError) {
    if (error.code === "ABORTED") return new RepositoryGitFetchError("ABORTED");
    if (error.code === "TIMEOUT") return new RepositoryGitFetchError("TIMEOUT");
    if (error.code === "NETWORK_ERROR") return new RepositoryGitFetchError("NETWORK_ERROR");
    if (error.code === "AUTH_REQUIRED") return new RepositoryGitFetchError("AUTH_REQUIRED");
    if (error.code === "INVALID_REMOTE") return new RepositoryGitFetchError("INVALID_REMOTE");
    return new RepositoryGitFetchError("FETCH_FAILED");
  }
  const name = errorName(error);
  const code = errorCode(error);
  if (name === "AbortError" || code === "ABORT_ERR") return new RepositoryGitFetchError("ABORTED");
  if (name === "TimeoutError" || code === "ETIMEDOUT") return new RepositoryGitFetchError("TIMEOUT");
  return new RepositoryGitFetchError("FETCH_FAILED");
}

function bindCallerSignal(http: HttpClient, signal: AbortSignal | undefined): HttpClient {
  if (signal === undefined) return http;
  return {
    request: (request: GitHttpRequest) => {
      const fetchOptions = isRecord(request.fetchOptions)
        ? { ...request.fetchOptions, signal }
        : { signal };
      return http.request({ ...request, fetchOptions, signal });
    },
  };
}

function generatedRemoteConfig(remote: RepositoryCloudConnection): string {
  // This is generated from the independently validated DTO; no source config
  // is read or copied, and the single refspec cannot widen to tags/branches.
  return [
    "[core]",
    "\trepositoryformatversion = 0",
    "\tfilemode = false",
    "\tbare = false",
    "\tlogallrefupdates = true",
    "\tsymlinks = false",
    "\tignorecase = true",
    `[remote "${REMOTE_NAME}"]`,
    `\turl = ${remote.url}`,
    `\tfetch = ${REMOTE_REFSPEC}`,
    "",
  ].join("\n");
}

async function writeGeneratedRemoteConfig(stagePath: string, remote: RepositoryCloudConnection): Promise<void> {
  try {
    await fs.writeFile(join(stagePath, ".git", "config"), generatedRemoteConfig(remote), { encoding: "utf8", flag: "w" });
  } catch {
    fail("FETCH_FAILED");
  }
}

async function assertMainPinned(stagePath: string, expected: string): Promise<void> {
  try {
    const actual = await git.resolveRef({ fs: GIT_FS, dir: stagePath, ref: "refs/heads/main" });
    if (actual !== expected) fail("STAGE_REF_CHANGED");
  } catch (error) {
    if (error instanceof RepositoryGitFetchError) throw error;
    fail("STAGE_REF_CHANGED");
  }
}

/**
 * Fetch the caller-probed main tip into a disposable stage only. A null tip
 * is an empty result from the caller's independent probe and performs no
 * network request. Fetched objects remain untrusted until graph validation.
 */
export async function fetchRemoteIntoStage(
  stage: LocalGitStage,
  verifiedPrivateRemote: VerifiedPrivateRemote,
  operationToken: string,
  expectedRemoteHead: string | null,
  options?: RepositoryGitFetchOptions,
): Promise<StageFetchResult> {
  const normalizedOptions = validateOptions(options);
  const remote = normalizeRemote(verifiedPrivateRemote);
  validateInputs(stage, expectedRemoteHead, operationToken);
  if (normalizedOptions.signal?.aborted) fail("ABORTED");
  if (expectedRemoteHead === null) {
    return Object.freeze({ remoteHead: null, fetched: false });
  }

  let http: HttpClient;
  let auth: AuthCallback;
  try {
    http = createRepositoryHttpClient(remote, {
      upstream: normalizedOptions.upstream,
      timeoutMs: normalizedOptions.timeoutMs,
    });
    http = bindCallerSignal(http, normalizedOptions.signal);
    auth = createRepositoryAuthCallback(remote, operationToken);
  } catch (error) {
    throw normalizeFailure(error, normalizedOptions.signal);
  }

  const gitClient = normalizedOptions.gitClient ?? git;
  try {
    return await stage.withOwnedDirectory(async (stagePath) => {
      await assertMainPinned(stagePath, stage.head);
      await writeGeneratedRemoteConfig(stagePath, remote);
      let result: Awaited<ReturnType<typeof git.fetch>>;
      try {
        result = await gitClient.fetch({
          fs: GIT_FS,
          http,
          dir: stagePath,
          url: remote.url,
          remote: REMOTE_NAME,
          remoteRef: REMOTE_REF,
          ref: LOCAL_REF,
          singleBranch: true,
          tags: false,
          onAuth: auth,
        });
      } catch (error) {
        throw normalizeFailure(error, normalizedOptions.signal);
      }
      if (result.fetchHead !== expectedRemoteHead) fail("REMOTE_HEAD_MISMATCH");
      await assertMainPinned(stagePath, stage.head);
      // Deliberately do not inspect or validate fetched object contents here.
      return Object.freeze({ remoteHead: expectedRemoteHead, fetched: true });
    });
  } catch (error) {
    throw normalizeFailure(error, normalizedOptions.signal);
  }
}
