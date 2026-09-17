import { describe, expect, it, vi } from "vitest";
import { GITHUB_DEVICE_VERIFICATION_URI } from "../preload-api";
import type {
  RepositoryCloudDiscoveryCancelResult,
  RepositoryCloudDiscoveryIpcResult,
} from "../repository-cloud-ipc";
import {
  CloudDiscoveryController,
  type CloudDiscoveryControllerApi,
  type CloudDiscoveryState,
} from "./cloud-discovery-controller";

const FIRST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";

function works(id: string, title: string, kind: "project" | "workbench" | "shelf" = "project"): RepositoryCloudDiscoveryIpcResult {
  return {
    kind: "works",
    works: [{ id, title, kind }],
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeApi(overrides: Partial<CloudDiscoveryControllerApi> = {}): CloudDiscoveryControllerApi {
  return {
    discoverPrivateWorks: overrides.discoverPrivateWorks ?? vi.fn(async () => works(FIRST_ID, "Project")),
    cancelPrivateWorksDiscovery: overrides.cancelPrivateWorksDiscovery
      ?? vi.fn(async (): Promise<RepositoryCloudDiscoveryCancelResult> => ({ kind: "idle" })),
    onDevicePrompt: overrides.onDevicePrompt ?? vi.fn(() => () => undefined),
  };
}

function makeHarness(api: CloudDiscoveryControllerApi = makeApi()): {
  readonly controller: CloudDiscoveryController;
  readonly states: CloudDiscoveryState[];
  readonly api: CloudDiscoveryControllerApi;
} {
  const states: CloudDiscoveryState[] = [];
  const controller = new CloudDiscoveryController({
    api,
    onState: (state) => states.push(state),
  });
  return { controller, states, api };
}

describe("cloud discovery renderer controller", () => {
  it("does not authenticate at construction and starts with exact idle state", () => {
    const api = makeApi();
    const harness = makeHarness(api);

    expect(api.discoverPrivateWorks).not.toHaveBeenCalled();
    expect(api.cancelPrivateWorksDiscovery).not.toHaveBeenCalled();
    expect(api.onDevicePrompt).not.toHaveBeenCalled();
    expect(harness.controller.getState()).toEqual({
      status: "idle",
      prompt: null,
      works: [],
      error: null,
    });
    expect(Object.isFrozen(harness.controller.getState())).toBe(true);
  });

  it("shows a bounded prompt only during discovery and clears it on success", async () => {
    let promptCallback: ((prompt: unknown) => void) | undefined;
    let unsubscribeCalls = 0;
    const pending = deferred<RepositoryCloudDiscoveryIpcResult>();
    const api = makeApi({
      onDevicePrompt: (callback) => {
        promptCallback = callback as unknown as (prompt: unknown) => void;
        return () => { unsubscribeCalls += 1; };
      },
      discoverPrivateWorks: () => pending.promise,
    });
    const harness = makeHarness(api);
    const operation = harness.controller.discover();

    expect(harness.controller.getState()).toMatchObject({ status: "discovering", prompt: null, works: [] });
    promptCallback?.({ userCode: "ABCD-1234", verificationUri: GITHUB_DEVICE_VERIFICATION_URI });
    const prompted = harness.controller.getState();
    expect(prompted).toEqual({
      status: "discovering",
      prompt: { userCode: "ABCD-1234", verificationUri: GITHUB_DEVICE_VERIFICATION_URI },
      works: [],
      error: null,
    });
    expect(Object.isFrozen(prompted.prompt)).toBe(true);

    pending.resolve(works(FIRST_ID, "Project", "project"));
    await operation;
    expect(harness.controller.getState()).toEqual({
      status: "ready",
      prompt: null,
      works: [{ id: FIRST_ID, title: "Project", kind: "project" }],
      error: null,
    });
    expect(unsubscribeCalls).toBe(1);
  });

  it("accepts all three work kinds but exposes only opaque summaries", async () => {
    const api = makeApi({
      discoverPrivateWorks: vi.fn(async () => ({
        kind: "works" as const,
        works: [
          { id: FIRST_ID, title: "Project", kind: "project" },
          { id: SECOND_ID, title: "Workbench", kind: "workbench" },
          { id: "shelf-1", title: "Private Shelf", kind: "shelf" },
        ],
      } as unknown as RepositoryCloudDiscoveryIpcResult)),
    });
    const harness = makeHarness(api);
    await harness.controller.discover();

    expect(harness.controller.getState()).toEqual({
      status: "ready",
      prompt: null,
      works: [
        { id: FIRST_ID, title: "Project", kind: "project" },
        { id: SECOND_ID, title: "Workbench", kind: "workbench" },
        { id: "shelf-1", title: "Private Shelf", kind: "shelf" },
      ],
      error: null,
    });
    expect(JSON.stringify(harness.controller.getState())).not.toContain("github.com");
    expect(JSON.stringify(harness.controller.getState())).not.toContain("token");
    expect(Object.keys(harness.controller.getState().works[0]!)).toEqual(["id", "title", "kind"]);
  });

  it("ignores invalid prompts and late prompts after cancellation", async () => {
    let promptCallback: ((prompt: unknown) => void) | undefined;
    const pending = deferred<RepositoryCloudDiscoveryIpcResult>();
    const api = makeApi({
      onDevicePrompt: (callback) => {
        promptCallback = callback as unknown as (prompt: unknown) => void;
        return () => undefined;
      },
      discoverPrivateWorks: () => pending.promise,
    });
    const harness = makeHarness(api);
    const operation = harness.controller.discover();
    promptCallback?.({ userCode: "ABCD-1234", verificationUri: "https://evil.example" });
    expect(harness.controller.getState()).toEqual({
      status: "error",
      prompt: null,
      works: [],
      error: "The cloud verification prompt was invalid.",
    });
    await harness.controller.cancel();
    promptCallback?.({ userCode: "EFGH-5678", verificationUri: GITHUB_DEVICE_VERIFICATION_URI });
    expect(harness.controller.getState().prompt).toBeNull();
    pending.resolve(works(FIRST_ID, "late"));
    await operation;
    expect(harness.controller.getState().status).toBe("idle");
  });

  it("returns idle on confirmed cancellation and ignores the late result", async () => {
    const pending = deferred<RepositoryCloudDiscoveryIpcResult>();
    const unsubscribe = vi.fn();
    const cancel = vi.fn(async (): Promise<RepositoryCloudDiscoveryCancelResult> => ({ kind: "cancelled" }));
    const api = makeApi({
      discoverPrivateWorks: () => pending.promise,
      cancelPrivateWorksDiscovery: cancel,
      onDevicePrompt: () => unsubscribe,
    });
    const harness = makeHarness(api);
    const operation = harness.controller.discover();
    await harness.controller.cancel();

    expect(harness.controller.getState()).toEqual({ status: "idle", prompt: null, works: [], error: null });
    expect(cancel).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    pending.resolve(works(FIRST_ID, "late"));
    await operation;
    expect(harness.controller.getState().status).toBe("idle");
  });

  it("keeps idle while surfacing a fixed uncertain-cancellation error", async () => {
    const pending = deferred<RepositoryCloudDiscoveryIpcResult>();
    const api = makeApi({
      discoverPrivateWorks: () => pending.promise,
      cancelPrivateWorksDiscovery: async () => { throw new Error("token/path must not escape"); },
    });
    const harness = makeHarness(api);
    const operation = harness.controller.discover();
    await harness.controller.cancel();

    expect(harness.controller.getState()).toEqual({
      status: "idle",
      prompt: null,
      works: [],
      error: "Cloud discovery cancellation could not be confirmed. Try again.",
    });
    pending.resolve(works(FIRST_ID, "late"));
    await operation;
  });

  it("prevents stale completion from replacing a newer discovery", async () => {
    const first = deferred<RepositoryCloudDiscoveryIpcResult>();
    const second = deferred<RepositoryCloudDiscoveryIpcResult>();
    let calls = 0;
    const api = makeApi({
      discoverPrivateWorks: () => {
        calls += 1;
        return calls === 1 ? first.promise : second.promise;
      },
      cancelPrivateWorksDiscovery: async () => ({ kind: "cancelled" }),
    });
    const harness = makeHarness(api);
    const older = harness.controller.discover();
    await Promise.resolve();
    const newer = harness.controller.discover();
    await Promise.resolve();
    second.resolve(works(SECOND_ID, "newer"));
    await newer;
    first.resolve(works(FIRST_ID, "older"));
    await older;

    expect(harness.controller.getState()).toEqual({
      status: "ready",
      prompt: null,
      works: [{ id: SECOND_ID, title: "newer", kind: "project" }],
      error: null,
    });
  });

  it("waits for an earlier cancellation before starting a new discovery", async () => {
    const first = deferred<RepositoryCloudDiscoveryIpcResult>();
    const second = deferred<RepositoryCloudDiscoveryIpcResult>();
    const cancelDeferred = deferred<RepositoryCloudDiscoveryCancelResult>();
    const discoverCalls: number[] = [];
    const api = makeApi({
      discoverPrivateWorks: vi.fn(async () => {
        discoverCalls.push(Date.now());
        return discoverCalls.length === 1 ? first.promise : second.promise;
      }),
      cancelPrivateWorksDiscovery: () => cancelDeferred.promise,
    });
    const harness = makeHarness(api);
    const firstOperation = harness.controller.discover();
    await Promise.resolve();
    const cancelOperation = harness.controller.cancel();
    const retry = harness.controller.discover();
    await Promise.resolve();
    expect(discoverCalls).toHaveLength(1);
    cancelDeferred.resolve({ kind: "cancelled" });
    await cancelOperation;
    await Promise.resolve();
    expect(discoverCalls).toHaveLength(2);
    second.resolve(works(SECOND_ID, "newer"));
    await retry;
    first.resolve(works(FIRST_ID, "late"));
    await firstOperation;
  });

  it("rejects malformed backend results and clears prompt subscription", async () => {
    const unsubscribe = vi.fn();
    const malformed = {
      kind: "works",
      works: [{ id: FIRST_ID, title: "Project", kind: "project", remote: "secret" }],
    } as unknown as RepositoryCloudDiscoveryIpcResult;
    const api = makeApi({
      discoverPrivateWorks: async () => malformed,
      onDevicePrompt: () => unsubscribe,
    });
    const harness = makeHarness(api);
    await harness.controller.discover();

    expect(harness.controller.getState()).toEqual({
      status: "error",
      prompt: null,
      works: [],
      error: "Private cloud discovery could not be completed. Try again.",
    });
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(JSON.stringify(harness.controller.getState())).not.toContain("secret");
  });

  it("unsubscribes, cancels, and ignores results on dispose", async () => {
    const pending = deferred<RepositoryCloudDiscoveryIpcResult>();
    const unsubscribe = vi.fn();
    const cancel = vi.fn(async (): Promise<RepositoryCloudDiscoveryCancelResult> => ({ kind: "cancelled" }));
    const api = makeApi({
      discoverPrivateWorks: () => pending.promise,
      cancelPrivateWorksDiscovery: cancel,
      onDevicePrompt: () => unsubscribe,
    });
    const harness = makeHarness(api);
    const operation = harness.controller.discover();
    harness.controller.dispose();
    harness.controller.dispose();
    pending.resolve(works(FIRST_ID, "late"));
    await operation;

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(harness.controller.getState()).toEqual({ status: "idle", prompt: null, works: [], error: null });
  });
});
