import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { DocumentWorkspaceService } from "./document-workspace";
import { MarkdownFileService } from "./markdown-file-service";
import { parseProjectMetadata } from "./project-metadata";
import { MemoryProjectPathStore, ProjectService } from "./project-service";

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

describe("Project service", () => {
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

  it("creates a plain local Project folder without repository state", async () => {
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
      const stats = await lstat(path.join(parent, "Coffee Sapling"));
      expect(stats.isDirectory()).toBe(true);
    });
  });
});
