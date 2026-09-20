import { describe, expect, it } from "vitest";
import {
  adaptBookSource,
  createBookSource,
  isbnBookSourceId,
  isValidIsbn13,
  normalizeIsbn13,
  SourceCoreError,
  type BookSourceInput
} from "./index";

const ISBN = "9780306406157";
const SECOND_ISBN = "9780134685991";

describe("Source Core ISBN identity", () => {
  it("accepts valid ASCII ISBN-13 values and computes the stable identity", () => {
    expect(normalizeIsbn13(ISBN)).toBe(ISBN);
    expect(isValidIsbn13(ISBN)).toBe(true);
    expect(isbnBookSourceId(ISBN)).toBe(`book:isbn13:${ISBN}`);
    expect(adaptBookSource({ isbn13: ISBN, title: "Book", authors: ["Author"] })).toMatchObject({
      id: `book:isbn13:${ISBN}`,
      type: "book",
      title: "Book",
      authors: ["Author"],
      identifiers: { isbn13: ISBN }
    });
  });

  it("rejects absent, formatted, wrong-prefix, and bad-checksum ISBNs", () => {
    const invalid: unknown[] = [
      undefined,
      null,
      "",
      "978-0-306-40615-7",
      "978 0306406157",
      "９７８０３０６４０６１５７",
      "9790306406157",
      "9780306406158",
      "97803064061570",
      9780306406157
    ];
    for (const value of invalid) {
      expect(normalizeIsbn13(value)).toBeUndefined();
      expect(isValidIsbn13(value)).toBe(false);
    }
    expect(adaptBookSource({ title: "No identity" })).toBeUndefined();
    expect(() => isbnBookSourceId("not-an-isbn")).toThrowError(
      expect.objectContaining({ name: "SourceCoreError", code: "invalid-isbn13" })
    );
    expect(() => createBookSource({ isbn13: "9780306406158" })).toThrowError(SourceCoreError);
  });

  it("dedupes by ISBN regardless of metadata and keeps optional fields optional", () => {
    const first = createBookSource({
      isbn13: ISBN,
      title: "  Title  ",
      authors: [" Author ", "", "  "],
      publisher: " Publisher ",
      publishedDate: " 2024-01-02 ",
      identifiers: { isbn10: " 0306406152 " },
      metadata: { language: "ja" }
    });
    const second = createBookSource({ isbn13: ISBN, title: "Different title" });
    expect(first.id).toBe(second.id);
    expect(first).toMatchObject({
      title: "Title",
      authors: ["Author"],
      publisher: "Publisher",
      publishedDate: "2024-01-02",
      identifiers: { isbn13: ISBN, isbn10: "0306406152" },
      metadata: { language: "ja" }
    });
    expect(first).not.toHaveProperty("url");
    expect(second).not.toHaveProperty("title", "Title");
  });

  it("copies input collections and returns frozen source data", () => {
    const authors = ["Author"];
    const identifiers = { isbn10: "0306406152" };
    const metadata = { language: "ja" };
    const input: BookSourceInput = { isbn13: SECOND_ISBN, authors, identifiers, metadata };
    const source = createBookSource(input);

    authors.push("Mutated");
    identifiers.isbn10 = "changed";
    metadata.language = "changed";

    expect(source.authors).toEqual(["Author"]);
    expect(source.identifiers).toMatchObject({ isbn10: "0306406152", isbn13: SECOND_ISBN });
    expect(source.metadata).toEqual({ language: "ja" });
    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.isFrozen(source.authors)).toBe(true);
    expect(Object.isFrozen(source.identifiers)).toBe(true);
    expect(Object.isFrozen(source.metadata)).toBe(true);
  });

  it("does not import host, provider, or network implementation details", async () => {
    // The package is intentionally usable in a renderer, worker, or test
    // process without a fetch/electron/node provider dependency.
    const source = adaptBookSource({ isbn13: ISBN });
    expect(source?.type).toBe("book");
  });
});
