/**
 * H.6R4's deliberately narrow bootstrap from the one known legacy Reviewer
 * SQLite layout.  The only durable output is the existing Format v0.1 Private
 * Shelf; this module neither changes Format nor introduces a migration store.
 */
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { lookupOpenBdMetadata } from "./openbd-metadata";
import {
  materializeReviewerRecords,
  type MaterializationResult,
  type ReviewerShelfMetadataLookup,
} from "./reviewer-shelf-materializer";
import type { ApprovedReviewerRecord } from "./reviewer-shelf-reconciliation";

const execFileAsync = promisify(execFile);
// This bootstrap is an engineering migration command, executed from the
// checked-out Desktop build; keep its fixed reader beside its source instead
// of adding a Python dependency to the shipped application.
const READER_PATH = path.resolve(__dirname, "../../src/legacy-quotes-reader.py");

export interface LegacyQuotesBootstrapResult extends MaterializationResult {
  readonly initialized: boolean;
  readonly approvedRecords: number;
}

export interface LegacyQuotesBootstrapOptions {
  /** The legacy_quotes directory. It is read only and must never be a Shelf. */
  readonly sourceRoot: string;
  /** Explicit caller-selected Shelf root. No destination is persisted here. */
  readonly shelfRoot: string;
  readonly shelfName?: string;
  readonly pythonExecutable?: string;
  readonly loadRecords?: (sourceRoot: string, pythonExecutable: string) => Promise<readonly ApprovedReviewerRecord[]>;
  readonly lookupMetadata?: ReviewerShelfMetadataLookup;
  readonly materialize?: typeof materializeReviewerRecords;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isApprovedRecord(value: unknown): value is ApprovedReviewerRecord {
  return isPlainRecord(value)
    && value.reviewState === "APPROVED"
    && typeof value.annotationId === "string"
    && typeof value.isbn13 === "string"
    && typeof value.quote === "string"
    && typeof value.pageLabel === "string"
    && typeof value.comment === "string";
}

async function loadLegacyRecords(sourceRoot: string, pythonExecutable: string): Promise<readonly ApprovedReviewerRecord[]> {
  const { stdout } = await execFileAsync(pythonExecutable, [READER_PATH, "--source", sourceRoot], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    // Windows Python otherwise inherits a legacy console encoding and corrupts
    // the Unicode JSON boundary before Node can parse it.
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  const parsed: unknown = JSON.parse(stdout);
  if (!isPlainRecord(parsed) || !Array.isArray(parsed.records) || !parsed.records.every(isApprovedRecord)) {
    throw new Error("The legacy Reviewer quote projection was invalid.");
  }
  return Object.freeze(parsed.records.map((record) => Object.freeze({ ...record })));
}

async function canonicalDirectory(value: string, label: string): Promise<string> {
  if (value.length === 0 || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute directory.`);
  const resolved = await realpath(value);
  if (!(await lstat(resolved)).isDirectory()) throw new Error(`${label} must be a directory.`);
  return resolved;
}

async function validateExistingShelf(shelfRoot: string): Promise<void> {
  const [format, repositoryCore] = await Promise.all([
    import("@maginalia/format"),
    import("@maginalia/repository-core"),
  ]);
  const [libraryText, identityText] = await Promise.all([
    readFile(path.join(shelfRoot, "library.json"), "utf8"),
    readFile(path.join(shelfRoot, ".maginalia", "repository.json"), "utf8"),
  ]);
  const library = format.validateEntity("library", JSON.parse(libraryText));
  if (!library.valid) throw new Error("The destination library.json is not a valid Format v0.1 Library.");
  const identity = repositoryCore.parseIdentity(JSON.parse(identityText));
  if (identity.kind !== "shelf") throw new Error("The destination repository is not a Private Shelf.");
}

async function initializeEmptyShelf(shelfRoot: string, shelfName: string): Promise<boolean> {
  const contents = await readdir(shelfRoot);
  if (contents.includes("library.json")) {
    await validateExistingShelf(shelfRoot);
    return false;
  }
  if (contents.length !== 0) {
    throw new Error("The destination must be an empty directory or an existing Private Shelf.");
  }
  const repositoryCore = await import("@maginalia/repository-core");
  const files = repositoryCore.templateFiles(repositoryCore.createIdentity("shelf", shelfName, randomUUID()));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(shelfRoot, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, { encoding: "utf8", flag: "wx" });
  }
  return true;
}

/**
 * Materialize the approved legacy records through H.6R2's existing boundary.
 * Repeating the call is safe because its Reviewer UUID aliases are durable.
 */
export async function bootstrapLegacyQuotes(options: LegacyQuotesBootstrapOptions): Promise<LegacyQuotesBootstrapResult> {
  const sourceRoot = await canonicalDirectory(options.sourceRoot, "Legacy source");
  const shelfRoot = await canonicalDirectory(options.shelfRoot, "Destination Shelf");
  if (sourceRoot === shelfRoot || sourceRoot.startsWith(`${shelfRoot}${path.sep}`) || shelfRoot.startsWith(`${sourceRoot}${path.sep}`)) {
    throw new Error("The legacy source and destination Shelf must be separate directories.");
  }
  const initialized = await initializeEmptyShelf(shelfRoot, options.shelfName ?? "Private Shelf");
  const records = await (options.loadRecords ?? loadLegacyRecords)(sourceRoot, options.pythonExecutable ?? "python");
  const lookup = options.lookupMetadata ?? lookupOpenBdMetadata;
  const lookupCache = new Map<string, Promise<Awaited<ReturnType<ReviewerShelfMetadataLookup>>>>();
  const cachedLookup: ReviewerShelfMetadataLookup = (isbn13) => {
    let pending = lookupCache.get(isbn13);
    if (pending === undefined) {
      pending = Promise.resolve().then(() => lookup(isbn13));
      lookupCache.set(isbn13, pending);
    }
    return pending;
  };
  const materialized = await (options.materialize ?? materializeReviewerRecords)(shelfRoot, records, cachedLookup);
  return Object.freeze({ ...materialized, initialized, approvedRecords: records.length });
}
