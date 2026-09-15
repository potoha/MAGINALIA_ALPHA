import { assertValidEntity } from "@maginalia/format";
import { IDENTITY_PATH, parseIdentity } from "./domain.js";
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
function escapeMarkdownText(value) {
    return value
        .replaceAll("\\", "\\\\")
        .replace(/[\r\n\u2028\u2029]+/g, " ")
        .replace(/([`*_{}\[\]()#+\-.!|>~])/g, "\\$1")
        .replaceAll("<", "\\<");
}
function heading(title) {
    return "# " + escapeMarkdownText(title) + "\n\n";
}
function identityJson(identity) {
    return JSON.stringify(identity, null, 2) + "\n";
}
/**
 * Encode the repository UUID into the canonical 26-character Format ULID
 * payload without generating a new identifier.
 */
function ulidFromUuid(uuid) {
    let value = BigInt("0x" + uuid.replaceAll("-", ""));
    let encoded = "";
    for (let index = 0; index < 26; index += 1) {
        encoded = CROCKFORD_ALPHABET[Number(value & 31n)] + encoded;
        value >>= 5n;
    }
    return encoded;
}
function projectJson(identity) {
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
function libraryJson(identity) {
    const library = assertValidEntity("library", {
        type: "library",
        version: "0.1",
        name: identity.title,
        booksPath: "books",
        annotationsPath: "annotations"
    });
    return JSON.stringify(library, null, 2) + "\n";
}
function commonFiles(identity) {
    return {
        [IDENTITY_PATH]: identityJson(identity),
        ".gitignore": GITIGNORE
    };
}
function projectFiles(identity) {
    return {
        ...commonFiles(identity),
        "README.md": [
            heading(identity.title),
            "This directory is a portable MAGINALIA Project.",
            "",
            "The canonical manuscript is `manuscript.md`. Project metadata is in `project.json`, and local notes belong under `notes/`.",
            "The `.maginalia/repository.json` file records the portable type, title, and template version.",
            "These are ordinary local files and remain editable outside MAGINALIA or GitHub.",
            ""
        ].join("\n"),
        "manuscript.md": heading(identity.title),
        "project.json": projectJson(identity),
        "notes/README.md": "# Notes\n\nKeep working notes here as ordinary portable text.\n"
    };
}
function workbenchFiles(identity) {
    return {
        ...commonFiles(identity),
        "README.md": [
            heading(identity.title),
            "This directory is a portable MAGINALIA Workbench for drafting and working notes.",
            "",
            "The manuscript is `manuscript.md`; no project-level metadata is required.",
            "The `.maginalia/repository.json` file records the portable type, title, and template version.",
            "These are ordinary local files and remain editable outside MAGINALIA or GitHub.",
            ""
        ].join("\n"),
        "manuscript.md": heading(identity.title),
        "notes/README.md": "# Notes\n\nKeep working notes here as ordinary portable text.\n"
    };
}
function shelfFiles(identity) {
    return {
        ...commonFiles(identity),
        "README.md": [
            heading(identity.title),
            "This directory is a private MAGINALIA Shelf.",
            "",
            "The canonical library metadata is in `library.json`. Books, annotations, and cover assets remain in their corresponding folders.",
            "The `.maginalia/repository.json` file records the portable type, title, and template version.",
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
export function templateFiles(identity) {
    const value = parseIdentity(identity);
    const files = value.kind === "project"
        ? projectFiles(value)
        : value.kind === "workbench"
            ? workbenchFiles(value)
            : shelfFiles(value);
    return Object.freeze(files);
}
