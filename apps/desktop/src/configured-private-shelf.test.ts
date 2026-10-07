import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { serializeFolderMarker } from "@maginalia/repository-core";
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

  it("preserves optional URL metadata as local storage without URL validation or network access", async () => {
    await withTempDirectory(async (directory) => {
      const configPath = path.join(directory, SHELF_LOCATION_FILE_NAME);
      const registryPath = path.join(directory, "資料", "引用棚");
      await writeFile(configPath, [
        "version: 1",
        "private_shelf:",
        `  registry: ${JSON.stringify(registryPath)}`,
        "  urls:",
        "    github: not-a-network-url",
        "    homepage: ''",
        "    other: ['maginalia://local', 'https://example.test/metadata']",
        "public_shelf:",
        "  registry: null",
        "  urls:",
        "    github: null",
        "    homepage: null",
        "    other: []",
        "",
      ].join("\n"), "utf8");

      const sourceBeforeLoad = await readFile(configPath, "utf8");
      await expect(new ShelfLocationRegistry(configPath).load()).resolves.toEqual({
        kind: "loaded",
        config: {
          version: 1,
          privateShelf: {
            registry: registryPath,
            urls: {
              github: "not-a-network-url",
              homepage: "",
              other: ["maginalia://local", "https://example.test/metadata"],
            },
          },
          publicShelf: { registry: null, urls: { github: null, homepage: null, other: [] } },
        },
      });
      expect(await readFile(configPath, "utf8")).toBe(sourceBeforeLoad);
    });
  });

  it("rejects malformed, relative, and missing configuration without reading a Shelf", async () => {
    await withTempDirectory(async (directory) => {
      const configPath = path.join(directory, SHELF_LOCATION_FILE_NAME);
      const registry = new ShelfLocationRegistry(configPath);
      await expect(registry.load()).resolves.toMatchObject({
        kind: "error",
        message: expect.stringContaining(configPath),
      });

      await writeFile(configPath, "version: 1\nprivate_shelf:\n  registry: relative\npublic_shelf:\n  registry: null\n", "utf8");
      await expect(registry.load()).resolves.toMatchObject({ kind: "error", message: expect.stringContaining("invalid") });

      await writeFile(configPath, "version: [\n", "utf8");
      await expect(registry.load()).resolves.toMatchObject({ kind: "error", message: expect.stringContaining("invalid") });
    });
  });

  it("reports the attempted configuration path when Private Shelf is explicitly absent", async () => {
    await withTempDirectory(async (directory) => {
      const configPath = path.join(directory, SHELF_LOCATION_FILE_NAME);
      await writeFile(configPath, locationYaml(null), "utf8");
      const configured = new ConfiguredPrivateShelf(new ShelfLocationRegistry(configPath), new LibraryService());

      await expect(configured.getActive({})).resolves.toMatchObject({
        kind: "error",
        code: "invalid-library-config",
        message: expect.stringContaining(configPath),
      });
    });
  });

  it("persists a user-selected canonical Shelf without changing Public Shelf or URL metadata", async () => {
    await withTempDirectory(async (directory) => {
      const configPath = path.join(directory, SHELF_LOCATION_FILE_NAME);
      const shelfRoot = path.join(directory, "資料", "選択した引用棚");
      await createCanonicalShelf(shelfRoot);
      await writeFile(configPath, [
        "version: 1",
        "private_shelf:",
        "  registry: null",
        "  urls:",
        "    github: private-metadata",
        "    homepage: ''",
        "    other: ['maginalia://private']",
        "public_shelf:",
        "  registry: null",
        "  urls:",
        "    github: public-metadata",
        "    homepage: null",
        "    other: ['maginalia://public']",
        "",
      ].join("\n"), "utf8");

      const configured = new ConfiguredPrivateShelf(new ShelfLocationRegistry(configPath), new LibraryService());
      expect(await configured.isPrivateShelfUnconfigured()).toBe(true);
      const shelfDataPaths = [
        path.join(shelfRoot, "library.json"),
        path.join(shelfRoot, "books", "book.json"),
        path.join(shelfRoot, "annotations", "annotation.json"),
      ];
      const shelfDataBefore = await Promise.all(shelfDataPaths.map((filePath) => readFile(filePath)));
      const active = await configured.configureAndOpen({}, shelfRoot);
      expect(active).toMatchObject({
        kind: "private-shelf",
        records: [{ annotationId: ANNOTATION_ID }],
      });
      expect(active.kind).toBe("private-shelf");
      if (active.kind !== "private-shelf") throw new Error("Expected configured Private Shelf");
      expect(active.folderIdentityId).toMatch(/^[0-9a-f-]{36}$/iu);
      expect(await readFile(path.join(shelfRoot, "shelf.magi"), "utf8")).toContain(`id = ${active.folderIdentityId}`);
      expect(await Promise.all(shelfDataPaths.map((filePath) => readFile(filePath)))).toEqual(shelfDataBefore);
      await expect(new ShelfLocationRegistry(configPath).load()).resolves.toEqual({
        kind: "loaded",
        config: {
          version: 1,
          privateShelf: {
            registry: shelfRoot,
            urls: { github: "private-metadata", homepage: "", other: ["maginalia://private"] },
          },
          publicShelf: {
            registry: null,
            urls: { github: "public-metadata", homepage: null, other: ["maginalia://public"] },
          },
        },
      });
    });
  });

  it("keeps Shelf records readable and unchanged while exposing conflicting folder markers", async () => {
    await withTempDirectory(async (directory) => {
      const shelfRoot = path.join(directory, "資料", "引用棚");
      await createCanonicalShelf(shelfRoot);
      const annotationPath = path.join(shelfRoot, "annotations", "annotation.json");
      const before = await readFile(annotationPath);
      await writeFile(path.join(shelfRoot, "shelf.magi"), serializeFolderMarker({
        version: 1, type: "shelf", id: "11111111-1111-4111-8111-111111111111",
      }), "utf8");
      await writeFile(path.join(shelfRoot, "本棚.magi"), serializeFolderMarker({
        version: 1, type: "shelf", id: "22222222-2222-4222-8222-222222222222",
      }), "utf8");

      const result = await new LibraryService().openPrivateShelfForOwner({}, shelfRoot);

      expect(result).toMatchObject({
        kind: "opened",
        recordCount: 1,
        folderIdentityRecovery: { code: "marker-conflict" },
      });
      expect(await readFile(annotationPath)).toEqual(before);
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
        message: expect.stringContaining(configPath),
      });
    });
  });
});
