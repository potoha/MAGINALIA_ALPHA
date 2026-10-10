import { describe, expect, it, vi } from "vitest";
import { createExportDocumentModel } from "./renderer/export-document-model";
import {
  collectExportImageReferences,
  ExportImageError,
  resolveExportImageAssets
} from "./export-project-images";

const imageDataUrl = "data:image/png;base64,iVBORw0KGgo=";

describe("Project-local image export resolution", () => {
  it("collects exact image references in document order while skipping metadata and code", () => {
    const model = createExportDocumentModel([
      "---",
      "image: ![[assets/metadata.png]]",
      "---",
      "",
      "# ![[assets/title.png]]",
      "",
      "本文 ![図](assets/figure.png) と ![[assets/図版 資料.png]]。",
      "",
      "> ![[assets/blockquote.png]]",
      "",
      "- ![[assets/list.png]]",
      "",
      "| 図 | 説明 |",
      "| --- | --- |",
      "| ![[assets/table.png]] | `![[assets/inline-code.png]]` |",
      "",
      "```md",
      "![[assets/fenced-code.png]]",
      "```",
      ""
    ].join("\n"));

    expect(collectExportImageReferences(model)).toEqual([
      "assets/title.png",
      "assets/figure.png",
      "assets/図版 資料.png",
      "assets/blockquote.png",
      "assets/list.png",
      "assets/table.png"
    ]);
  });

  it("resolves each unique reference through the owner-bound resolver", async () => {
    const owner = {};
    const model = createExportDocumentModel("![図](assets/figure.png) ![[assets/figure.png]]\n");
    const resolveAsset = vi.fn(async (actualOwner: object, projectId: string, relativePath: string) => {
      expect(actualOwner).toBe(owner);
      expect(projectId).toBe("project-opaque-id");
      expect(relativePath).toBe("assets/figure.png");
      return { kind: "resolved" as const, assetKind: "image" as const, mimeType: "image/png" as const, dataUrl: imageDataUrl };
    });

    const images = await resolveExportImageAssets(owner, "project-opaque-id", model, resolveAsset);

    expect(resolveAsset).toHaveBeenCalledOnce();
    expect([...images.keys()]).toEqual(["assets/figure.png"]);
    expect(images.get("assets/figure.png")).toEqual({ mimeType: "image/png", dataUrl: imageDataUrl });
  });

  it("rejects images without a Project association and preserves the user's source", async () => {
    const source = "![図](assets/figure.png)\n";
    const model = createExportDocumentModel(source);
    await expect(resolveExportImageAssets({}, undefined, model, undefined))
      .rejects.toThrow("Projectを開き直してから書き出してください。");
    expect(model.blocks.map((block) => block.markdown).join("")).toBe(source);
  });

  it("rejects unsafe, remote, and raw HTML image references instead of dropping them", async () => {
    for (const source of [
      "![[../outside.png]]",
      "![remote](https://example.test/image.png)",
      "<img src=\"file:///C:/outside.png\" alt=\"private\">"
    ]) {
      expect(() => collectExportImageReferences(createExportDocumentModel(source))).toThrow(ExportImageError);
    }
  });

  it("reports a missing image as an actionable Japanese error", async () => {
    const model = createExportDocumentModel("![[assets/見つからない.png]]");
    await expect(resolveExportImageAssets({}, "project", model, async () => ({
      kind: "error",
      code: "missing",
      message: "internal error"
    }))).rejects.toThrow("Project内に画像「assets/見つからない.png」が見つからないため、書き出せませんでした。");
  });

  it("does not export Project videos as document images", async () => {
    const model = createExportDocumentModel("![[assets/movie.mp4]]");
    await expect(resolveExportImageAssets({}, "project", model, async () => ({
      kind: "resolved",
      assetKind: "video",
      mimeType: "video/mp4",
      dataUrl: "data:video/mp4;base64,AAAA"
    }))).rejects.toThrow("PDF・DOCXには動画を含められません。");
  });
});
