import { describe, expect, it } from "vitest";
import {
  GITHUB_API_VERSION,
  GITHUB_REQUEST_TIMEOUT_MS,
  MAX_GITHUB_RESPONSE_BYTES,
  GitHubAdapter,
  GitHubAdapterError,
  type FetchImplementation,
  type UnverifiedPrivateCandidate,
  type VerifiedPrivateRemote,
} from "./repository-github";

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

function queuedFetch(plans: PlannedResponse[]): { fetch: FetchImplementation; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const fetch: FetchImplementation = async (url, init = {}) => {
    calls.push({ url, init });
    const plan = plans[index++];
    if (plan === undefined) throw new Error("fetch queue exhausted");
    return typeof plan === "function" ? plan(url, init) : plan;
  };
  return { fetch, calls };
}

function makeAdapter(
  operationToken: string | undefined,
  fetch: FetchImplementation,
  options: { readonly timeoutMs?: number } = {},
): GitHubAdapter {
  return new GitHubAdapter({ operationToken, fetch, ...options });
}

function restRepository(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const ownerValue = overrides.owner;
  const owner = isRecord(ownerValue) ? ownerValue : { login: "alice" };
  const name = typeof overrides.name === "string" ? overrides.name : "private-repo";
  return {
    id: 42,
    node_id: "R_kgDO42",
    name,
    owner,
    full_name: `${String(owner.login)}/${name}`,
    private: true,
    visibility: "private",
    clone_url: `https://github.com/${String(owner.login)}/${name}.git`,
    ...overrides,
  };
}

function remote(overrides: Partial<VerifiedPrivateRemote> = {}): VerifiedPrivateRemote {
  const owner = overrides.owner ?? "alice";
  const name = overrides.name ?? "private-repo";
  return {
    id: overrides.id ?? 42,
    nodeId: overrides.nodeId ?? "R_kgDO42",
    owner,
    name,
    url: overrides.url ?? `https://github.com/${owner}/${name}.git`,
    private: true,
  };
}

function graphQlResponse(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse({
    data: {
      node: {
        __typename: "Repository",
        id: "R_kgDO42",
        databaseId: 42,
        name: "private-repo",
        owner: { login: "alice" },
        isPrivate: true,
        visibility: "PRIVATE",
        ...overrides,
      },
    },
  });
}

function personalInstallation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7,
    app_id: 99,
    target_type: "User",
    account: { id: 42, login: "alice" },
    permissions: { administration: "write", contents: "write" },
    repository_selection: "selected",
    suspended_at: null,
    ...overrides,
  };
}

function installationListing(
  installations: Array<Record<string, unknown>>,
  totalCount = installations.length,
): Response {
  return jsonResponse({ total_count: totalCount, installations });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function header(init: RequestInit, name: string): string | undefined {
  const headers = init.headers as Record<string, string> | undefined;
  return headers?.[name];
}

async function failure(action: () => Promise<unknown>): Promise<GitHubAdapterError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubAdapterError);
    return error as GitHubAdapterError;
  }
  throw new Error("expected the operation to fail");
}

describe("desktop GitHub adapter", () => {
  it("uses the fixed account endpoint and safe fixed headers", async () => {
    const { fetch, calls } = queuedFetch([jsonResponse({ login: "alice", id: 42, node_id: "U_kgDO42" })]);
    const adapter = makeAdapter("secret-token", fetch);

    const result = await adapter.account();

    expect(result).toEqual({ id: 42, login: "alice", nodeId: "U_kgDO42" });
    expect(Object.isFrozen(result)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.github.com/user");
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.redirect).toBe("error");
    expect(header(calls[0].init, "Authorization")).toBe("Bearer secret-token");
    expect(header(calls[0].init, "Accept")).toBe("application/vnd.github+json");
    expect(header(calls[0].init, "X-GitHub-Api-Version")).toBe(GITHUB_API_VERSION);
  });

  it("requires a positive account id and validates an optional account node id", async () => {
    const missingId = queuedFetch([jsonResponse({ login: "alice" })]);
    const missingIdError = await failure(() => makeAdapter("secret", missingId.fetch).account());
    expect(missingIdError.code).toBe("INVALID_RESPONSE");

    const invalidNodeId = queuedFetch([jsonResponse({ login: "alice", id: 42, node_id: "not a node id" })]);
    const invalidNodeIdError = await failure(() => makeAdapter("secret", invalidNodeId.fetch).account());
    expect(invalidNodeIdError.code).toBe("INVALID_RESPONSE");
  });

  it("proves a personal installation with exact write permissions for selected or all repositories", async () => {
    for (const selection of ["selected", "all"] as const) {
      const { fetch, calls } = queuedFetch([installationListing([
        personalInstallation({
          repository_selection: selection,
        }),
      ])]);
      const result = await makeAdapter("secret-token", fetch).verifyPersonalInstallation(42);

      expect(result).toEqual({ installationId: 7, accountId: 42, appId: 99 });
      expect(Object.isFrozen(result)).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe("https://api.github.com/user/installations");
      expect(calls[0]!.init.method).toBe("GET");
      expect(calls[0]!.init.redirect).toBe("error");
      expect(header(calls[0]!.init, "Authorization")).toBe("Bearer secret-token");
      expect(header(calls[0]!.init, "Accept")).toBe("application/vnd.github+json");
      expect(calls[0]!.init.body).toBeUndefined();
    }
  });

  it("does not claim a personal installation for another account or an organization", async () => {
    const cases: Array<Record<string, unknown>> = [
      personalInstallation({ account: { id: 43, login: "someone-else" } }),
      { target_type: "Organization" },
    ];
    for (const installation of cases) {
      const { fetch, calls } = queuedFetch([installationListing([installation])]);
      const error = await failure(() => makeAdapter("secret", fetch).verifyPersonalInstallation(42));
      expect(error.code).toBe("INSTALLATION_NOT_FOUND");
      expect(calls).toHaveLength(1);
      expect(calls[0]!.init.method).toBe("GET");
    }

    const missing = queuedFetch([installationListing([])]);
    const missingError = await failure(() => makeAdapter("secret", missing.fetch).verifyPersonalInstallation(42));
    expect(missingError.code).toBe("INSTALLATION_NOT_FOUND");
  });

  it("accepts a matching installation in a bounded partial listing but blocks absent matches", async () => {
    const partialMatch = queuedFetch([installationListing([personalInstallation()], 2)]);
    await expect(makeAdapter("secret", partialMatch.fetch).verifyPersonalInstallation(42)).resolves.toEqual({
      installationId: 7,
      accountId: 42,
      appId: 99,
    });

    const partialMissing = queuedFetch([installationListing([
      personalInstallation({ account: { id: 43, login: "someone-else" } }),
    ], 2)]);
    const incompleteError = await failure(() => makeAdapter("secret", partialMissing.fetch)
      .verifyPersonalInstallation(42));
    expect(incompleteError.code).toBe("INSTALLATION_LOOKUP_INCOMPLETE");
  });

  it("distinguishes suspended, under-permissioned, and malformed installations", async () => {
    const suspended = queuedFetch([installationListing([personalInstallation({ suspended_at: "2026-09-17T00:00:00Z" })])]);
    const suspendedError = await failure(() => makeAdapter("secret", suspended.fetch).verifyPersonalInstallation(42));
    expect(suspendedError.code).toBe("INSTALLATION_SUSPENDED");

    for (const permissions of [
      { administration: "read", contents: "write" },
      { administration: "write", contents: "read" },
      { administration: "admin", contents: "write" },
    ]) {
      const underPermission = queuedFetch([installationListing([personalInstallation({ permissions })])]);
      const permissionError = await failure(() => makeAdapter("secret", underPermission.fetch)
        .verifyPersonalInstallation(42));
      expect(permissionError.code).toBe("INSTALLATION_PERMISSION_DENIED");
    }

    const malformed = queuedFetch([installationListing([personalInstallation({ permissions: undefined })])]);
    const malformedError = await failure(() => makeAdapter("secret", malformed.fetch)
      .verifyPersonalInstallation(42));
    expect(malformedError.code).toBe("INSTALLATION_LOOKUP_INCOMPLETE");

    const invalidCount = queuedFetch([installationListing([personalInstallation()], -1)]);
    const invalidCountError = await failure(() => makeAdapter("secret", invalidCount.fetch)
      .verifyPersonalInstallation(42));
    expect(invalidCountError.code).toBe("INSTALLATION_LOOKUP_INCOMPLETE");
  });

  it("rejects installation redirects and HTTP failures without any POST or fallback", async () => {
    const redirected = queuedFetch([jsonResponse({}, 302)]);
    const redirectError = await failure(() => makeAdapter("secret", redirected.fetch)
      .verifyPersonalInstallation(42));
    expect(redirectError.code).toBe("REDIRECT_REJECTED");
    expect(redirected.calls).toHaveLength(1);
    expect(redirected.calls[0]!.init.method).toBe("GET");
    expect(redirected.calls[0]!.init.redirect).toBe("error");

    const rateLimited = queuedFetch([new Response(null, { status: 429 })]);
    const rateError = await failure(() => makeAdapter("secret", rateLimited.fetch)
      .verifyPersonalInstallation(42));
    expect(rateError.code).toBe("RATE_LIMITED");
    expect(rateLimited.calls).toHaveLength(1);

    const forbidden = queuedFetch([new Response(null, { status: 403 })]);
    const forbiddenError = await failure(() => makeAdapter("secret", forbidden.fetch)
      .verifyPersonalInstallation(42));
    expect(forbiddenError.code).toBe("PERMISSION_DENIED");
    expect(forbidden.calls).toHaveLength(1);
  });

  it("validates the account ID before making an installation request", async () => {
    const { fetch, calls } = queuedFetch([]);
    const adapter = makeAdapter("secret", fetch);
    for (const accountId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const error = await failure(() => adapter.verifyPersonalInstallation(accountId));
      expect(error.code).toBe("INVALID_INPUT");
    }
    expect(calls).toHaveLength(0);
  });

  it("accepts JSON media types, rejects known non-JSON responses, and does not use unbounded fallbacks", async () => {
    const vendorJson = queuedFetch([jsonResponse({ login: "alice", id: 42 }, 200, {
      "content-type": "application/vnd.github+json; charset=utf-8",
    })]);
    await expect(makeAdapter("secret", vendorJson.fetch).account()).resolves.toEqual({ id: 42, login: "alice" });

    const plainText = queuedFetch([new Response(JSON.stringify({ login: "alice", id: 42 }), {
      status: 200,
      headers: { "content-type": "text/plain" },
    })]);
    const contentTypeError = await failure(() => makeAdapter("secret", plainText.fetch).account());
    expect(contentTypeError.code).toBe("INVALID_RESPONSE");

    let arrayBufferCalled = false;
    const responseWithoutStream = {
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      redirected: false,
      type: "basic",
      url: "",
      body: null,
      arrayBuffer: async () => {
        arrayBufferCalled = true;
        return new ArrayBuffer(0);
      },
      text: async () => {
        arrayBufferCalled = true;
        return "{}";
      },
    } as unknown as Response;
    const noFallback = queuedFetch([responseWithoutStream]);
    const fallbackError = await failure(() => makeAdapter("secret", noFallback.fetch).account());
    expect(fallbackError.code).toBe("INVALID_RESPONSE");
    expect(arrayBufferCalled).toBe(false);
  });

  it("splits private creation into an unverified candidate and an independent GET", async () => {
    const created = restRepository();
    const observed = restRepository();
    const { fetch, calls } = queuedFetch([jsonResponse(created, 201), jsonResponse(observed)]);
    const adapter = new GitHubAdapter({ operationToken: "secret-token", fetch });

    const candidate = await adapter.createPrivateCandidate("private-repo");
    expect(candidate).toEqual({
      id: 42,
      nodeId: "R_kgDO42",
      owner: "alice",
      name: "private-repo",
      url: "https://github.com/alice/private-repo.git",
    });
    expect(Object.isFrozen(candidate)).toBe(true);
    expect("private" in candidate).toBe(false);

    const verified = await adapter.verifyCreatedCandidate(candidate);
    expect(verified).toEqual({ ...candidate, private: true });
    expect(Object.isFrozen(verified)).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://api.github.com/user/repos");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.redirect).toBe("error");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      name: "private-repo",
      private: true,
      auto_init: false,
    });
    expect(calls[1].url).toBe("https://api.github.com/repos/alice/private-repo");
    expect(calls[1].init.method).toBe("GET");
    expect(calls[1].init.redirect).toBe("error");
  });

  it("requires explicit private POST/GET results and never retries or falls back", async () => {
    const publicResult = queuedFetch([jsonResponse(restRepository({ private: false, visibility: "public" }), 201)]);
    const publicError = await failure(() => makeAdapter("secret", publicResult.fetch).createPrivateCandidate("private-repo"));
    expect(publicError.code).toBe("REMOTE_NOT_PRIVATE");
    expect(publicError.creationUnknown).toBe(true);
    expect(publicResult.calls).toHaveLength(1);

    const missingPrivate = queuedFetch([jsonResponse(restRepository({ private: undefined }), 201)]);
    const missingError = await failure(() => makeAdapter("secret", missingPrivate.fetch).createPrivateCandidate("private-repo"));
    expect(missingError.code).toBe("REMOTE_NOT_PRIVATE");

    const mismatch = queuedFetch([
      jsonResponse(restRepository(), 201),
      jsonResponse(restRepository({ id: 99, node_id: "R_kgDO99" })),
    ]);
    const candidate = await makeAdapter("secret", mismatch.fetch).createPrivateCandidate("private-repo");
    const mismatchError = await failure(() => makeAdapter("secret", mismatch.fetch).verifyCreatedCandidate(candidate));
    expect(mismatchError.code).toBe("REMOTE_MISMATCH");
    expect(mismatchError.creationUnknown).toBe(false);
    expect(mismatch.calls).toHaveLength(2);
  });

  it("keeps definite create HTTP 4xx failures known while marking ambiguous responses unknown", async () => {
    const rejectedStatuses: Array<[number, string]> = [
      [401, "AUTH_REVOKED"],
      [403, "PERMISSION_DENIED"],
      [429, "RATE_LIMITED"],
      [422, "REMOTE_REQUEST_FAILED"],
    ];
    for (const [status, code] of rejectedStatuses) {
      const result = queuedFetch([jsonResponse({ message: "rejected" }, status)]);
      const error = await failure(() => makeAdapter("secret", result.fetch).createPrivateCandidate("private-repo"));
      expect(error.code).toBe(code);
      expect(error.creationUnknown).toBe(false);
      expect(result.calls).toHaveLength(1);
    }

    const serverFailure = queuedFetch([jsonResponse({ message: "uncertain" }, 500)]);
    const serverError = await failure(() => makeAdapter("secret", serverFailure.fetch).createPrivateCandidate("private-repo"));
    expect(serverError.code).toBe("REMOTE_CREATE_UNKNOWN");
    expect(serverError.creationUnknown).toBe(true);
    expect(serverFailure.calls).toHaveLength(1);

    const unexpectedSuccess = queuedFetch([jsonResponse(restRepository(), 200)]);
    const unexpectedSuccessError = await failure(() => makeAdapter("secret", unexpectedSuccess.fetch).createPrivateCandidate("private-repo"));
    expect(unexpectedSuccessError.code).toBe("REMOTE_CREATE_UNKNOWN");
    expect(unexpectedSuccessError.creationUnknown).toBe(true);

    const networkError = await failure(() => makeAdapter("secret", async () => {
      throw new Error("network failure");
    }).createPrivateCandidate("private-repo"));
    expect(networkError.code).toBe("NETWORK_ERROR");
    expect(networkError.creationUnknown).toBe(true);

    const timeout = makeAdapter("secret", async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("timed out")), { once: true });
    }), { timeoutMs: 5 });
    const timeoutError = await failure(() => timeout.createPrivateCandidate("private-repo"));
    expect(timeoutError.code).toBe("TIMEOUT");
    expect(timeoutError.creationUnknown).toBe(true);
  });

  it("matches every stable REST field during creation verification", async () => {
    const { fetch } = queuedFetch([jsonResponse(restRepository({ owner: { login: "alice" }, name: "other" }))]);
    const candidate: UnverifiedPrivateCandidate = Object.freeze({
      id: 42,
      nodeId: "R_kgDO42",
      owner: "alice",
      name: "private-repo",
      url: "https://github.com/alice/private-repo.git",
    });
    const error = await failure(() => makeAdapter("secret", fetch).verifyCreatedCandidate(candidate));
    expect(error.code).toBe("REMOTE_MISMATCH");
  });

  it("verifies GraphQL by stable node/database IDs while accepting a rename", async () => {
    const { fetch, calls } = queuedFetch([graphQlResponse({ name: "renamed-repo" })]);
    const adapter = makeAdapter("secret-token", fetch);

    const result = await adapter.verifyRemote(remote());

    expect(result).toEqual({
      id: 42,
      nodeId: "R_kgDO42",
      owner: "alice",
      name: "renamed-repo",
      url: "https://github.com/alice/renamed-repo.git",
      private: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.github.com/graphql");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.redirect).toBe("error");
    expect(JSON.parse(String(calls[0].init.body)).variables).toEqual({ nodeId: "R_kgDO42" });
  });

  it("rejects stable identity substitution and non-private GraphQL results", async () => {
    const mismatch = queuedFetch([graphQlResponse({ id: "R_kgDO99" })]);
    const mismatchError = await failure(() => makeAdapter("secret", mismatch.fetch).verifyRemote(remote()));
    expect(mismatchError.code).toBe("REMOTE_MISMATCH");

    const publicResult = queuedFetch([graphQlResponse({ isPrivate: false, visibility: "PUBLIC" })]);
    const publicError = await failure(() => makeAdapter("secret", publicResult.fetch).verifyRemote(remote()));
    expect(publicError.code).toBe("REMOTE_NOT_PRIVATE");
  });

  it("distinguishes safe auth, permission, rate-limit, and network errors without token leakage", async () => {
    const revoked = queuedFetch([jsonResponse({ message: "secret-token must not escape" }, 401)]);
    const revokedError = await failure(() => makeAdapter("secret-token", revoked.fetch).account());
    expect(revokedError.code).toBe("AUTH_REVOKED");
    expect(JSON.stringify(revokedError)).not.toContain("secret-token");
    expect(revokedError.message).not.toContain("secret-token");

    const denied = queuedFetch([jsonResponse({ message: "private response" }, 403)]);
    const deniedError = await failure(() => makeAdapter("secret-token", denied.fetch).account());
    expect(deniedError.code).toBe("PERMISSION_DENIED");

    const limited = queuedFetch([jsonResponse({ message: "rate response" }, 403, { "x-ratelimit-remaining": "0" })]);
    const limitedError = await failure(() => makeAdapter("secret-token", limited.fetch).account());
    expect(limitedError.code).toBe("RATE_LIMITED");

    const network = makeAdapter("secret-token", async () => {
      throw new Error("network body contains secret-token");
    });
    const networkError = await failure(() => network.account());
    expect(networkError.code).toBe("NETWORK_ERROR");
    expect(networkError.message).not.toContain("secret-token");
  });

  it("rejects redirects and changed response URLs before parsing", async () => {
    const redirected = queuedFetch([jsonResponse({ login: "alice" }, 302)]);
    const redirectError = await failure(() => makeAdapter("secret", redirected.fetch).account());
    expect(redirectError.code).toBe("REDIRECT_REJECTED");
    expect(redirected.calls[0].init.redirect).toBe("error");

    const createRedirect = queuedFetch([jsonResponse({}, 302)]);
    const createRedirectError = await failure(() => makeAdapter("secret", createRedirect.fetch).createPrivateCandidate("private-repo"));
    expect(createRedirectError.code).toBe("REDIRECT_REJECTED");
    expect(createRedirectError.creationUnknown).toBe(true);
    expect(createRedirect.calls).toHaveLength(1);

    const changed = queuedFetch([new Response(JSON.stringify({ login: "alice" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })]);
    const fetchWithChangedUrl: FetchImplementation = async (url, init = {}) => {
      changed.calls.push({ url, init });
      const response = new Response(JSON.stringify({ login: "alice" }), { status: 200 });
      Object.defineProperty(response, "url", { value: "https://evil.example/user" });
      return response;
    };
    const changedError = await failure(() => makeAdapter("secret", fetchWithChangedUrl).account());
    expect(changedError.code).toBe("REDIRECT_REJECTED");

    const createChanged = queuedFetch([]);
    const fetchWithCreateChangedUrl: FetchImplementation = async (url, init = {}) => {
      createChanged.calls.push({ url, init });
      const response = new Response(JSON.stringify({}), { status: 201 });
      Object.defineProperty(response, "url", { value: "https://evil.example/user/repos" });
      return response;
    };
    const createChangedError = await failure(() => makeAdapter("secret", fetchWithCreateChangedUrl).createPrivateCandidate("private-repo"));
    expect(createChangedError.code).toBe("REDIRECT_REJECTED");
    expect(createChangedError.creationUnknown).toBe(true);
    expect(createChanged.calls).toHaveLength(1);
  });

  it("honors caller abort, bounded deadlines, and the 256 KiB body limit", async () => {
    const callerController = new AbortController();
    let callerObserved = false;
    const pending = makeAdapter("secret-token", async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        callerObserved = true;
        reject(new Error("aborted secret-token"));
      }, { once: true });
    }));
    const callerPromise = failure(() => pending.account({ signal: callerController.signal }));
    callerController.abort();
    const callerError = await callerPromise;
    expect(callerObserved).toBe(true);
    expect(callerError.code).toBe("ABORTED");

    let timeoutObserved = false;
    const timeoutAdapter = makeAdapter("secret-token", async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        timeoutObserved = true;
        reject(new Error("timed out secret-token"));
      }, { once: true });
    }), { timeoutMs: 5 });
    const timeoutError = await failure(() => timeoutAdapter.account());
    expect(timeoutObserved).toBe(true);
    expect(timeoutError.code).toBe("TIMEOUT");

    const oversized = new Uint8Array(MAX_GITHUB_RESPONSE_BYTES + 1);
    const oversizedResponse = new Response(new Blob([oversized]), { status: 200 });
    const oversizedQueue = queuedFetch([oversizedResponse]);
    const oversizedError = await failure(() => makeAdapter("secret", oversizedQueue.fetch).account());
    expect(oversizedError.code).toBe("RESPONSE_TOO_LARGE");
    expect(GITHUB_REQUEST_TIMEOUT_MS).toBe(10_000);
  });

  it("clears the operation token on explicit dispose and refuses further requests", async () => {
    let calls = 0;
    const adapter = makeAdapter("secret-token", async () => {
      calls += 1;
      return jsonResponse({ login: "alice" });
    });
    adapter.dispose();
    const error = await failure(() => adapter.account());
    expect(error.code).toBe("DISPOSED");
    expect(error.message).not.toContain("secret-token");
    expect(calls).toBe(0);

    const missing = await failure(() => makeAdapter("  ", async () => jsonResponse({ login: "alice" })).account());
    expect(missing.code).toBe("AUTH_REQUIRED");
    expect(missing.tokenMissing).toBe(true);
  });

  it("rejects forged or widened DTOs before making a request", async () => {
    const { fetch, calls } = queuedFetch([]);
    const adapter = makeAdapter("secret", fetch);
    const candidate = {
      id: 42,
      nodeId: "R_kgDO42",
      owner: "alice",
      name: "private-repo",
      url: "https://github.com/alice/private-repo.git",
      private: true,
    };
    const candidateError = await failure(() => adapter.verifyCreatedCandidate(candidate as never));
    expect(candidateError.code).toBe("INVALID_INPUT");
    expect(calls).toHaveLength(0);

    const verified = remote({ url: "https://github.com/alice/private-repo.git?token=secret" });
    const verifiedError = await failure(() => adapter.verifyRemote(verified));
    expect(verifiedError.code).toBe("INVALID_INPUT");
    expect(calls).toHaveLength(0);
  });
});
