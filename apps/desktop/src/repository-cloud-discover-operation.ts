/**
 * One explicit main-process Restore discovery operation. Authentication and
 * provider state live only for this call; no token or session is returned.
 */

import {
  GitHubDeviceFlowAdapter,
  type GitHubDeviceFlowRequest,
  type GitHubDeviceVerificationCallback,
} from "./repository-github-auth.js";
import {
  GitHubAdapter,
  type GitHubAccount,
  type GitHubOperationOptions,
} from "./repository-github.js";
import {
  discoverPrivateRepositories,
  type RepositoryCloudDiscoveryProvider,
  type RepositoryCloudDiscoveryResult,
} from "./repository-cloud-discovery.js";
import { resolveGitHubAppClientId } from "./repository-cloud-config.js";

export type RestoreDiscoveryOperationErrorCode =
  | "INVALID_INPUT"
  | "ABORTED"
  | "AUTH_FAILED"
  | "PROVIDER_FAILED"
  | "ACCOUNT_FAILED"
  | "DISCOVERY_FAILED"
  | "DISPOSE_FAILED";

const ERROR_MESSAGES: Readonly<Record<RestoreDiscoveryOperationErrorCode, string>> = Object.freeze({
  INVALID_INPUT: "The authenticated Restore discovery input is invalid.",
  ABORTED: "The authenticated Restore discovery was cancelled.",
  AUTH_FAILED: "GitHub authentication did not complete.",
  PROVIDER_FAILED: "The GitHub provider could not be prepared safely.",
  ACCOUNT_FAILED: "The authenticated GitHub account could not be verified.",
  DISCOVERY_FAILED: "GitHub Restore discovery could not be completed safely.",
  DISPOSE_FAILED: "The temporary GitHub provider could not be released safely.",
});

export class RestoreDiscoveryOperationError extends Error {
  public readonly userMessage: string;

  public constructor(public readonly code: RestoreDiscoveryOperationErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "RestoreDiscoveryOperationError";
    this.userMessage = this.message;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface AuthenticatedRestoreDiscoveryRequest {
  readonly signal: AbortSignal;
  readonly onVerification: GitHubDeviceVerificationCallback;
  readonly clientId?: unknown;
}

export interface RestoreDiscoveryAuthorizer {
  readonly authorize: (request: GitHubDeviceFlowRequest) => Promise<string>;
}

export interface RestoreDiscoveryProvider extends RepositoryCloudDiscoveryProvider {
  readonly account: (options?: GitHubOperationOptions) => Promise<GitHubAccount>;
  readonly dispose: () => void;
}

export interface AuthenticatedRestoreDiscoveryDependencies {
  readonly auth?: RestoreDiscoveryAuthorizer;
  readonly createProvider?: (operationToken: string) => RestoreDiscoveryProvider;
}

function invalidInput(): never {
  throw new RestoreDiscoveryOperationError("INVALID_INPUT");
}

function aborted(): never {
  throw new RestoreDiscoveryOperationError("ABORTED");
}

function isSignal(value: unknown): value is AbortSignal {
  return value !== null
    && typeof value === "object"
    && typeof (value as AbortSignal).addEventListener === "function"
    && typeof (value as AbortSignal).removeEventListener === "function"
    && typeof (value as AbortSignal).aborted === "boolean";
}

function validateRequest(value: AuthenticatedRestoreDiscoveryRequest): AuthenticatedRestoreDiscoveryRequest {
  if (value === null || typeof value !== "object"
    || !isSignal(value.signal)
    || typeof value.onVerification !== "function") invalidInput();
  if (value.signal.aborted) aborted();
  return value;
}

function validateAuthorizer(value: RestoreDiscoveryAuthorizer): RestoreDiscoveryAuthorizer {
  if (value === null || typeof value !== "object" || typeof value.authorize !== "function") invalidInput();
  return value;
}

function validateDependencies(
  value: AuthenticatedRestoreDiscoveryDependencies,
): AuthenticatedRestoreDiscoveryDependencies {
  if (value === null || typeof value !== "object") invalidInput();
  return value;
}

function validateProvider(value: RestoreDiscoveryProvider): RestoreDiscoveryProvider {
  if (value === null || typeof value !== "object"
    || typeof value.account !== "function"
    || typeof value.dispose !== "function"
    || typeof value.listPrivateRepositoryCandidates !== "function"
    || typeof value.readRestoreCandidateIdentity !== "function") {
    throw new RestoreDiscoveryOperationError("PROVIDER_FAILED");
  }
  return value;
}

function safeError(
  phase: "auth" | "provider" | "account" | "discovery",
  error: unknown,
  signal: AbortSignal,
): RestoreDiscoveryOperationError {
  if (error instanceof RestoreDiscoveryOperationError) return error;
  if (signal.aborted || (typeof error === "object" && error !== null && (error as { readonly code?: unknown }).code === "ABORTED")) {
    return new RestoreDiscoveryOperationError("ABORTED");
  }
  switch (phase) {
    case "auth":
      return new RestoreDiscoveryOperationError("AUTH_FAILED");
    case "provider":
      return new RestoreDiscoveryOperationError("PROVIDER_FAILED");
    case "account":
      return new RestoreDiscoveryOperationError("ACCOUNT_FAILED");
    case "discovery":
      return new RestoreDiscoveryOperationError("DISCOVERY_FAILED");
  }
}

function defaultProvider(operationToken: string): RestoreDiscoveryProvider {
  return new GitHubAdapter({ operationToken });
}

/**
 * Start one explicit authenticated Restore discovery. The account ID always
 * comes from GitHub's `/user` response; callers cannot supply or override it.
 */
export async function discoverAuthenticatedRestoreRepositories(
  request: AuthenticatedRestoreDiscoveryRequest,
  dependencies: AuthenticatedRestoreDiscoveryDependencies = {},
): Promise<RepositoryCloudDiscoveryResult> {
  const validatedRequest = validateRequest(request);
  const validatedDependencies = validateDependencies(dependencies);
  const auth = validatedDependencies.auth === undefined
    ? new GitHubDeviceFlowAdapter()
    : validateAuthorizer(validatedDependencies.auth);
  const createProvider = validatedDependencies.createProvider ?? defaultProvider;
  if (typeof createProvider !== "function") invalidInput();

  let operationToken: string | undefined;
  let provider: RestoreDiscoveryProvider | undefined;
  let phase: "auth" | "provider" | "account" | "discovery" = "auth";
  let safeFailure: RestoreDiscoveryOperationError | undefined;
  try {
    let clientId: string;
    try {
      clientId = resolveGitHubAppClientId(validatedRequest.clientId);
    } catch {
      invalidInput();
    }
    const authRequest: GitHubDeviceFlowRequest = {
      clientId,
      signal: validatedRequest.signal,
      onVerification: validatedRequest.onVerification,
    };
    operationToken = await auth.authorize(authRequest);
    if (typeof operationToken !== "string" || operationToken.length === 0 || operationToken.length > 4 * 1024) {
      throw new RestoreDiscoveryOperationError("AUTH_FAILED");
    }
    if (validatedRequest.signal.aborted) aborted();

    phase = "provider";
    provider = validateProvider(createProvider(operationToken));
    if (validatedRequest.signal.aborted) aborted();

    phase = "account";
    const account = await provider.account({ signal: validatedRequest.signal });
    if (!Number.isSafeInteger(account.id) || account.id <= 0) {
      throw new RestoreDiscoveryOperationError("ACCOUNT_FAILED");
    }

    phase = "discovery";
    return await discoverPrivateRepositories(provider, account.id, { signal: validatedRequest.signal });
  } catch (error) {
    safeFailure = safeError(phase, error, validatedRequest.signal);
    throw safeFailure;
  } finally {
    operationToken = undefined;
    if (provider !== undefined) {
      try {
        provider.dispose();
      } catch {
        if (safeFailure === undefined) {
          throw new RestoreDiscoveryOperationError("DISPOSE_FAILED");
        }
      }
    }
  }
}
