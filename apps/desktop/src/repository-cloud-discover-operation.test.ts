import { describe, expect, it } from "vitest";
import {
  GITHUB_DEVICE_VERIFICATION_URI,
  GitHubDeviceFlowError,
  type GitHubDeviceFlowRequest,
} from "./repository-github-auth.js";
import {
  GITHUB_APP_CLIENT_ID,
} from "./repository-cloud-config.js";
import {
  RestoreDiscoveryOperationError,
  discoverAuthenticatedRestoreRepositories,
  type AuthenticatedRestoreDiscoveryDependencies,
  type RestoreDiscoveryAuthorizer,
  type RestoreDiscoveryProvider,
} from "./repository-cloud-discover-operation.js";

const TOKEN = "secret-operation-token";

async function expectCode(
  action: () => Promise<unknown>,
  code: RestoreDiscoveryOperationError["code"],
): Promise<RestoreDiscoveryOperationError> {
  let thrown: unknown;
  try {
    await action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RestoreDiscoveryOperationError);
  expect((thrown as RestoreDiscoveryOperationError).code).toBe(code);
  return thrown as RestoreDiscoveryOperationError;
}

function makeAuth(
  events: string[],
  implementation?: (request: GitHubDeviceFlowRequest) => Promise<string>,
): RestoreDiscoveryAuthorizer {
  return {
    authorize: async (request) => {
      events.push("auth");
      if (implementation) return implementation(request);
      return TOKEN;
    },
  };
}

function makeProvider(
  events: string[],
  overrides: Partial<RestoreDiscoveryProvider> = {},
): RestoreDiscoveryProvider {
  return {
    account: async () => {
      events.push("account");
      return { id: 42, login: "alice" };
    },
    listPrivateRepositoryCandidates: async (accountId) => {
      events.push(`list:${accountId}`);
      return { kind: "empty" };
    },
    readRestoreCandidateIdentity: async () => {
      throw new Error("read should not be called for an empty result");
    },
    dispose: () => {
      events.push("dispose");
    },
    ...overrides,
  };
}

function dependencies(
  auth: RestoreDiscoveryAuthorizer,
  provider: RestoreDiscoveryProvider,
): AuthenticatedRestoreDiscoveryDependencies {
  return { auth, createProvider: () => provider };
}

describe("authenticated main-only Restore discovery", () => {
  it("orders prompt, account binding, bounded discovery, and disposal without returning the token", async () => {
    const events: string[] = [];
    let receivedToken: string | undefined;
    let prompt: { readonly userCode: string; readonly verificationUri: string } | undefined;
    const controller = new AbortController();
    const auth = makeAuth(events, async (request) => {
      expect(request.clientId).toBe(GITHUB_APP_CLIENT_ID);
      expect(request.signal).toBe(controller.signal);
      request.onVerification({ userCode: "ABCD-1234", verificationUri: GITHUB_DEVICE_VERIFICATION_URI });
      return TOKEN;
    });
    const provider = makeProvider(events);
    const deps = {
      auth,
      createProvider: (token: string) => {
        receivedToken = token;
        events.push("provider");
        return provider;
      },
    } satisfies AuthenticatedRestoreDiscoveryDependencies;

    const result = await discoverAuthenticatedRestoreRepositories({
      signal: controller.signal,
      onVerification: (value) => {
        events.push("prompt");
        prompt = value;
      },
    }, deps);

    expect(result).toEqual({ kind: "empty" });
    expect(events).toEqual(["auth", "prompt", "provider", "account", "list:42", "dispose"]);
    expect(prompt).toEqual({ userCode: "ABCD-1234", verificationUri: GITHUB_DEVICE_VERIFICATION_URI });
    expect(receivedToken).toBe(TOKEN);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("does not start auth or fetch an account after caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    let authCalls = 0;
    let providerCalls = 0;
    const auth = makeAuth([], async () => {
      authCalls += 1;
      return TOKEN;
    });
    const error = await expectCode(
      () => discoverAuthenticatedRestoreRepositories({
        signal: controller.signal,
        onVerification: () => undefined,
      }, {
        auth,
        createProvider: () => {
          providerCalls += 1;
          return makeProvider([]);
        },
      }),
      "ABORTED",
    );
    expect(error.message).not.toContain(TOKEN);
    expect(authCalls).toBe(0);
    expect(providerCalls).toBe(0);
  });

  it("stops before provider/account binding if cancellation races auth completion", async () => {
    const controller = new AbortController();
    let providerCalls = 0;
    const auth = makeAuth([], async () => {
      controller.abort();
      return TOKEN;
    });
    const error = await expectCode(
      () => discoverAuthenticatedRestoreRepositories({
        signal: controller.signal,
        onVerification: () => undefined,
      }, {
        auth,
        createProvider: () => {
          providerCalls += 1;
          return makeProvider([]);
        },
      }),
      "ABORTED",
    );
    expect(error.message).not.toContain(TOKEN);
    expect(providerCalls).toBe(0);
  });

  it("stops after auth denial without constructing or disposing a provider", async () => {
    const events: string[] = [];
    let providerCalls = 0;
    const auth = makeAuth(events, async () => {
      throw new GitHubDeviceFlowError("AUTHORIZATION_DENIED");
    });
    const error = await expectCode(
      () => discoverAuthenticatedRestoreRepositories({
        signal: new AbortController().signal,
        onVerification: () => undefined,
      }, {
        auth,
        createProvider: () => {
          providerCalls += 1;
          return makeProvider(events);
        },
      }),
      "AUTH_FAILED",
    );
    expect(error.message).not.toContain(TOKEN);
    expect(events).toEqual(["auth"]);
    expect(providerCalls).toBe(0);
  });

  it("disposes the provider and returns a fixed account failure on provider errors", async () => {
    const events: string[] = [];
    let disposed = 0;
    const provider = makeProvider(events, {
      account: async () => {
        events.push("account");
        throw new Error(`provider leaked ${TOKEN}`);
      },
      dispose: () => {
        disposed += 1;
        events.push("dispose");
      },
    });
    const error = await expectCode(
      () => discoverAuthenticatedRestoreRepositories({
        signal: new AbortController().signal,
        onVerification: () => undefined,
      }, dependencies(makeAuth(events), provider)),
      "ACCOUNT_FAILED",
    );
    expect(error.message).not.toContain(TOKEN);
    expect(events).toEqual(["auth", "account", "dispose"]);
    expect(disposed).toBe(1);
  });

  it("disposes the provider on discovery failure and never returns raw provider errors", async () => {
    const events: string[] = [];
    let disposed = 0;
    const provider = makeProvider(events, {
      listPrivateRepositoryCandidates: async () => {
        events.push("list:42");
        throw new Error(`discovery leaked ${TOKEN}`);
      },
      dispose: () => {
        disposed += 1;
        events.push("dispose");
      },
    });
    const error = await expectCode(
      () => discoverAuthenticatedRestoreRepositories({
        signal: new AbortController().signal,
        onVerification: () => undefined,
      }, dependencies(makeAuth(events), provider)),
      "DISCOVERY_FAILED",
    );
    expect(error.message).not.toContain(TOKEN);
    expect(events).toEqual(["auth", "account", "list:42", "dispose"]);
    expect(disposed).toBe(1);
  });

  it("maps a disposal failure to a fixed outcome after an otherwise successful read", async () => {
    const events: string[] = [];
    const provider = makeProvider(events, {
      dispose: () => {
        events.push("dispose");
        throw new Error(`dispose leaked ${TOKEN}`);
      },
    });
    const error = await expectCode(
      () => discoverAuthenticatedRestoreRepositories({
        signal: new AbortController().signal,
        onVerification: () => undefined,
      }, dependencies(makeAuth(events), provider)),
      "DISPOSE_FAILED",
    );
    expect(error.message).not.toContain(TOKEN);
    expect(events).toEqual(["auth", "account", "list:42", "dispose"]);
  });
});
