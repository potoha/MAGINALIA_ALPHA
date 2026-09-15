import { describe, expect, it } from "vitest";
import {
  EntityKind,
  FORMAT_VERSION,
  generateEntityId,
  parseAndValidate,
  toPublishedAnnotation,
  toPublishedBook,
  validateEntity,
  type Annotation,
  type Book
} from "../index";

const ulid = "01J0A1B2C3D4E5F6G7H8J9K0M1";

const book: Book = {
  type: "book",
  version: FORMAT_VERSION,
  id: "isbn:9781234567890",
  title: "Book",
  authors: ["Author"],
  isbn13: "9781234567890",
  publisher: "Publisher",
  year: 2026,
  coverImage: "covers/book.png"
};

const annotation: Annotation = {
  type: "annotation",
  version: FORMAT_VERSION,
  id: `ann:${ulid}`,
  source: "isbn:9781234567890",
  location: { page: 1 },
  quote: "引用",
  comment: "Comment",
  attribution: "Author",
  captureImage: "captures/page.png",
  rawOcr: "OCR",
  localPath: "private/source.png",
  deviceMetadata: { device: "test" },
  privateMemo: "private",
  unpublishedComments: ["unpublished"]
};

const validEntities: Record<EntityKind, unknown> = {
  project: { type: "project", version: FORMAT_VERSION, id: `project:${ulid}`, title: "Project" },
  library: { type: "library", version: FORMAT_VERSION, name: "Personal" },
  book,
  annotation,
  note: { type: "note", version: FORMAT_VERSION, id: `note:${ulid}`, title: "Note", path: "notes/one.md" },
  source: { type: "source", version: FORMAT_VERSION, id: `source:${ulid}`, kind: "web", title: "Website", url: "https://example.test" },
  publication: {
    type: "publication",
    version: FORMAT_VERSION,
    id: `pub:${ulid}`,
    title: "Publication",
    source: { repository: "owner/repository", output: "outputs/article.md" },
    publishedAt: "2026-08-12"
  },
  "published-annotation": {
    type: "published-annotation",
    version: FORMAT_VERSION,
    id: `ann:${ulid}`,
    source: "isbn:9781234567890",
    location: { page: 1 },
    quote: "引用"
  },
  "published-book": {
    type: "published-book",
    version: FORMAT_VERSION,
    id: "isbn:9781234567890",
    title: "Book",
    authors: ["Author"],
    isbn13: "9781234567890"
  }
};

describe("MAGINALIA Format v0.1", () => {
  it.each(Object.values(EntityKind))("validates the %s entity fixture", (kind) => {
    expect(validateEntity(kind, validEntities[kind])).toMatchObject({ valid: true });
  });

  it("parses and validates YAML and JSON Library/Book/Annotation data", () => {
    const yamlBook = [
      "type: book",
      "version: '0.1'",
      "id: 'isbn:9781234567890'",
      "title: Book",
      "authors: [Author]",
      "isbn13: '9781234567890'"
    ].join("\n");
    expect(parseAndValidate("book", yamlBook)).toMatchObject({ valid: true });
    expect(parseAndValidate("book", JSON.stringify(book))).toMatchObject({ valid: true });
    expect(parseAndValidate("library", JSON.stringify(validEntities.library))).toMatchObject({ valid: true });
    expect(parseAndValidate("annotation", JSON.stringify(annotation))).toMatchObject({ valid: true });
  });

  it("rejects invalid entities and unknown additional properties", () => {
    expect(validateEntity("book", { ...book, isbn13: "not-an-isbn" })).toMatchObject({ valid: false });
    expect(validateEntity("library", { ...validEntities.library as object, privateField: "no" })).toMatchObject({ valid: false });
    expect(validateEntity("published-annotation", {
      ...validEntities["published-annotation"] as object,
      rawOcr: "private"
    })).toMatchObject({ valid: false });
  });

  it("returns actionable validation errors and rejects malformed YAML", () => {
    const invalid = validateEntity("library", { type: "library", version: "9.9", name: "" });
    expect(invalid.valid).toBe(false);
    if (!invalid.valid) expect(invalid.errors.length).toBeGreaterThan(0);
    expect(parseAndValidate("book", "type: [broken")).toMatchObject({ valid: false });
  });

  it("generates uppercase Crockford ULID entity IDs", () => {
    expect(generateEntityId("ann")).toMatch(/^ann:[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  });

  it("projects Annotation and Book through explicit publication allowlists", () => {
    const publishedAnnotation = toPublishedAnnotation(annotation);
    expect(publishedAnnotation).toEqual({
      type: "published-annotation",
      version: FORMAT_VERSION,
      id: annotation.id,
      source: annotation.source,
      location: annotation.location,
      quote: annotation.quote,
      comment: annotation.comment,
      attribution: annotation.attribution
    });
    for (const privateField of [
      "captureImage",
      "captureressoImage",
      "rawOcr",
      "localPath",
      "deviceMetadata",
      "privateMemo",
      "unpublishedComments"
    ]) {
      expect(privateField in publishedAnnotation).toBe(false);
    }
    expect(validateEntity("published-annotation", publishedAnnotation)).toMatchObject({ valid: true });

    const publishedBook = toPublishedBook(book);
    expect(publishedBook).toEqual({
      type: "published-book",
      version: FORMAT_VERSION,
      id: book.id,
      title: book.title,
      authors: book.authors,
      isbn13: book.isbn13,
      publisher: book.publisher,
      year: book.year
    });
    expect("coverImage" in publishedBook).toBe(false);
    expect(validateEntity("published-book", publishedBook)).toMatchObject({ valid: true });
  });
});
