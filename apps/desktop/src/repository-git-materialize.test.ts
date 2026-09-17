import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as git from "isomorphic-git";
import { afterEach, describe, expect, test } from "vitest";
import { createIdentity, templateFiles, type RepositoryIdentity } from "@maginalia/repository-core";
import {
  INCOMPLETE_MARKER,
  MAIN_REF,
  LocalRepositoryError,
  gitFs,
  initializeRepository,
  inspectIncompleteRepository,
  readLocalHistoryGraph,
} from "./repository-local-history.js";
import { LocalGitStage, stageLocalHistoryGraph } from "./repository-git-stage.js";
import {
  RepositoryGitMaterializeError,
  materializeRemoteFromStage,
} from "./repository-git-materialize.js";

const roots: string[] = [];
const ID = "550e8400-e29b-41d4-a716-446655440000";
const REMOTE_REF = "refs/remotes/maginalia/main";

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

async function makeFixture(): Promise<{
  readonly source: string;
  readonly identity: RepositoryIdentity;
  readonly initialGraph: Awaited<ReturnType<typeof readLocalHistoryGraph>>;
  readonly stage: LocalGitStage;
  readonly latest: string;
  readonly older: string;
}> {
  const source = await fs.mkdtemp(join(tmpdir(), "maginalia-materialize-remote-source-"));
  roots.push(source);
  const identity = createIdentity("project", "Remote recovery source", ID);
  await writeFiles(source, templateFiles(identity));
  await fs.writeFile(join(source, INCOMPLETE_MARKER), "publication marker\n", "utf8");
  await initializeRepository(source);
  await fs.unlink(join(source, INCOMPLETE_MARKER));
  const initialGraph = await readLocalHistoryGraph(source);
  await fs.mkdir(join(source, "notes"), { recursive: true });
  await fs.writeFile(join(source, "notes", "second.txt"), "local second commit\n", "utf8");
  await git.add({ fs: gitFs(), dir: source, filepath: "notes/second.txt" });
  await git.commit({
    fs: gitFs(),
    dir: source,
    message: "local second commit",
    author: { name: "Recovery Fixture", email: "recovery@example.invalid" },
    committer: { name: "Recovery Fixture", email: "recovery@example.invalid" },
  });
  const log = await git.log({ fs: gitFs(), dir: source, ref: MAIN_REF });
  const latest = log[0]?.oid;
  const older = log[1]?.oid;
  expect(latest).toBeDefined();
  expect(older).toBeDefined();
  const graph = await readLocalHistoryGraph(source);
  const parent = await fs.mkdtemp(join(tmpdir(), "maginalia-materialize-remote-parent-"));
  roots.push(parent);
  const stage = await stageLocalHistoryGraph(graph, { parentDirectory: parent });
  return { source, identity, initialGraph, stage, latest: latest!, older: older! };
}

async function makeDestination(prefix = "maginalia-materialize-remote-destination-"): Promise<string> {
  const destination = await fs.mkdtemp(join(tmpdir(), prefix));
  roots.push(destination);
  await fs.writeFile(join(destination, INCOMPLETE_MARKER), "destination marker\n", "utf8");
  return destination;
}

async function setRemote(stage: LocalGitStage, oid: string): Promise<void> {
  await stage.withOwnedDirectory((directory) => git.writeRef({
    fs: gitFs(),
    dir: directory,
    ref: REMOTE_REF,
    value: oid,
    force: true,
  }));
}

async function writeSiblingCommit(stage: LocalGitStage, parentOid: string, message: string): Promise<string> {
  return stage.withOwnedDirectory(async (directory) => {
    const parent = await git.readCommit({ fs: gitFs(), dir: directory, oid: parentOid });
    return git.writeCommit({
      fs: gitFs(),
      dir: directory,
      commit: { ...parent.commit, parent: [parentOid], message },
    });
  });
}

async function addSecretRemoteCommit(stage: LocalGitStage): Promise<string> {
  return stage.withOwnedDirectory(async (directory) => {
    const current = await git.resolveRef({ fs: gitFs(), dir: directory, ref: MAIN_REF });
    const commit = await git.readCommit({ fs: gitFs(), dir: directory, oid: current });
    const tree = await git.readTree({ fs: gitFs(), dir: directory, oid: commit.commit.tree });
    const secret = await git.writeBlob({
      fs: gitFs(),
      dir: directory,
      blob: new TextEncoder().encode("-----BEGIN PRIVATE KEY-----\n"),
    });
    return git.writeCommit({
      fs: gitFs(),
      dir: directory,
      commit: {
        ...commit.commit,
        parent: [current],
        message: "remote recovery secret fixture",
        tree: await git.writeTree({
          fs: gitFs(),
          dir: directory,
          tree: [...tree.tree, { mode: "100644", path: "credentials.txt", oid: secret, type: "blob" }],
        }),
      },
    });
  });
}

async function sourceSnapshot(source: string): Promise<{ readonly head: string; readonly index: Uint8Array }> {
  return {
    head: await git.resolveRef({ fs: gitFs(), dir: source, ref: MAIN_REF }),
    index: new Uint8Array(await fs.readFile(join(source, ".git", "index"))),
  };
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof LocalRepositoryError || error instanceof RepositoryGitMaterializeError) {
    return error.code;
  }
  return undefined;
}

async function expectCode<T>(promise: Promise<T>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error("expected rejection");
  } catch (error) {
    expect(errorCode(error)).toBe(code);
  }
}

describe("repository-git-materialize", () => {
  test.each(["remote-ahead", "diverged"] as const)(
    "materializes a %s selected remote tip into a fresh marked repository",
    async (relationship) => {
      const fixture = await makeFixture();
      const remoteHead = relationship === "remote-ahead"
        ? await writeSiblingCommit(fixture.stage, fixture.stage.head, "remote ahead commit")
        : await writeSiblingCommit(fixture.stage, fixture.older, "diverged remote commit");
      await setRemote(fixture.stage, remoteHead);
      const destination = await makeDestination();
      const sourceBefore = await sourceSnapshot(fixture.source);

      const result = await materializeRemoteFromStage(
        fixture.stage,
        remoteHead,
        fixture.identity,
        destination,
      );

      expect(result.head).toBe(remoteHead);
      expect(result.identity).toEqual(fixture.identity);
      expect(await git.resolveRef({ fs: gitFs(), dir: destination, ref: MAIN_REF })).toBe(remoteHead);
      expect(await git.listRefs({ fs: gitFs(), dir: destination, filepath: "refs" })).toEqual(["heads/main"]);
      expect(await fs.readdir(destination)).toContain(INCOMPLETE_MARKER);
      expect(await fs.readFile(join(destination, INCOMPLETE_MARKER), "utf8")).toBe("destination marker\n");
      expect(await fs.readFile(join(destination, ".git", "config"), "utf8")).not.toContain("maginalia");
      await expect(
        git.resolveRef({ fs: gitFs(), dir: destination, ref: REMOTE_REF }),
      ).rejects.toBeDefined();
      const sourceAfter = await sourceSnapshot(fixture.source);
      expect(sourceAfter.head).toBe(sourceBefore.head);
      expect(Buffer.from(sourceAfter.index)).toEqual(Buffer.from(sourceBefore.index));
      expect(await fixture.stage.withOwnedDirectory((directory) => git.resolveRef({
        fs: gitFs(),
        dir: directory,
        ref: MAIN_REF,
      }))).toBe(fixture.stage.head);
      expect(await fixture.stage.withOwnedDirectory((directory) => git.resolveRef({
        fs: gitFs(),
        dir: directory,
        ref: REMOTE_REF,
      }))).toBe(remoteHead);
      await fixture.stage.dispose();
    },
  );

  test("rejects wrong identity before destination initialization", async () => {
    const fixture = await makeFixture();
    const remoteHead = await writeSiblingCommit(fixture.stage, fixture.older, "remote identity fixture");
    await setRemote(fixture.stage, remoteHead);
    const destination = await makeDestination();
    const foreign = createIdentity("workbench", "Foreign recovery", "6ba7b810-9dad-41d1-80b4-00c04fd430c8");

    await expectCode(materializeRemoteFromStage(fixture.stage, remoteHead, foreign, destination), "invalid-identity");
    expect(await fs.readdir(destination)).toEqual([INCOMPLETE_MARKER]);
    await fixture.stage.dispose();
  });

  test("rejects a missing fetched object before destination initialization", async () => {
    const fixture = await makeFixture();
    const remoteHead = await writeSiblingCommit(fixture.stage, fixture.older, "remote missing object fixture");
    await setRemote(fixture.stage, remoteHead);
    await fixture.stage.withOwnedDirectory(async (directory) => {
      await fs.unlink(join(directory, ".git", "objects", remoteHead.slice(0, 2), remoteHead.slice(2)));
    });
    const destination = await makeDestination();

    await expectCode(materializeRemoteFromStage(fixture.stage, remoteHead, fixture.identity, destination), "unsafe-tree");
    expect(await fs.readdir(destination)).toEqual([INCOMPLETE_MARKER]);
    await fixture.stage.dispose();
  });

  test("rejects a historical secret before destination initialization", async () => {
    const fixture = await makeFixture();
    const remoteHead = await addSecretRemoteCommit(fixture.stage);
    await setRemote(fixture.stage, remoteHead);
    const destination = await makeDestination();

    await expectCode(materializeRemoteFromStage(fixture.stage, remoteHead, fixture.identity, destination), "unsafe-secret");
    expect(await fs.readdir(destination)).toEqual([INCOMPLETE_MARKER]);
    await fixture.stage.dispose();
  });

  test("rejects a remote ref mismatch before destination initialization", async () => {
    const fixture = await makeFixture();
    await setRemote(fixture.stage, fixture.older);
    const destination = await makeDestination();
    const wrongExpected = "1".repeat(40);

    await expectCode(materializeRemoteFromStage(fixture.stage, wrongExpected, fixture.identity, destination), "REMOTE_REF_CHANGED");
    expect(await fs.readdir(destination)).toEqual([INCOMPLETE_MARKER]);
    await fixture.stage.dispose();
  });

  test("rejects occupied and nested destinations without overwriting marker/payload", async () => {
    const occupiedFixture = await makeFixture();
    const occupiedHead = await writeSiblingCommit(occupiedFixture.stage, occupiedFixture.older, "occupied destination fixture");
    await setRemote(occupiedFixture.stage, occupiedHead);
    const occupied = await makeDestination();
    await fs.writeFile(join(occupied, "payload.txt"), "must remain\n", "utf8");
    await expectCode(
      materializeRemoteFromStage(occupiedFixture.stage, occupiedHead, occupiedFixture.identity, occupied),
      "target-exists",
    );
    expect(await fs.readFile(join(occupied, "payload.txt"), "utf8")).toBe("must remain\n");
    expect(await fs.readdir(occupied)).toContain(INCOMPLETE_MARKER);
    await occupiedFixture.stage.dispose();

    const nestedFixture = await makeFixture();
    const nestedHead = await writeSiblingCommit(nestedFixture.stage, nestedFixture.older, "nested destination fixture");
    await setRemote(nestedFixture.stage, nestedHead);
    let nested = "";
    await nestedFixture.stage.withOwnedDirectory(async (directory) => {
      nested = join(directory, "nested-destination");
      await fs.mkdir(nested);
      await fs.writeFile(join(nested, INCOMPLETE_MARKER), "nested marker\n", "utf8");
    });
    await expectCode(
      materializeRemoteFromStage(nestedFixture.stage, nestedHead, nestedFixture.identity, nested),
      "unsafe-path",
    );
    expect(await fs.readdir(nested)).toEqual([INCOMPLETE_MARKER]);
    await nestedFixture.stage.dispose();
  });

  test("keeps the marker after an injected mid-copy failure", async () => {
    const fixture = await makeFixture();
    const remoteHead = await writeSiblingCommit(fixture.stage, fixture.older, "mid-copy failure fixture");
    await setRemote(fixture.stage, remoteHead);
    const destination = await makeDestination();

    await expectCode(
      materializeRemoteFromStage(fixture.stage, remoteHead, fixture.identity, destination, {
        testFailurePoint: "after-object-write",
      }),
      "io-error",
    );
    expect(await fs.readdir(destination)).toContain(INCOMPLETE_MARKER);
    await fixture.stage.dispose();
  });
});
