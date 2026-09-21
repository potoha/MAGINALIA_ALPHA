import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { DocumentWorkspaceService } from "./document-workspace";
import { ProjectAssetService, validateProjectAssetPath } from "./project-assets";

async function withProject(
  test: (context: {
    readonly root: string;
    readonly sourceDirectory: string;
    readonly owner: object;
    readonly projectId: string;
    readonly assets: ProjectAssetService;
  }) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "maginalia-assets-"));
  const root = path.join(directory, "project");
  const sourceDirectory = path.join(directory, "drop");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "manuscript.md"), "");
  try {
    const workspace = new DocumentWorkspaceService();
    const owner = {};
    const opened = await workspace.openForOwner(owner, root);
    if (opened.kind !== "opened") throw new Error(opened.message);
    await mkdir(sourceDirectory, { recursive: true });
    await test({
      root,
      sourceDirectory,
      owner,
      projectId: opened.document.documentId,
      assets: new ProjectAssetService(workspace)
    });
  } finally {
    // libvips may release a transformed file one event-loop turn after its
    // metadata promise resolves on Windows.
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

describe("ProjectAssetService", () => {
  it("accepts only strict POSIX Project-relative paths", () => {
    expect(validateProjectAssetPath("assets/figure.webp")).toBe("assets/figure.webp");
    for (const value of ["../secret.png", "assets/../secret.png", "/secret.png", "C:/secret.png", "assets\\secret.png", "assets//secret.png"]) {
      expect(validateProjectAssetPath(value)).toBeNull();
    }
  });

  it("returns a path-free, signature-checked media representation only for the opened Project", async () => {
    await withProject(async ({ root, owner, projectId, assets }) => {
      const assetDirectory = path.join(root, "assets");
      await mkdir(assetDirectory, { recursive: true });
      await sharp({ create: { width: 2, height: 2, channels: 4, background: "#ff0000" } }).png().toFile(path.join(assetDirectory, "figure.png"));

      const resolved = await assets.resolveForOwner(owner, projectId, "assets/figure.png");
      expect(resolved).toMatchObject({ kind: "resolved", assetKind: "image", mimeType: "image/png" });
      if (resolved.kind === "resolved") expect(resolved.dataUrl).not.toContain(root);
      expect((await assets.resolveForOwner(owner, projectId, "../figure.png")).kind).toBe("error");
      expect((await assets.resolveForOwner({}, projectId, "assets/figure.png")).kind).toBe("error");
    });
  });

  it("imports collision-safe optimized WebP without modifying the dropped original", async () => {
    await withProject(async ({ root, sourceDirectory, owner, projectId, assets }) => {
      const source = path.join(sourceDirectory, "my figure.png");
      await sharp({ create: { width: 2000, height: 500, channels: 4, background: "#00ff00" } }).png().toFile(source);
      const before = await readFile(source);

      const first = await assets.importDroppedImageForOwner(owner, projectId, source, true);
      const second = await assets.importDroppedImageForOwner(owner, projectId, source, true);
      expect(first).toMatchObject({ kind: "imported", relativePath: "assets/my-figure.webp", mimeType: "image/webp" });
      expect(second).toMatchObject({ kind: "imported", relativePath: "assets/my-figure-1.webp", mimeType: "image/webp" });
      expect(await readFile(source)).toEqual(before);

      if (first.kind === "imported") {
        // Feed libvips bytes rather than a path so Windows has no lingering
        // handle on the temporary asset during fixture cleanup.
        const metadata = await sharp(await readFile(path.join(root, ...first.relativePath.split("/")))).metadata();
        expect(metadata.format).toBe("webp");
        expect(metadata.width).toBe(1600);
        expect(metadata.height).toBe(400);
      }
    });
  });

  it("copies the original extension when image optimization is disabled", async () => {
    await withProject(async ({ root, sourceDirectory, owner, projectId, assets }) => {
      const source = path.join(sourceDirectory, "original.png");
      await sharp({ create: { width: 3, height: 3, channels: 3, background: "#0000ff" } }).png().toFile(source);
      const sourceBytes = await readFile(source);
      const result = await assets.importDroppedImageForOwner(owner, projectId, source, false);
      expect(result).toMatchObject({ kind: "imported", relativePath: "assets/original.png", mimeType: "image/png" });
      if (result.kind === "imported") expect(await readFile(path.join(root, ...result.relativePath.split("/")))).toEqual(sourceBytes);
    });
  });

  it("does not create an asset for an unsupported drop", async () => {
    await withProject(async ({ root, sourceDirectory, owner, projectId, assets }) => {
      const source = path.join(sourceDirectory, "not-an-image.png");
      await writeFile(source, "not an image");
      const result = await assets.importDroppedImageForOwner(owner, projectId, source, true);
      expect(result.kind).toBe("error");
      await expect(access(path.join(root, "assets", "not-an-image.webp"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
