import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { materializeTutorialShelfSeed } from "./tutorial-seed";

const repositoryRoot = path.resolve(__dirname, "../../..");
const manifestPath = path.join(repositoryRoot, "Tutorial_sample_setup", "installer-copy-manifest.json");
const seedRoot = path.join(repositoryRoot, "Tutorial_sample_setup", "private-shelf-seed");

async function withShelf(run: (root: string) => Promise<void>): Promise<void> {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "magi-tutorial-seed-"));
  const shelfRoot = path.join(temporaryRoot, "日本語の本棚");
  try {
    await mkdir(path.join(shelfRoot, "books"), { recursive: true });
    await mkdir(path.join(shelfRoot, "annotations"), { recursive: true });
    await writeFile(path.join(shelfRoot, "library.json"), `${JSON.stringify({
      type: "library", version: "0.1", name: "Existing shelf", booksPath: "books", annotationsPath: "annotations"
    }, null, 2)}\n`, "utf8");
    await writeFile(path.join(shelfRoot, "shelf.magi"), "version = 1\ntype = shelf\nid = 11111111-1111-4111-8111-111111111111\n", "utf8");
    await writeFile(path.join(shelfRoot, "books", "user-book.json"), JSON.stringify({
      type: "book", version: "0.1", id: "isbn:9784000000001", title: "User book", authors: ["User"], isbn13: "9784000000001"
    }), "utf8");
    await run(shelfRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

describe("Tutorial Shelf seed materialization", () => {
  it("adds missing v0.1 records idempotently and preserves the marker, library, and existing bytes", async () => {
    await withShelf(async (shelfRoot) => {
      const libraryBefore = await readFile(path.join(shelfRoot, "library.json"));
      const markerBefore = await readFile(path.join(shelfRoot, "shelf.magi"));
      const userBookBefore = await readFile(path.join(shelfRoot, "books", "user-book.json"));

      const first = await materializeTutorialShelfSeed(manifestPath, shelfRoot);
      expect(first.booksAdded).toBe(3);
      expect(first.annotationsAdded).toBe(3);
      expect(first.conflicts).toEqual([]);

      const books = await readdir(path.join(shelfRoot, "books"));
      const annotations = await readdir(path.join(shelfRoot, "annotations"));
      expect(books).toHaveLength(4);
      expect(annotations).toHaveLength(3);

      const second = await materializeTutorialShelfSeed(manifestPath, shelfRoot);
      expect(second).toEqual({ booksAdded: 0, annotationsAdded: 0, conflicts: [] });
      expect(await readFile(path.join(shelfRoot, "library.json"))).toEqual(libraryBefore);
      expect(await readFile(path.join(shelfRoot, "shelf.magi"))).toEqual(markerBefore);
      expect(await readFile(path.join(shelfRoot, "books", "user-book.json"))).toEqual(userBookBefore);
    });
  });

  it("reports same-ID conflicts and still materializes unrelated tutorial records", async () => {
    await withShelf(async (shelfRoot) => {
      await writeFile(path.join(shelfRoot, "books", "9784101092058.json"), JSON.stringify({
        type: "book", version: "0.1", id: "isbn:9784101092058", title: "Different book", authors: ["宮沢 賢治"],
        isbn13: "9784101092058", publisher: "新潮社", year: 1989
      }), "utf8");

      const result = await materializeTutorialShelfSeed(manifestPath, shelfRoot);
      expect(result.booksAdded).toBe(2);
      expect(result.annotationsAdded).toBe(2);
      expect(result.conflicts).toContainEqual({
        kind: "book", id: "isbn:9784101092058", reason: "same-id-different-content"
      });
      expect(result.conflicts).toContainEqual({
        kind: "annotation", id: "ann:01JABCDEFGHJKMNPQRSTVWXYZ1", reason: "missing-source-book"
      });
      expect(await readFile(path.join(shelfRoot, "books", "9784101092058.json"), "utf8"))
        .toContain("Different book");
      expect((await readdir(path.join(shelfRoot, "books"))).sort()).toHaveLength(4);
    });
  });

  it("preserves matching records when JSON whitespace and key order differ", async () => {
    await withShelf(async (shelfRoot) => {
      const seed = JSON.parse(await readFile(path.join(seedRoot, "books", "9784101092058.json"), "utf8")) as Record<string, unknown>;
      const matchingPath = path.join(shelfRoot, "books", "matching.json");
      const existingText = JSON.stringify({
        year: seed.year, publisher: seed.publisher, isbn13: seed.isbn13, authors: seed.authors,
        title: seed.title, id: seed.id, version: seed.version, type: seed.type
      }, null, 4);
      await writeFile(matchingPath, existingText, "utf8");
      const before = await readFile(matchingPath);

      const result = await materializeTutorialShelfSeed(manifestPath, shelfRoot);
      expect(result.booksAdded).toBe(2);
      expect(await readFile(matchingPath)).toEqual(before);
    });
  });
});
