/**
 * Explicit, read-only GitHub App Device Flow preflight.
 *
 * This script is intentionally opt-in. It never creates a repository and it
 * keeps the short-lived access token in memory only long enough to call the
 * provider's GET /user validation operation.
 */

import process from "node:process";

const LIVE_GATE = "1";
const CLIENT_ID_ENV = "MAGINALIA_GITHUB_APP_CLIENT_ID";
const VERIFICATION_URI = "https://github.com/login/device";
const MAX_USER_CODE_LENGTH = 64;
const USER_CODE_PATTERN = /^[A-Za-z0-9-]+$/;

const KNOWN_ERROR_CODES = new Set([
  "INVALID_INPUT",
  "AUTH_REQUEST_FAILED",
  "AUTHORIZATION_DENIED",
  "DEVICE_CODE_EXPIRED",
  "RATE_LIMITED",
  "NETWORK_ERROR",
  "TIMEOUT",
  "ABORTED",
  "RESPONSE_TOO_LARGE",
  "INVALID_RESPONSE",
  "REDIRECT_REJECTED",
  "CALLBACK_FAILED",
  "AUTH_REQUIRED",
  "AUTH_REVOKED",
  "PERMISSION_DENIED",
  "REMOTE_NOT_FOUND",
  "REMOTE_REQUEST_FAILED",
  "REMOTE_NOT_PRIVATE",
  "REMOTE_MISMATCH",
  "REMOTE_CREATE_UNKNOWN",
  "DISPOSED",
]);

function writeLine(line) {
  process.stdout.write(`${line}\n`);
}

function errorCode(error) {
  try {
    if (error !== null && typeof error === "object") {
      const code = error.code;
      if (typeof code === "string" && KNOWN_ERROR_CODES.has(code)) return code;
    }
  } catch {
    // Treat unexpected provider values as a fixed network failure.
  }
  return "NETWORK_ERROR";
}

function exported(moduleNamespace, name) {
  const direct = moduleNamespace?.[name];
  if (direct !== undefined) return direct;
  return moduleNamespace?.default?.[name];
}

async function loadBuiltModules() {
  try {
    const [authModule, providerModule] = await Promise.all([
      import("../dist/main/repository-github-auth.js"),
      import("../dist/main/repository-github.js"),
    ]);
    const GitHubDeviceFlowAdapter = exported(authModule, "GitHubDeviceFlowAdapter");
    const GitHubAdapter = exported(providerModule, "GitHubAdapter");
    const verificationUri = exported(authModule, "GITHUB_DEVICE_VERIFICATION_URI");
    if (typeof GitHubDeviceFlowAdapter !== "function"
      || typeof GitHubAdapter !== "function"
      || verificationUri !== VERIFICATION_URI) {
      return undefined;
    }
    return { GitHubDeviceFlowAdapter, GitHubAdapter };
  } catch {
    return undefined;
  }
}

function safeUserCode(prompt) {
  try {
    const value = prompt?.userCode;
    if (typeof value === "string"
      && value.length > 0
      && value.length <= MAX_USER_CODE_LENGTH
      && USER_CODE_PATTERN.test(value)) {
      return value;
    }
  } catch {
    // The auth adapter owns prompt validation; a failed local check is safe.
  }
  return undefined;
}

async function runLivePreflight(clientId) {
  const modules = await loadBuiltModules();
  if (!modules) {
    writeLine("BUILD_REQUIRED: build the desktop main process before live auth preflight.");
    return 2;
  }

  const abortController = new AbortController();
  let interrupted = false;
  const abort = () => {
    interrupted = true;
    abortController.abort();
  };
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);

  let accessToken;
  let provider;
  try {
    const auth = new modules.GitHubDeviceFlowAdapter();
    accessToken = await auth.authorize({
      clientId,
      signal: abortController.signal,
      onVerification: (prompt) => {
        const userCode = safeUserCode(prompt);
        if (userCode === undefined) throw new Error("invalid verification prompt");
        writeLine(`Open ${VERIFICATION_URI} and enter code ${userCode}.`);
      },
    });

    provider = new modules.GitHubAdapter({ operationToken: accessToken });
    const account = await provider.account({ signal: abortController.signal });
    writeLine(`GitHub account verified: @${account.login} (id ${account.id}).`);
    return 0;
  } catch (error) {
    const code = interrupted ? "ABORTED" : errorCode(error);
    writeLine(`GITHUB_LIVE_AUTH_FAILED: ${code}.`);
    return 1;
  } finally {
    try {
      provider?.dispose();
    } catch {
      // Disposal is best effort after a fixed outcome has been reported.
    }
    provider = undefined;
    accessToken = undefined;
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

async function main() {
  if (process.env.MAGINALIA_GITHUB_LIVE !== LIVE_GATE) {
    writeLine("GitHub live auth preflight skipped; set MAGINALIA_GITHUB_LIVE=1 to opt in.");
    return 0;
  }

  const clientId = process.env[CLIENT_ID_ENV];
  if (typeof clientId !== "string" || clientId.length === 0) {
    writeLine(`GITHUB_LIVE_AUTH_FAILED: INVALID_INPUT (set ${CLIENT_ID_ENV}).`);
    return 2;
  }
  return runLivePreflight(clientId);
}

process.exitCode = await main();
