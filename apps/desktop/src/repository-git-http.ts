/**
 * Main-process-only smart-HTTP boundary for one verified private GitHub
 * remote.  This module deliberately does not fetch, push, clone, or mutate
 * a repository; it only constrains an isomorphic-git HttpClient and its
 * narrowly scoped auth callback.
 */

import nodeHttp from "isomorphic-git/http/node";
import type {
  AuthCallback,
  GitHttpRequest,
  GitHttpResponse,
  HttpClient,
} from "isomorphic-git";
import {
  parseRepositoryCloudConnection,
  RepositoryCloudConnectionError,
  serializeRepositoryCloudConnection,
  type RepositoryCloudConnection,
} from "./repository-cloud-connection";
import type { VerifiedPrivateRemote } from "./repository-github";

export const GIT_HTTP_REQUEST_TIMEOUT_MS = 10_000;
export const MAX_GIT_HTTP_REQUEST_TIMEOUT_MS = 60_000;
/**
 * Git packfiles are not API JSON.  This streaming cap is intentionally much
 * larger than the API adapter's JSON cap, while still preventing an
 * unbounded response from being consumed by the caller.
 */
export const MAX_GIT_HTTP_RESPONSE_BYTES = 64 * 1024 * 1024;

const GITHUB_WEB_ORIGIN = "https://github.com";
const ALLOWED_SERVICES = new Set(["git-upload-pack", "git-receive-pack"]);
const MAX_HTTP_URL_LENGTH = 4096;

export type RepositoryGitHttpErrorCode =
  | "INVALID_REMOTE"
  | "INVALID_REQUEST"
  | "AUTH_REQUIRED"
  | "REDIRECT_REJECTED"
  | "ABORTED"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "RESPONSE_TOO_LARGE"
  | "INVALID_RESPONSE"
  | "HTTP_ERROR";

const ERROR_MESSAGES: Readonly<Record<RepositoryGitHttpErrorCode, string>> = Object.freeze({
  INVALID_REMOTE: "The selected remote is not a verified private GitHub repository.",
  INVALID_REQUEST: "The GitHub Git request is not an allowed smart-HTTP request.",
  AUTH_REQUIRED: "GitHub authentication is required for the Git operation.",
  REDIRECT_REJECTED: "The GitHub Git request was redirected and was rejected.",
  ABORTED: "The GitHub Git request was cancelled.",
  TIMEOUT: "The GitHub Git request timed out.",
  NETWORK_ERROR: "The GitHub Git network request failed.",
  RESPONSE_TOO_LARGE: "The GitHub Git response exceeded the safety limit.",
  INVALID_RESPONSE: "The GitHub Git response was invalid.",
  HTTP_ERROR: "GitHub returned an unsuccessful Git response.",
});

export class RepositoryGitHttpError extends Error {
  public readonly code: RepositoryGitHttpErrorCode;
  public readonly status: number | undefined;
  public readonly userMessage: string;

  public constructor(code: RepositoryGitHttpErrorCode, status?: number) {
    super(ERROR_MESSAGES[code]);
    this.name = "RepositoryGitHttpError";
    this.code = code;
    this.status = status;
    this.userMessage = this.message;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function fail(code: RepositoryGitHttpErrorCode, status?: number): never {
  throw new RepositoryGitHttpError(code, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
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
    const name = error.name;
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  try {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

function isAsyncBody(value: unknown): value is AsyncIterableIterator<Uint8Array> {
  if (!isRecord(value)) return false;
  try {
    return typeof Reflect.get(value, Symbol.asyncIterator) === "function";
  } catch {
    return false;
  }
}

function normalizeRemote(value: VerifiedPrivateRemote): RepositoryCloudConnection {
  try {
    // The codec performs strict own-data-key validation and reconstructs a
    // frozen DTO, so a structurally typed or hostile object cannot smuggle a
    // different host, credentials, query, or extra fields into this boundary.
    return parseRepositoryCloudConnection(serializeRepositoryCloudConnection(value));
  } catch (error) {
    if (error instanceof RepositoryCloudConnectionError
      && error.code === "connection-too-large") {
      fail("INVALID_REMOTE");
    }
    fail("INVALID_REMOTE");
  }
}

function parseRemoteUrl(remote: RepositoryCloudConnection): URL {
  try {
    const parsed = new URL(remote.url);
    if (
      parsed.protocol !== "https:"
      || parsed.hostname !== "github.com"
      || parsed.port !== ""
      || parsed.username !== ""
      || parsed.password !== ""
      || parsed.search !== ""
      || parsed.hash !== ""
      || parsed.href !== remote.url
      || parsed.origin !== GITHUB_WEB_ORIGIN
      || parsed.pathname !== `/${remote.owner}/${remote.name}.git`
    ) {
      fail("INVALID_REMOTE");
    }
    return parsed;
  } catch (error) {
    if (error instanceof RepositoryGitHttpError) throw error;
    fail("INVALID_REMOTE");
  }
}

function normalizeMethod(method: unknown): string {
  if (method === undefined) return "GET";
  if (typeof method !== "string" || method.length > 16) fail("INVALID_REQUEST");
  if (method !== "GET" && method !== "POST") fail("INVALID_REQUEST");
  return method;
}

interface AllowedEndpoint {
  readonly url: URL;
  readonly method: "GET" | "POST";
}

function expectedService(search: string): string | undefined {
  if (!search.startsWith("?service=")) return undefined;
  const value = search.slice("?service=".length);
  if (!ALLOWED_SERVICES.has(value)) return undefined;
  // Only the one exact ASCII query is accepted.  This rejects duplicates,
  // encoded separators, alternate spellings, and unrelated parameters.
  return search === `?service=${value}` ? value : undefined;
}

function validateEndpoint(
  request: GitHttpRequest,
  remote: RepositoryCloudConnection,
): AllowedEndpoint {
  if (!isRecord(request) || typeof request.url !== "string" || request.url.length > MAX_HTTP_URL_LENGTH) {
    fail("INVALID_REQUEST");
  }
  // WHATWG URL parsing normalizes literal dot segments.  Inspect the raw
  // spelling first so a traversal-looking request cannot become an allowed
  // endpoint merely by being normalized to it.
  if (/(?:^|\/)(?:\.{1,2})(?:\/|$)/u.test(request.url) || /%2e/iu.test(request.url)) {
    fail("INVALID_REQUEST");
  }
  let parsed: URL;
  try {
    parsed = new URL(request.url);
  } catch {
    fail("INVALID_REQUEST");
  }
  if (parsed.href !== request.url) fail("INVALID_REQUEST");
  const base = parseRemoteUrl(remote);
  if (
    parsed.protocol !== "https:"
    || parsed.hostname !== "github.com"
    || parsed.port !== ""
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.hash !== ""
    || parsed.origin !== base.origin
  ) {
    fail("INVALID_REQUEST");
  }

  const infoPath = `${base.pathname}/info/refs`;
  const uploadPath = `${base.pathname}/git-upload-pack`;
  const receivePath = `${base.pathname}/git-receive-pack`;
  const method = normalizeMethod(request.method);
  if (parsed.pathname === infoPath) {
    if (method !== "GET" || expectedService(parsed.search) === undefined) fail("INVALID_REQUEST");
    return { url: parsed, method: "GET" };
  }
  if (parsed.pathname === uploadPath || parsed.pathname === receivePath) {
    if (method !== "POST" || parsed.search !== "") fail("INVALID_REQUEST");
    return { url: parsed, method: "POST" };
  }
  fail("INVALID_REQUEST");
}

function boundedTimeout(value: unknown): number {
  if (value === undefined) return GIT_HTTP_REQUEST_TIMEOUT_MS;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail("INVALID_REQUEST");
  }
  return Math.min(value, MAX_GIT_HTTP_REQUEST_TIMEOUT_MS);
}

function boundedResponseLimit(value: unknown): number {
  if (value === undefined) return MAX_GIT_HTTP_RESPONSE_BYTES;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail("INVALID_REQUEST");
  }
  return Math.min(value, MAX_GIT_HTTP_RESPONSE_BYTES);
}

interface RequestControl {
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  readonly responseLimit: number;
  readonly reason: () => "aborted" | "timeout" | undefined;
  readonly finish: () => void;
}

function startControl(request: GitHttpRequest, timeout: number, responseLimit: number): RequestControl {
  const controller = new AbortController();
  const signals: AbortSignal[] = [];
  if (isAbortSignal(request.signal)) signals.push(request.signal);
  if (isRecord(request.fetchOptions) && isAbortSignal(request.fetchOptions.signal)) {
    signals.push(request.fetchOptions.signal);
  }

  let reason: "aborted" | "timeout" | undefined;
  const listeners: Array<{ readonly signal: AbortSignal; readonly listener: () => void }> = [];
  const abort = (kind: "aborted" | "timeout"): void => {
    if (!controller.signal.aborted) {
      reason = kind;
      controller.abort();
    }
  };
  for (const signal of signals) {
    const listener = (): void => abort("aborted");
    if (signal.aborted) abort("aborted");
    else {
      signal.addEventListener("abort", listener, { once: true });
      listeners.push({ signal, listener });
    }
  }
  const timer = setTimeout(() => abort("timeout"), timeout);
  const finish = (): void => {
    clearTimeout(timer);
    for (const { signal, listener } of listeners) {
      signal.removeEventListener("abort", listener);
    }
  };
  return {
    controller,
    signal: controller.signal,
    responseLimit,
    reason: () => reason,
    finish,
  };
}

function controlError(control: RequestControl): RepositoryGitHttpError {
  return new RepositoryGitHttpError(control.reason() === "timeout" ? "TIMEOUT" : "ABORTED");
}

async function awaitWithControl<T>(
  promise: PromiseLike<T>,
  control: RequestControl,
): Promise<T> {
  if (control.signal.aborted) throw controlError(control);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      reject(controlError(control));
    };
    control.signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        control.signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        control.signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function normalizeFailure(error: unknown, control: RequestControl): RepositoryGitHttpError {
  if (error instanceof RepositoryGitHttpError) return error;
  if (control.signal.aborted) return controlError(control);
  const name = errorName(error);
  const code = errorCode(error);
  if (name === "AbortError" || code === "ABORT_ERR") return new RepositoryGitHttpError("ABORTED");
  if (name === "TimeoutError" || code === "ETIMEDOUT") return new RepositoryGitHttpError("TIMEOUT");
  return new RepositoryGitHttpError("NETWORK_ERROR");
}

async function closeBody(
  body: AsyncIterableIterator<Uint8Array> | undefined,
  control: RequestControl,
): Promise<void> {
  if (!body || typeof body.return !== "function") return;
  try {
    await awaitWithControl(body.return(), control);
  } catch {
    // The primary safe response error remains authoritative.
  }
}

async function* boundedBody(
  source: AsyncIterableIterator<Uint8Array>,
  control: RequestControl,
): AsyncGenerator<Uint8Array> {
  let iterator: AsyncIterator<Uint8Array>;
  try {
    if (!source || typeof source[Symbol.asyncIterator] !== "function") {
      fail("INVALID_RESPONSE");
    }
    iterator = source[Symbol.asyncIterator]();
    let total = 0;
    let completed = false;
    try {
      for (;;) {
        const step = await awaitWithControl(iterator.next(), control);
        if (step.done) {
          completed = true;
          return;
        }
        if (!(step.value instanceof Uint8Array)) fail("INVALID_RESPONSE");
        if (step.value.byteLength > control.responseLimit - total) {
          fail("RESPONSE_TOO_LARGE");
        }
        total += step.value.byteLength;
        yield step.value;
      }
    } finally {
      if (!completed && typeof iterator.return === "function") {
        try {
          await awaitWithControl(iterator.return(), control);
        } catch {
          // Preserve the original bounded/abort error.
        }
      }
    }
  } catch (error) {
    throw normalizeFailure(error, control);
  } finally {
    control.finish();
  }
}

function validateResponse(
  response: GitHttpResponse,
  expectedUrl: string,
): void {
  if (!isRecord(response) || typeof response.url !== "string") fail("INVALID_RESPONSE");
  if (response.url !== expectedUrl) fail("REDIRECT_REJECTED");
  if (!Number.isSafeInteger(response.statusCode) || response.statusCode < 100 || response.statusCode > 599) {
    fail("INVALID_RESPONSE");
  }
  if (response.statusCode >= 300 && response.statusCode < 400) {
    fail("REDIRECT_REJECTED", response.statusCode);
  }
  // Leave 401 available to isomorphic-git's auth challenge so its caller can
  // invoke the narrowly scoped callback and issue the one protocol retry.
  // The wrapper itself never retries.  Other unsuccessful statuses become a
  // token-free local error before isomorphic-git can expose response text.
  if (response.statusCode < 200 || response.statusCode >= 300) {
    if (response.statusCode === 401) return;
    fail("HTTP_ERROR", response.statusCode);
  }
}

export interface RepositoryGitHttpClientOptions {
  /** Inject only the isomorphic-git-compatible upstream transport in tests. */
  readonly upstream?: HttpClient;
  readonly timeoutMs?: number;
  /** A lower streaming limit is allowed; values above the hard cap are capped. */
  readonly maxResponseBytes?: number;
}

export function createRepositoryHttpClient(
  verifiedPrivateRemote: VerifiedPrivateRemote,
  options: RepositoryGitHttpClientOptions = {},
): HttpClient {
  const remote = normalizeRemote(verifiedPrivateRemote);
  parseRemoteUrl(remote);
  const upstream = options.upstream ?? nodeHttp;
  const configuredTimeout = boundedTimeout(options.timeoutMs);
  const configuredResponseLimit = boundedResponseLimit(options.maxResponseBytes);
  if (!upstream || typeof upstream.request !== "function") fail("INVALID_REQUEST");

  return {
    request: async (request: GitHttpRequest): Promise<GitHttpResponse> => {
      const endpoint = validateEndpoint(request, remote);
      const fetchOptions = isRecord(request.fetchOptions) ? request.fetchOptions : {};
      const timeout = boundedTimeout(fetchOptions.timeout ?? configuredTimeout);
      const control = startControl(request, timeout, configuredResponseLimit);
      const expectedUrl = endpoint.url.href;
      let response: GitHttpResponse | undefined;
      let responseBody: AsyncIterableIterator<Uint8Array> | undefined;
      try {
        if (control.signal.aborted) throw controlError(control);
        response = await awaitWithControl(upstream.request({
          ...request,
          url: expectedUrl,
          method: endpoint.method,
          fetchOptions: {
            followRedirects: false,
            timeout,
            signal: control.signal,
          },
          signal: control.signal,
        }), control);
        const body = response.body;
        if (body !== undefined) {
          if (!isAsyncBody(body)) fail("INVALID_RESPONSE");
          responseBody = body;
        }
        validateResponse(response, expectedUrl);
        if (body !== undefined) {
          return {
            ...response,
            url: expectedUrl,
            method: endpoint.method,
            body: boundedBody(body, control),
          };
        }
        control.finish();
        return { ...response, url: expectedUrl, method: endpoint.method };
      } catch (error) {
        await closeBody(responseBody, control);
        control.finish();
        throw normalizeFailure(error, control);
      }
    },
  };
}

/**
 * Restrict credentials to the exact verified repository base URL.  GitHub's
 * isomorphic-git callback receives the base URL even when the actual request
 * is an /info/refs or pack endpoint; every other URL is cancelled.
 */
export function createRepositoryAuthCallback(
  verifiedPrivateRemote: VerifiedPrivateRemote,
  operationToken: string,
): AuthCallback {
  const remote = normalizeRemote(verifiedPrivateRemote);
  parseRemoteUrl(remote);
  if (typeof operationToken !== "string" || operationToken.length === 0) fail("AUTH_REQUIRED");
  const expectedUrl = remote.url;
  return (url) => {
    if (typeof url !== "string" || url.length > MAX_HTTP_URL_LENGTH || url !== expectedUrl) {
      return { cancel: true };
    }
    return { username: "x-access-token", password: operationToken };
  };
}
