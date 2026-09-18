import { describe, expect, it, vi } from "vitest";
import {
  RepositoryCloudCoordinator,
  type RepositoryCloudDiscoveryOperation,
} from "./repository-cloud-coordinator";
import type { GitHubDeviceVerificationPrompt } from "./repository-github-auth";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function makeCoordinator(
  discover: RepositoryCloudDiscoveryOperation,
  liveOwners: Set<object>,
  registerOwnerLifecycle?: (owner: object, onClose: () => void) => void | (() => void),
): RepositoryCloudCoordinator {
  return new RepositoryCloudCoordinator({
    isLiveOwner: (owner) => liveOwners.has(owner),
    registerOwnerLifecycle,
    discover,
  });
}

describe("RepositoryCloudCoordinator", () => {
  it("isolates owners when cancelling one discovery", async () => {
    const owner = {};
    const otherOwner = {};
    const liveOwners = new Set<object>([owner, otherOwner]);
    const first = deferred<{ readonly kind: "empty" }>();
    const second = deferred<{ readonly kind: "empty" }>();
    const signals: AbortSignal[] = [];
    let call = 0;
    const coordinator = makeCoordinator(async (request) => {
      signals.push(request.signal);
      call += 1;
      return call === 1 ? first.promise : second.promise;
    }, liveOwners);

    const firstCall = coordinator.discoverForOwner(owner, vi.fn());
    const secondCall = coordinator.discoverForOwner(otherOwner, vi.fn());
    expect(coordinator.cancelForOwner(owner)).toBe(true);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);

    first.resolve({ kind: "empty" });
    await expect(firstCall).rejects.toThrow("no longer active");
    second.resolve({ kind: "empty" });
    await expect(secondCall).resolves.toEqual({ kind: "empty" });
    expect(coordinator.isCurrentOwner(otherOwner)).toBe(true);
  });

  it("aborts a prior same-owner attempt and rejects its late result", async () => {
    const owner = {};
    const liveOwners = new Set<object>([owner]);
    const older = deferred<{ readonly kind: "empty" }>();
    const newer = deferred<{ readonly kind: "empty" }>();
    const signals: AbortSignal[] = [];
    let call = 0;
    const coordinator = makeCoordinator(async (request) => {
      signals.push(request.signal);
      call += 1;
      return call === 1 ? older.promise : newer.promise;
    }, liveOwners);

    const olderCall = coordinator.discoverForOwner(owner, vi.fn());
    const newerCall = coordinator.discoverForOwner(owner, vi.fn());
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);

    newer.resolve({ kind: "empty" });
    await expect(newerCall).resolves.toEqual({ kind: "empty" });
    older.resolve({ kind: "empty" });
    await expect(olderCall).rejects.toThrow("no longer active");
  });

  it("rejects a late verification prompt after cancellation", async () => {
    const owner = {};
    const liveOwners = new Set<object>([owner]);
    const pending = deferred<{ readonly kind: "empty" }>();
    let prompt: ((value: GitHubDeviceVerificationPrompt) => void) | undefined;
    const coordinator = makeCoordinator(async (request) => {
      prompt = request.onVerification;
      return pending.promise;
    }, liveOwners);

    const discovery = coordinator.discoverForOwner(owner, vi.fn());
    expect(coordinator.cancelForOwner(owner)).toBe(true);
    expect(() => prompt?.({ userCode: "ABCD-1234", verificationUri: "https://github.com/login/device" }))
      .toThrow("could not be delivered");
    pending.resolve({ kind: "empty" });
    await expect(discovery).rejects.toThrow("no longer active");
  });

  it("rejects a result after owner death and clears its catalog", async () => {
    const owner = {};
    const liveOwners = new Set<object>([owner]);
    const pending = deferred<{ readonly kind: "empty" }>();
    const coordinator = makeCoordinator(async () => pending.promise, liveOwners);
    const discovery = coordinator.discoverForOwner(owner, vi.fn());

    coordinator.catalog.clearForOwner(owner);
    liveOwners.delete(owner);
    pending.resolve({ kind: "empty" });
    await expect(discovery).rejects.toThrow("no longer active");
    expect(coordinator.isCurrentOwner(owner)).toBe(false);
  });

  it("aborts and rejects stale results when disposed", async () => {
    const owner = {};
    const liveOwners = new Set<object>([owner]);
    const pending = deferred<{ readonly kind: "empty" }>();
    const coordinator = makeCoordinator(async (request) => {
      expect(request.signal.aborted).toBe(false);
      return pending.promise;
    }, liveOwners);
    const discovery = coordinator.discoverForOwner(owner, vi.fn());

    coordinator.dispose();
    expect(coordinator.isCurrentOwner(owner)).toBe(false);
    pending.resolve({ kind: "empty" });
    await expect(discovery).rejects.toThrow("no longer active");
    expect(() => coordinator.catalog.registerForOwner(owner, { kind: "empty" }))
      .toThrowError(/disposed/i);
  });

  it("binds owner close callbacks to cancellation and removes them on close", async () => {
    const owner = {};
    const liveOwners = new Set<object>([owner]);
    const pending = deferred<{ readonly kind: "empty" }>();
    let closeOwner: (() => void) | undefined;
    const removeListener = vi.fn();
    const coordinator = makeCoordinator(async () => pending.promise, liveOwners, (_owner, onClose) => {
      closeOwner = onClose;
      return removeListener;
    });
    const discovery = coordinator.discoverForOwner(owner, vi.fn());

    closeOwner?.();
    expect(removeListener).toHaveBeenCalledOnce();
    pending.resolve({ kind: "empty" });
    await expect(discovery).rejects.toThrow("no longer active");
    expect(coordinator.isCurrentOwner(owner)).toBe(false);
  });
});
