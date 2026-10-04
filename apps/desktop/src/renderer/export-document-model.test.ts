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

  it("follows the Renderer heading grammar instead of promoting empty or indented hashes", () => {
    const source = "#\n  # indented\n## Valid\n";
    const model = createExportDocumentModel(source);

    expect(model.blocks.map((item) => item.kind)).toEqual(["paragraph", "heading"]);
    expect(model.blocks.find((item) => item.kind === "heading")?.level).toBe(2);
    expect(serializeExportDocumentModel(model)).toBe(source);
  });

  it("uses canonical table boundaries and rejects malformed divider widths", () => {
    const malformed = "| A | B |\n| --- |\n| 1 | 2 |\n";
    const valid = "| A | B |\n| --- | --- |\n| 1 | 2 |\n";

    expect(createExportDocumentModel(malformed).blocks.some((item) => item.kind === "table")).toBe(false);
    expect(createExportDocumentModel(valid).blocks.some((item) => item.kind === "table")).toBe(true);
    expect(serializeExportDocumentModel(createExportDocumentModel(malformed))).toBe(malformed);
  });

  it("keeps fenced content inert with shared backtick/tilde length semantics", () => {
    const source = [
      "````md",
      "# fake",
      "```",
      "| fake | table |",
      "````",
      "~~~md",
      "## fake",
      "~~~~",
      "## real",
      ""
    ].join("\n");
    const model = createExportDocumentModel(source);

    expect(model.blocks.map((item) => item.kind)).toEqual(["code", "code", "heading"]);
    expect(model.blocks.filter((item) => item.kind === "heading")).toHaveLength(1);
    expect(serializeExportDocumentModel(model)).toBe(source);
  });

  it("uses H.7.4 front-matter scan states without inventing a boundary", () => {
    const bounded = "\uFEFF---\r\ntitle: 日本語\r\n...\r\n\r\n# 本文\r\n";
    const unterminated = "---\n title: [\n\n本文\n";

    expect(createExportDocumentModel(bounded).blocks[0]?.kind).toBe("metadata");
    expect(createExportDocumentModel(unterminated).blocks[0]?.kind).not.toBe("metadata");
    expect(serializeExportDocumentModel(createExportDocumentModel(bounded))).toBe(bounded);
    expect(serializeExportDocumentModel(createExportDocumentModel(unterminated))).toBe(unterminated);
  });

  it("remains lossless for CRLF, BOM, and Unicode regardless of classification", () => {
    const source = "\uFEFF# 見出し\r\n\r\n本文 😀\r\n";
    expect(serializeExportDocumentModel(createExportDocumentModel(source))).toBe(source);
  });
});
