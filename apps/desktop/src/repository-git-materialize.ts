/**
 * Main-process-only recovery materialization from one validated remote tip.
 * The source is an opaque LocalGitStage; only a caller-allocated destination
 * containing its incomplete marker is eligible for publication later.
 */

import * as git from "isomorphic-git";
import type { FsClient } from "isomorphic-git";
import { promises as fs } from "node:fs";
import type { RepositoryIdentity } from "@maginalia/repository-core" with { "resolution-mode": "import" };
import {
  MAIN_REF,
  materializeHistoryCommitFromObjectRoot,
  validateLocalHistoryGraphAtRoot,
  type LocalHistoryMaterialization,
  type MaterializeHistoryOptions,
} from "./repository-local-history.js";
import { LocalGitStage } from "./repository-git-stage.js";

const GIT_FS: FsClient = { promises: fs };
const SHA1 = /^[0-9a-f]{40}$/u;
const REMOTE_MAIN_REF = "refs/remotes/maginalia/main";

export type RepositoryGitMaterializeErrorCode =
  | "INVALID_INPUT"
  | "STAGE_REF_CHANGED"
  | "REMOTE_REF_CHANGED";

const ERROR_MESSAGES: Readonly<Record<RepositoryGitMaterializeErrorCode, string>> = Object.freeze({
  INVALID_INPUT: "The staged remote materialization input is invalid.",
  STAGE_REF_CHANGED: "The temporary stage main ref changed during materialization.",
  REMOTE_REF_CHANGED: "The temporary stage remote main ref changed during materialization.",
});

export class RepositoryGitMaterializeError extends Error {
  public readonly userMessage: string;

  public constructor(public readonly code: RepositoryGitMaterializeErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "RepositoryGitMaterializeError";
    this.userMessage = this.message;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function fail(code: RepositoryGitMaterializeErrorCode): never {
  throw new RepositoryGitMaterializeError(code);
}

async function resolveRef(root: string, ref: string, code: RepositoryGitMaterializeErrorCode): Promise<string> {
  try {
    return await git.resolveRef({ fs: GIT_FS, dir: root, ref });
  } catch {
    fail(code);
  }
}

/**
 * Re-materialize a verified remote main tip into a fresh incomplete folder.
 * Every read and write occurs while the stage ownership gate is held; the
 * active repository is never opened or modified.
 */
export async function materializeRemoteFromStage(
  stage: LocalGitStage,
  expectedRemoteHead: string,
  expectedIdentity: RepositoryIdentity,
  destinationRoot: string,
  options?: MaterializeHistoryOptions,
): Promise<LocalHistoryMaterialization> {
  if (
    !(stage instanceof LocalGitStage)
    || !SHA1.test(stage.head)
    || stage.head !== stage.head.toLowerCase()
    || typeof expectedRemoteHead !== "string"
    || !SHA1.test(expectedRemoteHead)
    || expectedRemoteHead !== expectedRemoteHead.toLowerCase()
    || typeof destinationRoot !== "string"
    || destinationRoot.trim().length === 0
  ) {
    fail("INVALID_INPUT");
  }

  return stage.withOwnedDirectory(async (stagePath) => {
    const mainBefore = await resolveRef(stagePath, MAIN_REF, "STAGE_REF_CHANGED");
    if (mainBefore !== stage.head) fail("STAGE_REF_CHANGED");
    const remoteBefore = await resolveRef(stagePath, REMOTE_MAIN_REF, "REMOTE_REF_CHANGED");
    if (remoteBefore !== expectedRemoteHead) fail("REMOTE_REF_CHANGED");

    // Perform the complete secret/path/identity/object walk before the
    // destination is even inspected for initialization.
    await validateLocalHistoryGraphAtRoot(
      stagePath,
      expectedRemoteHead,
      expectedIdentity,
      options,
    );

    const materialized = await materializeHistoryCommitFromObjectRoot(
      stagePath,
      destinationRoot,
      expectedRemoteHead,
      expectedIdentity,
      options,
    );

    const mainAfter = await resolveRef(stagePath, MAIN_REF, "STAGE_REF_CHANGED");
    const remoteAfter = await resolveRef(stagePath, REMOTE_MAIN_REF, "REMOTE_REF_CHANGED");
    if (mainAfter !== mainBefore) fail("STAGE_REF_CHANGED");
    if (remoteAfter !== remoteBefore) fail("REMOTE_REF_CHANGED");
    return materialized;
  });
}
