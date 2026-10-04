import { describe, expect, it } from "vitest";
import {
  parseMarkdownBlocks,
  parseMarkdownInlines,
  collectEditablePreviewRanges,
  scanLocalMediaTargets,
  scanQuoteMarkersFromText
} from "./markdown-renderer";
import { restoreRendererPreferences } from "./renderer-preferences";
import { collectMarkdownTables } from "./markdown-table-commands";
import { projectMarkdownBody } from "./document-properties";
import { scanSyncedBlockMarkers, serializeSyncedBlock } from "./synced-block";

describe("Markdown preview parser", () => {
  it("maps safe rendered text to exact original UTF-16 ranges without searching repeated text", () => {
    const source = "\uFEFF# 春🌸\r\n\r\nMoon.\r\n\r\nMoon.\r\n\r\n> 引用\r\n\r\n- **強い** [label](https://example.test)";
    const blocks = collectEditablePreviewRanges(source);
    const ranges = blocks.flat();
    expect(ranges.map((range) => range.text)).toEqual(["春🌸", "Moon.", "Moon.", "引用", "強い", " ", "label"]);
    expect(ranges.map((range) => source.slice(range.start, range.end))).toEqual(ranges.map((range) => range.text));
    expect(ranges[1]?.start).not.toBe(ranges[2]?.start);
    expect(ranges[1]?.start).toBe(source.indexOf("Moon."));
    expect(ranges[2]?.start).toBe(source.lastIndexOf("Moon."));
    expect(ranges[0]).toMatchObject({ start: 3, end: 6 });
  });

  it("keeps front matter out of the prose projection while retaining original source offsets", () => {
    const source = "\uFEFF---\r\ntype: draft\r\ntitle: 春\r\n---\r\n\r\n# 春\r\n本文\r\n\r\n| A | B |\r\n| --- | --- |\r\n| 1 | 2 |\r\n";
    const projection = projectMarkdownBody(source);
    expect(parseMarkdownBlocks(projection.body).map((block) => block.kind)).toEqual(["heading", "paragraph", "table"]);
    const proseRange = collectEditablePreviewRanges(projection.body, projection.start).flat().find((range) => range.text === "本文");
    expect(proseRange).toMatchObject({ start: source.indexOf("本文") });
    const table = collectMarkdownTables(projection.body, projection.start)[0];
    expect(table?.start).toBe(source.indexOf("| A | B |"));
  });

  it("leaves protected tables, fenced code, raw HTML and hard-wrapped paragraphs unmapped", () => {
    const source = [
      "before",
      "after",
      "",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "```",
      "code",
      "```",
      "",
      "<!-- protected -->"
    ].join("\n");
    expect(collectEditablePreviewRanges(source).map((ranges) => ranges.length)).toEqual([0, 0, 0, 0]);
  });
  it("keeps raw HTML and scripts as text rather than executable nodes", () => {
    const nodes = parseMarkdownInlines("before <script>alert(1)</script> <img src=x>");
    expect(nodes).toEqual([{ kind: "text", text: "before <script>alert(1)</script> <img src=x>" }]);
  });

  it("allows only portable external link protocols", () => {
    const safe = parseMarkdownInlines("[site](https://example.test/path)");
    expect(safe[0]).toMatchObject({ kind: "link", href: "https://example.test/path" });
    expect(parseMarkdownInlines("[bad](javascript:alert(1))")).toEqual([
      { kind: "text", text: "[bad](javascript:alert(1))" }
    ]);
  });

  it("parses ordinary headings, blockquotes, lists, and fenced code", () => {
    const blocks = parseMarkdownBlocks("# 見出し\n\n> quote\n\n- one\n- two\n\n```\nconst x = 1;\n```");
    expect(blocks.map((block) => block.kind)).toEqual(["heading", "blockquote", "list", "code"]);
  });

  it("keeps Synced Block source comments structural and never maps them as parent prose", () => {
    const marker = serializeSyncedBlock("chapters/one.md");
    const source = `before\n\n${marker}\n\nafter`;
    expect(parseMarkdownBlocks(source).map((block) => block.kind)).toEqual(["paragraph", "synced-block", "paragraph"]);
    expect(collectEditablePreviewRanges(source).flat().map((range) => range.text)).toEqual(["before", "after"]);
  });

  it("keeps valid and invalid whole-line Synced Block markers structurally aligned without blank lines", () => {
    const valid = serializeSyncedBlock("chapters/one.md");
    const invalid = "<!-- maginalia:synced-block v2 {\"target\":\"future.md\"} -->";
    for (const marker of [valid, invalid]) {
      const source = `before\n${marker}\nafter`;
      expect(parseMarkdownBlocks(source).map((block) => block.kind)).toEqual(["paragraph", "synced-block", "paragraph"]);
      expect(collectEditablePreviewRanges(source).map((ranges) => ranges.map((range) => range.text))).toEqual([["before"], [], ["after"]]);
    }
    expect(scanSyncedBlockMarkers(`before\n${invalid}\nafter`)).toMatchObject([{ kind: "invalid" }]);
  });

  it("keeps marker-shaped fenced code inert in every structural consumer", () => {
    const source = `before\n\`\`\`md\n${serializeSyncedBlock("fake.md")}\n\`\`\`\nafter`;
    expect(parseMarkdownBlocks(source).map((block) => block.kind)).toEqual(["paragraph", "code", "paragraph"]);
    expect(collectEditablePreviewRanges(source).map((ranges) => ranges.map((range) => range.text))).toEqual([["before"], [], ["after"]]);
    expect(scanSyncedBlockMarkers(source)).toEqual([]);
  });

  it("keeps all six heading levels distinct in the presentation AST", () => {
    const blocks = parseMarkdownBlocks("# 一\n## 二\n### 三\n#### 四\n##### 五\n###### 六");
    expect(blocks.map((block) => block.kind === "heading" ? block.depth : null)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("recognizes a BOM-prefixed H1 so all six heading levels reach presentation", () => {
    const blocks = parseMarkdownBlocks("\uFEFF# 一\n## 二\n### 三\n#### 四\n##### 五\n###### 六");
    expect(blocks.map((block) => block.kind === "heading" ? block.depth : null)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("parses Markdown tables structurally without treating escaped pipes as columns", () => {
    const blocks = parseMarkdownBlocks(String.raw`| 作品 | 評価 |
| :--- | ---: |
| 『存在の耐えられない軽さ』 | 5 |
| A\|B | mixed Latin |
| A\\|B |
| A\\\|B | odd slash run |
| terminal escaped\|`);
    const table = blocks[0];
    expect(table).toMatchObject({ kind: "table", alignments: ["left", "right"] });
    if (table?.kind !== "table") throw new Error("Expected a table block.");
    expect(table.header.map((cell) => cell[0]?.kind === "text" ? cell[0].text : "")).toEqual(["作品", "評価"]);
    expect(table.rows[1]?.[0]?.[0]).toMatchObject({ kind: "text", text: "A|B" });
    expect(table.rows[2]?.map((cell) => cell[0]?.kind === "text" ? cell[0].text : "")).toEqual(["A\\", "B"]);
    expect(table.rows[3]?.map((cell) => cell[0]?.kind === "text" ? cell[0].text : "")).toEqual(["A\\|B", "odd slash run"]);
    expect(table.rows[4]?.[0]?.[0]).toMatchObject({ kind: "text", text: "terminal escaped|" });
  });

  it("preserves intentional ideographic spaces at table-cell edges", () => {
    const table = parseMarkdownBlocks([
      "| 見出し | 内容 |",
      "| --- | --- |",
      "|　前後に全角空白　| 本文 |"
    ].join("\n"))[0];
    if (table?.kind !== "table") throw new Error("Expected a table block.");
    expect(table.rows[0]?.[0]?.[0]).toMatchObject({ kind: "text", text: "　前後に全角空白　" });
  });

  it("stops tables before following block starts that contain pipes", () => {
    const source = [
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "## Heading | with pipe",
      "- item | with pipe",
      "1. ordered | with pipe",
      "> quote | with pipe",
      "```text | with pipe",
      "inert | code",
      "```"
    ].join("\n");
    expect(parseMarkdownBlocks(source).map((block) => block.kind)).toEqual([
      "table", "heading", "list", "list", "blockquote", "code"
    ]);
    const table = parseMarkdownBlocks(source)[0];
    expect(table).toMatchObject({ kind: "table" });
    if (table?.kind !== "table") throw new Error("Expected a table block.");
    expect(table.rows).toHaveLength(1);
  });

  it("does not parse table-looking backtick or tilde fenced code and preserves table-cell media discovery", () => {
    const source = [
      "```",
      "| inert | table |",
      "| --- | --- |",
      "| code | only |",
      "```",
      "",
      "~~~markdown",
      "| still | inert |",
      "| --- | --- |",
      "~~~",
      "",
      "| 図版 | 説明 |",
      "| --- | --- |",
      "| ![[assets/図版 資料.png]] | Japanese/Latin |"
    ].join("\n");
    expect(parseMarkdownBlocks(source).map((block) => block.kind)).toEqual(["code", "code", "table"]);
    expect(scanLocalMediaTargets(source)).toEqual(["assets/図版 資料.png"]);
  });

  it("marks only standalone structural content as ineligible for presentation indentation", () => {
    const marker = '<!-- maginalia:quote-ref v1 {"quoteId":"a","mode":"normal"} -->';
    const blocks = parseMarkdownBlocks([
      "これは通常の文章です。[参考リンク](https://example.com) を参照します。",
      "",
      "本文 ![[assets/図版.png]] を参照します。",
      "",
      "本文 [YouTube](https://youtu.be/dQw4w9WgXcQ) を参照します。",
      "",
      "![[assets/図版.png]]",
      "",
      marker
    ].join("\n"));
    expect(blocks.map((block) => block.kind === "paragraph" ? block.presentation : null)).toEqual([
      "prose",
      "prose",
      "prose",
      "structural",
      "structural"
    ]);
  });

  it("keeps QuoteRef markers as typed renderer nodes", () => {
    const marker = '<!-- maginalia:quote-ref v1 {"quoteId":"a","mode":"normal"} -->';
    const nodes = parseMarkdownInlines(marker);
    expect(nodes[0]).toMatchObject({ kind: "quote-ref", marker, quote: { state: "unresolved" } });
    expect(scanQuoteMarkersFromText(`a\n${marker}\nb`)).toEqual([marker]);
  });

  it("renders Project links as typed resolved/unresolved controls without parsing media", () => {
    const parsed = parseMarkdownInlines("[[notes/eco.md|Eco]] ![[assets/figure.webp]]", new Map(), new Map([
      ["notes/eco.md", { fileId: "11111111-1111-4111-8111-111111111111" }]
    ]));
    expect(parsed[0]).toMatchObject({ kind: "internal-link", state: "resolved", fileId: "11111111-1111-4111-8111-111111111111" });
    expect(parsed.slice(1)).toMatchObject([{ kind: "text", text: " " }, {
      kind: "local-media",
      target: "assets/figure.webp",
      media: { state: "unresolved" }
    }]);
  });
});

describe("Renderer preferences", () => {
  it("defaults safely when persisted data is malformed", () => {
    expect(restoreRendererPreferences("not-json")).toEqual({
      version: 1,
      defaultWritingDirection: "horizontal",
      optimizeDroppedImages: true
    });
    expect(restoreRendererPreferences({ version: 1, defaultWritingDirection: "vertical", optimizeDroppedImages: false }))
      .toMatchObject({ defaultWritingDirection: "vertical", optimizeDroppedImages: false });
  });
});
