import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateEntityId } from "@maginalia/format";
import { parseFolderMarkerText } from "@maginalia/repository-core";
import { FirstRunCoordinator } from "./first-run-coordinator.js";
import { LibraryService } from "./library-service.js";
import { FirstRunJournalStore } from "./first-run-setup.js";
import { ShelfLocationRegistry, SHELF_LOCATION_FILE_NAME } from "./shelf-location-registry.js";
import { FileWorkdeskPathStore, WorkdeskService } from "./workdesk-service.js";

const roots: string[] = [];
const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const tutorialRoot = path.join(repositoryRoot, "Tutorial_sample_setup");
const tutorialShelfRoot = path.join(tutorialRoot, "private-shelf-seed");

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createPopulatedExistingShelf(shelfRoot: string) {
  const libraryBytes = Buffer.from([
    "{",
    '    "annotationsPath": "records/research-notes",',
    '    "name": "私の研究用Shelf",',
    '    "type": "library",',
    '    "version": "0.1",',
    '    "booksPath": "records/research-books"',
    "}",
    "",
  ].join("\n"), "utf8");
  const markerBytes = Buffer.from("version = 1\ntype = shelf\nid = 66666666-6666-4666-8666-666666666666\n", "utf8");
  const booksRoot = path.join(shelfRoot, "records", "research-books");
  const annotationsRoot = path.join(shelfRoot, "records", "research-notes");
  await mkdir(booksRoot, { recursive: true });
  await mkdir(annotationsRoot, { recursive: true });
  await writeFile(path.join(shelfRoot, "library.json"), libraryBytes);
  await writeFile(path.join(shelfRoot, "shelf.magi"), markerBytes);

  const bookFiles = (await readdir(path.join(tutorialShelfRoot, "books"))).filter((name) => name.endsWith(".json"));
  const annotationFiles = (await readdir(path.join(tutorialShelfRoot, "annotations"))).filter((name) => name.endsWith(".json"));
  const seedBooks = await Promise.all(bookFiles.map(async (name) => ({
    name,
    bytes: await readFile(path.join(tutorialShelfRoot, "books", name)),
    value: JSON.parse(await readFile(path.join(tutorialShelfRoot, "books", name), "utf8")) as Record<string, unknown>,
  })));
  const seedAnnotations = await Promise.all(annotationFiles.map(async (name) => ({
    name,
    bytes: await readFile(path.join(tutorialShelfRoot, "annotations", name)),
    value: JSON.parse(await readFile(path.join(tutorialShelfRoot, "annotations", name), "utf8")) as Record<string, unknown>,
  })));
  const matchingAnnotation = seedAnnotations.find((entry) =>
    seedBooks.some((book) => book.value.id === entry.value.source));
  if (!matchingAnnotation) throw new Error("The tutorial seed must contain an annotation with a source Book.");
  const matchingBook = seedBooks.find((entry) => entry.value.id === matchingAnnotation.value.source);
  if (!matchingBook) throw new Error("The tutorial seed Annotation source Book is missing.");

  const matchingBookPath = path.join(booksRoot, "existing-matching-book.json");
  const matchingAnnotationPath = path.join(annotationsRoot, "existing-matching-annotation.json");
  await writeFile(matchingBookPath, matchingBook.bytes);
  await writeFile(matchingAnnotationPath, matchingAnnotation.bytes);

  const isbnPrefix = "978400000000";
  const isbnSum = [...isbnPrefix].reduce((sum, digit, index) => sum + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
  const userIsbn = `${isbnPrefix}${(10 - (isbnSum % 10)) % 10}`;
  const userBook = {
    ...matchingBook.value,
    id: `isbn:${userIsbn}`,
    isbn13: userIsbn,
    title: "利用者が追加した研究書",
    authors: ["利用者"],
  };
  const userAnnotation = {
    ...matchingAnnotation.value,
    id: generateEntityId("ann"),
    source: userBook.id,
    quote: "利用者が保存した引用です。",
    comment: "利用者が記したメモです。",
  };
  const userBookPath = path.join(booksRoot, "user-authored-book.json");
  const userAnnotationPath = path.join(annotationsRoot, "user-authored-annotation.json");
  const userBookBytes = Buffer.from(`${JSON.stringify(userBook, null, 2)}\n`, "utf8");
  const userAnnotationBytes = Buffer.from(`${JSON.stringify(userAnnotation, null, 2)}\n`, "utf8");
  await writeFile(userBookPath, userBookBytes);
  await writeFile(userAnnotationPath, userAnnotationBytes);

  return {
    libraryBytes,
    markerBytes,
    booksRoot,
    annotationsRoot,
    matchingBookPath,
    matchingBookRecord: matchingBook.value,
    matchingBookBytes: matchingBook.bytes,
    matchingAnnotationPath,
    matchingAnnotationRecord: matchingAnnotation.value,
    matchingAnnotationBytes: matchingAnnotation.bytes,
    userBookPath,
    userBookBytes,
    userAnnotationPath,
    userAnnotationBytes,
    seedBookCount: seedBooks.length,
    seedAnnotationCount: seedAnnotations.length,
  };
}

function createCoordinator(parent: string, workdeskRoot: string, shelfRoot: string) {
  const userData = path.join(parent, "profile");
  const journal = new FirstRunJournalStore(path.join(userData, "first-run.json"));
  const workdesks = new WorkdeskService(new FileWorkdeskPathStore(path.join(userData, "workdesk-paths.json")));
  const shelfLocations = new ShelfLocationRegistry(path.join(userData, SHELF_LOCATION_FILE_NAME));
  const pickFolder = vi.fn(async (title: string) => title.includes("Workdesk") ? workdeskRoot : shelfRoot);
  const coordinator = new FirstRunCoordinator({
    journal,
    workdesks,
    libraries: new LibraryService(),
    shelfLocations,
    tutorialRoot,
    downloadsRoot: path.join(parent, "Downloads"),
    defaultWorkdeskRoot: workdeskRoot,
    defaultShelfRoot: shelfRoot,
    pickFolder,
    confirmAdoption: vi.fn(async () => false),
  });
  return { coordinator, journal, pickFolder, workdesks };
}

describe("FirstRunCoordinator", () => {
  it("sets up a Workdesk, Private Shelf, Tutorial Project, and Downloads without replacing files on restart", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "maginalia-first-run-e2e-"));
    roots.push(parent);
    const userData = path.join(parent, "profile");
    const workdeskRoot = path.join(parent, "Documents", "MAGINALIA", "Workdesk");
    const shelfRoot = path.join(parent, "Documents", "MAGINALIA", "Private Shelf");
    const workdesks = new WorkdeskService(new FileWorkdeskPathStore(path.join(userData, "workdesk-paths.json")));
    const locations = new ShelfLocationRegistry(path.join(userData, SHELF_LOCATION_FILE_NAME));
    const pickFolder = vi.fn(async (title: string) => title.includes("Workdesk") ? workdeskRoot : shelfRoot);
    const coordinator = new FirstRunCoordinator({
      journal: new FirstRunJournalStore(path.join(userData, "first-run.json")),
      workdesks,
      libraries: new LibraryService(),
      shelfLocations: locations,
      tutorialRoot,
      downloadsRoot: path.join(parent, "Downloads"),
      defaultWorkdeskRoot: workdeskRoot,
      defaultShelfRoot: shelfRoot,
      pickFolder,
      confirmAdoption: vi.fn(async () => false),
    });

    const result = await coordinator.run({}, { workdeskMode: "new", privateShelfMode: "new", registerPublicShelf: false });
    expect(result).toMatchObject({ kind: "completed", projectTitle: "MAGINALIA はじめてのプロジェクト" });
    if (result.kind !== "completed") throw new Error("Expected first-run setup to complete.");
    expect(result.shelfSeed).toMatchObject({ booksAdded: 3, annotationsAdded: 3, conflicts: [] });

    const workdeskMarker = parseFolderMarkerText(await readFile(path.join(workdeskRoot, "workdesk.magi"), "utf8"));
    const shelfMarker = parseFolderMarkerText(await readFile(path.join(shelfRoot, "shelf.magi"), "utf8"));
    expect(workdeskMarker.type).toBe("workdesk");
    expect(shelfMarker.type).toBe("shelf");
    expect((await readdir(path.join(shelfRoot, "books"))).filter((name) => name.endsWith(".json"))).toHaveLength(3);
    expect((await readdir(path.join(shelfRoot, "annotations"))).filter((name) => name.endsWith(".json"))).toHaveLength(3);

    const projectRoot = path.join(workdeskRoot, "projects", "MAGINALIA はじめてのプロジェクト");
    const projectMarker = parseFolderMarkerText(await readFile(path.join(projectRoot, "project.magi"), "utf8"));
    expect(projectMarker).toMatchObject({ type: "project", parent: workdeskMarker.id });
    expect(JSON.parse(await readFile(path.join(projectRoot, "project.json"), "utf8"))).toMatchObject({ type: "project", version: "0.1" });
    const firstRunJournal = await new FirstRunJournalStore(path.join(userData, "first-run.json")).load();
    expect(firstRunJournal).toMatchObject({ stage: "complete", workdeskIdentityId: workdeskMarker.id, shelfIdentityId: shelfMarker.id });
    expect(firstRunJournal?.tutorialProjectIdentityId).toBe(projectMarker.id);
    expect(firstRunJournal?.downloadsImageName).toBe("MAGINALIA_チュートリアル_宮沢賢治.jpg");
    expect(await locations.load()).toMatchObject({ kind: "loaded", config: { privateShelf: { registry: shelfRoot } } });
    const restoredDesk = await workdesks.restorePrimary();
    if (restoredDesk === undefined || "kind" in restoredDesk) throw new Error("Expected the saved Workdesk to restore.");
    expect(restoredDesk.identity.id).toBe(workdeskMarker.id);
    expect(await workdesks.lastActiveContext(await workdesks.open(workdeskRoot))).toEqual({ kind: "project", projectIdentityId: projectMarker.id });

    const markerBytes = await readFile(path.join(projectRoot, "project.magi"));
    const tutorialText = "ユーザーが追加した文\n";
    await writeFile(path.join(projectRoot, "sample-a_マキナの置き手紙.md"), tutorialText);
    const repeated = await coordinator.run({}, { workdeskMode: "new", privateShelfMode: "new", registerPublicShelf: false });
    expect(repeated.kind).toBe("completed");
    expect(pickFolder).toHaveBeenCalledTimes(2);
    expect(await readFile(path.join(projectRoot, "project.magi"))).toEqual(markerBytes);
    expect(await readFile(path.join(projectRoot, "sample-a_マキナの置き手紙.md"), "utf8")).toBe(tutorialText);
  });

  it("completes and resumes onboarding with a populated existing Shelf and preserves its library bytes and collection paths", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "maginalia-first-run-existing-shelf-"));
    roots.push(parent);
    const workdeskRoot = path.join(parent, "Documents", "MAGINALIA", "Workdesk");
    const shelfRoot = path.join(parent, "Documents", "Research", "本棚");
    const shelf = await createPopulatedExistingShelf(shelfRoot);
    const { coordinator, journal, pickFolder } = createCoordinator(parent, workdeskRoot, shelfRoot);
    const choices = { workdeskMode: "new" as const, privateShelfMode: "existing" as const, registerPublicShelf: false };

    const first = await coordinator.run({}, choices);
    expect(first).toMatchObject({
      kind: "completed",
      shelfSeed: { booksAdded: shelf.seedBookCount - 1, annotationsAdded: shelf.seedAnnotationCount - 1, conflicts: [] },
    });
    if (first.kind !== "completed") throw new Error("Expected onboarding to complete with the existing Shelf.");

    expect(await readFile(path.join(shelfRoot, "library.json"))).toEqual(shelf.libraryBytes);
    expect(await readFile(path.join(shelfRoot, "shelf.magi"))).toEqual(shelf.markerBytes);
    expect(await readFile(shelf.matchingBookPath)).toEqual(shelf.matchingBookBytes);
    expect(await readFile(shelf.matchingAnnotationPath)).toEqual(shelf.matchingAnnotationBytes);
    expect(await readFile(shelf.userBookPath)).toEqual(shelf.userBookBytes);
    expect(await readFile(shelf.userAnnotationPath)).toEqual(shelf.userAnnotationBytes);
    expect((await readdir(shelf.booksRoot)).filter((name) => name.endsWith(".json"))).toHaveLength(shelf.seedBookCount + 1);
    expect((await readdir(shelf.annotationsRoot)).filter((name) => name.endsWith(".json"))).toHaveLength(shelf.seedAnnotationCount + 1);
    expect(await readdir(shelfRoot)).not.toContain("books");
    expect(await readdir(shelfRoot)).not.toContain("annotations");

    const completed = await journal.load();
    if (!completed) throw new Error("Expected the completed first-run journal.");
    await journal.save(Object.freeze({ ...completed, stage: "shelf" }));
    const resumed = await coordinator.run({}, choices);
    expect(resumed).toMatchObject({
      kind: "completed",
      shelfSeed: { booksAdded: 0, annotationsAdded: 0, conflicts: [] },
    });
    expect(pickFolder).toHaveBeenCalledTimes(2);
    expect((await readdir(shelf.booksRoot)).filter((name) => name.endsWith(".json"))).toHaveLength(shelf.seedBookCount + 1);
    expect((await readdir(shelf.annotationsRoot)).filter((name) => name.endsWith(".json"))).toHaveLength(shelf.seedAnnotationCount + 1);
    expect(await readFile(path.join(shelfRoot, "library.json"))).toEqual(shelf.libraryBytes);
    expect(await readFile(shelf.userBookPath)).toEqual(shelf.userBookBytes);
    expect(await readFile(shelf.userAnnotationPath)).toEqual(shelf.userAnnotationBytes);
  });

  it("reports a same-ID Shelf conflict through the onboarding route without blocking unrelated seed records", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "maginalia-first-run-existing-shelf-conflict-"));
    roots.push(parent);
    const workdeskRoot = path.join(parent, "Documents", "MAGINALIA", "Workdesk");
    const shelfRoot = path.join(parent, "Documents", "Research", "本棚");
    const shelf = await createPopulatedExistingShelf(shelfRoot);
    const conflictingBookBytes = Buffer.from(`${JSON.stringify({
      ...shelf.matchingBookRecord,
      title: "同じIDで内容が異なる利用者の記録",
    }, null, 2)}\n`, "utf8");
    await writeFile(shelf.matchingBookPath, conflictingBookBytes);
    const { coordinator } = createCoordinator(parent, workdeskRoot, shelfRoot);

    const result = await coordinator.run({}, {
      workdeskMode: "new",
      privateShelfMode: "existing",
      registerPublicShelf: false,
    });
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") throw new Error("Expected onboarding to complete despite a record conflict.");
    expect(result.shelfSeed.booksAdded).toBeGreaterThan(0);
    expect(result.shelfSeed.conflicts).toContainEqual({
      kind: "book",
      id: shelf.matchingBookRecord.id,
      reason: "same-id-different-content",
    });
    expect(result.shelfSeed.conflicts).toContainEqual({
      kind: "annotation",
      id: shelf.matchingAnnotationRecord.id,
      reason: "missing-source-book",
    });
    expect(await readFile(path.join(shelfRoot, "library.json"))).toEqual(shelf.libraryBytes);
    expect(await readFile(shelf.matchingBookPath)).toEqual(conflictingBookBytes);
    expect(await readFile(shelf.matchingAnnotationPath)).toEqual(shelf.matchingAnnotationBytes);
    expect(await readFile(shelf.userBookPath)).toEqual(shelf.userBookBytes);
    expect(await readFile(shelf.userAnnotationPath)).toEqual(shelf.userAnnotationBytes);
  });

  it("resumes a journaled new Shelf after its identity marker was written but before library initialization", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "maginalia-first-run-resume-new-shelf-"));
    roots.push(parent);
    const workdeskRoot = path.join(parent, "Documents", "MAGINALIA", "Workdesk");
    const shelfRoot = path.join(parent, "Documents", "MAGINALIA", "Private Shelf");
    const workdeskIdentityId = "77777777-7777-4777-8777-777777777777";
    const shelfIdentityId = "88888888-8888-4888-8888-888888888888";
    const { coordinator, journal, workdesks } = createCoordinator(parent, workdeskRoot, shelfRoot);
    await workdesks.createAtRootForSetup(workdeskRoot, "マイWorkdesk", workdeskIdentityId);
    await mkdir(shelfRoot, { recursive: true });
    const markerBytes = Buffer.from(`version = 1\ntype = shelf\nid = ${shelfIdentityId}\n`, "utf8");
    await writeFile(path.join(shelfRoot, "shelf.magi"), markerBytes);
    await journal.save({
      schemaVersion: 1,
      stage: "workdesk",
      workdeskMode: "new",
      workdeskRoot,
      workdeskIdentityId,
      privateShelfMode: "new",
      shelfRoot,
      shelfIdentityId,
    });

    const result = await coordinator.run({}, { workdeskMode: "new", privateShelfMode: "new", registerPublicShelf: false });
    expect(result).toMatchObject({ kind: "completed", shelfSeed: { booksAdded: 3, annotationsAdded: 3, conflicts: [] } });
    expect(await readFile(path.join(shelfRoot, "shelf.magi"))).toEqual(markerBytes);
    expect(JSON.parse(await readFile(path.join(shelfRoot, "library.json"), "utf8"))).toMatchObject({ version: "0.1", booksPath: "books", annotationsPath: "annotations" });
  });
});
