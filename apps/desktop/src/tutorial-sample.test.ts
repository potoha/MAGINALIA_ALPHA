import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createIdentity,
  parseFolderMarkerText,
  templateFiles,
  type FolderMarker
} from "@maginalia/repository-core";
import {
  parseAndValidate,
  parseShelfEntity,
  validateEntity,
  type Annotation,
  type Book
} from "@maginalia/format";
import { parseQuoteRef } from "@maginalia/writing-core";
import { linearizeProjectComposition, resolveProjectComposition, scanSyncedBlockMarkers } from "./renderer/synced-block";

const SOURCE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const TUTORIAL_ROOT = path.resolve(SOURCE_ROOT, "../../../Tutorial_sample_setup");
const PROJECT_UUID = "11111111-1111-4111-8111-111111111111";
const WORKDESK_UUID = "22222222-2222-4222-8222-222222222222";
const SHELF_UUID = "33333333-3333-4333-8333-333333333333";

interface TutorialManifest {
  readonly schemaVersion: number;
  readonly tutorialProjectTemplate: string;
  readonly privateShelfSeed: string;
  readonly entryDocument: string;
  readonly identityMaterialization: {
    readonly generator: string;
    readonly project: {
      readonly templateMarker: string;
      readonly canonicalMarker: string;
      readonly type: string;
      readonly projectUuidPlaceholder: string;
      readonly primaryWorkdeskUuidPlaceholder: string;
      readonly parentUuidSource: string;
      readonly formatProjectIdPlaceholder: string;
      readonly formatProjectIdSource: string;
      readonly generationRule: string;
    };
    readonly privateShelf: {
      readonly templateMarker: string;
      readonly canonicalMarker: string;
      readonly type: string;
      readonly shelfUuidPlaceholder: string;
      readonly generationRule: string;
      readonly existingShelfMarker: string;
    };
  };
  readonly downloads: readonly {
    readonly source: string;
    readonly targetFileName: string;
    readonly windowsTarget: string;
    readonly linuxTarget: string;
    readonly overwrite: boolean;
    readonly onNameConflict: string;
  }[];
  readonly exportTutorial: {
    readonly outputDirectory: string;
    readonly sourceDocument: string;
    readonly files: readonly string[];
  };
  readonly shelfPolicy: {
    readonly privateShelfRequired: boolean;
    readonly publicShelfAutoCreate: boolean;
    readonly seedMode: string;
    readonly seedRecordVersion: string;
    readonly existingShelfMarker: string;
    readonly existingLibraryJson: string;
    readonly missingEntity: string;
    readonly sameIdSameContent: string;
    readonly sameIdDifferentContent: string;
    readonly matchingBook: string;
  };
}

function tutorialPath(...parts: string[]): string {
  return path.join(TUTORIAL_ROOT, ...parts);
}

async function readTutorialText(...parts: string[]): Promise<string> {
  return readFile(tutorialPath(...parts), "utf8");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readManifest(): Promise<TutorialManifest> {
  return JSON.parse(await readTutorialText("installer-copy-manifest.json")) as TutorialManifest;
}

describe("Tutorial sample Project and Shelf contracts", () => {
  it("materializes typed folder markers and a matching Format Project ID through Repository Core", async () => {
    const manifest = await readManifest();
    expect(manifest.identityMaterialization.generator).toBe("@maginalia/repository-core.templateFiles");

    const projectTemplate = JSON.parse(await readTutorialText("project-template", "project.json.template")) as Record<string, unknown>;
    expect(projectTemplate.id).toBe(manifest.identityMaterialization.project.formatProjectIdPlaceholder);
    expect(projectTemplate.id).toBe("${GENERATED_PROJECT_FORMAT_ID}");

    const title = String(projectTemplate.title);
    const projectIdentity = createIdentity("project", title, PROJECT_UUID);
    const workdeskIdentity = createIdentity("workbench", "テスト用Workdesk", WORKDESK_UUID);
    const projectFiles = templateFiles(projectIdentity, { parentWorkdeskId: workdeskIdentity.id });
    const markerTemplate = await readTutorialText("project-template", "project.magi.template");
    const materializedMarker = markerTemplate
      .replaceAll(manifest.identityMaterialization.project.projectUuidPlaceholder, projectIdentity.id)
      .replaceAll(manifest.identityMaterialization.project.primaryWorkdeskUuidPlaceholder, workdeskIdentity.id);
    expect(materializedMarker).toBe(projectFiles["project.magi"]);

    const marker = parseFolderMarkerText(projectFiles["project.magi"]);
    expect(marker).toEqual({ version: 1, type: "project", id: PROJECT_UUID, parent: WORKDESK_UUID } satisfies FolderMarker);
    expect(marker.type).toBe(manifest.identityMaterialization.project.type);
    if (marker.type !== "project") throw new Error("Repository Core did not generate a Project marker.");
    expect(marker.parent).toBe(workdeskIdentity.id);

    const generatedProject = JSON.parse(projectFiles["project.json"]) as { readonly id: string };
    const materializedProject = { ...projectTemplate, id: generatedProject.id };
    const projectValidation = validateEntity("project", materializedProject);
    expect(projectValidation.valid).toBe(true);
    if (!projectValidation.valid) throw new Error(projectValidation.errors.join("; "));
    expect(projectValidation.value.id).toBe(generatedProject.id);
    expect(generatedProject.id).toMatch(/^project:[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
    expect(Object.keys(projectFiles)).not.toContain(".maginalia/repository.json");

    const shelfLibrary = JSON.parse(await readTutorialText("private-shelf-seed", "library.json")) as { readonly name: string };
    const shelfIdentity = createIdentity("shelf", shelfLibrary.name, SHELF_UUID);
    const shelfFiles = templateFiles(shelfIdentity);
    const shelfMarkerTemplate = await readTutorialText("private-shelf-seed", "shelf.magi.template");
    expect(shelfMarkerTemplate.replaceAll(manifest.identityMaterialization.privateShelf.shelfUuidPlaceholder, SHELF_UUID))
      .toBe(shelfFiles["shelf.magi"]);
    expect(parseFolderMarkerText(shelfFiles["shelf.magi"])).toEqual({ version: 1, type: "shelf", id: SHELF_UUID });
    expect(Object.keys(shelfFiles)).not.toContain(".maginalia/repository.json");

    expect(await exists(tutorialPath("project-template", ".maginalia", "repository.json.template"))).toBe(false);
    expect(await exists(tutorialPath("private-shelf-seed", ".maginalia", "repository.json.template"))).toBe(false);
  });

  it("validates the three v0.1 Books and Annotations and resolves every seeded QuoteRef", async () => {
    const manifest = await readManifest();
    const shelfRoot = manifest.privateShelfSeed;
    const libraryText = await readTutorialText(shelfRoot, "library.json");
    const library = parseAndValidate("library", libraryText);
    expect(library.valid).toBe(true);
    if (!library.valid) throw new Error(library.errors.join("; "));

    const bookNames = (await readdir(tutorialPath(shelfRoot, library.value.booksPath ?? "books")))
      .filter((name) => name.endsWith(".json"))
      .sort();
    const annotationNames = (await readdir(tutorialPath(shelfRoot, library.value.annotationsPath ?? "annotations")))
      .filter((name) => name.endsWith(".json"))
      .sort();
    expect(bookNames).toHaveLength(3);
    expect(annotationNames).toHaveLength(3);

    const books: Book[] = [];
    for (const name of bookNames) {
      const result = parseShelfEntity("book", await readTutorialText(shelfRoot, library.value.booksPath ?? "books", name));
      expect(result.valid).toBe(true);
      if (!result.valid) throw new Error(result.errors.join("; "));
      expect(result.value.version).toBe("0.1");
      books.push(result.value as Book);
    }

    const annotations: Annotation[] = [];
    for (const name of annotationNames) {
      const result = parseShelfEntity("annotation", await readTutorialText(shelfRoot, library.value.annotationsPath ?? "annotations", name));
      expect(result.valid).toBe(true);
      if (!result.valid) throw new Error(result.errors.join("; "));
      expect(result.value.version).toBe("0.1");
      annotations.push(result.value as Annotation);
    }

    const bookIds = new Set(books.map((book) => book.id));
    expect(books.map((book) => book.title).sort()).toEqual([
      "宮沢賢治全集1",
      "新編 銀河鉄道の夜",
      "読書と人生"
    ].sort());
    for (const annotation of annotations) {
      expect(bookIds.has(annotation.source)).toBe(true);
      expect(annotation.comment).toBeTruthy();
      expect(annotation.attribution).toBeTruthy();
      expect(annotation.location.page).toBeUndefined();
      expect(annotation.location.path).toBeTruthy();
    }
    expect(annotations.map((annotation) => [annotation.id, annotation.quote]).sort(([left], [right]) => left.localeCompare(right))).toEqual([
      ["ann:01JABCDEFGHJKMNPQRSTVWXYZ0", "わたくしといふ現象は\n仮定された有機交流電燈の\nひとつの青い照明です"],
      ["ann:01JABCDEFGHJKMNPQRSTVWXYZ1", "けれどもほんとうのさいわいは一体何だろう。"],
      ["ann:01JABCDEFGHJKMNPQRSTVWXYZ2", "読書は一種の技術である。"]
    ].sort(([left], [right]) => left.localeCompare(right)));

    const documentNames = [
      "sample-a_マキナの置き手紙.md",
      "sample-b_小さなレポート.md",
      "sample-c_引用から考える.md",
      "sample-d_書き出してみる.md"
    ];
    const quoteRefMarkers = (await Promise.all(documentNames.map((name => readTutorialText(manifest.tutorialProjectTemplate, name)))))
      .flatMap((text) => [...text.matchAll(/<!-- maginalia:quote-ref v1 \{[^}]+\} -->/gu)].map((match) => match[0]!));
    expect(quoteRefMarkers).toHaveLength(2);
    for (const marker of quoteRefMarkers) {
      const quoteRef = parseQuoteRef(marker);
      expect(quoteRef).not.toBeNull();
      if (quoteRef === null) throw new Error("Tutorial contains an invalid QuoteRef.");
      expect(annotations.some((annotation) => annotation.id === quoteRef.quoteId)).toBe(true);
    }
    expect(quoteRefMarkers.map((marker) => parseQuoteRef(marker)!.quoteId).sort()).toEqual([
      "ann:01JABCDEFGHJKMNPQRSTVWXYZ0",
      "ann:01JABCDEFGHJKMNPQRSTVWXYZ2"
    ]);
  });

  it("resolves the sample-b Synced Block from the authoritative sample-c source", async () => {
    const manifest = await readManifest();
    const projectRoot = manifest.tutorialProjectTemplate;
    const bodyName = "sample-b_小さなレポート.md";
    const draftName = "sample-c_引用から考える.md";
    const body = await readTutorialText(projectRoot, bodyName);
    const draft = await readTutorialText(projectRoot, draftName);
    const occurrences = scanSyncedBlockMarkers(body);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({ kind: "valid", target: draftName });

    const sources = new Map([[draftName, draft]]);
    const composition = await resolveProjectComposition(body, {
      rootTarget: bodyName,
      resolve: async (target) => {
        const text = sources.get(target);
        return text === undefined
          ? { kind: "missing", message: "Tutorial Synced Block target is missing." }
          : { kind: "resolved", target, fileId: target, displayName: target, text };
      }
    });
    expect(composition.resolvedCount).toBe(1);
    const linear = linearizeProjectComposition(body, composition);
    expect(linear.kind).toBe("linear");
    if (linear.kind !== "linear") throw new Error(linear.message);
    expect(linear.markdown).toContain("私は、文章を読むときに「覚えておこう」と思って");
    expect(linear.markdown).not.toContain("maginalia:synced-block v1");
    expect(body).toContain("maginalia:synced-block v1");
    expect(body).not.toContain("私は、文章を読むときに「覚えておこう」と思って");
    expect(draft).toContain("私は、文章を読むときに「覚えておこう」と思って");
  });

  it("keeps manifest paths, tutorial UI steps, assets, provenance, and non-destructive seed rules aligned", async () => {
    const manifest = await readManifest();
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.shelfPolicy).toMatchObject({
      privateShelfRequired: true,
      publicShelfAutoCreate: false,
      seedMode: "idempotent-non-destructive",
      seedRecordVersion: "0.1",
      existingShelfMarker: "preserve",
      existingLibraryJson: "preserve",
      missingEntity: "add",
      sameIdSameContent: "preserve-existing",
      sameIdDifferentContent: "explicit-conflict-no-overwrite",
      matchingBook: "preserve-existing"
    });
    expect(manifest.downloads[0]).toMatchObject({
      targetFileName: "MAGINALIA_チュートリアル_宮沢賢治.jpg",
      windowsTarget: "KnownFolder:Downloads",
      linuxTarget: "XDG_DOWNLOAD_DIR",
      overwrite: false,
      onNameConflict: "choose-collision-safe-name-and-update-tutorial-text"
    });

    const referencedPaths = [
      manifest.identityMaterialization.project.templateMarker,
      manifest.identityMaterialization.privateShelf.templateMarker,
      manifest.downloads[0]!.source,
      path.join(manifest.tutorialProjectTemplate, manifest.entryDocument),
      path.join(manifest.tutorialProjectTemplate, manifest.exportTutorial.sourceDocument),
      path.join(manifest.privateShelfSeed, "library.json")
    ];
    for (const relativePath of referencedPaths) expect(await exists(tutorialPath(relativePath))).toBe(true);

    const expectedDocuments = [
      "sample-a_マキナの置き手紙.md",
      "sample-b_小さなレポート.md",
      "sample-c_引用から考える.md",
      "sample-d_書き出してみる.md"
    ];
    const actualDocuments = await readdir(tutorialPath(manifest.tutorialProjectTemplate));
    for (const name of expectedDocuments) expect(actualDocuments).toContain(name);
    expect(manifest.exportTutorial.files).toEqual([
      "MAGINALIA_チュートリアル_小さなレポート.md",
      "MAGINALIA_チュートリアル_小さなレポート.pdf",
      "MAGINALIA_チュートリアル_小さなレポート.docx"
    ]);

    const imageBytes = await readFile(tutorialPath(manifest.downloads[0]!.source));
    expect(imageBytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(imageBytes.length).toBeGreaterThan(0);
    const imageSource = await readTutorialText("resources", "IMAGE_SOURCE.md");
    const sources = await readTutorialText("SOURCES.md");
    expect(imageSource).toContain("https://commons.wikimedia.org/wiki/File:Miyazawa_Kenji.jpg");
    expect(imageSource).toContain("Public Domain in Japan and the United States");
    expect(sources).toContain("青空文庫図書カード");
    expect(sources).toContain("9784101092058");

    const sampleA = await readTutorialText(manifest.tutorialProjectTemplate, "sample-a_マキナの置き手紙.md");
    const sampleC = await readTutorialText(manifest.tutorialProjectTemplate, "sample-c_引用から考える.md");
    const sampleD = await readTutorialText(manifest.tutorialProjectTemplate, "sample-d_書き出してみる.md");
    const coreCommands = await readFile(path.join(SOURCE_ROOT, "renderer", "core-commands.ts"), "utf8");
    const rendererMain = await readFile(path.join(SOURCE_ROOT, "renderer", "main.ts"), "utf8");
    expect(sampleA).toContain("さいわい");
    expect(sampleA).toContain(manifest.downloads[0]!.targetFileName);
    expect(sampleC).toContain(manifest.downloads[0]!.targetFileName);
    expect(sampleD).toContain("Preview");
    expect(sampleD).toContain("Refresh References");
    for (const title of ["Export Markdown", "Export PDF", "Export DOCX", "Refresh References"]) {
      expect(coreCommands).toContain(`"${title}"`);
    }
    expect(rendererMain).toContain(">Preview</button>");
    expect(rendererMain).toContain("data-unified-search-mode=\"shelf\"");
    expect(rendererMain).toContain(">Search</button>");

    for (const name of expectedDocuments) {
      const text = await readTutorialText(manifest.tutorialProjectTemplate, name);
      expect(text).not.toContain("\uFFFD");
    }
  });
});
