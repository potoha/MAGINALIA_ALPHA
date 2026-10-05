import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  EXPORT_ORIENTATIONS,
  EXPORT_PAPER_SIZES,
  createExportPresentationSettings
} from "./export-presentation-settings";
import { renderExportDocumentHtml, writePdfWithVivliostyle } from "./export-pdf";

describe("Vivliostyle PDF adapter", () => {
  it("maps every supported paper size, including JIS B-series, and orientation", () => {
    const dimensions = {
      A3: [297, 420], A4: [210, 297], A5: [148, 210],
      B3: [364, 515], B4: [257, 364], B5: [182, 257],
      Letter: [215.9, 279.4], Legal: [215.9, 355.6]
    } as const;
    for (const paperSize of EXPORT_PAPER_SIZES) {
      for (const orientation of EXPORT_ORIENTATIONS) {
        const html = renderExportDocumentHtml("# 文書\n", createExportPresentationSettings({ paperSize, orientation }));
        const [short, long] = dimensions[paperSize];
        expect(html).toContain(orientation === "portrait" ? `size: ${short}mm ${long}mm;` : `size: ${long}mm ${short}mm;`);
      }
    }
    expect(renderExportDocumentHtml("# B3\n", createExportPresentationSettings({ paperSize: "B3" })))
      .toContain("364mm 515mm");
    expect(renderExportDocumentHtml("# B3\n", createExportPresentationSettings({ paperSize: "B3", orientation: "landscape" })))
      .toContain("515mm 364mm");
  });

  it("keeps authored headers, links, and code from injecting HTML or corrupting attributes", () => {
    const html = renderExportDocumentHtml('[A & B](https://example.test/?a=1&b=2) `*literal* <unsafe>`\n',
      createExportPresentationSettings({ header: { left: '</style><script>alert("x")</script>', center: "", right: "" } }));
    expect(html).not.toContain("<script>");
    expect(html).toContain('href="https://example.test/?a=1&amp;b=2"');
    expect(html).toContain("A &amp; B</a>");
    expect(html).toContain("<code>*literal* &lt;unsafe&gt;</code>");
  });

  it("preserves code after shorter closing runs and unterminated code fences", () => {
    const html = renderExportDocumentHtml("````md\n# inert\n```\nlast line\n", createExportPresentationSettings({}));
    expect(html).toContain("<pre><code># inert\n```\nlast line</code></pre>");
    expect(html).not.toContain("<h1>");
  });

  it("renders indent, independent headers, and optional centered page number", () => {
    const settings = createExportPresentationSettings({
      paragraphIndent: true,
      header: { left: "左", center: "中央", right: "右" },
      pageNumber: true
    });
    const html = renderExportDocumentHtml("本文\n", settings);
    expect(html).toContain("text-indent: 1em");
    expect(html).toContain('@top-left { content: "左"; }');
    expect(html).toContain('@top-center { content: "中央"; }');
    expect(html).toContain('@top-right { content: "右"; }');
    expect(html).toContain("@bottom-center { content: counter(page); }");

    const noNumber = renderExportDocumentHtml("本文\n", createExportPresentationSettings({ paragraphIndent: false, pageNumber: false }));
    expect(noNumber).not.toContain("text-indent: 1em");
    expect(noNumber).not.toContain("counter(page)");
    expect(noNumber).toContain('@top-left { content: ""; }');
  });

  it("preserves Japanese, tables, code, links, and resolved references without internal markers", () => {
    const source = [
      "# 作品論",
      "",
      "本文。日本語 😀",
      "",
      "[公式サイト](https://example.test)",
      "",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 二 |",
      "",
      "```ts",
      "const 日本語 = true;",
      "```",
      "",
      "引用元: resolved reference",
      ""
    ].join("\n");
    const original = source;
    const html = renderExportDocumentHtml(source, createExportPresentationSettings({}));

    expect(html).toContain("作品論");
    expect(html).toContain("日本語");
    expect(html).toContain("example.test");
    expect(html).toContain("<table>");
    expect(html).toContain("const 日本語 = true;");
    expect(html).not.toContain("maginalia:synced-block");
    expect(html).not.toContain("maginalia:quote-ref");
    expect(html).not.toContain("documentId");
    expect(source).toBe(original);
  });
});

describe("Vivliostyle process transaction", () => {
  const directories: string[] = [];
  afterEach(async () => {
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  });

  async function fixture(code: string): Promise<{ entry: string; output: string }> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "maginalia-pdf-日本語 & "));
    directories.push(directory);
    const entry = path.join(directory, "fixture.cjs");
    await writeFile(entry, code, "utf8");
    return { entry, output: path.join(directory, "文書 & output.pdf") };
  }

  it("spawns a JS CLI without shell interpretation and commits a validated artifact", async () => {
    const { entry, output } = await fixture('const fs = require("node:fs"); const args = process.argv.slice(2); if (args[0] !== "build") process.exit(2); fs.writeFileSync(args[args.indexOf("-o") + 1], "%PDF-1.7\\nfixture");');
    await writePdfWithVivliostyle(output, "日本語", createExportPresentationSettings({}), entry);
    expect(await readFile(output, "utf8")).toBe("%PDF-1.7\nfixture");
  });

  it("preserves an existing destination when the CLI writes partial output then fails", async () => {
    const { entry, output } = await fixture('const fs = require("node:fs"); const args = process.argv.slice(2); fs.writeFileSync(args[args.indexOf("-o") + 1], "%PDF-partial"); process.exit(1);');
    await writeFile(output, "existing artifact", "utf8");
    await expect(writePdfWithVivliostyle(output, "日本語", createExportPresentationSettings({}), entry)).rejects.toThrow();
    expect(await readFile(output, "utf8")).toBe("existing artifact");
  });

  it("rejects a successful CLI that produced an invalid artifact", async () => {
    const { entry, output } = await fixture('const fs = require("node:fs"); const args = process.argv.slice(2); fs.writeFileSync(args[args.indexOf("-o") + 1], "not a PDF");');
    await expect(writePdfWithVivliostyle(output, "日本語", createExportPresentationSettings({}), entry)).rejects.toThrow("valid PDF");
    await expect(readFile(output)).rejects.toThrow();
  });
});
