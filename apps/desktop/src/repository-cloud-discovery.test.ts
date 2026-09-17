import { createIdentity, type RepositoryIdentity } from "@maginalia/repository-core";
import { describe, expect, it } from "vitest";
import {
  GitHubAdapterError,
  type GitHubRepositoryCandidate,
  type GitHubRepositoryCandidateResult,
  type GitHubRestoreIdentityResult,
  type GitHubOperationOptions,
  type VerifiedPrivateRemote,
} from "./repository-github.js";
import {
  discoverPrivateRepositories,
  MAX_RESTORE_DISCOVERY_CANDIDATES,
  RepositoryCloudDiscoveryError,
  type RepositoryCloudDiscoveryProvider,
} from "./repository-cloud-discovery.js";

function candidate(id: number, name: string): GitHubRepositoryCandidate {
  return Object.freeze({
    id,
    nodeId: `R_kgDO${id}`,
    owner: "alice",
    name,
    url: `https://github.com/alice/${name}.git`,
  });
}

function remoteFor(value: GitHubRepositoryCandidate): VerifiedPrivateRemote {
  return Object.freeze({ ...value, private: true });
}

function identity(kind: "project" | "workbench" | "shelf", id: string): RepositoryIdentity {
  return createIdentity(kind, "Discovered", id);
}

function identityResult(
  value: GitHubRepositoryCandidate,
  repositoryIdentity: RepositoryIdentity,
): GitHubRestoreIdentityResult {
  return Object.freeze({
    kind: "identity",
    identity: repositoryIdentity,
    remote: remoteFor(value),
  });
}

function notMaginalia(value: GitHubRepositoryCandidate): GitHubRestoreIdentityResult {
  return Object.freeze({ kind: "not-maginalia", remote: remoteFor(value) });
}

async function failure(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("expected failure");
}

function providerFor(
  listing: GitHubRepositoryCandidateResult,
  read: (candidate: GitHubRepositoryCandidate, options?: GitHubOperationOptions) => Promise<GitHubRestoreIdentityResult>,
): { readonly provider: RepositoryCloudDiscoveryProvider; readonly listCalls: number[]; readonly readCalls: number[] } {
  const listCalls: number[] = [];
  const readCalls: number[] = [];
  return {
    provider: {
      listPrivateRepositoryCandidates: async (accountId, _options) => {
        listCalls.push(accountId);
        return listing;
      },
      readRestoreCandidateIdentity: async (value, options) => {
        readCalls.push(value.id);
        return read(value, options);
      },
    },
    listCalls,
    readCalls,
  };
}

describe("main-only cloud Restore discovery", () => {
  it("returns scoped empty when the accessible private installation has no candidates", async () => {
    let reads = 0;
    const { provider, listCalls } = providerFor({ kind: "empty" }, async () => {
      reads += 1;
      return notMaginalia(candidate(1, "unused"));
    });

    await expect(discoverPrivateRepositories(provider, 42)).resolves.toEqual({ kind: "empty" });
    expect(listCalls).toEqual([42]);
    expect(reads).toBe(0);
  });

  it("keeps only confirmed identities across all three repository kinds", async () => {
    const project = candidate(1, "project");
    const workbench = candidate(2, "workbench");
    const foreign = candidate(3, "foreign");
    const shelf = candidate(4, "shelf");
    const projectIdentity = identity("project", "11111111-1111-4111-8111-111111111111");
    const workbenchIdentity = identity("workbench", "22222222-2222-4222-8222-222222222222");
    const shelfIdentity = identity("shelf", "33333333-3333-4333-8333-333333333333");
    const calls: Array<{ readonly id: number; readonly options: GitHubOperationOptions | undefined }> = [];
    const { provider, readCalls } = providerFor(
      { kind: "candidates", candidates: [project, workbench, foreign, shelf] },
      async (value, options) => {
        calls.push({ id: value.id, options });
        if (value.id === project.id) return identityResult(value, projectIdentity);
        if (value.id === workbench.id) return identityResult(value, workbenchIdentity);
        if (value.id === foreign.id) return notMaginalia(value);
        return identityResult(value, shelfIdentity);
      },
    );
    const options = { timeoutMs: 5_000 };

    const result = await discoverPrivateRepositories(provider, 42, options);

    expect(result).toEqual({
      kind: "candidates",
      candidates: [
        { identity: projectIdentity, remote: remoteFor(project) },
        { identity: workbenchIdentity, remote: remoteFor(workbench) },
        { identity: shelfIdentity, remote: remoteFor(shelf) },
      ],
    });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.kind !== "candidates") throw new Error("expected candidates");
    expect(Object.isFrozen(result.candidates)).toBe(true);
    expect(Object.isFrozen(result.candidates[0])).toBe(true);
    expect(readCalls).toEqual([1, 2, 3, 4]);
    expect(calls.every((call) => call.options === options)).toBe(true);
  });

  it("rejects duplicate portable identity UUIDs instead of returning ambiguous results", async () => {
    const first = candidate(1, "first");
    const second = candidate(2, "second");
    const duplicate = identity("project", "11111111-1111-4111-8111-111111111111");
    const duplicateCaseVariant = identity("project", "11111111-1111-4111-8111-111111111111".toUpperCase());
    const { provider, readCalls } = providerFor(
      { kind: "candidates", candidates: [first, second] },
      async (value) => identityResult(value, value.id === first.id ? duplicate : duplicateCaseVariant),
    );

    const error = await failure(() => discoverPrivateRepositories(provider, 42));
    expect(error).toBeInstanceOf(RepositoryCloudDiscoveryError);
    if (!(error instanceof RepositoryCloudDiscoveryError)) throw new Error("expected discovery error");
    expect(error.code).toBe("DUPLICATE_IDENTITY");
    expect(readCalls).toEqual([1, 2]);
  });

  it("rejects identity results bound to a different candidate remote", async () => {
    const queried = candidate(1, "queried");
    const unrelated = candidate(2, "unrelated");
    const cases: Array<GitHubRestoreIdentityResult> = [
      identityResult(unrelated, identity("project", "11111111-1111-4111-8111-111111111111")),
      notMaginalia(unrelated),
    ];
    for (const result of cases) {
      const provider = providerFor(
        { kind: "candidates", candidates: [queried] },
        async () => result,
      );
      const error = await failure(() => discoverPrivateRepositories(provider.provider, 42));
      expect(error).toBeInstanceOf(RepositoryCloudDiscoveryError);
      if (!(error instanceof RepositoryCloudDiscoveryError)) throw new Error("expected discovery error");
      expect(error.code).toBe("INVALID_RESULT");
    }
  });

  it("fails closed on malformed provider results and the candidate bound", async () => {
    const malformedListing = providerFor(
      { kind: "candidates", candidates: [{ id: 0 }] } as never,
      async () => notMaginalia(candidate(1, "unused")),
    );
    const malformedListingError = await failure(() => discoverPrivateRepositories(malformedListing.provider, 42));
    expect(malformedListingError).toBeInstanceOf(RepositoryCloudDiscoveryError);
    if (!(malformedListingError instanceof RepositoryCloudDiscoveryError)) throw new Error("expected discovery error");
    expect(malformedListingError.code).toBe("INVALID_RESULT");
    expect(malformedListing.readCalls).toHaveLength(0);

    const malformedIdentityCandidate = candidate(1, "malformed");
    const malformedIdentity = providerFor(
      { kind: "candidates", candidates: [malformedIdentityCandidate] },
      async (value) => ({
        kind: "identity",
        identity: { schemaVersion: 2 },
        remote: remoteFor(value),
      } as never),
    );
    const malformedIdentityError = await failure(() => discoverPrivateRepositories(malformedIdentity.provider, 42));
    expect(malformedIdentityError).toBeInstanceOf(RepositoryCloudDiscoveryError);
    if (!(malformedIdentityError instanceof RepositoryCloudDiscoveryError)) throw new Error("expected discovery error");
    expect(malformedIdentityError.code).toBe("INVALID_RESULT");

    const tooMany = Array.from({ length: MAX_RESTORE_DISCOVERY_CANDIDATES + 1 }, (_, index) => candidate(index + 1, `repo-${index + 1}`));
    const tooManyProvider = providerFor(
      { kind: "candidates", candidates: tooMany },
      async (value) => notMaginalia(value),
    );
    const tooManyError = await failure(() => discoverPrivateRepositories(tooManyProvider.provider, 42));
    expect(tooManyError).toBeInstanceOf(RepositoryCloudDiscoveryError);
    if (!(tooManyError instanceof RepositoryCloudDiscoveryError)) throw new Error("expected discovery error");
    expect(tooManyError.code).toBe("TOO_MANY_CANDIDATES");
    expect(tooManyProvider.readCalls).toHaveLength(0);
  });

  it("does not return partial success when a later candidate fails", async () => {
    const first = candidate(1, "first");
    const second = candidate(2, "second");
    const firstIdentity = identity("workbench", "11111111-1111-4111-8111-111111111111");
    const { provider, readCalls } = providerFor(
      { kind: "candidates", candidates: [first, second] },
      async (value) => {
        if (value.id === first.id) return identityResult(value, firstIdentity);
        throw new GitHubAdapterError("RATE_LIMITED");
      },
    );

    await expect(discoverPrivateRepositories(provider, 42)).rejects
      .toMatchObject({ code: "RATE_LIMITED" });
    expect(readCalls).toEqual([1, 2]);
  });

  it("supports pre-cancel and cancellation between candidate reads", async () => {
    const preCancelled = new AbortController();
    preCancelled.abort();
    const preCancelledProvider = providerFor({ kind: "empty" }, async () => notMaginalia(candidate(1, "unused")));
    await expect(discoverPrivateRepositories(preCancelledProvider.provider, 42, preCancelled.signal)).rejects
      .toMatchObject({ code: "ABORTED" });
    expect(preCancelledProvider.listCalls).toHaveLength(0);

    const controller = new AbortController();
    const first = candidate(1, "first");
    const second = candidate(2, "second");
    const { provider, readCalls } = providerFor(
      { kind: "candidates", candidates: [first, second] },
      async (value) => {
        controller.abort();
        return identityResult(value, identity("project", "11111111-1111-4111-8111-111111111111"));
      },
    );
    await expect(discoverPrivateRepositories(provider, 42, controller.signal)).rejects
      .toMatchObject({ code: "ABORTED" });
    expect(readCalls).toEqual([1]);
  });

  it("validates account input and provider methods before network work", async () => {
    const provider = providerFor({ kind: "empty" }, async () => notMaginalia(candidate(1, "unused")));
    for (const accountId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(discoverPrivateRepositories(provider.provider, accountId)).rejects
        .toMatchObject({ code: "INVALID_INPUT" });
    }
    expect(provider.listCalls).toHaveLength(0);
    await expect(discoverPrivateRepositories({} as RepositoryCloudDiscoveryProvider, 42)).rejects
      .toMatchObject({ code: "INVALID_INPUT" });
  });
});
