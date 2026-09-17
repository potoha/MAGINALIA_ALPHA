/**
 * Main-process-only public cloud configuration.  This is a GitHub App Client
 * ID, never a Client Secret, access token, or refresh token.
 */

export const GITHUB_APP_CLIENT_ID = "Iv23livUmwQdnyi2NOHe" as const;

const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]+$/u;
const MAX_CLIENT_ID_LENGTH = 200;

export type RepositoryCloudConfigErrorCode = "INVALID_CLIENT_ID";

const ERROR_MESSAGES: Readonly<Record<RepositoryCloudConfigErrorCode, string>> = Object.freeze({
  INVALID_CLIENT_ID: "The GitHub App Client ID configuration is invalid.",
});

export class RepositoryCloudConfigError extends Error {
  public readonly userMessage: string;

  public constructor(public readonly code: RepositoryCloudConfigErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "RepositoryCloudConfigError";
    this.userMessage = this.message;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Resolve the public Client ID for one explicit auth operation. An omitted
 * value uses the registered app's public default; callers may inject another
 * validated public ID for a separate app without introducing a secret.
 */
export function resolveGitHubAppClientId(value: unknown = GITHUB_APP_CLIENT_ID): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > MAX_CLIENT_ID_LENGTH
    || !CLIENT_ID_PATTERN.test(value)) {
    throw new RepositoryCloudConfigError("INVALID_CLIENT_ID");
  }
  return value;
}
