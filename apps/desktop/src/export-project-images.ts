import type { ProjectAssetResult } from "./project-assets";
import { parseMarkdownInlines, type MarkdownInline } from "./renderer/markdown-inline";
import type { ExportDocumentBlock, ExportDocumentModel } from "./renderer/export-document-model";
import { parseMarkdownHeading, parseMarkdownListItem } from "./renderer/markdown-structure";

export type ExportImageMimeType = "image/png" | "image/jpeg" | "image/webp";

/** A path-free, main-process-resolved image snapshot for a single export. */
export interface ExportImageAsset {
  readonly mimeType: ExportImageMimeType;
  readonly dataUrl: string;
}

export type ExportImageAssets = ReadonlyMap<string, ExportImageAsset>;

export class ExportImageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ExportImageError";
  }
}

const MAX_EMBEDDED_IMAGE_DATA_URL_CHARS = 128 * 1024 * 1024;
const UNSUPPORTED_IMAGE_SYNTAX = /!\s*\[|<\s*\/?\s*(?:img|picture|svg|image|source)\b/iu;
const SAFE_IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/u;

function inlineSourceForBlock(block: ExportDocumentBlock): readonly string[] {
  if (block.kind === "metadata" || block.kind === "raw" || block.kind === "code") return [];
  const content = block.markdown.replace(/\r?\n$/u, "");
  if (block.kind === "heading") {
    const line = content.split(/\r?\n/u, 1)[0] ?? "";
    return [parseMarkdownHeading(line)?.content ?? line];
  }
  if (block.kind === "blockquote") {
    return [content.split(/\r?\n/u).map((line) => line.replace(/^>\s?/u, "")).join("\n")];
  }
  if (block.kind === "list") {
    return content.split(/\r?\n/u).map((line) => parseMarkdownListItem(line)?.content ?? line);
  }
  if (block.kind === "table") {
    if (block.table === undefined) throw new Error("Export table block is missing its parsed table data.");
    return [...block.table.header, ...block.table.rows.flat()];
  }
  return [content];
}

function inspectInlineNodes(
  nodes: readonly MarkdownInline[],
  targets: string[],
  textRun: { value: string }
): void {
  const flushText = (): void => {
    if (UNSUPPORTED_IMAGE_SYNTAX.test(textRun.value)) {
      throw new ExportImageError("PDF・DOCXではProject内のPNG・JPEG・WebP画像のみ使えます。画像の記法と形式を確認してください。");
    }
    textRun.value = "";
  };

  for (const node of nodes) {
    if (node.kind === "text") {
      textRun.value += node.text;
      continue;
    }
    // The inline parser deliberately treats an unsupported remote Markdown
    // image as plain text plus a normal link. Preserve the leading `!` long
    // enough to recognize that rejected image syntax instead of silently
    // exporting its label as an ordinary link.
    if (node.kind === "link" && /!\s*$/u.test(textRun.value)) {
      throw new ExportImageError("PDF・DOCXではProject内のPNG・JPEG・WebP画像のみ使えます。画像の記法と形式を確認してください。");
    }
    flushText();
    if (node.kind === "local-media") {
      targets.push(node.target);
      continue;
    }
    if (node.kind === "code" || node.kind === "quote-ref") continue;
    if (node.kind === "strong" || node.kind === "emphasis") {
      inspectInlineNodes(node.children, targets, textRun);
      flushText();
    } else if (node.kind === "link" || node.kind === "internal-link") {
      inspectInlineNodes(node.label, targets, textRun);
      flushText();
    }
  }
  flushText();
}

/** Collect only renderer-supported local image nodes, excluding code and metadata. */
export function collectExportImageReferences(model: ExportDocumentModel): readonly string[] {
  const targets: string[] = [];
  for (const block of model.blocks) {
    for (const source of inlineSourceForBlock(block)) {
      inspectInlineNodes(parseMarkdownInlines(source), targets, { value: "" });
    }
  }
  return Object.freeze(targets);
}

function messageForProjectAssetFailure(result: Exclude<ProjectAssetResult, { readonly kind: "resolved" }>, target: string): string {
  if (result.code === "missing") {
    return `Project内に画像「${target}」が見つからないため、書き出せませんでした。画像を戻すか、Markdownの参照を確認してください。`;
  }
  if (result.code === "too-large") {
    return `画像「${target}」のサイズが大きすぎるため、書き出せませんでした。画像を小さくしてからもう一度お試しください。`;
  }
  if (result.code === "unsupported") {
    return `画像「${target}」は対応していない形式か、画像として読み取れません。PNG・JPEG・WebPを確認してください。`;
  }
  return `画像「${target}」の参照先が安全ではないため、書き出せませんでした。Project内の相対パスを確認してください。`;
}

function validateImageDataUrl(value: Extract<ProjectAssetResult, { readonly kind: "resolved" }>): ExportImageAsset {
  if (value.assetKind !== "image") {
    throw new ExportImageError("PDF・DOCXには動画を含められません。動画の参照を外してから書き出してください。");
  }
  const match = SAFE_IMAGE_DATA_URL.exec(value.dataUrl);
  if (match === null || match[1] !== value.mimeType) {
    throw new ExportImageError("Project画像を安全に読み取れませんでした。画像ファイルを確認してください。");
  }
  return Object.freeze({ mimeType: value.mimeType as ExportImageMimeType, dataUrl: value.dataUrl });
}

/**
 * Resolve each exact relative image reference through ProjectAssetService.
 * The callback receives only owner-bound IDs and renderer-parsed relative
 * targets; the returned map is short-lived and never written to the Project.
 */
export async function resolveExportImageAssets(
  owner: object,
  projectId: string | undefined,
  model: ExportDocumentModel,
  resolveProjectAsset: ((
    owner: object,
    projectId: string,
    relativePath: string
  ) => Promise<ProjectAssetResult>) | undefined
): Promise<ExportImageAssets> {
  const references = collectExportImageReferences(model);
  if (references.length === 0) return new Map();
  if (projectId === undefined) {
    throw new ExportImageError("この文書の画像をProject内で確認できません。Projectを開き直してから書き出してください。");
  }
  if (resolveProjectAsset === undefined) {
    throw new ExportImageError("Project画像を安全に確認できませんでした。Projectを開き直してから書き出してください。");
  }

  const uniqueTargets = [...new Set(references)];
  const images = new Map<string, ExportImageAsset>();
  let totalDataUrlChars = 0;
  for (const target of uniqueTargets) {
    const result = await resolveProjectAsset(owner, projectId, target);
    if (result.kind !== "resolved") throw new ExportImageError(messageForProjectAssetFailure(result, target));
    const image = validateImageDataUrl(result);
    totalDataUrlChars += image.dataUrl.length * references.filter((reference) => reference === target).length;
    if (totalDataUrlChars > MAX_EMBEDDED_IMAGE_DATA_URL_CHARS) {
      throw new ExportImageError("画像の合計サイズが大きすぎるため、書き出せませんでした。画像を減らすか小さくしてください。");
    }
    images.set(target, image);
  }
  return images;
}

/** Ensure a format adapter cannot silently omit or invent an image. */
export function assertExportImagesResolved(model: ExportDocumentModel, images: ExportImageAssets): void {
  for (const target of collectExportImageReferences(model)) {
    if (!images.has(target)) {
      throw new ExportImageError(`Project内の画像「${target}」を確認できないため、書き出せませんでした。`);
    }
  }
}
