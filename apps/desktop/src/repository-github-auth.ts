/**
 * Main-process-only GitHub App Device Flow boundary.  It deliberately has no
 * renderer, Electron, filesystem, or session dependency: the caller supplies
 * the public client ID, cancellation signal, and trusted verification callback
 * for each independent operation.  GitHub App user tokens use the App's
 * fine-grained permissions rather than an OAuth scope; any refresh token is
 * intentionally discarded with the rest of the provider response.
 */

import { TextDecoder } from "node:util";

export const GITHUB_DEVICE_CODE_ENDPOINT = "https://github.com/login/device/code" as const;
export const GITHUB_ACCESS_TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token" as const;
export const GITHUB_DEVICE_VERIFICATION_URI = "https://github.com/login/device" as const;

export const DEFAULT_GITHUB_DEVICE_FLOW_TIMEOUT_MS = 15 * 60 * 1_000;
export const MAX_GITHUB_DEVICE_FLOW_TIMEOUT_MS = 15 * 60 * 1_000;
export const MAX_GITHUB_AUTH_RESPONSE_BYTES = 64 * 1024;

const MAX_CLIENT_ID_LENGTH = 200;
const MAX_DEVICE_CODE_LENGTH = 512;
const MAX_USER_CODE_LENGTH = 64;
const MAX_TOKEN_LENGTH = 4 * 1024;
const MAX_ERROR_FIELD_LENGTH = 2 * 1024;
const MAX_DEVICE_EXPIRES_SECONDS = MAX_GITHUB_DEVICE_FLOW_TIMEOUT_MS / 1_000;
const MAX_POLL_INTERVAL_SECONDS = MAX_GITHUB_DEVICE_FLOW_TIMEOUT_MS / 1_000;
const MIN_SLOW_DOWN_INCREMENT_MS = 5_000;
const DEVICE_CODE_PATTERN = /^[A-Za-z0-9_~+/=:.!-]+$/;
const USER_CODE_PATTERN = /^[A-Za-z0-9-]+$/;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const SAFE_FIELD_PATTERN = /^[^\u0000-\u001F\u007F-\u009F]+$/u;

const DEVICE_RESPONSE_KEYS = [
  "device_code",
  "user_code",
  "verification_uri",
  "verification_uri_complete",
  "expires_in",
  "interval",
] as const;

const DEVICE_REQUIRED_KEYS = [
  "device_code",
  "user_code",
  "verification_uri",
  "expires_in",
  "interval",
] as const;

const SUCCESS_RESPONSE_KEYS = [
  "access_token",
  "token_type",
  "scope",
  "refresh_token",
  "expires_in",
  "refresh_token_expires_in",
] as const;

const ERROR_RESPONSE_KEYS = ["error", "error_description", "error_uri", "interval"] as const;

const DEVICE_ERROR_CODES = new Set([
  "authorization_pending",
  "slow_down",
  "expired_token",
  "token_expired",
  "unsupported_grant_type",
  "incorrect_client_credentials",
  "incorrect_device_code",
  "access_denied",
  "device_flow_disabled",
  "bad_verification_code",
  "invalid_request",
  "unverified_user_email",
]);

type DeviceErrorCode =
  | "authorization_pending"
  | "slow_down"
  | "expired_token"
  | "token_expired"
  | "unsupported_grant_type"
  | "incorrect_client_credentials"
  | "incorrect_device_code"
  | "access_denied"
  | "device_flow_disabled"
  | "bad_verification_code"
  | "invalid_request"
  | "unverified_user_email";

export type GitHubDeviceFlowErrorCode =
  | "INVALID_INPUT"
  | "AUTH_REQUEST_FAILED"
  | "AUTHORIZATION_DENIED"
  | "DEVICE_CODE_EXPIRED"
  | "RATE_LIMITED"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "ABORTED"
  | "RESPONSE_TOO_LARGE"
  | "INVALID_RESPONSE"
  | "REDIRECT_REJECTED"
  | "CALLBACK_FAILED";

const ERROR_MESSAGES: Readonly<Record<GitHubDeviceFlowErrorCode, string>> = Object.freeze({
  INVALID_INPUT: "The GitHub Device Flow input is invalid.",
  AUTH_REQUEST_FAILED: "GitHub Device Flow authorization failed.",
  AUTHORIZATION_DENIED: "GitHub Device Flow authorization was cancelled.",
  DEVICE_CODE_EXPIRED: "The GitHub Device Flow code expired.",
  RATE_LIMITED: "GitHub Device Flow reached a rate limit.",
  NETWORK_ERROR: "The GitHub Device Flow network request failed.",
  TIMEOUT: "The GitHub Device Flow timed out.",
  ABORTED: "The GitHub Device Flow was cancelled.",
  RESPONSE_TOO_LARGE: "The GitHub Device Flow response exceeded the safety limit.",
  INVALID_RESPONSE: "GitHub returned an invalid Device Flow response.",
  REDIRECT_REJECTED: "GitHub redirected a Device Flow request; the redirect was rejected.",
  CALLBACK_FAILED: "The GitHub Device Flow verification prompt could not be delivered.",
});

export class GitHubDeviceFlowError extends Error {
  public readonly code: GitHubDeviceFlowErrorCode;
  public readonly userMessage: string;
  public readonly status: number | undefined;

  public constructor(code: GitHubDeviceFlowErrorCode, status?: number) {
    super(ERROR_MESSAGES[code]);
    this.name = "GitHubDeviceFlowError";
    this.code = code;
    this.userMessage = this.message;
    this.status = status;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface GitHubDeviceVerificationPrompt {
  readonly userCode: string;
  readonly verificationUri: typeof GITHUB_DEVICE_VERIFICATION_URI;
}

export type GitHubDeviceVerificationCallback = (
  prompt: GitHubDeviceVerificationPrompt,
) => void | Promise<void>;

export interface GitHubDeviceFlowRequest {
  readonly clientId: string;
  readonly signal: AbortSignal;
  readonly onVerification: GitHubDeviceVerificationCallback;
}

export type GitHubDeviceFlowFetch = (input: string, init?: RequestInit) => Promise<Response>;
export type GitHubDeviceFlowSleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;

export interface GitHubDeviceFlowAdapterOptions {
  readonly fetch?: GitHubDeviceFlowFetch;
  readonly sleep?: GitHubDeviceFlowSleep;
  readonly timeoutMs?: number;
}

interface NormalizedAdapterOptions {
  readonly fetch: GitHubDeviceFlowFetch;
  readonly sleep: GitHubDeviceFlowSleep;
  readonly timeoutMs: number;
}

interface FlowState {
  readonly controller: AbortController;
  callerAborted: boolean;
  timedOut: boolean;
}

interface DeviceAuthorization {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly expiresInSeconds: number;
  readonly intervalSeconds: number;
}

interface TokenPollSuccess {
  readonly kind: "success";
  readonly accessToken: string;
}

interface TokenPollError {
  readonly kind: "error";
  readonly code: DeviceErrorCode;
  readonly intervalSeconds?: number;
}

type TokenPollResult = TokenPollSuccess | TokenPollError;

interface JsonResponse {
  readonly status: number;
  readonly body: unknown;
}

function fail(code: GitHubDeviceFlowErrorCode, status?: number): never {
  throw new GitHubDeviceFlowError(code, status);
}

function abortError(): DOMException {
  return new DOMException("The request was aborted.", "AbortError");
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

function hasOwnData(value: Record<string, unknown>, key: string): boolean {
  return ownDataDescriptor(value, key) !== undefined;
}

function hasOnlyKeys(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  try {
    const keys = Reflect.ownKeys(value);
    return keys.every((key) => typeof key === "string" && allowed.includes(key))
      && keys.every((key) => typeof key === "string" && ownDataDescriptor(value, key) !== undefined);
  } catch {
    return false;
  }
}

function hasRequiredKeys(value: unknown, required: readonly string[], allowed: readonly string[]): value is Record<string, unknown> {
  return hasOnlyKeys(value, allowed) && required.every((key) => hasOwnData(value, key));
}

function isBoundedSafeString(value: unknown, maxLength: number, pattern: RegExp = SAFE_FIELD_PATTERN): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && pattern.test(value);
}

function validateClientId(value: unknown): string {
  if (!isBoundedSafeString(value, MAX_CLIENT_ID_LENGTH, CLIENT_ID_PATTERN)) fail("INVALID_INPUT");
  return value;
}

function validateSignal(value: unknown): AbortSignal {
  if (value === null || typeof value !== "object"
    || typeof (value as AbortSignal).addEventListener !== "function"
    || typeof (value as AbortSignal).removeEventListener !== "function"
    || typeof (value as AbortSignal).aborted !== "boolean") {
    fail("INVALID_INPUT");
  }
  return value as AbortSignal;
}

function validateVerificationCallback(value: unknown): GitHubDeviceVerificationCallback {
  if (typeof value !== "function") fail("INVALID_INPUT");
  return value as GitHubDeviceVerificationCallback;
}

function validateTimeout(value: unknown): number {
  if (typeof value !== "number"
    || !Number.isFinite(value)
    || value <= 0
    || value > MAX_GITHUB_DEVICE_FLOW_TIMEOUT_MS) {
    fail("INVALID_INPUT");
  }
  return value;
}

function responseHeader(response: Response, name: string): string | null {
  try {
    return response.headers?.get(name) ?? null;
  } catch {
    fail("INVALID_RESPONSE");
  }
}

function validateJsonContentType(response: Response): void {
  const contentType = responseHeader(response, "content-type");
  if (contentType === null || contentType.trim() === "") return;
  const mediaType = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (mediaType !== "application/json" && !mediaType.endsWith("+json")) fail("INVALID_RESPONSE");
}

function isRateLimitedResponse(response: Response): boolean {
  const remaining = responseHeader(response, "x-ratelimit-remaining");
  return response.status === 429
    || remaining === "0"
    || responseHeader(response, "retry-after") !== null;
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // The bounded operation has already stopped using the response.
  }
}

async function readResponseBytes(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const body = response.body;
  const contentLength = responseHeader(response, "content-length");
  if (contentLength !== null && contentLength.trim() !== "") {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0) fail("INVALID_RESPONSE");
    if (parsed > MAX_GITHUB_AUTH_RESPONSE_BYTES) {
      if (body && typeof body.getReader === "function") {
        const reader = body.getReader();
        await cancelReader(reader);
        reader.releaseLock();
      }
      fail("RESPONSE_TOO_LARGE");
    }
  }

  if (signal.aborted) {
    if (body && typeof body.getReader === "function") {
      const reader = body.getReader();
      await cancelReader(reader);
      reader.releaseLock();
    }
    throw abortError();
  }
  if (!body || typeof body.getReader !== "function") fail("INVALID_RESPONSE");

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
        throw abortError();
      }
      const result = await reader.read();
      if (signal.aborted || cancelled) {
        await cancelReader(reader);
        throw abortError();
      }
      if (result.done) break;
      const chunk = result.value instanceof Uint8Array ? result.value : new Uint8Array(result.value);
      total += chunk.byteLength;
      if (total > MAX_GITHUB_AUTH_RESPONSE_BYTES) {
        await cancelReader(reader);
        fail("RESPONSE_TOO_LARGE");
      }
      chunks.push(chunk);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // The response stream is no longer used.
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseJson(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("INVALID_RESPONSE");
  }
  try {
    return JSON.parse(text);
  } catch {
    fail("INVALID_RESPONSE");
  }
}

function validateResponseMetadata(response: unknown, expectedUrl: string): Response {
  if (response === null || typeof response !== "object") fail("INVALID_RESPONSE");
  const value = response as Response;
  let status: unknown;
  let redirected: unknown;
  let type: unknown;
  let url: unknown;
  try {
    status = value.status;
    redirected = value.redirected;
    type = value.type;
    url = value.url;
  } catch {
    fail("INVALID_RESPONSE");
  }
  if (typeof status !== "number" || !Number.isSafeInteger(status) || status < 100 || status > 599) {
    fail("INVALID_RESPONSE");
  }
  if (redirected === true || type === "opaqueredirect" || (status >= 300 && status < 400)) {
    fail("REDIRECT_REJECTED", status);
  }
  if (typeof url !== "string") fail("INVALID_RESPONSE");
  if (url !== "" && url !== expectedUrl) fail("REDIRECT_REJECTED", status);
  return value;
}

function validateDeviceAuthorization(body: unknown): DeviceAuthorization {
  if (!hasRequiredKeys(body, DEVICE_REQUIRED_KEYS, DEVICE_RESPONSE_KEYS)) fail("INVALID_RESPONSE");
  const deviceCode = ownValue(body, "device_code");
  const userCode = ownValue(body, "user_code");
  const verificationUri = ownValue(body, "verification_uri");
  const expiresIn = ownValue(body, "expires_in");
  const interval = ownValue(body, "interval");
  if (!isBoundedSafeString(deviceCode, MAX_DEVICE_CODE_LENGTH, DEVICE_CODE_PATTERN)
    || !isBoundedSafeString(userCode, MAX_USER_CODE_LENGTH, USER_CODE_PATTERN)
    || verificationUri !== GITHUB_DEVICE_VERIFICATION_URI
    || typeof expiresIn !== "number"
    || !Number.isSafeInteger(expiresIn)
    || expiresIn <= 0
    || expiresIn > MAX_DEVICE_EXPIRES_SECONDS
    || typeof interval !== "number"
    || !Number.isSafeInteger(interval)
    || interval <= 0
    || interval > MAX_POLL_INTERVAL_SECONDS) {
    fail("INVALID_RESPONSE");
  }
  if (hasOwnData(body, "verification_uri_complete")
    && !isBoundedSafeString(ownValue(body, "verification_uri_complete"), MAX_ERROR_FIELD_LENGTH)) {
    fail("INVALID_RESPONSE");
  }
  return { deviceCode, userCode, expiresInSeconds: expiresIn, intervalSeconds: interval };
}

function parseOAuthError(body: unknown): TokenPollError | undefined {
  if (!isPlainRecord(body) || !hasOwnData(body, "error")) return undefined;
  if (!hasOnlyKeys(body, ERROR_RESPONSE_KEYS)) fail("INVALID_RESPONSE");
  const rawError = ownValue(body, "error");
  if (!isBoundedSafeString(rawError, 128)) fail("INVALID_RESPONSE");
  if (!DEVICE_ERROR_CODES.has(rawError)) fail("AUTH_REQUEST_FAILED");
  const error = rawError as DeviceErrorCode;
  const description = ownValue(body, "error_description");
  const uri = ownValue(body, "error_uri");
  if (description !== undefined && !isBoundedSafeString(description, MAX_ERROR_FIELD_LENGTH)) {
    fail("INVALID_RESPONSE");
  }
  if (uri !== undefined && !isBoundedSafeString(uri, MAX_ERROR_FIELD_LENGTH)) {
    fail("INVALID_RESPONSE");
  }
  const intervalValue = ownValue(body, "interval");
  if (intervalValue !== undefined
    && (typeof intervalValue !== "number"
      || !Number.isSafeInteger(intervalValue)
      || intervalValue <= 0
      || intervalValue > MAX_POLL_INTERVAL_SECONDS)) {
    fail("INVALID_RESPONSE");
  }
  return {
    kind: "error",
    code: error,
    ...(intervalValue === undefined ? {} : { intervalSeconds: intervalValue }),
  };
}

function validateOptionalSuccessField(body: Record<string, unknown>, key: string): void {
  if (!hasOwnData(body, key)) return;
  const value = ownValue(body, key);
  if (key === "token_type") {
    if (value !== "bearer") fail("INVALID_RESPONSE");
    return;
  }
  if (key === "scope") {
    if (typeof value !== "string"
      || value !== "") {
      fail("INVALID_RESPONSE");
    }
    return;
  }
  if (key === "expires_in" || key === "refresh_token_expires_in") {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) fail("INVALID_RESPONSE");
    return;
  }
  if (key === "refresh_token" && !isBoundedSafeString(value, MAX_TOKEN_LENGTH)) fail("INVALID_RESPONSE");
}

function parseTokenPoll(body: unknown): TokenPollResult {
  const oauthError = parseOAuthError(body);
  if (oauthError) return oauthError;
  if (!hasRequiredKeys(body, ["access_token", "token_type"], SUCCESS_RESPONSE_KEYS)) fail("INVALID_RESPONSE");
  const accessToken = ownValue(body, "access_token");
  if (!isBoundedSafeString(accessToken, MAX_TOKEN_LENGTH)) fail("INVALID_RESPONSE");
  for (const key of SUCCESS_RESPONSE_KEYS) validateOptionalSuccessField(body, key);
  return { kind: "success", accessToken };
}

function classifyDeviceError(error: DeviceErrorCode): GitHubDeviceFlowErrorCode {
  switch (error) {
    case "access_denied":
      return "AUTHORIZATION_DENIED";
    case "expired_token":
    case "token_expired":
    case "bad_verification_code":
      return "DEVICE_CODE_EXPIRED";
    case "authorization_pending":
    case "slow_down":
      return "AUTH_REQUEST_FAILED";
    default:
      return "AUTH_REQUEST_FAILED";
  }
}

function defaultFetch(input: string, init?: RequestInit): Promise<Response> {
  const implementation = globalThis.fetch;
  if (typeof implementation !== "function") return Promise.reject(new Error("fetch is unavailable"));
  return implementation(input, init);
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function normalizeOptions(options: GitHubDeviceFlowAdapterOptions): NormalizedAdapterOptions {
  if (!isPlainRecord(options)) fail("INVALID_INPUT");
  const optionNames = Object.getOwnPropertyNames(options);
  if (Object.getOwnPropertySymbols(options).length !== 0
    || optionNames.some((name) => !["fetch", "sleep", "timeoutMs"].includes(name))
    || optionNames.some((name) => ownDataDescriptor(options, name) === undefined)) {
    fail("INVALID_INPUT");
  }
  const fetchValue = ownValue(options, "fetch");
  const sleepValue = ownValue(options, "sleep");
  const timeoutValue = ownValue(options, "timeoutMs");
  if (fetchValue !== undefined && typeof fetchValue !== "function") fail("INVALID_INPUT");
  if (sleepValue !== undefined && typeof sleepValue !== "function") fail("INVALID_INPUT");
  const timeoutMs = timeoutValue === undefined
    ? DEFAULT_GITHUB_DEVICE_FLOW_TIMEOUT_MS
    : validateTimeout(timeoutValue);
  return {
    fetch: fetchValue === undefined ? defaultFetch : fetchValue as GitHubDeviceFlowFetch,
    sleep: sleepValue === undefined ? defaultSleep : sleepValue as GitHubDeviceFlowSleep,
    timeoutMs,
  };
}

function deadlineError(kind: "timeout" | "expired"): GitHubDeviceFlowError {
  return new GitHubDeviceFlowError(kind === "expired" ? "DEVICE_CODE_EXPIRED" : "TIMEOUT");
}

function classifyThrown(error: unknown, state: FlowState, expiryKind: "timeout" | "expired"): GitHubDeviceFlowError {
  if (state.callerAborted) return new GitHubDeviceFlowError("ABORTED");
  if (state.timedOut) {
    if (error instanceof GitHubDeviceFlowError
      && (error.code === "TIMEOUT" || error.code === "DEVICE_CODE_EXPIRED")) {
      return error;
    }
    return deadlineError(expiryKind);
  }
  if (error instanceof GitHubDeviceFlowError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return state.callerAborted ? new GitHubDeviceFlowError("ABORTED") : deadlineError(expiryKind);
  }
  return new GitHubDeviceFlowError("NETWORK_ERROR");
}

function buildRequestInit(form: Record<string, string>, signal: AbortSignal): RequestInit {
  return {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form).toString(),
    redirect: "error",
    signal,
  };
}

export class GitHubDeviceFlowAdapter {
  readonly #fetch: GitHubDeviceFlowFetch;
  readonly #sleep: GitHubDeviceFlowSleep;
  readonly #timeoutMs: number;

  public constructor(options: GitHubDeviceFlowAdapterOptions = {}) {
    const normalized = normalizeOptions(options);
    this.#fetch = normalized.fetch;
    this.#sleep = normalized.sleep;
    this.#timeoutMs = normalized.timeoutMs;
  }

  /**
   * Start one independent Device Flow.  The returned value is the only token
   * this module hands to its trusted main-process caller; no token is cached.
   */
  public async authorize(request: GitHubDeviceFlowRequest): Promise<string> {
    if (!isPlainRecord(request)) fail("INVALID_INPUT");
    const requestNames = Object.getOwnPropertyNames(request);
    if (Object.getOwnPropertySymbols(request).length !== 0
      || requestNames.length !== 3
      || requestNames.some((name) => !["clientId", "signal", "onVerification"].includes(name))
      || requestNames.some((name) => ownDataDescriptor(request, name) === undefined)) {
      fail("INVALID_INPUT");
    }
    const clientId = validateClientId(ownValue(request, "clientId"));
    const callerSignal = validateSignal(ownValue(request, "signal"));
    const onVerification = validateVerificationCallback(ownValue(request, "onVerification"));
    if (callerSignal.aborted) fail("ABORTED");

    const state: FlowState = {
      controller: new AbortController(),
      callerAborted: false,
      timedOut: false,
    };
    const onAbort = (): void => {
      state.callerAborted = true;
      state.controller.abort();
    };
    callerSignal.addEventListener("abort", onAbort, { once: true });
    const operationStartedAt = Date.now();
    const operationDeadline = operationStartedAt + this.#timeoutMs;
    try {
      const deviceResponse = await this.requestJson(
        GITHUB_DEVICE_CODE_ENDPOINT,
        buildRequestInit({ client_id: clientId }, state.controller.signal),
        state,
        operationDeadline,
        "timeout",
      );
      if (deviceResponse.status !== 200) {
        const providerError = parseOAuthError(deviceResponse.body);
        if (providerError) fail(classifyDeviceError(providerError.code), deviceResponse.status);
        if (deviceResponse.status === 429) fail("RATE_LIMITED", deviceResponse.status);
        if (deviceResponse.status >= 500) fail("NETWORK_ERROR", deviceResponse.status);
        fail("AUTH_REQUEST_FAILED", deviceResponse.status);
      }
      const authorization = validateDeviceAuthorization(deviceResponse.body);
      const deviceDeadline = Date.now() + authorization.expiresInSeconds * 1_000;
      const codeDeadline = Math.min(
        operationDeadline,
        deviceDeadline,
      );
      const codeDeadlineKind = deviceDeadline < operationDeadline ? "expired" : "timeout";
      this.ensureDeadline(state, codeDeadline, codeDeadlineKind);
      const prompt = Object.freeze({
        userCode: authorization.userCode,
        verificationUri: GITHUB_DEVICE_VERIFICATION_URI,
      });
      await this.notifyVerification(onVerification, prompt, state, codeDeadline, codeDeadlineKind);
      this.ensureDeadline(state, codeDeadline, codeDeadlineKind);

      let intervalMilliseconds = authorization.intervalSeconds * 1_000;
      for (;;) {
        const expiryKind = codeDeadlineKind;
        await this.waitFor(intervalMilliseconds, codeDeadline, state, expiryKind);
        const tokenResponse = await this.requestJson(
          GITHUB_ACCESS_TOKEN_ENDPOINT,
          buildRequestInit({
            client_id: clientId,
            device_code: authorization.deviceCode,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          }, state.controller.signal),
          state,
          codeDeadline,
          expiryKind,
        );
        if (tokenResponse.status === 429) fail("RATE_LIMITED", tokenResponse.status);
        if (tokenResponse.status >= 500) fail("NETWORK_ERROR", tokenResponse.status);
        const pollResult = parseTokenPoll(tokenResponse.body);
        if (pollResult.kind === "success") {
          if (tokenResponse.status !== 200) fail("AUTH_REQUEST_FAILED", tokenResponse.status);
          return pollResult.accessToken;
        }
        if (pollResult.code === "authorization_pending") continue;
        if (pollResult.code === "slow_down") {
          const responseInterval = pollResult.intervalSeconds === undefined
            ? 0
            : pollResult.intervalSeconds * 1_000;
          intervalMilliseconds = Math.max(
            intervalMilliseconds + MIN_SLOW_DOWN_INCREMENT_MS,
            responseInterval,
          );
          continue;
        }
        fail(classifyDeviceError(pollResult.code), tokenResponse.status);
      }
    } catch (error) {
      throw classifyThrown(error, state, "timeout");
    } finally {
      callerSignal.removeEventListener("abort", onAbort);
    }
  }

  private async requestJson(
    url: string,
    init: RequestInit,
    state: FlowState,
    deadline: number,
    expiryKind: "timeout" | "expired",
  ): Promise<JsonResponse> {
    this.ensureDeadline(state, deadline, expiryKind);
    const remaining = Math.max(1, deadline - Date.now());
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let rejectControl!: (error: unknown) => void;
    const control = new Promise<never>((_resolve, reject) => {
      rejectControl = reject;
    });
    const onControlAbort = (): void => rejectControl(abortError());
    state.controller.signal.addEventListener("abort", onControlAbort, { once: true });
    timeoutTimer = setTimeout(() => {
      state.timedOut = true;
      state.controller.abort();
      rejectControl(deadlineError(expiryKind));
    }, remaining);
    let fetchPromise: Promise<Response>;
    try {
      fetchPromise = this.#fetch(url, init);
    } catch (error) {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      state.controller.signal.removeEventListener("abort", onControlAbort);
      throw classifyThrown(error, state, expiryKind);
    }
    try {
      const response = validateResponseMetadata(
        await Promise.race([fetchPromise, control]),
        url,
      );
      if (state.callerAborted) throw new GitHubDeviceFlowError("ABORTED");
      if (state.timedOut) throw deadlineError(expiryKind);
      if (isRateLimitedResponse(response)) fail("RATE_LIMITED", response.status);
      if (response.status >= 500) fail("NETWORK_ERROR", response.status);
      validateJsonContentType(response);
      const bytes = await readResponseBytes(response, state.controller.signal);
      if (state.callerAborted) throw new GitHubDeviceFlowError("ABORTED");
      if (state.timedOut) throw deadlineError(expiryKind);
      this.ensureDeadline(state, deadline, expiryKind);
      return { status: response.status, body: parseJson(bytes) };
    } catch (error) {
      throw classifyThrown(error, state, expiryKind);
    } finally {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      state.controller.signal.removeEventListener("abort", onControlAbort);
    }
  }

  private ensureDeadline(state: FlowState, deadline: number, kind: "timeout" | "expired"): void {
    if (state.callerAborted || state.controller.signal.aborted && !state.timedOut) throw new GitHubDeviceFlowError("ABORTED");
    if (Date.now() >= deadline) throw deadlineError(kind);
  }

  private async waitFor(
    milliseconds: number,
    deadline: number,
    state: FlowState,
    expiryKind: "timeout" | "expired",
  ): Promise<void> {
    this.ensureDeadline(state, deadline, expiryKind);
    const waitMilliseconds = Math.min(milliseconds, Math.max(1, deadline - Date.now()));
    const remainingMilliseconds = Math.max(1, deadline - Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectControl!: (error: unknown) => void;
    const control = new Promise<never>((_resolve, reject) => {
      rejectControl = reject;
    });
    const onControlAbort = (): void => rejectControl(abortError());
    state.controller.signal.addEventListener("abort", onControlAbort, { once: true });
    timer = setTimeout(() => {
      state.timedOut = true;
      state.controller.abort();
      rejectControl(deadlineError(expiryKind));
    }, remainingMilliseconds);
    try {
      await Promise.race([this.#sleep(waitMilliseconds, state.controller.signal), control]);
      this.ensureDeadline(state, deadline, expiryKind);
    } catch (error) {
      throw classifyThrown(error, state, expiryKind);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      state.controller.signal.removeEventListener("abort", onControlAbort);
    }
  }

  private async notifyVerification(
    callback: GitHubDeviceVerificationCallback,
    prompt: GitHubDeviceVerificationPrompt,
    state: FlowState,
    deadline: number,
    expiryKind: "timeout" | "expired",
  ): Promise<void> {
    this.ensureDeadline(state, deadline, expiryKind);
    const remainingMilliseconds = Math.max(1, deadline - Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectControl!: (error: unknown) => void;
    const control = new Promise<never>((_resolve, reject) => {
      rejectControl = reject;
    });
    const onControlAbort = (): void => rejectControl(abortError());
    state.controller.signal.addEventListener("abort", onControlAbort, { once: true });
    timer = setTimeout(() => {
      state.timedOut = true;
      state.controller.abort();
      rejectControl(deadlineError(expiryKind));
    }, remainingMilliseconds);
    let callbackPromise: Promise<void>;
    try {
      callbackPromise = Promise.resolve(callback(prompt));
    } catch {
      callbackPromise = Promise.reject(new GitHubDeviceFlowError("CALLBACK_FAILED"));
    }
    try {
      await Promise.race([callbackPromise, control]);
      this.ensureDeadline(state, deadline, expiryKind);
    } catch (error) {
      if (state.callerAborted) throw new GitHubDeviceFlowError("ABORTED");
      if (state.timedOut) throw deadlineError(expiryKind);
      if (error instanceof GitHubDeviceFlowError) throw error;
      throw new GitHubDeviceFlowError("CALLBACK_FAILED");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      state.controller.signal.removeEventListener("abort", onControlAbort);
    }
  }
}
