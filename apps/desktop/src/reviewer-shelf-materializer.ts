/**
 * Main-process-only durable boundary between Reviewer workflow records and a
 * selected canonical Private Shelf. Reviewer data is never used as a Shelf
 * schema: only validated Format v0.1 entities are written here.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { validateEntity, type Annotation, type Book } from "@maginalia/format";
import {
  createReviewerReconciliationCandidate,
  materializeReviewerReconciliationCandidate,
  type ApprovedReviewerRecord,
  type OpenBdBookMetadata,
  type ReviewerReconciliationPending
} from "./reviewer-shelf-reconciliation";

export interface ReviewerShelfMetadataLookup {
  (isbn13: string): Promise<{ readonly status: "ok"; readonly metadata: OpenBdBookMetadata } | { readonly status: string }>;
}

export interface MaterializationResult {
  readonly materialized: number;
  readonly unchanged: number;
  readonly pending: readonly ReviewerReconciliationPending[];
  readonly conflicts: number;
}

interface ExistingAlias {
  readonly annotation: Annotation;
  readonly digest: string;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function safeConfiguredDirectory(root: string, value: unknown, fallback: string): string | null {
  const part = typeof value === "string" ? value : fallback;
  if (part.length === 0 || path.isAbsolute(part) || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(part)) return null;
  const resolved = path.resolve(root, part);
  return inside(root, resolved) ? resolved : null;
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

function aliasFor(annotation: Annotation): ExistingAlias | undefined {
  const provenance = annotation.deviceMetadata?.maginaliaReviewer;
  if (provenance === null || typeof provenance !== "object" || Array.isArray(provenance)) return undefined;
  const value = provenance as { annotationId?: unknown; digest?: unknown };
  return typeof value.annotationId === "string" && typeof value.digest === "string"
    ? { annotation, digest: value.digest }
    : undefined;
}

async function existingAliases(directory: string): Promise<Map<string, ExistingAlias>> {
  const aliases = new Map<string, ExistingAlias>();
  let entries: string[];
  try { entries = await readdir(directory); } catch { return aliases; }
  for (const name of entries) {
    if (path.extname(name).toLowerCase() !== ".json") continue;
    try {
      const parsed: unknown = JSON.parse(await readFile(path.join(directory, name), "utf8"));
      const validated = validateEntity("annotation", parsed);
      if (!validated.valid) continue;
      const alias = aliasFor(validated.value);
      if (alias) aliases.set((validated.value.deviceMetadata!.maginaliaReviewer as { annotationId: string }).annotationId, alias);
    } catch { /* malformed user data is left untouched and never adopted */ }
  }
  return aliases;
}

/**
 * Materialize only complete approved records. Incomplete metadata and
 * unsupported locations remain pending in Reviewer for a later retry.
 */
export async function materializeReviewerRecords(
  shelfRoot: string,
  records: readonly ApprovedReviewerRecord[],
  lookupMetadata: ReviewerShelfMetadataLookup
): Promise<MaterializationResult> {
  let library: unknown;
  try { library = JSON.parse(await readFile(path.join(shelfRoot, "library.json"), "utf8")); } catch {
    throw new Error("The selected Private Shelf has no readable library.json.");
  }
  if (library === null || typeof library !== "object" || Array.isArray(library)) {
    throw new Error("The selected Private Shelf library is invalid.");
  }
  const config = library as { booksPath?: unknown; annotationsPath?: unknown };
  const booksDirectory = safeConfiguredDirectory(shelfRoot, config.booksPath, "books");
  const annotationsDirectory = safeConfiguredDirectory(shelfRoot, config.annotationsPath, "annotations");
  if (booksDirectory === null || annotationsDirectory === null) throw new Error("The Private Shelf paths are invalid.");
  await Promise.all([mkdir(booksDirectory, { recursive: true }), mkdir(annotationsDirectory, { recursive: true })]);
  const aliases = await existingAliases(annotationsDirectory);
  const pending: ReviewerReconciliationPending[] = [];
  let materialized = 0;
  let unchanged = 0;
  let conflicts = 0;

  for (const record of records) {
    const metadata = await lookupMetadata(record.isbn13);
    if (metadata.status !== "ok") {
      pending.push({ kind: "pending", code: "openbd-metadata-missing", reviewerAnnotationId: record.annotationId });
      continue;
    }
    const candidate = createReviewerReconciliationCandidate(record, metadata.metadata);
    if (candidate.kind === "pending") { pending.push(candidate); continue; }
    const existing = aliases.get(candidate.reviewerAnnotationId);
    if (existing) {
      if (existing.digest === candidate.digest) unchanged += 1;
      else conflicts += 1;
      continue;
    }
    const output = materializeReviewerReconciliationCandidate(candidate);
    if (output.kind === "pending") { pending.push(output); continue; }
    const bookPath = path.join(booksDirectory, `${output.book.isbn13}.json`);
    try {
      const present = validateEntity("book", JSON.parse(await readFile(bookPath, "utf8")));
      if (!present.valid || present.value.id !== output.book.id) { conflicts += 1; continue; }
    } catch {
      await writeJsonAtomic(bookPath, output.book as Book);
    }
    await writeJsonAtomic(path.join(annotationsDirectory, `${output.annotation.id.replace(":", "-")}.json`), output.annotation);
    aliases.set(candidate.reviewerAnnotationId, { annotation: output.annotation, digest: candidate.digest });
    materialized += 1;
  }
  return Object.freeze({ materialized, unchanged, pending: Object.freeze(pending), conflicts });
}
