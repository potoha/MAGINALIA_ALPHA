import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  createIdentity,
  parseIdentity,
  storageName,
  templateFiles,
  type RepositoryIdentity,
  type RepositoryKind,
} from "@maginalia/repository-core";
import {
  INCOMPLETE_MARKER,
  LocalRepositoryService,
  type LocalRepositoryOpened,
  type LocalRepositoryResult,
} from "./repository-service.js";
import { inspectRepository } from "./repository-local-history.js";

const roots: string[] = [];
const IDS: Record<RepositoryKind, string> = {
  project: "550e8400-e29b-41d4-a716-446655440000",
  workbench: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
  shelf: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
};

afterEach(async () => {
  delete process.env.MAGINALIA_TEST_REPOSITORY_CREATE_FAILURE;
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await fs.rm(root, { recursive: true, force: true });
  }
});

async function makeParent(): Promise<string> {
  const parent = await fs.mkdtemp(join(tmpdir(), "maginalia-repository-service-"));
  roots.push(parent);
  return parent;
}

function opened(result: LocalRepositoryResult): LocalRepositoryOpened {
  expect(result.kind).toBe("opened");
  if (result.kind !== "opened") throw new Error("Expected an opened repository");
  return result;
}

function fixedFactory(id: string, handle = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"): () => string {
  let calls = 0;
  return () => {
    calls += 1;
    return calls === 1 ? id : handle;
  };
}

async function identityAt(root: string): Promise<RepositoryIdentity> {
  return parseIdentity(JSON.parse(await fs.readFile(join(root, ".maginalia", "repository.json"), "utf8")));
}

async function exists(pathValue: string): Promise<boolean> {
  return fs.access(pathValue).then(() => true).catch(() => false);
}

describe("LocalRepositoryService", () => {
  test("creates each repository kind marker-first with exact canonical templates", async () => {
    const parent = await makeParent();
    for (const kind of ["project", "workbench", "shelf"] as const) {
      const identityId = IDS[kind];
      const title = kind === "project" ? "日本語 *Project* title" : "作業 " + kind;
      const service = new LocalRepositoryService({
        uuidFactory: fixedFactory(identityId, identityId.slice(0, 8) + "-1111-4111-8111-111111111111"),
      });
      const result = opened(await service.createForOwner({}, parent, kind, title));
      const root = join(parent, storageName(createIdentity(kind, title, identityId)));
      const identity = await identityAt(root);
      expect(identity).toEqual(createIdentity(kind, title, identityId));
      expect(root.endsWith(storageName(identity))).toBe(true);
      expect(await exists(join(root, INCOMPLETE_MARKER))).toBe(false);
      expect(await exists(join(root, ".git"))).toBe(true);
      expect(result.repository.kind).toBe(kind);
      expect(result.repository.title).toBe(title);
      expect(result.repository.templateVersion).toBe(1);
      expect(result.repository.repositoryId).not.toBe(identity.id);
      expect(Object.keys(result.repository).sort()).toEqual(["kind", "repositoryId", "templateVersion", "title"]);
      expect(JSON.stringify(result)).not.toContain(root);

      const expected = templateFiles(identity);
      for (const [pathValue, contents] of Object.entries(expected)) {
        expect(await fs.readFile(join(root, ...pathValue.split("/")), "utf8")).toBe(contents);
      }
      const inspection = await inspectRepository(root);
      expect(inspection.identity).toEqual(identity);
      expect(inspection.trackedFiles.map((file) => file.path).sort()).toEqual(Object.keys(expected).sort());
      const reopened = opened(await service.openForOwner({}, root));
      expect(reopened.repository.kind).toBe(kind);
      expect(reopened.repository.title).toBe(title);
    }
  });

  test("opens an existing repository without exposing its path and revalidates handles", async () => {
    const parent = await makeParent();
    const creator = new LocalRepositoryService({ uuidFactory: fixedFactory(IDS.project) });
    const created = opened(await creator.createForOwner({}, parent, "project", "Open me"));
    const root = join(parent, storageName(createIdentity("project", "Open me", IDS.project)));
    const owner = {};
    const service = new LocalRepositoryService({ uuidFactory: fixedFactory(IDS.workbench) });
    const openedResult = opened(await service.openForOwner(owner, root));
    expect(openedResult.repository.kind).toBe("project");
    expect(JSON.stringify(openedResult)).not.toContain(root);
    const resolved = await service.resolveForOwner(owner, openedResult.repository.repositoryId);
    expect(resolved).toMatchObject({ kind: "resolved", canonicalRoot: await fs.realpath(root) });
    expect((resolved as { identity: RepositoryIdentity }).identity.id).toBe(IDS.project);
    expect(await service.resolveForOwner({}, openedResult.repository.repositoryId)).toMatchObject({
      kind: "error",
      code: "repository-not-owned",
    });
    expect(created.repository.repositoryId).not.toBe(openedResult.repository.repositoryId);

    await fs.writeFile(join(root, ".maginalia", "repository.json"), JSON.stringify({
      schemaVersion: 1,
      id: IDS.project,
      kind: "project",
      title: "Changed title",
      templateVersion: 1,
    }), "utf8");
    expect(await service.resolveForOwner(owner, openedResult.repository.repositoryId)).toMatchObject({
      kind: "error",
      code: "invalid-identity",
    });
  });

  test("replaces one owner's active repository and invalidates stale handles", async () => {
    const parent = await makeParent();
    const owner = {};
    const ids = [IDS.project, IDS.workbench, IDS.shelf];
    let index = 0;
    const service = new LocalRepositoryService({
      uuidFactory: () => ids[index++] ?? "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    const first = opened(await service.createForOwner(owner, parent, "project", "First"));
    const second = opened(await service.createForOwner(owner, parent, "workbench", "Second"));
    expect(await service.resolveForOwner(owner, first.repository.repositoryId)).toMatchObject({
      kind: "error",
      code: "repository-not-owned",
    });
    expect(await service.resolveForOwner(owner, second.repository.repositoryId)).toMatchObject({ kind: "resolved" });
    service.dispose();
    expect(await service.resolveForOwner(owner, second.repository.repositoryId)).toMatchObject({
      kind: "error",
      code: "repository-not-owned",
    });
  });

  test("rejects invalid creation inputs, collisions, incomplete roots, and invalid parents", async () => {
    const parent = await makeParent();
    const service = new LocalRepositoryService({ uuidFactory: fixedFactory(IDS.project) });
    expect(await service.createForOwner(null, parent, "project", "Title")).toMatchObject({ kind: "error", code: "invalid-owner" });
    expect(await service.createForOwner({}, parent, "unknown", "Title")).toMatchObject({ kind: "error", code: "invalid-kind" });
    expect(await service.createForOwner({}, parent, "project", "   ")).toMatchObject({ kind: "error", code: "invalid-title" });
    expect(await service.createForOwner({}, join(parent, "missing"), "project", "Title")).toMatchObject({ kind: "error", code: "parent-missing" });

    const collision = join(parent, storageName(createIdentity("project", "Existing", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")));
    await fs.mkdir(collision);
    await fs.writeFile(join(collision, "keep.txt"), "keep", "utf8");
    const collisionService = new LocalRepositoryService({ uuidFactory: fixedFactory("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") });
    expect(await collisionService.createForOwner({}, parent, "project", "Existing")).toMatchObject({ kind: "error", code: "target-exists" });
    expect(await fs.readFile(join(collision, "keep.txt"), "utf8")).toBe("keep");

    const incomplete = join(parent, "incomplete");
    await fs.mkdir(incomplete);
    await fs.writeFile(join(incomplete, INCOMPLETE_MARKER), "incomplete\n", "utf8");
    expect(await service.openForOwner({}, incomplete)).toMatchObject({ kind: "error", code: "incomplete-marker" });

    const invalid = join(parent, "invalid");
    await fs.mkdir(join(invalid, ".maginalia"), { recursive: true });
    await fs.writeFile(join(invalid, ".maginalia", "repository.json"), "{}", "utf8");
    expect(await service.openForOwner({}, invalid)).toMatchObject({ kind: "error", code: "invalid-identity" });
    expect(await service.createForOwner({}, "relative-parent", "project", "Title")).toMatchObject({ kind: "error", code: "invalid-parent" });
  });

  test("rejects a parent symlink without allocating a destination", async () => {
    const parent = await makeParent();
    const actual = join(parent, "actual");
    const alias = join(parent, "alias");
    await fs.mkdir(actual);
    try {
      await fs.symlink(actual, alias, "junction");
    } catch {
      return;
    }
    const service = new LocalRepositoryService({ uuidFactory: fixedFactory(IDS.project) });
    expect(await service.createForOwner({}, alias, "project", "Alias")).toMatchObject({ kind: "error", code: "parent-not-directory" });
    expect(await exists(join(actual, storageName(createIdentity("project", "Alias", IDS.project))))).toBe(false);
  });

  test.each([
    "before-templates",
    "during-initialize",
    "before-marker-removal",
  ] as const)("retains the marked destination after injected %s failure", async (point) => {
    const parent = await makeParent();
    const identity = createIdentity("project", "Failure " + point, IDS.project);
    const destination = join(parent, storageName(identity));
    const service = new LocalRepositoryService({ uuidFactory: fixedFactory(IDS.project) });
    process.env.MAGINALIA_TEST_REPOSITORY_CREATE_FAILURE = point;
    const result = await service.createForOwner({}, parent, "project", identity.title);
    expect(result).toMatchObject({ kind: "error", code: "io-error" });
    expect(await exists(destination)).toBe(true);
    expect(await exists(join(destination, INCOMPLETE_MARKER))).toBe(true);
    expect(await fs.readFile(join(destination, INCOMPLETE_MARKER), "utf8")).toMatch(/incomplete/i);
    expect(await service.openForOwner({}, destination)).toMatchObject({ kind: "error", code: "incomplete-marker" });
  });

  test("does not persist credentials or machine-specific data in created templates", async () => {
    const parent = await makeParent();
    const title = "安全なタイトル";
    const service = new LocalRepositoryService({ uuidFactory: fixedFactory(IDS.shelf) });
    await service.createForOwner({}, parent, "shelf", title);
    const root = join(parent, storageName(createIdentity("shelf", title, IDS.shelf)));
    const files = templateFiles(await identityAt(root));
    const serialized = Object.values(files).join("\n");
    expect(serialized).not.toMatch(/ghp_|AKIA[0-9A-Z]{16}|BEGIN [A-Z0-9 ]*PRIVATE KEY/i);
    expect(serialized).not.toMatch(/privateMemo|rawOcr|deviceMetadata|localPath|unpublishedComments/i);
    expect(serialized).not.toContain("ghp_");
    expect(createHash("sha256").update(serialized).digest("hex")).toHaveLength(64);
  });
});
