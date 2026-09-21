import { createHash } from "node:crypto";
import { promises as fs, type Dirent, type Stats } from "node:fs";
import { basename, join, parse, relative, resolve, sep } from "node:path";
import type { RepositoryIdentity } from "@maginalia/repository-core" with { "resolution-mode": "import" };

type ParseIdentity = typeof import("@maginalia/repository-core", { with: { "resolution-mode": "import" } })["parseIdentity"];

let parseIdentityPromise: Promise<ParseIdentity> | undefined;

async function loadParseIdentity(): Promise<ParseIdentity> {
  parseIdentityPromise ??= import("@maginalia/repository-core").then((repositoryCore) => repositoryCore.parseIdentity);
  return parseIdentityPromise;
}

const IDENTITY_PATH = ".maginalia/repository.json";
export const INCOMPLETE_MARKER = "MAGINALIA-INCOMPLETE.txt" as const;

export const DEFAULT_REPOSITORY_FILESYSTEM_LIMITS = Object.freeze({
  maxFiles: 10_000,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxPathBytes: 240,
  maxDepth: 64,
  maxEntries: 100_000,
});

export type RepositoryFilesystemLimits = Readonly<{
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxPathBytes: number;
  maxDepth: number;
  maxEntries: number;
}>;

export type RepositoryFilesystemErrorCode =
  | "invalid-root"
  | "root-missing"
  | "root-not-directory"
  | "root-unreadable"
  | "invalid-path"
  | "invalid-identity"
  | "unsafe-path"
  | "unsafe-secret"
  | "unsafe-tree"
  | "limits-exceeded"
  | "changed"
  | "incomplete-marker"
  | "io-error";

export class RepositoryFilesystemError extends Error {
  public readonly userMessage: string;

  public constructor(
    public readonly code: RepositoryFilesystemErrorCode,
    userMessage: string,
  ) {
    super(userMessage);
    this.name = "RepositoryFilesystemError";
    this.userMessage = userMessage;
  }
}

export type RepositoryFileMode = "100644" | "100755";

export interface CapturedRepositoryFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly mode: RepositoryFileMode;
}

export interface WorkingTreeSnapshot {
  readonly files: readonly CapturedRepositoryFile[];
  readonly fingerprint: string;
}

export interface RepositoryFilesystemCaptureOptions {
  readonly limits?: Partial<RepositoryFilesystemLimits>;
  readonly trackedPaths?: ReadonlySet<string>;
  readonly modeHints?: ReadonlyMap<string, RepositoryFileMode>;
  readonly isIgnored?: (pathValue: string) => boolean | Promise<boolean>;
  /**
   * Main-process validated repository-owned subtrees which must not be
   * traversed or captured. This is intentionally a relative directory list,
   * never a renderer-controlled filesystem ignore mechanism.
   */
  readonly excludedDirectories?: ReadonlySet<string>;
  /**
   * This is an internal initialization-only escape hatch. It only controls
   * whether the root publication marker is omitted from a capture; it never
   * removes the marker or permits arbitrary paths.
   */
  readonly allowIncompleteMarker?: boolean;
}

export interface ReadIdentityOptions {
  readonly allowIncompleteMarker?: boolean;
}

const WINDOWS_RESERVED = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

const SKIPPED_DIRECTORY_NAMES = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  ".cache",
]);

const SECRET_FILE_PATTERNS = [
  /^\.env(?:\..*)?$/i,
  /^(?:\.npmrc|\.netrc|\.pypirc|\.dockerconfigjson)$/i,
  /^(?:credentials?|secrets?|tokens?|auth|service-account)(?:[._-].*)?(?:\.(?:json|ya?ml|toml|ini|cfg|conf|txt))?$/i,
  /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|authorized_keys)$/i,
  /\.(?:pem|key|p12|pfx|jks|kdbx|der)$/i,
];

const SECRET_CONTENT_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\b(?:ghp|gho|ghs|ghr|github_pat)_[A-Za-z0-9_]+\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
];

const IDENTITY_MAX_BYTES = 64 * 1024;
const UUID_PATH_SEPARATOR = "/";

const INVALID_ROOT_MESSAGE = "The repository folder must be a real non-root directory.";
const ROOT_MISSING_MESSAGE = "The repository folder is no longer available.";
const ROOT_NOT_DIRECTORY_MESSAGE = "The repository path is not a directory.";
const ROOT_UNREADABLE_MESSAGE = "The repository folder could not be read safely.";
const INVALID_PATH_MESSAGE = "The repository contains an invalid relative path.";
const UNSAFE_PATH_MESSAGE = "The repository contains an unsafe or unsupported path.";
const UNSAFE_TREE_MESSAGE = "The repository contains an unsafe or unsupported file.";
const UNSAFE_SECRET_MESSAGE = "A credential or private-key path or marker cannot be captured.";
const LIMIT_MESSAGE = "The repository exceeds the supported file or path limits.";
const CHANGED_MESSAGE = "Repository data changed while it was being inspected.";
const INVALID_IDENTITY_MESSAGE = "The portable repository identity is invalid.";
const INCOMPLETE_MESSAGE = "This repository folder is marked incomplete and is not ready for normal use.";
const IO_MESSAGE = "The repository filesystem operation could not be completed safely.";

function fail(code: RepositoryFilesystemErrorCode, message: string): never {
  throw new RepositoryFilesystemError(code, message);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code;
}

function isMissing(error: unknown): boolean {
  return isNodeError(error, "ENOENT")
    || isNodeError(error, "ENOTDIR")
    || isNodeError(error, "NotFoundError")
    || isNodeError(error, "NoSuchFileError");
}

function normalizeUnexpected(
  error: unknown,
  fallbackCode: RepositoryFilesystemErrorCode = "io-error",
): RepositoryFilesystemError {
  if (error instanceof RepositoryFilesystemError) return error;
  return new RepositoryFilesystemError(fallbackCode, IO_MESSAGE);
}

function statSize(stat: Stats): number {
  return typeof stat.size === "bigint" ? Number(stat.size) : stat.size;
}

function linkCount(stat: Stats): number {
  return typeof stat.nlink === "bigint" ? Number(stat.nlink) : stat.nlink;
}

function rejectHardLinkedFile(stat: Stats): void {
  if (stat.isFile() && linkCount(stat) > 1) {
    fail("unsafe-path", UNSAFE_PATH_MESSAGE);
  }
}

function validateLimits(input?: Partial<RepositoryFilesystemLimits>): RepositoryFilesystemLimits {
  const limits = {
    ...DEFAULT_REPOSITORY_FILESYSTEM_LIMITS,
    ...(input ?? {}),
  };
  const values = Object.values(limits);
  if (values.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    fail("limits-exceeded", LIMIT_MESSAGE);
  }
  return limits;
}

function normalizeCaseKey(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function compareNames(left: string, right: string): number {
  return left.localeCompare(right, "en", { sensitivity: "variant" });
}

function isWindowsReservedName(segment: string): boolean {
  const base = segment.replace(/[. ]+$/u, "").split(".", 1)[0]?.toUpperCase();
  return base !== undefined && base.length > 0 && WINDOWS_RESERVED.has(base);
}

function validateSegment(segment: string): void {
  if (
    segment.length === 0
    || segment === "."
    || segment === ".."
    || segment.includes("\0")
    || segment.includes("/")
    || segment.includes("\\")
    || segment.includes(":")
    || /[<>"|?*\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(segment)
    || /[. ]$/u.test(segment)
    || isWindowsReservedName(segment)
  ) {
    fail("invalid-path", INVALID_PATH_MESSAGE);
  }
}

/**
 * Validate a portable repository-relative path without touching the host
 * filesystem. Returned segments are newly allocated and safe to join below a
 * canonical root.
 */
export function validateRepositoryPath(pathValue: unknown): readonly string[] {
  if (
    typeof pathValue !== "string"
    || pathValue.length === 0
    || pathValue.startsWith("/")
    || pathValue.startsWith("\\")
    || pathValue.includes("\\")
    || pathValue.includes("\0")
    || pathValue.includes(":")
  ) {
    fail("invalid-path", INVALID_PATH_MESSAGE);
  }
  const segments = pathValue.split(UUID_PATH_SEPARATOR);
  for (const segment of segments) validateSegment(segment);
  if (segments.some((segment) => segment.toLowerCase() === ".git")) {
    fail("unsafe-path", UNSAFE_PATH_MESSAGE);
  }
  return segments;
}

/** Compatibility name for the local adapter that will consume this boundary. */
export const validateGitPath = validateRepositoryPath;

function isSecretPath(pathValue: string): boolean {
  const fileName = basename(pathValue);
  return SECRET_FILE_PATTERNS.some((pattern) => pattern.test(fileName));
}

function containsSecretMarker(bytes: Uint8Array): boolean {
  const text = Buffer.from(bytes).toString("utf8");
  return SECRET_CONTENT_PATTERNS.some((pattern) => pattern.test(text));
}

function checkSecret(pathValue: string, bytes: Uint8Array): void {
  if (isSecretPath(pathValue) || containsSecretMarker(bytes)) {
    fail("unsafe-secret", UNSAFE_SECRET_MESSAGE);
  }
}

function reserveSize(
  pathValue: string,
  size: number,
  limits: RepositoryFilesystemLimits,
  totals: { files: number; bytes: number },
): void {
  if (
    size > limits.maxFileBytes
    || Buffer.byteLength(pathValue, "utf8") > limits.maxPathBytes
  ) {
    fail("limits-exceeded", LIMIT_MESSAGE);
  }
  totals.files += 1;
  totals.bytes += size;
  if (totals.files > limits.maxFiles || totals.bytes > limits.maxTotalBytes) {
    fail("limits-exceeded", LIMIT_MESSAGE);
  }
}

function verifyReadSize(
  expectedSize: number,
  bytes: Uint8Array,
): void {
  if (bytes.byteLength !== expectedSize) fail("changed", CHANGED_MESSAGE);
}

function assertWithin(root: string, candidate: string): void {
  const child = relative(root, candidate);
  if (
    child === ""
    || (!child.startsWith(".." + sep) && child !== ".." && !parse(child).root)
  ) {
    return;
  }
  fail("unsafe-path", UNSAFE_PATH_MESSAGE);
}

async function assertContainedRealPath(rootReal: string, candidate: string): Promise<void> {
  try {
    const real = await fs.realpath(candidate);
    assertWithin(rootReal, real);
  } catch (error) {
    if (isMissing(error)) fail("changed", CHANGED_MESSAGE);
    throw error;
  }
}

async function assertSafeRootInternal(root: string): Promise<string> {
  if (typeof root !== "string" || root.trim().length === 0) {
    fail("invalid-root", INVALID_ROOT_MESSAGE);
  }
  const absolute = resolve(root);
  if (parse(absolute).root === absolute) fail("invalid-root", INVALID_ROOT_MESSAGE);

  let initialStat: Stats;
  try {
    initialStat = await fs.lstat(absolute);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) fail("root-missing", ROOT_MISSING_MESSAGE);
    if (isNodeError(error, "ENOTDIR")) fail("root-not-directory", ROOT_NOT_DIRECTORY_MESSAGE);
    if (isNodeError(error, "EACCES") || isNodeError(error, "EPERM")) {
      fail("root-unreadable", ROOT_UNREADABLE_MESSAGE);
    }
    throw error;
  }
  if (!initialStat.isDirectory()) fail("root-not-directory", ROOT_NOT_DIRECTORY_MESSAGE);
  if (initialStat.isSymbolicLink()) {
    fail("invalid-root", INVALID_ROOT_MESSAGE);
  }

  let canonical: string;
  try {
    canonical = await fs.realpath(absolute);
  } catch (error) {
    if (isMissing(error)) fail("root-missing", ROOT_MISSING_MESSAGE);
    throw error;
  }
  if (parse(canonical).root === canonical) fail("invalid-root", INVALID_ROOT_MESSAGE);
  const canonicalStat = await fs.lstat(canonical);
  if (!canonicalStat.isDirectory()) fail("root-not-directory", ROOT_NOT_DIRECTORY_MESSAGE);
  if (canonicalStat.isSymbolicLink()) {
    fail("invalid-root", INVALID_ROOT_MESSAGE);
  }
  return canonical;
}

export async function assertSafeRoot(root: string): Promise<string> {
  try {
    return await assertSafeRootInternal(root);
  } catch (error) {
    throw normalizeUnexpected(error, "invalid-root");
  }
}

export const canonicalizeRepositoryRoot = assertSafeRoot;

async function lstatDataPath(
  rootReal: string,
  pathValue: string,
  missingCode: RepositoryFilesystemErrorCode,
): Promise<{ absolute: string; stat: Stats }> {
  const segments = validateRepositoryPath(pathValue);
  let current = rootReal;
  for (const segment of segments) {
    current = join(current, segment);
    let stat: Stats;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (isMissing(error)) fail(missingCode, INVALID_IDENTITY_MESSAGE);
      throw error;
    }
    if (stat.isSymbolicLink()) fail("unsafe-path", UNSAFE_PATH_MESSAGE);
    await assertContainedRealPath(rootReal, current);
  }
  const stat = await fs.lstat(current);
  return { absolute: current, stat };
}

async function hasIncompleteMarker(rootReal: string): Promise<boolean> {
  const markerPath = join(rootReal, INCOMPLETE_MARKER);
  try {
    const stat = await fs.lstat(markerPath);
    if (!stat.isFile() || stat.isSymbolicLink() || linkCount(stat) > 1) {
      fail("incomplete-marker", INCOMPLETE_MESSAGE);
    }
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    if (error instanceof RepositoryFilesystemError) throw error;
    throw error;
  }
}

async function rejectIncompleteMarker(rootReal: string): Promise<void> {
  if (await hasIncompleteMarker(rootReal)) fail("incomplete-marker", INCOMPLETE_MESSAGE);
}

async function readIdentityInternal(
  rootReal: string,
  options?: ReadIdentityOptions,
): Promise<RepositoryIdentity> {
  if (!options?.allowIncompleteMarker) await rejectIncompleteMarker(rootReal);
  const { absolute, stat } = await lstatDataPath(rootReal, IDENTITY_PATH, "invalid-identity");
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail("invalid-identity", INVALID_IDENTITY_MESSAGE);
  }
  rejectHardLinkedFile(stat);
  const size = statSize(stat);
  if (size > IDENTITY_MAX_BYTES) fail("limits-exceeded", LIMIT_MESSAGE);
  const bytes = new Uint8Array(await fs.readFile(absolute));
  if (bytes.byteLength !== size) fail("changed", CHANGED_MESSAGE);
  try {
    const parseIdentity = await loadParseIdentity();
    return parseIdentity(JSON.parse(Buffer.from(bytes).toString("utf8")));
  } catch (error) {
    if (error instanceof RepositoryFilesystemError) throw error;
    fail("invalid-identity", INVALID_IDENTITY_MESSAGE);
  }
}

export async function readIdentity(
  root: string,
  options?: ReadIdentityOptions,
): Promise<RepositoryIdentity> {
  try {
    const rootReal = await assertSafeRootInternal(root);
    return await readIdentityInternal(rootReal, options);
  } catch (error) {
    throw normalizeUnexpected(error, "invalid-identity");
  }
}

function trackedDescendant(
  trackedPaths: ReadonlySet<string>,
  directoryPath: string,
): boolean {
  const prefix = directoryPath + UUID_PATH_SEPARATOR;
  for (const trackedPath of trackedPaths) {
    if (trackedPath === directoryPath || trackedPath.startsWith(prefix)) return true;
  }
  return false;
}

function validatedExcludedDirectories(
  value: ReadonlySet<string> | undefined,
  trackedPaths: ReadonlySet<string>,
  limits: RepositoryFilesystemLimits,
): ReadonlySet<string> {
  const exclusions = new Set<string>();
  for (const pathValue of value ?? []) {
    validateRepositoryPath(pathValue);
    if (Buffer.byteLength(pathValue, "utf8") > limits.maxPathBytes) {
      fail("limits-exceeded", LIMIT_MESSAGE);
    }
    for (const trackedPath of trackedPaths) {
      if (trackedPath === pathValue || trackedPath.startsWith(`${pathValue}/`)) {
        // Never silently drop content which an earlier parent snapshot already
        // tracked. The caller must resolve this ownership conflict explicitly.
        fail("unsafe-path", UNSAFE_PATH_MESSAGE);
      }
    }
    exclusions.add(pathValue);
  }
  return exclusions;
}

function modeFor(
  stat: Stats,
  pathValue: string,
  modeHints: ReadonlyMap<string, RepositoryFileMode> | undefined,
): RepositoryFileMode {
  if (process.platform === "win32") {
    const hinted = modeHints?.get(pathValue);
    if (hinted === "100644" || hinted === "100755") return hinted;
  }
  return (stat.mode & 0o111) !== 0 ? "100755" : "100644";
}

async function captureWorkingTreeInternal(
  rootReal: string,
  options?: RepositoryFilesystemCaptureOptions,
): Promise<WorkingTreeSnapshot> {
  const limits = validateLimits(options?.limits);
  const trackedPaths = new Set<string>(options?.trackedPaths ?? []);
  for (const trackedPath of trackedPaths) {
    validateRepositoryPath(trackedPath);
    if (Buffer.byteLength(trackedPath, "utf8") > limits.maxPathBytes) {
      fail("limits-exceeded", LIMIT_MESSAGE);
    }
  }
  const excludedDirectories = validatedExcludedDirectories(options?.excludedDirectories, trackedPaths, limits);

  const files: CapturedRepositoryFile[] = [];
  const seen = new Map<string, string>();
  const totals = { files: 0, bytes: 0 };
  let visitedEntries = 0;

  async function visit(directory: string, segments: readonly string[]): Promise<void> {
    if (segments.length > limits.maxDepth) fail("limits-exceeded", LIMIT_MESSAGE);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) fail("changed", CHANGED_MESSAGE);
      if (isNodeError(error, "EACCES") || isNodeError(error, "EPERM")) {
        fail("root-unreadable", ROOT_UNREADABLE_MESSAGE);
      }
      throw error;
    }
    entries.sort((left, right) => compareNames(left.name, right.name));

    for (const entry of entries) {
      visitedEntries += 1;
      if (visitedEntries > limits.maxEntries) fail("limits-exceeded", LIMIT_MESSAGE);
      const nextSegments = [...segments, entry.name];
      const pathValue = nextSegments.join(UUID_PATH_SEPARATOR);
      if (Buffer.byteLength(pathValue, "utf8") > limits.maxPathBytes) {
        fail("limits-exceeded", LIMIT_MESSAGE);
      }
      const caseKey = normalizeCaseKey(pathValue);
      const previous = seen.get(caseKey);
      if (previous !== undefined && previous !== pathValue) {
        fail("unsafe-path", UNSAFE_PATH_MESSAGE);
      }
      seen.set(caseKey, pathValue);

      const absolute = join(directory, entry.name);
      if (nextSegments.length === 1 && entry.name.toLowerCase() === ".git") {
        let gitStat: Stats;
        try {
          gitStat = await fs.lstat(absolute);
        } catch (error) {
          if (isMissing(error)) fail("changed", CHANGED_MESSAGE);
          throw error;
        }
        if (!gitStat.isDirectory() || gitStat.isSymbolicLink()) {
          fail("unsafe-tree", UNSAFE_TREE_MESSAGE);
        }
        await assertContainedRealPath(rootReal, absolute);
        continue;
      }
      if (entry.name.toLowerCase() === ".git") {
        fail("unsafe-path", UNSAFE_PATH_MESSAGE);
      }

      validateRepositoryPath(pathValue);
      await assertContainedRealPath(rootReal, absolute);
      let stat: Stats;
      try {
        stat = await fs.lstat(absolute);
      } catch (error) {
        if (isMissing(error)) fail("changed", CHANGED_MESSAGE);
        throw error;
      }
      if (stat.isSymbolicLink()) fail("unsafe-path", UNSAFE_PATH_MESSAGE);

      if (stat.isDirectory()) {
        if (excludedDirectories.has(pathValue)) {
          // The caller supplied this only after validating the direct child
          // repository identity and ownership. Stop before readdir so a
          // nested .git or any authoring data cannot cross into the parent.
          continue;
        }
        if (
          SKIPPED_DIRECTORY_NAMES.has(entry.name.toLowerCase())
          && !trackedDescendant(trackedPaths, pathValue)
        ) {
          continue;
        }
        await visit(absolute, nextSegments);
        continue;
      }

      if (!stat.isFile()) fail("unsafe-path", UNSAFE_PATH_MESSAGE);
      rejectHardLinkedFile(stat);
      const size = statSize(stat);
      reserveSize(pathValue, size, limits, totals);

      const bytes = new Uint8Array(await fs.readFile(absolute));
      verifyReadSize(size, bytes);
      if (pathValue === INCOMPLETE_MARKER) {
        if (!options?.allowIncompleteMarker) fail("incomplete-marker", INCOMPLETE_MESSAGE);
        continue;
      }

      // Safety checks intentionally precede ignore handling. The lstat/read
      // sequence rejects static links and verifies byte length, but is not a
      // claim of complete TOCTOU race resistance against later host changes.
      checkSecret(pathValue, bytes);
      const tracked = trackedPaths.has(pathValue);
      if (
        !tracked
        && pathValue !== IDENTITY_PATH
        && options?.isIgnored
        && await options.isIgnored(pathValue)
      ) {
        continue;
      }
      files.push({
        path: pathValue,
        bytes,
        mode: modeFor(stat, pathValue, options?.modeHints),
      });
    }
  }

  await visit(rootReal, []);
  files.sort((left, right) => compareNames(left.path, right.path));
  return Object.freeze({
    files: Object.freeze(files),
    fingerprint: fingerprint(files),
  });
}

export async function captureWorkingTree(
  root: string,
  options?: RepositoryFilesystemCaptureOptions,
): Promise<WorkingTreeSnapshot> {
  try {
    const rootReal = await assertSafeRootInternal(root);
    return await captureWorkingTreeInternal(rootReal, options);
  } catch (error) {
    throw normalizeUnexpected(error);
  }
}

/**
 * Compute a deterministic content-and-mode fingerprint. Bytes are hashed as
 * bytes, so CRLF, UTF-8 BOMs, and any other string/file representation are
 * preserved exactly.
 */
export function fingerprint(
  files: readonly Pick<CapturedRepositoryFile, "path" | "bytes" | "mode">[],
): string {
  const hash = createHash("sha256");
  const sorted = [...files].sort((left, right) => compareNames(left.path, right.path));
  for (const file of sorted) {
    hash.update(file.path, "utf8");
    hash.update("\0", "utf8");
    hash.update(file.mode, "utf8");
    hash.update("\0", "utf8");
    hash.update(String(file.bytes.byteLength), "utf8");
    hash.update("\0", "utf8");
    hash.update(file.bytes);
    hash.update("\n", "utf8");
  }
  return hash.digest("hex");
}

export const computeFingerprint = fingerprint;
