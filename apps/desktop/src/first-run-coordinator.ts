import { randomUUID } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import * as path from "node:path";
import type { LibraryService } from "./library-service.js";
import { createFolderMarker, resolveFolderMarker } from "./folder-identity.js";
import { FirstRunJournalStore, FirstRunSetupError, createPrivateShelfForSetup, materializeTutorialProject, type FirstRunJournal } from "./first-run-setup.js";
import type { TutorialSeedResult } from "./tutorial-seed.js";
import type { ShelfLocationRegistry } from "./shelf-location-registry.js";
import type { WorkdeskService, ValidatedWorkdesk } from "./workdesk-service.js";

export interface FirstRunChoices {
  readonly workdeskMode: "new" | "existing";
  readonly privateShelfMode: "new" | "existing";
  readonly registerPublicShelf: boolean;
}

export type FirstRunProgress = (message: string) => void;
export type FirstRunFolderPicker = (title: string, defaultPath: string) => Promise<string | undefined>;
export type FirstRunConfirmation = (kind: "workdesk" | "shelf", folderName: string) => Promise<boolean>;

export type FirstRunResult =
  | { readonly kind: "completed"; readonly projectTitle: string; readonly shelfSeed: TutorialSeedResult }
  | { readonly kind: "cancelled" }
  | { readonly kind: "error"; readonly message: string };

export interface FirstRunCoordinatorOptions {
  readonly journal: FirstRunJournalStore;
  readonly workdesks: WorkdeskService;
  readonly libraries: LibraryService;
  readonly shelfLocations: ShelfLocationRegistry;
  readonly tutorialRoot: string;
  readonly downloadsRoot: string;
  readonly defaultWorkdeskRoot: string;
  readonly defaultShelfRoot: string;
  readonly pickFolder: FirstRunFolderPicker;
  readonly confirmAdoption: FirstRunConfirmation;
  readonly onProgress?: FirstRunProgress;
  readonly onError?: (error: unknown) => void;
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

function friendlyError(error: unknown): string {
  if (error instanceof FirstRunSetupError) return error.message;
  const code = errorCode(error);
  if (code === "marker-conflict") return "この場所には異なる管理情報があります。ファイルはそのまま残しています。別の場所を選ぶか、管理情報を確認してください。";
  if (code === "legacy-kind-conflict" || code === "wrong-kind" || code === "wrong-type") return "選んだ場所はこの種類のデータとして使えません。内容は変更していません。別の場所を選んでください。";
  if (code === "missing-marker") return "この場所の管理情報が見つかりませんでした。読み取れるファイルはそのまま残っています。管理情報を作り直すか、別の場所を選んでください。";
  return "設定を完了できませんでした。選んだファイルやフォルダーはそのまま残っています。別の保存場所を選ぶか、もう一度お試しください。";
}

async function existingDirectory(root: string): Promise<boolean> {
  try {
    const stats = await lstat(root);
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

export class FirstRunCoordinator {
  public constructor(private readonly options: FirstRunCoordinatorOptions) {}

  public async run(owner: object, choices: FirstRunChoices): Promise<FirstRunResult> {
    try {
      const journal: FirstRunJournal = await this.options.journal.load() ?? Object.freeze({ schemaVersion: 1, stage: "start" });
      if (journal.stage === "complete") {
        return {
          kind: "completed",
          projectTitle: journal.tutorialProjectTitle ?? "MAGINALIA はじめてのプロジェクト",
          shelfSeed: journal.shelfSeedResult ?? { booksAdded: 0, annotationsAdded: 0, conflicts: [] },
        };
      }
      const workdesk = await this.resolveWorkdesk(journal, choices.workdeskMode);
      if (!workdesk) return { kind: "cancelled" };
      let current = await this.options.journal.load() ?? journal;

      this.options.onProgress?.("Private Shelfを準備しています");
      const shelf = await this.resolvePrivateShelf(owner, current, choices.privateShelfMode);
      if (!shelf) return { kind: "cancelled" };
      current = await this.options.journal.load() ?? current;

      await this.options.shelfLocations.initializeEmpty().then((result) => {
        if (result.kind === "error") throw new FirstRunSetupError("Shelfの保存設定を作成できませんでした。Shelfの内容は変更していません。");
      });
      const savedPrivate = await this.options.shelfLocations.savePrivateShelfRegistry(shelf.root);
      if (savedPrivate.kind === "error") throw new FirstRunSetupError("Private Shelfの場所を保存できませんでした。Shelfの内容はそのまま残っています。");

      if (!current.publicShelfChecked) {
        if (choices.registerPublicShelf) {
          this.options.onProgress?.("Public Shelfを確認しています");
          const publicRoot = await this.options.pickFolder("Public Shelfの保存場所を選ぶ", path.dirname(this.options.defaultShelfRoot));
          if (publicRoot === undefined) return { kind: "cancelled" };
          await resolveFolderMarker(publicRoot, "shelf");
          const publicOpened = await this.options.libraries.openForOwner(owner, publicRoot);
          if (publicOpened.kind !== "opened") throw new FirstRunSetupError("選んだPublic Shelfを開けませんでした。登録内容は変更していません。");
          const savedPublic = await this.options.shelfLocations.savePublicShelfRegistry(publicRoot);
          if (savedPublic.kind === "error") throw new FirstRunSetupError("Public Shelfの場所を記録できませんでした。Shelfの内容は変更していません。");
          current = Object.freeze({ ...current, publicShelfRoot: publicRoot, publicShelfChecked: true, stage: "shelf" });
        } else {
          current = Object.freeze({ ...current, publicShelfChecked: true, stage: "shelf" });
        }
        await this.options.journal.save(current);
      }

      this.options.onProgress?.("チュートリアルの引用資料を追加しています");
      const seedRoot = path.join(this.options.tutorialRoot, "private-shelf-seed");
      const seedManifest = path.join(this.options.tutorialRoot, "installer-copy-manifest.json");
      const seedResult = shelf.seedResult ?? await createPrivateShelfForSetup(
        shelf.root,
        shelf.identityId,
        seedRoot,
        seedManifest,
      );
      current = Object.freeze({ ...current, stage: "tutorial", shelfSeedResult: seedResult });
      await this.options.journal.save(current);

      this.options.onProgress?.("チュートリアルProjectを準備しています");
      const projectReservation = await this.reserveTutorialProject(workdesk, current);
      current = projectReservation.journal;
      await this.options.journal.save(current);
      const project = await materializeTutorialProject({
        projectRoot: projectReservation.root,
        projectId: projectReservation.identityId,
        projectTitle: projectReservation.title,
        workdeskId: workdesk.identity.id,
        templateRoot: path.join(this.options.tutorialRoot, "project-template"),
        downloadsRoot: this.options.downloadsRoot,
      });
      const validatedProject = await this.options.workdesks.validateDirectChildProject(workdesk, project.canonicalRoot);
      await this.options.workdesks.registerProjectLocation(workdesk, validatedProject);
      await this.options.workdesks.setLastActiveContext(workdesk, {
        kind: "project",
        projectIdentityId: validatedProject.projectIdentity.id,
      });
      await this.options.workdesks.setPrimary(workdesk);
      await this.options.journal.save(Object.freeze({
        ...current,
        stage: "complete",
        downloadsImageName: project.imageName,
        shelfSeedResult: seedResult,
      }));
      this.options.onProgress?.("設定が完了しました");
      return { kind: "completed", projectTitle: project.title, shelfSeed: seedResult };
    } catch (error: unknown) {
      this.options.onError?.(error);
      return { kind: "error", message: friendlyError(error) };
    }
  }

  private async resolveWorkdesk(journal: FirstRunJournal, mode: "new" | "existing"): Promise<ValidatedWorkdesk | undefined> {
    const root = journal.workdeskRoot ?? await this.options.pickFolder(
      mode === "new" ? "新しいWorkdeskの保存場所を選ぶ" : "使いたいWorkdeskを選ぶ",
      this.options.defaultWorkdeskRoot,
    );
    if (root === undefined) return undefined;
    this.options.onProgress?.("Workdeskを確認しています");

    if (journal.workdeskRoot && journal.workdeskIdentityId && journal.workdeskMode) {
      try {
        const restored = await this.options.workdesks.open(root);
        if (restored.identity.id.toLowerCase() !== journal.workdeskIdentityId.toLowerCase()) {
          throw new FirstRunSetupError("保存済みWorkdeskの管理情報が変わっています。既存ファイルは変更していません。");
        }
        await this.options.workdesks.setPrimary(restored);
        return restored;
      } catch (error) {
        if (errorCode(error) !== "missing-marker" && !(journal.workdeskMode === "new" && errorCode(error) === "root-missing")) throw error;
        if (journal.workdeskMode === "new") {
          return this.options.workdesks.createAtRootForSetup(root, "マイWorkdesk", journal.workdeskIdentityId);
        }
        const candidate = await this.options.workdesks.prepareAdoption(root);
        const adopted = await this.options.workdesks.adoptPreparedFolder(candidate, journal.workdeskIdentityId);
        await this.options.workdesks.setPrimary(adopted.workdesk);
        return adopted.workdesk;
      }
    }

    if (mode === "new") {
      try {
        const existing = await this.options.workdesks.open(root);
        await this.options.workdesks.setPrimary(existing);
        await this.options.journal.save(Object.freeze({
          schemaVersion: 1, stage: "workdesk", workdeskMode: "new", workdeskRoot: existing.canonicalRoot,
          workdeskIdentityId: existing.identity.id,
        }));
        return existing;
      } catch (error) {
        const code = errorCode(error);
        if (code !== "missing-marker" && code !== "root-missing") throw error;
      }
      if (await existingDirectory(root) && (await readdir(root)).length > 0) {
        throw new FirstRunSetupError("選んだ場所にファイルがあります。既存Workdeskを選ぶか、空の場所を選んでください。ファイルは変更していません。");
      }
      const identityId = randomUUID();
      await this.options.journal.save(Object.freeze({
        schemaVersion: 1, stage: "start", workdeskMode: "new", workdeskRoot: root, workdeskIdentityId: identityId,
      }));
      return this.options.workdesks.createAtRootForSetup(root, "マイWorkdesk", identityId);
    }

    try {
      const existing = await this.options.workdesks.open(root);
      await this.options.workdesks.setPrimary(existing);
      await this.options.journal.save(Object.freeze({
        schemaVersion: 1, stage: "workdesk", workdeskMode: "existing", workdeskRoot: existing.canonicalRoot,
        workdeskIdentityId: existing.identity.id,
      }));
      return existing;
    } catch (error) {
      if (errorCode(error) !== "missing-marker") throw error;
    }

    const folderName = path.basename(root) || "Workdesk";
    if (!await this.options.confirmAdoption("workdesk", folderName)) return undefined;
    const candidate = await this.options.workdesks.prepareAdoption(root);
    const identityId = randomUUID();
    await this.options.journal.save(Object.freeze({
      schemaVersion: 1, stage: "start", workdeskMode: "existing", workdeskRoot: root, workdeskIdentityId: identityId,
    }));
    const adopted = await this.options.workdesks.adoptPreparedFolder(candidate, identityId);
    await this.options.workdesks.setPrimary(adopted.workdesk);
    return adopted.workdesk;
  }

  private async resolvePrivateShelf(
    owner: object,
    journal: FirstRunJournal,
    mode: "new" | "existing",
  ): Promise<{ readonly root: string; readonly identityId: string; readonly seedResult?: TutorialSeedResult } | undefined> {
    const root = journal.shelfRoot ?? await this.options.pickFolder(
      mode === "new" ? "新しいPrivate Shelfの保存場所を選ぶ" : "使いたいPrivate Shelfを選ぶ",
      this.options.defaultShelfRoot,
    );
    if (root === undefined) return undefined;
    const hasReservation = journal.shelfRoot !== undefined && journal.shelfIdentityId !== undefined && journal.privateShelfMode !== undefined;

    if (hasReservation) {
      const current = await this.options.libraries.openConfiguredPrivateShelfForOwner(owner, root);
      if (current.kind === "opened" && current.folderIdentityId?.toLowerCase() === journal.shelfIdentityId!.toLowerCase()) {
        await this.options.journal.save(Object.freeze({ ...journal, stage: "shelf" }));
        return { root, identityId: journal.shelfIdentityId! };
      }
      if (current.kind === "opened" && current.folderIdentityRecovery?.code === "missing-marker") {
        const marker = await createFolderMarker(root, "shelf", { uuidFactory: () => journal.shelfIdentityId! });
        if (marker.marker.id.toLowerCase() !== journal.shelfIdentityId!.toLowerCase()) throw new FirstRunSetupError("Shelfの管理情報が保存済みの設定と一致しません。");
        const seeded = await createPrivateShelfForSetup(root, journal.shelfIdentityId!, path.join(this.options.tutorialRoot, "private-shelf-seed"), path.join(this.options.tutorialRoot, "installer-copy-manifest.json"));
        await this.options.journal.save(Object.freeze({ ...journal, stage: "shelf", shelfSeedResult: seeded }));
        return { root, identityId: journal.shelfIdentityId!, seedResult: seeded };
      }
      if (journal.privateShelfMode === "new" && current.kind === "error") {
        const seeded = await createPrivateShelfForSetup(root, journal.shelfIdentityId!, path.join(this.options.tutorialRoot, "private-shelf-seed"), path.join(this.options.tutorialRoot, "installer-copy-manifest.json"));
        await this.options.journal.save(Object.freeze({ ...journal, stage: "shelf", shelfSeedResult: seeded }));
        return { root, identityId: journal.shelfIdentityId!, seedResult: seeded };
      }
      throw current.kind === "error"
        ? new FirstRunSetupError("選んだPrivate Shelfを開けませんでした。既存の記録は変更していません。")
        : new FirstRunSetupError("Private Shelfの管理情報を確認できませんでした。内容はそのまま残しています。");
    }

    if (mode === "existing") {
      const current = await this.options.libraries.openConfiguredPrivateShelfForOwner(owner, root);
      if (current.kind !== "opened") throw new FirstRunSetupError("選んだPrivate Shelfを開けませんでした。既存の記録は変更していません。");
      let identityId = current.folderIdentityId;
      if (current.folderIdentityRecovery) {
        if (current.folderIdentityRecovery.code !== "missing-marker") {
          throw new FirstRunSetupError("Shelfの管理情報に問題があります。Shelfの記録はそのまま読める状態です。管理情報を確認するか、別のShelfを選んでください。");
        }
        const folderName = path.basename(root) || "Private Shelf";
        if (!await this.options.confirmAdoption("shelf", folderName)) return undefined;
        identityId = randomUUID();
        await this.options.journal.save(Object.freeze({
          schemaVersion: 1, stage: "workdesk", workdeskMode: journal.workdeskMode, workdeskRoot: journal.workdeskRoot,
          workdeskIdentityId: journal.workdeskIdentityId, privateShelfMode: "existing", shelfRoot: root, shelfIdentityId: identityId,
        }));
        const marker = await createFolderMarker(root, "shelf", { uuidFactory: () => identityId! });
        if (marker.marker.id.toLowerCase() !== identityId.toLowerCase()) throw new FirstRunSetupError("Shelfの管理情報を確定できませんでした。");
      }
      if (!identityId) throw new FirstRunSetupError("Shelfの管理情報を確認できませんでした。記録は変更していません。");
      await this.options.journal.save(Object.freeze({
        schemaVersion: 1, stage: "shelf", workdeskMode: journal.workdeskMode, workdeskRoot: journal.workdeskRoot,
        workdeskIdentityId: journal.workdeskIdentityId, privateShelfMode: "existing", shelfRoot: root, shelfIdentityId: identityId,
      }));
      return { root, identityId };
    }

    const existing = await this.options.libraries.openConfiguredPrivateShelfForOwner(owner, root);
    if (existing.kind === "opened" && existing.folderIdentityId) {
      await this.options.journal.save(Object.freeze({
        schemaVersion: 1, stage: "shelf", workdeskMode: journal.workdeskMode, workdeskRoot: journal.workdeskRoot,
        workdeskIdentityId: journal.workdeskIdentityId, privateShelfMode: "new", shelfRoot: root, shelfIdentityId: existing.folderIdentityId,
      }));
      return { root, identityId: existing.folderIdentityId };
    }
    if (existing.kind === "opened" && existing.folderIdentityRecovery?.code === "missing-marker") {
      const folderName = path.basename(root) || "Private Shelf";
      if (!await this.options.confirmAdoption("shelf", folderName)) return undefined;
      const identityId = randomUUID();
      await this.options.journal.save(Object.freeze({
        schemaVersion: 1, stage: "workdesk", workdeskMode: journal.workdeskMode, workdeskRoot: journal.workdeskRoot,
        workdeskIdentityId: journal.workdeskIdentityId, privateShelfMode: "existing", shelfRoot: root, shelfIdentityId: identityId,
      }));
      const marker = await createFolderMarker(root, "shelf", { uuidFactory: () => identityId });
      if (marker.marker.id.toLowerCase() !== identityId.toLowerCase()) throw new FirstRunSetupError("Shelfの管理情報を確定できませんでした。");
      return { root, identityId };
    }
    if (await existingDirectory(root)) {
      const entries = await readdir(root).catch(() => []);
      if (entries.length > 0) throw new FirstRunSetupError("選んだ場所に既存ファイルがあります。既存Shelfを選ぶか、空の場所を選んでください。Shelfの内容は変更していません。");
    }
    const identityId = randomUUID();
    const next = Object.freeze({
      schemaVersion: 1 as const, stage: "workdesk" as const, workdeskMode: journal.workdeskMode,
      workdeskRoot: journal.workdeskRoot, workdeskIdentityId: journal.workdeskIdentityId,
      privateShelfMode: "new" as const, shelfRoot: root, shelfIdentityId: identityId,
    });
    await this.options.journal.save(next);
    const seed = await createPrivateShelfForSetup(root, identityId, path.join(this.options.tutorialRoot, "private-shelf-seed"), path.join(this.options.tutorialRoot, "installer-copy-manifest.json"));
    await this.options.journal.save(Object.freeze({ ...next, stage: "shelf", shelfSeedResult: seed }));
    return { root, identityId, seedResult: seed };
  }

  private async reserveTutorialProject(workdesk: ValidatedWorkdesk, journal: FirstRunJournal): Promise<{
    readonly root: string;
    readonly identityId: string;
    readonly title: string;
    readonly journal: FirstRunJournal;
  }> {
    const projectsRoot = await this.options.workdesks.prepareChildProjectDirectory(workdesk);
    const canonicalProjectsRoot = await realpath(projectsRoot);
    if (journal.tutorialProjectRoot && journal.tutorialProjectIdentityId && journal.tutorialProjectTitle) {
      const parent = path.resolve(path.dirname(journal.tutorialProjectRoot));
      const normalize = (value: string) => process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
      if (normalize(parent) !== normalize(canonicalProjectsRoot)) throw new FirstRunSetupError("Tutorial Projectの保存場所がWorkdeskの外にあります。管理情報は変更していません。");
      return { root: journal.tutorialProjectRoot, identityId: journal.tutorialProjectIdentityId, title: journal.tutorialProjectTitle, journal };
    }
    const baseTitle = "MAGINALIA はじめてのプロジェクト";
    for (let suffix = 1; suffix < 1000; suffix += 1) {
      const title = suffix === 1 ? baseTitle : `${baseTitle} (${suffix})`;
      const root = path.join(canonicalProjectsRoot, title);
      if (await existingDirectory(root)) continue;
      const identityId = randomUUID();
      const next = Object.freeze({ ...journal, stage: "tutorial" as const, tutorialProjectRoot: root, tutorialProjectIdentityId: identityId, tutorialProjectTitle: title });
      return { root, identityId, title, journal: next };
    }
    throw new FirstRunSetupError("チュートリアルProjectの保存場所を用意できませんでした。");
  }
}
