import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as git from "isomorphic-git";
import { afterEach, describe, expect, test } from "vitest";
import { createIdentity, templateFiles } from "@maginalia/repository-core";
import {
  INCOMPLETE_MARKER,
  MAIN_REF,
  gitFs,
  initializeRepository,
  readLocalHistoryGraph,
} from "./repository-local-history.js";
import {
  LocalGitStage,
  stageLocalHistoryGraph,
} from "./repository-git-stage.js";
import {
  RepositoryGitFetchError,
  fetchRemoteIntoStage,
  type StageFetchResult,
} from "./repository-git-fetch.js";
import type { VerifiedPrivateRemote } from "./repository-github.js";

const roots: string[] = [];
const REMOTE_HEAD = "0123456789012345678901234567890123456789";
const OTHER_HEAD = "fedcba9876543210fedcba9876543210fedcba98";

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
  const root = await fs.mkdtemp(join(tmpdir(), "maginalia-fetch-source-"));
  roots.push(root);
  const identity = createIdentity("project", "Fetch source", "550e8400-e29b-41d4-a716-446655440000");
  await writeFiles(root, templateFiles(identity));
  await fs.writeFile(join(root, INCOMPLETE_MARKER), "publication marker\n", "utf8");
  await initializeRepository(root);
  await fs.unlink(join(root, INCOMPLETE_MARKER));
  return root;
}

async function makeParent(): Promise<string> {
  const parent = await fs.mkdtemp(join(tmpdir(), "maginalia-fetch-parent-"));
  roots.push(parent);
  return parent;
}

function remote(): VerifiedPrivateRemote {
  return Object.freeze({
    id: 42,
    nodeId: "R_kgDO42",
    owner: "alice",
    name: "private-repo",
    url: "https://github.com/alice/private-repo.git",
    private: true,
  });
}

async function createStage(): Promise<{ readonly root: string; readonly stage: LocalGitStage; readonly parent: string }> {
  const root = await makeRepository();
  const graph = await readLocalHistoryGraph(root);
  const parent = await makeParent();
  const stage = await stageLocalHistoryGraph(graph, { parentDirectory: parent });
  return { root, stage, parent };
}

function fetchClient(
  fetchHead: string | null,
  calls: Array<Record<string, unknown>>,
): Pick<typeof git, "fetch"> {
  return {
    fetch: async (input) => {
      calls.push(input as unknown as Record<string, unknown>);
      return {
        defaultBranch: "refs/heads/main",
        fetchHead,
        fetchHeadDescription: null,
      };
    },
  };
}

function expectFetchError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(RepositoryGitFetchError);
  expect((error as RepositoryGitFetchError).code).toBe(code);
}

describe("repository-git-fetch", () => {
  test("fetches one exact main ref into the stage and leaves the source untouched", async () => {
    const { root, stage, parent } = await createStage();
    const sourceHead = await git.resolveRef({ fs: gitFs(), dir: root, ref: MAIN_REF });
    const sourceIndex = await fs.readFile(join(root, ".git", "index"));
    const calls: Array<Record<string, unknown>> = [];

    const result = await fetchRemoteIntoStage(
      stage,
      remote(),
      "ephemeral-token-not-for-logging",
      REMOTE_HEAD,
      { gitClient: fetchClient(REMOTE_HEAD, calls) },
    );
    expect(result).toEqual<StageFetchResult>({ remoteHead: REMOTE_HEAD, fetched: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      dir: await stage.withOwnedDirectory(async (directory) => directory),
      url: remote().url,
      remote: "maginalia",
      remoteRef: "refs/heads/main",
      ref: "main",
      singleBranch: true,
      tags: false,
    });
    expect(calls[0]).not.toHaveProperty("depth");
    expect(calls[0]).not.toHaveProperty("corsProxy");
    expect(typeof calls[0]?.http).toBe("object");
    expect(typeof calls[0]?.onAuth).toBe("function");

    const destination = await stage.withOwnedDirectory(async (directory) => directory);
    const config = await fs.readFile(join(destination, ".git", "config"), "utf8");
    expect(config).toContain(`[remote "maginalia"]`);
    expect(config).toContain("\turl = https://github.com/alice/private-repo.git");
    expect(config).toContain("\tfetch = +refs/heads/main:refs/remotes/maginalia/main");
    expect(config).not.toContain("ephemeral-token");
    expect(await git.resolveRef({ fs: gitFs(), dir: destination, ref: MAIN_REF })).toBe(sourceHead);
    expect(await fs.readFile(join(root, ".git", "index"))).toEqual(sourceIndex);
    expect(await git.resolveRef({ fs: gitFs(), dir: root, ref: MAIN_REF })).toBe(sourceHead);
    await stage.dispose();
    expect(parent).toBeTruthy();
  });

  test("does not call Git for the independently probed empty remote", async () => {
    const { stage } = await createStage();
    const calls: Array<Record<string, unknown>> = [];
    const result = await fetchRemoteIntoStage(
      stage,
      remote(),
      "ephemeral-token",
      null,
      { gitClient: fetchClient(REMOTE_HEAD, calls) },
    );
    expect(result).toEqual({ remoteHead: null, fetched: false });
    expect(calls).toHaveLength(0);
    await stage.dispose();
  });

  test("rejects a fetch-head mismatch while retaining a disposable stage", async () => {
    const { stage } = await createStage();
    const calls: Array<Record<string, unknown>> = [];

    try {
      await fetchRemoteIntoStage(stage, remote(), "ephemeral-token", REMOTE_HEAD, {
        gitClient: fetchClient(OTHER_HEAD, calls),
      });
      throw new Error("expected fetch mismatch");
    } catch (error) {
      expectFetchError(error, "REMOTE_HEAD_MISMATCH");
    }
    expect(calls).toHaveLength(1);
    await stage.dispose();
  });

  test("rejects malformed expected heads before invoking Git", async () => {
    const { stage } = await createStage();
    const calls: Array<Record<string, unknown>> = [];
    try {
      await fetchRemoteIntoStage(stage, remote(), "ephemeral-token", OTHER_HEAD.toUpperCase(), {
        gitClient: fetchClient(REMOTE_HEAD, calls),
      });
      throw new Error("expected input rejection");
    } catch (error) {
      expectFetchError(error, "INVALID_INPUT");
    }
    expect(calls).toHaveLength(0);
    await stage.dispose();
  });
});
