import type { ProjectFileCreateResult, ProjectOpened, ProjectResult, ProjectService } from "./project-service.js";
import type { CreateProjectFileRequest } from "./project-ipc.js";
import type { ProjectDocumentType } from "./project-metadata.js";
import type {
  AdoptedWorkdesk,
  WorkdeskAdoptionCandidate,
  WorkdeskIdentityRecoveryRoot,
  WorkdeskLastActiveContext,
  WorkdeskService,
  WorkdeskOpenBoundary,
  ValidatedWorkdesk,
} from "./workdesk-service.js";

export const OPEN_WORKDESK_CHANNEL = "maginalia:open-workdesk";
export const CREATE_WORKDESK_CHANNEL = "maginalia:create-workdesk";
export const RESTORE_WORKDESK_CHANNEL = "maginalia:restore-workdesk";
export const RETURN_TO_WORKDESK_CHANNEL = "maginalia:return-to-workdesk";
export const SAVE_WORKDESK_CONTEXT_CHANNEL = "maginalia:save-workdesk-context";
export const CREATE_WORKDESK_FILE_CHANNEL = "maginalia:create-workdesk-file";
export const CREATE_WORKDESK_PROJECT_CHANNEL = "maginalia:create-workdesk-project";
export const REGISTER_WORKDESK_PROJECT_CHANNEL = "maginalia:register-workdesk-project";
export const REMOVE_WORKDESK_PROJECT_CHANNEL = "maginalia:remove-workdesk-project";
export const OPEN_WORKDESK_PROJECT_CHANNEL = "maginalia:open-workdesk-project";
export const COPY_WORKDESK_FILE_TO_PROJECT_CHANNEL = "maginalia:copy-workdesk-file-to-project";

export interface WorkdeskFolderSelection {
  readonly canceled: boolean;
  readonly filePaths: readonly string[];
}

export interface WorkdeskInvokeEvent { readonly sender: object; }

export interface CreateWorkdeskRequest { readonly title: string; }

export interface CreateWorkdeskFileRequest {
  readonly workdeskId: string;
  readonly fileName: string;
  readonly title: string;
  readonly documentType: "memo" | "draft" | "other";
  readonly parentEntryId?: string | null;
}

export interface CreateWorkdeskProjectRequest {
  readonly workdeskIdentityId: string;
  readonly title: string;
}

export interface RegisterWorkdeskProjectRequest {
  readonly workdeskIdentityId: string;
}

export interface OpenWorkdeskProjectRequest {
  readonly workdeskIdentityId: string;
  readonly projectIdentityId: string;
}

export interface RemoveWorkdeskProjectRequest {
  readonly workdeskIdentityId: string;
  readonly projectIdentityId: string;
}

/** All filesystem locations remain main-process-side opaque handles. */
export interface CopyWorkdeskFileToProjectRequest {
  readonly workdeskId: string;
  readonly sourceFileId: string;
  readonly projectIdentityId: string;
  readonly documentType: ProjectDocumentType;
}

export interface WorkdeskProjectNode {
  readonly projectIdentityId: string;
  readonly title: string;
  readonly available: boolean;
}

export interface WorkdeskProjectOpened {
  readonly kind: "opened";
  readonly project: ProjectOpened;
  readonly node: WorkdeskProjectNode;
}

export interface WorkdeskProjectOpenedUnregistered {
  readonly kind: "opened-unregistered";
  readonly project: ProjectOpened;
}

export interface WorkdeskProjectRegistered {
  readonly kind: "registered";
  readonly node: WorkdeskProjectNode;
}

export interface WorkdeskProjectRemoved {
  readonly kind: "removed";
  readonly projectIdentityId: string;
}

export interface WorkdeskOpened {
  readonly kind: "opened";
  readonly workdesk: {
    /** Portable repository identity, for display/index only. */
    readonly workdeskIdentityId: string;
    /** Owner-bound opaque loose-document handle, never a path. */
    readonly documentId: string;
    readonly title: string;
  };
  /** Existing Project-shaped handles are deliberately reused for loose files. */
  readonly project: ProjectOpened["project"];
  readonly files: ProjectOpened["files"];
  readonly projects: readonly WorkdeskProjectNode[];
  readonly lastActiveContext: WorkdeskLastActiveContext;
}

/** A recovery result with no selected or synthesized Workdesk UUID. */
export interface WorkdeskRecovered {
  readonly kind: "recovery";
  readonly workdesk: {
    readonly documentId: string;
    readonly title: string;
  };
  readonly project: ProjectOpened["project"];
  readonly files: ProjectOpened["files"];
  readonly recovery: {
    readonly code: WorkdeskIdentityRecoveryRoot["code"];
    readonly message: string;
  };
}

export interface WorkdeskCancelled { readonly kind: "cancelled"; }
export interface WorkdeskNone { readonly kind: "none"; }
export interface WorkdeskFailure { readonly kind: "error"; readonly code: string; readonly message: string; }

export type WorkdeskOpenResult = WorkdeskOpened | WorkdeskRecovered | WorkdeskCancelled | WorkdeskFailure;
export type WorkdeskRestoreResult = WorkdeskOpened | WorkdeskRecovered | WorkdeskNone | WorkdeskFailure;
export interface SaveWorkdeskContextRequest {
  readonly workdeskIdentityId: string;
  readonly context: WorkdeskLastActiveContext;
}
export type SaveWorkdeskContextResult = { readonly kind: "saved" } | WorkdeskFailure;
export type WorkdeskFileCreateResult = ProjectFileCreateResult | WorkdeskFailure;
export type WorkdeskProjectResult = WorkdeskProjectOpened | WorkdeskProjectOpenedUnregistered | WorkdeskProjectRegistered | WorkdeskProjectRemoved | WorkdeskCancelled | WorkdeskFailure;
export type ExistingProjectRegistrationChoice = "register" | "cancel" | "open-without-registration";
export type WorkdeskCopyResult = ProjectFileCreateResult | WorkdeskFailure;

export interface WorkdeskHandlerDependencies {
  readonly pickWorkdeskFolder: () => Promise<WorkdeskFolderSelection>;
  readonly pickWorkdeskParent: () => Promise<WorkdeskFolderSelection>;
  readonly pickExistingProjectFolder: () => Promise<WorkdeskFolderSelection>;
  readonly confirmAdoptWorkdesk: () => Promise<boolean>;
  readonly confirmRegisterExistingProject: () => Promise<ExistingProjectRegistrationChoice>;
  readonly service: WorkdeskService;
  readonly projects: ProjectService;
  /**
   * Workdesk keeps child Project roots out of its loose-file Explorer.  This
   * adapter verifies a renderer-supplied destination remains in that visible
   * loose-file tree before ProjectService receives the opaque parent handle.
   */
  readonly isPermittedWorkdeskFolder: (owner: object, documentId: string, parentEntryId: string | null) => Promise<boolean>;
}

export interface WorkdeskHandlers {
  readonly openWorkdesk: (event: WorkdeskInvokeEvent, ...args: readonly unknown[]) => Promise<WorkdeskOpenResult>;
  readonly createWorkdesk: (event: WorkdeskInvokeEvent, request: unknown, ...args: readonly unknown[]) => Promise<WorkdeskOpenResult>;
  readonly restoreWorkdesk: (event: WorkdeskInvokeEvent, ...args: readonly unknown[]) => Promise<WorkdeskRestoreResult>;
  readonly returnToWorkdesk: (event: WorkdeskInvokeEvent, ...args: readonly unknown[]) => Promise<WorkdeskRestoreResult>;
  readonly saveWorkdeskContext: (event: WorkdeskInvokeEvent, request: unknown, ...args: readonly unknown[]) => Promise<SaveWorkdeskContextResult>;
  readonly createWorkdeskFile: (event: WorkdeskInvokeEvent, request: unknown, ...args: readonly unknown[]) => Promise<WorkdeskFileCreateResult>;
  readonly createWorkdeskProject: (event: WorkdeskInvokeEvent, request: unknown, ...args: readonly unknown[]) => Promise<WorkdeskProjectResult>;
  readonly registerWorkdeskProject: (event: WorkdeskInvokeEvent, request: unknown, ...args: readonly unknown[]) => Promise<WorkdeskProjectResult>;
  readonly removeWorkdeskProject: (event: WorkdeskInvokeEvent, request: unknown, ...args: readonly unknown[]) => Promise<WorkdeskProjectResult>;
  readonly openWorkdeskProject: (event: WorkdeskInvokeEvent, request: unknown, ...args: readonly unknown[]) => Promise<WorkdeskProjectResult>;
  readonly copyWorkdeskFileToProject: (event: WorkdeskInvokeEvent, request: unknown, ...args: readonly unknown[]) => Promise<WorkdeskCopyResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIdentityRecovery(boundary: WorkdeskOpenBoundary): boundary is WorkdeskIdentityRecoveryRoot {
  return "kind" in boundary && boundary.kind === "identity-recovery";
}

function isFolderSelection(value: unknown): value is WorkdeskFolderSelection {
  return isRecord(value) && typeof value.canceled === "boolean" && Array.isArray(value.filePaths)
    && value.filePaths.every((entry) => typeof entry === "string");
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

function isCreateRequest(value: unknown): value is CreateWorkdeskRequest {
  return isRecord(value) && Reflect.ownKeys(value).length === 1 && typeof value.title === "string";
}

function isCreateFileRequest(value: unknown): value is CreateWorkdeskFileRequest {
  if (!isRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (!(keys.length === 4 || keys.length === 5)
    || !["workdeskId", "fileName", "title", "documentType"].every((key) => keys.includes(key))
    || (keys.length === 5 && !keys.includes("parentEntryId"))) return false;
  return isOpaqueId(value.workdeskId)
    && typeof value.fileName === "string"
    && typeof value.title === "string"
    && (value.documentType === "memo" || value.documentType === "draft" || value.documentType === "other")
    && (value.parentEntryId === undefined || value.parentEntryId === null || isOpaqueId(value.parentEntryId));
}

function isCreateProjectRequest(value: unknown): value is CreateWorkdeskProjectRequest {
  return isRecord(value) && Reflect.ownKeys(value).length === 2
    && isOpaqueId(value.workdeskIdentityId) && typeof value.title === "string";
}

function isRegisterProjectRequest(value: unknown): value is RegisterWorkdeskProjectRequest {
  return isRecord(value) && Reflect.ownKeys(value).length === 1 && isOpaqueId(value.workdeskIdentityId);
}

function isOpenProjectRequest(value: unknown): value is OpenWorkdeskProjectRequest {
  return isRecord(value) && Reflect.ownKeys(value).length === 2
    && isOpaqueId(value.workdeskIdentityId) && isOpaqueId(value.projectIdentityId);
}

function isSaveWorkdeskContextRequest(value: unknown): value is SaveWorkdeskContextRequest {
  if (!isRecord(value) || Reflect.ownKeys(value).length !== 2
    || !isOpaqueId(value.workdeskIdentityId) || !isRecord(value.context)) return false;
  return value.context.kind === "home"
    ? Reflect.ownKeys(value.context).length === 1
    : value.context.kind === "project" && Reflect.ownKeys(value.context).length === 2
      && isOpaqueId(value.context.projectIdentityId);
}

function isRemoveProjectRequest(value: unknown): value is RemoveWorkdeskProjectRequest {
  return isRecord(value) && Reflect.ownKeys(value).length === 2
    && isOpaqueId(value.workdeskIdentityId) && isOpaqueId(value.projectIdentityId);
}

function isCopyRequest(value: unknown): value is CopyWorkdeskFileToProjectRequest {
  return isRecord(value) && Reflect.ownKeys(value).length === 4
    && isOpaqueId(value.workdeskId) && isOpaqueId(value.sourceFileId) && isOpaqueId(value.projectIdentityId)
    && (value.documentType === "memo" || value.documentType === "draft" || value.documentType === "other" || value.documentType === "body");
}

function failure(code: string, message: string): WorkdeskFailure {
  return Object.freeze({ kind: "error", code, message });
}

function asFailure(error: unknown, message: string): WorkdeskFailure {
  if (error instanceof Error && error.name === "WorkdeskBoundaryError" && "code" in error
    && typeof (error as Error & { readonly code?: unknown }).code === "string") {
    return failure((error as Error & { readonly code: string }).code, error.message);
  }
  return failure("workdesk-unavailable", error instanceof Error && error.message.length > 0 ? error.message : message);
}

async function nodes(service: WorkdeskService, desk: ValidatedWorkdesk): Promise<readonly WorkdeskProjectNode[]> {
  const index = await service.listRegisteredProjects(desk);
  return Object.freeze(index.map((entry) => Object.freeze({
    projectIdentityId: entry.projectIdentityId,
    title: entry.title,
    available: entry.available
  })));
}

async function opened(
  dependencies: WorkdeskHandlerDependencies,
  owner: object,
  desk: ValidatedWorkdesk,
): Promise<WorkdeskOpened | WorkdeskFailure> {
  const loose = await dependencies.projects.openWorkdeskLooseFilesForOwner(owner, desk.canonicalRoot);
  if (loose.kind !== "opened") return failure("workdesk-open-failed", loose.message);
  // A Workdesk may contain independent child Project repositories below
  // `projects/`. They are never loose Workdesk documents, even briefly while
  // the renderer's Explorer request is in flight.
  const looseFiles = loose.files.filter((file) => file.displayName !== "projects" && !file.displayName.startsWith("projects/"));
  const workdeskProjects = await nodes(dependencies.service, desk);
  await dependencies.service.setPrimary(desk);
  // IPC results are deliberately reconstructed as a data-only DTO. The
  // Project service owns Maps internally; no host object/prototype is allowed
  // to cross Electron's structured-clone boundary with a Workdesk result.
  return {
    kind: "opened",
    workdesk: {
      workdeskIdentityId: desk.identity.id,
      documentId: loose.project.projectId,
      title: desk.identity.title
    },
    project: { projectId: loose.project.projectId, displayName: loose.project.displayName },
    files: looseFiles.map((file) => ({
      fileId: file.fileId,
      displayName: file.displayName,
      documentType: file.documentType,
      title: file.title,
    })),
    projects: [...workdeskProjects],
    lastActiveContext: await dependencies.service.lastActiveContext(desk)
  };
}

async function recovered(
  dependencies: WorkdeskHandlerDependencies,
  owner: object,
  recovery: WorkdeskIdentityRecoveryRoot,
): Promise<WorkdeskRecovered | WorkdeskFailure> {
  const loose = await dependencies.projects.openWorkdeskLooseFilesForOwner(owner, recovery.canonicalRoot, { rememberAsProject: false });
  if (loose.kind !== "opened") return failure("workdesk-open-failed", loose.message);
  const looseFiles = loose.files.filter((file) => file.displayName !== "projects" && !file.displayName.startsWith("projects/"));
  return {
    kind: "recovery",
    workdesk: { documentId: loose.project.projectId, title: recovery.title },
    project: { projectId: loose.project.projectId, displayName: loose.project.displayName },
    files: looseFiles.map((file) => ({
      fileId: file.fileId,
      displayName: file.displayName,
      documentType: file.documentType,
      title: file.title,
    })),
    recovery: { code: recovery.code, message: recovery.message },
  };
}

export function createWorkdeskHandlers(dependencies: WorkdeskHandlerDependencies): WorkdeskHandlers {
  // Each renderer owner has exactly one active Workdesk capability. The
  // portable UUID is checked against this map before a Project operation;
  // it is never treated as a filesystem locator.
  const activeDesks = new WeakMap<object, { readonly desk: ValidatedWorkdesk; readonly documentId: string }>();
  const currentDesk = (owner: object, workdeskIdentityId: string): ValidatedWorkdesk | WorkdeskFailure => {
    const active = activeDesks.get(owner);
    return active && active.desk.identity.id.toLowerCase() === workdeskIdentityId.toLowerCase()
      ? active.desk
      : failure("workdesk-not-active", "Open this Workdesk before changing its Projects.");
  };
  const rememberOpened = async (
    owner: object,
    desk: ValidatedWorkdesk,
  ): Promise<WorkdeskOpened | WorkdeskFailure> => {
    const result = await opened(dependencies, owner, desk);
    if (result.kind === "opened") activeDesks.set(owner, Object.freeze({ desk, documentId: result.workdesk.documentId }));
    return result;
  };
  const register = async (desk: ValidatedWorkdesk, project: Awaited<ReturnType<WorkdeskService["validateExternalProject"]>>): Promise<WorkdeskProjectNode> => {
    await dependencies.service.registerProjectLocation(desk, project);
    return Object.freeze({ projectIdentityId: project.projectIdentity.id, title: project.projectIdentity.title, available: true });
  };
  return {
    openWorkdesk: async (event, ...args) => {
      if (args.length !== 0) return failure("invalid-request", "The Workdesk request was invalid.");
      let selected: WorkdeskFolderSelection;
      try { selected = await dependencies.pickWorkdeskFolder(); } catch { return failure("folder-dialog-failed", "The Workdesk folder could not be selected."); }
      if (!isFolderSelection(selected)) return failure("folder-dialog-failed", "The Workdesk folder could not be selected.");
      if (selected.canceled || selected.filePaths.length === 0) return { kind: "cancelled" };
      if (selected.filePaths.length !== 1) return failure("invalid-request", "Choose one Workdesk folder.");
      const selectedRoot = selected.filePaths[0]!;
      let boundary: WorkdeskOpenBoundary;
      try {
        boundary = await dependencies.service.openForActivation(selectedRoot);
      } catch (openError) {
        let identityRecovery: WorkdeskIdentityRecoveryRoot | undefined;
        try {
          identityRecovery = await dependencies.service.inspectIdentityRecoveryForActivation(selectedRoot, openError);
        } catch {
          // The adoption boundary below will report unsafe or unreadable roots.
        }
        if (identityRecovery && identityRecovery.code !== "missing-marker") {
          activeDesks.delete(event.sender);
          return recovered(dependencies, event.sender, identityRecovery);
        }
        let candidate: WorkdeskAdoptionCandidate;
        try {
          candidate = await dependencies.service.prepareAdoption(selectedRoot);
        } catch (error) {
          return asFailure(error, "This folder is not a valid Workdesk and cannot be adopted safely.");
        }
        let confirmed = false;
        try { confirmed = await dependencies.confirmAdoptWorkdesk(); }
        catch { return failure("adoption-confirmation-failed", "The Workdesk adoption confirmation could not be shown."); }
        if (!confirmed) {
          if (identityRecovery) {
            activeDesks.delete(event.sender);
            return recovered(dependencies, event.sender, identityRecovery);
          }
          return { kind: "cancelled" };
        }
        let adopted: AdoptedWorkdesk;
        try {
          adopted = await dependencies.service.adoptPreparedFolder(candidate);
        } catch (error) {
          let recoveryAfterAdoptionFailure: WorkdeskIdentityRecoveryRoot | undefined;
          try {
            recoveryAfterAdoptionFailure = await dependencies.service.inspectIdentityRecoveryForActivation(selectedRoot, error);
          } catch {
            // Preserve the adoption error when the selected root is no longer safe to inspect.
          }
          if (recoveryAfterAdoptionFailure) {
            activeDesks.delete(event.sender);
            return recovered(dependencies, event.sender, recoveryAfterAdoptionFailure);
          }
          return asFailure(error, "The selected folder could not be adopted as a Workdesk.");
        }
        try {
          const result = await rememberOpened(event.sender, adopted.workdesk);
          return result;
        } catch (error) {
          return asFailure(error, "The adopted Workdesk could not be opened.");
        }
      }
      if (isIdentityRecovery(boundary)) {
        activeDesks.delete(event.sender);
        return recovered(dependencies, event.sender, boundary);
      }
      return rememberOpened(event.sender, boundary);
    },
    createWorkdesk: async (event, request, ...args) => {
      if (args.length !== 0 || !isCreateRequest(request)) return failure("invalid-request", "The Workdesk request was invalid.");
      let selected: WorkdeskFolderSelection;
      try { selected = await dependencies.pickWorkdeskParent(); } catch { return failure("folder-dialog-failed", "The Workdesk parent folder could not be selected."); }
      if (!isFolderSelection(selected)) return failure("folder-dialog-failed", "The Workdesk parent folder could not be selected.");
      if (selected.canceled || selected.filePaths.length === 0) return { kind: "cancelled" };
      if (selected.filePaths.length !== 1) return failure("invalid-request", "Choose one Workdesk parent folder.");
      try {
        const desk = await dependencies.service.create(selected.filePaths[0]!, request.title);
        return await rememberOpened(event.sender, desk);
      }
      catch (error) { return asFailure(error, "The Workdesk was created but could not be opened."); }
    },
    restoreWorkdesk: async (event, ...args) => {
      if (args.length !== 0) return failure("invalid-request", "The Workdesk request was invalid.");
      try {
        const boundary = await dependencies.service.restorePrimaryForActivation();
        if (boundary === undefined) return { kind: "none" };
        if (isIdentityRecovery(boundary)) {
          activeDesks.delete(event.sender);
          return recovered(dependencies, event.sender, boundary);
        }
        return await rememberOpened(event.sender, boundary);
      } catch (error) { return asFailure(error, "The previous Workdesk could not be restored."); }
    },
    returnToWorkdesk: async (event, ...args) => {
      if (args.length !== 0) return failure("invalid-request", "The Workdesk request was invalid.");
      try {
        const boundary = await dependencies.service.restorePrimaryForActivation();
        if (boundary === undefined) return { kind: "none" };
        if (isIdentityRecovery(boundary)) {
          activeDesks.delete(event.sender);
          return recovered(dependencies, event.sender, boundary);
        }
        return await rememberOpened(event.sender, boundary);
      } catch (error) { return asFailure(error, "The primary Workdesk could not be restored."); }
    },
    saveWorkdeskContext: async (event, request, ...args) => {
      if (args.length !== 0 || !isSaveWorkdeskContextRequest(request)) {
        return failure("invalid-request", "The Workdesk context request was invalid.");
      }
      const desk = currentDesk(event.sender, request.workdeskIdentityId);
      if ("kind" in desk) return desk;
      try {
        await dependencies.service.setLastActiveContext(desk, request.context);
        return Object.freeze({ kind: "saved" });
      } catch (error) { return asFailure(error, "The active Workdesk context could not be saved."); }
    },
    createWorkdeskFile: async (event, request, ...args) => {
      if (args.length !== 0 || !isCreateFileRequest(request)) {
        return failure("invalid-request", "New Workdesk documents must be memo, draft, or other.");
      }
      const projectRequest: CreateProjectFileRequest = {
        projectId: request.workdeskId,
        fileName: request.fileName,
        title: request.title,
        documentType: request.documentType,
        parentEntryId: request.parentEntryId
      };
      if (!await dependencies.isPermittedWorkdeskFolder(event.sender, projectRequest.projectId, projectRequest.parentEntryId ?? null)) {
        return failure("invalid-request", "Choose a folder in the Workdesk Explorer.");
      }
      // `workdeskId` on the wire is deliberately the opaque DocumentWorkspace
      // handle in `workdesk.documentId`; callers cannot turn a portable
      // repository UUID into a filesystem path.
      return dependencies.projects.createFileForOwner(event.sender, projectRequest.projectId, projectRequest.fileName, projectRequest.title, projectRequest.documentType, projectRequest.parentEntryId ?? null);
    },
    createWorkdeskProject: async (event, request, ...args) => {
      if (args.length !== 0 || !isCreateProjectRequest(request)) return failure("invalid-request", "The Workdesk Project request was invalid.");
      const desk = currentDesk(event.sender, request.workdeskIdentityId);
      if ("kind" in desk) return desk;
      try {
        const projectsRoot = await dependencies.service.prepareChildProjectDirectory(desk);
        const created = await dependencies.projects.createForWorkdesk(projectsRoot, request.title, desk.identity.id);
        if (created.kind !== "created") return failure(created.code, created.message);
        const boundary = await dependencies.service.validateDirectChildProject(desk, created.canonicalRoot);
        const checked = await dependencies.projects.validateProjectRoot(boundary.canonicalRoot);
        if (checked.kind !== "opened") return failure(checked.code, checked.message);
        let node: WorkdeskProjectNode;
        try { node = await register(desk, boundary); }
        catch (error) { return asFailure(error, "The Project was created but could not be registered with the Workdesk."); }
        const project = await dependencies.projects.openForOwner(event.sender, boundary.canonicalRoot);
        if (project.kind !== "opened") {
          return failure(project.code, project.message);
        }
        return Object.freeze({ kind: "opened", project, node });
      } catch (error) {
        return asFailure(error, "The Workdesk Project could not be created.");
      }
    },
    registerWorkdeskProject: async (event, request, ...args) => {
      if (args.length !== 0 || !isRegisterProjectRequest(request)) return failure("invalid-request", "The Workdesk Project request was invalid.");
      const desk = currentDesk(event.sender, request.workdeskIdentityId);
      if ("kind" in desk) return desk;
      let selected: WorkdeskFolderSelection;
      try { selected = await dependencies.pickExistingProjectFolder(); }
      catch { return failure("folder-dialog-failed", "The Project folder could not be selected."); }
      if (!isFolderSelection(selected)) return failure("folder-dialog-failed", "The Project folder could not be selected.");
      if (selected.canceled || selected.filePaths.length === 0) return { kind: "cancelled" };
      if (selected.filePaths.length !== 1) return failure("invalid-request", "Choose one Project folder.");
      try {
        const boundary = await dependencies.service.validateExternalProject(selected.filePaths[0]!, {
          expectedWorkdeskIdentityId: desk.identity.id,
          requireExistingMarker: true,
        });
        const checked = await dependencies.projects.validateProjectRoot(boundary.canonicalRoot);
        if (checked.kind !== "opened") return failure(checked.code, checked.message);
        const choice = await dependencies.confirmRegisterExistingProject();
        if (choice === "cancel") return { kind: "cancelled" };
        if (choice === "open-without-registration") {
          const project = await dependencies.projects.openForOwner(event.sender, boundary.canonicalRoot);
          if (project.kind !== "opened") return failure(project.code, project.message);
          return Object.freeze({ kind: "opened-unregistered", project });
        }
        const node = await register(desk, boundary);
        const project = await dependencies.projects.openForOwner(event.sender, boundary.canonicalRoot);
        if (project.kind !== "opened") return failure(project.code, project.message);
        return Object.freeze({ kind: "opened", project, node });
      } catch (error) {
        return asFailure(error, "Only a complete MAGINALIA Project can be registered.");
      }
    },
    removeWorkdeskProject: async (event, request, ...args) => {
      if (args.length !== 0 || !isRemoveProjectRequest(request)) return failure("invalid-request", "The Workdesk Project request was invalid.");
      const desk = currentDesk(event.sender, request.workdeskIdentityId);
      if ("kind" in desk) return desk;
      try {
        await dependencies.service.unregisterProject(desk, request.projectIdentityId);
        return Object.freeze({ kind: "removed" as const, projectIdentityId: request.projectIdentityId });
      } catch (error) {
        return asFailure(error, "The Project could not be removed from this Workdesk.");
      }
    },
    openWorkdeskProject: async (event, request, ...args) => {
      if (args.length !== 0 || !isOpenProjectRequest(request)) return failure("invalid-request", "The Workdesk Project request was invalid.");
      const desk = currentDesk(event.sender, request.workdeskIdentityId);
      if ("kind" in desk) return desk;
      try {
        const boundary = await dependencies.service.resolveRegisteredProject(desk, request.projectIdentityId);
        const project = await dependencies.projects.openForOwner(event.sender, boundary.canonicalRoot);
        if (project.kind !== "opened") return failure(project.code, project.message);
        const node = (await nodes(dependencies.service, desk)).find((candidate) => candidate.projectIdentityId.toLowerCase() === request.projectIdentityId.toLowerCase());
        if (!node) return failure("invalid-request", "This Project is no longer registered with the Workdesk.");
        return Object.freeze({ kind: "opened", project, node });
      } catch (error) {
        return asFailure(error, "The registered Project is unavailable on this PC.");
      }
    },
    copyWorkdeskFileToProject: async (event, request, ...args) => {
      if (args.length !== 0 || !isCopyRequest(request)) return failure("invalid-request", "The Workdesk copy request was invalid.");
      const active = activeDesks.get(event.sender);
      if (!active || active.documentId !== request.workdeskId) {
        return failure("workdesk-not-active", "Open the source Workdesk document before copying it.");
      }
      try {
        // Resolve the source while it is still bound to its active Workdesk
        // owner. The destination receives a private owner token so copy
        // preparation cannot replace the renderer's active workspace scope.
        const source = await dependencies.projects.readCopySourceForOwner(event.sender, request.workdeskId, request.sourceFileId);
        if ("kind" in source) return failure(source.code, source.message);
        const boundary = await dependencies.service.resolveRegisteredProject(active.desk, request.projectIdentityId);
        const copyOwner = Object.freeze({});
        const destination = await dependencies.projects.openForOwner(copyOwner, boundary.canonicalRoot);
        if (destination.kind !== "opened") return failure(destination.code, destination.message);
        const copied = await dependencies.projects.copySourceToProjectForOwner(copyOwner, destination.project.projectId, source, request.documentType);
        return copied.kind === "created" ? copied : failure(copied.code, copied.message);
      } catch (error) {
        return asFailure(error, "The Workdesk document could not be copied to the Project.");
      }
    }
  };
}
