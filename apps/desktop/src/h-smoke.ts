import * as path from "node:path";
import type { ProjectService } from "./project-service.js";
import type { LocalRepositoryService } from "./repository-service.js";
import type { WorkdeskService } from "./workdesk-service.js";

/**
 * Real Electron main-process coverage of Workdesk creation, child Project
 * ownership, parent History isolation, byte-preserving copy, and restart
 * restore. BrowserWindow.executeJavaScript cannot drive contextBridge APIs:
 * it evaluates in the main world and Electron cannot structured-clone an
 * isolated-world proxy. Renderer-facing channel contracts are covered by the
 * preload and Workdesk IPC tests; this smoke deliberately exercises the real
 * main-process lifecycle without manufacturing an unsafe renderer bridge.
 */
export async function runHSmoke(options: {
  readonly fixtureRoot: string;
  readonly restore: boolean;
  readonly workdesks: WorkdeskService;
  readonly repositories: LocalRepositoryService;
  readonly projects: ProjectService;
}): Promise<void> {
  if (options.restore) {
    const restored = await options.workdesks.restorePrimary();
    if (!restored) throw new Error("The primary Workdesk did not restore.");
    if ((await options.workdesks.listRegisteredProjects(restored)).length !== 1) {
      throw new Error("The restored Workdesk did not retain its Project registration.");
    }
    return;
  }

  const owner = Object.freeze({});
  const created = await options.repositories.createForOwner(owner, options.fixtureRoot, "workbench", "H Smoke Desk");
  if (created.kind !== "opened") throw new Error(`Workdesk creation failed: ${created.message}`);
  const resolved = await options.repositories.resolveForOwner(owner, created.repository.repositoryId);
  if (resolved.kind !== "resolved") throw new Error(`Workdesk resolution failed: ${resolved.message}`);
  const workdesk = await options.workdesks.open(resolved.canonicalRoot);
  await options.workdesks.setPrimary(workdesk);

  const loose = await options.projects.openForOwner(owner, workdesk.canonicalRoot);
  if (loose.kind !== "opened") throw new Error(`Workdesk loose documents failed to open: ${loose.message}`);
  const memo = await options.projects.createFileForOwner(owner, loose.project.projectId, "memo.md", "H Smoke Memo", "memo");
  if (memo.kind !== "created") throw new Error(`Workdesk memo creation failed: ${memo.message}`);

  const projectParent = await options.workdesks.prepareChildProjectDirectory(workdesk);
  const childOwner = Object.freeze({});
  const childCreated = await options.repositories.createForOwner(childOwner, projectParent, "project", "H Smoke Child");
  if (childCreated.kind !== "opened") throw new Error(`Child Project creation failed: ${childCreated.message}`);
  const childResolved = await options.repositories.resolveForOwner(childOwner, childCreated.repository.repositoryId);
  if (childResolved.kind !== "resolved") throw new Error(`Child Project resolution failed: ${childResolved.message}`);
  const child = await options.workdesks.validateDirectChildProject(workdesk, childResolved.canonicalRoot);
  await options.workdesks.registerPortableProject(workdesk, child.projectIdentity);
  await options.workdesks.registerProjectPath(workdesk, child);

  const source = await options.projects.readCopySourceForOwner(owner, loose.project.projectId, memo.file.fileId);
  if (!("text" in source)) throw new Error(`Workdesk copy source failed: ${source.message}`);
  const destinationOwner = Object.freeze({});
  const destination = await options.projects.openForOwner(destinationOwner, child.canonicalRoot);
  if (destination.kind !== "opened") throw new Error(`Child Project failed to open: ${destination.message}`);
  const copied = await options.projects.copySourceToProjectForOwner(destinationOwner, destination.project.projectId, source, "memo");
  if (copied.kind !== "created") throw new Error(`Workdesk copy failed: ${copied.message}`);

  const history = await options.repositories.createHistoryForOwner(owner, created.repository.repositoryId);
  if (history.kind !== "snapshot") throw new Error(`Parent Workdesk History did not safely capture: ${history.message}`);
  if (path.dirname(child.canonicalRoot) !== path.join(workdesk.canonicalRoot, "projects")) {
    throw new Error("Child Project was created outside the bounded Workdesk projects directory.");
  }
}
