/** Main-process-only, conflict-safe Reviewer -> Private Shelf v0.4 writer. */
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type {
  ShelfAnnotation,
  ShelfAnnotationV04,
  ShelfBook,
  ShelfBookV04,
  ShelfSourceFileV04
} from "@maginalia/format" with { "resolution-mode": "import" };
import {
  createReviewerReconciliationCandidate,
  materializeReviewerReconciliationCandidate,
  REVIEWER_SHELF_PROVENANCE_VERSION,
  type ApprovedReviewerRecord,
  type OpenBdBookMetadata,
  type ReviewerReconciliationCandidate,
  type ReviewerReconciliationPending
} from "./reviewer-shelf-reconciliation";

type FormatCore = typeof import("@maginalia/format", { with: { "resolution-mode": "import" } });
let formatCorePromise: Promise<FormatCore> | undefined;
function loadFormatCore(): Promise<FormatCore> {
  formatCorePromise ??= import("@maginalia/format");
  return formatCorePromise;
}

export interface ReviewerShelfMetadataLookup {
  (isbn13: string): Promise<
    | { readonly status: "ok"; readonly metadata: OpenBdBookMetadata }
    | { readonly status: string }
  >;
}

export interface MaterializationResult {
  readonly materialized: number;
  readonly unchanged: number;
  readonly pending: readonly ReviewerReconciliationPending[];
  readonly conflicts: number;
}

interface AliasEntry {
  readonly digest: string;
  readonly version?: number;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function safeConfiguredDirectory(root: string, value: unknown, fallback: string): string | null {
  const part = typeof value === "string" ? value : fallback;
  if (part.length === 0 || part.includes("\0") || path.isAbsolute(part)
    || /^[A-Za-z]:/u.test(part) || /^(?:[\\/]{1,2})/u.test(part)
    || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(part)) return null;
  const resolved = path.resolve(root, part);
  return inside(root, resolved) ? resolved : null;
}

function isMissingFile(error: unknown): boolean {
  return error !== null && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT";
}

function isExists(error: unknown): boolean {
  return error !== null && typeof error === "object" && (error as { code?: unknown }).code === "EEXIST";
}

function safeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function ensureDirectory(root: string, directory: string): Promise<boolean> {
  if (!inside(root, directory)) return false;
  const relative = path.relative(root, directory);
  let current = root;
  for (const segment of relative === "" ? [] : relative.split(path.sep)) {
    current = path.join(current, segment);
    try { await mkdir(current); } catch (error: unknown) { if (!isExists(error)) return false; }
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) return false;
      const canonical = await realpath(current);
      if (!inside(root, canonical)) return false;
    } catch { return false; }
  }
  return true;
}

async function writeNoReplace(target: string, contents: Uint8Array): Promise<"written" | "same" | "conflict"> {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { flag: "wx" });
    try {
      await link(temporary, target);
      return "written";
    } catch (error: unknown) {
      if (!isExists(error)) throw error;
      try {
        const info = await lstat(target);
        if (!info.isFile() || info.isSymbolicLink()) return "conflict";
        const current = await readFile(target);
        return Buffer.from(current).equals(Buffer.from(contents)) ? "same" : "conflict";
      } catch { return "conflict"; }
    }
  } finally {
    try { await unlink(temporary); } catch { /* The link is already removed or moved. */ }
  }
}

async function listShelfFiles(root: string, directory: string): Promise<string[]> {
  const output: string[] = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { continue; }
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      try {
        const info = await lstat(candidate);
        if (info.isSymbolicLink()) continue;
        const canonical = await realpath(candidate);
        if (!inside(root, canonical)) continue;
        if (info.isDirectory()) pending.push(candidate);
        else if (info.isFile() && [".json", ".yaml", ".yml"].includes(path.extname(entry.name).toLowerCase())) output.push(candidate);
      } catch { /* Malformed/unreadable Shelf entries remain untouched. */ }
    }
  }
  return output;
}

function reviewerAlias(annotation: ShelfAnnotation): { readonly annotationId: string; readonly digest: string; readonly version?: number } | undefined {
  const metadata = annotation.deviceMetadata;
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const provenance = (metadata as Record<string, unknown>).maginaliaReviewer;
  if (provenance === null || typeof provenance !== "object" || Array.isArray(provenance)) return undefined;
  const value = provenance as Record<string, unknown>;
  return typeof value.annotationId === "string" && typeof value.digest === "string"
    ? { annotationId: value.annotationId, digest: value.digest, ...(typeof value.version === "number" ? { version: value.version } : {}) }
    : undefined;
}

async function existingAliases(directory: string, format: FormatCore): Promise<Map<string, AliasEntry[]>> {
  const aliases = new Map<string, AliasEntry[]>();
  for (const filename of await listShelfFiles(directory, directory)) {
    try {
      const validated = format.parseShelfEntity("annotation", await readFile(filename, "utf8"));
      if (!validated.valid) continue;
      const alias = reviewerAlias(validated.value);
      if (!alias) continue;
      const matches = aliases.get(alias.annotationId) ?? [];
      matches.push({ digest: alias.digest, version: alias.version });
      aliases.set(alias.annotationId, matches);
    } catch { /* Invalid user data is never adopted or rewritten. */ }
  }
  return aliases;
}

async function existingBooks(directory: string, format: FormatCore): Promise<ShelfBookV04[]> {
  const books: ShelfBookV04[] = [];
  for (const filename of await listShelfFiles(directory, directory)) {
    try {
      const validated = format.parseShelfEntity("book", await readFile(filename, "utf8"));
      if (validated.valid && validated.value.version === "0.4") books.push(validated.value);
    } catch { /* Unknown or malformed files remain untouched. */ }
  }
  return books;
}

function fileDigests(book: ShelfBookV04): readonly string[] {
  return Object.freeze((book.source.files ?? []).map((file) => `${file.mediaType}:${file.sha256}`).sort());
}

function hasLocatorOverlap(candidate: ReviewerReconciliationCandidate, book: ShelfBookV04): boolean {
  if (candidate.isbn13 !== undefined && candidate.isbn13 === book.isbn13) return true;
  if (candidate.url !== undefined && candidate.url === book.url) return true;
  const existingHashes = new Set(fileDigests(book));
  return candidate.sourceFiles.some((file) => existingHashes.has(`${file.mediaType}:${file.sha256}`));
}

function booksAreCompatible(candidate: ReviewerReconciliationCandidate, book: ShelfBookV04): boolean {
  if (candidate.sourceKind !== book.source.kind) return false;
  if (candidate.isbn13 !== undefined && book.isbn13 !== undefined && candidate.isbn13 !== book.isbn13) return false;
  if (candidate.url !== undefined && book.url !== undefined && candidate.url !== book.url) return false;
  const requested = candidate.sourceFiles.map((file) => `${file.mediaType}:${file.sha256}`).sort();
  const existing = [...fileDigests(book)];
  if (requested.length > 0 && existing.length > 0 && requested.join("\n") !== existing.join("\n")) return false;
  if (requested.length > 0 && existing.length === 0) return false;
  return true;
}

function matchingBook(
  candidate: ReviewerReconciliationCandidate,
  books: readonly ShelfBookV04[]
): { readonly kind: "new" } | { readonly kind: "match"; readonly book: ShelfBookV04 } | { readonly kind: "conflict" } {
  const matches: ShelfBookV04[] = [];
  for (const book of books) {
    if (!hasLocatorOverlap(candidate, book)) continue;
    if (!booksAreCompatible(candidate, book)) return { kind: "conflict" };
    matches.push(book);
  }
  if (matches.length > 1) return { kind: "conflict" };
  return matches.length === 0 ? { kind: "new" } : { kind: "match", book: matches[0] };
}

function bookFilename(book: ShelfBookV04): string {
  return `${book.id.replace(":", "-")}.json`;
}

function sourceFolderKey(candidate: ReviewerReconciliationCandidate): string {
  const identity = candidate.canonicalSourceAssets
    .map(({ file }) => `${file.mediaType}:${file.sha256}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(identity || `${candidate.packageId}:${candidate.sourceKind}`, "utf8").digest("hex");
}

function legacyReviewerDigest(record: ApprovedReviewerRecord): string | undefined {
  if (record.reviewState !== "APPROVED"
    || typeof record.annotationId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(record.annotationId)
    || typeof record.isbn13 !== "string"
    || !/^[0-9]{13}$/u.test(record.isbn13)
    || typeof record.quote !== "string"
    || typeof record.pageLabel !== "string"
    || typeof record.comment !== "string") return undefined;
  let sum = 0;
  for (let index = 0; index < 12; index += 1) sum += Number(record.isbn13[index]) * (index % 2 === 0 ? 1 : 3);
  if ((10 - sum % 10) % 10 !== Number(record.isbn13[12])) return undefined;
  const canonical = JSON.stringify({
    annotationId: record.annotationId,
    comment: record.comment,
    isbn13: record.isbn13,
    pageLabel: record.pageLabel,
    quote: record.quote,
    reviewState: record.reviewState
  });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function shelfRelativePath(value: string): string | null {
  if (value.length === 0 || value.includes("\\") || value.includes("\0")
    || value.startsWith("/") || /^[A-Za-z]:/u.test(value)) return null;
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return null;
  return value;
}

async function prepareBookAndFiles(
  root: string,
  candidate: ReviewerReconciliationCandidate,
  selectedBook: ShelfBookV04 | undefined,
  format: FormatCore
): Promise<{ readonly book: ShelfBookV04; readonly files: readonly ShelfSourceFileV04[] } | null> {
  if (selectedBook !== undefined) {
    const existingFiles = selectedBook.source.files ?? [];
    if (candidate.canonicalSourceAssets.length > 0) {
      for (const asset of candidate.canonicalSourceAssets) {
        const existingFile = existingFiles.find((file) => file.sha256 === asset.file.sha256 && file.mediaType === asset.file.mediaType);
        if (existingFile === undefined) return null;
        const relative = shelfRelativePath(existingFile.path);
        if (relative === null) return null;
        const target = path.resolve(root, relative);
        if (!inside(root, target)) return null;
        const directory = path.dirname(target);
        if (!await ensureDirectory(root, directory)) return null;
        const state = await writeNoReplace(target, asset.bytes);
        if (state === "conflict") return null;
      }
    }
    return { book: selectedBook, files: Object.freeze([...existingFiles]) };
  }

  const shelfFiles: ShelfSourceFileV04[] = [];
  for (const asset of candidate.canonicalSourceAssets) {
    const packagePath = shelfRelativePath(asset.file.path);
    if (packagePath === null) return null;
    const relative = `sources/${sourceFolderKey(candidate)}/${packagePath}`;
    const target = path.resolve(root, ...relative.split("/"));
    if (!inside(root, target) || !await ensureDirectory(root, path.dirname(target))) return null;
    const state = await writeNoReplace(target, asset.bytes);
    if (state === "conflict") return null;
    shelfFiles.push(Object.freeze({
      path: relative,
      mediaType: asset.file.mediaType,
      sha256: asset.file.sha256,
      ...(asset.file.originalName === undefined ? {} : { originalName: asset.file.originalName })
    }));
  }
  const book: ShelfBookV04 = Object.freeze({
    type: "book",
    version: "0.4",
    id: candidate.bookId,
    source: Object.freeze({
      kind: candidate.sourceKind,
      ...(shelfFiles.length === 0 ? {} : { files: Object.freeze(shelfFiles) })
    }),
    get: Object.freeze({ date: candidate.getDate }),
    ...(candidate.isbn13 === undefined ? {} : { isbn13: candidate.isbn13 }),
    ...(candidate.url === undefined ? {} : { url: candidate.url }),
    ...(candidate.title === undefined ? {} : { title: candidate.title }),
    ...(candidate.authors.length === 0 ? {} : { authors: Object.freeze([...candidate.authors]) }),
    ...(candidate.publisher === undefined ? {} : { publisher: candidate.publisher }),
    ...(candidate.year === undefined ? {} : { year: candidate.year }),
    ...(candidate.circleName === undefined ? {} : { circleName: candidate.circleName }),
    ...(candidate.eventName === undefined ? {} : { eventName: candidate.eventName })
  });
  const validated = format.validateShelfEntity("book", book);
  if (!validated.valid) return null;
  return { book: validated.value as ShelfBookV04, files: Object.freeze(shelfFiles) };
}

async function materializeUnlocked(
  shelfRoot: string,
  records: readonly ApprovedReviewerRecord[],
  lookupMetadata: ReviewerShelfMetadataLookup
): Promise<MaterializationResult> {
  const format = await loadFormatCore();
  let root: string;
  try { root = await realpath(shelfRoot); } catch { throw new Error("The selected Private Shelf is unavailable."); }
  let library: unknown;
  try { library = JSON.parse(await readFile(path.join(root, "library.json"), "utf8")); } catch {
    throw new Error("The selected Private Shelf has no readable library.json.");
  }
  if (library === null || typeof library !== "object" || Array.isArray(library)) {
    throw new Error("The selected Private Shelf library is invalid.");
  }
  const config = library as { booksPath?: unknown; annotationsPath?: unknown };
  const booksDirectory = safeConfiguredDirectory(root, config.booksPath, "books");
  const annotationsDirectory = safeConfiguredDirectory(root, config.annotationsPath, "annotations");
  if (booksDirectory === null || annotationsDirectory === null) throw new Error("The Private Shelf paths are invalid.");
  if (!await ensureDirectory(root, booksDirectory) || !await ensureDirectory(root, annotationsDirectory)) {
    throw new Error("The Private Shelf paths are unavailable or unsafe.");
  }

  const aliases = await existingAliases(annotationsDirectory, format);
  const books = await existingBooks(booksDirectory, format);
  const pending: ReviewerReconciliationPending[] = [];
  let materialized = 0;
  let unchanged = 0;
  let conflicts = 0;

  for (const record of records) {
    const prior = typeof record.annotationId === "string" ? aliases.get(record.annotationId) : undefined;
    const legacyDigest = legacyReviewerDigest(record);
    if (prior !== undefined
      && prior.length === 1
      && prior[0].version === 1
      && legacyDigest !== undefined
      && prior[0].digest === legacyDigest) {
      unchanged += 1;
      continue;
    }
    let enrichment: unknown;
    if (record.isbn13 && (!record.title || !record.authors || record.authors.length === 0)) {
      try {
        const result = await lookupMetadata(record.isbn13);
        if (result.status === "ok" && "metadata" in result) enrichment = result.metadata;
      } catch { /* Provider enrichment is optional; package provenance is not. */ }
    }
    const candidateResult = await createReviewerReconciliationCandidate(record, enrichment);
    if (candidateResult.kind === "pending") {
      if (prior !== undefined) conflicts += 1;
      else pending.push(candidateResult);
      continue;
    }
    const candidate = candidateResult;
    if (prior !== undefined) {
      if (prior.length === 1 && prior[0].version === REVIEWER_SHELF_PROVENANCE_VERSION && prior[0].digest === candidate.digest) unchanged += 1;
      else conflicts += 1;
      continue;
    }

    const match = matchingBook(candidate, books);
    if (match.kind === "conflict") { conflicts += 1; continue; }
    const prepared = await prepareBookAndFiles(root, candidate, match.kind === "match" ? match.book : undefined, format);
    if (prepared === null) { conflicts += 1; continue; }

    if (match.kind === "new") {
      const target = path.join(booksDirectory, bookFilename(prepared.book));
      const state = await writeNoReplace(target, Buffer.from(safeJson(prepared.book), "utf8"));
      if (state === "conflict") { conflicts += 1; continue; }
      books.push(prepared.book);
    }

    const output = await materializeReviewerReconciliationCandidate(
      candidate,
      prepared.book,
      prepared.files
    );
    if (output.kind === "pending") { pending.push(output); continue; }
    const annotationTarget = path.join(annotationsDirectory, `${output.annotation.id.replace(":", "-")}.json`);
    const state = await writeNoReplace(annotationTarget, Buffer.from(safeJson(output.annotation), "utf8"));
    if (state === "conflict") { conflicts += 1; continue; }
    const entries = aliases.get(candidate.reviewerAnnotationId) ?? [];
    entries.push({ digest: candidate.digest });
    aliases.set(candidate.reviewerAnnotationId, entries);
    if (state === "same") unchanged += 1;
    else materialized += 1;
  }
  return Object.freeze({ materialized, unchanged, pending: Object.freeze(pending), conflicts });
}

// The Desktop single-instance main process serializes Shelf writes so a manual
// retry and an approval-triggered retry cannot create duplicate aliases.
let writeQueue: Promise<void> = Promise.resolve();

export function materializeReviewerRecords(
  shelfRoot: string,
  records: readonly ApprovedReviewerRecord[],
  lookupMetadata: ReviewerShelfMetadataLookup
): Promise<MaterializationResult> {
  const result = writeQueue.then(() => materializeUnlocked(shelfRoot, records, lookupMetadata));
  writeQueue = result.then(() => undefined, () => undefined);
  return result;
}
