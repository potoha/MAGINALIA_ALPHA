import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { serializeQuoteRef } from "@maginalia/writing-core";
import { ConfiguredPrivateShelf } from "./configured-private-shelf";
import { LibraryService } from "./library-service";
import { SHELF_LOCATION_FILE_NAME, ShelfLocationRegistry } from "./shelf-location-registry";
import { resolveShelfQuoteRefs } from "./shelf-resolution";

const BOOK_ID = "isbn:9780306406157";
const ANNOTATION_ID = "ann:01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SECOND_ANNOTATION_ID = "ann:01ARZ3NDEKTSV4RRFFQ69G5FAW";
const REVIEWER_ANNOTATION_UUID = "123e4567-e89b-42d3-a456-426614174000";

async function withTempDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "maginalia-shelf-location-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function createCanonicalShelf(root: string): Promise<void> {
  await mkdir(path.join(root, "books"), { recursive: true });
  await mkdir(path.join(root, "annotations"), { recursive: true });
  await writeJson(path.join(root, "library.json"), {
    type: "library",
    version: "0.1",
    name: "日本語の引用棚",
    booksPath: "books",
    annotationsPath: "annotations",
  });
  await writeJson(path.join(root, "books", "book.json"), {
    type: "book",
    version: "0.1",
    id: BOOK_ID,
    isbn13: BOOK_ID.slice("isbn:".length),
    title: "『構成された棚』",
    authors: ["山田太郎"],
  });
  await writeJson(path.join(root, "annotations", "annotation.json"), {
    type: "annotation",
    version: "0.1",
    id: ANNOTATION_ID,
    source: BOOK_ID,
    location: { page: 42 },
    quote: "設定された Shelf の引用です。",
    privateMemo: "検索可能なメモ",
    deviceMetadata: {
      maginaliaReviewer: { version: 1, annotationId: REVIEWER_ANNOTATION_UUID, digest: "sha256:fixture" },
    },
  });
}

function locationYaml(registry: string | null): string {
  const value = registry === null ? "null" : JSON.stringify(registry);
  return [
    "version: 1",
    "",
    "private_shelf:",
    `  registry: ${value}`,
    "  urls:",
    "    github: null",
    "    homepage: null",
    "    other: []",
    "",
    "public_shelf:",
    "  registry: null",
    "  urls:",
    "    github: null",
    "    homepage: null",
    "    other: []",
    "",
  ].join("\n");
}

describe("shelf_location.yml", () => {
  it("parses an explicit Unicode Private Shelf and accepts an absent Public Shelf", async () => {
    await withTempDirectory(async (directory) => {
      const configPath = path.join(directory, SHELF_LOCATION_FILE_NAME);
      const registryPath = path.join(directory, "資料", "引用棚");
      await writeFile(configPath, locationYaml(registryPath), "utf8");

      const result = await new ShelfLocationRegistry(configPath).load();

      expect(result).toEqual({
        kind: "loaded",
        config: {
          version: 1,
          privateShelf: {
            registry: registryPath,
            urls: { github: null, homepage: null, other: [] },
          },
          publicShelf: {
            registry: null,
            urls: { github: null, homepage: null, other: [] },
          },
        },
      });
    });
  });

  it("rejects malformed, relative, and missing configuration without reading a Shelf", async () => {
    await withTempDirectory(async (directory) => {
      const configPath = path.join(directory, SHELF_LOCATION_FILE_NAME);
      const registry = new ShelfLocationRegistry(configPath);
      await expect(registry.load()).resolves.toMatchObject({ kind: "error", message: expect.stringContaining("not found") });

      await writeFile(configPath, "version: 1\nprivate_shelf:\n  registry: relative\npublic_shelf:\n  registry: null\n", "utf8");
      await expect(registry.load()).resolves.toMatchObject({ kind: "error", message: expect.stringContaining("invalid") });

      await writeFile(configPath, "version: [\n", "utf8");
      await expect(registry.load()).resolves.toMatchObject({ kind: "error", message: expect.stringContaining("invalid") });
    });
  });

  it("binds and reloads the configured canonical Shelf without accepting a fallback directory", async () => {
    await withTempDirectory(async (directory) => {
      const configPath = path.join(directory, SHELF_LOCATION_FILE_NAME);
      const shelfRoot = path.join(directory, "資料", "引用棚");
      await createCanonicalShelf(shelfRoot);
      await writeFile(configPath, locationYaml(shelfRoot), "utf8");

      const service = new LibraryService();
      const configured = new ConfiguredPrivateShelf(new ShelfLocationRegistry(configPath), service);
      const owner = {};
      const first = await configured.getActive(owner);
      expect(first).toMatchObject({
        kind: "private-shelf",
        records: [{ annotationId: ANNOTATION_ID, quote: "設定された Shelf の引用です。" }],
      });
      if (first.kind !== "private-shelf") throw new Error("Expected configured Private Shelf");

      const resolved = await resolveShelfQuoteRefs(
        `${serializeQuoteRef({ quoteId: ANNOTATION_ID, mode: "normal" })}\n${serializeQuoteRef({ quoteId: REVIEWER_ANNOTATION_UUID, mode: "normal" })}`,
        first.entities,
      );
      expect(resolved).toMatchObject({ kind: "resolved", resolved: [{ quotation: { annotationId: ANNOTATION_ID } }, { quotation: { annotationId: REVIEWER_ANNOTATION_UUID } }], unresolved: [] });

      await writeJson(path.join(shelfRoot, "annotations", "second.json"), {
        type: "annotation",
        version: "0.1",
        id: SECOND_ANNOTATION_ID,
        source: BOOK_ID,
        location: { page: 43 },
        quote: "再読み込み後の引用です。",
      });
      const reloaded = await configured.reload(owner);
      expect(reloaded).toMatchObject({ kind: "opened", recordCount: 2, library: { libraryId: first.library.libraryId } });

      const fallbackRoot = path.join(directory, "fallback");
      await mkdir(fallbackRoot);
      await writeFile(configPath, locationYaml(fallbackRoot), "utf8");
      await expect(configured.getActive(owner)).resolves.toMatchObject({
        kind: "error",
        code: "invalid-library-config",
        message: expect.stringContaining("could not be opened"),
      });
      expect(service.getActivePrivateShelfForOwner(owner)).toMatchObject({
        kind: "private-shelf",
        library: { libraryId: first.library.libraryId },
      });

      await unlink(configPath);
      await expect(configured.getActive(owner)).resolves.toMatchObject({
        kind: "error",
        code: "invalid-library-config",
        message: expect.stringContaining("not found"),
      });
    });
  });
});
