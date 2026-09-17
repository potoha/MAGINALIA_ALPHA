import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as git from "isomorphic-git";
import { afterEach, describe, expect, test } from "vitest";
import {
  INCOMPLETE_MARKER,
  MAIN_REF,
  LocalRepositoryError,
  gitFs,
  initializeRepository,
  readLocalHistoryGraph,
  validateLocalHistoryGraphAtRoot,
} from "./repository-local-history.js";
import { LocalGitStage, stageLocalHistoryGraph } from "./repository-git-stage.js";
import {
  RepositoryGitValidateError,
  validateFetchedStageHistory,
} from "./repository-git-validate.js";
import { createIdentity, templateFiles, type RepositoryIdentity } from "@maginalia/repository-core";

const roots: string[] = [];
const REPOSITORY_ID = "550e8400-e29b-41d4-a716-446655440000";

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

async function makeRepository(identity = createIdentity("project", "Validation source", REPOSITORY_ID)): Promise<{
  readonly root: string;
  readonly identity: RepositoryIdentity;
}> {
  const root = await fs.mkdtemp(join(tmpdir(), "maginalia-validate-source-"));
  roots.push(root);
  await writeFiles(root, templateFiles(identity));
  await fs.writeFile(join(root, INCOMPLETE_MARKER), "publication marker\n", "utf8");
  await initializeRepository(root);
  await fs.unlink(join(root, INCOMPLETE_MARKER));
  return { root, identity };
}

async function makeStage(identity?: RepositoryIdentity): Promise<{
  readonly source: string;
  readonly graph: Awaited<ReturnType<typeof readLocalHistoryGraph>>;
  readonly stage: LocalGitStage;
}> {
  const { root: source } = await makeRepository(identity);
  const graph = await readLocalHistoryGraph(source);
  const parent = await fs.mkdtemp(join(tmpdir(), "maginalia-validate-parent-"));
  roots.push(parent);
  const stage = await stageLocalHistoryGraph(graph, { parentDirectory: parent });
  return { source, graph, stage };
}

function codeOf(error: unknown): string | undefined {
  if (error instanceof LocalRepositoryError) return error.code;
  if (error instanceof RepositoryGitValidateError) return error.code;
  return undefined;
}

async function expectCode<T>(promise: Promise<T>, expected: string): Promise<void> {
  try {
    await promise;
    throw new Error("expected rejection");
  } catch (error) {
    expect(codeOf(error)).toBe(expected);
  }
}

function remote(): {
  readonly id: number;
  readonly nodeId: string;
  readonly owner: string;
  readonly name: string;
  readonly url: string;
  readonly private: true;
} {
  return {
    id: 42,
    nodeId: "R_kgDO42",
    owner: "alice",
    name: "private-repo",
    url: "https://github.com/alice/private-repo.git",
    private: true,
  };
}

describe("repository-git-validate", () => {
  test("validates a complete stage closure without an index or worktree", async () => {
    const { graph, stage } = await makeStage();
    const result = await stage.withOwnedDirectory((directory) =>
      validateLocalHistoryGraphAtRoot(directory, graph.head, graph.identity));
    expect(result).toEqual({
      head: graph.head,
      identity: graph.identity,
      objectCount: graph.objects.length,
      objectBytes: graph.objects.reduce((total, object) => total + object.bytes.byteLength, 0),
    });
    await stage.dispose();
  });

  test("rechecks stage main and fetched remote refs before and after validation", async () => {
    const { graph, stage } = await makeStage();
    await stage.withOwnedDirectory(async (directory) => {
      await git.writeRef({ fs: gitFs(), dir: directory, ref: "refs/remotes/maginalia/main", value: graph.head, force: true });
    });
    const result = await validateFetchedStageHistory(stage, graph.head, graph.identity);
    expect(result.head).toBe(graph.head);
    expect(await stage.withOwnedDirectory((directory) => git.resolveRef({ fs: gitFs(), dir: directory, ref: MAIN_REF }))).toBe(stage.head);
    await stage.dispose();
  });

  test("rejects a foreign identity and lower object limits", async () => {
    const { graph, stage } = await makeStage();
    const foreign = createIdentity("workbench", "Foreign", "6ba7b810-9dad-41d1-80b4-00c04fd430c8");
    await stage.withOwnedDirectory((directory) =>
      expectCode(validateLocalHistoryGraphAtRoot(directory, graph.head, foreign), "invalid-identity"));
    await stage.withOwnedDirectory((directory) =>
      expectCode(validateLocalHistoryGraphAtRoot(directory, graph.head, graph.identity, { limits: { maxObjects: 1 } }), "limits-exceeded"));
    await stage.dispose();
  });

  test("rejects a missing object and a secret in historical fetched state", async () => {
    const { graph, stage } = await makeStage();
    const target = graph.objects.find((object) => object.type === "blob");
    expect(target).toBeDefined();
    await stage.withOwnedDirectory(async (directory) => {
      const objectPath = join(directory, ".git", "objects", target!.oid.slice(0, 2), target!.oid.slice(2));
      await fs.unlink(objectPath);
      await expectCode(validateLocalHistoryGraphAtRoot(directory, graph.head, graph.identity), "unsafe-tree");
    });

    const secretFixture = await makeStage();
    const secretHead = await secretFixture.stage.withOwnedDirectory(async (directory) => {
      const currentHead = await git.resolveRef({ fs: gitFs(), dir: directory, ref: MAIN_REF });
      const currentCommit = await git.readCommit({ fs: gitFs(), dir: directory, oid: currentHead });
      const currentTree = await git.readTree({ fs: gitFs(), dir: directory, oid: currentCommit.commit.tree });
      const secretBlob = await git.writeBlob({ fs: gitFs(), dir: directory, blob: new TextEncoder().encode("-----BEGIN PRIVATE KEY-----\n") });
      const secretTree = await git.writeTree({
        fs: gitFs(),
        dir: directory,
        tree: [...currentTree.tree, { mode: "100644", path: "credentials.txt", oid: secretBlob, type: "blob" }],
      });
      const head = await git.writeCommit({
        fs: gitFs(),
        dir: directory,
        commit: { ...currentCommit.commit, tree: secretTree, parent: [currentHead], message: "secret fetched fixture" },
      });
      await git.writeRef({ fs: gitFs(), dir: directory, ref: MAIN_REF, value: currentHead, force: true });
      await git.writeRef({ fs: gitFs(), dir: directory, ref: "refs/remotes/maginalia/main", value: head, force: true });
      return head;
    });
    await expectCode(
      validateFetchedStageHistory(secretFixture.stage, secretHead, secretFixture.graph.identity),
      "unsafe-secret",
    );
    await stage.dispose();
    await secretFixture.stage.dispose();
  });
});
