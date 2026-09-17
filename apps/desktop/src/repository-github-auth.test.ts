import { describe, expect, it } from "vitest";
import {
  GITHUB_ACCESS_TOKEN_ENDPOINT,
  GITHUB_DEVICE_CODE_ENDPOINT,
  GITHUB_DEVICE_VERIFICATION_URI,
  MAX_GITHUB_AUTH_RESPONSE_BYTES,
  GitHubDeviceFlowAdapter,
  GitHubDeviceFlowError,
  type GitHubDeviceFlowFetch,
  type GitHubDeviceFlowSleep,
  type GitHubDeviceVerificationPrompt,
} from "./repository-github-auth";

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

type PlannedResponse = Response | ((url: string, init: RequestInit) => Response | Promise<Response>);

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function deviceResponse(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse({
    device_code: "device-code-stays-main-only",
    user_code: "WDJB-MJHT",
    verification_uri: GITHUB_DEVICE_VERIFICATION_URI,
    expires_in: 900,
    interval: 1,
    ...overrides,
  });
}

function tokenResponse(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse({
    access_token: "ghu_access-token",
    token_type: "bearer",
    scope: "",
    refresh_token: "ghr_refresh-token-must-be-discarded",
    expires_in: 28_800,
    refresh_token_expires_in: 15_897_600,
    ...overrides,
  });
}

function queuedFetch(plans: PlannedResponse[]): { fetch: GitHubDeviceFlowFetch; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const fetch: GitHubDeviceFlowFetch = async (url, init = {}) => {
    calls.push({ url, init });
    const plan = plans[index++];
    if (plan === undefined) throw new Error("fetch queue exhausted");
    return typeof plan === "function" ? plan(url, init) : plan;
  };
  return { fetch, calls };
}

function body(init: RequestInit): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(String(init.body)).entries());
}

async function failure(action: () => Promise<unknown>): Promise<GitHubDeviceFlowError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubDeviceFlowError);
    return error as GitHubDeviceFlowError;
  }
  throw new Error("expected the operation to fail");
}

function request(onVerification: (prompt: GitHubDeviceVerificationPrompt) => void | Promise<void>): {
  readonly clientId: string;
  readonly signal: AbortSignal;
  readonly onVerification: typeof onVerification;
} {
  return {
    clientId: "Iv23-test-client-id",
    signal: new AbortController().signal,
    onVerification,
  };
}

describe("GitHub App Device Flow adapter", () => {
  it("starts with only the injected client ID, reports no device code, polls at interval/slow_down, and returns only the access token", async () => {
    const { fetch, calls } = queuedFetch([
      deviceResponse(),
      jsonResponse({ error: "authorization_pending" }),
      jsonResponse({ error: "slow_down" }),
      tokenResponse(),
    ]);
    const delays: number[] = [];
    const sleep: GitHubDeviceFlowSleep = async (milliseconds) => {
      delays.push(milliseconds);
    };
    const prompts: GitHubDeviceVerificationPrompt[] = [];
    const adapter = new GitHubDeviceFlowAdapter({ fetch, sleep });
    const operation = request((prompt) => {
      prompts.push(prompt);
    });

    // Importing/constructing the adapter does not start an HTTP operation.
    expect(calls).toHaveLength(0);
    const accessToken = await adapter.authorize(operation);

    expect(accessToken).toBe("ghu_access-token");
    expect(prompts).toEqual([{
      userCode: "WDJB-MJHT",
      verificationUri: GITHUB_DEVICE_VERIFICATION_URI,
    }]);
    expect(Object.isFrozen(prompts[0])).toBe(true);
    expect("deviceCode" in prompts[0]!).toBe(false);
    expect(JSON.stringify(prompts[0])).not.toContain("device-code-stays-main-only");
    expect(delays).toEqual([1_000, 1_000, 6_000]);

    expect(calls).toHaveLength(4);
    expect(calls[0]!.url).toBe(GITHUB_DEVICE_CODE_ENDPOINT);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.redirect).toBe("error");
    expect(calls[0]!.init.headers).toEqual({
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    });
    expect(body(calls[0]!.init)).toEqual({ client_id: "Iv23-test-client-id" });
    expect(body(calls[0]!.init)).not.toHaveProperty("scope");
    expect(body(calls[0]!.init)).not.toHaveProperty("client_secret");

    expect(calls[1]!.url).toBe(GITHUB_ACCESS_TOKEN_ENDPOINT);
    expect(calls[1]!.init.method).toBe("POST");
    expect(body(calls[1]!.init)).toEqual({
      client_id: "Iv23-test-client-id",
      device_code: "device-code-stays-main-only",
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    expect(String(accessToken)).not.toContain("ghr_refresh-token");
  });

  it("requires bearer token responses and accepts GitHub App's empty scope while discarding refresh tokens", async () => {
    const missingType = queuedFetch([deviceResponse({ interval: 1 }), tokenResponse({ token_type: undefined })]);
    const missingTypeError = await failure(() => new GitHubDeviceFlowAdapter({
      fetch: missingType.fetch,
      sleep: async () => undefined,
    }).authorize(request(() => undefined)));
    expect(missingTypeError.code).toBe("INVALID_RESPONSE");

    const wrongType = queuedFetch([deviceResponse({ interval: 1 }), tokenResponse({ token_type: "basic" })]);
    const wrongTypeError = await failure(() => new GitHubDeviceFlowAdapter({
      fetch: wrongType.fetch,
      sleep: async () => undefined,
    }).authorize(request(() => undefined)));
    expect(wrongTypeError.code).toBe("INVALID_RESPONSE");

    const widenedScope = queuedFetch([deviceResponse({ interval: 1 }), tokenResponse({ scope: "repo" })]);
    const widenedScopeError = await failure(() => new GitHubDeviceFlowAdapter({
      fetch: widenedScope.fetch,
      sleep: async () => undefined,
    }).authorize(request(() => undefined)));
    expect(widenedScopeError.code).toBe("INVALID_RESPONSE");

    const success = queuedFetch([deviceResponse({ interval: 1 }), tokenResponse({ refresh_token: "secret-refresh" })]);
    const result = await new GitHubDeviceFlowAdapter({
      fetch: success.fetch,
      sleep: async () => undefined,
    }).authorize(request(() => undefined));
    expect(result).toBe("ghu_access-token");
    expect(JSON.stringify(result)).not.toContain("secret-refresh");
  });

  it("classifies consent denial and code expiry without exposing provider details", async () => {
    const denied = queuedFetch([
      deviceResponse(),
      jsonResponse({ error: "access_denied", error_description: "ghu_secret-token" }),
    ]);
    const deniedError = await failure(() => new GitHubDeviceFlowAdapter({
      fetch: denied.fetch,
      sleep: async () => undefined,
    }).authorize(request(() => undefined)));
    expect(deniedError.code).toBe("AUTHORIZATION_DENIED");
    expect(deniedError.message).not.toContain("ghu_secret-token");
    expect(JSON.stringify(deniedError)).not.toContain("ghu_secret-token");

    const expired = queuedFetch([
      deviceResponse(),
      jsonResponse({ error: "expired_token" }),
    ]);
    const expiredError = await failure(() => new GitHubDeviceFlowAdapter({
      fetch: expired.fetch,
      sleep: async () => undefined,
    }).authorize(request(() => undefined)));
    expect(expiredError.code).toBe("DEVICE_CODE_EXPIRED");
  });

  it("rejects redirects, changed URLs, and known non-JSON responses before accepting a body", async () => {
    const redirected = queuedFetch([new Response(null, { status: 302 })]);
    const redirectError = await failure(() => new GitHubDeviceFlowAdapter({ fetch: redirected.fetch })
      .authorize(request(() => undefined)));
    expect(redirectError.code).toBe("REDIRECT_REJECTED");
    expect(redirected.calls[0]!.init.redirect).toBe("error");

    const changed = queuedFetch([new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    })]);
    const changedFetch: GitHubDeviceFlowFetch = async (url, init = {}) => {
      changed.calls.push({ url, init });
      const response = jsonResponse({});
      Object.defineProperty(response, "url", { value: "https://evil.example/device/code" });
      return response;
    };
    const changedError = await failure(() => new GitHubDeviceFlowAdapter({ fetch: changedFetch })
      .authorize(request(() => undefined)));
    expect(changedError.code).toBe("REDIRECT_REJECTED");

    const nonJson = queuedFetch([new Response("not-json", {
      status: 200,
      headers: { "content-type": "text/plain" },
    })]);
    const nonJsonError = await failure(() => new GitHubDeviceFlowAdapter({ fetch: nonJson.fetch })
      .authorize(request(() => undefined)));
    expect(nonJsonError.code).toBe("INVALID_RESPONSE");
  });

  it("stops on rate/network failures and enforces the bounded response size", async () => {
    const rate = queuedFetch([new Response(null, { status: 429 })]);
    const rateError = await failure(() => new GitHubDeviceFlowAdapter({ fetch: rate.fetch })
      .authorize(request(() => undefined)));
    expect(rateError.code).toBe("RATE_LIMITED");

    const serverFailure = queuedFetch([new Response(null, { status: 503 })]);
    const serverError = await failure(() => new GitHubDeviceFlowAdapter({ fetch: serverFailure.fetch })
      .authorize(request(() => undefined)));
    expect(serverError.code).toBe("NETWORK_ERROR");

    const network = await failure(() => new GitHubDeviceFlowAdapter({
      fetch: async () => {
        throw new Error("network contains ghu_secret-token");
      },
    }).authorize(request(() => undefined)));
    expect(network.code).toBe("NETWORK_ERROR");
    expect(network.message).not.toContain("ghu_secret-token");

    const oversized = new Uint8Array(MAX_GITHUB_AUTH_RESPONSE_BYTES + 1);
    const tooLarge = queuedFetch([
      deviceResponse(),
      new Response(new Blob([oversized]), { status: 200 }),
    ]);
    const tooLargeError = await failure(() => new GitHubDeviceFlowAdapter({
      fetch: tooLarge.fetch,
      sleep: async () => undefined,
    }).authorize(request(() => undefined)));
    expect(tooLargeError.code).toBe("RESPONSE_TOO_LARGE");
  });

  it("honors caller abort and a bounded total deadline while aborting the underlying request", async () => {
    const abortController = new AbortController();
    let abortObserved = false;
    const abortPromise = failure(() => new GitHubDeviceFlowAdapter({
      fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          abortObserved = true;
          reject(new Error("aborted ghu_secret-token"));
        }, { once: true });
      }),
    }).authorize({
      clientId: "Iv23-test-client-id",
      signal: abortController.signal,
      onVerification: () => undefined,
    }));
    abortController.abort();
    const abortError = await abortPromise;
    expect(abortError.code).toBe("ABORTED");
    expect(abortObserved).toBe(true);

    let timeoutObserved = false;
    const timeoutError = await failure(() => new GitHubDeviceFlowAdapter({
      timeoutMs: 5,
      fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          timeoutObserved = true;
          reject(new Error("timed out ghu_secret-token"));
        }, { once: true });
      }),
    }).authorize(request(() => undefined)));
    expect(timeoutError.code).toBe("TIMEOUT");
    expect(timeoutObserved).toBe(true);
  });

  it("cancels a response body when the caller aborts during bounded reading", async () => {
    const abortController = new AbortController();
    let bodyReadStarted = false;
    let bodyCancelled = false;
    let notifyReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      notifyReadStarted = resolve;
    });
    let releasePendingRead: (() => void) | undefined;
    const bodyReader = {
      read: (): Promise<ReadableStreamReadResult<Uint8Array>> => {
        bodyReadStarted = true;
        notifyReadStarted();
        return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
          releasePendingRead = () => resolve({ done: true, value: undefined });
        });
      },
      cancel: async (): Promise<void> => {
        bodyCancelled = true;
        releasePendingRead?.();
      },
      releaseLock: (): void => undefined,
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    const body = {
      getReader: (): ReadableStreamDefaultReader<Uint8Array> => bodyReader,
    } as unknown as ReadableStream<Uint8Array>;
    const hangingResponse = {
      status: 200,
      redirected: false,
      type: "basic",
      url: "",
      headers: new Headers({ "content-type": "application/json" }),
      body,
    } as unknown as Response;
    let calls = 0;
    const operation = new GitHubDeviceFlowAdapter({
      fetch: async () => {
        calls += 1;
        if (calls === 1) return hangingResponse;
        throw new Error("poll should not start after abort");
      },
      sleep: async () => undefined,
    }).authorize({
      clientId: "Iv23-test-client-id",
      signal: abortController.signal,
      onVerification: () => undefined,
    });
    await readStarted;
    abortController.abort();
    const error = await failure(() => operation);

    expect(error.code).toBe("ABORTED");
    expect(bodyReadStarted).toBe(true);
    expect(bodyCancelled).toBe(true);
    expect(calls).toBe(1);
  });

  it("does not start with invalid or pre-aborted caller input", async () => {
    let calls = 0;
    const adapter = new GitHubDeviceFlowAdapter({ fetch: async () => {
      calls += 1;
      return deviceResponse();
    } });
    const invalidClient = await failure(() => adapter.authorize({
      clientId: "",
      signal: new AbortController().signal,
      onVerification: () => undefined,
    }));
    expect(invalidClient.code).toBe("INVALID_INPUT");
    const controller = new AbortController();
    controller.abort();
    const aborted = await failure(() => adapter.authorize({
      clientId: "Iv23-test-client-id",
      signal: controller.signal,
      onVerification: () => undefined,
    }));
    expect(aborted.code).toBe("ABORTED");
    expect(calls).toBe(0);
  });
});
