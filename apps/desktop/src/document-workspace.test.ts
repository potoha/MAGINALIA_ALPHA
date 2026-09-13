import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DocumentWorkspaceService,
  type DocumentWorkspaceOpened,
  type DocumentWorkspaceResult
} from "./document-workspace";

async function withTempDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "maginalia-document-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function opened(result: DocumentWorkspaceResult): DocumentWorkspaceOpened {
  expect(result.kind).toBe("opened");
  if (result.kind !== "opened") throw new Error("Expected a Document root to open");
  return result;
}

describe("Document workspace service", () => {
  it("canonicalizes a root and returns deterministic opaque document/manuscript metadata", async () => {
    await withTempDirectory(async (directory) => {
      const root = path.join(directory, "document");
      const rootAlias = path.join(directory, "document-alias");
      await mkdir(root);
      await writeFile(path.join(root, "z.md"), "z", "utf8");
      await writeFile(path.join(root, "manuscript.markdown"), "markdown", "utf8");
      await writeFile(path.join(root, "manuscript.md"), "md", "utf8");
      await writeFile(path.join(root, "A.markdown"), "a", "utf8");
      await symlink(root, rootAlias, "junction");

      const owner = {};
      const service = new DocumentWorkspaceService();
      const result = opened(await service.openForOwner(owner, rootAlias));

      expect(result.document.displayName).toBe("document");
      expect(result.manuscripts.map((manuscript) => manuscript.displayName)).toEqual([
        "manuscript.md",
        "manuscript.markdown",
        "A.markdown",
        "z.md"
      ]);
      expect(result.document.documentId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(result.manuscripts.every((manuscript) => /^[0-9a-f-]{36}$/i.test(manuscript.manuscriptId))).toBe(true);
      expect(Object.keys(result.document).sort()).toEqual(["displayName", "documentId"]);
      expect(result.manuscripts.every((manuscript) => Object.keys(manuscript).sort().join(",") === "displayName,manuscriptId"))
        .toBe(true);
      expect(JSON.stringify(result)).not.toContain(root);
      expect(JSON.stringify(result)).not.toContain(rootAlias);

      const selected = result.manuscripts[0];
      const resolved = await service.resolveManuscriptPath(owner, result.document.documentId, selected.manuscriptId);
      expect(resolved).toMatchObject({
        kind: "resolved",
        canonicalPath: path.join(await realpath(root), "manuscript.md")
      });
    });
  });

  it("excludes hidden names, non-Markdown entries, directories, and symlinks", async () => {
    await withTempDirectory(async (directory) => {
      const root = path.join(directory, "document");
      const outside = path.join(directory, "outside");
      await mkdir(root);
      await mkdir(outside);
      await writeFile(path.join(root, ".hidden.md"), "hidden", "utf8");
      await writeFile(path.join(root, "notes.txt"), "text", "utf8");
      await mkdir(path.join(root, "nested.md"));
      await writeFile(path.join(outside, "outside.md"), "outside", "utf8");
      await symlink(outside, path.join(root, "linked.md"), "junction");
      await writeFile(path.join(root, "kept.MD"), "kept", "utf8");

      const service = new DocumentWorkspaceService();
      const result = opened(await service.openForOwner({}, root));

      expect(result.manuscripts.map((manuscript) => manuscript.displayName)).toEqual(["kept.MD"]);
    });
  });

  it("returns typed failures for missing and non-directory roots without throwing", async () => {
    await withTempDirectory(async (directory) => {
      const service = new DocumentWorkspaceService();
      const owner = {};
      const missing = await service.openForOwner(owner, path.join(directory, "missing"));
      expect(missing).toMatchObject({ kind: "error", code: "root-missing" });

      const filePath = path.join(directory, "not-a-directory.md");
      await writeFile(filePath, "file", "utf8");
      const fileRoot = await service.openForOwner(owner, filePath);
      expect(fileRoot).toMatchObject({ kind: "error", code: "root-not-directory" });

      expect(await service.openForOwner(null, directory)).toMatchObject({ kind: "error", code: "invalid-owner" });
      expect(await service.openForOwner(owner, "relative-directory")).toMatchObject({
        kind: "error",
        code: "invalid-root"
      });
    });
  });

  it("rejects guessed IDs, malformed IDs, and another owner's document", async () => {
    await withTempDirectory(async (directory) => {
      const root = path.join(directory, "document");
      await mkdir(root);
      await writeFile(path.join(root, "notes.md"), "notes", "utf8");
      const owner = {};
      const otherOwner = {};
      const service = new DocumentWorkspaceService();
      const result = opened(await service.openForOwner(owner, root));
      const manuscript = result.manuscripts[0];

      expect(await service.resolveManuscriptPath(otherOwner, result.document.documentId, manuscript.manuscriptId))
        .toMatchObject({ kind: "error", code: "document-not-owned" });
      expect(await service.resolveManuscriptPath(owner, "00000000-0000-4000-8000-000000000000", manuscript.manuscriptId))
        .toMatchObject({ kind: "error", code: "document-not-owned" });
      expect(await service.resolveManuscriptPath(owner, "../../document", manuscript.manuscriptId))
        .toMatchObject({ kind: "error", code: "invalid-document-id" });
      expect(await service.resolveManuscriptPath(owner, result.document.documentId, "../../outside"))
        .toMatchObject({ kind: "error", code: "invalid-manuscript-id" });
      expect(await service.resolveManuscriptPath(owner, result.document.documentId, "00000000-0000-4000-8000-000000000000"))
        .toMatchObject({ kind: "error", code: "manuscript-not-owned" });
    });
  });

  it("replaces one owner's Document and invalidates the old path resolution", async () => {
    await withTempDirectory(async (directory) => {
      const firstRoot = path.join(directory, "first");
      const secondRoot = path.join(directory, "second");
      await mkdir(firstRoot);
      await mkdir(secondRoot);
      await writeFile(path.join(firstRoot, "first.md"), "first", "utf8");
      await writeFile(path.join(secondRoot, "second.md"), "second", "utf8");
      const owner = {};
      const service = new DocumentWorkspaceService();
      const first = opened(await service.openForOwner(owner, firstRoot));
      const second = opened(await service.openForOwner(owner, secondRoot));

      expect(await service.resolveManuscriptPath(owner, first.document.documentId, first.manuscripts[0].manuscriptId))
        .toMatchObject({ kind: "error", code: "document-not-owned" });
      expect(await service.resolveManuscriptPath(owner, second.document.documentId, second.manuscripts[0].manuscriptId))
        .toMatchObject({
          kind: "resolved",
          canonicalPath: path.join(await realpath(secondRoot), "second.md")
        });
    });
  });

  it("revalidates the retained file boundary before resolving a manuscript", async () => {
    await withTempDirectory(async (directory) => {
      const root = path.join(directory, "document");
      const outside = path.join(directory, "outside");
      await mkdir(root);
      await mkdir(outside);
      const manuscriptPath = path.join(root, "notes.md");
      await writeFile(manuscriptPath, "notes", "utf8");
      await writeFile(path.join(outside, "outside.md"), "outside", "utf8");
      const owner = {};
      const service = new DocumentWorkspaceService();
      const result = opened(await service.openForOwner(owner, root));

      await rm(manuscriptPath);
      await symlink(outside, manuscriptPath, "junction");
      const resolved = await service.resolveManuscriptPath(owner, result.document.documentId, result.manuscripts[0].manuscriptId);

      expect(resolved).toMatchObject({ kind: "error", code: "manuscript-unavailable" });
      expect(JSON.stringify(resolved)).not.toContain(outside);
    });
  });
});
