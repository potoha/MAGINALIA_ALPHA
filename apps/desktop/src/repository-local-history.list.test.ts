import { promises as fs } from "node:fs";
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
  listLocalHistory,
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
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await fs.rm(root, { recursive: true, force: true });
  }
});

async function makeRepository(kind: RepositoryKind = "project"): Promise<{
  root: string;
  identity: RepositoryIdentity;
}> {
  const root = await fs.mkdtemp(join(tmpdir(), "maginalia-history-list-"));
  roots.push(root);
  const identity = createIdentity(kind, `History ${kind}`, IDS[kind]);
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

async function writeSnapshot(root: string, text: string): Promise<void> {
  await fs.writeFile(join(root, "manuscript.md"), text, "utf8");
  const result = await createHistorySnapshot(root);
  expect(result.created).toBe(true);
}

describe("bounded main-only History listing", () => {
  test("lists the current main chain newest-first with only OID and validated milliseconds", async () => {
    const { root } = await makeRepository();
    const initial = await head(root);
    await writeSnapshot(root, "最初の保存\r\n");
    const middle = await head(root);
    await writeSnapshot(root, "二つ目の保存\r\n");
    const latest = await head(root);

    const listed = await listLocalHistory(root);
    expect(listed.truncated).toBe(false);
    expect(listed.entries.map((entry) => entry.oid)).toEqual([latest, middle, initial]);
    expect(listed.entries.every((entry) => Number.isSafeInteger(entry.timestampMs))).toBe(true);
    for (const entry of listed.entries) {
      expect(Object.keys(entry).sort()).toEqual(["oid", "timestampMs"]);
      expect(entry.oid).toMatch(/^[0-9a-f]{40}$/);
    }

    for (let index = 0; index < listed.entries.length; index += 1) {
      const commit = await git.readCommit({ fs: gitFs(), dir: root, oid: listed.entries[index]!.oid });
      expect(commit.commit.parent.length).toBeLessThanOrEqual(1);
      if (index + 1 < listed.entries.length) {
        expect(commit.commit.parent[0]).toBe(listed.entries[index + 1]!.oid);
      }
    }
  });

  test("bounds results, reports truncation, and rejects invalid limits", async () => {
    const { root } = await makeRepository("workbench");
    await writeSnapshot(root, "保存 1\n");
    await writeSnapshot(root, "保存 2\n");
    const limited = await listLocalHistory(root, 2);
    expect(limited.entries).toHaveLength(2);
    expect(limited.truncated).toBe(true);

    const untruncated = await listLocalHistory(root, 100);
    expect(untruncated.entries).toHaveLength(3);
    expect(untruncated.truncated).toBe(false);

    for (const invalid of [0, -1, 1.5, 101, Number.NaN, Number.POSITIVE_INFINITY, "2", null] as unknown[]) {
      await expectCode(listLocalHistory(root, invalid as number), "limits-exceeded");
    }
  });

  test("does not mutate working or administrative bytes and refuses marker, journal, and locks", async () => {
    const { root } = await makeRepository("shelf");
    const refPath = join(root, ".git", "refs", "heads", "main");
    const indexPath = join(root, ".git", "index");
    const authoredPath = join(root, "README.md");
    const refBefore = await fs.readFile(refPath);
    const indexBefore = await fs.readFile(indexPath);
    const authoredBefore = await fs.readFile(authoredPath);

    await fs.writeFile(join(root, INCOMPLETE_MARKER), "still incomplete\n", "utf8");
    await expectCode(listLocalHistory(root), "incomplete-marker");
    expect(await fs.readFile(refPath)).toEqual(refBefore);
    expect(await fs.readFile(indexPath)).toEqual(indexBefore);
    expect(await fs.readFile(authoredPath)).toEqual(authoredBefore);
    await fs.unlink(join(root, INCOMPLETE_MARKER));

    const journalPath = join(root, ".git", "maginalia-snapshot.json");
    await fs.writeFile(journalPath, "{}\n", "utf8");
    const journalBefore = await fs.readFile(journalPath);
    await expectCode(listLocalHistory(root), "unsupported-state");
    expect(await fs.readFile(journalPath)).toEqual(journalBefore);
    await fs.unlink(journalPath);

    const lockPath = join(root, ".git", "index.lock");
    await fs.writeFile(lockPath, "foreign lock\n", "utf8");
    const lockBefore = await fs.readFile(lockPath);
    await expectCode(listLocalHistory(root), "unsupported-state");
    expect(await fs.readFile(lockPath)).toEqual(lockBefore);
  });

  test("rejects a merge commit instead of returning a nonlinear chain", async () => {
    const { root } = await makeRepository();
    const current = await head(root);
    const currentCommit = await git.readCommit({ fs: gitFs(), dir: root, oid: current });
    const merge = await git.writeCommit({
      fs: gitFs(),
      dir: root,
      commit: {
        tree: currentCommit.commit.tree,
        parent: [current, current],
        message: "fixture merge",
        author: currentCommit.commit.author,
        committer: currentCommit.commit.committer,
      },
    });
    await git.writeRef({ fs: gitFs(), dir: root, ref: MAIN_REF, value: merge, force: true });

    await expectCode(listLocalHistory(root), "unsupported-state");
  });
});
