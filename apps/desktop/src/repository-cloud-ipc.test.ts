import { describe, expect, it, vi } from "vitest";
import { createIdentity } from "@maginalia/repository-core";
import {
  createRepositoryCloudDiscoveryCancellationHandlers,
  createRepositoryCloudDiscoveryHandlers,
  CANCEL_PRIVATE_WORKS_DISCOVERY_CHANNEL,
  DISCOVER_PRIVATE_WORKS_CHANNEL,
  type RepositoryCloudDiscoveryIpcDependencies,
} from "./repository-cloud-ipc";
import { RepositoryCloudRestoreCatalog } from "./repository-cloud-restore-catalog";

const WORK_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN_MARKER = "secret-token-marker";
const PATH_MARKER = "C:\\private\\repository";

function result(index = 1) {
  const identity = createIdentity("project", `Project ${index}`, `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`);
  return {
    kind: "candidates" as const,
    candidates: [{
      identity,
      remote: {
        id: index,
        nodeId: `MDQ6UmVwb3NpdG9yeT${index}`,
        owner: "alice",
        name: `private-${index}`,
        url: `https://github.com/alice/private-${index}.git`,
        private: true as const,
      },
    }],
  };
}

function makeDependencies(
  catalog: RepositoryCloudDiscoveryIpcDependencies["catalog"],
  discover: RepositoryCloudDiscoveryIpcDependencies["discover"],
  createVerificationCallback: RepositoryCloudDiscoveryIpcDependencies["createVerificationCallback"] = () => () => undefined,
): RepositoryCloudDiscoveryIpcDependencies {
  return {
    catalog,
    discover,
    createVerificationCallback,
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

describe("repository cloud discovery IPC boundary", () => {
  it("returns a frozen opaque works list and passes owner/prompt callback to discovery", async () => {
    const owner = {};
    const callback = vi.fn();
    const catalog = new RepositoryCloudRestoreCatalog({ idFactory: () => WORK_ID });
    let receivedOwner: object | undefined;
    let receivedCallback: unknown;
    const createVerificationCallback = vi.fn((callbackOwner: object) => {
      expect(callbackOwner).toBe(owner);
      return callback;
    });
    const dependencies = makeDependencies(catalog, async (operationOwner, onVerification) => {
      receivedOwner = operationOwner;
      receivedCallback = onVerification;
      onVerification({ userCode: "ABCD-1234", verificationUri: "https://github.com/login/device" });
      return result();
    }, createVerificationCallback);
    const handlers = createRepositoryCloudDiscoveryHandlers(dependencies);

    const value = await handlers.discoverPrivateWorks({ sender: owner });

    expect(value).toEqual({
      kind: "works",
      works: [{ id: WORK_ID, title: "Project 1", kind: "project" }],
    });
    expect(Object.isFrozen(value)).toBe(true);
    if (value.kind === "works") {
      expect(Object.isFrozen(value.works)).toBe(true);
      expect(Object.keys(value.works[0]!)).toEqual(["id", "title", "kind"]);
      expect(JSON.stringify(value)).not.toContain("github.com");
      expect(JSON.stringify(value)).not.toContain(".git");
      expect(JSON.stringify(value)).not.toContain(TOKEN_MARKER);
      expect(JSON.stringify(value)).not.toContain(PATH_MARKER);
    }
    expect(receivedOwner).toBe(owner);
    expect(receivedCallback).toBe(callback);
    expect(createVerificationCallback).toHaveBeenCalledWith(owner);
    expect(callback).toHaveBeenCalledWith({
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
    });
    expect(DISCOVER_PRIVATE_WORKS_CHANNEL).toBe("maginalia:discover-private-works");
  });

  it("returns scoped empty semantics without exposing provider data", async () => {
    const catalog = new RepositoryCloudRestoreCatalog();
    const discover = vi.fn(async () => ({ kind: "empty" as const }));
    const handlers = createRepositoryCloudDiscoveryHandlers(makeDependencies(catalog, discover));

    const value = await handlers.discoverPrivateWorks({ sender: {} });

    expect(value).toEqual({ kind: "works", works: [] });
    expect(discover).toHaveBeenCalledOnce();
  });

  it("accepts no renderer arguments and validates the event sender before clearing or discovering", async () => {
    let cleared = 0;
    let discovered = 0;
    const catalog = {
      clearForOwner: () => { cleared += 1; },
      registerForOwner: () => [],
    } as unknown as RepositoryCloudRestoreCatalog;
    const handlers = createRepositoryCloudDiscoveryHandlers(makeDependencies(catalog, async () => {
      discovered += 1;
      return { kind: "empty" as const };
    }));

    expect(await handlers.discoverPrivateWorks({ sender: {} }, { path: PATH_MARKER })).toEqual({
      kind: "error",
      code: "invalid-request",
      message: "The cloud discovery request was invalid.",
    });
    expect(await handlers.discoverPrivateWorks(null as never)).toMatchObject({ kind: "error", code: "invalid-request" });
    expect(cleared).toBe(0);
    expect(discovered).toBe(0);
  });

  it("keeps selections owner-bound", async () => {
    let next = 0;
    const catalog = new RepositoryCloudRestoreCatalog({
      idFactory: () => (++next === 1 ? WORK_ID : "22222222-2222-4222-8222-222222222222"),
    });
    const handlers = createRepositoryCloudDiscoveryHandlers(makeDependencies(catalog, async (_owner) => result()));
    const first = await handlers.discoverPrivateWorks({ sender: {} });
    const secondOwner = {};
    const second = await handlers.discoverPrivateWorks({ sender: secondOwner });
    expect(first.kind).toBe("works");
    expect(second.kind).toBe("works");
    if (first.kind === "works") {
      expect(second.kind === "works" && second.works[0]!.id).not.toBe(first.works[0]!.id);
      expectCatalogNotOwned(catalog, secondOwner, first.works[0]!.id);
    }
  });

  it("does not let an older completion repopulate after a newer success", async () => {
    const owner = {};
    const catalog = new RepositoryCloudRestoreCatalog({
      idFactory: () => "11111111-1111-4111-8111-111111111111",
    });
    const first = deferred<ReturnType<typeof result>>();
    const second = deferred<ReturnType<typeof result>>();
    let call = 0;
    const handlers = createRepositoryCloudDiscoveryHandlers(makeDependencies(catalog, async () => {
      call += 1;
      return call === 1 ? first.promise : second.promise;
    }));

    const firstCall = handlers.discoverPrivateWorks({ sender: owner });
    const secondCall = handlers.discoverPrivateWorks({ sender: owner });
    second.resolve(result(2));
    const newest = await secondCall;
    expect(newest).toMatchObject({ kind: "works", works: [{ title: "Project 2" }] });
    first.resolve(result(1));
    expect(await firstCall).toMatchObject({ kind: "error", code: "discovery-failed" });
    if (newest.kind === "works") {
      expect(catalog.resolveForOwner(owner, newest.works[0]!.id).identity.title).toBe("Project 2");
    }
  });

  it("keeps an older completion blocked after a newer failed retry", async () => {
    const owner = {};
    const catalog = new RepositoryCloudRestoreCatalog({
      idFactory: () => "11111111-1111-4111-8111-111111111111",
    });
    let call = 0;
    const first = deferred<ReturnType<typeof result>>();
    const second = deferred<ReturnType<typeof result>>();
    const handlers = createRepositoryCloudDiscoveryHandlers(makeDependencies(catalog, async () => {
      call += 1;
      if (call === 1) return result();
      return call === 2 ? first.promise : second.promise;
    }));
    const initial = await handlers.discoverPrivateWorks({ sender: owner });
    expect(initial.kind).toBe("works");
    if (initial.kind !== "works") throw new Error("expected initial discovery");

    const olderCall = handlers.discoverPrivateWorks({ sender: owner });
    const newerCall = handlers.discoverPrivateWorks({ sender: owner });
    second.reject(new Error(`raw ${TOKEN_MARKER} ${PATH_MARKER}`));
    expect(await newerCall).toMatchObject({ kind: "error", code: "discovery-failed" });
    first.resolve(result(2));
    expect(await olderCall).toMatchObject({ kind: "error", code: "discovery-failed" });
    expect(() => catalog.resolveForOwner(owner, initial.works[0]!.id)).toThrowError(/no longer available/);
  });

  it("clears stale selections before a failed discovery attempt", async () => {
    const owner = {};
    let attempt = 0;
    const catalog = new RepositoryCloudRestoreCatalog({ idFactory: () => WORK_ID });
    const events: string[] = [];
    const originalClear = catalog.clearForOwner.bind(catalog);
    const wrappedCatalog = {
      clearForOwner: (value: object) => {
        events.push("clear");
        originalClear(value);
      },
      registerForOwner: catalog.registerForOwner.bind(catalog),
    } as const;
    const dependencies = makeDependencies(wrappedCatalog, async () => {
      events.push("discover");
      if (attempt++ > 0) throw new Error(`raw ${TOKEN_MARKER} ${PATH_MARKER}`);
      return result();
    });
    const handlers = createRepositoryCloudDiscoveryHandlers(dependencies);
    const first = await handlers.discoverPrivateWorks({ sender: owner });
    expect(first.kind).toBe("works");
    if (first.kind !== "works") throw new Error("expected first discovery");

    const failed = await handlers.discoverPrivateWorks({ sender: owner });
    expect(failed).toEqual({
      kind: "error",
      code: "discovery-failed",
      message: "Private cloud discovery could not be completed safely.",
    });
    expect(events).toEqual(["clear", "discover", "clear", "discover"]);
    expect(() => catalog.resolveForOwner(owner, first.works[0]!.id)).toThrowError(/no longer available/);
    expect(JSON.stringify(failed)).not.toContain(TOKEN_MARKER);
    expect(JSON.stringify(failed)).not.toContain(PATH_MARKER);
  });

  it("maps catalog failures to fixed errors without leaking provider values", async () => {
    const catalog = {
      clearForOwner: () => undefined,
      registerForOwner: () => { throw new Error(`catalog ${TOKEN_MARKER} ${PATH_MARKER}`); },
    } as unknown as RepositoryCloudRestoreCatalog;
    const handlers = createRepositoryCloudDiscoveryHandlers(makeDependencies(catalog, async () => result()));

    const value = await handlers.discoverPrivateWorks({ sender: {} });

    expect(value).toEqual({
      kind: "error",
      code: "catalog-failed",
      message: "The private cloud discovery selection could not be retained safely.",
    });
    expect(JSON.stringify(value)).not.toContain(TOKEN_MARKER);
    expect(JSON.stringify(value)).not.toContain(PATH_MARKER);
  });

  it("cancels only the current owner, accepts no arguments, and is idempotent", () => {
    const owner = {};
    const otherOwner = {};
    const controller = new AbortController();
    const activeOwners = new Set<object>([owner]);
    const cancelForOwner = vi.fn((value: object) => {
      if (!activeOwners.delete(value)) return false;
      controller.abort();
      return true;
    });
    const handlers = createRepositoryCloudDiscoveryCancellationHandlers({
      isCurrentOwner: (value) => value === owner,
      cancelForOwner,
    });

    expect(handlers.cancelPrivateWorksDiscovery({ sender: owner }, { unexpected: true })).toEqual({
      kind: "invalid-request",
    });
    expect(handlers.cancelPrivateWorksDiscovery({ sender: otherOwner })).toEqual({
      kind: "invalid-request",
    });
    expect(handlers.cancelPrivateWorksDiscovery({ sender: owner })).toEqual({
      kind: "cancelled",
    });
    expect(controller.signal.aborted).toBe(true);
    expect(cancelForOwner).toHaveBeenCalledTimes(1);
    expect(handlers.cancelPrivateWorksDiscovery({ sender: owner })).toEqual({
      kind: "idle",
    });
    expect(cancelForOwner).toHaveBeenCalledTimes(2);
    expect(CANCEL_PRIVATE_WORKS_DISCOVERY_CHANNEL).toBe("maginalia:cancel-private-works-discovery");
  });
});

function expectCatalogNotOwned(catalog: RepositoryCloudRestoreCatalog, owner: object, id: string): void {
  expect(() => catalog.resolveForOwner(owner, id)).toThrowError(/no longer available/);
}
