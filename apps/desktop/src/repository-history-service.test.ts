import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createIdentity,
  storageName,
  type RepositoryKind,
} from "@maginalia/repository-core";
import {
  LocalRepositoryService,
  type LocalHistoryListResult,
  type LocalHistorySnapshotResult,
  type LocalRepositoryOpened,
  type LocalRepositoryResult,
} from "./repository-service.js";
import * as localHistory from "./repository-local-history.js";
import { FileWorkdeskPathStore, WorkdeskService } from "./workdesk-service.js";

const roots: string[] = [];
const IDS: Record<RepositoryKind, string> = {
  project: "550e8400-e29b-41d4-a716-446655440000",
  workbench: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
  shelf: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
};

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await fs.rm(root, { recursive: true, force: true });
  }
});

function opened(result: LocalRepositoryResult): LocalRepositoryOpened {
  expect(result.kind).toBe("opened");
  if (result.kind !== "opened") throw new Error("Expected an opened repository");
  return result;
}

function snapshot(result: LocalHistorySnapshotResult | { kind: "error" }): LocalHistorySnapshotResult {
  expect(result.kind).toBe("snapshot");
  if (result.kind !== "snapshot") throw new Error("Expected a History snapshot result");
  return result;
}

function listing(result: LocalHistoryListResult | { kind: "error" }): LocalHistoryListResult {
  expect(result.kind).toBe("history");
  if (result.kind !== "history") throw new Error("Expected a History listing result");
  return result;
}

function sequenceFactory(ids: readonly string[]): () => string {
  let index = 0;
  return () => ids[index++] ?? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
}

async function makeRepository(
  service: LocalRepositoryService,
  owner: object,
  kind: RepositoryKind,
  title: string,
  identityId: string,
): Promise<{ parent: string; root: string; repositoryId: string }> {
  const parent = await fs.mkdtemp(join(tmpdir(), "maginalia-history-service-"));
  roots.push(parent);
  const result = opened(await service.createForOwner(owner, parent, kind, title));
  const root = join(parent, storageName(createIdentity(kind, title, identityId)));
  expect(result.repository.kind).toBe(kind);
  return { parent, root, repositoryId: result.repository.repositoryId };
}

describe("owner-bound History service", () => {
  test("excludes one registered direct Workdesk Project from every parent History capture", async () => {
    const parent = await fs.mkdtemp(join(tmpdir(), "maginalia-workdesk-history-"));
    roots.push(parent);
    const workdeskService = new WorkdeskService(new FileWorkdeskPathStore(join(parent, "app-local-workdesk-state.json")));
    const service = new LocalRepositoryService({
      workdeskHistoryExclusionResolver: (root, identity) => workdeskService.historyExcludedChildDirectories(root, identity),
    });
    const workdeskOwner = {};
    const workdesk = opened(await service.createForOwner(workdeskOwner, parent, "workbench", "Desk"));
    const resolvedDesk = await service.resolveForOwner(workdeskOwner, workdesk.repository.repositoryId);
    expect(resolvedDesk.kind).toBe("resolved");
    if (resolvedDesk.kind !== "resolved") throw new Error("Expected Workdesk root");
    const desk = await workdeskService.open(resolvedDesk.canonicalRoot);

    const projectsRoot = join(desk.canonicalRoot, "projects");
    await fs.mkdir(projectsRoot);
    const childOwner = {};
    const child = opened(await service.createForOwner(childOwner, projectsRoot, "project", "Child", {
      parentWorkdeskId: desk.identity.id,
    }));
    const resolvedChild = await service.resolveForOwner(childOwner, child.repository.repositoryId);
    expect(resolvedChild.kind).toBe("resolved");
    if (resolvedChild.kind !== "resolved") throw new Error("Expected child Project root");
    const childBoundary = await workdeskService.validateDirectChildProject(desk, resolvedChild.canonicalRoot);
    await workdeskService.registerPortableProject(desk, childBoundary.projectIdentity);
    await workdeskService.registerProjectPath(desk, childBoundary);

    await fs.writeFile(join(desk.canonicalRoot, "memo.md"), "parent v1\n", "utf8");
    const exclusions = await workdeskService.historyExcludedChildDirectories(desk.canonicalRoot, desk.identity);
    const captured = await import("./repository-filesystem.js").then(({ captureWorkingTree }) => captureWorkingTree(desk.canonicalRoot, { excludedDirectories: exclusions }));
    expect(captured.files.map((file) => file.path)).not.toContain(`projects/${childBoundary.canonicalRoot.split(/[\\/]/u).pop()}/manuscript.md`);
    expect(captured.files.some((file) => file.path === ".git" || file.path.includes("/.git/"))).toBe(false);
    const firstSnapshot = await service.createHistoryForOwner(workdeskOwner, workdesk.repository.repositoryId);
    if (firstSnapshot.kind === "error") throw new Error(`${firstSnapshot.code}: ${firstSnapshot.message}`);
    expect(firstSnapshot.created).toBe(true);

    await fs.writeFile(join(childBoundary.canonicalRoot, "manuscript.md"), "child only change\n", "utf8");
    expect(snapshot(await service.createHistoryForOwner(workdeskOwner, workdesk.repository.repositoryId)).created).toBe(false);
  });

  test("fails closed when a nested Workdesk Project is not registered consistently", async () => {
    const parent = await fs.mkdtemp(join(tmpdir(), "maginalia-workdesk-history-unsafe-"));
    roots.push(parent);
    const workdeskService = new WorkdeskService(new FileWorkdeskPathStore(join(parent, "app-local-workdesk-state.json")));
    const service = new LocalRepositoryService({
      workdeskHistoryExclusionResolver: (root, identity) => workdeskService.historyExcludedChildDirectories(root, identity),
    });
    const owner = {};
    const deskOpened = opened(await service.createForOwner(owner, parent, "workbench", "Desk"));
    const deskResolved = await service.resolveForOwner(owner, deskOpened.repository.repositoryId);
    expect(deskResolved.kind).toBe("resolved");
    if (deskResolved.kind !== "resolved") throw new Error("Expected Workdesk root");
    await fs.mkdir(join(deskResolved.canonicalRoot, "projects"));
    const child = opened(await service.createForOwner({}, join(deskResolved.canonicalRoot, "projects"), "project", "Unregistered"));
    expect(child.repository.kind).toBe("project");

    await expect(service.createHistoryForOwner(owner, deskOpened.repository.repositoryId)).resolves.toMatchObject({ kind: "error" });
  });

  test("creates changed and unchanged snapshots and lists newest-first without exposing Git data", async () => {
    const owner = {};
    const service = new LocalRepositoryService({
      uuidFactory: sequenceFactory([
        IDS.project,
        "10000000-0000-4000-8000-000000000001",
        "20000000-0000-4000-8000-000000000001",
        "20000000-0000-4000-8000-000000000002",
        "20000000-0000-4000-8000-000000000003",
        "20000000-0000-4000-8000-000000000004",
      ]),
    });
    const { root, repositoryId } = await makeRepository(service, owner, "project", "履歴の文書", IDS.project);

    const unchanged = snapshot(await service.createHistoryForOwner(owner, repositoryId));
    expect(unchanged.created).toBe(false);
    expect(Object.keys(unchanged).sort()).toEqual(["created", "kind", "latest", "repositoryId"]);
    expect(Object.keys(unchanged.latest).sort()).toEqual(["historyId", "timestampMs"]);

    const manuscript = join(root, "manuscript.md");
    await fs.writeFile(manuscript, "保存した変更\r\n", "utf8");
    const changed = snapshot(await service.createHistoryForOwner(owner, repositoryId));
    expect(changed.created).toBe(true);

    const listed = listing(await service.listHistoryForOwner(owner, repositoryId));
    expect(listed.entries).toHaveLength(2);
    expect(listed.entries[0]?.historyId).not.toBe(listed.entries[1]?.historyId);
    expect(listed.entries.every((entry) => /^[0-9a-f-]{36}$/i.test(entry.historyId))).toBe(true);
    expect(listed.entries.every((entry) => Number.isSafeInteger(entry.timestampMs))).toBe(true);
    const internal = await localHistory.listLocalHistory(root);
    expect(internal.entries).toHaveLength(2);
    const serialized = JSON.stringify(listed);
    for (const entry of internal.entries) expect(serialized).not.toContain(entry.oid);
    expect(serialized).not.toMatch(/message|author|email|paths|files|head|index|git/i);

    expect(await service.resolveHistoryForOwner(owner, repositoryId, listed.entries[0]!.historyId))
      .toMatchObject({ kind: "resolved", oid: internal.entries[0]!.oid });
    expect(await service.resolveHistoryForOwner(owner, repositoryId, unchanged.latest.historyId))
      .toMatchObject({ kind: "error", code: "history-not-found" });
  });

  test("does not publish new History handles when the post-snapshot head disagrees", async () => {
    const owner = {};
    const service = new LocalRepositoryService({
      uuidFactory: sequenceFactory([
        IDS.project,
        "10000000-0000-4000-8000-000000000040",
        "20000000-0000-4000-8000-000000000040",
      ]),
    });
    const { root, repositoryId } = await makeRepository(service, owner, "project", "Head check", IDS.project);
    const existing = listing(await service.listHistoryForOwner(owner, repositoryId));
    const existingHistoryId = existing.entries[0]!.historyId;
    const actualList = localHistory.listLocalHistory;
    const listSpy = vi.spyOn(localHistory, "listLocalHistory").mockImplementation(async (listRoot, limit, options) => {
      const actual = await actualList(listRoot, limit, options);
      return Object.freeze({
        entries: Object.freeze([
          Object.freeze({ oid: "0".repeat(40), timestampMs: actual.entries[0]!.timestampMs }),
          ...actual.entries.slice(1),
        ]),
        truncated: actual.truncated,
      });
    });
    try {
      await expect(service.createHistoryForOwner(owner, repositoryId)).resolves.toMatchObject({
        kind: "error",
        code: "changed",
      });
    } finally {
      listSpy.mockRestore();
    }
    expect(await service.resolveHistoryForOwner(owner, repositoryId, existingHistoryId))
      .toMatchObject({ kind: "resolved" });
  });

  test("does not save or mutate authored/index/ref bytes while listing", async () => {
    const owner = {};
    const service = new LocalRepositoryService({
      uuidFactory: sequenceFactory([
        IDS.workbench,
        "10000000-0000-4000-8000-000000000002",
        "20000000-0000-4000-8000-000000000010",
      ]),
    });
    const { root, repositoryId } = await makeRepository(service, owner, "workbench", "一覧", IDS.workbench);
    const files = [
      join(root, "manuscript.md"),
      join(root, ".git", "index"),
      join(root, ".git", "refs", "heads", "main"),
    ];
    const before = await Promise.all(files.map((file) => fs.readFile(file)));
    const listed = listing(await service.listHistoryForOwner(owner, repositoryId));
    expect(listed.entries).toHaveLength(1);
    const after = await Promise.all(files.map((file) => fs.readFile(file)));
    expect(after).toEqual(before);
  });

  test("rejects guessed, stale, cross-owner, and cross-repository handles", async () => {
    const ownerA = {};
    const ownerB = {};
    const service = new LocalRepositoryService({
      uuidFactory: sequenceFactory([
        IDS.project,
        "10000000-0000-4000-8000-000000000020",
        IDS.shelf,
        "10000000-0000-4000-8000-000000000021",
        "20000000-0000-4000-8000-000000000020",
        "20000000-0000-4000-8000-000000000021",
        "20000000-0000-4000-8000-000000000022",
      ]),
    });
    const first = await makeRepository(service, ownerA, "project", "A", IDS.project);
    const second = await makeRepository(service, ownerB, "shelf", "B", IDS.shelf);
    const firstListing = listing(await service.listHistoryForOwner(ownerA, first.repositoryId));
    const secondListing = listing(await service.listHistoryForOwner(ownerB, second.repositoryId));
    const firstHistoryId = firstListing.entries[0]!.historyId;
    const secondHistoryId = secondListing.entries[0]!.historyId;

    expect(await service.resolveHistoryForOwner(ownerA, first.repositoryId, "not-a-history-id"))
      .toMatchObject({ kind: "error", code: "invalid-history-id" });
    expect(await service.resolveHistoryForOwner(ownerB, first.repositoryId, firstHistoryId))
      .toMatchObject({ kind: "error", code: "repository-not-owned" });
    expect(await service.resolveHistoryForOwner(ownerA, second.repositoryId, secondHistoryId))
      .toMatchObject({ kind: "error", code: "repository-not-owned" });

    const ownerASecond = await service.openForOwner(ownerA, first.root);
    expect(ownerASecond.kind).toBe("opened");
    if (ownerASecond.kind === "opened") {
      expect(await service.resolveHistoryForOwner(ownerA, first.repositoryId, firstHistoryId))
        .toMatchObject({ kind: "error", code: "repository-not-owned" });
    }
  });

  test("revalidates the repository before resolving a saved version", async () => {
    const owner = {};
    const service = new LocalRepositoryService({
      uuidFactory: sequenceFactory([
        IDS.project,
        "10000000-0000-4000-8000-000000000030",
        "20000000-0000-4000-8000-000000000030",
      ]),
    });
    const { root, repositoryId } = await makeRepository(service, owner, "project", "Revalidate", IDS.project);
    const listed = listing(await service.listHistoryForOwner(owner, repositoryId));
    const identityPath = join(root, "project.magi");
    const original = await fs.readFile(identityPath);
    await fs.writeFile(
      identityPath,
      Buffer.from(original).toString("utf8").replace(IDS.project, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      "utf8",
    );
    expect(await service.resolveHistoryForOwner(owner, repositoryId, listed.entries[0]!.historyId))
      .toMatchObject({ kind: "error", code: "invalid-identity" });
  });
});
