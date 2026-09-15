import { createHash } from "node:crypto";
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
  inspectRepository,
  materializeHistoryCommit,
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
  delete process.env.MAGINALIA_TEST_MATERIALIZATION_INTERRUPT;
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

async function makeRepository(kind: RepositoryKind = "project"): Promise<{
  root: string;
  identity: RepositoryIdentity;
}> {
  const root = await fs.mkdtemp(join(tmpdir(), "maginalia-materialize-source-"));
  roots.push(root);
  const identity = createIdentity(kind, `Materialize ${kind}`, IDS[kind]);
  await writeFiles(root, templateFiles(identity));
  await fs.writeFile(join(root, INCOMPLETE_MARKER), "publication marker\n", "utf8");
  await initializeRepository(root);
  await fs.unlink(join(root, INCOMPLETE_MARKER));
  return { root, identity };
}

async function makeDestination(): Promise<string> {
  const destination = await fs.mkdtemp(join(tmpdir(), "maginalia-materialize-destination-"));
  roots.push(destination);
  await fs.writeFile(join(destination, INCOMPLETE_MARKER), "destination marker\n", "utf8");
  return destination;
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

async function readBytes(pathValue: string): Promise<Uint8Array> {
  return new Uint8Array(await fs.readFile(pathValue));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function manuscriptPathFor(kind: RepositoryKind): string {
  return kind === "project" ? "manuscript.md" : "books/old.md";
}

async function repositorySnapshot(root: string): Promise<{
  head: string;
  index: Uint8Array;
  manuscript?: Uint8Array;
  oldFile?: Uint8Array;
}> {
  return {
    head: await git.resolveRef({ fs: gitFs(), dir: root, ref: MAIN_REF }),
    index: await readBytes(join(root, ".git", "index")),
    manuscript: await readBytes(join(root, "manuscript.md")).catch(() => undefined),
    oldFile: await readBytes(join(root, "notes", "old.md")).catch(() => undefined),
  };
}

async function readTreeFiles(
  root: string,
  treeOid: string,
  prefix = "",
): Promise<readonly { path: string; oid: string; mode: string }[]> {
  const tree = await git.readTree({ fs: gitFs(), dir: root, oid: treeOid });
  const files: { path: string; oid: string; mode: string }[] = [];
  for (const entry of tree.tree) {
    const pathValue = prefix.length === 0 ? entry.path : `${prefix}/${entry.path}`;
    if (entry.type === "tree") {
      files.push(...await readTreeFiles(root, entry.oid, pathValue));
    } else {
      files.push({ path: pathValue, oid: entry.oid, mode: entry.mode });
    }
  }
  return files;
}

function parseIndexRows(bytes: Uint8Array): readonly { path: string; oid: string; mode: string }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(8, false);
  const checksumOffset = bytes.byteLength - 20;
  const rows: { path: string; oid: string; mode: string }[] = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const mode = view.getUint32(offset + 24, false).toString(8).padStart(6, "0");
    const oid = Buffer.from(bytes.subarray(offset + 40, offset + 60)).toString("hex");
    let nameEnd = offset + 62;
    while (nameEnd < checksumOffset && bytes[nameEnd] !== 0) nameEnd += 1;
    rows.push({
      path: Buffer.from(bytes.subarray(offset + 62, nameEnd)).toString("utf8"),
      oid,
      mode,
    });
    const entrySize = 62 + (nameEnd - (offset + 62)) + 1;
    offset += (entrySize + 7) & ~7;
  }
  return rows.sort((left, right) => left.path.localeCompare(right.path));
}

async function objectStats(root: string, head: string): Promise<{
  unique: number;
  visited: number;
  totalBytes: number;
  blobBytes: number;
}> {
  const pending = [head];
  const seen = new Set<string>();
  let visited = 0;
  let totalBytes = 0;
  let blobBytes = 0;
  while (pending.length > 0) {
    const oid = pending.pop()!;
    visited += 1;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const raw = await git.readObject({ fs: gitFs(), dir: root, oid, format: "content" }) as {
      type: string;
      object: Uint8Array;
    };
    totalBytes += raw.object.byteLength;
    if (raw.type === "blob") {
      blobBytes += raw.object.byteLength;
    } else if (raw.type === "commit") {
      const commit = await git.readCommit({ fs: gitFs(), dir: root, oid });
      pending.push(commit.commit.tree, ...commit.commit.parent);
    } else if (raw.type === "tree") {
      const tree = await git.readTree({ fs: gitFs(), dir: root, oid });
      pending.push(...tree.tree.map((entry) => entry.oid));
    }
  }
  return { unique: seen.size, visited, totalBytes, blobBytes };
}

async function prepareOlderVersion(
  root: string,
  kind: RepositoryKind = "project",
): Promise<{ oldHead: string; latestHead: string }> {
  const manuscriptPath = manuscriptPathFor(kind);
  if (manuscriptPath.includes("/")) {
    await fs.mkdir(join(root, manuscriptPath.split("/")[0]!), { recursive: true });
  }
  await fs.writeFile(join(root, manuscriptPath), "\uFEFF古い本文\r\n二行目\r\n", "utf8");
  if (process.platform !== "win32") await fs.chmod(join(root, manuscriptPath), 0o755);
  if (kind === "project") {
    await fs.writeFile(join(root, "notes", "old.md"), "old historical note\n", "utf8");
  } else {
    await fs.mkdir(join(root, "books"), { recursive: true });
    await fs.writeFile(join(root, "books", "old-note.md"), "old historical note\n", "utf8");
  }
  const old = await createHistorySnapshot(root);
  if (kind === "project") {
    await fs.unlink(join(root, "notes", "old.md"));
  } else {
    await fs.unlink(join(root, "books", "old-note.md"));
  }
  await fs.writeFile(join(root, manuscriptPath), "latest working tree\n", "utf8");
  const latest = await createHistorySnapshot(root);
  return { oldHead: old.head, latestHead: latest.head };
}

describe("validated local History materialization", () => {
  test.each(["project", "shelf"] as const)(
    "copies a validated older %s tree while preserving source state",
    async (kind) => {
      const { root, identity } = await makeRepository(kind);
      const versions = await prepareOlderVersion(root, kind);
      const sourceBefore = await repositorySnapshot(root);
      const destination = await makeDestination();

      const result = await materializeHistoryCommit(
        root,
        destination,
        versions.oldHead,
        identity,
      );

      expect(result.head).toBe(versions.oldHead);
      expect(result.head).not.toBe(versions.latestHead);
      expect(result.identity).toEqual(identity);
      expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(await git.resolveRef({ fs: gitFs(), dir: destination, ref: MAIN_REF })).toBe(versions.oldHead);
      const destinationFiles = await git.listFiles({ fs: gitFs(), dir: destination });
      expect(destinationFiles).toContain(kind === "project" ? "notes/old.md" : "books/old-note.md");
      expect(await git.listFiles({ fs: gitFs(), dir: destination })).not.toContain(INCOMPLETE_MARKER);
      expect(await fs.readFile(join(destination, manuscriptPathFor(kind)), "utf8"))
        .toBe("\uFEFF古い本文\r\n二行目\r\n");
      if (process.platform !== "win32") {
        expect((await fs.stat(join(destination, manuscriptPathFor(kind)))).mode & 0o111).not.toBe(0);
      }
      expect(await fs.readFile(join(destination, kind === "project" ? "notes/old.md" : "books/old-note.md"), "utf8"))
        .toBe("old historical note\n");
      expect(await fs.readFile(join(destination, INCOMPLETE_MARKER), "utf8"))
        .toBe("destination marker\n");

      const selectedCommit = await git.readCommit({ fs: gitFs(), dir: root, oid: versions.oldHead });
      const expectedIndex = [...await readTreeFiles(root, selectedCommit.commit.tree)]
        .sort((left, right) => left.path.localeCompare(right.path));
      expect(parseIndexRows(await readBytes(join(destination, ".git", "index"))))
        .toEqual(expectedIndex);
      await expect(
        git.readObject({ fs: gitFs(), dir: destination, oid: versions.latestHead, format: "content" }),
      ).rejects.toBeDefined();

      const history = await git.log({ fs: gitFs(), dir: destination, ref: MAIN_REF });
      expect(history[0]?.oid).toBe(versions.oldHead);
      expect(history.length).toBeGreaterThanOrEqual(2);
      expect(history.every((entry) => entry.commit.parent.length <= 1)).toBe(true);
      expect(await git.listRefs({ fs: gitFs(), dir: destination, filepath: "refs" }))
        .toEqual(["heads/main"]);

      const sourceAfter = await repositorySnapshot(root);
      expect(sourceAfter.head).toBe(sourceBefore.head);
      expect(Buffer.from(sourceAfter.index)).toEqual(Buffer.from(sourceBefore.index));
      expect(Buffer.from(sourceAfter.manuscript ?? [])).toEqual(Buffer.from(sourceBefore.manuscript ?? []));
      expect(sourceAfter.oldFile).toBeUndefined();
      expect(sha256(await readBytes(join(destination, manuscriptPathFor(kind))))).not.toBe("");
    },
  );

  test("rejects malformed or unreachable selections before creating destination Git", async () => {
    const { root, identity } = await makeRepository();
    const versions = await prepareOlderVersion(root);
    for (const [oid, expectedCode] of [["not-an-oid", "unsafe-tree"], ["0".repeat(40), "unsupported-state"]] as const) {
      const destination = await makeDestination();
      await expectCode(materializeHistoryCommit(root, destination, oid, identity), expectedCode);
      expect(await fs.readdir(destination)).toEqual([INCOMPLETE_MARKER]);
    }
    expect(await git.resolveRef({ fs: gitFs(), dir: root, ref: MAIN_REF })).toBe(versions.latestHead);
  });

  test("rejects a nonlinear current main history before touching the destination", async () => {
    const { root, identity } = await makeRepository();
    const current = await git.resolveRef({ fs: gitFs(), dir: root, ref: MAIN_REF });
    const currentCommit = await git.readCommit({ fs: gitFs(), dir: root, oid: current });
    const merge = await git.writeCommit({
      fs: gitFs(),
      dir: root,
      commit: {
        tree: currentCommit.commit.tree,
        parent: [current, current],
        message: "malformed merge fixture",
        author: currentCommit.commit.author,
        committer: currentCommit.commit.committer,
      },
    });
    await git.writeRef({ fs: gitFs(), dir: root, ref: MAIN_REF, value: merge, force: true });
    const destination = await makeDestination();

    await expectCode(materializeHistoryCommit(root, destination, merge, identity), "unsupported-state");
    expect(await fs.readdir(destination)).toEqual([INCOMPLETE_MARKER]);
  });

  test("rejects a private marker present only in an ancestor before destination payload", async () => {
    const { root, identity } = await makeRepository();
    await fs.writeFile(join(root, "notes", "history-secret.txt"), "-----BEGIN PRIVATE KEY-----\n", "utf8");
    await git.add({ fs: gitFs(), dir: root, filepath: "notes/history-secret.txt" });
    const secretCommit = await git.commit({
      fs: gitFs(),
      dir: root,
      message: "secret ancestor fixture",
      author: { name: "Fixture", email: "fixture@example.invalid" },
      committer: { name: "Fixture", email: "fixture@example.invalid" },
    });
    await fs.unlink(join(root, "notes", "history-secret.txt"));
    await git.remove({ fs: gitFs(), dir: root, filepath: "notes/history-secret.txt" });
    const latest = await git.commit({
      fs: gitFs(),
      dir: root,
      message: "clean descendant fixture",
      author: { name: "Fixture", email: "fixture@example.invalid" },
      committer: { name: "Fixture", email: "fixture@example.invalid" },
    });
    expect(latest).not.toBe(secretCommit);
    const destination = await makeDestination();

    await expectCode(materializeHistoryCommit(root, destination, latest, identity), "unsafe-secret");
    expect(await fs.readdir(destination)).toEqual([INCOMPLETE_MARKER]);
  });

  test("rejects a private marker present only in an ancestor commit message", async () => {
    const { root, identity } = await makeRepository();
    const current = await git.resolveRef({ fs: gitFs(), dir: root, ref: MAIN_REF });
    const currentCommit = await git.readCommit({ fs: gitFs(), dir: root, oid: current });
    const secretAncestor = await git.writeCommit({
      fs: gitFs(),
      dir: root,
      commit: {
        tree: currentCommit.commit.tree,
        parent: [current],
        message: "ancestor ghp_AncestorCommitOnly123",
        author: currentCommit.commit.author,
        committer: currentCommit.commit.committer,
      },
    });
    const cleanSelected = await git.writeCommit({
      fs: gitFs(),
      dir: root,
      commit: {
        tree: currentCommit.commit.tree,
        parent: [secretAncestor],
        message: "clean selected descendant",
        author: currentCommit.commit.author,
        committer: currentCommit.commit.committer,
      },
    });
    await git.writeRef({ fs: gitFs(), dir: root, ref: MAIN_REF, value: cleanSelected, force: true });
    const destination = await makeDestination();

    await expectCode(materializeHistoryCommit(root, destination, cleanSelected, identity), "unsafe-secret");
    expect(await fs.readdir(destination)).toEqual([INCOMPLETE_MARKER]);
  });

  test("enforces object count/byte bounds before destination writes", async () => {
    const { root, identity } = await makeRepository();
    const latest = (await prepareOlderVersion(root)).latestHead;
    const byteDestination = await makeDestination();
    await expectCode(
      materializeHistoryCommit(root, byteDestination, latest, identity, { maxObjectBytes: 1 }),
      "limits-exceeded",
    );
    expect(await fs.readdir(byteDestination)).toEqual([INCOMPLETE_MARKER]);

    const countDestination = await makeDestination();
    await expectCode(
      materializeHistoryCommit(root, countDestination, latest, identity, { limits: { maxObjects: 1 } }),
      "limits-exceeded",
    );
    expect(await fs.readdir(countDestination)).toEqual([INCOMPLETE_MARKER]);

    const stats = await objectStats(root, latest);
    expect(stats.visited).toBeGreaterThan(stats.unique);
    const exactDestination = await makeDestination();
    await expect(
      materializeHistoryCommit(root, exactDestination, latest, identity, {
        maxObjectBytes: stats.totalBytes,
      }),
    ).resolves.toMatchObject({ head: latest });
    const blobOnlyDestination = await makeDestination();
    await expectCode(
      materializeHistoryCommit(root, blobOnlyDestination, latest, identity, {
        maxObjectBytes: stats.blobBytes,
      }),
      "limits-exceeded",
    );
    expect(await fs.readdir(blobOnlyDestination)).toEqual([INCOMPLETE_MARKER]);
  });

  test("rejects destination aliases, payload, or missing marker without overwriting", async () => {
    const { root, identity } = await makeRepository();
    const latest = (await prepareOlderVersion(root)).latestHead;

    const extra = await makeDestination();
    await fs.writeFile(join(extra, "extra.txt"), "must remain\n", "utf8");
    await expectCode(materializeHistoryCommit(root, extra, latest, identity), "target-exists");
    expect(await fs.readFile(join(extra, "extra.txt"), "utf8")).toBe("must remain\n");

    const missingMarker = await fs.mkdtemp(join(tmpdir(), "maginalia-materialize-missing-"));
    roots.push(missingMarker);
    await expectCode(materializeHistoryCommit(root, missingMarker, latest, identity), "incomplete-marker");

    const insideSource = await fs.mkdtemp(join(root, "fresh-destination-"));
    roots.push(insideSource);
    await fs.writeFile(join(insideSource, INCOMPLETE_MARKER), "marker\n", "utf8");
    await expectCode(materializeHistoryCommit(root, insideSource, latest, identity), "unsafe-path");
    expect(await fs.readdir(insideSource)).toEqual([INCOMPLETE_MARKER]);
  });

  test.each([
    "after-git-init",
    "after-object-write",
    "after-content-write",
    "after-index-write",
    "after-ref-write",
  ] as const)("leaves marker and source unchanged after injected %s failure", async (point) => {
    const { root, identity } = await makeRepository();
    const latest = (await prepareOlderVersion(root)).latestHead;
    const sourceBefore = await repositorySnapshot(root);
    const destination = await makeDestination();

    await expectCode(
      materializeHistoryCommit(root, destination, latest, identity, { testFailurePoint: point }),
      "io-error",
    );
    expect(await fs.readdir(destination)).toContain(INCOMPLETE_MARKER);
    await expectCode(inspectRepository(destination), "incomplete-marker");
    const sourceAfter = await repositorySnapshot(root);
    expect(sourceAfter.head).toBe(sourceBefore.head);
    expect(Buffer.from(sourceAfter.index)).toEqual(Buffer.from(sourceBefore.index));
    expect(Buffer.from(sourceAfter.manuscript ?? [])).toEqual(Buffer.from(sourceBefore.manuscript ?? []));
  });

  test("rejects a linked marker where the platform permits link creation", async () => {
    const { root, identity } = await makeRepository();
    const latest = (await prepareOlderVersion(root)).latestHead;
    const destination = await makeDestination();
    const targetDirectory = await fs.mkdtemp(join(tmpdir(), "maginalia-materialize-marker-target-"));
    roots.push(targetDirectory);
    const outside = join(targetDirectory, "marker-target.txt");
    await fs.writeFile(outside, "marker target\n", "utf8");
    let linked = false;
    try {
      await fs.unlink(join(destination, INCOMPLETE_MARKER));
      await fs.link(outside, join(destination, INCOMPLETE_MARKER));
      linked = true;
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code !== "EPERM" && code !== "EACCES" && code !== "ENOTSUP" && code !== "EXDEV" && code !== "EINVAL") {
        throw error;
      }
      // Link creation can be unavailable on the test volume; the capability
      // check is the only operation intentionally skipped in that case.
    } finally {
      if (!linked) await fs.writeFile(join(destination, INCOMPLETE_MARKER), "destination marker\n", "utf8");
    }
    if (!linked) return;

    await expectCode(materializeHistoryCommit(root, destination, latest, identity), "incomplete-marker");
    expect(await fs.stat(join(destination, ".git")).then(() => true).catch(() => false)).toBe(false);
  });
});
