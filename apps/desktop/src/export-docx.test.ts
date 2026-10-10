import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { createExportPresentationSettings } from "./export-presentation-settings";
import { validateDocxArtifactFile, writeDocxWithPandoc } from "./export-docx";
import { createExportDocumentModel } from "./renderer/export-document-model";

const model = (source: string) => createExportDocumentModel(source);
const installedPandoc = "C:\\Program Files\\Pandoc\\pandoc.exe";
function findPandoc(): string | null {
  if (process.env.MAGINALIA_PANDOC_BIN !== undefined && existsSync(process.env.MAGINALIA_PANDOC_BIN)) {
    return process.env.MAGINALIA_PANDOC_BIN;
  }
  if (existsSync(installedPandoc)) return installedPandoc;
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const name of process.platform === "win32" ? ["pandoc.exe", "pandoc"] : ["pandoc"]) {
      const candidate = path.join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}
const pandoc = findPandoc();
const pandocIt = pandoc === null ? it.skip : it;
function expectPageSize(documentXml: string, width: number, height: number, orientation?: "landscape"): void {
  const size = /<w:pgSz\b([^>]*)\/>/u.exec(documentXml)?.[1] ?? "";
  expect(size).toContain(`w:w="${width}"`);
  expect(size).toContain(`w:h="${height}"`);
  if (orientation !== undefined) expect(size).toContain(`w:orient="${orientation}"`);
}

describe("Pandoc DOCX adapter", () => {
  const directories: string[] = [];
  afterEach(async () => {
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  });

  async function fixture(): Promise<{ readonly directory: string; readonly output: string }> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "maginalia-docx-日本語 & "));
    directories.push(directory);
    return { directory, output: path.join(directory, "作品 & output.docx") };
  }

  pandocIt("uses Pandoc as the content writer and preserves the shared presentation contract", async () => {
    const { output } = await fixture();
    const source = [
      "---",
      "title: 作品論",
      "author: 未田3字",
      "---",
      "",
      "# 作品論",
      "",
      "これは日本語の本文です。😀",
      "",
      "[公式サイト](https://example.test)",
      "",
      "`![literal][ref] [x](C:/literal) <img src=\"C:/literal.png\">`",
      "",
      "```md",
      "![literal][ref]",
      "[x](C:/literal)",
      "<img src=\"C:/literal.png\">",
      "```",
      "",
      "| 左 | 右 |",
      "| --- | --- |",
      "| 一 | 二 |",
      "",
      "> 引用段落",
      "",
      "- 箇条書き",
      "",
      "```ts",
      "const 日本語 = true;",
      "```",
      "",
      "References",
      "",
      "- 引用資料"
    ].join("\n");
    const original = source;
    const settings = createExportPresentationSettings({
      paperSize: "B3",
      orientation: "landscape",
      paragraphIndent: true,
      header: { left: "左ヘッダー", center: "中央 & <見出し>", right: "右ヘッダー" },
      pageNumber: true
    });

    await writeFile(output, "previous DOCX artifact", "utf8");
    await writeDocxWithPandoc(output, model(source), settings, pandoc!);
    await validateDocxArtifactFile(output);
    const packageFiles = unzipSync(await readFile(output));
    const document = strFromU8(packageFiles["word/document.xml"]!);
    const styles = strFromU8(packageFiles["word/styles.xml"]!);
    const documentRelationships = strFromU8(packageFiles["word/_rels/document.xml.rels"]!);
    const header = strFromU8(packageFiles["word/header1.xml"]!);
    const footer = strFromU8(packageFiles["word/footer1.xml"]!);

    expectPageSize(document, Math.round(515 * 1440 / 25.4), Math.round(364 * 1440 / 25.4), "landscape");
    expect(document).toContain('w:top="1020"');
    expect(document).toContain('w:left="907"');
    expect(styles).toContain('w:firstLineChars="100"');
    expect(styles).toMatch(/w:styleId="FirstParagraph"[\s\S]*?w:firstLineChars="100"/u);
    expect(styles).toMatch(/w:styleId="Compact"[\s\S]*?w:firstLineChars="0"/u);
    expect(header).toContain("左ヘッダー");
    expect(header).toContain("中央 &amp; &lt;見出し&gt;");
    expect(header).toContain("右ヘッダー");
    expect(header).toContain('w:val="center"');
    expect(header).toContain('w:val="right"');
    expect(footer).toContain('w:jc w:val="center"');
    expect(footer).toContain(" PAGE ");
    expect(document).toContain("作品論");
    expect(document).toContain("日本語");
    expect(document).toContain("引用資料");
    expect(document).toContain("<w:tbl>");
    expect(document).toContain("<w:hyperlink");
    expect(documentRelationships).toContain("https://example.test");
    expect(document).toContain("<w:numId");
    expect(document).toContain("引用段落");
    expect(document).toContain("引用資料");
    expect(document).toContain("箇条書き");
    expect(document).toContain("![literal][ref]");
    expect(document).toContain("C:/literal");
    expect(document).toContain("&lt;img src=");
    expect(packageFiles["word/_rels/document.xml.rels"]).toBeDefined();
    expect(source).toBe(original);
  });

  pandocIt("maps every paper size to its intended dimensions and respects orientation", async () => {
    const { output } = await fixture();
    const dimensions = {
      A3: [297, 420], A4: [210, 297], A5: [148, 210],
      B3: [364, 515], B4: [257, 364], B5: [182, 257],
      Letter: [215.9, 279.4], Legal: [215.9, 355.6]
    } as const;
    for (const [paperSize, [short, long]] of Object.entries(dimensions)) {
      const settings = createExportPresentationSettings({ paperSize: paperSize as keyof typeof dimensions });
      await writeDocxWithPandoc(output, model("本文"), settings, pandoc!);
      let document = strFromU8(unzipSync(await readFile(output))["word/document.xml"]!);
      expectPageSize(document, Math.round(short * 1440 / 25.4), Math.round(long * 1440 / 25.4));
      await writeDocxWithPandoc(output, model("本文"), createExportPresentationSettings({
        paperSize: paperSize as keyof typeof dimensions,
        orientation: "landscape",
        paragraphIndent: false,
        pageNumber: false
      }), pandoc!);
      const packageFiles = unzipSync(await readFile(output));
      document = strFromU8(packageFiles["word/document.xml"]!);
      expectPageSize(document, Math.round(long * 1440 / 25.4), Math.round(short * 1440 / 25.4), "landscape");
      expect(packageFiles["word/footer1.xml"]).toBeUndefined();
      const relationships = packageFiles["word/_rels/document.xml.rels"];
      expect(relationships).toBeDefined();
      expect(strFromU8(relationships!)).not.toContain("relationships/footer");
      expect(strFromU8(packageFiles["word/styles.xml"]!)).not.toContain('w:firstLineChars="100"');
    }
  }, 120_000);

  pandocIt("consumes the supplied ExportDocumentModel instead of rebuilding a document model", async () => {
    const { output } = await fixture();
    const authoredBlock = Object.freeze({
      kind: "heading" as const,
      level: 2,
      markdown: "Model supplied as plain content\n"
    });
    const suppliedModel = Object.freeze({
      kind: "export-document" as const,
      version: 1 as const,
      blocks: Object.freeze([authoredBlock])
    });
    await writeDocxWithPandoc(output, suppliedModel, createExportPresentationSettings({}), pandoc!);
    const document = strFromU8(unzipSync(await readFile(output))["word/document.xml"]!);
    expect(document).toContain("Model supplied as plain content");
    expect(document).not.toContain("heading");
  });

  it("fails closed for unresolved media/internal markers and preserves an existing artifact", async () => {
    const { output } = await fixture();
    await writeFile(output, "previous DOCX artifact", "utf8");
    const blockedSources = [
      "![figure](images/figure.png)",
      "![local image][asset]\n\n[asset]: C:/Users/private/image.png",
      "[local document][target]\n\n[target]: C:/Users/private/document.md",
      "<img src=\"C:/Users/private/image.png\">",
      "<video src=\"file:///C:/Users/private/movie.mp4\"></video>",
      "<audio src=\"C:/Users/private/audio.wav\"></audio>",
      "<source src=\"C:/Users/private/track.mp4\">",
      "<object data=\"C:/Users/private/object.bin\"></object>",
      "<embed src=\"C:/Users/private/plugin.bin\">",
      "<iframe src=\"file:///C:/Users/private/page.html\"></iframe>",
      "<svg><image href=\"C:/Users/private/image.png\"/></svg>",
      "<div style=\"background-image: url(file:///C:/Users/private/image.png)\"></div>",
      "<a href=\"file:///C:/Users/private/document.md\">private</a>",
      "[local document](C:/Users/private/document.md)",
      "[[notes/secret.md|secret]]",
      "<!-- maginalia:synced-block v1 {\"target\":\"child.md\"} -->",
      "<!-- maginalia:quote-ref v1 {} -->"
    ];
    for (const source of blockedSources) {
      await expect(writeDocxWithPandoc(output, model(source), createExportPresentationSettings({}), pandoc ?? "pandoc"))
        .rejects.toThrow();
      expect(await readFile(output, "utf8")).toBe("previous DOCX artifact");
    }
  });

  pandocIt("embeds Project PNG, JPEG, and WebP images in a portable DOCX", async () => {
    const { directory, output } = await fixture();
    const imageDirectory = path.join(directory, "画像 inputs");
    await mkdir(imageDirectory, { recursive: true });
    const pngPath = path.join(imageDirectory, "figure.png");
    const jpegPath = path.join(imageDirectory, "写真.jpg");
    const webpPath = path.join(imageDirectory, "図版 資料.webp");
    await sharp({ create: { width: 1000, height: 400, channels: 4, background: "#d9e24f" } }).png().toFile(pngPath);
    await sharp({ create: { width: 320, height: 220, channels: 3, background: "#c69b86" } }).jpeg().toFile(jpegPath);
    await sharp({ create: { width: 640, height: 480, channels: 4, background: "#528c75" } }).webp().toFile(webpPath);
    const toDataUrl = async (filePath: string, mimeType: string): Promise<string> =>
      `data:${mimeType};base64,${(await readFile(filePath)).toString("base64")}`;
    const images = new Map([
      ["assets/figure.png", { mimeType: "image/png" as const, dataUrl: await toDataUrl(pngPath, "image/png") }],
      ["assets/写真.jpg", { mimeType: "image/jpeg" as const, dataUrl: await toDataUrl(jpegPath, "image/jpeg") }],
      ["assets/図版 資料.webp", { mimeType: "image/webp" as const, dataUrl: await toDataUrl(webpPath, "image/webp") }]
    ]);
    const source = [
      "# 画像付き研究メモ",
      "",
      "PNGの前後 text ![図と説明](assets/figure.png) の後。",
      "",
      "![[assets/写真.jpg]]",
      "",
      "![[assets/図版 資料.webp]]",
      ""
    ].join("\n");
    const before = source;

    await writeDocxWithPandoc(output, model(source), createExportPresentationSettings({}), pandoc!, images);
    await validateDocxArtifactFile(output);
    const parts = unzipSync(await readFile(output));
    const mediaNames = Object.keys(parts).filter((name) => name.startsWith("word/media/"));
    const document = strFromU8(parts["word/document.xml"]!);
    const relationships = strFromU8(parts["word/_rels/document.xml.rels"]!);
    expect(mediaNames).toHaveLength(3);
    expect(mediaNames.some((name) => name.endsWith(".png"))).toBe(true);
    expect(mediaNames.some((name) => name.endsWith(".jpg") || name.endsWith(".jpeg"))).toBe(true);
    expect(document).toContain("w:drawing");
    expect(document).toContain("図と説明");
    expect(relationships.match(/relationships\/image/gu)?.length).toBe(3);
    expect(Object.keys(parts).join("\n")).not.toContain("画像 inputs");
    expect(source).toBe(before);
  }, 120_000);

  it("validates the DOCX artifact format rather than accepting arbitrary ZIP files", async () => {
    const { output } = await fixture();
    await writeFile(output, "not a docx");
    await expect(validateDocxArtifactFile(output)).rejects.toThrow("valid DOCX");
    await writeFile(output, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    await expect(validateDocxArtifactFile(output)).rejects.toThrow("valid DOCX ZIP");
  });

  it("keeps Pandoc inputs, reference template, and staged artifact under OS temp, independent of CWD", async () => {
    const { directory, output } = await fixture();
    const template = zipSync({
      "[Content_Types].xml": strToU8(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`),
      "_rels/.rels": strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="officeDocument" Target="word/document.xml"/></Relationships>'),
      "word/document.xml": strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:sectPr></w:sectPr></w:body></w:document>'),
      "word/styles.xml": strToU8('<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="BodyText"><w:name w:val="Body Text"/><w:pPr></w:pPr></w:style><w:style w:type="paragraph" w:styleId="FirstParagraph"><w:name w:val="First Paragraph"/><w:pPr></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Compact"><w:name w:val="Compact"/><w:pPr></w:pPr></w:style></w:styles>'),
      "word/_rels/document.xml.rels": strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>')
    });
    const fakeEntry = path.join(directory, "fake-pandoc.cjs");
    const manifest = path.join(directory, "invocation.json");
    const script = [
      'const fs = require("node:fs");',
      'const args = process.argv.slice(2);',
      `fs.writeFileSync(${JSON.stringify(manifest)}, JSON.stringify({ cwd: process.cwd(), args }));`,
      `if (args.includes("--print-default-data-file")) fs.writeFileSync(args[args.indexOf("-o") + 1], Buffer.from(${JSON.stringify(Buffer.from(template).toString("base64"))}, "base64"));`,
      `else fs.writeFileSync(args[args.indexOf("--output") + 1], Buffer.from(${JSON.stringify(Buffer.from(template).toString("base64"))}, "base64"));`
    ].join("\n");
    await writeFile(fakeEntry, script, "utf8");

    await writeDocxWithPandoc(output, model("`![alt][id] <img src=\"C:/inactive.png\">`\n\n```html\n<video src=\"C:/inactive.mp4\"></video>\n![ref][id]\n```"), createExportPresentationSettings({}), fakeEntry);
    const invocation = JSON.parse(await readFile(manifest, "utf8")) as { readonly cwd: string; readonly args: string[] };
    const tempRoot = path.resolve(os.tmpdir());
    const repositoryRoot = path.resolve(process.cwd());
    const source = path.resolve(invocation.args.at(-1)!);
    const reference = path.resolve(invocation.args[invocation.args.indexOf("--reference-doc") + 1]!);
    const staged = path.resolve(invocation.args[invocation.args.indexOf("--output") + 1]!);
    expect(path.resolve(invocation.cwd).startsWith(tempRoot)).toBe(true);
    expect(path.resolve(invocation.cwd).startsWith(repositoryRoot)).toBe(false);
    expect(source.startsWith(tempRoot)).toBe(true);
    expect(reference.startsWith(tempRoot)).toBe(true);
    expect(staged.startsWith(tempRoot)).toBe(true);
  });
});
