import { promises as fs } from "node:fs";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    unlinkSync: vi.fn(actual.unlinkSync),
  };
});

import {
  createIdentity,
  storageName,
  type RepositoryIdentity,
  type RepositoryKind,
} from "@maginalia/repository-core";
import {
  INCOMPLETE_MARKER,
  LocalRepositoryService,
  type LocalRepositoryOpened,
  type LocalRepositoryResult,
} from "./repository-service.js";
import {
  gitFs,
  inspectRepository,
  listLocalHistory,
  MAIN_REF,
} from "./repository-local-history.js";
import { DocumentWorkspaceService } from "./document-workspace.js";
import { LibraryService } from "./library-service.js";
import * as git from "isomorphic-git";
import * as localHistory from "./repository-local-history.js";

const roots: string[] = [];
const IDS: Record<RepositoryKind, string> = {
  project: "550e8400-e29b-41d4-a716-446655440000",
  workbench: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
  shelf: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
};

afterEach(async () => {
  delete process.env.MAGINALIA_TEST_MATERIALIZATION_INTERRUPT;
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

function fixedFactory(id: string): () => string {
  let calls = 0;
  return () => {
    calls += 1;
    return calls === 1 ? id : `aaaaaaaa-aaaa-4aaa-8aaa-${String(calls).padStart(12, "0")}`;
  };
}

async function makeParent(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function makeRepository(
  service: LocalRepositoryService,
  owner: object,
  kind: RepositoryKind,
  title: string,
): Promise<{ parent: string; root: string; identity: RepositoryIdentity; repositoryId: string }> {
  const parent = await makeParent("maginalia-history-copy-source-");
  const identity = createIdentity(kind, title, IDS[kind]);
  const result = opened(await service.createForOwner(owner, parent, kind, title));
  return {
    parent,
    root: join(parent, storageName(identity)),
    identity,
    repositoryId: result.repository.repositoryId,
  };
}

async function listDirectories(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
}

async function prepareTwoVersions(
  service: LocalRepositoryService,
  owner: object,
  kind: RepositoryKind,
  title: string,
): Promise<{
  parent: string;
  root: string;
  identity: RepositoryIdentity;
  repositoryId: string;
  oldOid: string;
  latestOid: string;
}> {
  const repository = await makeRepository(service, owner, kind, title);
  const contentPath = kind === "shelf" ? join(repository.root, "books", "old.md") : join(repository.root, "manuscript.md");
  if (kind === "shelf") await fs.mkdir(join(repository.root, "books"), { recursive: true });
  await fs.writeFile(contentPath, "古い版\r\n二行目\r\n", "utf8");
  const old = await service.createHistoryForOwner(owner, repository.repositoryId);
  if (old.kind === "error") throw new Error(`${kind} History snapshot failed: ${old.code} ${old.message}`);
  expect(old.kind).toBe("snapshot");

  await fs.writeFile(contentPath, "最新の版\n", "utf8");
  const latest = await service.createHistoryForOwner(owner, repository.repositoryId);
  expect(latest.kind).toBe("snapshot");
  const listing = await service.listHistoryForOwner(owner, repository.repositoryId);
  expect(listing.kind).toBe("history");
  if (listing.kind !== "history") throw new Error("Expected History listing");
  const internal = await listLocalHistory(repository.root);
  expect(internal.entries).toHaveLength(3);
  return {
    ...repository,
    oldOid: internal.entries[1]!.oid,
    latestOid: internal.entries[0]!.oid,
  };
}

async function snapshotState(
  root: string,
  kind: RepositoryKind,
): Promise<{ head: string; index: Uint8Array; content: Uint8Array }> {
  const contentPath = kind === "shelf" ? join(root, "books", "old.md") : join(root, "manuscript.md");
  return {
    head: await git.resolveRef({ fs: gitFs(), dir: root, ref: MAIN_REF }),
    index: new Uint8Array(await fs.readFile(join(root, ".git", "index"))),
    content: new Uint8Array(await fs.readFile(contentPath)),
  };
}

describe("owner-bound History copy service", () => {
  test.each(["project", "workbench", "shelf"] as const)(
    "materializes a selected historical %s version and publishes a new opaque repository",
    async (kind) => {
      const owner = {};
      const service = new LocalRepositoryService({ uuidFactory: fixedFactory(IDS[kind]) });
      const source = await prepareTwoVersions(service, owner, kind, `履歴コピー ${kind}`);
      const destinationParent = await makeParent("maginalia-history-copy-destination-");
      const sourceBefore = await snapshotState(source.root, kind);
      const listed = await service.listHistoryForOwner(owner, source.repositoryId);
      expect(listed.kind).toBe("history");
      if (listed.kind !== "history") throw new Error("Expected History listing");
      const selectedHistoryId = listed.entries[1]!.historyId;

      const result = opened(await service.openHistoryCopyForOwner(
        owner,
        source.repositoryId,
        selectedHistoryId,
        destinationParent,
      ));
      expect(result.repository.repositoryId).not.toBe(source.repositoryId);
      expect(result.repository.kind).toBe(kind);
      expect(JSON.stringify(result)).not.toContain(source.oldOid);
      expect(JSON.stringify(result)).not.toContain(destinationParent);

      const destinations = await listDirectories(destinationParent);
      expect(destinations).toHaveLength(1);
      const destination = destinations[0]!;
      expect(destination).not.toContain(source.oldOid);
      expect(await fs.access(join(destination, INCOMPLETE_MARKER)).then(() => true).catch(() => false)).toBe(false);
      const copiedInspection = await inspectRepository(destination);
      expect(copiedInspection.head).toBe(source.oldOid);
      expect(copiedInspection.identity.id).toBe(source.identity.id);
      expect(copiedInspection.identity.kind).toBe(kind);
      expect(await fs.readFile(
        kind === "shelf" ? join(destination, "books", "old.md") : join(destination, "manuscript.md"),
        "utf8",
      )).toBe("古い版\r\n二行目\r\n");
      expect(await fs.readFile(
        kind === "shelf" ? join(destination, "books", "old.md") : join(destination, "manuscript.md"),
        "utf8",
      )).not.toContain("最新の版");
      await expect(git.readObject({ fs: gitFs(), dir: destination, oid: source.latestOid, format: "content" }))
        .rejects.toBeDefined();

      const sourceAfter = await snapshotState(source.root, kind);
      expect(sourceAfter.head).toBe(sourceBefore.head);
      expect(Buffer.from(sourceAfter.index)).toEqual(Buffer.from(sourceBefore.index));
      expect(Buffer.from(sourceAfter.content)).toEqual(Buffer.from(sourceBefore.content));
      expect(await service.resolveForOwner(owner, source.repositoryId)).toMatchObject({
        kind: "error",
        code: "repository-not-owned",
      });

      if (kind === "project" || kind === "workbench") {
        const document = new DocumentWorkspaceService();
        const documentResult = await document.openForOwner({}, destination);
        expect(documentResult.kind).toBe("opened");
        document.dispose();
      } else {
        const library = new LibraryService();
        const libraryResult = await library.openForOwner({}, destination);
        expect(libraryResult.kind).toBe("opened");
        library.dispose();
      }
    },
    120_000,
  );

  test("rejects a source/ancestor/descendant destination parent without allocating", async () => {
    const owner = {};
    const service = new LocalRepositoryService({ uuidFactory: fixedFactory(IDS.project) });
    const source = await prepareTwoVersions(service, owner, "project", "境界");
    const history = await service.listHistoryForOwner(owner, source.repositoryId);
    expect(history.kind).toBe("history");
    if (history.kind !== "history") throw new Error("Expected History listing");
    const selected = history.entries[1]!.historyId;
    const inside = join(source.root, "nested");
    await fs.mkdir(inside);
    for (const parent of [source.root, source.parent, inside]) {
      const before = await listDirectories(source.parent);
      expect(await service.openHistoryCopyForOwner(owner, source.repositoryId, selected, parent))
        .toMatchObject({ kind: "error", code: "unsafe-path" });
      expect(await listDirectories(source.parent)).toEqual(before);
    }
  });

  test("keeps an allocated destination marker after materialization failure", async () => {
    const owner = {};
    const service = new LocalRepositoryService({ uuidFactory: fixedFactory(IDS.project) });
    const source = await prepareTwoVersions(service, owner, "project", "失敗コピー");
    const destinationParent = await makeParent("maginalia-history-copy-failure-");
    const history = await service.listHistoryForOwner(owner, source.repositoryId);
    expect(history.kind).toBe("history");
    if (history.kind !== "history") throw new Error("Expected History listing");
    process.env.MAGINALIA_TEST_MATERIALIZATION_INTERRUPT = "after-git-init";
    const result = await service.openHistoryCopyForOwner(
      owner,
      source.repositoryId,
      history.entries[1]!.historyId,
      destinationParent,
    );
    expect(result).toMatchObject({ kind: "error", code: "io-error" });
    const destinations = await listDirectories(destinationParent);
    expect(destinations).toHaveLength(1);
    expect(await fs.access(join(destinations[0]!, INCOMPLETE_MARKER)).then(() => true).catch(() => false)).toBe(true);
    expect(await service.openForOwner({}, destinations[0]!)).toMatchObject({
      kind: "error",
      code: "incomplete-marker",
    });
  });

  test("rejects foreign and stale history handles before selecting a destination", async () => {
    const owner = {};
    const foreignOwner = {};
    const service = new LocalRepositoryService({ uuidFactory: fixedFactory(IDS.project) });
    const source = await prepareTwoVersions(service, owner, "project", "隔離");
    const history = await service.listHistoryForOwner(owner, source.repositoryId);
    expect(history.kind).toBe("history");
    if (history.kind !== "history") throw new Error("Expected History listing");
    const foreignParent = await makeParent("maginalia-history-copy-foreign-");
    const selected = history.entries[1]!.historyId;
    expect(await service.openHistoryCopyForOwner(foreignOwner, source.repositoryId, selected, foreignParent))
      .toMatchObject({ kind: "error", code: "repository-not-owned" });
    expect(await listDirectories(foreignParent)).toEqual([]);

    const replacement = await service.openForOwner(owner, source.root);
    expect(replacement.kind).toBe("opened");
    expect(await service.openHistoryCopyForOwner(owner, source.repositoryId, selected, foreignParent))
      .toMatchObject({ kind: "error", code: "repository-not-owned" });
    expect(await listDirectories(foreignParent)).toEqual([]);
  });

  test("retries a collision without overwriting an existing target, then refuses exhaustion", async () => {
    const owner = {};
    const identity = createIdentity("project", "衝突", IDS.project);
    const fixed = identity.id.replaceAll("-", "");
    const service = new LocalRepositoryService({ uuidFactory: () => identity.id });
    const source = await makeRepository(service, owner, "project", identity.title);
    const history = await service.listHistoryForOwner(owner, source.repositoryId);
    expect(history.kind).toBe("history");
    if (history.kind !== "history") throw new Error("Expected History listing");
    const destinationParent = await makeParent("maginalia-history-copy-collision-");
    const collision = join(destinationParent, `${storageName(identity)}-history-${fixed}`);
    await fs.mkdir(collision);
    await fs.writeFile(join(collision, "keep.txt"), "keep\n", "utf8");

    const result = await service.openHistoryCopyForOwner(
      owner,
      source.repositoryId,
      history.entries[0]!.historyId,
      destinationParent,
    );
    expect(result).toMatchObject({ kind: "error", code: "target-exists" });
    expect(await fs.readFile(join(collision, "keep.txt"), "utf8")).toBe("keep\n");
    expect(await fs.access(join(collision, INCOMPLETE_MARKER)).then(() => true).catch(() => false)).toBe(false);
    expect(await service.resolveForOwner(owner, source.repositoryId)).toMatchObject({ kind: "resolved" });
  });

  test("rejects a linked destination parent without allocating", async () => {
    const owner = {};
    const service = new LocalRepositoryService({ uuidFactory: fixedFactory(IDS.project) });
    const source = await prepareTwoVersions(service, owner, "project", "リンク親");
    const actualParent = await makeParent("maginalia-history-copy-linked-actual-");
    const linkedParent = join(await makeParent("maginalia-history-copy-linked-alias-"), "alias");
    let linked = false;
    try {
      await fs.symlink(actualParent, linkedParent, "junction");
      linked = true;
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code !== "EPERM" && code !== "EACCES" && code !== "ENOTSUP" && code !== "EXDEV" && code !== "EINVAL") {
        throw error;
      }
    }
    if (!linked) return;

    const history = await service.listHistoryForOwner(owner, source.repositoryId);
    expect(history.kind).toBe("history");
    if (history.kind !== "history") throw new Error("Expected History listing");
    const result = await service.openHistoryCopyForOwner(
      owner,
      source.repositoryId,
      history.entries[0]!.historyId,
      linkedParent,
    );
    expect(result).toMatchObject({ kind: "error" });
    expect(["invalid-parent", "parent-not-directory"]).toContain(
      result.kind === "error" ? result.code : undefined,
    );
    expect(await listDirectories(actualParent)).toEqual([]);
  });

  test("does not repair a destination swapped to an alias after allocation", async () => {
    const owner = {};
    const service = new LocalRepositoryService({ uuidFactory: fixedFactory(IDS.project) });
    const source = await prepareTwoVersions(service, owner, "project", "交換");
    const destinationParent = await makeParent("maginalia-history-copy-swap-parent-");
    const outside = await makeParent("maginalia-history-copy-swap-outside-");
    const history = await service.listHistoryForOwner(owner, source.repositoryId);
    expect(history.kind).toBe("history");
    if (history.kind !== "history") throw new Error("Expected History listing");
    const originalMkdir = fs.mkdir.bind(fs);
    let allocated: string | undefined;
    let linked = false;
    const mkdirSpy = vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
      const result = await originalMkdir(...args);
      if (allocated === undefined && typeof args[0] === "string" && args[0].startsWith(destinationParent)) {
        allocated = args[0];
        await fs.rm(allocated, { recursive: true, force: true });
        try {
          await fs.symlink(outside, allocated, "junction");
          linked = true;
        } catch (error) {
          const code = typeof error === "object" && error !== null && "code" in error
            ? (error as { code?: unknown }).code
            : undefined;
          if (code !== "EPERM" && code !== "EACCES" && code !== "ENOTSUP" && code !== "EXDEV" && code !== "EINVAL") {
            throw error;
          }
        }
      }
      return result;
    });
    try {
      const result = await service.openHistoryCopyForOwner(
        owner,
        source.repositoryId,
        history.entries[0]!.historyId,
        destinationParent,
      );
      if (!linked) return;
      expect(result).toMatchObject({ kind: "error", code: "unsafe-path" });
      expect(await fs.access(join(outside, INCOMPLETE_MARKER)).then(() => true).catch(() => false)).toBe(false);
      expect(await service.resolveForOwner(owner, source.repositoryId)).toMatchObject({ kind: "resolved" });
    } finally {
      mkdirSpy.mockRestore();
    }
  });

  test("refuses a destination journal while preserving the marker and source", async () => {
    const owner = {};
    const service = new LocalRepositoryService({ uuidFactory: fixedFactory(IDS.project) });
    const source = await prepareTwoVersions(service, owner, "project", "journal");
    const destinationParent = await makeParent("maginalia-history-copy-journal-");
    const before = await snapshotState(source.root, "project");
    const history = await service.listHistoryForOwner(owner, source.repositoryId);
    expect(history.kind).toBe("history");
    if (history.kind !== "history") throw new Error("Expected History listing");
    const actualInspect = localHistory.inspectIncompleteRepository;
    const inspectSpy = vi.spyOn(localHistory, "inspectIncompleteRepository").mockImplementation(async (root, options) => {
      await fs.writeFile(join(root, ".git", "maginalia-snapshot.json"), "{}", "utf8");
      return actualInspect(root, options);
    });
    try {
      const result = await service.openHistoryCopyForOwner(
        owner,
        source.repositoryId,
        history.entries[0]!.historyId,
        destinationParent,
      );
      expect(result).toMatchObject({ kind: "error", code: "unsupported-state" });
      const destination = (await listDirectories(destinationParent))[0]!;
      expect(await fs.access(join(destination, INCOMPLETE_MARKER)).then(() => true).catch(() => false)).toBe(true);
      await expect(fs.access(join(destination, ".git", "maginalia-snapshot.json")))
        .resolves.toBeUndefined();
      const after = await snapshotState(source.root, "project");
      expect(after.head).toBe(before.head);
      expect(Buffer.from(after.index)).toEqual(Buffer.from(before.index));
      expect(Buffer.from(after.content)).toEqual(Buffer.from(before.content));
    } finally {
      inspectSpy.mockRestore();
    }
  });

  test("keeps the marker when final publication unlink fails", async () => {
    const owner = {};
    const service = new LocalRepositoryService({ uuidFactory: fixedFactory(IDS.project) });
    const source = await prepareTwoVersions(service, owner, "project", "unlink");
    const destinationParent = await makeParent("maginalia-history-copy-unlink-");
    const before = await snapshotState(source.root, "project");
    const history = await service.listHistoryForOwner(owner, source.repositoryId);
    expect(history.kind).toBe("history");
    if (history.kind !== "history") throw new Error("Expected History listing");
    const originalUnlink = nodeFs.unlinkSync.bind(nodeFs);
    let injected = false;
    const unlinkSpy = vi.spyOn(nodeFs, "unlinkSync").mockImplementation((pathValue) => {
      if (!injected && typeof pathValue === "string" && pathValue.endsWith(INCOMPLETE_MARKER)) {
        injected = true;
        const error = new Error("injected unlink failure") as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      }
      return originalUnlink(pathValue);
    });
    try {
      const result = await service.openHistoryCopyForOwner(
        owner,
        source.repositoryId,
        history.entries[0]!.historyId,
        destinationParent,
      );
      expect(result).toMatchObject({ kind: "error", code: "io-error" });
      const destination = (await listDirectories(destinationParent))[0]!;
      expect(await fs.access(join(destination, INCOMPLETE_MARKER)).then(() => true).catch(() => false)).toBe(true);
      const after = await snapshotState(source.root, "project");
      expect(after.head).toBe(before.head);
      expect(Buffer.from(after.index)).toEqual(Buffer.from(before.index));
      expect(Buffer.from(after.content)).toEqual(Buffer.from(before.content));
    } finally {
      unlinkSpy.mockRestore();
    }
  });

  test("does not publish a stale copy across the final History publication boundary", async () => {
    const owner = {};
    const service = new LocalRepositoryService({ uuidFactory: fixedFactory(IDS.project) });
    const source = await prepareTwoVersions(service, owner, "project", "公開境界競合");
    const destinationParent = await makeParent("maginalia-history-copy-publication-race-");
    const history = await service.listHistoryForOwner(owner, source.repositoryId);
    expect(history.kind).toBe("history");
    if (history.kind !== "history") throw new Error("Expected History listing");
    const historyId = history.entries[0]!.historyId;

    const originalPromiseUnlink = fs.unlink.bind(fs);
    const originalSyncUnlink = vi.mocked(nodeFs.unlinkSync).getMockImplementation();
    expect(originalSyncUnlink).toBeDefined();
    let fixedBoundaryEntered = false;
    let asyncBoundaryEntered = false;
    let destination: string | undefined;
    let releaseAsyncUnlink!: () => void;
    const asyncUnlinkRelease = new Promise<void>((resolve) => { releaseAsyncUnlink = resolve; });
    let markAsyncBoundary!: () => void;
    const asyncBoundary = new Promise<void>((resolve) => { markAsyncBoundary = resolve; });
    let copyPromise: Promise<LocalRepositoryResult> | undefined;

    const syncUnlinkSpy = vi.spyOn(nodeFs, "unlinkSync").mockImplementation((pathValue) => {
      const result = originalSyncUnlink!(pathValue);
      if (!fixedBoundaryEntered && typeof pathValue === "string" && pathValue.endsWith(INCOMPLETE_MARKER)) {
        fixedBoundaryEntered = true;
        destination = dirname(pathValue);
        // A synchronous invalidation models a History refresh re-entering the
        // service at the exact publication boundary.  There is no event-loop
        // yield for a real refresh to exploit between unlink and activation.
        service.dispose();
      }
      return result;
    });
    const promiseUnlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (pathValue) => {
      if (!asyncBoundaryEntered && typeof pathValue === "string" && pathValue.endsWith(INCOMPLETE_MARKER)) {
        asyncBoundaryEntered = true;
        destination = dirname(pathValue);
        // Exercise the former awaited-unlink gap when this test is run
        // against the pre-fix implementation: physically remove the marker,
        // expose the staged path, and keep the unlink completion pending.
        await originalPromiseUnlink(pathValue);
        markAsyncBoundary();
        await asyncUnlinkRelease;
        return;
      }
      return originalPromiseUnlink(pathValue);
    });

    try {
      copyPromise = service.openHistoryCopyForOwner(
        owner,
        source.repositoryId,
        historyId,
        destinationParent,
      );
      const boundary = await Promise.race([
        asyncBoundary.then(() => "async" as const),
        copyPromise.then(() => "completed" as const),
      ]);

      if (boundary === "async") {
        expect(asyncBoundaryEntered).toBe(true);
        expect(destination).toBeDefined();

        const replacement = await service.openForOwner(owner, source.root);
        expect(replacement.kind).toBe("opened");
        const refreshed = replacement.kind === "opened"
          ? await service.listHistoryForOwner(owner, replacement.repository.repositoryId)
          : undefined;
        expect(refreshed).toMatchObject({ kind: "history" });
        expect(await service.openHistoryCopyForOwner(owner, source.repositoryId, historyId, destinationParent))
          .toMatchObject({ kind: "error", code: "repository-not-owned" });

        // The old await gap makes this destination externally openable before
        // the stale completion notices the invalidated History session.
        const externallyOpened = await service.openForOwner({}, destination);
        expect(externallyOpened).toMatchObject({ kind: "error", code: "incomplete-marker" });
        releaseAsyncUnlink();
      }

      const result = await copyPromise;
      expect(result).toMatchObject({ kind: "error", code: "changed" });
      expect(fixedBoundaryEntered || asyncBoundaryEntered).toBe(true);
      expect(destination).toBeDefined();
      expect(await fs.access(join(destination!, INCOMPLETE_MARKER)).then(() => true).catch(() => false)).toBe(true);

      if (boundary === "completed") {
        expect(fixedBoundaryEntered).toBe(true);
        expect(asyncBoundaryEntered).toBe(false);
        expect(await service.openForOwner({}, destination)).toMatchObject({
          kind: "error",
          code: "incomplete-marker",
        });
        const replacement = await service.openForOwner(owner, source.root);
        expect(replacement.kind).toBe("opened");
        if (replacement.kind === "opened") {
          expect(await service.listHistoryForOwner(owner, replacement.repository.repositoryId))
            .toMatchObject({ kind: "history" });
        }
      }
    } finally {
      releaseAsyncUnlink();
      await copyPromise?.catch(() => undefined);
      promiseUnlinkSpy.mockRestore();
      syncUnlinkSpy.mockRestore();
    }
  });

  test("rejects a copy when the owner switches repositories while materialization is deferred", async () => {
    const owner = {};
    const service = new LocalRepositoryService({ uuidFactory: fixedFactory(IDS.project) });
    const source = await prepareTwoVersions(service, owner, "project", "競合");
    const destinationParent = await makeParent("maginalia-history-copy-race-");
    const history = await service.listHistoryForOwner(owner, source.repositoryId);
    expect(history.kind).toBe("history");
    if (history.kind !== "history") throw new Error("Expected History listing");
    let release!: () => void;
    const deferred = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const actualMaterialize = localHistory.materializeHistoryCommit;
    const materializeSpy = vi.spyOn(localHistory, "materializeHistoryCommit").mockImplementation(async (...args) => {
      started();
      await deferred;
      return actualMaterialize(...args);
    });
    try {
      const copyPromise = service.openHistoryCopyForOwner(
        owner,
        source.repositoryId,
        history.entries[0]!.historyId,
        destinationParent,
      );
      await startedPromise;
      const replacement = await service.openForOwner(owner, source.root);
      expect(replacement.kind).toBe("opened");
      release();
      await expect(copyPromise).resolves.toMatchObject({ kind: "error", code: "changed" });
      const destination = (await listDirectories(destinationParent))[0]!;
      expect(await fs.access(join(destination, INCOMPLETE_MARKER)).then(() => true).catch(() => false)).toBe(true);
      if (replacement.kind === "opened") {
        expect(await service.resolveForOwner(owner, replacement.repository.repositoryId)).toMatchObject({ kind: "resolved" });
      }
    } finally {
      materializeSpy.mockRestore();
    }
  });
});
