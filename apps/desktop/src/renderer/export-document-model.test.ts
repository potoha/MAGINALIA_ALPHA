import { describe, expect, it } from "vitest";

import {
  createExportDocumentModel,
  serializeExportDocumentModel
} from "./export-document-model";

describe("Export Document Model", () => {
  it("keeps the resolved Markdown lossless while exposing format-neutral block kinds", () => {
    const source = "---\ntitle: 作品論\n---\n\n# 作品論\n\n本文。\n\n- 第一\n- 第二\n\n> 引用\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```ts\nconst 日本語 = true;\n```\n\n[リンク](https://example.test) ![画像](assets/図版.png)\n";
    const model = createExportDocumentModel(source);

    expect(model.kind).toBe("export-document");
    expect(model.version).toBe(1);
    expect(model.blocks.map((item) => item.kind)).toEqual([
      "metadata", "raw", "heading", "raw", "paragraph", "raw", "list", "raw", "blockquote", "raw", "table", "raw", "code", "raw", "paragraph"
    ]);
    expect(model.blocks.find((item) => item.kind === "heading")).toMatchObject({ level: 1 });
    expect(model.blocks.find((item) => item.kind === "list")).toMatchObject({ ordered: false });
    expect(model.blocks.find((item) => item.kind === "code")?.markdown).toContain("日本語");
    expect(serializeExportDocumentModel(model)).toBe(source);
  });

  it("does not add runtime or authoring identities to the model", () => {
    const source = "# Export\n\n本文と解決済み引用。\n";
    const model = createExportDocumentModel(source);
    expect(JSON.stringify(model)).not.toContain("documentId");
    expect(JSON.stringify(model)).not.toContain("revision");
    expect(JSON.stringify(model)).not.toContain("synced-block");
    expect(serializeExportDocumentModel(model)).toBe(source);
  });
});
