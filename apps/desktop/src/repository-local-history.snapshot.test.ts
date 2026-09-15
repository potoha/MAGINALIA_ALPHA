import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as git from "isomorphic-git";
import { afterEach, describe, expect, test } from "vitest";
import {
  INCOMPLETE_MARKER,
  MAIN_REF,
  LocalRepositoryError,
  createHistorySnapshot,
  gitFs,
  initializeRepository,
} from "./repository-local-history.js";
import {
  createIdentity,
  templateFiles,
  type RepositoryIdentity,
  type RepositoryKind,
} from "@maginalia/repository-core";

const roots: string[] = [];
const IDS: Record<RepositoryKind, string> = {
  project: "550e8400-e29b-41d4-a716-446655440000",
  workbench: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
  shelf: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
};

afterEach(async () => {
  delete process.env.MAGINALIA_TEST_SNAPSHOT_INTERRUPT;
  delete process.env.MAGINALIA_TEST_SNAPSHOT_PAUSE;
  delete process.env.MAGINALIA_TEST_SNAPSHOT_RESUME;
  delete process.env.MAGINALIA_TEST_SNAPSHOT_PAUSE_READY;
  delete process.env.MAGINALIA_TEST_SNAPSHOT_HEAD_ENOSPC;
  delete process.env.MAGINALIA_TEST_SNAPSHOT_REF_RENAME_FAILURE;
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await fs.rm(root, { recursive: true, force: true });
  }
});

async function makeRoot(kind: RepositoryKind = "project"): Promise<{
  root: string;
  identity: RepositoryIdentity;
}> {
  const root = await fs.mkdtemp(join(tmpdir(), "maginalia-snapshot-"));
  roots.push(root);
  const identity = createIdentity(kind, `Snapshot ${kind}`, IDS[kind]);
  for (const [pathValue, contents] of Object.entries(templateFiles(identity))) {
    const segments = pathValue.split("/");
    let directory = root;
    for (const segment of segments.slice(0, -1)) {
      directory = join(directory, segment);
      await fs.mkdir(directory, { recursive: true });
    }
    await fs.writeFile(join(root, ...segments), contents, "utf8");
  }
  await fs.writeFile(join(root, INCOMPLETE_MARKER), "incomplete fixture\n", "utf8");
  await initializeRepository(root);
  await fs.unlink(join(root, INCOMPLETE_MARKER));
  return { root, identity };
}

function codeOf(error: unknown): string | undefined {
  return error instanceof LocalRepositoryError ? error.code : undefined;
}

async function expectCode<T>(promise: Promise<T>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error("expected rejection");
  } catch (error) {
    expect(codeOf(error)).toBe(code);
  }
}

async function head(root: string): Promise<string> {
  return git.resolveRef({ fs: gitFs(), dir: root, ref: MAIN_REF });
}

async function fileBytes(pathValue: string): Promise<Uint8Array> {
  return new Uint8Array(await fs.readFile(pathValue));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function waitForPause(point: string): Promise<void> {
  for (let attempt = 0; attempt < 400 && process.env.MAGINALIA_TEST_SNAPSHOT_PAUSE_READY !== point; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  expect(process.env.MAGINALIA_TEST_SNAPSHOT_PAUSE_READY).toBe(point);
}

async function readJournal(root: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(join(root, ".git", "maginalia-snapshot.json"), "utf8")) as Record<string, unknown>;
}

async function expectCleanIndex(root: string): Promise<void> {
  const rows = await git.statusMatrix({ fs: gitFs(), dir: root, ref: MAIN_REF, ignored: false, refresh: true });
  expect(rows.every((row) => row[1] === row[3])).toBe(true);
}

async function writeAndSnapshot(root: string, text: string): Promise<Awaited<ReturnType<typeof createHistorySnapshot>>> {
  await fs.writeFile(join(root, "manuscript.md"), text, "utf8");
  return createHistorySnapshot(root);
}

describe("main-only local snapshot publication", () => {
  test("creates a changed snapshot, then reports identical content unchanged", async () => {
    const { root } = await makeRoot();
    const before = await head(root);
    const created = await writeAndSnapshot(root, "新しい本文\r\nsecond line\r\n");
    expect(created.created).toBe(true);
    expect(created.head).not.toBe(before);
    expect(await head(root)).toBe(created.head);
    expect(await fs.readFile(join(root, "manuscript.md"), "utf8")).toBe("新しい本文\r\nsecond line\r\n");
    await expectCleanIndex(root);

    const unchanged = await createHistorySnapshot(root);
    expect(unchanged).toEqual({ head: created.head, fingerprint: created.fingerprint, created: false });
    expect(await head(root)).toBe(created.head);
  });

  test("preserves additions, deletions, and executable mode changes", async () => {
    const { root } = await makeRoot("workbench");
    await fs.writeFile(join(root, "notes", "added.md"), "added\n", "utf8");
    await fs.unlink(join(root, "notes", "README.md"));
    if (process.platform !== "win32") await fs.chmod(join(root, "manuscript.md"), 0o755);
    const result = await createHistorySnapshot(root);
    expect(result.created).toBe(true);
    await expectCleanIndex(root);

    const listed = await git.listFiles({ fs: gitFs(), dir: root });
    expect(listed).toContain("notes/added.md");
    expect(listed).not.toContain("notes/README.md");
    const commit = await git.readCommit({ fs: gitFs(), dir: root, oid: result.head });
    const tree = await git.readTree({ fs: gitFs(), dir: root, oid: commit.commit.tree });
    const notes = tree.tree.find((entry) => entry.path === "notes");
    expect(notes?.type).toBe("tree");
    if (notes?.type === "tree") {
      const notesTree = await git.readTree({ fs: gitFs(), dir: root, oid: notes.oid });
      expect(notesTree.tree.some((entry) => entry.path === "added.md")).toBe(true);
      expect(notesTree.tree.some((entry) => entry.path === "README.md")).toBe(false);
    }
    if (process.platform !== "win32") {
      const manuscript = tree.tree.find((entry) => entry.path === "manuscript.md");
      expect(manuscript?.mode).toBe("100755");
    }
  });

  test("retains tracked descendants under an ignored directory and omits ignored siblings", async () => {
    const { root } = await makeRoot();
    await fs.mkdir(join(root, "dist"));
    await fs.writeFile(join(root, "dist", "kept.txt"), "tracked old\n", "utf8");
    await fs.writeFile(join(root, "dist", "drop.txt"), "ignored sibling\n", "utf8");
    await fs.writeFile(join(root, ".gitignore"), "dist/\n", "utf8");
    await git.add({ fs: gitFs(), dir: root, filepath: ".gitignore" });
    await git.add({ fs: gitFs(), dir: root, filepath: "dist/kept.txt", force: true });
    await git.commit({
      fs: gitFs(),
      dir: root,
      message: "track ignored descendant fixture",
      author: { name: "Fixture", email: "fixture@example.invalid" },
      committer: { name: "Fixture", email: "fixture@example.invalid" },
    });

    await fs.writeFile(join(root, "dist", "kept.txt"), "tracked new\n", "utf8");
    const result = await createHistorySnapshot(root);
    expect(result.created).toBe(true);
    const commit = await git.readCommit({ fs: gitFs(), dir: root, oid: result.head });
    const tree = await git.readTree({ fs: gitFs(), dir: root, oid: commit.commit.tree });
    const dist = tree.tree.find((entry) => entry.path === "dist");
    expect(dist?.type).toBe("tree");
    if (dist?.type === "tree") {
      const distTree = await git.readTree({ fs: gitFs(), dir: root, oid: dist.oid });
      expect(distTree.tree.map((entry) => entry.path)).toEqual(["kept.txt"]);
      expect(await fs.readFile(join(root, "dist", "drop.txt"), "utf8")).toBe("ignored sibling\n");
    }
  });

  test("rejects unsafe content before advancing the head", async () => {
    const { root } = await makeRoot();
    const before = await head(root);
    await fs.writeFile(join(root, ".env"), "TOKEN=not-a-real-secret\n", "utf8");
    await expectCode(createHistorySnapshot(root), "unsafe-secret");
    expect(await head(root)).toBe(before);
    await fs.unlink(join(root, ".env"));
    await fs.writeFile(join(root, "notes", "safe.md"), "still safe\n", "utf8");
    await createHistorySnapshot(root);
    expect(await head(root)).not.toBe(before);
  });

  test("detects a working-tree mutation at the pre-publication boundary", async () => {
    const { root } = await makeRoot();
    const before = await head(root);
    await fs.writeFile(join(root, "manuscript.md"), "candidate\n", "utf8");
    process.env.MAGINALIA_TEST_SNAPSHOT_PAUSE = "before-publication";
    const pending = createHistorySnapshot(root);
    for (let attempt = 0; attempt < 400 && process.env.MAGINALIA_TEST_SNAPSHOT_PAUSE_READY !== "before-publication"; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(process.env.MAGINALIA_TEST_SNAPSHOT_PAUSE_READY).toBe("before-publication");
    await fs.writeFile(join(root, "manuscript.md"), "newer edit\n", "utf8");
    process.env.MAGINALIA_TEST_SNAPSHOT_RESUME = "before-publication";
    await expectCode(pending, "changed");
    expect(await head(root)).toBe(before);
    expect(await fs.readFile(join(root, "manuscript.md"), "utf8")).toBe("newer edit\n");
  });

  test("recovers recognized publication interruptions without changing authored files", async () => {
    for (const point of [
      "after-head-publication",
      "after-index-removal",
      "after-index-install",
      "after-cleanup-old",
    ] as const) {
      const { root } = await makeRoot("shelf");
      await fs.writeFile(join(root, "manuscript.md"), `interrupted ${point}\n`, "utf8");
      const beforeText = await fs.readFile(join(root, "manuscript.md"), "utf8");
      process.env.MAGINALIA_TEST_SNAPSHOT_INTERRUPT = point;
      await expectCode(createHistorySnapshot(root), "io-error");
      expect(await fs.readFile(join(root, "manuscript.md"), "utf8")).toBe(beforeText);
      const recovered = await createHistorySnapshot(root);
      expect(recovered.created).toBe(false);
      expect(await fs.readFile(join(root, "manuscript.md"), "utf8")).toBe(beforeText);
      expect(await fs.access(join(root, ".git", "maginalia-snapshot.json")).then(() => true).catch(() => false)).toBe(false);
      await expectCleanIndex(root);
    }
  });

  test("keeps foreign locks and malformed journals untouched", async () => {
    const { root } = await makeRoot();
    const indexLock = join(root, ".git", "index.lock");
    await fs.writeFile(indexLock, "foreign lock\n", "utf8");
    const beforeLock = await fs.readFile(indexLock, "utf8");
    await expectCode(createHistorySnapshot(root), "unsupported-state");
    expect(await fs.readFile(indexLock, "utf8")).toBe(beforeLock);
    await fs.unlink(indexLock);

    const journal = join(root, ".git", "maginalia-snapshot.json");
    await fs.writeFile(journal, "{}\n", "utf8");
    await expectCode(createHistorySnapshot(root), "unsupported-state");
    expect(await fs.readFile(journal, "utf8")).toBe("{}\n");
  });

  test("serializes concurrent snapshots and cleans the queue after rejection", async () => {
    const { root } = await makeRoot();
    await fs.writeFile(join(root, "manuscript.md"), "serialized\n", "utf8");
    const results = await Promise.all([
      createHistorySnapshot(root),
      createHistorySnapshot(root),
    ]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results[0].head).toBe(results[1].head);
    await expectCleanIndex(root);

    await fs.writeFile(join(root, ".env"), "rejection\n", "utf8");
    await expectCode(createHistorySnapshot(root), "unsafe-secret");
    await fs.unlink(join(root, ".env"));
    await fs.writeFile(join(root, "notes", "after-rejection.md"), "queue remains usable\n", "utf8");
    const after = await createHistorySnapshot(root);
    expect(after.created).toBe(true);
  });

  test("retains a recoverable journal after an injected head publication failure", async () => {
    const { root } = await makeRoot();
    const before = await head(root);
    await fs.writeFile(join(root, "manuscript.md"), "ENOSPC candidate\n", "utf8");
    process.env.MAGINALIA_TEST_SNAPSHOT_HEAD_ENOSPC = "after-temporary-write";
    await expectCode(createHistorySnapshot(root), "io-error");
    expect(await head(root)).toBe(before);
    expect(await fs.access(join(root, ".git", "maginalia-snapshot.json")).then(() => true).catch(() => false)).toBe(true);
    const recovered = await createHistorySnapshot(root);
    expect(recovered.created).toBe(true);
    expect(await fs.readFile(join(root, "manuscript.md"), "utf8")).toBe("ENOSPC candidate\n");
  });

  test("rejects a mode-only staged index change before touching the head or index", async () => {
    const { root } = await makeRoot();
    const beforeHead = await head(root);
    const indexPath = join(root, ".git", "index");
    const manuscriptBytes = await fileBytes(join(root, "manuscript.md"));
    const { oid } = await git.hashBlob({ object: manuscriptBytes });
    await git.updateIndex({
      fs: gitFs(),
      dir: root,
      filepath: "manuscript.md",
      oid,
      mode: 0o100755,
      add: true,
    });
    const stagedIndex = await fileBytes(indexPath);
    await fs.writeFile(join(root, "notes", "unrelated-working-change.md"), "working change\n", "utf8");

    await expectCode(createHistorySnapshot(root), "unsupported-state");
    expect(await head(root)).toBe(beforeHead);
    expect(Buffer.from(await fileBytes(indexPath))).toEqual(Buffer.from(stagedIndex));
    expect(await fs.readFile(join(root, "notes", "unrelated-working-change.md"), "utf8")).toBe("working change\n");
  });

  test("refuses a journal that claims a null new index without mutating recovery state", async () => {
    const { root } = await makeRoot();
    await fs.writeFile(join(root, "manuscript.md"), "null index candidate\n", "utf8");
    process.env.MAGINALIA_TEST_SNAPSHOT_INTERRUPT = "after-head-publication";
    await expectCode(createHistorySnapshot(root), "io-error");

    const journalPath = join(root, ".git", "maginalia-snapshot.json");
    const indexPath = join(root, ".git", "index");
    const originalHead = await head(root);
    const originalIndex = await fileBytes(indexPath);
    const journal = await readJournal(root);
    const artifactNames = (await fs.readdir(join(root, ".git")))
      .filter((name) => name.startsWith("maginalia-snapshot-"));
    const originalArtifacts = new Map<string, Uint8Array>();
    for (const name of artifactNames) {
      originalArtifacts.set(name, await fileBytes(join(root, ".git", name)));
    }
    journal.newIndexPath = null;
    journal.newIndexHash = null;
    journal.newIndexSize = 0;
    const tamperedJournal = `${JSON.stringify(journal)}\n`;
    await fs.writeFile(journalPath, tamperedJournal, "utf8");

    await expectCode(createHistorySnapshot(root), "unsupported-state");
    expect(await head(root)).toBe(originalHead);
    expect(Buffer.from(await fileBytes(indexPath))).toEqual(Buffer.from(originalIndex));
    expect(await fs.readFile(journalPath, "utf8")).toBe(tamperedJournal);
    for (const [name, bytes] of originalArtifacts) {
      expect(Buffer.from(await fileBytes(join(root, ".git", name)))).toEqual(Buffer.from(bytes));
    }
  });

  test("refuses a hash-consistent but commit-inconsistent new index artifact", async () => {
    const { root } = await makeRoot();
    await fs.writeFile(join(root, "manuscript.md"), "inconsistent artifact candidate\n", "utf8");
    process.env.MAGINALIA_TEST_SNAPSHOT_INTERRUPT = "after-head-publication";
    await expectCode(createHistorySnapshot(root), "io-error");

    const indexPath = join(root, ".git", "index");
    const oldIndex = await fileBytes(indexPath);
    const journalPath = join(root, ".git", "maginalia-snapshot.json");
    const journal = await readJournal(root);
    const newIndexName = journal.newIndexPath;
    expect(typeof newIndexName).toBe("string");
    if (typeof newIndexName !== "string") return;
    const newIndexPath = join(root, ".git", newIndexName);
    await fs.writeFile(newIndexPath, oldIndex);
    journal.newIndexHash = sha256(oldIndex);
    journal.newIndexSize = oldIndex.byteLength;
    const tamperedJournal = `${JSON.stringify(journal)}\n`;
    await fs.writeFile(journalPath, tamperedJournal, "utf8");
    const beforeHead = await head(root);

    await expectCode(createHistorySnapshot(root), "unsupported-state");
    expect(await head(root)).toBe(beforeHead);
    expect(Buffer.from(await fileBytes(indexPath))).toEqual(Buffer.from(oldIndex));
    expect(await fs.readFile(journalPath, "utf8")).toBe(tamperedJournal);
    expect(Buffer.from(await fileBytes(newIndexPath))).toEqual(Buffer.from(oldIndex));
  });

  test("retains the journal when the active head changes after publication", async () => {
    const { root } = await makeRoot();
    const oldHead = await head(root);
    await fs.writeFile(join(root, "manuscript.md"), "head race candidate\n", "utf8");
    process.env.MAGINALIA_TEST_SNAPSHOT_PAUSE = "after-head-publication";
    const pending = createHistorySnapshot(root);
    await waitForPause("after-head-publication");
    await fs.writeFile(join(root, ".git", "refs", "heads", "main"), `${oldHead}\n`, "utf8");
    process.env.MAGINALIA_TEST_SNAPSHOT_RESUME = "after-head-publication";

    await expectCode(pending, "changed");
    expect(await head(root)).toBe(oldHead);
    expect(await fs.access(join(root, ".git", "maginalia-snapshot.json")).then(() => true).catch(() => false)).toBe(true);
  });

  test("retains the journal when the live index changes after index publication", async () => {
    const { root } = await makeRoot();
    const oldIndex = await fileBytes(join(root, ".git", "index"));
    await fs.writeFile(join(root, "manuscript.md"), "index race candidate\n", "utf8");
    process.env.MAGINALIA_TEST_SNAPSHOT_PAUSE = "after-index-publication";
    const pending = createHistorySnapshot(root);
    await waitForPause("after-index-publication");
    await fs.writeFile(join(root, ".git", "index"), oldIndex);
    process.env.MAGINALIA_TEST_SNAPSHOT_RESUME = "after-index-publication";

    await expectCode(pending, "changed");
    expect(await fs.access(join(root, ".git", "maginalia-snapshot.json")).then(() => true).catch(() => false)).toBe(true);
    expect(Buffer.from(await fileBytes(join(root, ".git", "index")))).toEqual(Buffer.from(oldIndex));
  });

  test("does not auto-delete a stale operation lock beside a valid journal", async () => {
    const { root } = await makeRoot();
    await fs.writeFile(join(root, "manuscript.md"), "stale lock candidate\n", "utf8");
    process.env.MAGINALIA_TEST_SNAPSHOT_INTERRUPT = "after-head-publication";
    await expectCode(createHistorySnapshot(root), "io-error");

    const operationLock = join(root, ".git", "maginalia-operation.lock");
    const journalPath = join(root, ".git", "maginalia-snapshot.json");
    const indexPath = join(root, ".git", "index");
    const beforeHead = await head(root);
    const beforeIndex = await fileBytes(indexPath);
    const beforeJournal = await fs.readFile(journalPath, "utf8");
    await fs.writeFile(operationLock, "stale operation lock\n", "utf8");

    await expectCode(createHistorySnapshot(root), "unsupported-state");
    expect(await head(root)).toBe(beforeHead);
    expect(Buffer.from(await fileBytes(indexPath))).toEqual(Buffer.from(beforeIndex));
    expect(await fs.readFile(journalPath, "utf8")).toBe(beforeJournal);
    expect(await fs.readFile(operationLock, "utf8")).toBe("stale operation lock\n");
  });

  test("recovers after an actual ref rename failure distinct from ENOSPC", async () => {
    const { root } = await makeRoot();
    const before = await head(root);
    await fs.writeFile(join(root, "manuscript.md"), "rename failure candidate\n", "utf8");
    process.env.MAGINALIA_TEST_SNAPSHOT_REF_RENAME_FAILURE = "before-rename";
    await expectCode(createHistorySnapshot(root), "io-error");
    expect(await head(root)).toBe(before);
    expect(await fs.access(join(root, ".git", "maginalia-snapshot.json")).then(() => true).catch(() => false)).toBe(true);

    const recovered = await createHistorySnapshot(root);
    expect(recovered.created).toBe(true);
    expect(await head(root)).toBe(recovered.head);
    expect(recovered.head).not.toBe(before);
  });
});
