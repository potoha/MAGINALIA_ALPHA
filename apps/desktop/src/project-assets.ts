import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import * as path from "node:path";
import sharp from "sharp";
import type { DocumentWorkspaceService } from "./document-workspace";

export type ProjectAssetKind = "image" | "video";

export interface ResolvedProjectAsset {
  readonly kind: "resolved";
  readonly assetKind: ProjectAssetKind;
  readonly mimeType: string;
  /** A bounded, path-free representation for a renderer media element. */
  readonly dataUrl: string;
}

export type ProjectAssetResult = ResolvedProjectAsset | {
  readonly kind: "error";
  readonly code: "invalid" | "missing" | "unsupported" | "too-large";
  readonly message: string;
};

export type ProjectAssetImportResult = {
  readonly kind: "imported";
  readonly relativePath: string;
  readonly mimeType: string;
} | {
  readonly kind: "error";
  readonly code: "invalid" | "unsupported" | "import-failed";
  readonly message: string;
};

const IMAGE_TYPES = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"]
]);
const VIDEO_TYPES = new Map<string, string>([
  [".mp4", "video/mp4"],
  [".webm", "video/webm"]
]);
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Strict POSIX-style Project-relative asset path; never accept a native path. */
export function validateProjectAssetPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024) return null;
  if (value.includes("\\") || /[\u0000-\u001F\u007F]/u.test(value) || path.isAbsolute(value) || /^[A-Za-z]:/u.test(value)) return null;
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return null;
  return segments.join("/");
}

function mediaInfo(relativePath: string): { readonly assetKind: ProjectAssetKind; readonly mimeType: string } | null {
  const extension = path.posix.extname(relativePath).toLowerCase();
  const image = IMAGE_TYPES.get(extension);
  if (image) return { assetKind: "image", mimeType: image };
  const video = VIDEO_TYPES.get(extension);
  if (video) return { assetKind: "video", mimeType: video };
  return null;
}

function magicMatches(bytes: Buffer, mimeType: string): boolean {
  if (mimeType === "image/png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/webp") return bytes.length >= 12 && bytes.subarray(0, 4).equals(Buffer.from("RIFF")) && bytes.subarray(8, 12).equals(Buffer.from("WEBP"));
  // ISO BMFF and WebM validation is intentionally conservative at this IPC
  // boundary. The browser will still reject corrupt media without executing it.
  if (mimeType === "video/mp4") return bytes.length >= 12 && bytes.subarray(4, 8).equals(Buffer.from("ftyp"));
  if (mimeType === "video/webm") return bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  return false;
}

function fileStem(sourcePath: string): string {
  const stem = path.basename(sourcePath, path.extname(sourcePath))
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  return stem || "image";
}

async function writeCollisionSafeAsset(
  directory: string,
  stem: string,
  extension: string,
  contents: Buffer
): Promise<string> {
  // `wx` is the actual collision guarantee.  A lstat-then-write sequence
  // would leave a race in which another process could be overwritten.
  for (let counter = 0; counter < 10_000; counter += 1) {
    const name = counter === 0 ? `${stem}${extension}` : `${stem}-${counter}${extension}`;
    try {
      await writeFile(path.join(directory, name), contents, { flag: "wx" });
      return name;
    } catch (error: unknown) {
      if ((error as { code?: unknown }).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error("No safe asset filename is available.");
}

async function checkedSourceImage(sourcePath: string): Promise<{
  readonly canonicalPath: string;
  readonly mimeType: string;
  readonly bytes: Buffer;
} | null> {
  if (typeof sourcePath !== "string" || !path.isAbsolute(sourcePath)) return null;
  try {
    const canonicalPath = await realpath(sourcePath);
    const stats = await lstat(canonicalPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_IMAGE_BYTES) return null;
    const mimeType = IMAGE_TYPES.get(path.extname(canonicalPath).toLowerCase());
    if (!mimeType) return null;
    const bytes = await readFile(canonicalPath, { encoding: null, flag: "r" });
    return magicMatches(bytes.subarray(0, 32), mimeType) ? { canonicalPath, mimeType, bytes } : null;
  } catch { return null; }
}

/**
 * Keeps all Project filesystem authority in main. Renderer callers have only
 * opaque Project IDs, safe relative paths, and data URLs returned after this
 * service re-validates canonical containment and type.
 */
export class ProjectAssetService {
  public constructor(private readonly workspace: DocumentWorkspaceService) {}

  public async resolveForOwner(owner: object, projectId: string, relativePath: string): Promise<ProjectAssetResult> {
    const safePath = validateProjectAssetPath(relativePath);
    const info = safePath === null ? null : mediaInfo(safePath);
    if (safePath === null) return { kind: "error", code: "invalid", message: "The Project asset path is invalid." };
    if (info === null) return { kind: "error", code: "unsupported", message: "That Project asset type is not supported." };
    const root = await this.workspace.resolveDocumentRoot(owner, projectId);
    if (root.kind !== "resolved") return { kind: "error", code: "missing", message: "The Project is unavailable." };
    const candidate = path.join(root.canonicalRoot, ...safePath.split("/"));
    if (!isWithin(root.canonicalRoot, candidate)) return { kind: "error", code: "invalid", message: "The Project asset path is invalid." };
    try {
      const stats = await lstat(candidate);
      if (!stats.isFile() || stats.isSymbolicLink()) return { kind: "error", code: "missing", message: "The Project asset is unavailable." };
      if (stats.size > (info.assetKind === "image" ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES)) return { kind: "error", code: "too-large", message: "The Project asset is too large to preview safely." };
      const canonical = await realpath(candidate);
      if (!isWithin(root.canonicalRoot, canonical)) return { kind: "error", code: "invalid", message: "The Project asset is outside this Project." };
      const bytes = await readFile(canonical);
      if (!magicMatches(bytes.subarray(0, 32), info.mimeType)) return { kind: "error", code: "unsupported", message: "The Project asset content is not supported." };
      return { kind: "resolved", ...info, dataUrl: `data:${info.mimeType};base64,${bytes.toString("base64")}` };
    } catch { return { kind: "error", code: "missing", message: "The Project asset is unavailable." }; }
  }

  public async importDroppedImageForOwner(
    owner: object,
    projectId: string,
    sourcePath: string,
    optimize: boolean
  ): Promise<ProjectAssetImportResult> {
    const source = await checkedSourceImage(sourcePath);
    if (source === null) return { kind: "error", code: "unsupported", message: "Drop a PNG, JPEG, or WebP image smaller than 25 MB." };
    const root = await this.workspace.resolveDocumentRoot(owner, projectId);
    if (root.kind !== "resolved") return { kind: "error", code: "invalid", message: "Open a Project before importing an image." };
    const assetsDirectory = path.join(root.canonicalRoot, "assets");
    try {
      const extension = optimize ? ".webp" : path.extname(source.canonicalPath).toLowerCase();
      // Transform fully before creating a Project asset.  A decoding failure
      // therefore cannot leave a partial image behind.
      const contents = optimize
        ? await sharp(source.canonicalPath, { failOn: "error" })
        // sharp's default output excludes EXIF/GPS metadata; rotate applies
        // orientation before that metadata is stripped. withoutEnlargement
        // protects small source files and WebP retains alpha when present.
          .rotate()
          .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
          .webp({ quality: 80 })
          .toBuffer()
        : source.bytes;
      await mkdir(assetsDirectory, { recursive: true });
      const name = await writeCollisionSafeAsset(assetsDirectory, fileStem(source.canonicalPath), extension, contents);
      return { kind: "imported", relativePath: `assets/${name}`, mimeType: optimize ? "image/webp" : source.mimeType };
    } catch {
      return { kind: "error", code: "import-failed", message: "The image could not be imported into this Project." };
    }
  }
}
