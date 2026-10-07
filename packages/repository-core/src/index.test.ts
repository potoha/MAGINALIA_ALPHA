import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAndValidate } from "@maginalia/format";
import {
  REPOSITORY_KIND_LABELS,
  createIdentity,
  isKnownRepositoryKind,
  parseIdentity,
  repositoryKindLabel,
  storageName,
  templateFiles,
  parseFolderMarkerText,
  serializeFolderMarker,
  canonicalFolderMarkerFilename,
  type RepositoryKind
} from "./index";

const PROJECT_UUID = "550e8400-e29b-41d4-a716-446655440000";
const WORKBENCH_UUID = "650e8400-e29b-41d4-a716-446655440000";
const SHELF_UUID = "750e8400-e29b-41d4-a716-446655440000";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function identity(kind: RepositoryKind, title: string, id = PROJECT_UUID) {
  return createIdentity(kind, title, id);
}

function expectInvalid(value: unknown): void {
  expect(() => parseIdentity(value)).toThrowError(
    expect.objectContaining({
      name: "RepositoryError",
      code: "invalid-identity",
      message: "The Project, Workbench, or Private Shelf identity is invalid."
    })
  );
}

describe("Repository Core identity", () => {
  it("supports exactly the three labelled repository kinds", () => {
    expect(REPOSITORY_KIND_LABELS).toEqual({
      project: "Project",
      workbench: "Workbench",
      shelf: "Private Shelf"
    });
    expect(repositoryKindLabel("project")).toBe("Project");
    expect(repositoryKindLabel("workbench")).toBe("Workbench");
    expect(repositoryKindLabel("shelf")).toBe("Private Shelf");
    expect(isKnownRepositoryKind("project")).toBe(true);
    expect(isKnownRepositoryKind("workbench")).toBe(true);
    expect(isKnownRepositoryKind("shelf")).toBe(true);
    expect(isKnownRepositoryKind("library")).toBe(false);
  });

  it("constructs and copies strict identities without generating UUIDs", () => {
    const original = {
      schemaVersion: 1,
      id: PROJECT_UUID,
      kind: "project",
      title: "日本語『研究／ノート』",
      templateVersion: 1
    } as const;
    const parsed = parseIdentity(original);
    expect(parsed).toEqual(original);
    expect(parsed).not.toBe(original);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(identity("workbench", "Workbench", WORKBENCH_UUID)).toMatchObject({
      schemaVersion: 1,
      id: WORKBENCH_UUID,
      kind: "workbench",
      title: "Workbench",
      templateVersion: 1
    });
    expect(storageName(identity("shelf", "Private Shelf", SHELF_UUID)))
      .toBe("maginalia-shelf-750e8400e29b41d4a716446655440000");
    expect(storageName(identity("project", "タイトル A", PROJECT_UUID)))
      .toBe(storageName(identity("project", "タイトル B", PROJECT_UUID)));
    expect(storageName(identity("project", "Title", PROJECT_UUID))).toMatch(
      /^maginalia-project-[0-9a-f]{32}$/
    );
    expect(UUID_PATTERN.test(parsed.id)).toBe(true);
    expect(storageName(identity("project", "Title", PROJECT_UUID)).includes("Title")).toBe(false);
  });

  it("rejects malformed fields, unknown keys, accessors, and prototypes", () => {
    const valid = identity("project", "Valid");
    const malformed: unknown[] = [
      null,
      [],
      { ...valid, schemaVersion: 2 },
      { ...valid, templateVersion: 2 },
      { ...valid, kind: "unknown" },
      { ...valid, id: "not-a-uuid" },
      { ...valid, title: "   " },
      { ...valid, extra: "unexpected" },
      { ...valid, [Symbol("extra")]: "unexpected" }
    ];
    for (const value of malformed) expectInvalid(value);

    const accessor = { ...valid };
    Object.defineProperty(accessor, "title", {
      enumerable: true,
      get: () => "accessor"
    });
    expectInvalid(accessor);

    const customPrototype = Object.assign(Object.create({ inherited: true }), valid);
    expectInvalid(customPrototype);
    const nullPrototype = Object.assign(Object.create(null), valid);
    expectInvalid(nullPrototype);
    expectInvalid(new Proxy(valid, {
      getOwnPropertyDescriptor: () => {
        throw new Error("descriptor trap");
      }
    }));

    expect(() => createIdentity("unknown" as RepositoryKind, "Title", PROJECT_UUID))
      .toThrowError(expect.objectContaining({ code: "invalid-kind" }));
    expect(() => createIdentity("project", "", PROJECT_UUID))
      .toThrowError(expect.objectContaining({ code: "invalid-title" }));
    expect(() => createIdentity("project", "Title", "not-a-uuid"))
      .toThrowError(expect.objectContaining({ code: "invalid-id" }));
  });

  it("bounds titles by Unicode code points and rejects all required controls", () => {
    expect(identity("project", "😀".repeat(200)).title).toHaveLength(400);
    for (const title of [
      "😀".repeat(201),
      "line\nbreak",
      "bell\u0007",
      "c1\u0085",
      "separator\u2028",
      "paragraph\u2029"
    ]) {
      expect(() => createIdentity("project", title, PROJECT_UUID))
        .toThrowError(expect.objectContaining({ code: "invalid-title" }));
    }
  });
});

describe("Repository Core templates", () => {
  it("generates the exact Project layout and validates canonical Format metadata", () => {
    const value = identity("project", "日本語 #題名 [安全] *", PROJECT_UUID);
    const files = templateFiles(value);
    expect(Object.keys(files).sort()).toEqual([
      ".gitignore",
      "README.md",
      "manuscript.md",
      "notes/README.md",
      "project.json",
      "project.magi"
    ]);
    expect(parseFolderMarkerText(files["project.magi"])).toEqual({
      version: 1, type: "project", id: value.id, parent: null
    });
    const project = parseAndValidate("project", files["project.json"]);
    expect(project).toMatchObject({ valid: true });
    if (project.valid) {
      expect(project.value.title).toBe(value.title);
      expect(project.value.visibility).toBe("private");
      expect(project.value.readme).toBe("README.md");
      expect(project.value.id).toMatch(/^project:[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    }
    expect(files["README.md"]).toContain("\\#題名");
    expect(files["README.md"]).toContain("\\[安全\\]");
    expect(files["README.md"]).toContain("\\*");
    expect(files["manuscript.md"]).toContain("\\#題名");
    expect(files["README.md"]).not.toContain("repository.json");
    expect(files["notes/README.md"]).toContain("ordinary portable text");

    const sameUuidDifferentTitle = templateFiles(identity("project", "別の題名", PROJECT_UUID));
    expect(JSON.parse(files["project.json"]).id).toBe(JSON.parse(sameUuidDifferentTitle["project.json"]).id);
  });

  it("generates a Workbench without project or Library metadata", () => {
    const files = templateFiles(identity("workbench", "Draft Workbench", WORKBENCH_UUID));
    expect(Object.keys(files).sort()).toEqual([
      ".gitignore",
      "README.md",
      "manuscript.md",
      "notes/README.md",
      "workdesk.magi"
    ]);
    expect(files["project.json"]).toBeUndefined();
    expect(files["library.json"]).toBeUndefined();
    expect(parseFolderMarkerText(files["workdesk.magi"])).toEqual({
      version: 1, type: "workdesk", id: WORKBENCH_UUID
    });
  });

  it("generates an empty Shelf compatible with Format v0.1", () => {
    const value = identity("shelf", "私有引用棚・『読書』", SHELF_UUID);
    const files = templateFiles(value);
    expect(Object.keys(files).sort()).toEqual([
      ".gitignore",
      "README.md",
      "annotations/README.md",
      "books/README.md",
      "covers/README.md",
      "library.json",
      "shelf.magi"
    ]);
    const library = parseAndValidate("library", files["library.json"]);
    expect(library).toMatchObject({ valid: true });
    if (library.valid) {
      expect(library.value).toEqual({
        type: "library",
        version: "0.1",
        name: value.title,
        booksPath: "books",
        annotationsPath: "annotations"
      });
    }
    expect(files["project.json"]).toBeUndefined();
    expect(files["manuscript.md"]).toBeUndefined();
    expect(files["README.md"]).toContain("private MAGINALIA Shelf");
    expect(files["books/README.md"]).toContain("Format v0.1");
    expect(files["annotations/README.md"]).toContain("Format v0.1");
    expect(files["covers/README.md"]).toContain("cover images");
  });

  it("writes an explicit Project parent Workdesk UUID and rejects invalid parents", () => {
    const files = templateFiles(identity("project", "Child", PROJECT_UUID), {
      parentWorkdeskId: WORKBENCH_UUID
    });
    expect(parseFolderMarkerText(files["project.magi"])).toEqual({
      version: 1, type: "project", id: PROJECT_UUID, parent: WORKBENCH_UUID
    });
    expect(() => templateFiles(identity("project", "Child", PROJECT_UUID), {
      parentWorkdeskId: "not-a-uuid"
    })).toThrow();
    expect(() => templateFiles(identity("shelf", "Shelf", SHELF_UUID), {
      parentWorkdeskId: WORKBENCH_UUID
    })).toThrow();
  });

  it("keeps templates deterministic, credential-safe, and host-independent", () => {
    const value = identity("project", "Title with `markdown` and \\\\ path", PROJECT_UUID);
    const first = templateFiles(value);
    const second = templateFiles(value);
    expect(second).toEqual(first);
    expect(first[".gitignore"]).toContain(".env*");
    expect(first[".gitignore"]).toContain("keys/");
    expect(first[".gitignore"]).toContain("*.key");
    expect(first[".gitignore"]).toContain("*.pem");
    expect(first[".gitignore"]).toContain(".maginalia-local");
    expect(first[".gitignore"]).toContain("node_modules/");
    expect(first[".gitignore"]).toContain("dist/");
    expect(first["README.md"]).toContain("\\`markdown\\`");
    expect(first["README.md"]).toContain("\\\\\\\\ path");
    for (const contents of Object.values(first)) {
      expect(contents).not.toMatch(/(password|secret|token|provider|account|sample quote|978[0-9]{10})/iu);
    }

    const domainSource = readFileSync(new URL("./domain.ts", import.meta.url), "utf8");
    const templateSource = readFileSync(new URL("./templates.ts", import.meta.url), "utf8");
    const markerSource = readFileSync(new URL("./folder-marker.ts", import.meta.url), "utf8");
    const implementationSource = domainSource + templateSource + markerSource;
    expect(implementationSource).not.toMatch(/node:(?:crypto|fs|path)/u);
    expect(implementationSource).not.toContain("electron");
    expect(implementationSource).not.toContain("randomUUID");
  });
});

describe("typed .magi marker codec", () => {
  it("round-trips all folder types and exposes canonical creation names", () => {
    const markers = [
      { version: 1, type: "project", id: PROJECT_UUID, parent: null },
      { version: 1, type: "workdesk", id: WORKBENCH_UUID },
      { version: 1, type: "shelf", id: SHELF_UUID }
    ] as const;
    for (const marker of markers) {
      const text = serializeFolderMarker(marker);
      expect(text).toContain("フォルダ識別子");
      expect(parseFolderMarkerText(text)).toEqual(marker);
    }
    expect(canonicalFolderMarkerFilename("project")).toBe("project.magi");
    expect(canonicalFolderMarkerFilename("workdesk")).toBe("workdesk.magi");
    expect(canonicalFolderMarkerFilename("shelf")).toBe("shelf.magi");
  });

  it("accepts whitespace and Unicode comments while validating structure strictly", () => {
    expect(parseFolderMarkerText("# 日本語コメント\n version  =  1 \n type = project\n id = " + PROJECT_UUID + "\n parent = null\n"))
      .toEqual({ version: 1, type: "project", id: PROJECT_UUID, parent: null });
    for (const text of [
      "version=1\ntype=project\nid=" + PROJECT_UUID,
      "version=1\ntype=project\nid=" + PROJECT_UUID + "\nparent=null\nparent=null",
      "version=2\ntype=project\nid=" + PROJECT_UUID + "\nparent=null",
      "version=1\ntype=unknown\nid=" + PROJECT_UUID,
      "version=1\ntype=project\nid=bad\nparent=null",
      "version=1\ntype=workdesk\nid=" + PROJECT_UUID + "\nparent=null",
      "version=1\ntype=shelf\nid=" + PROJECT_UUID + "\nextra=abc",
      "version=1\ntype=project\nid=" + PROJECT_UUID + "\nparent=null\nnot a field"
    ]) expect(() => parseFolderMarkerText(text)).toThrow();
    expect(() => serializeFolderMarker({ version: 1, type: "shelf", id: SHELF_UUID, parent: null } as never)).toThrow();
  });
});
