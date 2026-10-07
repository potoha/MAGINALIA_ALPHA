import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createIdentity, parseFolderMarkerText, serializeFolderMarker } from "@maginalia/repository-core";
import { ensureFolderMarker, inspectFolderMarkers } from "./folder-identity.js";

const roots: string[] = [];
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const WORKDESK_ID = "22222222-2222-4222-8222-222222222222";
const SHELF_ID = "33333333-3333-4333-8333-333333333333";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "maginalia-identity-"));
  roots.push(parent);
  const root = path.join(parent, "研究資料", "卒論・引用棚");
  await mkdir(root, { recursive: true });
  return root;
}

async function writeMarker(root: string, filename: string, text: string): Promise<void> {
  await writeFile(path.join(root, filename), text, "utf8");
}

describe("typed folder identity", () => {
  it("recognizes renamed Unicode markers by payload and keeps same-identity duplicates conservative", async () => {
    const root = await tempRoot();
    const marker = { version: 1, type: "project", id: PROJECT_ID, parent: WORKDESK_ID } as const;
    await writeMarker(root, "卒論.magi", serializeFolderMarker(marker));

    const first = await ensureFolderMarker(root, "project");
    expect(first.marker).toEqual(marker);
    expect(first.filenames).toEqual(["卒論.magi"]);
    expect(await readdir(root)).toEqual(["卒論.magi"]);

    await writeMarker(root, "draft-name.magi", serializeFolderMarker(marker));
    const duplicate = await ensureFolderMarker(root, "project");
    expect(duplicate.marker).toEqual(marker);
    expect(new Set(duplicate.filenames)).toEqual(new Set(["draft-name.magi", "卒論.magi"]));
    expect(await readdir(root)).toHaveLength(2);
  });

  it("recognizes renamed Workdesk and Shelf markers from their typed payloads", async () => {
    const workdeskRoot = await tempRoot();
    const shelfRoot = await tempRoot();
    await writeMarker(workdeskRoot, "作業机.magi", serializeFolderMarker({ version: 1, type: "workdesk", id: WORKDESK_ID }));
    await writeMarker(shelfRoot, "本棚.magi", serializeFolderMarker({ version: 1, type: "shelf", id: SHELF_ID }));

    expect(await ensureFolderMarker(workdeskRoot, "workdesk")).toMatchObject({
      marker: { type: "workdesk", id: WORKDESK_ID },
      filenames: ["作業机.magi"],
      source: "marker",
    });
    expect(await ensureFolderMarker(shelfRoot, "shelf")).toMatchObject({
      marker: { type: "shelf", id: SHELF_ID },
      filenames: ["本棚.magi"],
      source: "marker",
    });
  });

  it("creates canonical names for each role and validates their round trips", async () => {
    const projectRoot = await tempRoot();
    const workdeskRoot = await tempRoot();
    const shelfRoot = await tempRoot();
    const workdesk = await ensureFolderMarker(workdeskRoot, "workdesk", { uuidFactory: () => WORKDESK_ID });
    const project = await ensureFolderMarker(projectRoot, "project", {
      parentWorkdeskId: workdesk.marker.id,
      uuidFactory: () => PROJECT_ID,
    });
    const shelf = await ensureFolderMarker(shelfRoot, "shelf", { uuidFactory: () => SHELF_ID });

    expect(workdesk.filenames).toEqual(["workdesk.magi"]);
    expect(project.filenames).toEqual(["project.magi"]);
    expect(shelf.filenames).toEqual(["shelf.magi"]);
    expect(parseFolderMarkerText(await readFile(path.join(projectRoot, "project.magi"), "utf8"))).toEqual({
      version: 1, type: "project", id: PROJECT_ID, parent: WORKDESK_ID,
    });
  });

  it("reuses valid legacy UUIDs and does not change legacy metadata", async () => {
    const root = await tempRoot();
    const legacy = createIdentity("shelf", "Legacy Shelf", SHELF_ID);
    const legacyPath = path.join(root, ".maginalia", "repository.json");
    await mkdir(path.dirname(legacyPath));
    const legacyText = `${JSON.stringify(legacy, null, 2)}\n`;
    await writeFile(legacyPath, legacyText, "utf8");

    const result = await ensureFolderMarker(root, "shelf", { uuidFactory: () => PROJECT_ID });

    expect(result.source).toBe("legacy");
    expect(result.marker).toEqual({ version: 1, type: "shelf", id: SHELF_ID });
    expect(await readFile(legacyPath, "utf8")).toBe(legacyText);
  });

  it("migrates a legacy Project UUID while recording the chosen Workdesk parent", async () => {
    const root = await tempRoot();
    const legacy = createIdentity("project", "Legacy Project", PROJECT_ID);
    const legacyPath = path.join(root, ".maginalia", "repository.json");
    await mkdir(path.dirname(legacyPath));
    const legacyText = `${JSON.stringify(legacy, null, 2)}\n`;
    await writeFile(legacyPath, legacyText, "utf8");

    const result = await ensureFolderMarker(root, "project", { parentWorkdeskId: WORKDESK_ID });

    expect(result.marker).toEqual({ version: 1, type: "project", id: PROJECT_ID, parent: WORKDESK_ID });
    expect(await readFile(legacyPath, "utf8")).toBe(legacyText);
  });

  it("repairs malformed legacy identity without changing readable authored files", async () => {
    const root = await tempRoot();
    const authoredPath = path.join(root, "序論.md");
    const authoredText = "# 研究ノート\n本文はそのままです。\n";
    await writeFile(authoredPath, authoredText, "utf8");
    const legacyPath = path.join(root, ".maginalia", "repository.json");
    await mkdir(path.dirname(legacyPath));
    await writeFile(legacyPath, "{broken\n", "utf8");

    const result = await ensureFolderMarker(root, "project", { uuidFactory: () => PROJECT_ID });

    expect(result.source).toBe("generated");
    expect(result.marker.id).toBe(PROJECT_ID);
    expect(await readFile(authoredPath, "utf8")).toBe(authoredText);
    expect(await readFile(legacyPath, "utf8")).toBe("{broken\n");
  });

  it("surfaces conflicting valid markers without choosing a basename or writing another identity", async () => {
    const root = await tempRoot();
    await writeMarker(root, "project.magi", serializeFolderMarker({ version: 1, type: "project", id: PROJECT_ID, parent: null }));
    await writeMarker(root, "卒論.magi", serializeFolderMarker({ version: 1, type: "project", id: SHELF_ID, parent: null }));

    await expect(ensureFolderMarker(root, "project")).rejects.toMatchObject({ code: "marker-conflict" });
    const inspection = await inspectFolderMarkers(root);
    expect(inspection.kind).toBe("conflict");
    expect(new Set(await readdir(root))).toEqual(new Set(["project.magi", "卒論.magi"]));
  });

  it("does not recursively discover descendant markers", async () => {
    const root = await tempRoot();
    const child = path.join(root, "資料");
    await mkdir(child);
    await writeMarker(child, "作業机.magi", serializeFolderMarker({ version: 1, type: "workdesk", id: WORKDESK_ID }));

    expect(await inspectFolderMarkers(root)).toEqual({ kind: "missing", invalidFiles: [] });
  });
});
