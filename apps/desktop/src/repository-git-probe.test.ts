import type {
  GitHttpRequest,
  GitHttpResponse,
  HttpClient,
} from "isomorphic-git";
import { describe, expect, it } from "vitest";
import type { VerifiedPrivateRemote } from "./repository-github";
import {
  probeRemoteMain,
} from "./repository-git-probe";
import { RepositoryGitHttpError } from "./repository-git-http";

const REMOTE: VerifiedPrivateRemote = Object.freeze({
  id: 71,
  nodeId: "R_probe_71",
  owner: "maginalia-fixture",
  name: "private-recovery",
  url: "https://github.com/maginalia-fixture/private-recovery.git",
  private: true,
});
const TOKEN = "probe-token-must-stay-in-memory";
const OID = "a".repeat(40);
const INFO_URL = `${REMOTE.url}/info/refs?service=git-upload-pack`;

function advertisement(value: unknown): unknown {
  return { capabilities: [], ...value as Record<string, unknown> };
}

function response(request: GitHttpRequest, overrides: Partial<GitHttpResponse> = {}): GitHttpResponse {
  return {
    url: request.url,
    method: request.method,
    headers: {},
    statusCode: 200,
    statusMessage: "OK",
    ...overrides,
  };
}

async function expectCode(
  action: () => Promise<unknown>,
  code: string,
): Promise<unknown> {
  let thrown: unknown;
  try {
    await action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeDefined();
  expect((thrown as { code?: string }).code).toBe(code);
  return thrown;
}

describe("read-only GitHub main remote probe", () => {
  it("uses getRemoteInfo once through the strict HTTP boundary and accepts main", async () => {
    const requests: GitHttpRequest[] = [];
    const upstream: HttpClient = {
      request: async (request) => {
        requests.push(request);
        return response(request);
      },
    };
    let authUrl: string | undefined;
    let called = 0;
    const result = await probeRemoteMain(REMOTE, TOKEN, {
      upstream,
      gitClient: {
        getRemoteInfo: async ({ http, url, onAuth }) => {
          called += 1;
          authUrl = url;
          expect(onAuth).toBeDefined();
          expect(onAuth!(url, {})).toEqual({
            username: "x-access-token",
            password: TOKEN,
          });
          await http.request({ url: INFO_URL, method: "GET", headers: {} });
          return advertisement({
            refs: {
              heads: { main: OID },
            },
            HEAD: "refs/heads/main",
          }) as never;
        },
      },
    });

    expect(result).toEqual({ remoteHead: OID });
    expect(Object.isFrozen(result)).toBe(true);
    expect(called).toBe(1);
    expect(authUrl).toBe(REMOTE.url);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(INFO_URL);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.fetchOptions).toMatchObject({ followRedirects: false });
  });

  it("accepts the actual empty runtime advertisement and an empty nested heads map", async () => {
    const empty = async (info: unknown): Promise<{ remoteHead: string | null }> => probeRemoteMain(
      REMOTE,
      TOKEN,
      { gitClient: { getRemoteInfo: async () => info as never } },
    );

    expect(await empty(advertisement({}))).toEqual({ remoteHead: null });
    expect(await empty(advertisement({ refs: { heads: {} } }))).toEqual({ remoteHead: null });
  });

  it("rejects declaration-only top-level heads instead of guessing runtime shape", async () => {
    await expectCode(
      () => probeRemoteMain(REMOTE, TOKEN, {
        gitClient: {
          getRemoteInfo: async () => advertisement({
            heads: { main: OID },
            HEAD: "refs/heads/main",
          }) as never,
        },
      }),
      "INVALID_REMOTE_STATE",
    );
  });

  it("rejects non-main branches, tags, malformed OIDs, and ambiguous HEAD state", async () => {
    const invalidAdvertisements: unknown[] = [
      advertisement({ refs: { heads: { develop: OID } } }),
      advertisement({ refs: { heads: { main: OID, develop: OID } } }),
      advertisement({ refs: { heads: { main: "A".repeat(40) } } }),
      advertisement({ refs: { heads: { main: "a".repeat(39) } } }),
      advertisement({ refs: { heads: { main: `${OID}0` } } }),
      advertisement({ refs: { heads: { main: "not-an-oid" } } }),
      advertisement({ refs: { tags: { release: OID } } }),
      advertisement({ refs: { heads: { main: OID }, tags: {} } }),
      advertisement({ refs: { heads: { main: OID }, HEAD: "refs/heads/dev" } }),
      advertisement({ refs: { heads: {}, HEAD: "refs/heads/main" } }),
      advertisement({ refs: { heads: { main: OID } }, HEAD: "refs/heads/dev" }),
      advertisement({ refs: { heads: { main: OID }, HEAD: "refs/heads/main" }, heads: { main: OID } }),
      advertisement({ HEAD: "refs/heads/main" }),
      { refs: { heads: { main: OID } } },
      null,
    ];

    for (const invalid of invalidAdvertisements) {
      await expectCode(
        () => probeRemoteMain(REMOTE, TOKEN, {
          gitClient: { getRemoteInfo: async () => invalid as never },
        }),
        "INVALID_REMOTE_STATE",
      );
    }
  });

  it("rejects a changed remote identity before any HTTP request", async () => {
    let calls = 0;
    const upstream: HttpClient = {
      request: async () => {
        calls += 1;
        throw new Error("must not be called");
      },
    };
    await expectCode(
      () => probeRemoteMain(
        { ...REMOTE, url: "https://evil.example/maginalia-fixture/private-recovery.git" },
        TOKEN,
        { upstream },
      ),
      "INVALID_REMOTE",
    );
    expect(calls).toBe(0);
  });

  it("maps provider exceptions to safe errors without copying token or URL", async () => {
    const thrown = await expectCode(
      () => probeRemoteMain(REMOTE, TOKEN, {
        gitClient: {
          getRemoteInfo: async () => {
            throw new Error(`leaked ${TOKEN} ${REMOTE.url}`);
          },
        },
      }),
      "NETWORK_ERROR",
    ) as Error;
    expect(thrown.message).not.toContain(TOKEN);
    expect(thrown.message).not.toContain(REMOTE.url);
    expect(JSON.stringify(thrown)).not.toContain(TOKEN);
  });

  it("preserves strict redirect rejection and never retries", async () => {
    const calls: GitHttpRequest[] = [];
    const upstream: HttpClient = {
      request: async (request) => {
        calls.push(request);
        return response(request, { statusCode: 302, statusMessage: "Found" });
      },
    };
    const thrown = await expectCode(
      () => probeRemoteMain(REMOTE, TOKEN, {
        upstream,
        gitClient: {
          getRemoteInfo: async ({ http }) => {
            await http.request({ url: INFO_URL, method: "GET", headers: {} });
            return advertisement({}) as never;
          },
        },
      }),
      "REDIRECT_REJECTED",
    );
    expect(thrown).toBeInstanceOf(RepositoryGitHttpError);
    expect(calls).toHaveLength(1);
  });

  it("forwards caller cancellation through the HTTP boundary", async () => {
    const controller = new AbortController();
    let resolveUpstream!: (value: GitHttpResponse) => void;
    const pendingUpstream = new Promise<GitHttpResponse>((resolve) => {
      resolveUpstream = resolve;
    });
    const pending = probeRemoteMain(REMOTE, TOKEN, {
      signal: controller.signal,
      upstream: { request: async () => pendingUpstream },
      gitClient: {
        getRemoteInfo: async ({ http }) => {
          const request = http.request({ url: INFO_URL, method: "GET", headers: {} });
          controller.abort();
          await request;
          return advertisement({}) as never;
        },
      },
    });
    await expectCode(() => pending, "ABORTED");
    resolveUpstream(response({ url: INFO_URL, method: "GET" }));
  });

  it("enforces the bounded probe timeout", async () => {
    let resolveUpstream!: (value: GitHttpResponse) => void;
    const pendingUpstream = new Promise<GitHttpResponse>((resolve) => {
      resolveUpstream = resolve;
    });
    const started = Date.now();
    await expectCode(
      () => probeRemoteMain(REMOTE, TOKEN, {
        timeoutMs: 10,
        upstream: { request: async () => pendingUpstream },
        gitClient: {
          getRemoteInfo: async ({ http }) => {
            await http.request({ url: INFO_URL, method: "GET", headers: {} });
            return advertisement({}) as never;
          },
        },
      }),
      "TIMEOUT",
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    resolveUpstream(response({ url: INFO_URL, method: "GET" }));
  });

  it("does not create an FsClient or touch local filesystem state", async () => {
    let getRemoteInfoCalls = 0;
    const result = await probeRemoteMain(REMOTE, TOKEN, {
      gitClient: {
        getRemoteInfo: async (args) => {
          getRemoteInfoCalls += 1;
          expect(Object.keys(args).sort()).toEqual(["http", "onAuth", "url"]);
          return advertisement({ refs: { heads: { main: OID } } }) as never;
        },
      },
    });
    expect(getRemoteInfoCalls).toBe(1);
    expect(result.remoteHead).toBe(OID);
  });
});
