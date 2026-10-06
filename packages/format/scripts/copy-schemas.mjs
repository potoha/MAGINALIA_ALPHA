import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(packageRoot, "../../spec");
const target = resolve(packageRoot, "dist/schemas");
const schemaNames = [
  "common.schema.json",
  "project.schema.json",
  "library.schema.json",
  "book.schema.json",
  "annotation.schema.json",
  "note.schema.json",
  "source.schema.json",
  "publication.schema.json",
  "published-annotation.schema.json",
  "published-book.schema.json",
  "shelf-book.schema.json",
  "shelf-annotation.schema.json"
];

if (!existsSync(source)) throw new Error(`authoritative schema source is missing: ${source}`);
mkdirSync(target, { recursive: true });
for (const name of schemaNames) cpSync(resolve(source, name), resolve(target, name));
console.log(`copied ${schemaNames.length} authoritative Format schemas to dist/schemas`);
