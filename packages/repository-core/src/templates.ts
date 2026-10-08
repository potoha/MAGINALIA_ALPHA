import { assertValidEntity } from "@maginalia/format";
import {
  parseIdentity,
  type RepositoryIdentity
} from "./domain.js";
import { canonicalFolderMarkerFilename, serializeFolderMarker } from "./folder-marker.js";

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const GITIGNORE = [
  "# Credentials and machine-local state",
  ".env*",
  "keys/",
  "*.key",
  "*.pem",
  "*.p12",
  "*.pfx",
  ".maginalia-local",
  ".maginalia-local/",
  "",
  "# Dependencies and generated output",
  "node_modules/",
  "vendor/",
  "dist/",
  "build/",
  "out/",
  "coverage/",
  "target/",
  ".cache/",
  ""
].join("\n");

function escapeMarkdownText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/([`*_{}\[\]()#+\-.!|>~])/g, "\\$1")
    .replaceAll("<", "\\<");
}

function heading(title: string): string {
  return "# " + escapeMarkdownText(title) + "\n\n";
}

/**
 * Encode the repository UUID into the canonical 26-character Format ULID
 * payload without generating a new identifier.
 */
function ulidFromUuid(uuid: string): string {
  let value = BigInt("0x" + uuid.replaceAll("-", ""));
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = CROCKFORD_ALPHABET[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return encoded;
}

function projectJson(identity: RepositoryIdentity): string {
  const project = assertValidEntity("project", {
    type: "project",
    version: "0.1",
    id: "project:" + ulidFromUuid(identity.id),
    title: identity.title,
    visibility: "private",
    readme: "README.md"
  });
  return JSON.stringify(project, null, 2) + "\n";
}

function libraryJson(identity: RepositoryIdentity): string {
  const library = assertValidEntity("library", {
    type: "library",
    version: "0.1",
    name: identity.title,
    booksPath: "books",
    annotationsPath: "annotations"
  });
  return JSON.stringify(library, null, 2) + "\n";
}

function commonFiles(identity: RepositoryIdentity, folderMarker: string, parentWorkdeskId: string | null = null): Record<string, string> {
  return {
    [folderMarker]: serializeFolderMarker(identity.kind === "workbench"
      ? { version: 1, type: "workdesk", id: identity.id }
      : identity.kind === "project"
        ? { version: 1, type: "project", id: identity.id, parent: parentWorkdeskId }
        : { version: 1, type: "shelf", id: identity.id }),
    ".gitignore": GITIGNORE
  };
}

function projectFiles(identity: RepositoryIdentity, parentWorkdeskId: string | null): Record<string, string> {
  return {
    ...commonFiles(identity, canonicalFolderMarkerFilename("project"), parentWorkdeskId),
    "README.md": [
      heading(identity.title),
      "This directory is a portable MAGINALIA Project.",
      "",
      "The canonical manuscript is `manuscript.md`. Project metadata is in `project.json`, and local notes belong under `notes/`.",
      "These are ordinary local files and remain editable outside MAGINALIA or GitHub.",
      ""
    ].join("\n"),
    "manuscript.md": heading(identity.title),
    "project.json": projectJson(identity),
    "notes/README.md": "# Notes\n\nKeep working notes here as ordinary portable text.\n"
  };
}

function workbenchFiles(identity: RepositoryIdentity): Record<string, string> {
  return {
    ...commonFiles(identity, canonicalFolderMarkerFilename("workdesk")),
    "README.md": [
      heading(identity.title),
      "This directory is a portable MAGINALIA Workbench for drafting and working notes.",
      "",
      "The manuscript is `manuscript.md`; no project-level metadata is required.",
      "These are ordinary local files and remain editable outside MAGINALIA or GitHub.",
      ""
    ].join("\n"),
    "manuscript.md": heading(identity.title),
    "notes/README.md": "# Notes\n\nKeep working notes here as ordinary portable text.\n"
  };
}

function shelfFiles(identity: RepositoryIdentity): Record<string, string> {
  return {
    ...commonFiles(identity, canonicalFolderMarkerFilename("shelf")),
    "README.md": [
      heading(identity.title),
      "This directory is a private MAGINALIA Shelf.",
      "",
      "The canonical library metadata is in `library.json`. Books, annotations, and cover assets remain in their corresponding folders.",
      "Books and annotations use existing Format v0.1 JSON or YAML records; each annotation `source` links to a Book ID.",
      "A Shelf is not copied into a Project. These are ordinary local files and remain editable outside MAGINALIA or GitHub.",
      ""
    ].join("\n"),
    "library.json": libraryJson(identity),
    "books/README.md": "# Books\n\nStore canonical Format v0.1 book records here.\n",
    "annotations/README.md": "# Annotations\n\nStore canonical Format v0.1 annotation records here.\n",
    "covers/README.md": "# Covers\n\nStore cover images referenced by book records here.\n"
  };
}

/** Return deterministic UTF-8 text files for a new portable repository. */
export interface TemplateOptions {
  /** Parent Workdesk UUID for a Project; omitted means a standalone Project. */
  readonly parentWorkdeskId?: string | null;
}

export function templateFiles(identity: RepositoryIdentity, options: TemplateOptions = {}): Readonly<Record<string, string>> {
  const value = parseIdentity(identity);
  if (value.kind !== "project" && options.parentWorkdeskId !== undefined) {
    throw new TypeError("Only a Project marker can declare a parent Workdesk.");
  }
  const files = value.kind === "project"
    ? projectFiles(value, options.parentWorkdeskId ?? null)
    : value.kind === "workbench"
      ? workbenchFiles(value)
      : shelfFiles(value);
  return Object.freeze(files);
}
