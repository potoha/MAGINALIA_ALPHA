import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LibraryService,
  type LibraryOpened,
  type LibraryOpenResult,
  type LibraryRecordsResult,
  type LibraryRecord,
} from "./library-service";

const BOOK_ID = "isbn:9781234567890";
const SECOND_BOOK_ID = "isbn:9781234567891";
const ANNOTATION_ID = "ann:01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SECOND_ANNOTATION_ID = "ann:01ARZ3NDEKTSV4RRFFQ69G5FAW";
const REVIEWER_ANNOTATION_UUID = "123e4567-e89b-42d3-a456-426614174000";

async function withTempDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "maginalia-library-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(value), "utf8");
}

function book(id = BOOK_ID, title = "Book"): object {
  return {
    type: "book",
    version: "0.1",
    id,
    title,
    authors: ["Author"],
    isbn13: id.slice("isbn:".length),
  };
}

function annotation(
  id = ANNOTATION_ID,
  source = BOOK_ID,
  quote = "引用",
): object {
  return {
    type: "annotation",
    version: "0.1",
    id,
    source,
    location: { page: 4, path: "pages/p4" },
    quote,
    comment: "not retained",
    attribution: "not retained",
    captureImage: "capture/page.jpg",
    rawOcr: "raw OCR must not survive",
    localPath: "private/original.png",
    deviceMetadata: { device: "private" },
    privateMemo: "private search memo",
    unpublishedComments: ["not published"],
  };
}

async function createPrivateShelf(root: string): Promise<void> {
  await mkdir(path.join(root, "books"), { recursive: true });
  await mkdir(path.join(root, "annotations"), { recursive: true });
  await writeJson(path.join(root, "library.json"), {
    type: "library",
    version: "0.1",
    name: "Selected Shelf",
    booksPath: "books",
    annotationsPath: "annotations",
  });
  await writeJson(path.join(root, "books", "book.json"), {
    ...book(),
    publisher: "青土社",
    year: 1990,
    coverImage: "private/cover.jpg",
  });
  await writeJson(path.join(root, "annotations", "annotation.json"), {
    ...annotation(),
    quote: "canonical quote",
    deviceMetadata: {
      maginaliaReviewer: {
        version: 1,
        annotationId: REVIEWER_ANNOTATION_UUID,
        digest: "private provenance digest",
      },
    },
  });
}

function opened(result: LibraryOpenResult): LibraryOpened {
  expect(result.kind).toBe("opened");
  if (result.kind !== "opened") throw new Error("Expected the Library to open");
  return result;
}

function records(result: LibraryRecordsResult): readonly LibraryRecord[] {
  expect(result.kind).toBe("records");
  if (result.kind !== "records") throw new Error("Expected a Library snapshot");
  return result.records;
}

describe("LibraryService", () => {
  it("loads configured YAML and JSON scopes and returns an opaque summary", async () => {
    await withTempDirectory(async (directory) => {
      const root = path.join(directory, "configured-library");
      await mkdir(path.join(root, "catalog"), { recursive: true });
      await mkdir(path.join(root, "annotations"), { recursive: true });
      await writeJson(path.join(root, "library.json"), {
        type: "library",
        version: "0.1",
        name: "Configured Library",
        booksPath: "catalog",
        annotationsPath: "annotations",
      });
      await writeJson(path.join(root, "catalog", "book.json"), book());
      await writeFile(
        path.join(root, "annotations", "quote.yaml"),
        [
          "type: annotation",
          "version: '0.1'",
          `id: '${ANNOTATION_ID}'`,
          `source: '${BOOK_ID}'`,
          "location:",
          "  page: 4",
          "quote: '引用 from YAML'",
          "privateMemo: 'private search memo'",
        ].join("\n"),
        "utf8",
      );
      await writeJson(path.join(root, "outside-book.json"), book(SECOND_BOOK_ID, "Ignored Book"));

      const owner = {};
      const service = new LibraryService();
      const result = opened(await service.openForOwner(owner, root));

      expect(result.library.displayName).toBe("Configured Library");
      expect(result.library.libraryId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(result.recordCount).toBe(1);
      expect(JSON.stringify(result)).not.toContain(root);
      expect(JSON.stringify(result)).not.toContain("private search memo");
      expect(JSON.stringify(result)).not.toContain("引用 from YAML");

      const snapshot = records(service.getRecordsForOwner(owner, result.library.libraryId));
      expect(snapshot).toEqual([expect.objectContaining({
        annotationId: ANNOTATION_ID,
        sourceId: BOOK_ID,
        quote: "引用 from YAML",
        title: "Book",
        authors: ["Author"],
        privateMemo: "private search memo",
        page: 4,
      })]);
    });
  });

  it("uses the selected root as the fallback display name and scope", async () => {
    await withTempDirectory(async (directory) => {
      const root = path.join(directory, "fallback-library");
      await mkdir(root);
      await writeJson(path.join(root, "book.json"), book());
      await writeFile(
        path.join(root, "annotation.yml"),
        [
          "type: annotation",
          "version: '0.1'",
          `id: '${ANNOTATION_ID}'`,
          `source: '${BOOK_ID}'`,
          "location: {page: 1}",
          "quote: 'root fallback'",
        ].join("\n"),
        "utf8",
      );

      const result = opened(await new LibraryService().openForOwner({}, root));
      expect(result.library.displayName).toBe("fallback-library");
      expect(result.recordCount).toBe(1);
    });
  });

  it("retains a minimized canonical entity view only through the Private Shelf open seam", async () => {
    await withTempDirectory(async (directory) => {
      const root = path.join(directory, "研究用 Shelf");
      await createPrivateShelf(root);

      const owner = {};
      const service = new LibraryService();
      const ordinary = opened(await service.openForOwner(owner, root));
      expect(service.getActivePrivateShelfForOwner(owner)).toMatchObject({
        kind: "error",
        code: "library-not-owned",
      });

      const selected = opened(await service.openPrivateShelfForOwner(owner, root));
      expect(selected.library.libraryId).not.toBe(ordinary.library.libraryId);
      expect(JSON.stringify(selected)).not.toContain(root);
      const publicRecords = records(service.getRecordsForOwner(owner, selected.library.libraryId));
      expect(JSON.stringify(publicRecords)).not.toContain(root);
      expect(JSON.stringify(publicRecords)).not.toContain(REVIEWER_ANNOTATION_UUID);
      expect(JSON.stringify(publicRecords)).not.toContain("private provenance digest");
      expect(JSON.stringify(publicRecords)).not.toContain("private/cover.jpg");

      const active = service.getActivePrivateShelfForOwner(owner);
      expect(active).toMatchObject({
        kind: "private-shelf",
        privateShelf: true,
        library: { libraryId: selected.library.libraryId, displayName: "Selected Shelf" },
        records: [{ annotationId: ANNOTATION_ID, sourceId: BOOK_ID, quote: "canonical quote" }],
        entities: {
          annotations: [{
            id: ANNOTATION_ID,
            source: BOOK_ID,
            deviceMetadata: { maginaliaReviewer: { annotationId: REVIEWER_ANNOTATION_UUID } },
          }],
          books: [{
            id: BOOK_ID,
            isbn13: BOOK_ID.slice("isbn:".length),
            title: "Book",
            publisher: "青土社",
            year: 1990,
          }],
        },
      });
      if (active.kind !== "private-shelf") throw new Error("Expected the selected Private Shelf view");
      expect(active.canonicalRoot).toBe(await realpath(root));
      const retained = JSON.stringify(active.entities);
      expect(retained).not.toContain("capture/page.jpg");
      expect(retained).not.toContain("private/original.png");
      expect(retained).not.toContain("private provenance digest");
      expect(retained).not.toContain("private/cover.jpg");
    });
  });

  it("reloads the same selected Private Shelf into its existing Library ID", async () => {
    await withTempDirectory(async (directory) => {
      const root = path.join(directory, "reload-library");
      await createPrivateShelf(root);

      const owner = {};
      const service = new LibraryService();
      const first = opened(await service.openPrivateShelfForOwner(owner, root));
      await writeJson(path.join(root, "books", "second-book.json"), book(SECOND_BOOK_ID, "Second Book"));
      await writeJson(
        path.join(root, "annotations", "second-annotation.json"),
        annotation(SECOND_ANNOTATION_ID, SECOND_BOOK_ID, "new after materialization"),
      );

      const reloaded = opened(await service.reloadForOwner(owner));
      expect(reloaded.library.libraryId).toBe(first.library.libraryId);
      expect(reloaded.recordCount).toBe(2);
      expect(service.getActivePrivateShelfForOwner(owner)).toMatchObject({
        kind: "private-shelf",
        library: { libraryId: first.library.libraryId },
        records: expect.arrayContaining([
          expect.objectContaining({ annotationId: ANNOTATION_ID }),
          expect.objectContaining({ annotationId: SECOND_ANNOTATION_ID, quote: "new after materialization" }),
        ]),
        entities: {
          annotations: expect.arrayContaining([
            expect.objectContaining({ id: ANNOTATION_ID }),
            expect.objectContaining({ id: SECOND_ANNOTATION_ID }),
          ]),
        },
      });
      expect(records(service.getRecordsForOwner(owner, first.library.libraryId))).toHaveLength(2);
    });
  });

  it("reopens canonical Reviewer aliases and Book metadata after a service restart on a Unicode root", async () => {
    await withTempDirectory(async (directory) => {
      const root = path.join(directory, "資料", "引用棚");
      await createPrivateShelf(root);

      const firstService = new LibraryService();
      const first = opened(await firstService.openPrivateShelfForOwner({}, root));
      const restartedService = new LibraryService();
      const ownerAfterRestart = {};
      const reopened = opened(await restartedService.openPrivateShelfForOwner(ownerAfterRestart, root));
      expect(reopened.library.libraryId).not.toBe(first.library.libraryId);
      const active = restartedService.getActivePrivateShelfForOwner(ownerAfterRestart);
      expect(active).toMatchObject({
        kind: "private-shelf",
        entities: {
          annotations: [{
            id: ANNOTATION_ID,
            deviceMetadata: { maginaliaReviewer: { annotationId: REVIEWER_ANNOTATION_UUID } },
          }],
          books: [{
            id: BOOK_ID,
            isbn13: BOOK_ID.slice("isbn:".length),
            title: "Book",
            authors: ["Author"],
            publisher: "青土社",
            year: 1990,
          }],
        },
      });
      if (active.kind !== "private-shelf") throw new Error("Expected the reopened Private Shelf view");
      expect(active.canonicalRoot).toBe(await realpath(root));
      expect(active.records[0]).toMatchObject({
        annotationId: ANNOTATION_ID,
        sourceId: BOOK_ID,
        title: "Book",
        authors: ["Author"],
      });
    });
  });

  it("projects only the main-side record allowlist and excludes private evidence fields", async () => {
    await withTempDirectory(async (directory) => {
      const root = path.join(directory, "privacy-library");
      await mkdir(root);
      await writeJson(path.join(root, "book.json"), {
        ...book(),
        coverImage: "covers/private-cover.png",
        publisher: "Publisher",
      });
      await writeJson(path.join(root, "annotation.json"), annotation());

      const service = new LibraryService();
      const result = opened(await service.openForOwner({}, root));
      // The object passed to openForOwner is intentionally not reused above;
      // this lookup must not accidentally work for another owner.
      expect(service.getRecordsForOwner({}, result.library.libraryId)).toMatchObject({
        kind: "error",
        code: "library-not-owned",
      });
      expect(result.recordCount).toBe(1);

      const owner = {};
      const owned = opened(await service.openForOwner(owner, root));
      const ownedRecords = records(service.getRecordsForOwner(owner, owned.library.libraryId));
      expect(ownedRecords).toHaveLength(1);
      expect(Object.keys(ownedRecords[0]).sort()).toEqual([
        "annotationId",
        "authors",
        "page",
        "privateMemo",
        "quote",
        "sourceId",
        "title",
      ]);
      const serialized = JSON.stringify(ownedRecords);
      expect(serialized).toContain("private search memo");
      expect(serialized).not.toContain("raw OCR must not survive");
      expect(serialized).not.toContain("capture/page.jpg");
      expect(serialized).not.toContain("private/original.png");
      expect(serialized).not.toContain("not retained");
      expect(serialized).not.toContain("not published");
      expect(serialized).not.toContain("private-cover.png");
    });
  });

  it("excludes every duplicate ID and orphan annotation while counting issues", async () => {
    await withTempDirectory(async (directory) => {
      const root = path.join(directory, "ambiguous-library");
      await mkdir(path.join(root, "books"), { recursive: true });
      await mkdir(path.join(root, "annotations"), { recursive: true });
      await writeJson(path.join(root, "books", "duplicate-a.json"), book());
      await writeJson(path.join(root, "books", "duplicate-b.json"), book());
      await writeJson(path.join(root, "books", "unique.json"), book(SECOND_BOOK_ID, "Unique"));
      await writeJson(path.join(root, "annotations", "duplicate-a.json"), annotation(ANNOTATION_ID, SECOND_BOOK_ID));
      await writeJson(path.join(root, "annotations", "duplicate-b.json"), annotation(ANNOTATION_ID, SECOND_BOOK_ID));
      await writeJson(path.join(root, "annotations", "valid.json"), annotation(SECOND_ANNOTATION_ID, SECOND_BOOK_ID, "kept"));
      await writeJson(path.join(root, "annotations", "orphan.json"), annotation("ann:01ARZ3NDEKTSV4RRFFQ69G5FAX", BOOK_ID, "orphan"));

      const result = opened(await new LibraryService().openForOwner({}, root));
      expect(result.recordCount).toBe(1);
      expect(result.issueCount).toBeGreaterThanOrEqual(3);
    });
  });

  it("fails closed for invalid or ambiguous Library configuration", async () => {
    await withTempDirectory(async (directory) => {
      const missingScopeRoot = path.join(directory, "missing-scope");
      await mkdir(missingScopeRoot);
      await writeJson(path.join(missingScopeRoot, "library.json"), {
        type: "library",
        version: "0.1",
        name: "Missing scope",
        booksPath: "does-not-exist",
      });
      const service = new LibraryService();
      expect(await service.openForOwner({}, missingScopeRoot)).toMatchObject({
        kind: "error",
        code: "invalid-library-config",
      });

      const traversalRoot = path.join(directory, "traversal");
      await mkdir(traversalRoot);
      await writeJson(path.join(traversalRoot, "library.json"), {
        type: "library",
        version: "0.1",
        name: "Traversal",
        booksPath: "../outside",
      });
      expect(await service.openForOwner({}, traversalRoot)).toMatchObject({
        kind: "error",
        code: "invalid-library",
      });

      const ambiguousRoot = path.join(directory, "ambiguous");
      await mkdir(ambiguousRoot);
      await writeJson(path.join(ambiguousRoot, "library-a.json"), { type: "library", version: "0.1", name: "A" });
      await writeJson(path.join(ambiguousRoot, "library-b.json"), { type: "library", version: "0.1", name: "B" });
      expect(await service.openForOwner({}, ambiguousRoot)).toMatchObject({
        kind: "error",
        code: "ambiguous-library",
      });
    });
  });

  it("rejects invalid roots without throwing and does not expose paths", async () => {
    await withTempDirectory(async (directory) => {
      const service = new LibraryService();
      const filePath = path.join(directory, "not-a-directory.json");
      await writeFile(filePath, "{}", "utf8");

      expect(await service.openForOwner(null, directory)).toMatchObject({ kind: "error", code: "invalid-owner" });
      expect(await service.openForOwner({}, "relative-root")).toMatchObject({ kind: "error", code: "invalid-root" });
      expect(await service.openForOwner({}, path.join(directory, "missing"))).toMatchObject({ kind: "error", code: "root-missing" });
      const fileResult = await service.openForOwner({}, filePath);
      expect(fileResult).toMatchObject({ kind: "error", code: "root-not-directory" });
      expect(JSON.stringify(fileResult)).not.toContain(filePath);
    });
  });

  it("counts oversized candidates and skips hidden/build content", async () => {
    await withTempDirectory(async (directory) => {
      const root = path.join(directory, "bounded-library");
      await mkdir(path.join(root, "node_modules"), { recursive: true });
      await mkdir(path.join(root, "build"), { recursive: true });
      await mkdir(root, { recursive: true });
      const oversized = `${JSON.stringify({ type: "book" })}${"x".repeat(1_048_576)}`;
      await writeFile(path.join(root, "oversized.json"), oversized, "utf8");
      await writeJson(path.join(root, ".hidden.json"), book());
      await writeJson(path.join(root, "node_modules", "ignored.json"), book());
      await writeJson(path.join(root, "build", "ignored.json"), book());

      const result = opened(await new LibraryService().openForOwner({}, root));
      expect(result.recordCount).toBe(0);
      expect(result.issueCount).toBeGreaterThanOrEqual(1);
    });
  });

  it("rejects a configured scope whose symlink escapes the selected root", async () => {
    await withTempDirectory(async (directory) => {
      const root = path.join(directory, "symlink-library");
      const outside = path.join(directory, "outside");
      await mkdir(root);
      await mkdir(outside);
      try {
        await symlink(outside, path.join(root, "books-link"), "junction");
      } catch (error: unknown) {
        const code = error !== null && typeof error === "object" && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
        if (code === "EPERM" || code === "EACCES" || code === "UNKNOWN") return;
        throw error;
      }
      await writeJson(path.join(root, "library.json"), {
        type: "library",
        version: "0.1",
        name: "Symlink escape",
        booksPath: "books-link",
      });

      expect(await new LibraryService().openForOwner({}, root)).toMatchObject({
        kind: "error",
        code: "invalid-library-config",
      });
    });
  });

  it("invalidates the previous owner snapshot and protects immutable records", async () => {
    await withTempDirectory(async (directory) => {
      const firstRoot = path.join(directory, "first");
      const secondRoot = path.join(directory, "second");
      await mkdir(firstRoot);
      await mkdir(secondRoot);
      await writeJson(path.join(firstRoot, "book.json"), book());
      await writeJson(path.join(firstRoot, "annotation.json"), annotation());
      await writeJson(path.join(secondRoot, "book.json"), book(SECOND_BOOK_ID, "Second"));
      await writeJson(path.join(secondRoot, "annotation.json"), annotation(SECOND_ANNOTATION_ID, SECOND_BOOK_ID, "second"));

      const service = new LibraryService();
      const owner = {};
      const first = opened(await service.openForOwner(owner, firstRoot));
      const second = opened(await service.openForOwner(owner, secondRoot));
      expect(second.library.libraryId).not.toBe(first.library.libraryId);
      expect(service.getRecordsForOwner(owner, first.library.libraryId)).toMatchObject({
        kind: "error",
        code: "library-not-owned",
      });
      expect(service.getRecordsForOwner({}, second.library.libraryId)).toMatchObject({
        kind: "error",
        code: "library-not-owned",
      });
      expect(service.getRecordsForOwner(owner, "../../guess")).toMatchObject({
        kind: "error",
        code: "invalid-library-id",
      });
      expect(service.getRecordsForOwner(owner, "00000000-0000-4000-8000-000000000000")).toMatchObject({
        kind: "error",
        code: "library-not-owned",
      });

      const firstRead = records(service.getRecordsForOwner(owner, second.library.libraryId));
      expect(Object.isFrozen(firstRead)).toBe(true);
      expect(Object.isFrozen(firstRead[0])).toBe(true);
      expect(Object.isFrozen(firstRead[0].authors)).toBe(true);
      try {
        (firstRead as LibraryRecord[]).push(firstRead[0]);
      } catch {
        // Object.freeze is expected to reject mutation in strict mode.
      }
      try {
        (firstRead[0] as unknown as { quote: string }).quote = "mutated";
      } catch {
        // Object.freeze is expected to reject mutation in strict mode.
      }
      try {
        (firstRead[0].authors as string[]).push("mutated");
      } catch {
        // Object.freeze is expected to reject mutation in strict mode.
      }
      const secondRead = records(service.getRecordsForOwner(owner, second.library.libraryId));
      expect(secondRead).toEqual(firstRead);
      expect(secondRead).not.toBe(firstRead);
    });
  });

  it("keeps an outside symlink from contributing records", async () => {
    await withTempDirectory(async (directory) => {
      const root = path.join(directory, "symlink-scan");
      const outside = path.join(directory, "outside-records");
      await mkdir(root);
      await mkdir(outside);
      try {
        await symlink(outside, path.join(root, "linked-records"), "junction");
      } catch (error: unknown) {
        const code = error !== null && typeof error === "object" && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
        if (code === "EPERM" || code === "EACCES" || code === "UNKNOWN") return;
        throw error;
      }
      await writeJson(path.join(outside, "book.json"), book());
      await writeJson(path.join(outside, "annotation.json"), annotation());

      const result = opened(await new LibraryService().openForOwner({}, root));
      expect(result.recordCount).toBe(0);
      expect(result.issueCount).toBeGreaterThanOrEqual(1);
    });
  });
});
