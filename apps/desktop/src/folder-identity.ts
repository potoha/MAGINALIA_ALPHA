import { randomUUID } from "node:crypto";
import { lstat, open, readdir, readFile, unlink } from "node:fs/promises";
import * as path from "node:path";
import type { FolderMarker, FolderMarkerType, RepositoryIdentity } from "@maginalia/repository-core" with { "resolution-mode": "import" };
import { assertSafeRoot, readIdentity as readLegacyRepositoryIdentity } from "./repository-filesystem.js";

type RepositoryCore = typeof import("@maginalia/repository-core", { with: { "resolution-mode": "import" } });
let repositoryCorePromise: Promise<RepositoryCore> | undefined;

function loadRepositoryCore(): Promise<RepositoryCore> {
  repositoryCorePromise ??= import("@maginalia/repository-core");
  return repositoryCorePromise;
}

export type FolderMarkerInspection =
  | { readonly kind: "missing"; readonly invalidFiles: readonly string[] }
  | { readonly kind: "valid"; readonly marker: FolderMarker; readonly filenames: readonly string[] }
  | { readonly kind: "conflict"; readonly markers: readonly { readonly filename: string; readonly marker: FolderMarker }[] };

export type FolderMarkerSource = "marker" | "legacy" | "generated";

export interface EnsuredFolderMarker {
  readonly marker: FolderMarker;
  readonly filenames: readonly string[];
  readonly source: FolderMarkerSource;
  /** Legacy title is presentation metadata only and is never marker identity. */
  readonly legacyIdentity?: RepositoryIdentity;
}

export type FolderMarkerErrorCode = "marker-conflict" | "wrong-type" | "legacy-kind-conflict" | "marker-write-failed" | "missing-marker";

export class FolderMarkerError extends Error {
  public constructor(public readonly code: FolderMarkerErrorCode, message: string) {
    super(message);
    this.name = "FolderMarkerError";
  }
}

const MARKER_MAX_BYTES = 16 * 1024;

function sameMarker(left: FolderMarker, right: FolderMarker): boolean {
  if (left.version !== right.version || left.type !== right.type || left.id.toLowerCase() !== right.id.toLowerCase()) return false;
  if (left.type === "project" && right.type === "project") {
    return (left.parent?.toLowerCase() ?? null) === (right.parent?.toLowerCase() ?? null);
  }
  return left.type !== "project" && right.type !== "project";
}

async function canonicalFolderRoot(root: string): Promise<string> {
  const canonicalRoot = await assertSafeRoot(root);
  const stats = await lstat(canonicalRoot);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("The selected folder is unsafe.");
  return canonicalRoot;
}

/** Inspect immediate-root `*.magi` files only. Invalid candidates never become identities. */
export async function inspectFolderMarkers(root: string): Promise<FolderMarkerInspection> {
  const canonicalRoot = await canonicalFolderRoot(root);
  const repositoryCore = await loadRepositoryCore();
  const entries = await readdir(canonicalRoot, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.name.toLocaleLowerCase("en-US").endsWith(".magi"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en", { sensitivity: "variant" }));
  const valid: { filename: string; marker: FolderMarker }[] = [];
  const invalid: string[] = [];

  for (const filename of candidates) {
    const filePath = path.join(canonicalRoot, filename);
    try {
      const stats = await lstat(filePath);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MARKER_MAX_BYTES) {
        invalid.push(filename);
        continue;
      }
      const bytes = await readFile(filePath);
      if (bytes.byteLength !== stats.size) {
        invalid.push(filename);
        continue;
      }
      const marker = repositoryCore.parseFolderMarkerText(bytes.toString("utf8"));
      valid.push({ filename, marker });
    } catch {
      invalid.push(filename);
    }
  }

  if (valid.length === 0) return Object.freeze({ kind: "missing", invalidFiles: Object.freeze(invalid) });
  const first = valid[0]!;
  if (valid.some((candidate) => !sameMarker(first.marker, candidate.marker))) {
    return Object.freeze({
      kind: "conflict",
      markers: Object.freeze(valid.map((candidate) => Object.freeze(candidate)))
    });
  }
  return Object.freeze({
    kind: "valid",
    marker: first.marker,
    filenames: Object.freeze(valid.map((candidate) => candidate.filename))
  });
}

function repositoryKindFor(type: FolderMarkerType): RepositoryIdentity["kind"] {
  return type === "workdesk" ? "workbench" : type;
}

function markerIdentity(marker: FolderMarker): { readonly type: FolderMarkerType; readonly id: string } {
  return { type: marker.type, id: marker.id };
}

async function readPresentationTitle(root: string, type: FolderMarkerType): Promise<string | undefined> {
  const candidates = type === "project" ? ["project.json", "manuscript.md"]
    : type === "workdesk" ? ["manuscript.md"]
      : ["library.json"];
  for (const filename of candidates) {
    try {
      const filePath = path.join(root, filename);
      const stats = await lstat(filePath);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 1024 * 1024) continue;
      const text = await readFile(filePath, "utf8");
      if (filename.endsWith(".json")) {
        const value: unknown = JSON.parse(text);
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          const record = value as Record<string, unknown>;
          const title = type === "shelf" ? record.name : record.title;
          if (typeof title === "string" && title.trim().length > 0) return title;
        }
      } else {
        const match = /^#\s+(.+?)\s*$/mu.exec(text);
        if (match?.[1]) return match[1].replace(/\\([\\`*_{}\[\]()#+.!|>~-])/gu, "$1");
      }
    } catch {
      // Presentation titles come from ordinary user data and are optional.
    }
  }
  return undefined;
}

function legacyApplies(identity: RepositoryIdentity, expectedType: FolderMarkerType): boolean {
  return identity.kind === repositoryKindFor(expectedType);
}

function markerFromLegacy(
  type: FolderMarkerType,
  id: string,
  parentWorkdeskId: string | null,
): FolderMarker {
  return type === "project"
    ? { version: 1, type, id, parent: parentWorkdeskId }
    : { version: 1, type, id };
}

async function writeMarkerExclusively(root: string, filename: string, text: string): Promise<void> {
  const markerPath = path.join(root, filename);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let ownedIdentity: { readonly dev: number; readonly ino: number } | undefined;
  try {
    handle = await open(markerPath, "wx", 0o644);
    const stats = await handle.stat();
    ownedIdentity = { dev: stats.dev, ino: stats.ino };
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } catch (error) {
    if (ownedIdentity) {
      try {
        const current = await lstat(markerPath);
        if (current.isFile() && !current.isSymbolicLink() && current.dev === ownedIdentity.dev && current.ino === ownedIdentity.ino) {
          await unlink(markerPath);
        }
      } catch {
        // Preserve paths which changed after our exclusive create.
      }
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Resolve or add one typed marker. A valid marker always wins over legacy
 * metadata. With no valid marker, a usable matching legacy UUID is migrated;
 * malformed legacy metadata is ignored and replaced by a new marker UUID.
 */
export async function ensureFolderMarker(
  root: string,
  type: FolderMarkerType,
  options: {
    readonly parentWorkdeskId?: string | null;
    readonly uuidFactory?: () => string;
    readonly createIfMissing?: boolean;
  } = {},
): Promise<EnsuredFolderMarker> {
  const canonicalRoot = await canonicalFolderRoot(root);
  const initial = await inspectFolderMarkers(canonicalRoot);
  if (initial.kind === "conflict") {
    throw new FolderMarkerError("marker-conflict", "This folder contains conflicting valid .magi markers. Resolve the marker conflict before continuing.");
  }
  let legacyIdentity: RepositoryIdentity | undefined;
  try {
    legacyIdentity = await readLegacyRepositoryIdentity(canonicalRoot, { allowIncompleteMarker: true });
  } catch {
    // Readable project documents, notes, and Shelf records remain usable when
    // optional legacy identity metadata is missing or malformed.
  }
  if (initial.kind === "valid") {
    if (initial.marker.type !== type) {
      throw new FolderMarkerError("wrong-type", `This folder is marked as ${initial.marker.type}, not ${type}.`);
    }
    const sameIdentityLegacy = legacyIdentity
      && legacyApplies(legacyIdentity, type)
      && legacyIdentity.id.toLowerCase() === initial.marker.id.toLowerCase()
      ? legacyIdentity
      : undefined;
    return Object.freeze({ marker: initial.marker, filenames: initial.filenames, source: "marker", ...(sameIdentityLegacy ? { legacyIdentity: sameIdentityLegacy } : {}) });
  }
  if (legacyIdentity && !legacyApplies(legacyIdentity, type)) {
    throw new FolderMarkerError("legacy-kind-conflict", "The existing legacy identity belongs to a different folder role.");
  }
  if (!legacyIdentity && options.createIfMissing === false) {
    throw new FolderMarkerError("missing-marker", "This folder has no usable identity marker yet.");
  }

  const uuid = legacyIdentity?.id ?? (options.uuidFactory ?? randomUUID)();
  const parent = type === "project" ? options.parentWorkdeskId ?? null : null;
  const marker = markerFromLegacy(type, uuid, parent);
  const repositoryCore = await loadRepositoryCore();
  const filename = repositoryCore.canonicalFolderMarkerFilename(type);
  try {
    await writeMarkerExclusively(canonicalRoot, filename, repositoryCore.serializeFolderMarker(marker));
  } catch (error) {
    // A concurrent process may have completed the same migration. Never
    // overwrite that result; re-read and accept only one unambiguous identity.
    const current = await inspectFolderMarkers(canonicalRoot).catch(() => undefined);
    if (current?.kind === "valid" && current.marker.type === type
      && current.marker.id.toLowerCase() === uuid.toLowerCase()
      && (type !== "project" || sameMarker(current.marker, marker))) {
      return Object.freeze({ marker: current.marker, filenames: current.filenames, source: "marker", ...(legacyIdentity ? { legacyIdentity } : {}) });
    }
    throw new FolderMarkerError("marker-write-failed", error instanceof Error ? error.message : "The folder marker could not be created safely.");
  }
  return Object.freeze({
    marker,
    filenames: Object.freeze([filename]),
    source: legacyIdentity ? "legacy" : "generated",
    ...(legacyIdentity ? { legacyIdentity } : {})
  });
}

/** Adapt the marker to the repository UI/history identity shape without adding fields to `.magi`. */
export async function repositoryIdentityFromMarker(
  root: string,
  marker: FolderMarker,
  legacyIdentity?: RepositoryIdentity,
): Promise<RepositoryIdentity> {
  const repositoryCore = await loadRepositoryCore();
  const kind = repositoryKindFor(marker.type);
  const title = legacyIdentity && legacyIdentity.id.toLowerCase() === marker.id.toLowerCase()
    && legacyApplies(legacyIdentity, marker.type)
    ? legacyIdentity.title
    : ((await readPresentationTitle(root, marker.type)) ?? path.basename(root))
      || (kind === "project" ? "Project" : kind === "workbench" ? "Workdesk" : "Private Shelf");
  let safeTitle = title;
  if (Array.from(safeTitle).length > 200) safeTitle = Array.from(safeTitle).slice(0, 200).join("");
  try {
    return repositoryCore.createIdentity(kind, safeTitle, marker.id);
  } catch {
    return repositoryCore.createIdentity(kind, kind === "project" ? "Project" : kind === "workbench" ? "Workdesk" : "Private Shelf", marker.id);
  }
}

export function effectiveFolderMarkerIdentity(marker: FolderMarker): string {
  const identity = markerIdentity(marker);
  return `${identity.type}:${identity.id.toLowerCase()}`;
}
