import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { createFolderMarker, inspectFolderMarkers } from "./folder-identity.js";
import { materializeTutorialShelfSeed, type TutorialSeedResult } from "./tutorial-seed.js";

type RepositoryCore = typeof import("@maginalia/repository-core", { with: { "resolution-mode": "import" } });
let repositoryCorePromise: Promise<RepositoryCore> | undefined;

function loadRepositoryCore(): Promise<RepositoryCore> {
  repositoryCorePromise ??= import("@maginalia/repository-core");
  return repositoryCorePromise;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEFAULT_TUTORIAL_IMAGE = "MAGINALIA_チュートリアル_宮沢賢治.jpg";

export type FirstRunStage = "start" | "workdesk" | "shelf" | "tutorial" | "complete";

export interface FirstRunJournal {
  readonly schemaVersion: 1;
  readonly stage: FirstRunStage;
  readonly workdeskMode?: "new" | "existing";
  readonly workdeskRoot?: string;
  readonly workdeskIdentityId?: string;
  readonly privateShelfMode?: "new" | "existing";
  readonly shelfRoot?: string;
  readonly shelfIdentityId?: string;
  readonly publicShelfChecked?: boolean;
  readonly publicShelfRoot?: string;
  readonly tutorialProjectRoot?: string;
  readonly tutorialProjectIdentityId?: string;
  readonly tutorialProjectTitle?: string;
  readonly downloadsImageName?: string;
  readonly shelfSeedResult?: TutorialSeedResult;
}

export class FirstRunSetupError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "FirstRunSetupError";
  }
}

function validJournal(value: unknown): value is FirstRunJournal {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || !["start", "workdesk", "shelf", "tutorial", "complete"].includes(String(record.stage))) return false;
  if (record.workdeskMode !== undefined && record.workdeskMode !== "new" && record.workdeskMode !== "existing") return false;
  if (record.privateShelfMode !== undefined && record.privateShelfMode !== "new" && record.privateShelfMode !== "existing") return false;
  if (record.publicShelfChecked !== undefined && typeof record.publicShelfChecked !== "boolean") return false;
  for (const key of ["workdeskRoot", "shelfRoot", "publicShelfRoot", "tutorialProjectRoot"] as const) {
    if (record[key] !== undefined && (typeof record[key] !== "string" || !path.isAbsolute(record[key]))) return false;
  }
  for (const key of ["workdeskIdentityId", "shelfIdentityId", "tutorialProjectIdentityId"] as const) {
    if (record[key] !== undefined && (typeof record[key] !== "string" || !UUID_PATTERN.test(record[key]))) return false;
  }
  for (const key of ["tutorialProjectTitle", "downloadsImageName"] as const) {
    if (record[key] !== undefined && typeof record[key] !== "string") return false;
  }
  return true;
}

/** Durable app-local journal. It stores paths and reserved identities only, never research content. */
export class FirstRunJournalStore {
  public constructor(private readonly filePath: string) {
    if (!path.isAbsolute(filePath)) throw new Error("The first-run journal path must be absolute.");
  }

  public async load(): Promise<FirstRunJournal | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      if (!validJournal(value)) throw new FirstRunSetupError("MAGINALIAの初回設定を読み取れませんでした。設定内容を確認してから、もう一度お試しください。");
      return Object.freeze({ ...value });
    } catch (error: unknown) {
      const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code === "ENOENT") return undefined;
      if (error instanceof FirstRunSetupError) throw error;
      throw new FirstRunSetupError("MAGINALIAの初回設定を読み取れませんでした。設定内容を確認してから、もう一度お試しください。");
    }
  }

  public async save(journal: FirstRunJournal): Promise<void> {
    if (!validJournal(journal)) throw new FirstRunSetupError("初回設定の保存内容を確認できませんでした。");
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    try {
      await rename(temporary, this.filePath);
    } catch (error: unknown) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

async function writeUtf8Exclusive(directory: string, filename: string, contents: string): Promise<boolean> {
  const destination = path.join(directory, filename);
  const temporary = path.join(directory, `.${filename}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o644);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, destination);
      return true;
    } catch (error: unknown) {
      const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code === "EEXIST") return false;
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function writeBufferExclusive(destination: string, contents: Buffer): Promise<boolean> {
  const directory = path.dirname(destination);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(destination)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o644);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, destination);
      return true;
    } catch (error: unknown) {
      const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code === "EEXIST") return false;
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function assertSafeDirectory(root: string, create: boolean): Promise<string> {
  if (!path.isAbsolute(root)) throw new FirstRunSetupError("選んだ保存場所を確認できませんでした。");
  if (create) await mkdir(root, { recursive: true });
  try {
    const stats = await lstat(root);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("unsafe");
    return await realpath(root);
  } catch {
    throw new FirstRunSetupError("選んだ保存場所を開けませんでした。別の場所を選んでください。");
  }
}

async function walkTemplateFiles(root: string, relative = ""): Promise<Array<{ readonly relative: string; readonly contents: string }>> {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const output: Array<{ readonly relative: string; readonly contents: string }> = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    const childPath = path.join(root, childRelative);
    if (entry.isSymbolicLink()) throw new FirstRunSetupError("チュートリアル資料の一部を安全に読み取れませんでした。");
    if (entry.isDirectory()) {
      output.push(...await walkTemplateFiles(root, childRelative));
    } else if (entry.isFile()) {
      if (entry.name.endsWith(".template") || childRelative.split(path.sep).some((segment) => segment === ".maginalia" || segment === ".git")) continue;
      output.push({ relative: childRelative.split(path.sep).join("/"), contents: await readFile(childPath, "utf8") });
    }
  }
  return output;
}

function validateRelative(relative: string): string[] {
  const segments = relative.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || segment.includes(":"))) {
    throw new FirstRunSetupError("チュートリアル資料の保存先を確認できませんでした。");
  }
  return segments;
}

/** Create/registering-time identity writer for a new Shelf. Existing folder contents are preserved. */
export async function createPrivateShelfForSetup(
  root: string,
  identityId: string,
  seedRoot: string,
  manifestPath: string,
): Promise<TutorialSeedResult> {
  if (!UUID_PATTERN.test(identityId)) throw new FirstRunSetupError("Shelfの管理情報を準備できませんでした。");
  const canonicalRoot = await assertSafeDirectory(root, true);
  const markerState = await inspectFolderMarkers(canonicalRoot);
  if (markerState.kind === "conflict") throw new FirstRunSetupError("この場所には異なる管理情報があります。別の場所を選んでください。");
  if (markerState.kind === "valid" && (markerState.marker.type !== "shelf" || markerState.marker.id.toLowerCase() !== identityId.toLowerCase())) {
    throw new FirstRunSetupError("この場所には別のデータがあります。内容はそのまま残しています。");
  }
  if (markerState.kind === "missing") {
    if ((await readdir(canonicalRoot)).length > 0) throw new FirstRunSetupError("選んだ場所に既存ファイルがあります。既存Shelfを選ぶか、空の場所を選んでください。");
    const created = await createFolderMarker(canonicalRoot, "shelf", { uuidFactory: () => identityId });
    if (created.marker.id.toLowerCase() !== identityId.toLowerCase()) throw new FirstRunSetupError("Shelfの管理情報が一致しません。");
  }

  const seedCanonical = await assertSafeDirectory(seedRoot, false);
  const seedLibrary = await readFile(path.join(seedCanonical, "library.json"));
  const libraryPath = path.join(canonicalRoot, "library.json");
  if (!await writeBufferExclusive(libraryPath, seedLibrary)) {
    if (!(await readFile(libraryPath)).equals(seedLibrary)) {
      throw new FirstRunSetupError("既存のShelf一覧はそのまま残しました。内容を確認してください。");
    }
  }
  return materializeTutorialShelfSeed(manifestPath, canonicalRoot);
}

export interface TutorialProjectMaterialization {
  readonly canonicalRoot: string;
  readonly identityId: string;
  readonly title: string;
  readonly imageName: string;
  readonly preservedFiles: readonly string[];
}

/** Materialize the bundled Tutorial Project without replacing an existing Project or authored files. */
export async function materializeTutorialProject(options: {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly projectTitle: string;
  readonly workdeskId: string;
  readonly templateRoot: string;
  readonly downloadsRoot: string;
}): Promise<TutorialProjectMaterialization> {
  const { projectRoot, projectId, projectTitle, workdeskId, templateRoot, downloadsRoot } = options;
  if (!UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(workdeskId) || !path.isAbsolute(projectRoot)) {
    throw new FirstRunSetupError("チュートリアルProjectの管理情報を準備できませんでした。");
  }
  const canonicalProject = await assertSafeDirectory(projectRoot, true);
  const markers = await inspectFolderMarkers(canonicalProject);
  if (markers.kind === "conflict") throw new FirstRunSetupError("チュートリアルProjectに異なる管理情報が見つかりました。ファイルはそのまま残しています。");
  if (markers.kind === "valid") {
    if (markers.marker.type !== "project" || markers.marker.id.toLowerCase() !== projectId.toLowerCase()
      || markers.marker.parent?.toLowerCase() !== workdeskId.toLowerCase()) {
      throw new FirstRunSetupError("同じ名前のProjectがすでにあります。既存の内容は変更していません。");
    }
  } else {
    if ((await readdir(canonicalProject)).length > 0) {
      throw new FirstRunSetupError("同じ名前のフォルダーにファイルがあります。既存の内容は変更していません。");
    }
    const marker = await createFolderMarker(canonicalProject, "project", {
      parentWorkdeskId: workdeskId,
      uuidFactory: () => projectId,
    });
    if (marker.marker.type !== "project" || marker.marker.id.toLowerCase() !== projectId.toLowerCase()
      || marker.marker.parent?.toLowerCase() !== workdeskId.toLowerCase()) {
      throw new FirstRunSetupError("チュートリアルProjectの管理情報が一致しません。");
    }
  }

  const repositoryCore = await loadRepositoryCore();
  const identity = repositoryCore.createIdentity("project", projectTitle, projectId);
  const coreFiles = repositoryCore.templateFiles(identity, { parentWorkdeskId: workdeskId });
  const markerFilename = repositoryCore.canonicalFolderMarkerFilename("project");
  for (const [relative, contents] of Object.entries(coreFiles).sort(([left], [right]) => left.localeCompare(right))) {
    if (relative === markerFilename || relative === "README.md") continue;
    const segments = validateRelative(relative);
    let parent = canonicalProject;
    for (const segment of segments.slice(0, -1)) {
      parent = path.join(parent, segment);
      try { await mkdir(parent); }
      catch (error: unknown) {
        const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
        if (code !== "EEXIST") throw error;
        const existing = await lstat(parent);
        if (!existing.isDirectory() || existing.isSymbolicLink()) throw new FirstRunSetupError("Project内の保存先が安全ではありません。");
      }
    }
    await writeUtf8Exclusive(parent, segments.at(-1)!, contents);
  }

  const tutorialFiles = await walkTemplateFiles(await assertSafeDirectory(templateRoot, false));
  const imageSource = path.join(path.dirname(templateRoot), "resources", DEFAULT_TUTORIAL_IMAGE);
  const imageBytes = await readFile(imageSource).catch(() => {
    throw new FirstRunSetupError("チュートリアル用の画像を読み取れませんでした。");
  });
  const canonicalDownloads = await assertSafeDirectory(downloadsRoot, true);
  const imageName = await copyWithCollisionSafeName(canonicalDownloads, DEFAULT_TUTORIAL_IMAGE, imageBytes);
  const preservedFiles: string[] = [];
  for (const source of tutorialFiles) {
    const relative = source.relative;
    // Repository Core owns its generated manifest and README at the Project root.
    if (relative === "project.json" || relative === "project.magi") continue;
    const segments = validateRelative(relative);
    let parent = canonicalProject;
    for (const segment of segments.slice(0, -1)) {
      parent = path.join(parent, segment);
      try { await mkdir(parent); }
      catch (error: unknown) {
        const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
        if (code !== "EEXIST") throw error;
        const existing = await lstat(parent);
        if (!existing.isDirectory() || existing.isSymbolicLink()) throw new FirstRunSetupError("Project内の保存先が安全ではありません。");
      }
    }
    const text = source.contents.replaceAll(DEFAULT_TUTORIAL_IMAGE, imageName);
    const created = await writeUtf8Exclusive(parent, segments.at(-1)!, text);
    if (!created) preservedFiles.push(relative);
  }
  return Object.freeze({ canonicalRoot: canonicalProject, identityId: projectId, title: projectTitle, imageName, preservedFiles: Object.freeze(preservedFiles) });
}

async function copyWithCollisionSafeName(directory: string, preferredName: string, contents: Buffer): Promise<string> {
  const extension = path.extname(preferredName);
  const stem = path.basename(preferredName, extension);
  for (let index = 1; index < 1000; index += 1) {
    const filename = index === 1 ? preferredName : `${stem} (${index})${extension}`;
    const destination = path.join(directory, filename);
    if (await writeBufferExclusive(destination, contents)) return filename;
    try {
      const existing = await lstat(destination);
      if (!existing.isFile() || existing.isSymbolicLink()) continue;
      if ((await readFile(destination)).equals(contents)) return filename;
    } catch {
      // A path changed during the check; move to the next safe filename.
    }
  }
  throw new FirstRunSetupError("ダウンロードにチュートリアル画像を保存できませんでした。別の保存場所を選んでください。");
}
