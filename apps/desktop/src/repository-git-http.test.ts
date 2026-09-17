import type {
  GitHttpRequest,
  GitHttpResponse,
  HttpClient,
} from "isomorphic-git";
import { describe, expect, it } from "vitest";
import type { VerifiedPrivateRemote } from "./repository-github";
import {
  createRepositoryAuthCallback,
  createRepositoryHttpClient,
  MAX_GIT_HTTP_REQUEST_TIMEOUT_MS,
  MAX_GIT_HTTP_RESPONSE_BYTES,
  RepositoryGitHttpError,
} from "./repository-git-http";

const REMOTE: VerifiedPrivateRemote = Object.freeze({
  id: 71,
  nodeId: "R_transport_71",
  owner: "maginalia-fixture",
  name: "private-recovery",
  url: "https://github.com/maginalia-fixture/private-recovery.git",
  private: true,
});
const TOKEN = "memory-only-git-token";

async function* emptyBody(): AsyncGenerator<Uint8Array> {
  // An explicit empty body keeps the response shape identical to
  // isomorphic-git's node adapter.
}

function response(url: string, overrides: Partial<GitHttpResponse> = {}): GitHttpResponse {
  return {
    url,
    method: "GET",
    headers: {},
    body: emptyBody(),
    statusCode: 200,
    statusMessage: "OK",
    ...overrides,
  };
}

function request(url: string, method: string): GitHttpRequest {
  return { url, method, headers: {} };
}

async function expectCode(action: () => Promise<unknown>, code: string): Promise<void> {
  await expect(action()).rejects.toSatisfy((error: unknown) => {
    return error instanceof RepositoryGitHttpError && error.code === code;
  });
}

describe("repository Git smart-HTTP boundary", () => {
  it("allows only exact smart-HTTP request shapes and disables upstream redirects", async () => {
    const calls: GitHttpRequest[] = [];
    const upstream: HttpClient = {
      request: async (input) => {
        calls.push(input);
        return response(input.url, { method: input.method });
      },
    };
    const client = createRepositoryHttpClient(REMOTE, { upstream });

    const allowed = [
      request(`${REMOTE.url}/info/refs?service=git-upload-pack`, "GET"),
      request(`${REMOTE.url}/info/refs?service=git-receive-pack`, "GET"),
      request(`${REMOTE.url}/git-upload-pack`, "POST"),
      request(`${REMOTE.url}/git-receive-pack`, "POST"),
    ];
    for (const input of allowed) {
      const result = await client.request(input);
      if (result.body) {
        for await (const _chunk of result.body) {
          // Drain each bounded wrapper so its deadline/listeners are released.
        }
      }
    }

    expect(calls).toHaveLength(allowed.length);
    expect(calls.map((call) => [call.url, call.method])).toEqual([
      [allowed[0]!.url, "GET"],
      [allowed[1]!.url, "GET"],
      [allowed[2]!.url, "POST"],
      [allowed[3]!.url, "POST"],
    ]);
    for (const call of calls) {
      expect(call.fetchOptions).toMatchObject({ followRedirects: false });
      expect(call.fetchOptions.timeout).toBe(10_000);
      expect(call.fetchOptions.signal).toBeInstanceOf(AbortSignal);
      expect(call.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("rejects wrong methods, paths, traversal, ports, and non-exact queries without retrying", async () => {
    let calls = 0;
    const client = createRepositoryHttpClient(REMOTE, {
      upstream: { request: async (input) => { calls += 1; return response(input.url); } },
    });
    const rejected = [
      request(REMOTE.url, "GET"),
      request(`${REMOTE.url}/info/refs`, "GET"),
      request(`${REMOTE.url}/info/refs?service=other`, "GET"),
      request(`${REMOTE.url}/info/refs?service=git-upload-pack&extra=1`, "GET"),
      request(`${REMOTE.url}/info/refs?service=git-upload-pack&service=git-upload-pack`, "GET"),
      request(`${REMOTE.url}/info/refs?service=git%2Dupload-pack`, "GET"),
      request(`${REMOTE.url}/info/refs?service=git-upload-pack`, "POST"),
      request(`${REMOTE.url}/info/refs?service=git-upload-pack`, "get"),
      request(`${REMOTE.url}/git-upload-pack`, "GET"),
      request(`${REMOTE.url}/git-upload-pack?service=git-upload-pack`, "POST"),
      request(`${REMOTE.url}/git-receive-pack/../git-upload-pack`, "POST"),
      request(`${REMOTE.url}/git-receive-pack/%2e%2e/git-upload-pack`, "POST"),
      request("https://github.com:443/maginalia-fixture/private-recovery.git/git-upload-pack", "POST"),
      request("https://evil.example/maginalia-fixture/private-recovery.git/git-upload-pack", "POST"),
      request(`${REMOTE.url}/git-upload-pack#fragment`, "POST"),
      request(`${REMOTE.url}/git-upload-pack`, "PATCH"),
    ];
    for (const input of rejected) await expectCode(() => client.request(input), "INVALID_REQUEST");
    expect(calls).toBe(0);

    await expectCode(
      () => client.request({
        ...request("https://evil.example/maginalia-fixture/private-recovery.git/git-upload-pack", "POST"),
        headers: { Authorization: `Basic ${TOKEN}` },
      }),
      "INVALID_REQUEST",
    );
    expect(calls).toBe(0);
  });

  it("rejects unverified, credential-bearing, or non-GitHub remotes before upstream use", async () => {
    let calls = 0;
    const upstream: HttpClient = {
      request: async (input) => { calls += 1; return response(input.url); },
    };
    const variants = [
      { ...REMOTE, url: "https://github.com:443/maginalia-fixture/private-recovery.git" },
      { ...REMOTE, url: "https://user:pass@github.com/maginalia-fixture/private-recovery.git" },
      { ...REMOTE, url: "https://github.com/maginalia-fixture/private-recovery.git?token=secret" },
      { ...REMOTE, url: "https://evil.example/maginalia-fixture/private-recovery.git" },
      { ...REMOTE, private: false },
      { ...REMOTE, id: 0 },
    ];
    for (const variant of variants) {
      expect(
        () => createRepositoryHttpClient(variant as unknown as VerifiedPrivateRemote, { upstream }),
      ).toThrowError(RepositoryGitHttpError);
    }
    expect(calls).toBe(0);
  });

  it("rejects redirects, changed response URLs, and unsuccessful status without a second request", async () => {
    const calls: GitHttpRequest[] = [];
    const endpoint = `${REMOTE.url}/info/refs?service=git-upload-pack`;
    const redirect = createRepositoryHttpClient(REMOTE, {
      upstream: {
        request: async (input) => { calls.push(input); return response(input.url, { statusCode: 302, statusMessage: "Found" }); },
      },
    });
    await expectCode(() => redirect.request(request(endpoint, "GET")), "REDIRECT_REJECTED");

    const changed = createRepositoryHttpClient(REMOTE, {
      upstream: {
        request: async (input) => { calls.push(input); return response("https://github.com/other-owner/other.git/info/refs?service=git-upload-pack"); },
      },
    });
    await expectCode(() => changed.request(request(endpoint, "GET")), "REDIRECT_REJECTED");

    const unauthorized = createRepositoryHttpClient(REMOTE, {
      upstream: {
        request: async (input) => { calls.push(input); return response(input.url, { statusCode: 401, statusMessage: "Unauthorized" }); },
      },
    });
    const challenge = await unauthorized.request(request(endpoint, "GET"));
    expect(challenge.statusCode).toBe(401);
    if (challenge.body) for await (const _chunk of challenge.body) { /* drain */ }

    const denied = createRepositoryHttpClient(REMOTE, {
      upstream: {
        request: async (input) => { calls.push(input); return response(input.url, { statusCode: 403, statusMessage: "Forbidden" }); },
      },
    });
    await expectCode(() => denied.request(request(endpoint, "GET")), "HTTP_ERROR");
    expect(calls).toHaveLength(4);
  });

  it("bounds response streams and closes them on overflow", async () => {
    let returned = false;
    const body: AsyncIterableIterator<Uint8Array> = {
      next: async () => ({ done: false, value: Uint8Array.from([1, 2, 3, 4, 5]) }),
      return: async () => { returned = true; return { done: true, value: undefined as never }; },
      [Symbol.asyncIterator]() { return this; },
    };
    const endpoint = `${REMOTE.url}/info/refs?service=git-upload-pack`;
    const client = createRepositoryHttpClient(REMOTE, {
      upstream: { request: async (input) => response(input.url, { body }) },
      maxResponseBytes: 4,
    });
    const result = await client.request(request(endpoint, "GET"));
    await expectCode(async () => {
      for await (const _chunk of result.body!) {
        // The second byte-bound check throws before yielding an oversized chunk.
      }
    }, "RESPONSE_TOO_LARGE");
    expect(returned).toBe(true);
    expect(MAX_GIT_HTTP_RESPONSE_BYTES).toBeGreaterThan(4);
  });

  it("honors caller abort while an upstream request is pending", async () => {
    const controller = new AbortController();
    let resolveRequest!: (value: GitHttpResponse) => void;
    const client = createRepositoryHttpClient(REMOTE, {
      upstream: {
        request: async (input) => new Promise<GitHttpResponse>((resolve) => {
          resolveRequest = () => resolve(response(input.url));
        }),
      },
    });
    const pending = client.request({
      ...request(`${REMOTE.url}/info/refs?service=git-upload-pack`, "GET"),
      signal: controller.signal,
    });
    controller.abort();
    await expectCode(() => pending, "ABORTED");
    // Avoid an unresolved test fixture promise retaining a closure.
    resolveRequest?.(response(`${REMOTE.url}/info/refs?service=git-upload-pack`));
  });

  it("applies the default and hard timeout bounds", async () => {
    expect(MAX_GIT_HTTP_REQUEST_TIMEOUT_MS).toBe(60_000);
    let capturedTimeout = 0;
    const cappedClient = createRepositoryHttpClient(REMOTE, {
      timeoutMs: MAX_GIT_HTTP_REQUEST_TIMEOUT_MS + 10_000,
      upstream: {
        request: async (input) => {
          capturedTimeout = input.fetchOptions.timeout;
          return response(input.url);
        },
      },
    });
    const cappedResult = await cappedClient.request(request(`${REMOTE.url}/info/refs?service=git-upload-pack`, "GET"));
    if (cappedResult.body) for await (const _chunk of cappedResult.body) { /* drain */ }
    expect(capturedTimeout).toBe(MAX_GIT_HTTP_REQUEST_TIMEOUT_MS);

    const start = Date.now();
    const shortClient = createRepositoryHttpClient(REMOTE, {
      timeoutMs: 10,
      upstream: {
        request: async () => new Promise<GitHttpResponse>(() => {
          // Deliberately unresolved.
        }),
      },
    });
    await expectCode(
      () => shortClient.request(request(`${REMOTE.url}/info/refs?service=git-upload-pack`, "GET")),
      "TIMEOUT",
    );
    expect(Date.now() - start).toBeLessThan(1_000);

    const controller = new AbortController();
    controller.abort();
    const abortedClient = createRepositoryHttpClient(REMOTE, {
      timeoutMs: MAX_GIT_HTTP_REQUEST_TIMEOUT_MS,
      upstream: {
        request: async (input) => response(input.url),
      },
    });
    await expectCode(
      () => abortedClient.request({ ...request(`${REMOTE.url}/info/refs?service=git-upload-pack`, "GET"), signal: controller.signal }),
      "ABORTED",
    );
  });

  it("returns credentials only for the exact verified base and never for a wrong endpoint", async () => {
    const auth = createRepositoryAuthCallback(REMOTE, TOKEN);
    expect(auth(REMOTE.url, {})).toEqual({
      username: "x-access-token",
      password: TOKEN,
    });
    expect(auth(`${REMOTE.url}/git-upload-pack`, {})).toEqual({ cancel: true });
    expect(auth(`${REMOTE.url}?token=secret`, {})).toEqual({ cancel: true });
    expect(auth("https://evil.example/private-recovery.git", {})).toEqual({ cancel: true });
    expect(() => createRepositoryAuthCallback(REMOTE, "")).toThrowError(RepositoryGitHttpError);
    try {
      createRepositoryAuthCallback(REMOTE, "");
    } catch (error) {
      expect(String(error)).not.toContain(TOKEN);
    }
  });

  it("redacts upstream error text instead of exposing a token", async () => {
    const endpoint = `${REMOTE.url}/git-upload-pack`;
    const client = createRepositoryHttpClient(REMOTE, {
      upstream: {
        request: async () => { throw new Error(`upstream leaked ${TOKEN}`); },
      },
    });
    try {
      await client.request(request(endpoint, "POST"));
      throw new Error("expected network failure");
    } catch (error) {
      expect(error).toBeInstanceOf(RepositoryGitHttpError);
      expect((error as Error).message).not.toContain(TOKEN);
      expect((error as RepositoryGitHttpError).code).toBe("NETWORK_ERROR");
    }
  });
});
