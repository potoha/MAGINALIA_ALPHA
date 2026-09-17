import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as git from "isomorphic-git";
import { afterEach, describe, expect, test } from "vitest";
import { createIdentity, templateFiles, type RepositoryIdentity } from "@maginalia/repository-core";
import {
  INCOMPLETE_MARKER,
  MAIN_REF,
  gitFs,
  initializeRepository,
  readLocalHistoryGraph,
} from "./repository-local-history.js";
import { LocalGitStage, stageLocalHistoryGraph } from "./repository-git-stage.js";
import {
  RepositoryGitClassifyError,
  classifyStagedHistory,
} from "./repository-git-classify.js";
import { LocalRepositoryError } from "./repository-local-history.js";

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

async function makeHistoryStage(): Promise<{
  readonly stage: LocalGitStage;
  readonly identity: RepositoryIdentity;
  readonly latest: string;
  readonly older: string;
  readonly initialGraph: Awaited<ReturnType<typeof readLocalHistoryGraph>>;
}> {
  const source = await fs.mkdtemp(join(tmpdir(), "maginalia-classify-source-"));
  roots.push(source);
  const identity = createIdentity("project", "Classification source", ID);
  await writeFiles(source, templateFiles(identity));
  await fs.writeFile(join(source, INCOMPLETE_MARKER), "publication marker\n", "utf8");
  await initializeRepository(source);
  await fs.unlink(join(source, INCOMPLETE_MARKER));
  const initialGraph = await readLocalHistoryGraph(source);
  await fs.mkdir(join(source, "notes"), { recursive: true });
  await fs.writeFile(join(source, "notes", "second.txt"), "second classification commit\n", "utf8");
  await git.add({ fs: gitFs(), dir: source, filepath: "notes/second.txt" });
  await git.commit({
    fs: gitFs(),
    dir: source,
    message: "classification second commit",
    author: { name: "Classification Fixture", email: "classification@example.invalid" },
    committer: { name: "Classification Fixture", email: "classification@example.invalid" },
  });
  const log = await git.log({ fs: gitFs(), dir: source, ref: MAIN_REF });
  const latest = log[0]?.oid;
  const older = log[1]?.oid;
  expect(latest).toBeDefined();
  expect(older).toBeDefined();
  const graph = await readLocalHistoryGraph(source);
  const parent = await fs.mkdtemp(join(tmpdir(), "maginalia-classify-parent-"));
  roots.push(parent);
  const stage = await stageLocalHistoryGraph(graph, { parentDirectory: parent });
  return { stage, identity, latest: latest!, older: older!, initialGraph };
}

async function setRemote(stage: LocalGitStage, oid: string): Promise<void> {
  await stage.withOwnedDirectory((directory) => git.writeRef({
    fs: gitFs(),
    dir: directory,
    ref: "refs/remotes/maginalia/main",
    value: oid,
    force: true,
  }));
}

async function writeSiblingCommit(
  stage: LocalGitStage,
  parentOid: string,
  message: string,
): Promise<string> {
  return stage.withOwnedDirectory(async (directory) => {
    const parent = await git.readCommit({ fs: gitFs(), dir: directory, oid: parentOid });
    return git.writeCommit({
      fs: gitFs(),
      dir: directory,
      commit: {
        ...parent.commit,
        parent: [parentOid],
        message,
      },
    });
  });
}

function classifyCode(error: unknown): string | undefined {
  if (error instanceof RepositoryGitClassifyError) return error.code;
  if (error instanceof LocalRepositoryError) return error.code;
  return undefined;
}

async function expectCode<T>(promise: Promise<T>, expected: string): Promise<void> {
  try {
    await promise;
    throw new Error("expected rejection");
  } catch (error) {
    expect(classifyCode(error)).toBe(expected);
  }
}

describe("repository-git-classify", () => {
  test("classifies empty remote as local-ahead after local closure validation", async () => {
    const { stage, identity, latest } = await makeHistoryStage();
    const result = await classifyStagedHistory(stage, null, identity);
    expect(result).toEqual({ status: "local-ahead", localHead: latest, remoteHead: null });
    await stage.dispose();
  });

  test.each([
    ["local-ahead", [true, false]],
    ["remote-ahead", [false, true]],
    ["diverged", [false, false]],
  ] as const)("classifies %s after validating both closures", async (status, answers) => {
    const { stage, identity, latest, older } = await makeHistoryStage();
    await setRemote(stage, older);
    const calls: Array<{ readonly dir: string; readonly oid: string; readonly ancestor: string }> = [];
    const pending = [...answers];
    const result = await classifyStagedHistory(stage, older, identity, {
      gitClient: {
        isDescendent: async (input) => {
          calls.push({ dir: input.dir ?? "", oid: input.oid, ancestor: input.ancestor });
          return pending.shift() ?? false;
        },
      },
    });
    expect(result).toEqual({ status, localHead: latest, remoteHead: older });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.oid).toBe(latest);
    expect(calls[0]?.ancestor).toBe(older);
    expect(calls[1]?.oid).toBe(older);
    expect(calls[1]?.ancestor).toBe(latest);
    expect(calls[0]?.dir).toBe(calls[1]?.dir);
    expect(await stage.withOwnedDirectory((directory) => git.resolveRef({ fs: gitFs(), dir: directory, ref: MAIN_REF }))).toBe(latest);
    await stage.dispose();
  });

  test("classifies local-ahead using real isDescendent", async () => {
    const { stage, identity, latest, older } = await makeHistoryStage();
    await setRemote(stage, older);
    const result = await classifyStagedHistory(stage, older, identity);
    expect(result).toEqual({ status: "local-ahead", localHead: latest, remoteHead: older });
    await stage.dispose();
  });

  test("classifies remote-ahead using real isDescendent on a stage-only sibling", async () => {
    const { stage: unusedStage, identity, initialGraph } = await makeHistoryStage();
    await unusedStage.dispose();
    const parent = await fs.mkdtemp(join(tmpdir(), "maginalia-classify-remote-ahead-"));
    roots.push(parent);
    const stage = await stageLocalHistoryGraph(initialGraph, { parentDirectory: parent });
    const remoteHead = await writeSiblingCommit(stage, initialGraph.head, "remote sibling commit");
    await setRemote(stage, remoteHead);

    const result = await classifyStagedHistory(stage, remoteHead, identity);
    expect(result).toEqual({
      status: "remote-ahead",
      localHead: initialGraph.head,
      remoteHead,
    });
    await stage.dispose();
  });

  test("classifies diverged using real isDescendent on stage-only sibling commits", async () => {
    const { stage, identity, latest, older } = await makeHistoryStage();
    const remoteHead = await writeSiblingCommit(stage, older, "remote sibling commit");
    await setRemote(stage, remoteHead);

    const result = await classifyStagedHistory(stage, remoteHead, identity);
    expect(result).toEqual({ status: "diverged", localHead: latest, remoteHead });
    await stage.dispose();
  });

  test("classifies equal heads as synced without an ancestry call", async () => {
    const { stage, identity, latest } = await makeHistoryStage();
    await setRemote(stage, latest);
    let calls = 0;
    const result = await classifyStagedHistory(stage, latest, identity, {
      gitClient: { isDescendent: async () => { calls += 1; return false; } },
    });
    expect(result.status).toBe("synced");
    expect(calls).toBe(0);
    await stage.dispose();
  });

  test("fails closed on foreign identity, ref mismatch, and malformed input", async () => {
    const { stage, identity, latest, older } = await makeHistoryStage();
    await setRemote(stage, older);
    const foreign = createIdentity("workbench", "Foreign", "6ba7b810-9dad-41d1-80b4-00c04fd430c8");
    await expectCode(classifyStagedHistory(stage, older, foreign), "invalid-identity");
    await expectCode(classifyStagedHistory(stage, latest, identity), "REMOTE_REF_CHANGED");
    await expectCode(classifyStagedHistory(stage, latest.toUpperCase(), identity), "INVALID_INPUT");
    await stage.dispose();
  });
});
