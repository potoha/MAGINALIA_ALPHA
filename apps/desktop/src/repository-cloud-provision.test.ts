import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createIdentity,
  IDENTITY_PATH,
  storageName,
  templateFiles,
  type RepositoryIdentity,
} from "@maginalia/repository-core";
import {
  PendingCloudCreationLedger,
  type PendingCloudCreationCandidate,
} from "./repository-cloud-pending";
import { RepositoryCloudConnectionStore } from "./repository-cloud-connection-store";
import type {
  GitHubAccount,
  VerifiedPersonalInstallation,
  VerifiedPrivateRemote,
} from "./repository-github";
import {
  provisionPrivateCloud,
  RepositoryCloudProvisionError,
  type RepositoryCloudProvisionProvider,
} from "./repository-cloud-provision";
import { initializeRepository } from "./repository-local-history";

const BASE_ID = "550e8400-e29b-41d4-a716-446655440000";
const ACCOUNT: GitHubAccount = Object.freeze({
  id: 42,
  login: "alice",
  nodeId: "U_42",
});
const INSTALLATION: VerifiedPersonalInstallation = Object.freeze({
  installationId: 7,
  accountId: ACCOUNT.id,
  appId: 99,
});
const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await fs.rm(root, { recursive: true, force: true });
  }
});

async function writeFiles(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [pathValue, contents] of Object.entries(files)) {
    const segments = pathValue.split("/");
    let directory = root;
    for (const segment of segments.slice(0, -1)) {
      directory = join(directory, segment);
      await fs.mkdir(directory, { recursive: true });
    }
    await fs.writeFile(join(root, ...segments), contents, "utf8");
  }
}

async function makeFixture(): Promise<{ readonly root: string; readonly appData: string; readonly identity: RepositoryIdentity }> {
  const root = await fs.mkdtemp(join(tmpdir(), "maginalia-provision-repository-"));
  roots.push(root);
  const appData = await fs.mkdtemp(join(tmpdir(), "maginalia-provision-appdata-"));
  roots.push(appData);
  const identity = createIdentity("project", "Provision fixture", BASE_ID);
  await writeFiles(root, templateFiles(identity));
  await fs.writeFile(join(root, "MAGINALIA-INCOMPLETE.txt"), "setup marker\n", "utf8");
  await initializeRepository(root);
  await fs.unlink(join(root, "MAGINALIA-INCOMPLETE.txt"));
  return { root, appData, identity };
}

function candidateFor(identity: RepositoryIdentity, overrides: Partial<PendingCloudCreationCandidate> = {}): PendingCloudCreationCandidate {
  const name = overrides.name ?? storageName(identity);
  const owner = overrides.owner ?? ACCOUNT.login;
  return Object.freeze({
    id: overrides.id ?? 101,
    nodeId: overrides.nodeId ?? "R_provision_101",
    owner,
    name,
    url: overrides.url ?? `https://github.com/${owner}/${name}.git`,
  });
}

function verifiedFor(candidate: PendingCloudCreationCandidate): VerifiedPrivateRemote {
  return Object.freeze({ ...candidate, private: true as const });
}

interface ProviderOverrides {
  readonly account?: RepositoryCloudProvisionProvider["account"];
  readonly verifyPersonalInstallation?: RepositoryCloudProvisionProvider["verifyPersonalInstallation"];
  readonly createPrivateCandidate?: RepositoryCloudProvisionProvider["createPrivateCandidate"];
  readonly verifyCreatedCandidate?: RepositoryCloudProvisionProvider["verifyCreatedCandidate"];
  readonly verifyRemote?: RepositoryCloudProvisionProvider["verifyRemote"];
}

function makeProvider(identity: RepositoryIdentity, overrides: ProviderOverrides = {}): RepositoryCloudProvisionProvider {
  const candidate = candidateFor(identity);
  const defaults: RepositoryCloudProvisionProvider = {
    account: async () => ACCOUNT,
    verifyPersonalInstallation: async () => INSTALLATION,
    createPrivateCandidate: async () => candidate,
    verifyCreatedCandidate: async (value) => verifiedFor(value),
    verifyRemote: async (value) => Object.freeze({ ...value, private: true as const }),
  };
  return { ...defaults, ...overrides };
}

async function makeStores(appData: string): Promise<{
  readonly ledger: PendingCloudCreationLedger;
  readonly connectionStore: RepositoryCloudConnectionStore;
}> {
  return {
    ledger: new PendingCloudCreationLedger(appData),
    connectionStore: new RepositoryCloudConnectionStore(),
  };
}

async function expectCode(action: () => Promise<unknown>, code: string): Promise<unknown> {
  let thrown: unknown;
  try {
    await action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeDefined();
  expect((thrown as { readonly code?: string }).code).toBe(code);
  return thrown;
}

describe("idempotent private cloud provisioning", () => {
  it("runs preflight, persists intent before one POST, records candidate, verifies, binds, and clears", async () => {
    const { root, appData, identity } = await makeFixture();
    const stores = await makeStores(appData);
    const events: string[] = [];
    const candidate = candidateFor(identity);
    const provider = makeProvider(identity, {
      account: async () => {
        events.push("account");
        return ACCOUNT;
      },
      verifyPersonalInstallation: async (accountId) => {
        events.push(`installation:${accountId}`);
        return INSTALLATION;
      },
      createPrivateCandidate: async (name) => {
        events.push(`create:${name}`);
        expect(await stores.ledger.get(identity.id)).toMatchObject({ state: "intent" });
        return candidate;
      },
      verifyCreatedCandidate: async (value) => {
        events.push("verify-candidate");
        return verifiedFor(value);
      },
      verifyRemote: async (value) => {
        events.push("verify-remote");
        return verifiedFor(value);
      },
    });

    await expect(provisionPrivateCloud(provider, stores.ledger, stores.connectionStore, root, identity))
      .resolves.toEqual({ status: "connected" });
    expect(events).toEqual([
      "account",
      "installation:42",
      `create:${storageName(identity)}`,
      "verify-candidate",
      "verify-remote",
    ]);
    expect(await stores.ledger.get(identity.id)).toBeUndefined();
    await expect(stores.connectionStore.read(root)).resolves.toEqual(verifiedFor(candidate));
  });

  it("reverifies an existing connection and never creates another repository", async () => {
    const { root, appData, identity } = await makeFixture();
    const stores = await makeStores(appData);
    const existing = verifiedFor(candidateFor(identity));
    await stores.connectionStore.write(root, existing);
    let creates = 0;
    let verifies = 0;
    const provider = makeProvider(identity, {
      createPrivateCandidate: async () => {
        creates += 1;
        return existing;
      },
      verifyRemote: async (value) => {
        verifies += 1;
        return value;
      },
    });

    await expect(provisionPrivateCloud(provider, stores.ledger, stores.connectionStore, root, identity))
      .resolves.toEqual({ status: "already-connected" });
    expect(creates).toBe(0);
    expect(verifies).toBe(1);
  });

  it("clears a candidate left after connection binding, using stable private verification without POST", async () => {
    const { root, appData, identity } = await makeFixture();
    const stores = await makeStores(appData);
    const candidate = candidateFor(identity);
    await stores.ledger.begin(identity, ACCOUNT.id);
    await stores.ledger.recordCandidate(identity.id, ACCOUNT.id, candidate);

    // Model the crash window after connectionStore.write but before
    // ledger.clearAfterConnection.  The remote has since been renamed, so
    // only its stable IDs remain equal to the pending candidate.
    const renamed = verifiedFor(candidateFor(identity, {
      name: `${candidate.name}-renamed`,
      url: `https://github.com/${candidate.owner}/${candidate.name}-renamed.git`,
    }));
    await stores.connectionStore.write(root, renamed);
    const events: string[] = [];
    let creates = 0;
    const provider = makeProvider(identity, {
      createPrivateCandidate: async () => {
        creates += 1;
        return candidate;
      },
      verifyCreatedCandidate: async () => {
        events.push("verify-candidate");
        throw new Error("candidate GET is unnecessary after stable connection verification");
      },
      verifyRemote: async (value) => {
        events.push("verify-remote");
        return renamed;
      },
    });

    await expect(provisionPrivateCloud(provider, stores.ledger, stores.connectionStore, root, identity))
      .resolves.toEqual({ status: "already-connected" });
    expect(events).toEqual(["verify-remote"]);
    expect(creates).toBe(0);
    expect(await stores.ledger.get(identity.id)).toBeUndefined();
    await expect(stores.connectionStore.read(root)).resolves.toEqual(renamed);
  });

  it("resolves a recorded candidate without POST and clears it only after private verification", async () => {
    const { root, appData, identity } = await makeFixture();
    const stores = await makeStores(appData);
    const candidate = candidateFor(identity);
    await stores.ledger.begin(identity, ACCOUNT.id);
    await stores.ledger.recordCandidate(identity.id, ACCOUNT.id, candidate);
    const events: string[] = [];
    const provider = makeProvider(identity, {
      createPrivateCandidate: async () => {
        events.push("create");
        return candidate;
      },
      verifyCreatedCandidate: async (value) => {
        events.push("verify-candidate");
        return verifiedFor(value);
      },
      verifyRemote: async (value) => {
        events.push("verify-remote");
        return value;
      },
    });

    await expect(provisionPrivateCloud(provider, stores.ledger, stores.connectionStore, root, identity))
      .resolves.toEqual({ status: "connected" });
    expect(events).toEqual(["verify-candidate", "verify-remote"]);
    expect(await stores.ledger.get(identity.id)).toBeUndefined();
    expect(await stores.connectionStore.read(root)).toEqual(verifiedFor(candidate));
  });

  it("treats an unresolved intent as an attention barrier and never adopts a name or POSTs", async () => {
    const { root, appData, identity } = await makeFixture();
    const stores = await makeStores(appData);
    await stores.ledger.begin(identity, ACCOUNT.id);
    let creates = 0;
    const provider = makeProvider(identity, {
      createPrivateCandidate: async () => {
        creates += 1;
        return candidateFor(identity, { name: "human-title" });
      },
    });

    await expectCode(
      () => provisionPrivateCloud(provider, stores.ledger, stores.connectionStore, root, identity),
      "PENDING_ATTENTION",
    );
    expect(creates).toBe(0);
    expect(await stores.ledger.get(identity.id)).toMatchObject({ state: "intent" });
  });

  it("keeps the intent when creation is uncertain or candidate persistence fails", async () => {
    const first = await makeFixture();
    const firstStores = await makeStores(first.appData);
    const firstError = await expectCode(
      () => provisionPrivateCloud(makeProvider(first.identity, {
        createPrivateCandidate: async () => {
          throw new Error("provider detail includes token");
        },
      }), firstStores.ledger, firstStores.connectionStore, first.root, first.identity),
      "CREATE_FAILED",
    ) as RepositoryCloudProvisionError;
    expect(firstError.message).not.toContain("token");
    expect(await firstStores.ledger.get(first.identity.id)).toMatchObject({ state: "intent" });

    const second = await makeFixture();
    const secondStores = await makeStores(second.appData);
    const failingLedger = {
      get: (identityId: string) => secondStores.ledger.get(identityId),
      begin: (value: RepositoryIdentity, accountId: number) => secondStores.ledger.begin(value, accountId),
      recordCandidate: async () => {
        throw new Error("candidate persistence detail");
      },
      clearAfterConnection: (
        identityId: string,
        accountId: number,
        candidate: Parameters<PendingCloudCreationLedger["clearAfterConnection"]>[2],
      ) => secondStores.ledger.clearAfterConnection(identityId, accountId, candidate),
    };
    await expectCode(
      () => provisionPrivateCloud(makeProvider(second.identity), failingLedger, secondStores.connectionStore, second.root, second.identity),
      "PENDING_PERSIST_FAILED",
    );
    expect(await secondStores.ledger.get(second.identity.id)).toMatchObject({ state: "intent" });
  });

  it("keeps a candidate after a public or stable-ID mismatch and never binds it", async () => {
    const { root, appData, identity } = await makeFixture();
    const stores = await makeStores(appData);
    const candidate = candidateFor(identity);
    await stores.ledger.begin(identity, ACCOUNT.id);
    await stores.ledger.recordCandidate(identity.id, ACCOUNT.id, candidate);
    const provider = makeProvider(identity, {
      verifyCreatedCandidate: async (value) => ({ ...verifiedFor(value), private: false }) as never,
    });

    await expectCode(
      () => provisionPrivateCloud(provider, stores.ledger, stores.connectionStore, root, identity),
      "CANDIDATE_UNVERIFIED",
    );
    expect(await stores.ledger.get(identity.id)).toMatchObject({ state: "candidate" });
    expect(await stores.connectionStore.read(root)).toBeNull();

    await expectCode(
      () => provisionPrivateCloud(makeProvider(identity, {
        verifyRemote: async (value) => ({ ...value, id: value.id + 1 }),
      }), stores.ledger, stores.connectionStore, root, identity),
      "REMOTE_VERIFY_FAILED",
    );
    expect(await stores.ledger.get(identity.id)).toMatchObject({ state: "candidate" });
  });

  it("rejects a pending account switch before candidate verification or creation", async () => {
    const { root, appData, identity } = await makeFixture();
    const stores = await makeStores(appData);
    await stores.ledger.begin(identity, 99);
    let candidateVerifies = 0;
    let creates = 0;
    const provider = makeProvider(identity, {
      createPrivateCandidate: async () => {
        creates += 1;
        return candidateFor(identity);
      },
      verifyCreatedCandidate: async (value) => {
        candidateVerifies += 1;
        return verifiedFor(value);
      },
    });

    await expectCode(
      () => provisionPrivateCloud(provider, stores.ledger, stores.connectionStore, root, identity),
      "ACCOUNT_MISMATCH",
    );
    expect(candidateVerifies).toBe(0);
    expect(creates).toBe(0);
  });

  it("allows only one concurrent create POST when two callers race", async () => {
    const { root, appData, identity } = await makeFixture();
    const stores = await makeStores(appData);
    const candidate = candidateFor(identity);
    let creates = 0;
    let releaseCreate!: () => void;
    let signalCreateStarted!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      signalCreateStarted = resolve;
    });
    // A shared provider is needed so both calls use the same deterministic
    // fixture; the ledger lock, not provider state, enforces one POST.
    let provider!: RepositoryCloudProvisionProvider;
    provider = makeProvider(identity, {
      createPrivateCandidate: async () => {
        creates += 1;
        signalCreateStarted();
        await new Promise<void>((release) => {
          releaseCreate = release;
        });
        return candidate;
      },
    });
    const first = provisionPrivateCloud(provider, stores.ledger, stores.connectionStore, root, identity);
    await Promise.race([
      createStarted,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("create did not start")), 1_000)),
    ]);
    const second = provisionPrivateCloud(provider, stores.ledger, stores.connectionStore, root, identity);
    await expectCode(() => second, "PENDING_ATTENTION");
    releaseCreate();
    await expect(first).resolves.toEqual({ status: "connected" });
    expect(creates).toBe(1);
  });

  it("keeps a candidate when connection binding fails", async () => {
    const { root, appData, identity } = await makeFixture();
    const stores = await makeStores(appData);
    const provider = makeProvider(identity);
    const failingStore = {
      read: (value: string) => stores.connectionStore.read(value),
      write: async () => {
        throw new Error("connection storage detail");
      },
    };

    await expectCode(
      () => provisionPrivateCloud(provider, stores.ledger, failingStore, root, identity),
      "CONNECTION_PERSIST_FAILED",
    );
    expect(await stores.ledger.get(identity.id)).toMatchObject({ state: "candidate" });
  });

  it("fails local identity mismatch before provider preflight and does not expose paths", async () => {
    const { root, appData, identity } = await makeFixture();
    const stores = await makeStores(appData);
    const other = createIdentity("project", "Other fixture", "6ba7b810-9dad-41d1-80b4-00c04fd430c8");
    let calls = 0;
    const provider = makeProvider(identity, {
      account: async () => {
        calls += 1;
        return ACCOUNT;
      },
    });

    const error = await expectCode(
      () => provisionPrivateCloud(provider, stores.ledger, stores.connectionStore, root, other),
      "LOCAL_IDENTITY_MISMATCH",
    ) as RepositoryCloudProvisionError;
    expect(calls).toBe(0);
    expect(error.message).not.toContain(root);
  });

  it("rechecks the local identity after provider awaits and never writes a stale binding", async () => {
    const { root, appData, identity } = await makeFixture();
    const stores = await makeStores(appData);
    const changedIdentity = createIdentity(
      "project",
      "Changed during cloud verification",
      "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
    );
    let writes = 0;
    const guardedStore = {
      read: (value: string) => stores.connectionStore.read(value),
      write: async (...args: Parameters<RepositoryCloudConnectionStore["write"]>) => {
        writes += 1;
        return stores.connectionStore.write(...args);
      },
    };
    const provider = makeProvider(identity, {
      verifyRemote: async (value) => {
        await fs.writeFile(
          join(root, IDENTITY_PATH),
          templateFiles(changedIdentity)[IDENTITY_PATH]!,
          "utf8",
        );
        return verifiedFor(value);
      },
    });

    await expectCode(
      () => provisionPrivateCloud(provider, stores.ledger, guardedStore, root, identity),
      "LOCAL_REPOSITORY_INVALID",
    );
    expect(writes).toBe(0);
    expect(await stores.ledger.get(identity.id)).toMatchObject({ state: "candidate" });
    expect(await stores.connectionStore.read(root)).toBeNull();
  });
});
