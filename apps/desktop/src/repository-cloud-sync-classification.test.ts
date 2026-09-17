import { describe, expect, test, vi } from "vitest";
import {
  classifyRepositoryCloudSync,
  type RepositoryCloudSyncAncestryChecker,
  type RepositoryCloudSyncInput,
} from "./repository-cloud-sync-classification.js";

const LOCAL = "a".repeat(40);
const REMOTE = "b".repeat(40);

function input(
  connected: boolean,
  remoteHead: string | null,
  localHead = LOCAL,
): RepositoryCloudSyncInput {
  return { connected, localHead, remoteHead };
}

describe("classifyRepositoryCloudSync", () => {
  test("returns local-only for a disconnected repository with no remote", async () => {
    const checker = vi.fn<RepositoryCloudSyncAncestryChecker>();
    await expect(classifyRepositoryCloudSync(input(false, null), checker))
      .resolves.toEqual({ status: "local-only" });
    expect(checker).not.toHaveBeenCalled();
  });

  test("returns local-ahead for a connected verified empty remote", async () => {
    const checker = vi.fn<RepositoryCloudSyncAncestryChecker>();
    await expect(classifyRepositoryCloudSync(input(true, null), checker))
      .resolves.toEqual({ status: "local-ahead" });
    expect(checker).not.toHaveBeenCalled();
  });

  test("returns synced for equal heads without an ancestry call", async () => {
    const checker = vi.fn<RepositoryCloudSyncAncestryChecker>();
    const result = await classifyRepositoryCloudSync(input(true, LOCAL), checker);
    expect(result).toEqual({ status: "synced" });
    expect(checker).not.toHaveBeenCalled();
    expect(Object.isFrozen(result)).toBe(true);
  });

  test("returns local-ahead when remote is an ancestor of local", async () => {
    const checker = vi.fn<RepositoryCloudSyncAncestryChecker>(async (ancestor, descendant) => {
      return ancestor === REMOTE && descendant === LOCAL;
    });
    await expect(classifyRepositoryCloudSync(input(true, REMOTE), checker))
      .resolves.toEqual({ status: "local-ahead" });
    expect(checker).toHaveBeenNthCalledWith(1, REMOTE, LOCAL);
    expect(checker).toHaveBeenNthCalledWith(2, LOCAL, REMOTE);
  });

  test("returns remote-ahead when local is an ancestor of remote", async () => {
    const checker = vi.fn<RepositoryCloudSyncAncestryChecker>(async (ancestor, descendant) => {
      return ancestor === LOCAL && descendant === REMOTE;
    });
    await expect(classifyRepositoryCloudSync(input(true, REMOTE), checker))
      .resolves.toEqual({ status: "remote-ahead" });
  });

  test("returns diverged when neither tip is an ancestor", async () => {
    const checker = vi.fn<RepositoryCloudSyncAncestryChecker>(async () => false);
    await expect(classifyRepositoryCloudSync(input(true, REMOTE), checker))
      .resolves.toEqual({ status: "diverged" });
    expect(checker).toHaveBeenCalledTimes(2);
  });

  test.each([
    ["uppercase local", input(true, REMOTE, LOCAL.toUpperCase())],
    ["uppercase remote", input(true, REMOTE.toUpperCase())],
    ["short local", input(true, REMOTE, "a")],
    ["short remote", input(true, "b")],
    ["null-sentinel local", input(true, REMOTE, "0".repeat(40))],
    ["null-sentinel remote", input(true, "0".repeat(40))],
    ["disconnected with remote", input(false, REMOTE)],
  ])("returns attention for %s", async (_label, value) => {
    const checker = vi.fn<RepositoryCloudSyncAncestryChecker>();
    const result = await classifyRepositoryCloudSync(value, checker);
    expect(result.status).toBe("attention");
    expect(checker).not.toHaveBeenCalled();
  });

  test("returns attention when ancestry throws or returns a non-boolean", async () => {
    const throwing = vi.fn<RepositoryCloudSyncAncestryChecker>(async () => {
      throw new Error(`secret ${REMOTE}`);
    });
    await expect(classifyRepositoryCloudSync(input(true, REMOTE), throwing))
      .resolves.toEqual({ status: "attention", code: "ANCESTRY_FAILED" });

    const malformed = vi.fn<RepositoryCloudSyncAncestryChecker>(async () => "yes" as unknown as boolean);
    await expect(classifyRepositoryCloudSync(input(true, REMOTE), malformed))
      .resolves.toEqual({ status: "attention", code: "ANCESTRY_FAILED" });
  });

  test("returns attention for contradictory ancestry in both directions", async () => {
    const checker = vi.fn<RepositoryCloudSyncAncestryChecker>(async () => true);
    await expect(classifyRepositoryCloudSync(input(true, REMOTE), checker))
      .resolves.toEqual({ status: "attention", code: "CONTRADICTORY_ANCESTRY" });
    expect(checker).toHaveBeenCalledTimes(2);
  });

  test("does not mutate input or expose heads in the result", async () => {
    const value = Object.freeze(input(true, REMOTE));
    const result = await classifyRepositoryCloudSync(value, async () => false);
    expect(value).toEqual({ connected: true, localHead: LOCAL, remoteHead: REMOTE });
    expect(result).toEqual({ status: "diverged" });
    expect(JSON.stringify(result)).not.toContain(LOCAL);
    expect(JSON.stringify(result)).not.toContain(REMOTE);
  });
});
