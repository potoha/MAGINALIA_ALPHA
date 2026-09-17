/**
 * Narrow main-process IPC boundary for explicit Restore discovery.
 *
 * The handler accepts no renderer arguments. Provider authentication and the
 * verification prompt are injected by trusted main orchestration; only the
 * catalog's opaque display entries cross this boundary.
 */

import type {
  GitHubDeviceVerificationCallback,
  GitHubDeviceVerificationPrompt,
} from "./repository-github-auth.js";
import type { RepositoryCloudDiscoveryResult } from "./repository-cloud-discovery.js";
import {
  type RepositoryCloudRestoreCatalog,
  type RestoreCatalogEntry,
} from "./repository-cloud-restore-catalog.js";

export const DISCOVER_PRIVATE_WORKS_CHANNEL = "maginalia:discover-private-works" as const;
export const CANCEL_PRIVATE_WORKS_DISCOVERY_CHANNEL = "maginalia:cancel-private-works-discovery" as const;
export const GITHUB_DEVICE_PROMPT_CHANNEL = "maginalia:github-device-prompt" as const;
export const GITHUB_DEVICE_VERIFICATION_URI = "https://github.com/login/device" as const;

export type RepositoryCloudDevicePrompt = GitHubDeviceVerificationPrompt;

export interface CloudDiscoveryInvokeEvent {
  readonly sender: object;
}

export type CloudDiscoveryOperation = (
  owner: object,
  onVerification: GitHubDeviceVerificationCallback,
) => Promise<RepositoryCloudDiscoveryResult>;

export interface RepositoryCloudDiscoveryIpcDependencies {
  readonly discover: CloudDiscoveryOperation;
  /** Route each Device Flow prompt to the initiating main-process owner. */
  readonly createVerificationCallback: (owner: object) => GitHubDeviceVerificationCallback;
  readonly catalog: Pick<RepositoryCloudRestoreCatalog, "clearForOwner" | "registerForOwner">;
}

export type RepositoryCloudDiscoveryIpcErrorCode =
  | "invalid-request"
  | "discovery-failed"
  | "catalog-failed";

export interface RepositoryCloudDiscoveryIpcFailure {
  readonly kind: "error";
  readonly code: RepositoryCloudDiscoveryIpcErrorCode;
  readonly message: string;
}

export interface RepositoryCloudWorksResult {
  readonly kind: "works";
  readonly works: readonly RestoreCatalogEntry[];
}

export type RepositoryCloudDiscoveryIpcResult =
  | RepositoryCloudWorksResult
  | RepositoryCloudDiscoveryIpcFailure;

export type RepositoryCloudDiscoveryCancelResult = Readonly<
  | { readonly kind: "cancelled" }
  | { readonly kind: "idle" }
  | { readonly kind: "invalid-request" }
>;

export interface RepositoryCloudDiscoveryCancellationDependencies {
  readonly isCurrentOwner: (owner: object) => boolean;
  readonly cancelForOwner: (owner: object) => boolean;
}

export interface RepositoryCloudDiscoveryCancellationHandlers {
  readonly cancelPrivateWorksDiscovery: (
    event: CloudDiscoveryInvokeEvent,
    ...args: readonly unknown[]
  ) => RepositoryCloudDiscoveryCancelResult;
}

export interface RepositoryCloudDiscoveryHandlers {
  readonly discoverPrivateWorks: (
    event: CloudDiscoveryInvokeEvent,
    ...args: readonly unknown[]
  ) => Promise<RepositoryCloudDiscoveryIpcResult>;
}

const INVALID_REQUEST: RepositoryCloudDiscoveryIpcFailure = Object.freeze({
  kind: "error",
  code: "invalid-request",
  message: "The cloud discovery request was invalid.",
});

const DISCOVERY_FAILED: RepositoryCloudDiscoveryIpcFailure = Object.freeze({
  kind: "error",
  code: "discovery-failed",
  message: "Private cloud discovery could not be completed safely.",
});

const CATALOG_FAILED: RepositoryCloudDiscoveryIpcFailure = Object.freeze({
  kind: "error",
  code: "catalog-failed",
  message: "The private cloud discovery selection could not be retained safely.",
});

const CANCELLED: RepositoryCloudDiscoveryCancelResult = Object.freeze({ kind: "cancelled" });
const IDLE: RepositoryCloudDiscoveryCancelResult = Object.freeze({ kind: "idle" });
const INVALID_CANCEL_REQUEST: RepositoryCloudDiscoveryCancelResult = Object.freeze({
  kind: "invalid-request",
});

function isOwner(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

function isInvokeEvent(value: unknown): value is CloudDiscoveryInvokeEvent {
  if (value === null || typeof value !== "object") return false;
  try {
    const sender = (value as { readonly sender?: unknown }).sender;
    return isOwner(sender);
  } catch {
    return false;
  }
}

function validateDependencies(value: RepositoryCloudDiscoveryIpcDependencies): void {
  if (value === null || typeof value !== "object") throw new Error("invalid dependencies");
  if (typeof value.discover !== "function"
    || typeof value.createVerificationCallback !== "function"
    || value.catalog === null
    || typeof value.catalog !== "object"
    || typeof value.catalog.clearForOwner !== "function"
    || typeof value.catalog.registerForOwner !== "function") {
    throw new Error("invalid dependencies");
  }
}

function worksResult(works: readonly RestoreCatalogEntry[]): RepositoryCloudWorksResult {
  return Object.freeze({
    kind: "works" as const,
    works: Object.freeze(works.slice()),
  });
}

function validateCancellationDependencies(value: RepositoryCloudDiscoveryCancellationDependencies): void {
  if (value === null || typeof value !== "object"
    || typeof value.isCurrentOwner !== "function"
    || typeof value.cancelForOwner !== "function") {
    throw new Error("invalid dependencies");
  }
}

/**
 * Create a fixed, zero-argument cancellation handler. Ownership is checked
 * before cancellation so one renderer cannot abort or clear another owner's
 * active discovery or selection catalog.
 */
export function createRepositoryCloudDiscoveryCancellationHandlers(
  dependencies: RepositoryCloudDiscoveryCancellationDependencies,
): RepositoryCloudDiscoveryCancellationHandlers {
  validateCancellationDependencies(dependencies);
  return {
    cancelPrivateWorksDiscovery: (event, ...args) => {
      if (args.length !== 0 || !isInvokeEvent(event)) return INVALID_CANCEL_REQUEST;
      try {
        if (!dependencies.isCurrentOwner(event.sender)) return INVALID_CANCEL_REQUEST;
        return dependencies.cancelForOwner(event.sender) ? CANCELLED : IDLE;
      } catch {
        return INVALID_CANCEL_REQUEST;
      }
    },
  };
}

/**
 * Create one explicit, no-argument discovery handler. The catalog is cleared
 * before every accepted attempt, so a failed retry cannot leave stale choices
 * available to the renderer.
 */
export function createRepositoryCloudDiscoveryHandlers(
  dependencies: RepositoryCloudDiscoveryIpcDependencies,
): RepositoryCloudDiscoveryHandlers {
  validateDependencies(dependencies);
  const latestAttempt = new WeakMap<object, number>();
  let nextAttempt = 0;
  return {
    discoverPrivateWorks: async (event, ...args) => {
      if (args.length !== 0 || !isInvokeEvent(event)) return INVALID_REQUEST;
      const owner = event.sender;
      const attempt = ++nextAttempt;
      latestAttempt.set(owner, attempt);

      try {
        dependencies.catalog.clearForOwner(owner);
      } catch {
        return CATALOG_FAILED;
      }

      let onVerification: GitHubDeviceVerificationCallback;
      try {
        onVerification = dependencies.createVerificationCallback(owner);
        if (typeof onVerification !== "function") return DISCOVERY_FAILED;
      } catch {
        return DISCOVERY_FAILED;
      }

      let discovered: RepositoryCloudDiscoveryResult;
      try {
        discovered = await dependencies.discover(owner, onVerification);
      } catch {
        return DISCOVERY_FAILED;
      }

      if (latestAttempt.get(owner) !== attempt) return DISCOVERY_FAILED;
      try {
        return worksResult(dependencies.catalog.registerForOwner(owner, discovered));
      } catch {
        return CATALOG_FAILED;
      }
    },
  };
}
