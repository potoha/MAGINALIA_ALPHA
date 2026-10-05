import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

import { commitStagedArtifact } from "./export-artifact-transaction";
import type { ExportPresentationSettings, ExportPaperSize } from "./export-presentation-settings";
import { parseMarkdownInlines, safeExternalHref, type MarkdownInline } from "./renderer/markdown-inline";
import { parseMarkdownHeading, parseMarkdownListItem } from "./renderer/markdown-structure";
import type { ExportDocumentBlock, ExportDocumentModel } from "./renderer/export-document-model";
import { serializeExportDocumentModel } from "./renderer/export-document-model";

const PAGE_DIMENSIONS_MM: Readonly<Record<ExportPaperSize, readonly [number, number]>> = Object.freeze({
  A3: [297, 420],
  A4: [210, 297],
  A5: [148, 210],
  // These are JIS B-series dimensions, not ISO B-series dimensions.
  B3: [364, 515],
  B4: [257, 364],
  B5: [182, 257],
  Letter: [215.9, 279.4],
  Legal: [215.9, 355.6]
});

const MAIN_DOCUMENT_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const MAX_DOCX_BYTES = 256 * 1024 * 1024;
const HTML_MEDIA_RESOURCE_TAG = /<\s*\/?\s*(?:img|video|audio|source|track|object|embed|iframe|svg|image|picture|link)\b/iu;
const CSS_RESOURCE_URL = /\burl\s*\(/iu;
const HTML_RESOURCE_ATTRIBUTE = /<[^>]+\b(?:href|src|srcset|poster|data|background|action|formaction)\s*=/iu;
const MARKDOWN_REFERENCE_LINK = /(?<!!)\[[^\]]+\]\s*\[[^\]]*\]/u;

function xml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

function xmlText(value: string): string {
  const normalized = value.replace(/[\r\n\t]+/gu, " ");
  for (const character of normalized) {
    const codePoint = character.codePointAt(0)!;
    if (!(codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd
      || (codePoint >= 0x20 && codePoint <= 0xd7ff)
      || (codePoint >= 0xe000 && codePoint <= 0xfffd)
      || (codePoint >= 0x10000 && codePoint <= 0x10ffff))) {
      throw new Error("DOCX header text contains a character that OOXML cannot represent.");
    }
  }
  return xml(normalized);
}

function twips(mm: number): number {
  return Math.round(mm * 1440 / 25.4);
}

function sectionPageSettings(settings: ExportPresentationSettings): { readonly width: number; readonly height: number } {
  const [short, long] = PAGE_DIMENSIONS_MM[settings.paperSize];
  const [widthMm, heightMm] = settings.orientation === "portrait" ? [short, long] : [long, short];
  return { width: twips(widthMm), height: twips(heightMm) };
}

function styleWithIndent(styleXml: string, styleId: string, firstLineChars: string | null): string {
  const stylePattern = new RegExp(`<w:style\\b(?=[^>]*\\bw:styleId="${styleId}")[^>]*>[\\s\\S]*?<\\/w:style>`, "u");
  const match = stylePattern.exec(styleXml);
  if (match === null) throw new Error(`Pandoc reference template is missing the ${styleId} paragraph style.`);
  const indent = firstLineChars === null ? null : `<w:ind w:firstLineChars="${firstLineChars}"/>`;
  let updatedStyle = match[0].replace(/<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>/u, (pPr) => {
    const existing = /<w:ind\b[^>]*\/>/u.exec(pPr)?.[0];
    if (existing === undefined) return indent === null ? pPr : pPr.replace("</w:pPr>", `${indent}</w:pPr>`);
    const otherAttributes = existing
      .replace(/\s+w:(?:firstLine|firstLineChars|hanging|hangingChars)="[^"]*"/gu, "")
      .replace(/^<w:ind\b/u, "")
      .replace(/\s*\/>$/u, "");
    const replacement = indent !== null
      ? `<w:ind${otherAttributes} w:firstLineChars="${firstLineChars}"/>`
      : otherAttributes.trim().length === 0 ? "" : `<w:ind${otherAttributes}/>`;
    return pPr.replace(existing, replacement);
  });
  if (indent !== null && !/<w:pPr\b/u.test(updatedStyle)) {
    const pPr = `<w:pPr>${indent}</w:pPr>`;
    updatedStyle = updatedStyle.replace(/<w:rPr\b/u, `${pPr}<w:rPr`);
    if (!/<w:pPr\b/u.test(updatedStyle)) updatedStyle = updatedStyle.replace("</w:style>", `${pPr}</w:style>`);
  }
  return styleXml.replace(match[0], updatedStyle);
}

function setParagraphIndent(stylesXml: string, enabled: boolean): string {
  // Pandoc emits ordinary Markdown prose as BodyText/FirstParagraph. Compact
  // is used for list and table content and must not inherit body indentation.
  let result = styleWithIndent(stylesXml, "BodyText", enabled ? "100" : null);
  result = styleWithIndent(result, "FirstParagraph", enabled ? "100" : null);
  result = styleWithIndent(result, "Compact", "0");
  return result;
}

function headerParagraph(settings: ExportPresentationSettings): string | null {
  const { left, center, right } = settings.header;
  if (left.length === 0 && center.length === 0 && right.length === 0) return null;
  const { width } = sectionPageSettings(settings);
  const usableWidth = width - twips(16) * 2;
  const runs: string[] = [];
  if (left.length > 0) runs.push(`<w:r><w:t xml:space="preserve">${xmlText(left)}</w:t></w:r>`);
  if (center.length > 0 || right.length > 0) {
    runs.push('<w:r><w:tab/></w:r>');
    if (center.length > 0) runs.push(`<w:r><w:t xml:space="preserve">${xmlText(center)}</w:t></w:r>`);
  }
  if (right.length > 0) {
    runs.push('<w:r><w:tab/></w:r>');
    runs.push(`<w:r><w:t xml:space="preserve">${xmlText(right)}</w:t></w:r>`);
  }
  const tabs = `<w:tabs><w:tab w:val="center" w:pos="${Math.round(usableWidth / 2)}"/><w:tab w:val="right" w:pos="${usableWidth}"/></w:tabs>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr>${tabs}</w:pPr>${runs.join("")}</w:p></w:hdr>`;
}

function footerXml(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>';
}

function addContentTypeOverride(contentTypes: string, partName: string, contentType: string): string {
  if (contentTypes.includes(`PartName="${partName}"`)) return contentTypes;
  return contentTypes.replace("</Types>", `<Override PartName="${partName}" ContentType="${contentType}"/></Types>`);
}

function addRelationship(rels: string, id: string, type: string, target: string): string {
  if (rels.includes(`Id="${id}"`)) return rels;
  return rels.replace("</Relationships>", `<Relationship Id="${id}" Type="${type}" Target="${target}"/></Relationships>`);
}

function setSectionProperties(documentXml: string, settings: ExportPresentationSettings): string {
  const section = /<w:sectPr\b[^>]*>[\s\S]*?<\/w:sectPr>/u.exec(documentXml);
  if (section === null) throw new Error("Pandoc reference template has no document section properties.");
  const { width, height } = sectionPageSettings(settings);
  const margins = {
    top: twips(18), right: twips(16), bottom: twips(20), left: twips(16), header: twips(10), footer: twips(10), gutter: 0
  };
  let sectionXml = section[0]
    .replace(/<w:headerReference\b[^>]*\/>/gu, "")
    .replace(/<w:footerReference\b[^>]*\/>/gu, "")
    .replace(/<w:pgSz\b[^>]*\/>/gu, "")
    .replace(/<w:pgMar\b[^>]*\/>/gu, "");
  const refs = [
    headerParagraph(settings) === null ? "" : '<w:headerReference w:type="default" r:id="rIdMaginaliaHeader"/>',
    settings.pageNumber ? '<w:footerReference w:type="default" r:id="rIdMaginaliaFooter"/>' : ""
  ].join("");
  const pageSize = `<w:pgSz w:w="${width}" w:h="${height}"${settings.orientation === "landscape" ? ' w:orient="landscape"' : ""}/>`;
  const pageMargins = `<w:pgMar w:top="${margins.top}" w:right="${margins.right}" w:bottom="${margins.bottom}" w:left="${margins.left}" w:header="${margins.header}" w:footer="${margins.footer}" w:gutter="${margins.gutter}"/>`;
  // SectPr schema order places header/footer references before page geometry.
  sectionXml = sectionXml.replace(/(<w:sectPr\b[^>]*>)/u, `$1${refs}${pageSize}${pageMargins}`);
  return documentXml.replace(section[0], sectionXml);
}

function withPresentationSettings(referenceDocx: Uint8Array, settings: ExportPresentationSettings): Uint8Array {
  let files: Record<string, Uint8Array>;
  try { files = unzipSync(referenceDocx); }
  catch { throw new Error("Pandoc produced an invalid reference DOCX template."); }
  const getXml = (name: string): string => {
    const entry = files[name];
    if (entry === undefined) throw new Error(`Pandoc reference template is missing ${name}.`);
    return strFromU8(entry);
  };

  files["word/styles.xml"] = strToU8(setParagraphIndent(getXml("word/styles.xml"), settings.paragraphIndent));
  files["word/document.xml"] = strToU8(setSectionProperties(getXml("word/document.xml"), settings));

  let contentTypes = getXml("[Content_Types].xml");
  let documentRels = getXml("word/_rels/document.xml.rels");
  const header = headerParagraph(settings);
  if (header !== null) {
    files["word/header1.xml"] = strToU8(header);
    contentTypes = addContentTypeOverride(contentTypes, "/word/header1.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml");
    documentRels = addRelationship(documentRels, "rIdMaginaliaHeader", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header", "header1.xml");
  }
  if (settings.pageNumber) {
    files["word/footer1.xml"] = strToU8(footerXml());
    contentTypes = addContentTypeOverride(contentTypes, "/word/footer1.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml");
    documentRels = addRelationship(documentRels, "rIdMaginaliaFooter", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer", "footer1.xml");
  }
  files["[Content_Types].xml"] = strToU8(contentTypes);
  files["word/_rels/document.xml.rels"] = strToU8(documentRels);
  return zipSync(files, { level: 6 });
}

function assertTextHasNoUnresolvedResources(value: string): void {
  if (/!\[/u.test(value)
    || HTML_MEDIA_RESOURCE_TAG.test(value)
    || HTML_RESOURCE_ATTRIBUTE.test(value)
    || CSS_RESOURCE_URL.test(value)
    || MARKDOWN_REFERENCE_LINK.test(value)) {
    throw new Error("DOCX export cannot resolve Markdown/HTML media/resources or unsupported reference links.");
  }
  if (/\[\[[^\]]*\]\]/u.test(value)) throw new Error("DOCX export contains an unresolved internal link.");
  for (const match of value.matchAll(/(?<!!)(\[[^\]]+\])\(([^)\s]+)\)/gu)) {
    if (safeExternalHref(match[2] ?? "") === null) throw new Error("DOCX export contains an unresolved or unsafe link.");
  }
}

function assertInlineExportable(value: string): void {
  const visit = (nodes: readonly MarkdownInline[]): void => {
    let textRun = "";
    const flushTextRun = (): void => {
      if (textRun.length === 0) return;
      assertTextHasNoUnresolvedResources(textRun);
      textRun = "";
    };
    for (const node of nodes) {
      if (node.kind === "text") {
        textRun += node.text;
        if (node.text.includes("maginalia:synced-block") || node.text.includes("maginalia:quote-ref")) {
          throw new Error("DOCX export contains an unresolved MAGINALIA marker.");
        }
        continue;
      }
      flushTextRun();
      if (node.kind === "local-media") throw new Error("DOCX export cannot resolve Project media in this document.");
      if (node.kind === "internal-link") throw new Error("DOCX export contains an unresolved internal link.");
      if (node.kind === "quote-ref") throw new Error("DOCX export contains an unresolved quotation marker.");
      if (node.kind === "link" || node.kind === "strong" || node.kind === "emphasis") {
        visit(node.kind === "link" ? node.label : node.children);
      }
    }
    flushTextRun();
  };
  visit(parseMarkdownInlines(value));
}

function assertBlockExportable(block: ExportDocumentBlock): void {
  if (block.kind === "metadata" || block.kind === "raw" || block.kind === "code") return;
  if (block.kind === "table") {
    if (block.table === undefined) throw new Error("DOCX export received a table block without its Export Document Model projection.");
    for (const cell of block.table.header) assertInlineExportable(cell);
    for (const row of block.table.rows) for (const cell of row) assertInlineExportable(cell);
    return;
  }
  let text = block.markdown.replace(/\r?\n$/u, "");
  if (block.kind === "heading") {
    text = parseMarkdownHeading(text)?.content ?? text;
  } else if (block.kind === "blockquote") {
    text = text.split(/\r?\n/gu).map((line) => line.replace(/^>\s?/u, "")).join("\n");
  } else if (block.kind === "list") {
    for (const line of text.split(/\r?\n/gu)) assertInlineExportable(parseMarkdownListItem(line)?.content ?? line);
    return;
  }
  assertInlineExportable(text);
}

function validateModel(model: ExportDocumentModel): string {
  if (model.kind !== "export-document" || model.version !== 1 || !Array.isArray(model.blocks)) {
    throw new Error("DOCX export received an invalid Export Document Model.");
  }
  for (const block of model.blocks) assertBlockExportable(block);
  return serializeExportDocumentModel(model);
}

function validateDocxBytes(bytes: Uint8Array): void {
  if (bytes.byteLength < 4 || bytes.byteLength > MAX_DOCX_BYTES
    || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    throw new Error("Pandoc did not create a valid DOCX package.");
  }
  let entries: Record<string, Uint8Array>;
  try { entries = unzipSync(bytes); }
  catch { throw new Error("Pandoc did not create a valid DOCX ZIP package."); }
  const contentTypes = entries["[Content_Types].xml"];
  const packageRels = entries["_rels/.rels"];
  const document = entries["word/document.xml"];
  const styles = entries["word/styles.xml"];
  const documentRels = entries["word/_rels/document.xml.rels"];
  if (contentTypes === undefined || packageRels === undefined || document === undefined || styles === undefined || documentRels === undefined) {
    throw new Error("DOCX package is missing required OOXML parts.");
  }
  const contentTypesXml = strFromU8(contentTypes);
  const packageRelsXml = strFromU8(packageRels);
  const documentXml = strFromU8(document);
  if (!contentTypesXml.includes(MAIN_DOCUMENT_CONTENT_TYPE)
    || !/<w:document\b/u.test(documentXml)
    || !/<w:body\b/u.test(documentXml)
    || !packageRelsXml.includes("officeDocument")
    || !/<w:styles\b/u.test(strFromU8(styles))) {
    throw new Error("Pandoc output is not a valid WordprocessingML document.");
  }
}

/** Validate a generated DOCX ZIP/OOXML artifact; exported for Electron smoke. */
export async function validateDocxArtifactFile(filePath: string): Promise<void> {
  const output = await stat(filePath);
  if (!output.isFile() || output.size > MAX_DOCX_BYTES) throw new Error("DOCX output is not a valid artifact file.");
  validateDocxBytes(await readFile(filePath));
}

async function resolvePandocExecutable(executable: string): Promise<string> {
  if (path.isAbsolute(executable)) {
    await access(executable);
    return executable;
  }
  if (executable.includes("/") || executable.includes("\\")) {
    const resolved = path.resolve(executable);
    await access(resolved);
    return resolved;
  }
  const candidates = process.platform === "win32" && path.extname(executable).length === 0
    ? [executable, `${executable}.exe`]
    : [executable];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    for (const candidateName of candidates) {
      const candidate = path.join(directory, candidateName);
      try { await access(candidate); return candidate; } catch { /* Try the next PATH entry. */ }
    }
  }
  throw new Error("Pandoc was not found. Install Pandoc or configure MAGINALIA_PANDOC_BIN.");
}

async function runPandoc(executable: string, args: readonly string[], cwd: string): Promise<void> {
  const javascriptEntry = /\.(?:mjs|cjs|js)$/iu.test(executable);
  const spawnExecutable = javascriptEntry ? process.execPath : executable;
  const spawnArgs = javascriptEntry ? [executable, ...args] : [...args];
  const env = javascriptEntry ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" } : process.env;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(spawnExecutable, spawnArgs, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env,
      shell: false,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-16_384); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16_384); });
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolve()
      : reject(new Error((stderr || stdout).trim() || `Pandoc exited with ${code ?? "unknown"}.`)));
  });
}

/** Main-process DOCX adapter. Pandoc performs all Markdown content writing. */
export async function writeDocxWithPandoc(
  outputPath: string,
  model: ExportDocumentModel,
  settings: ExportPresentationSettings,
  executable = process.env.MAGINALIA_PANDOC_BIN ?? "pandoc"
): Promise<void> {
  const markdown = validateModel(model);
  const resolvedExecutable = await resolvePandocExecutable(executable);
  const workspace = await mkdtemp(path.join(tmpdir(), "maginalia-pandoc-docx-"));
  const sourcePath = path.join(workspace, "resolved.md");
  const referencePath = path.join(workspace, "reference.docx");
  const referencePatchedPath = path.join(workspace, "reference-maginalia.docx");
  const stagedDocxPath = path.join(workspace, "resolved.docx");
  try {
    await writeFile(sourcePath, markdown, "utf8");
    // Pandoc's documented reference-doc workflow supplies the styles and
    // section defaults; it remains the only Markdown-to-DOCX content writer.
    await runPandoc(resolvedExecutable, ["-o", referencePath, "--print-default-data-file", "reference.docx"], workspace);
    const reference = withPresentationSettings(await readFile(referencePath), settings);
    await writeFile(referencePatchedPath, reference);
    await runPandoc(resolvedExecutable, [
      "--from=markdown",
      "--to=docx",
      "--reference-doc", referencePatchedPath,
      "--wrap=none",
      "--output", stagedDocxPath,
      sourcePath
    ], workspace);
    await validateDocxArtifactFile(stagedDocxPath);
    await commitStagedArtifact(stagedDocxPath, outputPath);
  } finally {
    // Once the destination commit succeeds, temp cleanup must not turn a
    // successful export into a reported failure with a changed destination.
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}
