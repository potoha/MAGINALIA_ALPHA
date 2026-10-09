import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseFolderMarkerText } from "@maginalia/repository-core";
import { FirstRunCoordinator } from "./first-run-coordinator.js";
import { LibraryService } from "./library-service.js";
import { FirstRunJournalStore } from "./first-run-setup.js";
import { ShelfLocationRegistry, SHELF_LOCATION_FILE_NAME } from "./shelf-location-registry.js";
import { FileWorkdeskPathStore, WorkdeskService } from "./workdesk-service.js";

const roots: string[] = [];
const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const tutorialRoot = path.join(repositoryRoot, "Tutorial_sample_setup");

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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
});
