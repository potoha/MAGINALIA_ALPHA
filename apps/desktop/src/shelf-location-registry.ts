import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { parseDocument } from "yaml";

export const SHELF_LOCATION_FILE_NAME = "shelf_location.yml";

export interface ShelfUrls {
  readonly github: string | null;
  readonly homepage: string | null;
  readonly other: readonly string[];
}

export interface ShelfLocation {
  readonly registry: string | null;
  readonly urls: ShelfUrls;
}

export interface ShelfLocationRegistryConfig {
  readonly version: 1;
  readonly privateShelf: ShelfLocation;
  readonly publicShelf: ShelfLocation;
}

export interface ShelfLocationRegistryLoaded {
  readonly kind: "loaded";
  readonly config: ShelfLocationRegistryConfig;
}

export interface ShelfLocationRegistryFailure {
  readonly kind: "error";
  readonly message: string;
}

export type ShelfLocationRegistryResult = ShelfLocationRegistryLoaded | ShelfLocationRegistryFailure;

const DEFAULT_URLS: ShelfUrls = Object.freeze({
  github: null,
  homepage: null,
  other: Object.freeze([]),
});

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function parseUrls(value: unknown): ShelfUrls | undefined {
  if (value === undefined) return DEFAULT_URLS;
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["github", "homepage", "other"])) return undefined;
  const github = value.github;
  const homepage = value.homepage;
  const other = value.other;
  if ((github !== null && !isHttpUrl(github)) || (homepage !== null && !isHttpUrl(homepage))) return undefined;
  if (!Array.isArray(other) || !other.every(isHttpUrl)) return undefined;
  return Object.freeze({ github, homepage, other: Object.freeze([...other]) });
}

function parseShelfLocation(value: unknown): ShelfLocation | undefined {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["registry", "urls"])) return undefined;
  if (value.registry !== null && (typeof value.registry !== "string" || value.registry.length === 0 || !path.isAbsolute(value.registry))) {
    return undefined;
  }
  const urls = parseUrls(value.urls);
  if (urls === undefined) return undefined;
  return Object.freeze({ registry: value.registry, urls });
}

function parseConfig(value: unknown): ShelfLocationRegistryConfig | undefined {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["version", "private_shelf", "public_shelf"]) || value.version !== 1) {
    return undefined;
  }
  const privateShelf = parseShelfLocation(value.private_shelf);
  const publicShelf = parseShelfLocation(value.public_shelf);
  if (privateShelf === undefined || publicShelf === undefined) return undefined;
  return Object.freeze({ version: 1, privateShelf, publicShelf });
}

/**
 * Read-only machine-local registry location configuration. It intentionally
 * stores no Shelf data, indexes, or selected document state.
 */
export class ShelfLocationRegistry {
  public constructor(private readonly filePath: string) {}

  public async load(): Promise<ShelfLocationRegistryResult> {
    let source: string;
    try {
      source = await readFile(this.filePath, "utf8");
    } catch (error: unknown) {
      const code = error !== null && typeof error === "object" && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
      return Object.freeze({
        kind: "error",
        message: code === "ENOENT"
          ? "Private Shelf is not configured: shelf_location.yml was not found."
          : "Private Shelf configuration could not be read. Check shelf_location.yml.",
      });
    }

    try {
      const document = parseDocument(source, { prettyErrors: false });
      if (document.errors.length > 0) {
        return Object.freeze({ kind: "error", message: "Private Shelf configuration is invalid. Check shelf_location.yml." });
      }
      const config = parseConfig(document.toJS());
      if (config === undefined) {
        return Object.freeze({ kind: "error", message: "Private Shelf configuration is invalid. Check shelf_location.yml." });
      }
      return Object.freeze({ kind: "loaded", config });
    } catch {
      return Object.freeze({ kind: "error", message: "Private Shelf configuration is invalid. Check shelf_location.yml." });
    }
  }
}
