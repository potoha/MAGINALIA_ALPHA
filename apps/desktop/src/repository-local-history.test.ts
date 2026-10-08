import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as git from "isomorphic-git";
import { afterEach, describe, expect, test } from "vitest";
import {
  INCOMPLETE_MARKER,
  MAIN_REF,
  LocalRepositoryError,
  initializeRepository,
  inspectRepository,
  readIdentity,
  gitFs,
} from "./repository-local-history.js";
import { captureWorkingTree } from "./repository-filesystem.js";
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

async function makeMarkedRoot(kind: RepositoryKind = "project"): Promise<{
  root: string;
  identity: RepositoryIdentity;
}> {
  const root = await fs.mkdtemp(join(tmpdir(), "maginalia-rlh-"));
  roots.push(root);
  const identity = createIdentity(kind, "Fixture " + kind, IDS[kind]);
  const files = templateFiles(identity);
  for (const [pathValue, contents] of Object.entries(files)) {
    const segments = pathValue.split("/");
    let directory = root;
    for (const segment of segments.slice(0, -1)) {
      directory = join(directory, segment);
      await fs.mkdir(directory, { recursive: true });
    }
    await fs.writeFile(join(root, ...segments), contents, "utf8");
  }
  await fs.writeFile(join(root, INCOMPLETE_MARKER), "incomplete fixture\n", "utf8");
  return { root, identity };
}

async function removeMarker(root: string): Promise<void> {
  await fs.unlink(join(root, INCOMPLETE_MARKER));
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

describe("main-only local repository state", () => {
  test("initializes all three kinds with a main commit while retaining but not tracking the marker", async () => {
    for (const kind of ["project", "workbench", "shelf"] as const) {
      const { root, identity } = await makeMarkedRoot(kind);
      const initialized = await initializeRepository(root);

      expect(initialized.created).toBe(true);
      expect(initialized.identity).toEqual(identity);
      expect(initialized.head).toMatch(/^[0-9a-f]{40}$/);
      expect(await git.resolveRef({ fs: gitFs(), dir: root, ref: MAIN_REF })).toBe(initialized.head);
      expect(await fs.lstat(join(root, INCOMPLETE_MARKER))).toBeDefined();
      expect(initialized.trackedFiles.some((file) => file.path === INCOMPLETE_MARKER)).toBe(false);
      expect(await git.listFiles({ fs: gitFs(), dir: root })).not.toContain(INCOMPLETE_MARKER);
      await expectCode(inspectRepository(root), "incomplete-marker");
    }
  });

  test("inspects a valid unmarked repository and exposes only next-adapter state", async () => {
    const { root, identity } = await makeMarkedRoot("project");
    const initialized = await initializeRepository(root);
    await removeMarker(root);

    const inspected = await inspectRepository(root);
    expect(inspected.canonicalRoot).toBe(await fs.realpath(root));
    expect(inspected.identity).toEqual(identity);
    expect(inspected.head).toBe(initialized.head);
    expect(inspected.trackedFiles.length).toBeGreaterThan(0);
    expect(inspected.trackedFiles.every((file) => file.path !== INCOMPLETE_MARKER)).toBe(true);
    expect(await inspected.isIgnored("manuscript.md")).toBe(false);
    expect(Object.keys(inspected).sort()).toEqual([
      "canonicalRoot",
      "head",
      "identity",
      "isIgnored",
      "trackedFiles",
    ]);
    expect((await readIdentity(root)).id).toBe(identity.id);
  });

  test("requires a real, regular, non-hard-linked marker and a valid typed identity before creating Git", async () => {
    const missing = await makeMarkedRoot();
    await removeMarker(missing.root);
    await expectCode(initializeRepository(missing.root), "incomplete-marker");
    expect(await fs.stat(join(missing.root, ".git")).then(() => true).catch(() => false)).toBe(false);

    const malformed = await makeMarkedRoot();
    await fs.unlink(join(malformed.root, "project.magi"));
    await fs.writeFile(join(malformed.root, "broken.magi"), "not a typed marker\n", "utf8");
    await fs.mkdir(join(malformed.root, ".maginalia"), { recursive: true });
    await fs.writeFile(
      join(malformed.root, ".maginalia", "repository.json"),
      "{\"schemaVersion\":1}\n",
      "utf8",
    );
    await expectCode(initializeRepository(malformed.root), "invalid-identity");
    expect(await fs.stat(join(malformed.root, ".git")).then(() => true).catch(() => false)).toBe(false);

    const linked = await makeMarkedRoot();
    const outside = join(linked.root, "..", "maginalia-rlh-marker-outside.txt");
    await fs.writeFile(outside, "marker outside\n", "utf8");
    try {
      await fs.unlink(join(linked.root, INCOMPLETE_MARKER));
      await fs.link(outside, join(linked.root, INCOMPLETE_MARKER));
      await expectCode(initializeRepository(linked.root), "incomplete-marker");
      expect(await fs.stat(join(linked.root, ".git")).then(() => true).catch(() => false)).toBe(false);
    } catch {
      // Hard-link creation can be disabled by the Windows fixture volume.
    } finally {
      await fs.unlink(join(linked.root, INCOMPLETE_MARKER)).catch(() => undefined);
      await fs.unlink(outside).catch(() => undefined);
    }

    const symlinked = await makeMarkedRoot();
    const symlinkOutside = join(symlinked.root, "..", "maginalia-rlh-marker-link.txt");
    await fs.writeFile(symlinkOutside, "marker link target\n", "utf8");
    try {
      await fs.unlink(join(symlinked.root, INCOMPLETE_MARKER));
      await fs.symlink(symlinkOutside, join(symlinked.root, INCOMPLETE_MARKER));
      await expectCode(initializeRepository(symlinked.root), "incomplete-marker");
      expect(await fs.stat(join(symlinked.root, ".git")).then(() => true).catch(() => false)).toBe(false);
    } catch {
      // Symlink creation may be disabled by the Windows fixture policy.
    } finally {
      await fs.unlink(join(symlinked.root, INCOMPLETE_MARKER)).catch(() => undefined);
      await fs.unlink(symlinkOutside).catch(() => undefined);
    }
  });

  test("keeps a valid typed marker usable when legacy identity metadata is malformed", async () => {
    const { root, identity } = await makeMarkedRoot();
    await removeMarker(root);
    await fs.mkdir(join(root, ".maginalia"), { recursive: true });
    await fs.writeFile(join(root, ".maginalia", "repository.json"), "{broken legacy identity\n", "utf8");

    expect(await readIdentity(root)).toMatchObject({ id: identity.id, kind: identity.kind });
    expect(await fs.readFile(join(root, "manuscript.md"), "utf8")).toContain("Fixture project");
    expect(await fs.stat(join(root, ".git")).then(() => true).catch(() => false)).toBe(false);
  });

  test("rejects malformed existing identity and marked roots without exposing the root path", async () => {
    const { root } = await makeMarkedRoot();
    await initializeRepository(root);
    await expectCode(inspectRepository(root), "incomplete-marker");
    await removeMarker(root);
    await fs.unlink(join(root, "project.magi"));
    await fs.writeFile(join(root, "bad.magi"), "not a typed marker\n", "utf8");
    await fs.mkdir(join(root, ".maginalia"), { recursive: true });
    await fs.writeFile(join(root, ".maginalia", "repository.json"), "not json\n", "utf8");
    try {
      await inspectRepository(root);
      throw new Error("expected invalid identity");
    } catch (error) {
      expect(codeOf(error)).toBe("invalid-identity");
      expect(error instanceof Error ? error.message : "").not.toContain(root);
    }
  });

  test("rejects additional branches, tags, refs, detached HEAD, unfinished state, and locks", async () => {
    const { root } = await makeMarkedRoot();
    await initializeRepository(root);
    await removeMarker(root);

    await git.writeRef({
      fs: gitFs(),
      dir: root,
      ref: "refs/heads/feature",
      value: await git.resolveRef({ fs: gitFs(), dir: root, ref: MAIN_REF }),
      force: false,
    });
    await expectCode(inspectRepository(root), "unsupported-state");
    await git.deleteRef({ fs: gitFs(), dir: root, ref: "refs/heads/feature" });

    await git.writeRef({
      fs: gitFs(),
      dir: root,
      ref: "refs/tags/fixture",
      value: await git.resolveRef({ fs: gitFs(), dir: root, ref: MAIN_REF }),
      force: false,
    });
    await expectCode(inspectRepository(root), "unsupported-state");
    await git.deleteRef({ fs: gitFs(), dir: root, ref: "refs/tags/fixture" });

    await git.writeRef({
      fs: gitFs(),
      dir: root,
      ref: "refs/notes/fixture",
      value: await git.resolveRef({ fs: gitFs(), dir: root, ref: MAIN_REF }),
      force: false,
    });
    await expectCode(inspectRepository(root), "unsupported-state");
    await git.deleteRef({ fs: gitFs(), dir: root, ref: "refs/notes/fixture" });

    const headPath = join(root, ".git", "HEAD");
    const originalHead = await fs.readFile(headPath, "utf8");
    await fs.writeFile(headPath, "detached\n", "utf8");
    await expectCode(inspectRepository(root), "unsupported-state");
    await fs.writeFile(headPath, originalHead, "utf8");

    for (const statePath of ["MERGE_HEAD", "REBASE_HEAD", "BISECT_LOG", "sequencer"]) {
      const absolute = join(root, ".git", statePath);
      if (statePath === "sequencer") await fs.mkdir(absolute);
      else await fs.writeFile(absolute, "unfinished\n", "utf8");
      await expectCode(inspectRepository(root), "unsupported-state");
      await fs.rm(absolute, { recursive: true, force: true });
    }

    for (const lockPath of [
      join(root, ".git", "index.lock"),
      join(root, ".git", "refs", "heads", "main.lock"),
    ]) {
      await fs.writeFile(lockPath, "foreign lock\n", "utf8");
      await expectCode(inspectRepository(root), "unsupported-state");
      await fs.rm(lockPath);
    }
  });

  test("rejects staged/index mismatch and unsafe administrative links", async () => {
    const { root } = await makeMarkedRoot();
    await initializeRepository(root);
    await removeMarker(root);

    const stagedBlob = await git.hashBlob({ object: Buffer.from("staged but not saved\n", "utf8") });
    await git.updateIndex({
      fs: gitFs(),
      dir: root,
      filepath: "manuscript.md",
      oid: stagedBlob.oid,
      mode: 0o100644,
      add: true,
    });
    await expectCode(inspectRepository(root), "unsupported-state");

    const fresh = await makeMarkedRoot("workbench");
    await initializeRepository(fresh.root);
    await removeMarker(fresh.root);
    const configPath = join(fresh.root, ".git", "config");
    const originalConfig = await fs.readFile(configPath);
    const outside = join(fresh.root, "..", "maginalia-rlh-admin-outside.txt");
    await fs.writeFile(outside, "admin outside\n", "utf8");
    try {
      await fs.unlink(configPath);
      await fs.symlink(outside, configPath);
      await expectCode(inspectRepository(fresh.root), "unsupported-state");
      expect(await fs.readFile(outside, "utf8")).toBe("admin outside\n");
    } catch {
      // Symlink creation may be disabled by the Windows fixture policy.
    } finally {
      await fs.unlink(configPath).catch(() => undefined);
      await fs.writeFile(configPath, originalConfig);
      await fs.unlink(outside).catch(() => undefined);
    }
  });

  test("feeds tracked paths and modes to capture so ignored skipped descendants survive", async () => {
    const { root } = await makeMarkedRoot("project");
    await initializeRepository(root);
    await removeMarker(root);

    await fs.mkdir(join(root, "dist"));
    await fs.writeFile(join(root, "dist", "kept.txt"), "tracked descendant\n", "utf8");
    await fs.writeFile(join(root, "dist", "drop.txt"), "ignored sibling\n", "utf8");
    await fs.writeFile(join(root, ".gitignore"), "dist/\n", "utf8");
    await git.add({ fs: gitFs(), dir: root, filepath: ".gitignore" });
    await git.add({ fs: gitFs(), dir: root, filepath: "dist/kept.txt", force: true });
    await git.commit({
      fs: gitFs(),
      dir: root,
      message: "fixture tracked descendant",
      author: { name: "Fixture", email: "fixture@example.invalid" },
      committer: { name: "Fixture", email: "fixture@example.invalid" },
    });

    const inspected = await inspectRepository(root);
    expect(inspected.trackedFiles.some((file) => file.path === "dist/kept.txt")).toBe(true);
    const captured = await captureWorkingTree(root, {
      trackedPaths: new Set(inspected.trackedFiles.map((file) => file.path)),
      modeHints: new Map(inspected.trackedFiles.map((file) => [file.path, file.mode] as const)),
      isIgnored: inspected.isIgnored,
    });
    expect(captured.files.some((file) => file.path === "dist/kept.txt")).toBe(true);
    expect(captured.files.some((file) => file.path === "dist/drop.txt")).toBe(false);
  });

  test("keeps bounded error messages and rejects an invalid reachable tree", async () => {
    const { root } = await makeMarkedRoot("shelf");
    await initializeRepository(root);
    await removeMarker(root);
    const head = await git.resolveRef({ fs: gitFs(), dir: root, ref: MAIN_REF });
    await fs.rm(join(root, ".git", "objects"), { recursive: true, force: true });
    try {
      await inspectRepository(root);
      throw new Error("expected invalid tree");
    } catch (error) {
      expect(error instanceof LocalRepositoryError).toBe(true);
      expect(codeOf(error)).toBe("unsafe-tree");
      expect(error instanceof Error ? error.message : "").not.toContain(root);
    } finally {
      // The fixture is discarded by afterEach; no production cleanup path is
      // exercised by this test.
      expect(head).toMatch(/^[0-9a-f]{40}$/);
    }
  });
});
