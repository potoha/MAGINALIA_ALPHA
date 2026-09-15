import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { readFileSync } from "node:fs";
import { ulid } from "ulid";
import { parseDocument } from "yaml";
export const FORMAT_VERSION = "0.1";
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
};
// Ajv v8's CommonJS runtime and ESM declarations disagree under NodeNext. These
// narrow casts retain static ESM imports, so the standalone package and bundles
// include Ajv instead of resolving it from a host node_modules directory.
const Ajv2020 = Ajv2020Module;
const addFormats = addFormatsModule;
const schemaFiles = {
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
const readSchema = (file) => {
    try {
        return JSON.parse(readFileSync(new URL(file, specDirectory), "utf8"));
    }
    catch (error) {
        if (error === null || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT")
            throw error;
        return JSON.parse(readFileSync(new URL(file, sourceSpecDirectory), "utf8"));
    }
};
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addSchema(readSchema("common.schema.json"));
for (const file of Object.values(schemaFiles))
    ajv.addSchema(readSchema(file));
const validators = Object.fromEntries(Object.entries(schemaFiles).map(([kind, file]) => [kind, ajv.getSchema(`https://maginalia.app/spec/${file}`)]));
function errorsFor(errors) {
    return (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`);
}
export function generateEntityId(prefix) {
    return `${prefix}:${ulid()}`;
}
export function validateEntity(kind, value) {
    const validator = validators[kind];
    if (!validator(value))
        return { valid: false, errors: errorsFor(validator.errors) };
    return { valid: true, value: value };
}
export function assertValidEntity(kind, value) {
    const result = validateEntity(kind, value);
    if (!result.valid)
        throw new Error(`Invalid ${kind} entity: ${result.errors.join("; ")}`);
    return result.value;
}
export function parseAndValidate(kind, yamlText) {
    const document = parseDocument(yamlText, { prettyErrors: false });
    if (document.errors.length > 0)
        return { valid: false, errors: document.errors.map((error) => error.message) };
    return validateEntity(kind, document.toJS());
}
/** Publication boundaries are explicit allowlists, never object spreads. */
export function toPublishedAnnotation(annotation) {
    const output = {
        type: "published-annotation",
        version: FORMAT_VERSION,
        id: annotation.id,
        source: annotation.source,
        location: annotation.location,
        quote: annotation.quote
    };
    if (annotation.comment !== undefined)
        output.comment = annotation.comment;
    if (annotation.attribution !== undefined)
        output.attribution = annotation.attribution;
    return output;
}
export function toPublishedBook(book) {
    const output = {
        type: "published-book",
        version: FORMAT_VERSION,
        id: book.id,
        title: book.title,
        authors: [...book.authors],
        isbn13: book.isbn13
    };
    if (book.publisher !== undefined)
        output.publisher = book.publisher;
    if (book.year !== undefined)
        output.year = book.year;
    return assertValidEntity("published-book", output);
}
