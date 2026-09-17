import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as git from "isomorphic-git";
import type { PrePushParams } from "isomorphic-git";
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
import type { VerifiedPrivateRemote } from "./repository-github.js";
import { RepositoryGitHttpError } from "./repository-git-http.js";
import {
  RepositoryGitPushError,
  pushStageToRemote,
  type RepositoryGitPushOptions,
} from "./repository-git-push.js";

const roots: string[] = [];
const ID = "550e8400-e29b-41d4-a716-446655440000";
const ZERO_OID = "0".repeat(40);

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

async function makeStage(): Promise<{
  readonly stage: LocalGitStage;
  readonly identity: RepositoryIdentity;
  readonly older: string;
}> {
  const source = await fs.mkdtemp(join(tmpdir(), "maginalia-push-source-"));
  roots.push(source);
  const identity = createIdentity("project", "Push source", ID);
  await writeFiles(source, templateFiles(identity));
  await fs.writeFile(join(source, INCOMPLETE_MARKER), "publication marker\n", "utf8");
  await initializeRepository(source);
  await fs.unlink(join(source, INCOMPLETE_MARKER));
  await fs.mkdir(join(source, "notes"), { recursive: true });
  await fs.writeFile(join(source, "notes", "second.txt"), "second push commit\n", "utf8");
  await git.add({ fs: gitFs(), dir: source, filepath: "notes/second.txt" });
  await git.commit({
    fs: gitFs(),
    dir: source,
    message: "push second commit",
    author: { name: "Push Fixture", email: "push@example.invalid" },
    committer: { name: "Push Fixture", email: "push@example.invalid" },
  });
  const log = await git.log({ fs: gitFs(), dir: source, ref: MAIN_REF });
  const latest = log[0]?.oid;
  const older = log[1]?.oid;
  expect(latest).toBeDefined();
  expect(older).toBeDefined();
  const graph = await readLocalHistoryGraph(source);
  const parent = await fs.mkdtemp(join(tmpdir(), "maginalia-push-parent-"));
  roots.push(parent);
  const stage = await stageLocalHistoryGraph(graph, { parentDirectory: parent });
  return { stage, identity, older: older! };
}

async function setTracking(stage: LocalGitStage, oid: string): Promise<void> {
  await stage.withOwnedDirectory((directory) => git.writeRef({
    fs: gitFs(),
    dir: directory,
    ref: "refs/remotes/maginalia/main",
    value: oid,
    force: true,
  }));
}

type PushInput = Parameters<typeof git.push>[0];

function acceptedResult(): Awaited<ReturnType<typeof git.push>> {
  return {
    ok: true,
    error: null,
    refs: {
      "refs/heads/main": { ok: true, error: "" },
    },
  };
}

function validPrePush(
  stage: LocalGitStage,
  expectedRemoteHead: string | null,
): PrePushParams {
  return {
    remote: "maginalia",
    url: remote().url,
    localRef: { ref: "refs/heads/main", oid: stage.head },
    remoteRef: { ref: "refs/heads/main", oid: expectedRemoteHead ?? ZERO_OID },
  };
}

function mockPush(
  calls: PushInput[],
  behavior?: (input: PushInput) => Promise<void>,
): Pick<typeof git, "push"> {
  return {
    push: async (input) => {
      calls.push(input);
      await behavior?.(input);
      return acceptedResult();
    },
  };
}

function expectPushError(error: unknown, code: string, uncertain?: boolean): void {
  expect(error).toBeInstanceOf(RepositoryGitPushError);
  expect((error as RepositoryGitPushError).code).toBe(code);
  if (uncertain !== undefined) expect((error as RepositoryGitPushError).uncertain).toBe(uncertain);
}

async function runPush(
  stage: LocalGitStage,
  expectedRemoteHead: string | null,
  options: RepositoryGitPushOptions,
) {
  return pushStageToRemote(stage, remote(), "ephemeral-push-token", expectedRemoteHead, options);
}

describe("repository-git-push", () => {
  test("submits only stage main with an exact null-remote CAS callback", async () => {
    const { stage } = await makeStage();
    const calls: PushInput[] = [];
    let callbackParams: PrePushParams | undefined;
    const result = await runPush(stage, null, {
      gitClient: mockPush(calls, async (input) => {
        expect(typeof input.onPrePush).toBe("function");
        callbackParams = validPrePush(stage, null);
        await input.onPrePush!(callbackParams);
      }),
    });

    expect(result).toEqual({ status: "submitted" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      dir: await stage.withOwnedDirectory(async (directory) => directory),
      url: remote().url,
      remote: "maginalia",
      ref: "main",
      remoteRef: "refs/heads/main",
      force: false,
    });
    expect(calls[0]).not.toHaveProperty("tags");
    expect(calls[0]).not.toHaveProperty("delete");
    expect(calls[0]).not.toHaveProperty("corsProxy");
    expect(callbackParams?.remoteRef.oid).toBe(ZERO_OID);
    await stage.dispose();
  });

  test("submits a nonempty remote only when the stage tracking ref is pinned", async () => {
    const { stage, older } = await makeStage();
    await setTracking(stage, older);
    const calls: PushInput[] = [];
    const result = await runPush(stage, older, {
      gitClient: mockPush(calls, async (input) => {
        await input.onPrePush!(validPrePush(stage, older));
      }),
    });
    expect(result).toEqual({ status: "submitted" });
    expect(calls).toHaveLength(1);
    await stage.dispose();
  });

  test("allows isomorphic-git to advance the stage tracking ref after acceptance", async () => {
    const { stage, older } = await makeStage();
    await setTracking(stage, older);
    const calls: PushInput[] = [];
    const result = await runPush(stage, older, {
      gitClient: mockPush(calls, async (input) => {
        await input.onPrePush!(validPrePush(stage, older));
        await setTracking(stage, stage.head);
      }),
    });
    expect(result).toEqual({ status: "submitted" });
    expect(await stage.withOwnedDirectory((directory) => git.resolveRef({
      fs: gitFs(),
      dir: directory,
      ref: "refs/remotes/maginalia/main",
    }))).toBe(stage.head);
    await stage.dispose();
  });

  test.each([
    ["remote", (value: PrePushParams) => ({ ...value, remote: "other" })],
    ["url", (value: PrePushParams) => ({ ...value, url: "https://github.com/other/repo.git" })],
    ["local ref", (value: PrePushParams) => ({ ...value, localRef: { ...value.localRef, ref: "refs/heads/dev" } })],
    ["local oid", (value: PrePushParams) => ({ ...value, localRef: { ...value.localRef, oid: ZERO_OID } })],
    ["remote ref", (value: PrePushParams) => ({ ...value, remoteRef: { ...value.remoteRef, ref: "refs/heads/dev" } })],
    ["remote oid", (value: PrePushParams) => ({ ...value, remoteRef: { ...value.remoteRef, oid: ZERO_OID } })],
  ] as const)("rejects a pre-push %s mismatch before the mocked pack", async (_label, alter) => {
    const { stage, older } = await makeStage();
    await setTracking(stage, older);
    const calls: PushInput[] = [];
    let packAttempted = false;
    try {
      await runPush(stage, older, {
        gitClient: mockPush(calls, async (input) => {
          const params = alter(validPrePush(stage, older));
          await input.onPrePush!(params);
          packAttempted = true;
        }),
      });
      throw new Error("expected pre-push rejection");
    } catch (error) {
      expectPushError(error, "PRE_PUSH_MISMATCH", false);
    }
    expect(packAttempted).toBe(false);
    expect(calls).toHaveLength(1);
    await stage.dispose();
  });

  test("rejects a missing or repeated pre-push callback", async () => {
    const missing = await makeStage();
    await setTracking(missing.stage, missing.older);
    const missingCalls: PushInput[] = [];
    try {
      await runPush(missing.stage, missing.older, { gitClient: mockPush(missingCalls) });
      throw new Error("expected missing callback rejection");
    } catch (error) {
      expectPushError(error, "PRE_PUSH_CALLBACK", true);
    }
    await missing.stage.dispose();

    const repeated = await makeStage();
    await setTracking(repeated.stage, repeated.older);
    const repeatedCalls: PushInput[] = [];
    let packAttempted = false;
    try {
      await runPush(repeated.stage, repeated.older, {
        gitClient: mockPush(repeatedCalls, async (input) => {
          await input.onPrePush!(validPrePush(repeated.stage, repeated.older));
          await input.onPrePush!(validPrePush(repeated.stage, repeated.older));
          packAttempted = true;
        }),
      });
      throw new Error("expected repeated callback rejection");
    } catch (error) {
      expectPushError(error, "PRE_PUSH_CALLBACK", false);
    }
    expect(packAttempted).toBe(false);
    await repeated.stage.dispose();
  });

  test("rejects a changed stage main ref after push transport returns", async () => {
    const { stage, older } = await makeStage();
    await setTracking(stage, older);
    const calls: PushInput[] = [];
    try {
      await runPush(stage, older, {
        gitClient: mockPush(calls, async (input) => {
          await input.onPrePush!(validPrePush(stage, older));
          await stage.withOwnedDirectory((directory) => git.writeRef({
            fs: gitFs(),
            dir: directory,
            ref: MAIN_REF,
            value: older,
            force: true,
          }));
        }),
      });
      throw new Error("expected stage ref rejection");
    } catch (error) {
      expectPushError(error, "STAGE_REF_CHANGED", true);
    }
    await stage.dispose();
  });

  test("fails before push when the tracking ref does not match the expected CAS", async () => {
    const { stage, older } = await makeStage();
    const calls: PushInput[] = [];
    try {
      await runPush(stage, older, { gitClient: mockPush(calls) });
      throw new Error("expected tracking ref rejection");
    } catch (error) {
      expectPushError(error, "REMOTE_REF_CHANGED", false);
    }
    expect(calls).toHaveLength(0);
    await stage.dispose();
  });

  test("normalizes auth, cancellation, timeout, network, and unknown failures without token text", async () => {
    const missingToken = await makeStage();
    try {
      await pushStageToRemote(missingToken.stage, remote(), "", null, {
        gitClient: mockPush([]),
      });
      throw new Error("expected auth rejection");
    } catch (error) {
      expectPushError(error, "AUTH_REQUIRED", false);
    }
    await missingToken.stage.dispose();

    const cases: ReadonlyArray<readonly [string, unknown, string]> = [
      ["abort", { name: "AbortError", message: "ephemeral-push-token" }, "ABORTED"],
      ["timeout", { name: "TimeoutError", message: "ephemeral-push-token" }, "TIMEOUT"],
      ["network", new RepositoryGitHttpError("NETWORK_ERROR"), "NETWORK_ERROR"],
      ["unknown", new Error("ephemeral-push-token"), "PUSH_UNKNOWN"],
    ];
    for (const [_label, failure, expected] of cases) {
      const { stage, older } = await makeStage();
      await setTracking(stage, older);
      try {
        await runPush(stage, older, {
          gitClient: mockPush([], async () => { throw failure; }),
        });
        throw new Error("expected push failure");
      } catch (error) {
        expectPushError(error, expected, true);
        expect(JSON.stringify(error)).not.toContain("ephemeral-push-token");
      }
      await stage.dispose();
    }
  });

  test("rejects an invalid verified remote without invoking push", async () => {
    const { stage } = await makeStage();
    const calls: PushInput[] = [];
    try {
      await pushStageToRemote(
        stage,
        { ...remote(), url: "https://github.com/alice/private-repo.git?token=secret" },
        "ephemeral-push-token",
        null,
        { gitClient: mockPush(calls) },
      );
      throw new Error("expected remote rejection");
    } catch (error) {
      expectPushError(error, "INVALID_REMOTE", false);
    }
    expect(calls).toHaveLength(0);
    await stage.dispose();
  });
});
