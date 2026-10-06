import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateShelfEntity } from "@maginalia/format";
import { materializeReviewerRecords } from "./reviewer-shelf-materializer";

const ISBN = "9780306406157";
const PACKAGE_ID = "capkg:01ARZ3NDEKTSV4RRFFQ69G5FAV";
const LOOKUP = async () => ({ status: "not-found" });
let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});

async function shelfRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "maginalia-shelf-v04-日本語-"));
  roots.push(root);
  await writeFile(path.join(root, "library.json"), JSON.stringify({
    type: "library", version: "0.1", name: "私有棚", booksPath: "books", annotationsPath: "annotations"
  }), "utf8");
  return root;
}

function approved(annotationId: string, packageId: string, quote: string) {
  return {
    annotationId,
    reviewState: "APPROVED" as const,
    packageId,
    sourceKind: "book" as const,
    getDate: "202602011230",
    isbn13: ISBN,
    title: "日本語の書名",
    authors: ["著者名"],
    publisher: "出版社",
    year: 2024,
    quote,
    pageLabel: "12",
    comment: "Reviewer comment"
  };
}

async function entityFiles(directory: string): Promise<Record<string, unknown>[]> {
  return Promise.all((await readdir(directory)).filter((name) => name.endsWith(".json")).map(async (name) =>
    JSON.parse(await readFile(path.join(directory, name), "utf8")) as Record<string, unknown>));
}

describe("Shelf v0.4 Reviewer materializer", () => {
  it("writes current records once, reuses one Book for another quote, and rejects changed alias content", async () => {
    const root = await shelfRoot();
    const first = approved("123e4567-e89b-42d3-a456-426614174000", PACKAGE_ID, "日本語の引用一");
    const second = approved("123e4567-e89b-42d3-a456-426614174001", "capkg:01ARZ3NDEKTSV4RRFFQ69G5FAW", "日本語の引用二");
    expect(await materializeReviewerRecords(root, [first], LOOKUP)).toMatchObject({ materialized: 1, unchanged: 0, conflicts: 0, pending: [] });
    expect(await materializeReviewerRecords(root, [second], LOOKUP)).toMatchObject({ materialized: 1, unchanged: 0, conflicts: 0, pending: [] });
    expect(await materializeReviewerRecords(root, [first], LOOKUP)).toMatchObject({ materialized: 0, unchanged: 1, conflicts: 0, pending: [] });
    expect(await materializeReviewerRecords(root, [{ ...first, quote: "書き換えた引用" }], LOOKUP))
      .toMatchObject({ materialized: 0, unchanged: 0, conflicts: 1, pending: [] });

    const books = await entityFiles(path.join(root, "books"));
    const annotations = await entityFiles(path.join(root, "annotations"));
    expect(books).toHaveLength(1);
    expect(annotations).toHaveLength(2);
    expect(books[0]).toMatchObject({
      version: "0.4", source: { kind: "book" }, get: { date: "202602011230" }, isbn13: ISBN,
      title: "日本語の書名", authors: ["著者名"]
    });
    expect(annotations.map((annotation) => annotation.id).every((id) => typeof id === "string" && id.startsWith("ann:"))).toBe(true);
    for (const annotation of annotations) expect(validateShelfEntity("annotation", annotation).valid).toBe(true);
  });

  it("stores verified canonical Handwritten bytes under portable Shelf paths", async () => {
    const root = await shelfRoot();
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0x10, 0x20, 0x30]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const record = {
      annotationId: "123e4567-e89b-42d3-a456-426614174002",
      reviewState: "APPROVED" as const,
      packageId: "capkg:01ARZ3NDEKTSV4RRFFQ69G5FAY",
      sourceKind: "Handwritten" as const,
      getDate: "202603021415",
      isbn13: null,
      url: null,
      title: "手書き資料",
      authors: [],
      quote: "筆記された引用",
      pageLabel: "3",
      comment: "原資料の記録",
      sourceFiles: [{ path: "images/手書き資料.jpg", mediaType: "image/jpeg" as const, sha256, originalName: "手書き資料.jpg", bytes }]
    };
    const result = await materializeReviewerRecords(root, [record], LOOKUP);
    expect(result).toMatchObject({ materialized: 1, pending: [], conflicts: 0 });
    const [book] = await entityFiles(path.join(root, "books"));
    const [annotation] = await entityFiles(path.join(root, "annotations"));
    expect(book).toMatchObject({ version: "0.4", source: { kind: "Handwritten", files: [{ mediaType: "image/jpeg", sha256 }] } });
    expect(annotation).toMatchObject({ version: "0.4", get: { date: "202603021415" }, source: { kind: "Handwritten", files: [{ sha256 }] } });
    const shelfFile = (book.source as { files: { path: string }[] }).files[0]!.path;
    expect(shelfFile).toContain("sources/");
    expect(shelfFile).toContain("手書き資料.jpg");
    expect(await readFile(path.join(root, ...shelfFile.split("/")))).toEqual(Buffer.from(bytes));
    expect(validateShelfEntity("book", book).valid).toBe(true);
    expect(validateShelfEntity("annotation", annotation).valid).toBe(true);
  });

  it("recognizes an unchanged legacy v0.1 Reviewer alias without creating a v0.4 duplicate", async () => {
    const root = await shelfRoot();
    const annotationId = "123e4567-e89b-42d3-a456-426614174004";
    const record = {
      annotationId, reviewState: "APPROVED" as const, isbn13: ISBN,
      quote: "既存引用", pageLabel: "8", comment: "旧メモ"
    };
    const canonical = JSON.stringify({
      annotationId,
      comment: record.comment,
      isbn13: ISBN,
      pageLabel: record.pageLabel,
      quote: record.quote,
      reviewState: "APPROVED"
    });
    const legacyDigest = `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
    await mkdir(path.join(root, "books"), { recursive: true });
    await mkdir(path.join(root, "annotations"), { recursive: true });
    await writeFile(path.join(root, "books", "legacy.json"), JSON.stringify({
      type: "book", version: "0.1", id: `isbn:${ISBN}`, isbn13: ISBN, title: "既存書", authors: ["著者"]
    }), "utf8");
    const legacyAnnotation = {
      type: "annotation", version: "0.1", id: "ann:01J0A1B2C3D4E5F6G7H8J9K0M1",
      source: `isbn:${ISBN}`, location: { page: 8 }, quote: "既存引用", privateMemo: "旧メモ",
      deviceMetadata: { maginaliaReviewer: { version: 1, annotationId, digest: legacyDigest } }
    };
    await writeFile(path.join(root, "annotations", "legacy.json"), JSON.stringify(legacyAnnotation), "utf8");
    const result = await materializeReviewerRecords(root, [record], LOOKUP);
    expect(result).toMatchObject({ materialized: 0, unchanged: 1, conflicts: 0, pending: [] });
    expect(await readdir(path.join(root, "books"))).toEqual(["legacy.json"]);
    expect(await readdir(path.join(root, "annotations"))).toEqual(["legacy.json"]);
  });

  it("leaves legacy Books unchanged while writing new Reviewer data with a v0.4 Book", async () => {
    const root = await shelfRoot();
    const booksDirectory = path.join(root, "books");
    await mkdir(booksDirectory, { recursive: true });
    const legacyBook = path.join(booksDirectory, "legacy.json");
    const legacyText = JSON.stringify({
      type: "book", version: "0.1", id: `isbn:${ISBN}`, isbn13: ISBN, title: "既存の旧形式書籍", authors: ["旧著者"]
    });
    await writeFile(legacyBook, legacyText, "utf8");

    const result = await materializeReviewerRecords(root, [approved(
      "123e4567-e89b-42d3-a456-426614174005", PACKAGE_ID, "新しい引用"
    )], LOOKUP);

    expect(result).toMatchObject({ materialized: 1, unchanged: 0, conflicts: 0, pending: [] });
    expect(await readFile(legacyBook, "utf8")).toBe(legacyText);
    const books = await entityFiles(booksDirectory);
    expect(books).toHaveLength(2);
    expect(books.some((book) => book.version === "0.4" && book.isbn13 === ISBN)).toBe(true);
  });

  it("does not write outside configured Shelf directories", async () => {
    const root = await shelfRoot();
    await mkdir(path.join(root, "outside"));
    await writeFile(path.join(root, "library.json"), JSON.stringify({
      type: "library", version: "0.1", name: "Private", booksPath: "../outside", annotationsPath: "annotations"
    }), "utf8");
    await expect(materializeReviewerRecords(root, [approved("123e4567-e89b-42d3-a456-426614174003", PACKAGE_ID, "quote")], LOOKUP))
      .rejects.toThrow("paths are invalid");
    expect(await readdir(path.join(root, "outside"))).toEqual([]);
  });
});
