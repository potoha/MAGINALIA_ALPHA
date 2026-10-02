import { describe, expect, it } from "vitest";
import {
  parseMarkdownBlocks,
  parseMarkdownInlines,
  scanLocalMediaTargets,
  scanQuoteMarkersFromText
} from "./markdown-renderer";
import { restoreRendererPreferences } from "./renderer-preferences";

describe("Markdown preview parser", () => {
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
