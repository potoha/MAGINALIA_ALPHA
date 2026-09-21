import { describe, expect, it } from "vitest";
import {
  parseMarkdownBlocks,
  parseMarkdownInlines,
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
