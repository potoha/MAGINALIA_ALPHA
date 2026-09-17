/**
 * Main-process-only post-push confirmation.
 *
 * Confirmation is deliberately read-only and one-shot: verify the private
 * repository identity independently, then inspect the remote main
 * advertisement.  A transport result is never treated as synchronized until
 * both checks have completed successfully.
 */

import type {
  GitHubAdapter,
  GitHubOperationOptions,
  VerifiedPrivateRemote,
} from "./repository-github";
import { GitHubAdapterError } from "./repository-github";
import {
  probeRemoteMain,
  RepositoryGitProbeError,
  type RepositoryGitProbeOptions,
  type RepositoryRemoteMainProbeResult,
} from "./repository-git-probe";
import { RepositoryGitHttpError } from "./repository-git-http";
import {
  parseRepositoryCloudConnection,
  serializeRepositoryCloudConnection,
} from "./repository-cloud-connection";

const SHA1_PATTERN = /^[0-9a-f]{40}$/u;
const MAX_CONFIRM_TIMEOUT_MS = 60_000;

export type RepositoryGitConfirmErrorCode =
  | "INVALID_INPUT"
  | "PRIVATE_VERIFY_FAILED"
  | "REMOTE_STATE_UNKNOWN"
  | "ABORTED"
  | "TIMEOUT"
  | "NETWORK_ERROR";

const ERROR_MESSAGES: Readonly<Record<RepositoryGitConfirmErrorCode, string>> = Object.freeze({
  INVALID_INPUT: "The GitHub remote confirmation input is invalid.",
  PRIVATE_VERIFY_FAILED: "The private GitHub remote could not be independently verified.",
  REMOTE_STATE_UNKNOWN: "The GitHub remote state could not be confirmed.",
  ABORTED: "The GitHub remote confirmation was cancelled.",
  TIMEOUT: "The GitHub remote confirmation timed out.",
  NETWORK_ERROR: "The GitHub remote confirmation failed due to a network error.",
});

/** Errors contain only a fixed local classification, never provider data. */
export class RepositoryGitConfirmError extends Error {
  public readonly code: RepositoryGitConfirmErrorCode;
  public readonly userMessage: string;

  public constructor(code: RepositoryGitConfirmErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "RepositoryGitConfirmError";
    this.code = code;
    this.userMessage = this.message;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type GitHubRemoteVerifier = Pick<GitHubAdapter, "verifyRemote">;

export interface RepositoryGitConfirmOptions {
  /** Caller cancellation is forwarded to both independent read operations. */
  readonly signal?: AbortSignal;
  /** Per-request timeout, bounded by the underlying adapters. */
  readonly timeoutMs?: number;
  /** Test seam; production uses the strict read-only remote probe. */
  readonly probe?: typeof probeRemoteMain;
}

export type RepositoryGitConfirmResult = Readonly<{
  readonly status: "confirmed" | "changed";
}>;

interface NormalizedConfirmOptions {
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number | undefined;
  readonly probe: typeof probeRemoteMain;
}

type VerifyRemoteMethod = GitHubRemoteVerifier["verifyRemote"];

function fail(code: RepositoryGitConfirmErrorCode): never {
  throw new RepositoryGitConfirmError(code);
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

function ownDataKey(value: Record<string, unknown>, key: string): boolean {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor;
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

function normalizeOptions(value: RepositoryGitConfirmOptions | undefined): NormalizedConfirmOptions {
  if (value === undefined) {
    return Object.freeze({ probe: probeRemoteMain, signal: undefined, timeoutMs: undefined });
  }
  if (!isPlainRecord(value)) fail("INVALID_INPUT");
  let keys: (string | symbol)[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    fail("INVALID_INPUT");
  }
  const allowed = new Set(["signal", "timeoutMs", "probe"]);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) fail("INVALID_INPUT");
  for (const key of keys) {
    if (typeof key !== "string" || !ownDataKey(value, key)) fail("INVALID_INPUT");
  }

  const signalValue = ownValue(value, "signal");
  if (signalValue !== undefined && !isAbortSignal(signalValue)) fail("INVALID_INPUT");
  const timeoutValue = ownValue(value, "timeoutMs");
  if (timeoutValue !== undefined
    && (typeof timeoutValue !== "number"
      || !Number.isSafeInteger(timeoutValue)
      || timeoutValue <= 0
      || timeoutValue > MAX_CONFIRM_TIMEOUT_MS)) {
    fail("INVALID_INPUT");
  }
  const probeValue = ownValue(value, "probe");
  if (probeValue !== undefined && typeof probeValue !== "function") fail("INVALID_INPUT");

  return Object.freeze({
    signal: signalValue as AbortSignal | undefined,
    timeoutMs: timeoutValue as number | undefined,
    probe: (probeValue ?? probeRemoteMain) as typeof probeRemoteMain,
  });
}

function normalizeRemote(value: VerifiedPrivateRemote): VerifiedPrivateRemote {
  try {
    return parseRepositoryCloudConnection(serializeRepositoryCloudConnection(value));
  } catch {
    fail("INVALID_INPUT");
  }
}

function validateHead(value: unknown): string {
  if (typeof value !== "string" || !SHA1_PATTERN.test(value) || value !== value.toLowerCase()) {
    fail("INVALID_INPUT");
  }
  return value;
}

function getVerifyRemoteMethod(value: unknown): VerifyRemoteMethod | undefined {
  if (!isRecord(value)) return undefined;
  let current: object | null = value;
  try {
    while (current !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(current, "verifyRemote");
      if (descriptor !== undefined) {
        if (!("value" in descriptor) || typeof descriptor.value !== "function") return undefined;
        return descriptor.value as VerifyRemoteMethod;
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function requestOptions(
  options: NormalizedConfirmOptions,
): GitHubOperationOptions | undefined {
  if (options.signal === undefined && options.timeoutMs === undefined) return undefined;
  return Object.freeze({
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

function probeOptions(
  options: NormalizedConfirmOptions,
): RepositoryGitProbeOptions | undefined {
  if (options.signal === undefined && options.timeoutMs === undefined) return undefined;
  return Object.freeze({
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
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

function normalizeFailure(
  error: unknown,
  signal: AbortSignal | undefined,
  phase: "verify" | "probe",
): RepositoryGitConfirmError {
  if (error instanceof RepositoryGitConfirmError) return error;
  if (signal?.aborted) return new RepositoryGitConfirmError("ABORTED");

  if (error instanceof GitHubAdapterError) {
    if (error.code === "ABORTED") return new RepositoryGitConfirmError("ABORTED");
    if (error.code === "TIMEOUT") return new RepositoryGitConfirmError("TIMEOUT");
    if (error.code === "NETWORK_ERROR") return new RepositoryGitConfirmError("NETWORK_ERROR");
    return new RepositoryGitConfirmError("PRIVATE_VERIFY_FAILED");
  }
  if (error instanceof RepositoryGitProbeError || error instanceof RepositoryGitHttpError) {
    const code = error.code;
    if (code === "ABORTED") return new RepositoryGitConfirmError("ABORTED");
    if (code === "TIMEOUT") return new RepositoryGitConfirmError("TIMEOUT");
    if (code === "NETWORK_ERROR") return new RepositoryGitConfirmError("NETWORK_ERROR");
    return new RepositoryGitConfirmError("REMOTE_STATE_UNKNOWN");
  }

  const name = errorName(error);
  const code = errorCode(error);
  if (name === "AbortError" || code === "ABORT_ERR") {
    return new RepositoryGitConfirmError("ABORTED");
  }
  if (name === "TimeoutError" || code === "ETIMEDOUT") {
    return new RepositoryGitConfirmError("TIMEOUT");
  }
  if (code === "NETWORK_ERROR" || code === "ECONNRESET" || code === "ENETUNREACH") {
    return new RepositoryGitConfirmError("NETWORK_ERROR");
  }
  return new RepositoryGitConfirmError(
    phase === "verify" ? "PRIVATE_VERIFY_FAILED" : "REMOTE_STATE_UNKNOWN",
  );
}

function normalizeProbeResult(value: unknown): RepositoryRemoteMainProbeResult {
  if (!isPlainRecord(value)) fail("REMOTE_STATE_UNKNOWN");
  let keys: (string | symbol)[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    fail("REMOTE_STATE_UNKNOWN");
  }
  if (keys.length !== 1 || keys[0] !== "remoteHead" || !ownDataKey(value, "remoteHead")) {
    fail("REMOTE_STATE_UNKNOWN");
  }
  const remoteHead = ownValue(value, "remoteHead");
  if (remoteHead !== null
    && (typeof remoteHead !== "string"
      || !SHA1_PATTERN.test(remoteHead)
      || remoteHead !== remoteHead.toLowerCase())) {
    fail("REMOTE_STATE_UNKNOWN");
  }
  return Object.freeze({ remoteHead: remoteHead as string | null });
}

/**
 * Confirm the result of a submitted stage push without retrying or pushing.
 * The private GraphQL verification always precedes the read-only Git probe.
 */
export async function confirmPushedRemote(
  verifier: GitHubRemoteVerifier,
  verifiedPrivateRemote: VerifiedPrivateRemote,
  transportToken: string,
  expectedLocalHead: string,
  options?: RepositoryGitConfirmOptions,
): Promise<RepositoryGitConfirmResult> {
  const verifyMethod = getVerifyRemoteMethod(verifier);
  if (verifyMethod === undefined) fail("INVALID_INPUT");
  const remote = normalizeRemote(verifiedPrivateRemote);
  const expected = validateHead(expectedLocalHead);
  if (typeof transportToken !== "string" || transportToken.length === 0) fail("INVALID_INPUT");
  const normalizedOptions = normalizeOptions(options);
  if (normalizedOptions.signal?.aborted) fail("ABORTED");

  const verifyRequestOptions = requestOptions(normalizedOptions);
  let independentlyVerified: VerifiedPrivateRemote;
  let verifiedResult: unknown;
  try {
    verifiedResult = verifyRequestOptions === undefined
      ? await verifyMethod.call(verifier, remote)
      : await verifyMethod.call(verifier, remote, verifyRequestOptions);
  } catch (error) {
    throw normalizeFailure(error, normalizedOptions.signal, "verify");
  }
  try {
    independentlyVerified = normalizeRemote(verifiedResult as VerifiedPrivateRemote);
  } catch {
    fail("PRIVATE_VERIFY_FAILED");
  }
  if (normalizedOptions.signal?.aborted) fail("ABORTED");
  if (independentlyVerified.id !== remote.id || independentlyVerified.nodeId !== remote.nodeId) {
    fail("PRIVATE_VERIFY_FAILED");
  }

  const probeRequestOptions = probeOptions(normalizedOptions);
  let observed: RepositoryRemoteMainProbeResult;
  try {
    const result = probeRequestOptions === undefined
      ? await normalizedOptions.probe(independentlyVerified, transportToken)
      : await normalizedOptions.probe(independentlyVerified, transportToken, probeRequestOptions);
    observed = normalizeProbeResult(result);
  } catch (error) {
    throw normalizeFailure(error, normalizedOptions.signal, "probe");
  }
  if (normalizedOptions.signal?.aborted) fail("ABORTED");

  return Object.freeze({
    status: observed.remoteHead === expected ? "confirmed" : "changed",
  });
}
