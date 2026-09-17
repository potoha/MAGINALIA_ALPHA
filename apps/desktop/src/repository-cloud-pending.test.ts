import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createIdentity,
  storageName,
  type RepositoryIdentity,
  type RepositoryKind,
} from "@maginalia/repository-core";
import {
  MAX_PENDING_CLOUD_CREATIONS,
  MAX_PENDING_CLOUD_CREATION_BYTES,
  PENDING_CLOUD_CREATION_FILE_NAME,
  PendingCloudCreationError,
  PendingCloudCreationLedger,
  type PendingCloudCreationCandidate,
  type PendingCloudCreationRecord,
  type PendingCloudCreationVerifiedCandidate,
} from "./repository-cloud-pending";

const BASE_UUID = "550e8400-e29b-41d4-a716-446655440000";
const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await fs.rm(root, { recursive: true, force: true });
  }
});

async function makeAppData(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), "maginalia-pending-"));
  roots.push(root);
  return root;
}

function makeIdentity(
  index = 0,
  kind: RepositoryKind = "project",
  title = `Project ${index}`,
): RepositoryIdentity {
  const suffix = index === 0
    ? BASE_UUID.slice(-12)
    : index.toString(16).padStart(12, "0");
  return createIdentity(kind, title, `550e8400-e29b-41d4-a716-${suffix}`);
}

function candidateFor(identity: RepositoryIdentity, overrides: Partial<PendingCloudCreationCandidate> = {}): PendingCloudCreationCandidate {
  const name = overrides.name ?? storageName(identity);
  const owner = overrides.owner ?? "alice";
  return {
    id: overrides.id ?? 42,
    nodeId: overrides.nodeId ?? "R_kgDO42",
    owner,
    name,
    url: overrides.url ?? `https://github.com/${owner}/${name}.git`,
  };
}

function verifiedFor(candidate: PendingCloudCreationCandidate): PendingCloudCreationVerifiedCandidate {
  return Object.freeze({
    id: candidate.id,
    nodeId: candidate.nodeId,
    owner: candidate.owner,
    name: candidate.name,
    url: candidate.url,
    private: true as const,
  });
}

function expectCode(action: () => Promise<unknown>, code: string): Promise<void> {
  return expect(action()).rejects.toSatisfy((error: unknown) => {
    return error instanceof PendingCloudCreationError && error.code === code;
  });
}

function intentJson(identity: RepositoryIdentity, accountId: number): Record<string, unknown> {
  return {
    identityId: identity.id.toLowerCase(),
    kind: identity.kind,
    storageName: storageName(identity),
    accountId,
    state: "intent",
  };
}

async function writeLedger(root: string, value: unknown): Promise<void> {
  await fs.writeFile(
    join(root, PENDING_CLOUD_CREATION_FILE_NAME),
    JSON.stringify(value),
  );
}

describe("pending private cloud creation ledger", () => {
  it("persists an intent and then an explicit unverified candidate without secrets", async () => {
    const root = await makeAppData();
    const identity = makeIdentity();
    const ledger = new PendingCloudCreationLedger(root);

    const intent = await ledger.begin(identity, 42);
    expect(intent).toEqual({
      identityId: identity.id,
      kind: "project",
      storageName: storageName(identity),
      accountId: 42,
      state: "intent",
    });
    expect(Object.isFrozen(intent)).toBe(true);
    expect(await ledger.get(identity.id.toUpperCase())).toEqual(intent);

    const candidate = candidateFor(identity);
    const recorded = await ledger.recordCandidate(identity.id, 42, candidate);
    expect(recorded).toEqual({ ...intent, state: "candidate", candidate });
    expect(Object.isFrozen(recorded)).toBe(true);
    expect(Object.isFrozen(recorded.candidate)).toBe(true);

    const raw = await fs.readFile(join(root, PENDING_CLOUD_CREATION_FILE_NAME), "utf8");
    expect(raw).not.toContain(identity.title);
    expect(raw).not.toContain("private");
    expect(raw).not.toContain("token");
    expect(JSON.parse(raw).records[0]).toEqual({
      ...intent,
      state: "candidate",
      candidate,
    });
  });

  it("treats every existing record as an attention barrier and prevents account or identity switching", async () => {
    const root = await makeAppData();
    const identity = makeIdentity();
    const ledger = new PendingCloudCreationLedger(root);
    await ledger.begin(identity, 42);

    await expectCode(() => ledger.begin(identity, 42), "already-pending");
    await expectCode(() => ledger.begin(identity, 43), "account-mismatch");
    await expectCode(() => ledger.begin({ ...identity, kind: "workbench" }, 42), "identity-mismatch");

    const candidate = candidateFor(identity);
    await ledger.recordCandidate(identity.id, 42, candidate);
    await expectCode(() => ledger.begin(identity, 42), "already-pending");
    await expectCode(() => ledger.recordCandidate(identity.id, 7, candidate), "account-mismatch");
  });

  it("requires the deterministic storage name for a recorded candidate", async () => {
    const root = await makeAppData();
    const identity = makeIdentity();
    const ledger = new PendingCloudCreationLedger(root);
    await ledger.begin(identity, 42);

    const wrongName = candidateFor(identity, { name: "human-title" });
    await expectCode(() => ledger.recordCandidate(identity.id, 42, wrongName), "identity-mismatch");
    expect((await ledger.get(identity.id))?.state).toBe("intent");
  });

  it("requires verified and matching proof before clearing, preserving unresolved records", async () => {
    const root = await makeAppData();
    const identity = makeIdentity();
    const ledger = new PendingCloudCreationLedger(root);
    await ledger.begin(identity, 42);
    const candidate = candidateFor(identity);

    await expectCode(
      () => ledger.clearAfterConnection(identity.id, 42, verifiedFor(candidate)),
      "not-verified",
    );
    expect((await ledger.get(identity.id))?.state).toBe("intent");

    await ledger.recordCandidate(identity.id, 42, candidate);
    await expectCode(
      () => ledger.clearAfterConnection(identity.id, 42, {
        ...verifiedFor(candidate),
        private: false,
      } as unknown as PendingCloudCreationVerifiedCandidate),
      "not-verified",
    );
    await expectCode(
      () => ledger.clearAfterConnection(identity.id, 42, verifiedFor(candidateFor(identity, { id: 43 }))),
      "candidate-mismatch",
    );
    expect(await ledger.get(identity.id)).toBeDefined();

    await ledger.clearAfterConnection(identity.id, 42, verifiedFor(candidate));
    expect(await ledger.get(identity.id)).toBeUndefined();
  });

  it("enforces the hard cap without eviction", async () => {
    const root = await makeAppData();
    const ledger = new PendingCloudCreationLedger(root);
    const identities = Array.from({ length: MAX_PENDING_CLOUD_CREATIONS + 1 }, (_, index) => makeIdentity(index));

    for (const [index, identity] of identities.slice(0, MAX_PENDING_CLOUD_CREATIONS).entries()) {
      await ledger.begin(identity, index + 1);
    }
    await expectCode(() => ledger.begin(identities[MAX_PENDING_CLOUD_CREATIONS]!, 999), "limit-reached");
    expect(await ledger.get(identities[0]!.id)).toBeDefined();
    expect(await ledger.get(identities[MAX_PENDING_CLOUD_CREATIONS - 1]!.id)).toBeDefined();
    expect(await ledger.get(identities[MAX_PENDING_CLOUD_CREATIONS]!.id)).toBeUndefined();
  });

  it("fails closed for malformed, duplicate, unsupported, invalid, and oversized ledgers without rewriting them", async () => {
    const root = await makeAppData();
    const ledger = new PendingCloudCreationLedger(root);
    const path = join(root, PENDING_CLOUD_CREATION_FILE_NAME);
    const identity = makeIdentity();
    const cases: Array<{ readonly value: string; readonly code: string }> = [
      { value: "{", code: "ledger-corrupt" },
      {
        value: JSON.stringify({ schemaVersion: 99, records: [] }),
        code: "unsupported-version",
      },
      {
        value: JSON.stringify({ schemaVersion: 1, records: [intentJson(identity, 42), intentJson(identity, 42)] }),
        code: "ledger-corrupt",
      },
      {
        value: JSON.stringify({ schemaVersion: 1, records: [{ ...intentJson(identity, 42), title: identity.title }] }),
        code: "ledger-corrupt",
      },
      {
        value: "x".repeat(MAX_PENDING_CLOUD_CREATION_BYTES + 1),
        code: "ledger-too-large",
      },
    ];

    for (const testCase of cases) {
      await fs.writeFile(path, testCase.value);
      const before = await fs.readFile(path);
      await expectCode(() => ledger.get(identity.id), testCase.code);
      expect(await fs.readFile(path)).toEqual(before);
    }
  });

  it("serializes concurrent instances and preserves records", async () => {
    const root = await makeAppData();
    const first = new PendingCloudCreationLedger(root);
    const second = new PendingCloudCreationLedger(root);
    const identities = [makeIdentity(101), makeIdentity(102), makeIdentity(103)];

    const results = await Promise.allSettled([
      first.begin(identities[0]!, 42),
      second.begin(identities[1]!, 42),
      first.begin(identities[2]!, 42),
      second.begin(identities[0]!, 42),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ code: "already-pending" });
    for (const identity of identities) {
      expect(await first.get(identity.id)).toMatchObject({ identityId: identity.id, state: "intent" });
    }
  });

  it("keeps intent when candidate persistence fails, and blocks POST-start persistence failures", async () => {
    const root = await makeAppData();
    const tempPath = join(root, `${PENDING_CLOUD_CREATION_FILE_NAME}.tmp`);
    const identity = makeIdentity();
    const ledger = new PendingCloudCreationLedger(root);

    await fs.writeFile(tempPath, "occupied");
    await expectCode(() => ledger.begin(identity, 42), "storage-io");
    expect(await ledger.get(identity.id)).toBeUndefined();
    await fs.rm(tempPath);

    await ledger.begin(identity, 42);
    await fs.writeFile(tempPath, "occupied");
    await expectCode(() => ledger.recordCandidate(identity.id, 42, candidateFor(identity)), "storage-io");
    expect((await ledger.get(identity.id))?.state).toBe("intent");
    await fs.rm(tempPath);
  });

  it("keeps a candidate when clearing cannot atomically replace the ledger", async () => {
    const root = await makeAppData();
    const tempPath = join(root, `${PENDING_CLOUD_CREATION_FILE_NAME}.tmp`);
    const identity = makeIdentity();
    const ledger = new PendingCloudCreationLedger(root);
    const candidate = candidateFor(identity);
    await ledger.begin(identity, 42);
    await ledger.recordCandidate(identity.id, 42, candidate);

    await fs.writeFile(tempPath, "occupied");
    await expectCode(
      () => ledger.clearAfterConnection(identity.id, 42, verifiedFor(candidate)),
      "storage-io",
    );
    expect(await ledger.get(identity.id)).toMatchObject({ state: "candidate" });
    await fs.rm(tempPath);
    await ledger.clearAfterConnection(identity.id, 42, verifiedFor(candidate));
    expect(await ledger.get(identity.id)).toBeUndefined();
  });
});
