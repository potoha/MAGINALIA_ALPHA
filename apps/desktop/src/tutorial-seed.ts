import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, realpath, unlink } from "node:fs/promises";
import * as path from "node:path";

type FormatCore = typeof import("@maginalia/format", { with: { "resolution-mode": "import" } });
let formatCorePromise: Promise<FormatCore> | undefined;

function loadFormatCore(): Promise<FormatCore> {
  formatCorePromise ??= import("@maginalia/format");
  return formatCorePromise;
}

export interface TutorialSeedConflict {
  readonly kind: "book" | "annotation";
  readonly id: string;
  readonly reason: "same-id-different-content" | "duplicate-id" | "missing-source-book";
}

export interface TutorialSeedResult {
  readonly booksAdded: number;
  readonly annotationsAdded: number;
  readonly conflicts: readonly TutorialSeedConflict[];
}

export class TutorialSeedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "TutorialSeedError";
  }
}

interface SeedManifest {
  readonly schemaVersion: number;
  readonly privateShelfSeed: string;
  readonly shelfPolicy: {
    readonly seedMode: string;
    readonly seedRecordVersion: string;
    readonly existingShelfMarker: string;
    readonly existingLibraryJson: string;
  };
}

interface EntityRecord {
  readonly id: string;
  readonly type: "book" | "annotation";
  readonly value: Record<string, unknown>;
  readonly text: string;
  readonly relativePath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeRelativePath(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value)) {
    throw new TutorialSeedError("The tutorial Shelf contains an unsafe collection path.");
  }
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || segment.includes(":"))) {
    throw new TutorialSeedError("The tutorial Shelf contains an unsafe collection path.");
  }
  return segments;
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value) ?? "undefined";
  const members = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`);
  return `{${members.join(",")}}`;
}

function entityIdentity(value: unknown, type: "book" | "annotation"): string | undefined {
  if (!isRecord(value) || value.type !== type || typeof value.id !== "string") return undefined;
  return value.id;
}

async function assertDirectory(root: string, create: boolean): Promise<string> {
  if (create) {
    try {
      await mkdir(root, { recursive: true });
    } catch {
      throw new TutorialSeedError("The Shelf record folder could not be prepared.");
    }
  }
  try {
    const stats = await lstat(root);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("unsafe");
    return await realpath(root);
  } catch {
    throw new TutorialSeedError("The Shelf record folder is unavailable or unsafe.");
  }
}

async function listRecordFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile() && /\.(?:json|ya?ml)$/iu.test(entry.name)) output.push(entryPath);
    }
  };
  await visit(root);
  return output;
}

async function readSeedEntities(
  seedRoot: string,
  collectionName: string,
  type: "book" | "annotation",
  allowedSources?: ReadonlySet<string>,
): Promise<EntityRecord[]> {
  const format = await loadFormatCore();
  const collectionSegments = safeRelativePath(collectionName);
  const collectionRoot = await assertDirectory(path.join(seedRoot, ...collectionSegments), false);
  const files = (await listRecordFiles(collectionRoot)).sort((left, right) => left.localeCompare(right));
  const records: EntityRecord[] = [];
  for (const filePath of files) {
    const text = await readFile(filePath, "utf8");
    const parsed = format.parseShelfEntity(type, text);
    if (!parsed.valid) {
      throw new TutorialSeedError(`A tutorial ${type} record is invalid: ${path.basename(filePath)}.`);
    }
    const value = parsed.value as unknown as Record<string, unknown>;
    if (value.version !== "0.1") {
      throw new TutorialSeedError("Tutorial seed records must retain Shelf v0.1 semantics.");
    }
    if (type === "annotation" && allowedSources && (typeof value.source !== "string" || !allowedSources.has(value.source))) {
      throw new TutorialSeedError("A tutorial quotation refers to a Book missing from the seed.");
    }
    const id = entityIdentity(value, type);
    if (!id) throw new TutorialSeedError(`A tutorial ${type} record has no valid identity.`);
    records.push({
      id,
      type,
      value,
      text,
      relativePath: path.relative(seedRoot, filePath).split(path.sep).join("/"),
    });
  }
  return records;
}

async function readExistingRecords(root: string, type: "book" | "annotation"): Promise<Map<string, EntityRecord[]>> {
  const byId = new Map<string, EntityRecord[]>();
  const files = await listRecordFiles(root);
  for (const filePath of files) {
    const text = await readFile(filePath, "utf8");
    let parsed: unknown;
    try {
      const format = await loadFormatCore();
      const result = format.parseShelfEntity(type, text);
      if (result.valid) parsed = result.value;
      else parsed = JSON.parse(text);
    } catch {
      try { parsed = JSON.parse(text); } catch { continue; }
    }
    const id = entityIdentity(parsed, type);
    if (!id) continue;
    const value = parsed as Record<string, unknown>;
    const existing = byId.get(id) ?? [];
    existing.push({
      id,
      type,
      value,
      text,
      relativePath: path.relative(path.dirname(root), filePath).split(path.sep).join("/"),
    });
    byId.set(id, existing);
  }
  return byId;
}

async function writeExclusive(directory: string, filename: string, text: string): Promise<boolean> {
  const destination = path.join(directory, filename);
  const temporary = path.join(directory, `.${filename}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, destination);
      return true;
    } catch (error) {
      const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code === "EEXIST") return false;
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function mergeCollection(
  shelfRoot: string,
  targetCollection: string,
  seedRecords: readonly EntityRecord[],
  type: "book" | "annotation",
  knownBooks?: ReadonlySet<string>,
): Promise<{ added: number; conflicts: TutorialSeedConflict[] }> {
  const segments = safeRelativePath(targetCollection);
  const collectionPath = path.join(shelfRoot, ...segments);
  const collectionRoot = await assertDirectory(collectionPath, true);
  const existingById = await readExistingRecords(collectionRoot, type);
  const addedIds = new Set<string>();
  const conflicts: TutorialSeedConflict[] = [];

  for (const seed of seedRecords) {
    if (type === "annotation" && knownBooks && (typeof seed.value.source !== "string" || !knownBooks.has(seed.value.source))) {
      conflicts.push(Object.freeze({ kind: "annotation", id: seed.id, reason: "missing-source-book" }));
      continue;
    }
    const existing = existingById.get(seed.id) ?? [];
    if (existing.length > 1) {
      conflicts.push(Object.freeze({ kind: type, id: seed.id, reason: "duplicate-id" }));
      continue;
    }
    if (existing.length === 1) {
      if (stableValue(existing[0]!.value) !== stableValue(seed.value)) {
        conflicts.push(Object.freeze({ kind: type, id: seed.id, reason: "same-id-different-content" }));
      }
      continue;
    }

    const targetFilename = path.basename(seed.relativePath);
    if (await writeExclusive(collectionRoot, targetFilename, seed.text)) {
      addedIds.add(seed.id);
      existingById.set(seed.id, [seed]);
      continue;
    }

    const collided = await readExistingRecords(collectionRoot, type);
    const afterCollision = collided.get(seed.id) ?? [];
    if (afterCollision.length === 1 && stableValue(afterCollision[0]!.value) === stableValue(seed.value)) continue;
    conflicts.push(Object.freeze({
      kind: type,
      id: seed.id,
      reason: afterCollision.length > 1 ? "duplicate-id" : "same-id-different-content",
    }));
  }
  return { added: addedIds.size, conflicts };
}

/**
 * Add the manifest's v0.1 tutorial records without replacing any Shelf file.
 * The marker and library.json are read only; only missing Book/Annotation files
 * are published by an exclusive link after a fully-written temporary file.
 */
export async function materializeTutorialShelfSeed(
  manifestPath: string,
  shelfRoot: string,
): Promise<TutorialSeedResult> {
  if (!path.isAbsolute(manifestPath) || !path.isAbsolute(shelfRoot)) {
    throw new TutorialSeedError("The tutorial Shelf location could not be verified.");
  }
  let manifest: SeedManifest;
  let canonicalSeedRoot: string;
  let canonicalShelfRoot: string;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as SeedManifest;
    if (manifest.schemaVersion !== 1 || manifest.shelfPolicy.seedMode !== "idempotent-non-destructive"
      || manifest.shelfPolicy.seedRecordVersion !== "0.1"
      || manifest.shelfPolicy.existingShelfMarker !== "preserve"
      || manifest.shelfPolicy.existingLibraryJson !== "preserve") throw new Error("manifest");
    const manifestDirectory = await realpath(path.dirname(manifestPath));
    canonicalSeedRoot = await realpath(path.join(manifestDirectory, ...safeRelativePath(manifest.privateShelfSeed)));
    canonicalShelfRoot = await realpath(shelfRoot);
  } catch {
    throw new TutorialSeedError("The tutorial Shelf resources or selected Shelf are unavailable.");
  }

  const libraryPath = path.join(canonicalShelfRoot, "library.json");
  const seedLibraryPath = path.join(canonicalSeedRoot, "library.json");
  let existingLibrary: Record<string, unknown>;
  let seedLibrary: Record<string, unknown>;
  const format = await loadFormatCore();
  try {
    const existingText = await readFile(libraryPath, "utf8");
    const seedText = await readFile(seedLibraryPath, "utf8");
    const existingParsed = format.parseAndValidate("library", existingText);
    const seedParsed = format.parseAndValidate("library", seedText);
    if (!existingParsed.valid || !seedParsed.valid) throw new Error("library");
    existingLibrary = existingParsed.value as unknown as Record<string, unknown>;
    seedLibrary = seedParsed.value as unknown as Record<string, unknown>;
  } catch {
    throw new TutorialSeedError("The selected Shelf records could not be read. Existing files were left unchanged.");
  }

  const booksPath = typeof existingLibrary.booksPath === "string" ? existingLibrary.booksPath : "books";
  const annotationsPath = typeof existingLibrary.annotationsPath === "string" ? existingLibrary.annotationsPath : "annotations";
  const seedBooksPath = typeof seedLibrary.booksPath === "string" ? seedLibrary.booksPath : "books";
  const seedAnnotationsPath = typeof seedLibrary.annotationsPath === "string" ? seedLibrary.annotationsPath : "annotations";
  const seedBooks = await readSeedEntities(canonicalSeedRoot, seedBooksPath, "book");
  const sourceBookIds = new Set(seedBooks.map((book) => book.id));
  const seedAnnotations = await readSeedEntities(canonicalSeedRoot, seedAnnotationsPath, "annotation", sourceBookIds);

  const books = await mergeCollection(canonicalShelfRoot, booksPath, seedBooks, "book");
  const booksDirectory = await assertDirectory(path.join(canonicalShelfRoot, ...safeRelativePath(booksPath)), false);
  const existingBooks = await readExistingRecords(booksDirectory, "book");
  const usableBookIds = new Set<string>();
  for (const seedBook of seedBooks) {
    const existing = existingBooks.get(seedBook.id) ?? [];
    if (existing.length === 1 && stableValue(existing[0]!.value) === stableValue(seedBook.value)) usableBookIds.add(seedBook.id);
  }
  const annotations = await mergeCollection(canonicalShelfRoot, annotationsPath, seedAnnotations, "annotation", usableBookIds);
  return Object.freeze({
    booksAdded: books.added,
    annotationsAdded: annotations.added,
    conflicts: Object.freeze([...books.conflicts, ...annotations.conflicts]),
  });
}
