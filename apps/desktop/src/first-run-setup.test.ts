import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createIdentity, templateFiles } from "@maginalia/repository-core";
import { createPrivateShelfForSetup, FirstRunJournalStore, materializeTutorialProject } from "./first-run-setup.js";

const roots: string[] = [];
const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const tutorialRoot = path.join(repositoryRoot, "Tutorial_sample_setup");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("first-run materialization", () => {
  it("persists the setup journal and resumes its stage", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "maginalia-first-run-journal-"));
    roots.push(parent);
    const store = new FirstRunJournalStore(path.join(parent, "user-data", "first-run.json"));
    expect(await store.load()).toBeUndefined();
    await store.save({
      schemaVersion: 1,
      stage: "shelf",
      workdeskRoot: path.join(parent, "作業机"),
      workdeskIdentityId: "11111111-1111-4111-8111-111111111111",
      shelfIdentityId: "22222222-2222-4222-8222-222222222222",
    });
    expect(await store.load()).toMatchObject({ stage: "shelf", shelfIdentityId: "22222222-2222-4222-8222-222222222222" });
  });

  it("creates and seeds a typed Private Shelf without replacing its library or marker on retry", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "maginalia-first-run-shelf-"));
    roots.push(parent);
    const root = path.join(parent, "資料", "Private Shelf");
    const id = "33333333-3333-4333-8333-333333333333";
    const seedRoot = path.join(tutorialRoot, "private-shelf-seed");
    const manifest = path.join(tutorialRoot, "installer-copy-manifest.json");

    const first = await createPrivateShelfForSetup(root, id, seedRoot, manifest);
    const libraryBytes = await readFile(path.join(root, "library.json"));
    const markerBytes = await readFile(path.join(root, "shelf.magi"));
    expect(first.booksAdded).toBe(3);
    expect(first.annotationsAdded).toBe(3);

    const second = await createPrivateShelfForSetup(root, id, seedRoot, manifest);
    expect(second.booksAdded).toBe(0);
    expect(second.annotationsAdded).toBe(0);
    expect(await readFile(path.join(root, "library.json"))).toEqual(libraryBytes);
    expect(await readFile(path.join(root, "shelf.magi"))).toEqual(markerBytes);
  });

  it("materializes the Tutorial Project with the reserved identity, parent, and collision-safe Downloads image", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "maginalia-first-run-project-"));
    roots.push(parent);
    const projectRoot = path.join(parent, "作業机", "projects", "MAGINALIA はじめてのプロジェクト");
    const downloadsRoot = path.join(parent, "Downloads");
    await mkdir(path.dirname(projectRoot), { recursive: true });
    await mkdir(downloadsRoot);
    const unrelatedImage = Buffer.from("not the tutorial image");
    await writeFile(path.join(downloadsRoot, "MAGINALIA_チュートリアル_宮沢賢治.jpg"), unrelatedImage);
    const projectId = "44444444-4444-4444-8444-444444444444";
    const workdeskId = "55555555-5555-4555-8555-555555555555";
    const identity = createIdentity("project", "MAGINALIA はじめてのプロジェクト", projectId);
    const expectedCoreProjectJson = templateFiles(identity, { parentWorkdeskId: workdeskId })["project.json"];

    const result = await materializeTutorialProject({
      projectRoot,
      projectId,
      projectTitle: "MAGINALIA はじめてのプロジェクト",
      workdeskId,
      templateRoot: path.join(tutorialRoot, "project-template"),
      downloadsRoot,
    });
    expect(result.imageName).toBe("MAGINALIA_チュートリアル_宮沢賢治 (2).jpg");
    expect(await readFile(path.join(downloadsRoot, result.imageName))).not.toEqual(unrelatedImage);
    expect(await readFile(path.join(projectRoot, "project.json"), "utf8")).toBe(expectedCoreProjectJson);
    expect(await readFile(path.join(projectRoot, "sample-a_マキナの置き手紙.md"), "utf8")).toContain(result.imageName);
    expect(await readFile(path.join(projectRoot, "sample-c_引用から考える.md"), "utf8")).toContain(result.imageName);

    const authored = "自分で加えた文章\n";
    await writeFile(path.join(projectRoot, "sample-a_マキナの置き手紙.md"), authored);
    const retry = await materializeTutorialProject({
      projectRoot,
      projectId,
      projectTitle: "MAGINALIA はじめてのプロジェクト",
      workdeskId,
      templateRoot: path.join(tutorialRoot, "project-template"),
      downloadsRoot,
    });
    expect(retry.imageName).toBe(result.imageName);
    expect(retry.preservedFiles).toContain("sample-a_マキナの置き手紙.md");
    expect(await readFile(path.join(projectRoot, "sample-a_マキナの置き手紙.md"), "utf8")).toBe(authored);
  });
});
