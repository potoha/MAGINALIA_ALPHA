import {
  discoverAuthenticatedRestoreRepositories,
  type AuthenticatedRestoreDiscoveryRequest,
} from "./repository-cloud-discover-operation.js";
import type { GitHubDeviceVerificationCallback } from "./repository-github-auth.js";
import type {
  RepositoryCloudDiscoveryResult,
} from "./repository-cloud-discovery.js";
import { RepositoryCloudRestoreCatalog } from "./repository-cloud-restore-catalog.js";

const INACTIVE_OWNER_MESSAGE = "The cloud discovery owner is not active.";
const STALE_OPERATION_MESSAGE = "The cloud discovery operation is no longer active.";
const INVALID_INPUT_MESSAGE = "The cloud discovery coordinator input was invalid.";

export type RepositoryCloudDiscoveryOperation = (
  request: AuthenticatedRestoreDiscoveryRequest,
) => Promise<RepositoryCloudDiscoveryResult>;

/**
 * The Electron main process owns the concrete owner (WebContents) and its
 * lifecycle event.  The coordinator only needs a registration hook so that
 * its owner-scoped operation state can be torn down without importing
 * Electron types into the cloud operation layer.
 */
export type RepositoryCloudOwnerLifecycleRegistration = (
  owner: object,
  onClose: () => void,
) => void | (() => void);

export interface RepositoryCloudCoordinatorOptions {
  /** Check the current main-process owner/window before starting or finishing. */
  readonly isLiveOwner: (owner: object) => boolean;
  /** Register an owner-destroyed callback and optionally return its removal. */
  readonly registerOwnerLifecycle?: RepositoryCloudOwnerLifecycleRegistration;
  /** Injected for focused tests; defaults to the authenticated read-only flow. */
  readonly discover?: RepositoryCloudDiscoveryOperation;
  /** Injected catalog is useful for testing; production creates one here. */
  readonly catalog?: RepositoryCloudRestoreCatalog;
}

function isOwner(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

function isLiveOwnerSafely(
  isLiveOwner: (owner: object) => boolean,
  owner: object,
): boolean {
  try {
    return isLiveOwner(owner) === true;
  } catch {
    return false;
  }
}

function validateOptions(value: RepositoryCloudCoordinatorOptions): void {
  if (value === null || typeof value !== "object"
    || typeof value.isLiveOwner !== "function"
    || (value.registerOwnerLifecycle !== undefined && typeof value.registerOwnerLifecycle !== "function")
    || (value.discover !== undefined && typeof value.discover !== "function")
    || (value.catalog !== undefined
      && (value.catalog === null
        || typeof value.catalog !== "object"
        || typeof value.catalog.clearForOwner !== "function"
        || typeof value.catalog.registerForOwner !== "function"
        || typeof value.catalog.dispose !== "function"))) {
    throw new TypeError(INVALID_INPUT_MESSAGE);
  }
}

/**
 * Main-process owner of the transient, read-only private-cloud discovery
 * operation.  It deliberately does not own the durable pending-creation
 * ledger or any provisioning path; those remain separate authorities.
 */
export class RepositoryCloudCoordinator {
  public readonly catalog: RepositoryCloudRestoreCatalog;

  private readonly isLiveOwner: (owner: object) => boolean;
  private readonly registerOwnerLifecycle: RepositoryCloudOwnerLifecycleRegistration | undefined;
  private readonly discoverOperation: RepositoryCloudDiscoveryOperation;
  private readonly controllers = new WeakMap<object, AbortController>();
  private readonly lifecycleCleanup = new WeakMap<object, () => void>();
  private readonly owners = new Set<object>();
  private readonly closedOwners = new WeakSet<object>();
  private disposed = false;

  public constructor(options: RepositoryCloudCoordinatorOptions) {
    validateOptions(options);
    this.isLiveOwner = options.isLiveOwner;
    this.registerOwnerLifecycle = options.registerOwnerLifecycle;
    this.discoverOperation = options.discover ?? discoverAuthenticatedRestoreRepositories;
    this.catalog = options.catalog ?? new RepositoryCloudRestoreCatalog();
  }

  /**
   * Run one explicit discovery for an owner. A later attempt for the same
   * owner aborts the previous one; the IPC layer remains responsible for its
   * attempt-generation/catalog-registration guard.
   */
  public async discoverForOwner(
    owner: object,
    onVerification: GitHubDeviceVerificationCallback,
  ): Promise<RepositoryCloudDiscoveryResult> {
    if (!isOwner(owner) || typeof onVerification !== "function") {
      throw new Error(INVALID_INPUT_MESSAGE);
    }
    if (!this.isCurrentOwner(owner)) throw new Error(INACTIVE_OWNER_MESSAGE);

    this.attachOwnerLifecycle(owner);
    if (!this.isCurrentOwner(owner)) {
      this.cancelForOwner(owner);
      throw new Error(INACTIVE_OWNER_MESSAGE);
    }
    this.controllers.get(owner)?.abort();
    const controller = new AbortController();
    this.controllers.set(owner, controller);

    const guardedVerification: GitHubDeviceVerificationCallback = (prompt) => {
      if (!this.isCurrentOperation(owner, controller)) {
        throw new Error("The cloud verification prompt could not be delivered.");
      }
      return onVerification(prompt);
    };

    try {
      const result = await this.discoverOperation({
        signal: controller.signal,
        onVerification: guardedVerification,
      });
      if (!this.isCurrentOperation(owner, controller)) {
        throw new Error(STALE_OPERATION_MESSAGE);
      }
      return result;
    } catch (error) {
      // A dead/closed owner, cancellation, disposal, or a superseded
      // operation must never complete successfully.  Keep these errors fixed
      // so no provider token/path/error can reach the renderer through IPC.
      if (!this.isCurrentOperation(owner, controller)) {
        throw new Error(STALE_OPERATION_MESSAGE);
      }
      throw error;
    } finally {
      if (this.controllers.get(owner) === controller) {
        this.controllers.delete(owner);
        if (!this.isCurrentOwner(owner)) this.clearCatalogForOwner(owner);
      }
    }
  }

  /** Alias used by main-process IPC wiring and future cloud operations. */
  public discover(
    owner: object,
    onVerification: GitHubDeviceVerificationCallback,
  ): Promise<RepositoryCloudDiscoveryResult> {
    return this.discoverForOwner(owner, onVerification);
  }

  /** True only while the owner can still initiate a main-process operation. */
  public isCurrentOwner(owner: object): boolean {
    return !this.disposed
      && isOwner(owner)
      && !this.closedOwners.has(owner)
      && isLiveOwnerSafely(this.isLiveOwner, owner);
  }

  /**
   * Abort and clear one owner's active operation/catalog. Returns false when
   * there was no active operation, while still clearing any stale selection.
   */
  public cancelForOwner(owner: object): boolean {
    if (!isOwner(owner)) return false;
    const controller = this.controllers.get(owner);
    if (controller !== undefined) {
      controller.abort();
      this.controllers.delete(owner);
    }
    this.clearCatalogForOwner(owner);
    return controller !== undefined;
  }

  /** Close one owner, including the WebContents-destroyed path. */
  public closeOwner(owner: object): void {
    if (!isOwner(owner)) return;
    this.closedOwners.add(owner);
    this.cancelForOwner(owner);
    const cleanup = this.lifecycleCleanup.get(owner);
    if (cleanup !== undefined) {
      this.lifecycleCleanup.delete(owner);
      try {
        cleanup();
      } catch {
        // A destroyed owner cannot be reattached; state is already closed.
      }
    }
    this.owners.delete(owner);
  }

  /** Abort all owners and dispose the owner-bound catalog during app quit. */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const owner of [...this.owners]) this.closeOwner(owner);
    this.catalog.dispose();
  }

  private attachOwnerLifecycle(owner: object): void {
    if (this.owners.has(owner) || this.registerOwnerLifecycle === undefined) {
      this.owners.add(owner);
      return;
    }
    const onClose = (): void => this.closeOwner(owner);
    let cleanup: void | (() => void);
    try {
      cleanup = this.registerOwnerLifecycle(owner, onClose);
    } catch {
      throw new Error(INACTIVE_OWNER_MESSAGE);
    }
    if (cleanup !== undefined && typeof cleanup !== "function") {
      throw new Error(INACTIVE_OWNER_MESSAGE);
    }
    if (cleanup !== undefined) this.lifecycleCleanup.set(owner, cleanup);
    this.owners.add(owner);
  }

  private isCurrentOperation(owner: object, controller: AbortController): boolean {
    return this.controllers.get(owner) === controller
      && !controller.signal.aborted
      && this.isCurrentOwner(owner);
  }

  private clearCatalogForOwner(owner: object): void {
    try {
      this.catalog.clearForOwner(owner);
    } catch {
      // Disposal is intentionally idempotent and fail-closed.
    }
  }
}

export function createRepositoryCloudCoordinator(
  options: RepositoryCloudCoordinatorOptions,
): RepositoryCloudCoordinator {
  return new RepositoryCloudCoordinator(options);
}
