/**
 * Main-process-only validation wrapper for a fetched stage. It binds the
 * arbitrary validated OID to the stage's remote-tracking main ref while the
 * stage ownership gate is held, then rechecks both refs after the read.
 */

import * as git from "isomorphic-git";
import type { FsClient } from "isomorphic-git";
import { promises as fs } from "node:fs";
import type { RepositoryIdentity } from "@maginalia/repository-core" with { "resolution-mode": "import" };
import {
  MAIN_REF,
  validateLocalHistoryGraphAtRoot,
  type ReadLocalHistoryGraphOptions,
  type ValidatedLocalHistoryGraph,
} from "./repository-local-history.js";
import { LocalGitStage, RepositoryGitStageError } from "./repository-git-stage.js";

const GIT_FS: FsClient = { promises: fs };
const SHA1 = /^[0-9a-f]{40}$/u;
const REMOTE_MAIN_REF = "refs/remotes/maginalia/main";

export type RepositoryGitValidateErrorCode = "INVALID_INPUT" | "STAGE_REF_CHANGED" | "REMOTE_REF_CHANGED";

const ERROR_MESSAGES: Readonly<Record<RepositoryGitValidateErrorCode, string>> = Object.freeze({
  INVALID_INPUT: "The staged remote history validation input is invalid.",
  STAGE_REF_CHANGED: "The temporary stage changed unexpectedly during validation.",
  REMOTE_REF_CHANGED: "The staged remote main ref changed during validation.",
});

export class RepositoryGitValidateError extends Error {
  public readonly userMessage: string;

  public constructor(public readonly code: RepositoryGitValidateErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "RepositoryGitValidateError";
    this.userMessage = this.message;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function fail(code: RepositoryGitValidateErrorCode): never {
  throw new RepositoryGitValidateError(code);
}

async function resolveRef(root: string, ref: string, code: RepositoryGitValidateErrorCode): Promise<string> {
  try {
    return await git.resolveRef({ fs: GIT_FS, dir: root, ref });
  } catch {
    fail(code);
  }
}

/**
 * Validate the remote main closure already fetched into `stage`. The local
 * main branch remains pinned to the authored stage head; only the exact
 * `refs/remotes/maginalia/main` OID is validated as the remote candidate.
 */
export async function validateFetchedStageHistory(
  stage: LocalGitStage,
  expectedRemoteHead: string,
  expectedIdentity: RepositoryIdentity,
  options?: ReadLocalHistoryGraphOptions,
): Promise<ValidatedLocalHistoryGraph> {
  if (!(stage instanceof LocalGitStage) || !SHA1.test(stage.head) || stage.head !== stage.head.toLowerCase()) {
    fail("INVALID_INPUT");
  }
  if (
    typeof expectedRemoteHead !== "string"
    || !SHA1.test(expectedRemoteHead)
    || expectedRemoteHead !== expectedRemoteHead.toLowerCase()
  ) {
    fail("INVALID_INPUT");
  }
  try {
    return await stage.withOwnedDirectory(async (stagePath) => {
      const mainBefore = await resolveRef(stagePath, MAIN_REF, "STAGE_REF_CHANGED");
      if (mainBefore !== stage.head) fail("STAGE_REF_CHANGED");
      const remoteBefore = await resolveRef(stagePath, REMOTE_MAIN_REF, "REMOTE_REF_CHANGED");
      if (remoteBefore !== expectedRemoteHead) fail("REMOTE_REF_CHANGED");

      const validated = await validateLocalHistoryGraphAtRoot(
        stagePath,
        expectedRemoteHead,
        expectedIdentity,
        options,
      );

      const mainAfter = await resolveRef(stagePath, MAIN_REF, "STAGE_REF_CHANGED");
      const remoteAfter = await resolveRef(stagePath, REMOTE_MAIN_REF, "REMOTE_REF_CHANGED");
      if (mainAfter !== mainBefore) fail("STAGE_REF_CHANGED");
      if (remoteAfter !== remoteBefore) fail("REMOTE_REF_CHANGED");
      return validated;
    });
  } catch (error) {
    if (error instanceof RepositoryGitValidateError) throw error;
    if (error instanceof RepositoryGitStageError) throw error;
    throw error;
  }
}
