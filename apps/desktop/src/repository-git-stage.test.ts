import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as git from "isomorphic-git";
import { afterEach, describe, expect, test } from "vitest";
import {
  INCOMPLETE_MARKER,
  MAIN_REF,
  createHistorySnapshot,
  gitFs,
  initializeRepository,
  readLocalHistoryGraph,
} from "./repository-local-history.js";
import {
  LocalGitStage,
  RepositoryGitStageError,
  stageLocalHistoryGraph,
} from "./repository-git-stage.js";
import { createIdentity, templateFiles, type RepositoryKind } from "@maginalia/repository-core";

const roots: string[] = [];
const ID = "550e8400-e29b-41d4-a716-446655440000";

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

async function makeRepository(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), "maginalia-stage-source-"));
  roots.push(root);
  const identity = createIdentity("project" satisfies RepositoryKind, "Stage source", ID);
  await writeFiles(root, templateFiles(identity));
  await fs.writeFile(join(root, INCOMPLETE_MARKER), "publication marker\n", "utf8");
  await initializeRepository(root);
  await fs.unlink(join(root, INCOMPLETE_MARKER));
  return root;
}

async function makeParent(): Promise<string> {
  const parent = await fs.mkdtemp(join(tmpdir(), "maginalia-stage-parent-"));
  roots.push(parent);
  return parent;
}

async function addSecondCommit(root: string): Promise<void> {
  await fs.mkdir(join(root, "notes"), { recursive: true });
  await fs.writeFile(join(root, "notes", "second.txt"), "second version\n", "utf8");
  await git.add({ fs: gitFs(), dir: root, filepath: "notes/second.txt" });
  await git.commit({
    fs: gitFs(),
    dir: root,
    message: "second stage fixture",
    author: { name: "Stage Fixture", email: "stage@example.invalid" },
    committer: { name: "Stage Fixture", email: "stage@example.invalid" },
  });
}

async function stagePath(parent: string): Promise<string> {
  const entries = await fs.readdir(parent, { withFileTypes: true });
  const stage = entries.find((entry) => entry.name.startsWith("maginalia-git-stage-"));
  expect(stage?.isDirectory()).toBe(true);
  return join(parent, stage!.name);
}

function expectStageError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(RepositoryGitStageError);
  expect((error as RepositoryGitStageError).code).toBe(code);
}

describe("repository-git-stage", () => {
  test("imports the complete multi-commit graph with only main and disposes safely", async () => {
    const root = await makeRepository();
    await addSecondCommit(root);
    const sourceHead = await git.resolveRef({ fs: gitFs(), dir: root, ref: MAIN_REF });
    const sourceIndex = await fs.readFile(join(root, ".git", "index"));
    const graph = await readLocalHistoryGraph(root);
    const parent = await makeParent();

    const stage = await stageLocalHistoryGraph(graph, { parentDirectory: parent });
    expect(stage).toBeInstanceOf(LocalGitStage);
    expect(stage.head).toBe(sourceHead);
    expect(stage.objectCount).toBe(graph.objects.length);

    const destination = await stage.withOwnedDirectory(async (directory) => directory);
    expect("owned" in stage).toBe(false);
    expect(destination).toBe(await fs.realpath(await stagePath(parent)));
    expect(await git.resolveRef({ fs: gitFs(), dir: destination, ref: MAIN_REF })).toBe(graph.head);
    expect(await git.listRefs({ fs: gitFs(), dir: destination, filepath: "refs" })).toEqual(["heads/main"]);
    expect(await fs.readdir(destination)).toEqual([".git"]);
    await expect(fs.lstat(join(destination, ".git", "objects", "info", "alternates"))).rejects.toMatchObject({ code: "ENOENT" });

    for (const expected of graph.objects) {
      const actual = await git.readObject({ fs: gitFs(), dir: destination, oid: expected.oid, format: "content" });
      expect(actual.oid).toBe(expected.oid);
      expect(actual.type).toBe(expected.type);
      expect(Buffer.from(actual.object as Uint8Array)).toEqual(Buffer.from(expected.bytes));
    }

    expect(await git.listRefs({ fs: gitFs(), dir: destination, filepath: "refs/heads" })).toEqual(["main"]);
    expect(await fs.readFile(join(root, ".git", "index"))).toEqual(sourceIndex);
    expect(await git.resolveRef({ fs: gitFs(), dir: root, ref: MAIN_REF })).toBe(sourceHead);

    await stage.dispose();
    await stage.dispose();
    await expect(fs.lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects an object whose bytes were tampered after graph export", async () => {
    const root = await makeRepository();
    const graph = await readLocalHistoryGraph(root);
    const first = graph.objects[0]!;
    const tamperedBytes = new Uint8Array(first.bytes);
    tamperedBytes[0] = tamperedBytes[0]! ^ 0xff;
    const tampered = {
      ...graph,
      objects: graph.objects.map((object) => object === first
        ? { ...object, bytes: tamperedBytes }
        : object),
    };
    const parent = await makeParent();

    try {
      await stageLocalHistoryGraph(tampered, { parentDirectory: parent });
      throw new Error("expected staging rejection");
    } catch (error) {
      expectStageError(error, "oid-mismatch");
    }
    expect((await fs.readdir(parent)).filter((name) => name.startsWith("maginalia-git-stage-")).length).toBe(0);
  });

  test("waits for an active directory operation and shares concurrent disposal", async () => {
    const root = await makeRepository();
    const graph = await readLocalHistoryGraph(root);
    const parent = await makeParent();
    const stage = await stageLocalHistoryGraph(graph, { parentDirectory: parent });
    const destination = await stagePath(parent);
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });

    const operation = stage.withOwnedDirectory(async (directory) => {
      entered();
      await releasePromise;
      await fs.lstat(directory);
    });
    await enteredPromise;
    const firstDispose = stage.dispose();
    const secondDispose = stage.dispose();
    expect(secondDispose).toBe(firstDispose);
    let settled = false;
    void firstDispose.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(settled).toBe(false);
    await expect(fs.lstat(destination)).resolves.toBeDefined();

    release();
    await operation;
    await Promise.all([firstDispose, secondDispose]);
    await expect(fs.lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects a valid but unreachable object and leaves no stage", async () => {
    const root = await makeRepository();
    const graph = await readLocalHistoryGraph(root);
    const bytes = new TextEncoder().encode("unreachable stage object\n");
    const oid = await git.writeObject({ fs: gitFs(), dir: root, type: "blob", object: bytes, format: "content" });
    const tampered = {
      ...graph,
      objects: [...graph.objects, { oid, type: "blob" as const, bytes }],
    };
    const parent = await makeParent();

    try {
      await stageLocalHistoryGraph(tampered, { parentDirectory: parent });
      throw new Error("expected staging rejection");
    } catch (error) {
      expectStageError(error, "invalid-graph");
    }
    expect((await fs.readdir(parent)).filter((name) => name.startsWith("maginalia-git-stage-")).length).toBe(0);
  });

  test("rejects over-limit graphs before allocating a stage", async () => {
    const root = await makeRepository();
    const graph = await readLocalHistoryGraph(root);
    const parent = await makeParent();
    const oversized = {
      ...graph,
      objects: Array.from({ length: 100_001 }, () => graph.objects[0]!),
    };

    try {
      await stageLocalHistoryGraph(oversized, { parentDirectory: parent });
      throw new Error("expected staging rejection");
    } catch (error) {
      expectStageError(error, "limits-exceeded");
    }
    expect((await fs.readdir(parent)).length).toBe(0);
  });
});
