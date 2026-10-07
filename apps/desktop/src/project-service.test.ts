import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parseFolderMarkerText, serializeFolderMarker } from "@maginalia/repository-core";
import { DocumentWorkspaceService } from "./document-workspace";
import { MarkdownFileService } from "./markdown-file-service";
import { parseProjectMetadata } from "./project-metadata";
import { FileProjectPathStore, MemoryProjectPathStore, ProjectService, withCopiedDocumentType } from "./project-service";

async function withTempDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "maginalia-project-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function opened<T extends { kind: string }>(value: T): Extract<T, { kind: "opened" }> {
  expect(value.kind).toBe("opened");
  return value as Extract<T, { kind: "opened" }>;
}

describe("FileProjectPathStore local settings", () => {
  it("creates an empty default-creation-parent placeholder when the file is absent", async () => {
    await withTempDirectory(async (directory) => {
      const filePath = path.join(directory, "profile", "last-project.json");
      const store = new FileProjectPathStore(filePath);

      await store.ensureDefaultCreationParentPlaceholder();

      expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({ defaultCreationParent: null });
      expect(await store.load()).toBeNull();
    });
  });

  it("preserves the last-opened root and configured creation parent", async () => {
    await withTempDirectory(async (directory) => {
      const filePath = path.join(directory, "last-project.json");
      const previousRoot = path.join(directory, "previous-project");
      const configuredParent = path.join(directory, "chosen-projects-folder");
      await writeFile(filePath, `${JSON.stringify({ rootPath: previousRoot })}\n`, "utf8");
      const store = new FileProjectPathStore(filePath);

      await store.ensureDefaultCreationParentPlaceholder();
      expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({
        rootPath: previousRoot,
        defaultCreationParent: null
      });

      await writeFile(filePath, `${JSON.stringify({ rootPath: previousRoot, defaultCreationParent: configuredParent })}\n`, "utf8");
      await store.ensureDefaultCreationParentPlaceholder();
      const beforeSave = JSON.parse(await readFile(filePath, "utf8"));
      expect(beforeSave).toEqual({ rootPath: previousRoot, defaultCreationParent: configuredParent });

      const nextRoot = path.join(directory, "next-project");
      await store.save(nextRoot);
      expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({
        rootPath: nextRoot,
        defaultCreationParent: configuredParent
      });
    });
  });

  it("is idempotent after initialization", async () => {
    await withTempDirectory(async (directory) => {
      const filePath = path.join(directory, "last-project.json");
      const store = new FileProjectPathStore(filePath);
      await store.ensureDefaultCreationParentPlaceholder();
      const initialized = await readFile(filePath, "utf8");

      await store.ensureDefaultCreationParentPlaceholder();

      expect(await readFile(filePath, "utf8")).toBe(initialized);
    });
  });

  it("does not replace malformed or unreadable settings", async () => {
    await withTempDirectory(async (directory) => {
      const malformedPath = path.join(directory, "malformed.json");
      const malformed = "{not valid json\n";
      await writeFile(malformedPath, malformed, "utf8");
      await expect(new FileProjectPathStore(malformedPath).ensureDefaultCreationParentPlaceholder()).rejects.toThrow();
      expect(await readFile(malformedPath, "utf8")).toBe(malformed);

      const invalidShapePath = path.join(directory, "invalid-shape.json");
      const invalidShape = `${JSON.stringify({ rootPath: "relative-project-path" })}\n`;
      await writeFile(invalidShapePath, invalidShape, "utf8");
      await expect(new FileProjectPathStore(invalidShapePath).ensureDefaultCreationParentPlaceholder()).rejects.toThrow();
      expect(await readFile(invalidShapePath, "utf8")).toBe(invalidShape);

      const unreadablePath = path.join(directory, "unreadable.json");
      await mkdir(unreadablePath);
      await expect(new FileProjectPathStore(unreadablePath).ensureDefaultCreationParentPlaceholder()).rejects.toThrow();
      expect((await lstat(unreadablePath)).isDirectory()).toBe(true);
    });
  });
});

describe("Project service", () => {
  it("resolves a Synced Block source through owned Project containment without exposing a path", async () => {
    await withTempDirectory(async (directory) => {
      const root = path.join(directory, "project");
      await mkdir(path.join(root, "chapters"), { recursive: true });
      await writeFile(path.join(root, "chapters", "春.md"), "# 春\n本文\n", "utf8");
      const owner = {};
      const service = new ProjectService(new DocumentWorkspaceService(), new MarkdownFileService(), new MemoryProjectPathStore());
      const project = opened(await service.openForOwner(owner, root));
      const result = await service.resolveSyncedDocumentForOwner(owner, project.project.projectId, "chapters/春.md");
      expect(result).toMatchObject({ kind: "resolved", target: "chapters/春.md", displayName: "chapters/春.md", text: "# 春\n本文\n" });
      expect(JSON.stringify(result)).not.toContain(root);
      await expect(service.resolveSyncedDocumentForOwner(owner, project.project.projectId, "../outside.md"))
        .resolves.toMatchObject({ kind: "invalid" });
    });
  });

  it("opens a local folder as a flat Registry and creates ordinary Markdown", async () => {
    await withTempDirectory(async (directory) => {
      const root = path.join(directory, "coffee");
      await mkdir(root);
      await writeFile(path.join(root, "draft.md"), "---\ntype: draft\ntitle: Draft\n---\n\n本文", "utf8");
      await writeFile(path.join(root, "broken.md"), "---\ntype: nope\n---\n\n読める本文", "utf8");
      const owner = {};
      const service = new ProjectService(
        new DocumentWorkspaceService(),
        new MarkdownFileService(),
        new MemoryProjectPathStore()
      );

      const project = opened(await service.openForOwner(owner, root));
      expect(project.project.displayName).toBe("coffee");
      expect(project.files.map((file) => [file.displayName, file.documentType])).toEqual([
        ["broken.md", "other"],
        ["draft.md", "draft"]
      ]);
      expect(JSON.stringify(project)).not.toContain(root);

      const documentTitle = "エーコ: 「開かれた作品」について";
      const created = await service.createFileForOwner(owner, project.project.projectId, "memo", documentTitle, "memo");
      expect(created.kind).toBe("created");
      if (created.kind !== "created") throw new Error("Expected a created file");
      expect(created.file.displayName).toBe("memo.md");
      expect(created.file.documentType).toBe("memo");
      expect(created.file.title).toBe(documentTitle);
      expect(parseProjectMetadata(await readFile(path.join(root, "memo.md"), "utf8"), "memo.md")).toEqual({
        documentType: "memo",
        title: documentTitle,
        valid: true
      });

      const duplicate = await service.createFileForOwner(owner, project.project.projectId, "memo.md", "Again", "memo");
      expect(duplicate).toMatchObject({ kind: "error", code: "manuscript-exists" });
      expect((await service.openFileForOwner(owner, project.project.projectId, created.file.fileId)).kind).toBe("opened");
    });
  });

  it("restores a remembered Project and reports a missing folder clearly", async () => {
    await withTempDirectory(async (directory) => {
      const root = path.join(directory, "saved");
      await mkdir(root);
      const store = new MemoryProjectPathStore();
      const service = new ProjectService(new DocumentWorkspaceService(), new MarkdownFileService(), store);
      expect((await service.restoreForOwner({})).kind).toBe("none");
      const first = opened(await service.openForOwner({}, root));
      expect(first.project.displayName).toBe("saved");

      const owner = {};
      await service.openForOwner(owner, root);
      expect((await service.restoreForOwner(owner)).kind).toBe("opened");
      await rm(root, { recursive: true, force: true });
      expect(await service.restoreForOwner(owner)).toMatchObject({ kind: "error", code: "project-state-unavailable" });
    });
  });

  it("creates a plain local Project with a typed marker and no Git state", async () => {
    await withTempDirectory(async (directory) => {
      const parent = path.join(directory, "projects");
      await mkdir(parent);
      const service = new ProjectService(
        new DocumentWorkspaceService(),
        new MarkdownFileService(),
        new MemoryProjectPathStore()
      );
      const result = await service.createForOwner({}, parent, "Coffee Sapling");
      expect(result).toMatchObject({ kind: "opened", project: { displayName: "Coffee Sapling" }, files: [] });
      const projectRoot = path.join(parent, "Coffee Sapling");
      const stats = await lstat(projectRoot);
      expect(stats.isDirectory()).toBe(true);
      expect(parseFolderMarkerText(await readFile(path.join(projectRoot, "project.magi"), "utf8"))).toMatchObject({
        version: 1,
        type: "project",
        parent: null,
      });
      await expect(lstat(path.join(projectRoot, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("creates a Workdesk child Project with the parent UUID without initializing Git", async () => {
    await withTempDirectory(async (directory) => {
      const parent = path.join(directory, "projects");
      await mkdir(parent);
      const workdeskId = "22222222-2222-4222-8222-222222222222";
      const service = new ProjectService(new DocumentWorkspaceService(), new MarkdownFileService(), new MemoryProjectPathStore());

      const result = await service.createForWorkdesk(parent, "子Project", workdeskId);

      expect(result).toMatchObject({ kind: "created" });
      if (result.kind !== "created") throw new Error("Expected a Workdesk Project folder.");
      expect(parseFolderMarkerText(await readFile(path.join(result.canonicalRoot, "project.magi"), "utf8"))).toMatchObject({
        type: "project",
        parent: workdeskId,
      });
      await expect(lstat(path.join(result.canonicalRoot, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("opens Workdesk loose files without creating a competing Project marker", async () => {
    await withTempDirectory(async (directory) => {
      const root = path.join(directory, "作業机");
      await mkdir(root);
      await writeFile(path.join(root, "workdesk.magi"), serializeFolderMarker({
        version: 1, type: "workdesk", id: "22222222-2222-4222-8222-222222222222",
      }), "utf8");
      await writeFile(path.join(root, "メモ.md"), "# 今日のメモ\n", "utf8");
      const service = new ProjectService(new DocumentWorkspaceService(), new MarkdownFileService(), new MemoryProjectPathStore());

      const result = await service.openWorkdeskLooseFilesForOwner({}, root);

      expect(result).toMatchObject({ kind: "opened", files: [{ displayName: "メモ.md" }] });
      if (result.kind !== "opened") throw new Error("Expected loose Workdesk files to open.");
      expect(result.folderIdentityRecovery).toBeUndefined();
      expect(new Set(await readdir(root))).toEqual(new Set(["メモ.md", "workdesk.magi"]));
    });
  });

  it("opens Workdesk recovery documents without remembering the root as a Project", async () => {
    await withTempDirectory(async (directory) => {
      const root = path.join(directory, "作業机");
      await mkdir(root);
      await writeFile(path.join(root, "メモ.md"), "# 保存済みメモ\n", "utf8");
      const store = new MemoryProjectPathStore();
      const service = new ProjectService(new DocumentWorkspaceService(), new MarkdownFileService(), store);

      const result = await service.openWorkdeskLooseFilesForOwner({}, root, { rememberAsProject: false });

      expect(result).toMatchObject({ kind: "opened", files: [{ displayName: "メモ.md" }] });
      expect(await store.load()).toBeNull();
      expect(await readdir(root)).toEqual(["メモ.md"]);
    });
  });

  it("opens authored files while surfacing conflicting Project markers for recovery", async () => {
    await withTempDirectory(async (directory) => {
      const root = path.join(directory, "卒論資料");
      await mkdir(root);
      const authoredPath = path.join(root, "序論.md");
      const authored = "# 日本語の原稿\n保存した本文です。\n";
      await writeFile(authoredPath, authored, "utf8");
      await writeFile(path.join(root, "project.magi"), serializeFolderMarker({
        version: 1, type: "project", id: "11111111-1111-4111-8111-111111111111", parent: null,
      }), "utf8");
      await writeFile(path.join(root, "卒論.magi"), serializeFolderMarker({
        version: 1, type: "project", id: "22222222-2222-4222-8222-222222222222", parent: null,
      }), "utf8");

      const service = new ProjectService(new DocumentWorkspaceService(), new MarkdownFileService(), new MemoryProjectPathStore());
      const opened = await service.openForOwner({}, root);

      expect(opened).toMatchObject({
        kind: "opened",
        files: [{ displayName: "序論.md" }],
        folderIdentityRecovery: { code: "marker-conflict" },
      });
      expect(await readFile(authoredPath, "utf8")).toBe(authored);
      expect(await readdir(root)).toEqual(expect.arrayContaining(["project.magi", "卒論.magi"]));
    });
  });

  it("copies a Workdesk source as an independent, collision-safe Project document", async () => {
    await withTempDirectory(async (directory) => {
      const sourceRoot = path.join(directory, "workdesk");
      const destinationRoot = path.join(directory, "project");
      await mkdir(sourceRoot);
      await mkdir(destinationRoot);
      const sourceText = "---\r\ntype: memo\r\ntitle: Source title\r\n---\r\n\r\n# Exact source\r\n\r\n[[note]]\r\n";
      await writeFile(path.join(sourceRoot, "memo.md"), sourceText, "utf8");

      const service = new ProjectService(new DocumentWorkspaceService(), new MarkdownFileService(), new MemoryProjectPathStore());
      const sourceOwner = {};
      const destinationOwner = {};
      const sourceProject = opened(await service.openForOwner(sourceOwner, sourceRoot));
      const destinationProject = opened(await service.openForOwner(destinationOwner, destinationRoot));
      const sourceFile = sourceProject.files.find((file) => file.displayName === "memo.md");
      expect(sourceFile).toBeDefined();
      const source = await service.readCopySourceForOwner(sourceOwner, sourceProject.project.projectId, sourceFile!.fileId);
      expect("kind" in source).toBe(false);
      if ("kind" in source) throw new Error("Expected an owner-bound copy source");

      const first = await service.copySourceToProjectForOwner(
        destinationOwner,
        destinationProject.project.projectId,
        source,
        "memo"
      );
      expect(first).toMatchObject({ kind: "created", file: { displayName: "memo.md", documentType: "memo" } });
      expect(await readFile(path.join(destinationRoot, "memo.md"), "utf8")).toBe(sourceText);
      expect(await readFile(path.join(sourceRoot, "memo.md"), "utf8")).toBe(sourceText);

      const second = await service.copySourceToProjectForOwner(
        destinationOwner,
        destinationProject.project.projectId,
        source,
        "draft"
      );
      expect(second).toMatchObject({ kind: "created", file: { displayName: "memo-001.md", documentType: "draft" } });
      const changedType = await readFile(path.join(destinationRoot, "memo-001.md"), "utf8");
      expect(parseProjectMetadata(changedType, "memo-001.md")).toMatchObject({ documentType: "draft", title: "Source title" });
      expect(changedType).toContain("# Exact source\r\n\r\n[[note]]\r\n");
      expect(await readFile(path.join(sourceRoot, "memo.md"), "utf8")).toBe(sourceText);

      await writeFile(path.join(destinationRoot, "memo-002.md"), "already here", "utf8");
      const third = await service.copySourceToProjectForOwner(
        destinationOwner,
        destinationProject.project.projectId,
        source,
        "other"
      );
      expect(third).toMatchObject({ kind: "created", file: { displayName: "memo-003.md", documentType: "other" } });
      expect(await readFile(path.join(destinationRoot, "memo-002.md"), "utf8")).toBe("already here");
    });
  });

  it("changes only YAML type for an explicit cross-type copy and preserves an untyped body", () => {
    const typed = "---\ntitle: Keep\ntype: memo\ncreated: 2026-01-01\n---\n\nBody\n";
    expect(withCopiedDocumentType(typed, "body")).toBe("---\ntitle: Keep\ntype: body\ncreated: 2026-01-01\n---\n\nBody\n");
    expect(withCopiedDocumentType("Plain body\n", "draft")).toBe("---\ntype: draft\n---\n\nPlain body\n");
  });

  it("searches only the current Project Markdown with opaque ids and literal Unicode matching", async () => {
    await withTempDirectory(async (directory) => {
      const root = path.join(directory, "searchable");
      const otherRoot = path.join(directory, "other");
      await mkdir(path.join(root, "notes"), { recursive: true });
      await mkdir(otherRoot);
      await writeFile(path.join(root, "notes", "eco.md"), "# エーコ\n作品の開放性について。", "utf8");
      await writeFile(path.join(root, "miss.md"), "different", "utf8");
      await writeFile(path.join(otherRoot, "outside.md"), "作品の開放性", "utf8");
      const owner = {};
      const service = new ProjectService(new DocumentWorkspaceService(), new MarkdownFileService(), new MemoryProjectPathStore());
      const project = opened(await service.openForOwner(owner, root));
      const result = await service.searchMarkdownForOwner(owner, project.project.projectId, "作品の開放性");
      expect(result.total).toBe(1);
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toMatchObject({ displayName: "notes/eco.md" });
      expect(result.results[0]?.excerpt).toContain("作品の開放性");
      expect(JSON.stringify(result)).not.toContain(root);
      expect(JSON.stringify(result)).not.toContain(otherRoot);
    });
  });
});
