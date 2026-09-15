import Ajv2020Module, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { readFileSync } from "node:fs";
import { ulid } from "ulid";
import { parseDocument } from "yaml";

export const FORMAT_VERSION = "0.1" as const;

export const EntityKind = {
  Project: "project",
  Library: "library",
  Book: "book",
  Annotation: "annotation",
  Note: "note",
  Source: "source",
  Publication: "publication",
  PublishedAnnotation: "published-annotation",
  PublishedBook: "published-book"
} as const;

export type EntityKind = (typeof EntityKind)[keyof typeof EntityKind];
export type EntityIdPrefix = "ann" | "pub" | "project" | "note" | "capture";

export interface Project {
  type: "project";
  version: "0.1";
  id: `project:${string}`;
  title: string;
  description?: string;
  visibility?: "private" | "public";
  readme?: string;
}

export interface Library {
  type: "library";
  version: "0.1";
  name: string;
  booksPath?: string;
  annotationsPath?: string;
}

export interface Book {
  type: "book";
  version: "0.1";
  id: `isbn:${string}`;
  title: string;
  authors: string[];
  isbn13: string;
  publisher?: string;
  year?: number;
  coverImage?: string;
}

export interface Annotation {
  type: "annotation";
  version: "0.1";
  id: `ann:${string}`;
  source: `isbn:${string}`;
  location: { page?: number; path?: string };
  quote: string;
  comment?: string;
  attribution?: string;
  captureImage?: string;
  rawOcr?: string;
  localPath?: string;
  deviceMetadata?: Record<string, unknown>;
  privateMemo?: string;
  unpublishedComments?: string[];
}

export interface Note {
  type: "note";
  version: "0.1";
  id: `note:${string}`;
  title: string;
  path: string;
}

export interface Source {
  type: "source";
  version: "0.1";
  id: `source:${string}`;
  kind: "book" | "paper" | "web";
  title: string;
  path?: string;
  url?: string;
}

export interface Publication {
  type: "publication";
  version: "0.1";
  id: `pub:${string}`;
  title: string;
  source: { repository: string; output: string };
  publishedAt: string;
  url?: string;
  annotations?: `ann:${string}`[];
  sources?: `isbn:${string}`[];
}

export interface PublishedAnnotation {
  type: "published-annotation";
  version: "0.1";
  id: `ann:${string}`;
  source: `isbn:${string}`;
  location: { page?: number; path?: string };
  quote: string;
  comment?: string;
  attribution?: string;
}

export interface PublishedBook {
  type: "published-book";
  version: "0.1";
  id: `isbn:${string}`;
  title: string;
  authors: string[];
  isbn13: string;
  publisher?: string;
  year?: number;
}

export type Entity =
  | Project
  | Library
  | Book
  | Annotation
  | Note
  | Source
  | Publication
  | PublishedAnnotation
  | PublishedBook;

export type EntityForKind<K extends EntityKind> = Extract<Entity, { type: K }>;
export type ValidationResult<T = unknown> =
  | { valid: true; value: T }
  | { valid: false; errors: readonly string[] };

// Ajv v8's CommonJS runtime and ESM declarations disagree under NodeNext. These
// narrow casts retain static ESM imports, so the standalone package and bundles
// include Ajv instead of resolving it from a host node_modules directory.
const Ajv2020 = Ajv2020Module as unknown as new (options: object) => {
  addSchema(schema: object): unknown;
  getSchema(key: string): ValidateFunction | undefined;
};
const addFormats = addFormatsModule as unknown as (instance: unknown) => void;

const schemaFiles: Record<EntityKind, string> = {
  project: "project.schema.json",
  library: "library.schema.json",
  book: "book.schema.json",
  annotation: "annotation.schema.json",
  note: "note.schema.json",
  source: "source.schema.json",
  publication: "publication.schema.json",
  "published-annotation": "published-annotation.schema.json",
  "published-book": "published-book.schema.json"
};

// Schemas are copied from the authoritative repository spec during build. The
// artifact-relative lookup is used first so the packed package stays self-contained;
// the source-tree fallback keeps clean source tests independent of a prior build.
const specDirectory = new URL("./schemas/", import.meta.url);
const sourceSpecDirectory = new URL("../../../spec/", import.meta.url);
const readSchema = (file: string): object => {
  try {
    return JSON.parse(readFileSync(new URL(file, specDirectory), "utf8"));
  } catch (error: unknown) {
    if (error === null || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
    return JSON.parse(readFileSync(new URL(file, sourceSpecDirectory), "utf8"));
  }
};
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addSchema(readSchema("common.schema.json"));
for (const file of Object.values(schemaFiles)) ajv.addSchema(readSchema(file));
const validators = Object.fromEntries(
  Object.entries(schemaFiles).map(([kind, file]) => [kind, ajv.getSchema(`https://maginalia.app/spec/${file}`)!])
) as Record<EntityKind, ValidateFunction>;

function errorsFor(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`);
}

export function generateEntityId(prefix: EntityIdPrefix): `${EntityIdPrefix}:${string}` {
  return `${prefix}:${ulid()}`;
}

export function validateEntity<K extends EntityKind>(
  kind: K,
  value: unknown
): ValidationResult<EntityForKind<K>> {
  const validator = validators[kind];
  if (!validator(value)) return { valid: false, errors: errorsFor(validator.errors) };
  return { valid: true, value: value as EntityForKind<K> };
}

export function assertValidEntity<K extends EntityKind>(kind: K, value: unknown): EntityForKind<K> {
  const result = validateEntity(kind, value);
  if (!result.valid) throw new Error(`Invalid ${kind} entity: ${result.errors.join("; ")}`);
  return result.value;
}

export function parseAndValidate<K extends EntityKind>(
  kind: K,
  yamlText: string
): ValidationResult<EntityForKind<K>> {
  const document = parseDocument(yamlText, { prettyErrors: false });
  if (document.errors.length > 0) return { valid: false, errors: document.errors.map((error) => error.message) };
  return validateEntity(kind, document.toJS());
}

/** Publication boundaries are explicit allowlists, never object spreads. */
export function toPublishedAnnotation(annotation: Annotation): PublishedAnnotation {
  const output: PublishedAnnotation = {
    type: "published-annotation",
    version: FORMAT_VERSION,
    id: annotation.id,
    source: annotation.source,
    location: annotation.location,
    quote: annotation.quote
  };
  if (annotation.comment !== undefined) output.comment = annotation.comment;
  if (annotation.attribution !== undefined) output.attribution = annotation.attribution;
  return output;
}

export function toPublishedBook(book: Book): PublishedBook {
  const output: PublishedBook = {
    type: "published-book",
    version: FORMAT_VERSION,
    id: book.id,
    title: book.title,
    authors: [...book.authors],
    isbn13: book.isbn13
  };
  if (book.publisher !== undefined) output.publisher = book.publisher;
  if (book.year !== undefined) output.year = book.year;
  return assertValidEntity("published-book", output);
}
