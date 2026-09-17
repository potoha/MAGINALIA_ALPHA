import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as git from "isomorphic-git";
import { afterEach, describe, expect, test } from "vitest";
import {
  createIdentity,
  templateFiles,
  type RepositoryIdentity,
} from "@maginalia/repository-core";
import {
  gitFs,
  initializeRepository,
  type LocalHistoryObjectGraph,
} from "./repository-local-history.js";
import {
  preflightCloudLocalState,
  recheckCloudLocalPin,
  RepositoryCloudLocalPreflightError,
} from "./repository-cloud-local-preflight.js";

const MAIN_REF = "refs/heads/main";
const ID = "550e8400-e29b-41d4-a716-446655440000";
const roots: string[] = [];

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

async function makeRepository(): Promise<{ readonly root: string; readonly identity: RepositoryIdentity }> {
  const root = await fs.mkdtemp(join(tmpdir(), "maginalia-cloud-local-preflight-"));
  roots.push(root);
  const identity = createIdentity("project", "Cloud local preflight", ID);
  await writeFiles(root, templateFiles(identity));
  await fs.writeFile(join(root, "MAGINALIA-INCOMPLETE.txt"), "setup marker\n", "utf8");
  await initializeRepository(root);
  await fs.unlink(join(root, "MAGINALIA-INCOMPLETE.txt"));
  return { root: await fs.realpath(root), identity };
}

async function head(root: string): Promise<string> {
  return git.resolveRef({ fs: gitFs(), dir: root, ref: MAIN_REF });
}

async function expectCode(action: () => Promise<unknown>, code: string): Promise<RepositoryCloudLocalPreflightError> {
  let thrown: unknown;
  try {
    await action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RepositoryCloudLocalPreflightError);
  expect((thrown as RepositoryCloudLocalPreflightError).code).toBe(code);
  return thrown as RepositoryCloudLocalPreflightError;
}

describe("cloud local-first preflight", () => {
  test("rejects the dirty guard before snapshot and never reads a graph", async () => {
    const { root, identity } = await makeRepository();
    const before = await head(root);
    let guardCalls = 0;

    await expectCode(
      () => preflightCloudLocalState(root, identity, async () => {
        guardCalls += 1;
        throw new Error("unsaved manuscript");
      }),
      "DIRTY_CONTENT",
    );

    expect(guardCalls).toBe(1);
    expect(await head(root)).toBe(before);
    await expect(fs.lstat(join(root, ".git", "maginalia-snapshot.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("stops at snapshot failure before graph validation", async () => {
    const { root, identity } = await makeRepository();
    const before = await head(root);
    await fs.writeFile(join(root, ".env"), "SECRET=not-for-repository\n", "utf8");

    await expectCode(
      () => preflightCloudLocalState(root, identity, async () => undefined),
      "SNAPSHOT_FAILED",
    );
    expect(await head(root)).toBe(before);
  });

  test("pins clean saved state with a complete graph and final guard", async () => {
    const { root, identity } = await makeRepository();
    const calls: string[] = [];

    const pin = await preflightCloudLocalState(root, identity, async () => {
      calls.push("guard");
    });

    expect(calls).toEqual(["guard", "guard"]);
    expect(Object.isFrozen(pin)).toBe(true);
    expect(pin.canonicalRoot).toBe(await fs.realpath(root));
    expect(pin.snapshot.created).toBe(false);
    expect(pin.snapshot.head).toBe(pin.graph.head);
    expect(pin.graph.identity).toEqual(identity);
    expect(pin.graph.objects.length).toBeGreaterThan(0);
    expect(pin.workingTreeFingerprint).toBe(pin.snapshot.fingerprint);
  });

  test("rechecks an unchanged pin with guards before and after local reads", async () => {
    const { root, identity } = await makeRepository();
    const pin = await preflightCloudLocalState(root, identity, async () => undefined);
    let guardCalls = 0;

    await recheckCloudLocalPin(pin, async () => {
      guardCalls += 1;
    });

    expect(guardCalls).toBe(2);
  });

  test("rejects a saved worktree change", async () => {
    const fixture = await makeRepository();
    const pin = await preflightCloudLocalState(fixture.root, fixture.identity, async () => undefined);
    await fs.writeFile(join(fixture.root, "changed.md"), "changed after pin\n", "utf8");
    await expectCode(
      () => recheckCloudLocalPin(pin, async () => undefined),
      "WORKING_TREE_CHANGED",
    );
  });

  test("rejects a saved identity change", async () => {
    const fixture = await makeRepository();
    const pin = await preflightCloudLocalState(fixture.root, fixture.identity, async () => undefined);
    await fs.writeFile(
      join(fixture.root, ".maginalia", "repository.json"),
      JSON.stringify({ ...fixture.identity, title: "Changed identity" }),
      "utf8",
    );
    await expectCode(
      () => recheckCloudLocalPin(pin, async () => undefined),
      "IDENTITY_MISMATCH",
    );
  });

  test("rejects a changed main HEAD", async () => {
    const fixture = await makeRepository();
    const pin = await preflightCloudLocalState(fixture.root, fixture.identity, async () => undefined);
    await fs.writeFile(join(fixture.root, "head-change.md"), "new commit\n", "utf8");
    await git.add({ fs: gitFs(), dir: fixture.root, filepath: "head-change.md" });
    await git.commit({
      fs: gitFs(),
      dir: fixture.root,
      message: "change main after pin",
      author: { name: "Pin Fixture", email: "pin@example.invalid" },
      committer: { name: "Pin Fixture", email: "pin@example.invalid" },
    });
    await expectCode(
      () => recheckCloudLocalPin(pin, async () => undefined),
      "LOCAL_STATE_CHANGED",
    );
  });

  test("rejects a real staged index change", async () => {
    const fixture = await makeRepository();
    const pin = await preflightCloudLocalState(fixture.root, fixture.identity, async () => undefined);
    await fs.writeFile(join(fixture.root, "staged-after-pin.md"), "staged after pin\n", "utf8");
    await git.add({ fs: gitFs(), dir: fixture.root, filepath: "staged-after-pin.md" });
    await expectCode(
      () => recheckCloudLocalPin(pin, async () => undefined),
      "GRAPH_FAILED",
    );
  });

  test("rejects a pin whose stored index hash changed", async () => {
    const fixture = await makeRepository();
    const pin = await preflightCloudLocalState(fixture.root, fixture.identity, async () => undefined);
    const changedIndexPin = Object.freeze({
      ...pin,
      graph: Object.freeze({ ...pin.graph, indexHash: "0".repeat(64) }),
    });
    await expectCode(
      () => recheckCloudLocalPin(changedIndexPin, async () => undefined),
      "LOCAL_STATE_CHANGED",
    );
  });

  test("runs the dirty guard before local reads and after the recheck", async () => {
    const { root, identity } = await makeRepository();
    const pin = await preflightCloudLocalState(root, identity, async () => undefined);
    let beforeCalls = 0;
    await expectCode(
      () => recheckCloudLocalPin(pin, async () => {
        beforeCalls += 1;
        throw new Error("manuscript is dirty");
      }),
      "DIRTY_CONTENT",
    );
    expect(beforeCalls).toBe(1);

    let afterCalls = 0;
    await expectCode(
      () => recheckCloudLocalPin(pin, async () => {
        afterCalls += 1;
        if (afterCalls === 2) throw new Error("manuscript changed during communication");
      }),
      "DIRTY_CONTENT",
    );
    expect(afterCalls).toBe(2);
  });

  test("rejects malformed pins before invoking the guard", async () => {
    const { root, identity } = await makeRepository();
    const pin = await preflightCloudLocalState(root, identity, async () => undefined);
    let guardCalls = 0;
    const malformed = Object.freeze({ ...pin, canonicalRoot: "relative-root" });

    await expectCode(
      () => recheckCloudLocalPin(malformed, async () => {
        guardCalls += 1;
      }),
      "INVALID_INPUT",
    );
    expect(guardCalls).toBe(0);
  });

  test("fails closed when the requested portable identity differs", async () => {
    const { root } = await makeRepository();
    const different = createIdentity("project", "Different identity", "6ba7b810-9dad-41d1-80b4-00c04fd430c8");
    let guardCalls = 0;

    await expectCode(
      () => preflightCloudLocalState(root, different, async () => {
        guardCalls += 1;
      }),
      "IDENTITY_MISMATCH",
    );
    expect(guardCalls).toBe(1);
  });

  test("treats a guard that becomes dirty after the snapshot as an attention stop", async () => {
    const { root, identity } = await makeRepository();
    let guardCalls = 0;

    await expectCode(
      () => preflightCloudLocalState(root, identity, async () => {
        guardCalls += 1;
        if (guardCalls === 2) throw new Error("manuscript changed after snapshot");
      }),
      "DIRTY_CONTENT",
    );
    expect(guardCalls).toBe(2);
  });

  test("does not introduce any network dependency", async () => {
    const { root, identity } = await makeRepository();
    const graph = await preflightCloudLocalState(root, identity, async () => undefined);
    const graphKeys = Object.keys(graph.graph) as Array<keyof LocalHistoryObjectGraph>;
    expect(graphKeys).toEqual(["identity", "head", "indexHash", "objects"]);
  });
});
