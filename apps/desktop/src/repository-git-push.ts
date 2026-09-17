/**
 * Main-process-only non-force push from one disposable LocalGitStage.
 *
 * The stage is the only filesystem passed to isomorphic-git.  The caller's
 * short-lived token is retained only by the strict auth callback while this
 * operation is running.  This module submits one exact main ref; a later
 * probe must establish synchronization.
 */

import * as git from "isomorphic-git";
import type {
  AuthCallback,
  FsClient,
  HttpClient,
  PrePushCallback,
  PrePushParams,
} from "isomorphic-git";
import { promises as fs } from "node:fs";
import type { VerifiedPrivateRemote } from "./repository-github.js";
import {
  createRepositoryAuthCallback,
  createRepositoryHttpClient,
  RepositoryGitHttpError,
} from "./repository-git-http.js";
import {
  parseRepositoryCloudConnection,
  serializeRepositoryCloudConnection,
  type RepositoryCloudConnection,
} from "./repository-cloud-connection.js";
import { LocalGitStage } from "./repository-git-stage.js";

const GIT_FS: FsClient = { promises: fs };
const SHA1 = /^[0-9a-f]{40}$/u;
const REMOTE_NAME = "maginalia";
const LOCAL_REF = "refs/heads/main";
const REMOTE_REF = "refs/heads/main";
const TRACKING_REF = "refs/remotes/maginalia/main";
const ZERO_OID = "0".repeat(40);

export type RepositoryGitPushErrorCode =
  | "INVALID_INPUT"
  | "INVALID_REMOTE"
  | "AUTH_REQUIRED"
  | "ABORTED"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "REDIRECT_REJECTED"
  | "REMOTE_REF_CHANGED"
  | "STAGE_REF_CHANGED"
  | "PRE_PUSH_MISMATCH"
  | "PRE_PUSH_CALLBACK"
  | "PUSH_FAILED"
  | "PUSH_UNKNOWN";

const ERROR_MESSAGES: Readonly<Record<RepositoryGitPushErrorCode, string>> = Object.freeze({
  INVALID_INPUT: "The GitHub stage push input is invalid.",
  INVALID_REMOTE: "The selected remote is not a verified private GitHub repository.",
  AUTH_REQUIRED: "GitHub authentication is required for the stage push.",
  ABORTED: "The GitHub stage push was cancelled.",
  TIMEOUT: "The GitHub stage push timed out.",
  NETWORK_ERROR: "The GitHub stage push failed due to a network error.",
  REDIRECT_REJECTED: "The GitHub stage push was redirected and was rejected.",
  REMOTE_REF_CHANGED: "The GitHub remote changed before the stage push.",
  STAGE_REF_CHANGED: "The temporary stage changed during the push.",
  PRE_PUSH_MISMATCH: "The stage push precondition did not match the verified refs.",
  PRE_PUSH_CALLBACK: "The stage push precondition callback was not invoked exactly once.",
  PUSH_FAILED: "The GitHub stage push was not accepted.",
  PUSH_UNKNOWN: "The GitHub stage push result is unknown.",
});

export class RepositoryGitPushError extends Error {
  public readonly userMessage: string;
  public readonly uncertain: boolean;

  public constructor(
    public readonly code: RepositoryGitPushErrorCode,
    options: { readonly uncertain?: boolean } = {},
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = "RepositoryGitPushError";
    this.userMessage = this.message;
    this.uncertain = options.uncertain ?? false;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface RepositoryGitPushOptions {
  /** Inject only isomorphic-git's push operation in tests. */
  readonly gitClient?: Pick<typeof git, "push">;
  /** Inject only the strict GitHub smart-HTTP upstream in tests. */
  readonly upstream?: HttpClient;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface StagePushResult {
  /** The push transport accepted the operation; this is not sync proof. */
  readonly status: "submitted";
}

interface NormalizedPushOptions {
  readonly gitClient?: Pick<typeof git, "push">;
  readonly upstream?: HttpClient;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

interface PrePushState {
  calls: number;
  approved: boolean;
}

function fail(code: RepositoryGitPushErrorCode, uncertain = false): never {
  throw new RepositoryGitPushError(code, { uncertain });
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

function ownDataValue(value: Record<string, unknown>, key: string): unknown {
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

function validateOptions(value: RepositoryGitPushOptions | undefined): NormalizedPushOptions {
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

  const gitClientValue = ownDataValue(value, "gitClient");
  if (gitClientValue !== undefined
    && (!isRecord(gitClientValue) || typeof gitClientValue.push !== "function")) {
    fail("INVALID_INPUT");
  }
  const upstreamValue = ownDataValue(value, "upstream");
  if (upstreamValue !== undefined
    && (!isRecord(upstreamValue) || typeof upstreamValue.request !== "function")) {
    fail("INVALID_INPUT");
  }
  const timeoutValue = ownDataValue(value, "timeoutMs");
  if (timeoutValue !== undefined
    && (typeof timeoutValue !== "number" || !Number.isSafeInteger(timeoutValue) || timeoutValue <= 0)) {
    fail("INVALID_INPUT");
  }
  const signalValue = ownDataValue(value, "signal");
  if (signalValue !== undefined && !isAbortSignal(signalValue)) fail("INVALID_INPUT");

  return Object.freeze({
    gitClient: gitClientValue as Pick<typeof git, "push"> | undefined,
    upstream: upstreamValue as HttpClient | undefined,
    timeoutMs: timeoutValue as number | undefined,
    signal: signalValue as AbortSignal | undefined,
  });
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
  expectedRemoteHead: string | null,
  operationToken: string,
): void {
  if (!(stage instanceof LocalGitStage) || !SHA1.test(stage.head)) fail("INVALID_INPUT");
  if (expectedRemoteHead !== null && !SHA1.test(expectedRemoteHead)) fail("INVALID_INPUT");
  if (typeof operationToken !== "string" || operationToken.trim().length === 0) fail("AUTH_REQUIRED");
}

function isMissingRef(error: unknown): boolean {
  if (!isRecord(error)) return false;
  try {
    return error.code === "NotFoundError" || error.name === "NotFoundError";
  } catch {
    return false;
  }
}

async function resolveMainRef(stagePath: string): Promise<string> {
  try {
    return await git.resolveRef({ fs: GIT_FS, dir: stagePath, ref: LOCAL_REF });
  } catch {
    fail("STAGE_REF_CHANGED");
  }
}

async function resolveTrackingRef(stagePath: string): Promise<string | null> {
  try {
    return await git.resolveRef({ fs: GIT_FS, dir: stagePath, ref: TRACKING_REF });
  } catch (error) {
    if (isMissingRef(error)) return null;
    fail("REMOTE_REF_CHANGED");
  }
}

async function assertMainPinned(stagePath: string, stageHead: string, uncertain = false): Promise<void> {
  const actualMain = await resolveMainRef(stagePath).catch((error: unknown) => {
    if (error instanceof RepositoryGitPushError && uncertain) {
      throw new RepositoryGitPushError(error.code, { uncertain: true });
    }
    throw error;
  });
  if (actualMain !== stageHead) fail("STAGE_REF_CHANGED", uncertain);
}

async function assertPinnedRefs(
  stagePath: string,
  stageHead: string,
  expectedRemoteHead: string | null,
): Promise<void> {
  await assertMainPinned(stagePath, stageHead);
  const actualRemote = await resolveTrackingRef(stagePath);
  if (actualRemote !== expectedRemoteHead) fail("REMOTE_REF_CHANGED");
}

function matchesPrePush(
  value: unknown,
  remote: RepositoryCloudConnection,
  stageHead: string,
  expectedRemoteHead: string | null,
): value is PrePushParams {
  if (!hasExactDataKeys(value, ["remote", "url", "localRef", "remoteRef"])) return false;
  const localRef = ownDataValue(value, "localRef");
  const remoteRef = ownDataValue(value, "remoteRef");
  if (!hasExactDataKeys(localRef, ["ref", "oid"]) || !hasExactDataKeys(remoteRef, ["ref", "oid"])) {
    return false;
  }
  return ownDataValue(value, "remote") === REMOTE_NAME
    && ownDataValue(value, "url") === remote.url
    && ownDataValue(localRef, "ref") === LOCAL_REF
    && ownDataValue(localRef, "oid") === stageHead
    && ownDataValue(remoteRef, "ref") === REMOTE_REF
    && ownDataValue(remoteRef, "oid") === (expectedRemoteHead ?? ZERO_OID);
}

function makePrePushCallback(
  remote: RepositoryCloudConnection,
  stageHead: string,
  expectedRemoteHead: string | null,
  state: PrePushState,
): PrePushCallback {
  return (params) => {
    state.calls += 1;
    if (state.calls !== 1) fail("PRE_PUSH_CALLBACK");
    if (!matchesPrePush(params, remote, stageHead, expectedRemoteHead)) fail("PRE_PUSH_MISMATCH");
    state.approved = true;
    return true;
  };
}

function isAcceptedPushResult(value: unknown): boolean {
  if (!isPlainRecord(value) || ownDataValue(value, "ok") !== true) return false;
  const refs = ownDataValue(value, "refs");
  if (!hasExactDataKeys(refs, [REMOTE_REF])) return false;
  const status = ownDataValue(refs, REMOTE_REF);
  return isPlainRecord(status) && ownDataValue(status, "ok") === true;
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

function normalizeFailure(error: unknown, signal: AbortSignal | undefined): RepositoryGitPushError {
  if (error instanceof RepositoryGitPushError) return error;
  if (signal?.aborted) return new RepositoryGitPushError("ABORTED", { uncertain: true });
  if (error instanceof RepositoryGitHttpError) {
    if (error.code === "AUTH_REQUIRED") return new RepositoryGitPushError("AUTH_REQUIRED");
    if (error.code === "INVALID_REMOTE") return new RepositoryGitPushError("INVALID_REMOTE");
    if (error.code === "REDIRECT_REJECTED") return new RepositoryGitPushError("REDIRECT_REJECTED");
    if (error.code === "ABORTED") return new RepositoryGitPushError("ABORTED", { uncertain: true });
    if (error.code === "TIMEOUT") return new RepositoryGitPushError("TIMEOUT", { uncertain: true });
    if (error.code === "NETWORK_ERROR") return new RepositoryGitPushError("NETWORK_ERROR", { uncertain: true });
    return new RepositoryGitPushError("PUSH_FAILED", { uncertain: true });
  }
  const name = errorName(error);
  const code = errorCode(error);
  if (name === "AbortError" || code === "ABORT_ERR") {
    return new RepositoryGitPushError("ABORTED", { uncertain: true });
  }
  if (name === "TimeoutError" || code === "ETIMEDOUT") {
    return new RepositoryGitPushError("TIMEOUT", { uncertain: true });
  }
  if (name === "GitPushError"
    || name === "PushRejectedError"
    || name === "HttpError"
    || name === "SmartHttpError"
    || name === "UserCanceledError") {
    return new RepositoryGitPushError("PUSH_FAILED", { uncertain: true });
  }
  return new RepositoryGitPushError("PUSH_UNKNOWN", { uncertain: true });
}

function bindCallerSignal(http: HttpClient, signal: AbortSignal | undefined): HttpClient {
  if (signal === undefined) return http;
  return {
    request: (request) => {
      const fetchOptions = isRecord(request.fetchOptions)
        ? { ...request.fetchOptions, signal }
        : { signal };
      return http.request({ ...request, fetchOptions, signal });
    },
  };
}

/**
 * Submit exactly the stage's main ref using the verified remote's expected
 * old tip as a compare-and-swap precondition.  A returned `submitted` state
 * means only that the push transport accepted the result; callers must probe
 * the remote independently before declaring synchronization.
 */
export async function pushStageToRemote(
  stage: LocalGitStage,
  verifiedPrivateRemote: VerifiedPrivateRemote,
  operationToken: string,
  expectedRemoteHead: string | null,
  options?: RepositoryGitPushOptions,
): Promise<StagePushResult> {
  const normalizedOptions = validateOptions(options);
  const remote = normalizeRemote(verifiedPrivateRemote);
  validateInputs(stage, expectedRemoteHead, operationToken);
  if (normalizedOptions.signal?.aborted) fail("ABORTED");

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
  const state: PrePushState = { calls: 0, approved: false };
  try {
    return await stage.withOwnedDirectory(async (stagePath) => {
      await assertPinnedRefs(stagePath, stage.head, expectedRemoteHead);
      const onPrePush = makePrePushCallback(remote, stage.head, expectedRemoteHead, state);
      let pushResult: Awaited<ReturnType<typeof git.push>>;
      try {
        pushResult = await gitClient.push({
          fs: GIT_FS,
          http,
          dir: stagePath,
          url: remote.url,
          remote: REMOTE_NAME,
          ref: "main",
          remoteRef: REMOTE_REF,
          force: false,
          onAuth: auth,
          onPrePush,
        });
      } catch (error) {
        throw normalizeFailure(error, normalizedOptions.signal);
      }
      if (normalizedOptions.signal?.aborted) fail("ABORTED", true);
      await assertMainPinned(stagePath, stage.head, true).catch((error: unknown) => {
        if (error instanceof RepositoryGitPushError) {
          throw error;
        }
        throw normalizeFailure(error, normalizedOptions.signal);
      });
      if (state.calls !== 1 || !state.approved) fail("PRE_PUSH_CALLBACK", true);
      if (!isAcceptedPushResult(pushResult)) fail("PUSH_FAILED", true);
      return Object.freeze({ status: "submitted" as const });
    });
  } catch (error) {
    throw normalizeFailure(error, normalizedOptions.signal);
  }
}
