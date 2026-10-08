import { mkdtemp, mkdir, realpath, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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
  it("lists safe hierarchical metadata while hiding dot names and leading-quote directories only in Explorer", async () => {
    await withTempDirectory(async (root) => {
      for (const name of [".maginalia", ".git", ".codex", ".研究", "'temp", "'資料", "Alice's notes", "資料", "assets", "projects"]) {
        await mkdir(path.join(root, name));
        await writeFile(path.join(root, name, "memo.md"), name, "utf8");
      }
      await writeFile(path.join(root, ".hidden.md"), "hidden", "utf8");
      await writeFile(path.join(root, "'quoted-file.md"), "file", "utf8");
      await writeFile(path.join(root, "assets", "図.png"), "image", "utf8");
      const owner = {};
      const service = new DocumentWorkspaceService();
      const documentId = opened(await service.openForOwner(owner, root)).document.documentId;
      const listed = await service.listExplorerForOwner(owner, documentId, ["projects"]);
      expect(listed.kind).toBe("listed");
      if (listed.kind !== "listed") throw new Error("Explorer unavailable");
      expect(listed.entries.map((entry) => entry.relativeName)).toEqual([
        "'quoted-file.md", "Alice's notes", "Alice's notes/memo.md", "assets", "assets/memo.md", "assets/図.png", "資料", "資料/memo.md"
      ]);
      const folder = listed.entries.find((entry) => entry.relativeName === "資料")!;
      expect(listed.entries.find((entry) => entry.relativeName === "資料/memo.md")?.parentId).toBe(folder.entryId);
      expect(listed.entries.find((entry) => entry.relativeName === "assets/図.png")?.kind).toBe("file");
      expect(JSON.stringify(listed)).not.toContain(root);
      expect((await readdir(root)).includes("'temp")).toBe(true);
      expect(await readFile(path.join(root, "'資料", "memo.md"), "utf8")).toBe("'資料");
      const searchable = await service.listProjectMarkdownForOwner(owner, documentId);
      expect(Array.isArray(searchable) && searchable.some((entry) => entry.displayName === "'資料/memo.md")).toBe(true);
      expect(await service.listExplorerForOwner({}, documentId)).toMatchObject({ kind: "error", code: "document-not-owned" });
      const again = await service.listExplorerForOwner(owner, documentId, ["projects"]);
      expect(again).toEqual(listed);
    });
  });

  it("hides .magi marker files in Explorer without changing them or hiding matching directories", async () => {
    await withTempDirectory(async (root) => {
      const canonicalMarker = "version = 1\ntype = project\nid = 11111111-1111-4111-8111-111111111111\nparent = null\n";
      const renamedMarker = "version = 1\ntype = project\nid = 22222222-2222-4222-8222-222222222222\nparent = null\n";
      const malformedMarker = "not a valid marker\n";
      await writeFile(path.join(root, "project.magi"), canonicalMarker, "utf8");
      await writeFile(path.join(root, "卒論.MAGI"), renamedMarker, "utf8");
      await writeFile(path.join(root, "broken.magi"), malformedMarker, "utf8");
      await mkdir(path.join(root, "資料.magi"));
      await writeFile(path.join(root, "資料.magi", "chapter.md"), "chapter", "utf8");
      await writeFile(path.join(root, "notes.md"), "notes", "utf8");

      const owner = {};
      const service = new DocumentWorkspaceService();
      const documentId = opened(await service.openForOwner(owner, root)).document.documentId;
      const listed = await service.listExplorerForOwner(owner, documentId);
      expect(listed.kind).toBe("listed");
      if (listed.kind !== "listed") throw new Error("Explorer unavailable");

      expect(listed.entries.some((entry) => /\.magi$/iu.test(entry.displayName) && entry.kind !== "folder")).toBe(false);
      expect(listed.entries.find((entry) => entry.relativeName === "資料.magi")).toMatchObject({ kind: "folder" });
      expect(listed.entries.some((entry) => entry.relativeName === "資料.magi/chapter.md" && entry.kind === "markdown")).toBe(true);
      expect(listed.entries.some((entry) => entry.relativeName === "notes.md" && entry.kind === "markdown")).toBe(true);

      expect(await readFile(path.join(root, "project.magi"), "utf8")).toBe(canonicalMarker);
      expect(await readFile(path.join(root, "卒論.MAGI"), "utf8")).toBe(renamedMarker);
      expect(await readFile(path.join(root, "broken.magi"), "utf8")).toBe(malformedMarker);
    });
  });

  it("creates Unicode root and nested folders and Markdown without overwriting collisions", async () => {
    await withTempDirectory(async (root) => {
      const owner = {};
      const service = new DocumentWorkspaceService();
      const documentId = opened(await service.openForOwner(owner, root)).document.documentId;
      const folder = await service.createFolderForOwner(owner, documentId, null, "資料");
      expect(folder.kind).toBe("created");
      if (folder.kind !== "created") throw new Error("Folder unavailable");
      const nested = await service.createFolderForOwner(owner, documentId, folder.entry.entryId, "第一章");
      expect(nested).toMatchObject({ kind: "created", entry: { relativeName: "資料/第一章", parentId: folder.entry.entryId } });
      const manuscript = await service.createManuscriptForOwner(owner, documentId, "覚書.md", "---\ndocumentType: memo\n---\n本文", folder.entry.entryId);
      expect(manuscript).toMatchObject({ kind: "created", manuscript: { displayName: "資料/覚書.md" } });
      expect(await readFile(path.join(root, "資料", "覚書.md"), "utf8")).toContain("本文");
      const listed = await service.listExplorerForOwner(owner, documentId);
      if (listed.kind !== "listed" || manuscript.kind !== "created") throw new Error("Creation unavailable");
      const file = listed.entries.find((entry) => entry.relativeName === "資料/覚書.md")!;
      expect(file.entryId).toBe(manuscript.manuscript.manuscriptId);
      expect(await service.resolveExplorerFilePath(owner, documentId, file.entryId)).toMatchObject({ kind: "resolved", canonicalPath: path.join(await realpath(root), "資料", "覚書.md") });
      expect(await service.resolveExplorerFilePath(owner, documentId, folder.entry.entryId)).toMatchObject({ kind: "error", code: "explorer-entry-unavailable" });
      expect(await service.createFolderForOwner(owner, documentId, null, "資料")).toMatchObject({ kind: "error", code: "folder-exists" });
      expect(await service.createManuscriptForOwner(owner, documentId, "覚書.MD", "overwrite", folder.entry.entryId)).toMatchObject({ kind: "error", code: "manuscript-exists" });
      expect(await service.createFolderForOwner(owner, documentId, null, "'presentational")).toMatchObject({ kind: "created" });
    });
  });

  it("rejects unsafe or hidden creation names and guessed parent identities", async () => {
    await withTempDirectory(async (root) => {
      const owner = {};
      const service = new DocumentWorkspaceService();
      const documentId = opened(await service.openForOwner(owner, root)).document.documentId;
      for (const name of ["", " ", ".", "..", ".codex", " .hidden", "../escape", "a/b", "a\\b", root, "C:\\escape", "CON", "nul.txt", "COM1", "LPT²", "bad:", "trailing.", "a\u0000b"]) {
        expect(await service.createFolderForOwner(owner, documentId, null, name), name).toMatchObject({ kind: "error", code: "invalid-folder-name" });
      }
      for (const name of [".hidden.md", "../escape.md", "NUL.md", "a/b.md"]) {
        expect(await service.createManuscriptForOwner(owner, documentId, name, "text"), name).toMatchObject({ kind: "error", code: "invalid-manuscript-name" });
      }
      expect(await service.createFolderForOwner(owner, documentId, "../../outside", "safe")).toMatchObject({ kind: "error", code: "explorer-entry-unavailable" });
      expect(await service.createFolderForOwner(owner, documentId, "11111111-1111-4111-8111-111111111111", "safe")).toMatchObject({ kind: "error", code: "explorer-entry-unavailable" });
      expect(await readdir(root)).toEqual([]);
    });
  });

  it("rejects a selected parent replaced by a junction before creation or file resolution", async () => {
    await withTempDirectory(async (directory) => {
      const root = path.join(directory, "root");
      const outside = path.join(directory, "outside");
      await mkdir(root);
      await mkdir(outside);
      await mkdir(path.join(root, "notes"));
      await writeFile(path.join(root, "notes", "memo.md"), "inside");
      await writeFile(path.join(outside, "memo.md"), "outside");
      const owner = {};
      const service = new DocumentWorkspaceService();
      const documentId = opened(await service.openForOwner(owner, root)).document.documentId;
      const listed = await service.listExplorerForOwner(owner, documentId);
      if (listed.kind !== "listed") throw new Error("Explorer unavailable");
      const parent = listed.entries.find((entry) => entry.kind === "folder")!;
      const file = listed.entries.find((entry) => entry.kind === "markdown")!;
      await rm(path.join(root, "notes"), { recursive: true });
      await symlink(outside, path.join(root, "notes"), "junction");
      expect(await service.createFolderForOwner(owner, documentId, parent.entryId, "new")).toMatchObject({ kind: "error", code: "explorer-entry-unavailable" });
      expect(await service.createManuscriptForOwner(owner, documentId, "new.md", "new", parent.entryId)).toMatchObject({ kind: "error", code: "explorer-entry-unavailable" });
      expect(await service.resolveExplorerFilePath(owner, documentId, file.entryId)).toMatchObject({ kind: "error", code: "explorer-entry-unavailable" });
      expect(await readdir(outside)).toEqual(["memo.md"]);
    });
  });

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

      // Workspace persistence stores these opaque handles, so reopening the
      // same canonical root must reproduce them instead of generating a new
      // set that would make saved tabs impossible to restore.
      const reopened = opened(await service.openForOwner({}, root));
      expect(reopened.document.documentId).toBe(result.document.documentId);
      expect(reopened.manuscripts.map((manuscript) => manuscript.manuscriptId))
        .toEqual(result.manuscripts.map((manuscript) => manuscript.manuscriptId));
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
