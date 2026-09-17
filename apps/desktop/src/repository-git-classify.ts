/**
 * Main-process-only classification of two already fetched History tips in a
 * disposable LocalGitStage. This module performs no merge, checkout, or
 * active-repository operation.
 */

import * as git from "isomorphic-git";
import type { FsClient } from "isomorphic-git";
import { promises as fs } from "node:fs";
import type { RepositoryIdentity } from "@maginalia/repository-core" with { "resolution-mode": "import" };
import {
  MAIN_REF,
  validateLocalHistoryGraphAtRoot,
  type ReadLocalHistoryGraphOptions,
} from "./repository-local-history.js";
import { LocalGitStage, RepositoryGitStageError } from "./repository-git-stage.js";

const GIT_FS: FsClient = { promises: fs };
const SHA1 = /^[0-9a-f]{40}$/u;
const REMOTE_MAIN_REF = "refs/remotes/maginalia/main";

export type RepositoryGitClassification = "synced" | "local-ahead" | "remote-ahead" | "diverged";

export type RepositoryGitClassifyErrorCode =
  | "INVALID_INPUT"
  | "STAGE_REF_CHANGED"
  | "REMOTE_REF_CHANGED"
  | "ANCESTRY_FAILED";

const ERROR_MESSAGES: Readonly<Record<RepositoryGitClassifyErrorCode, string>> = Object.freeze({
  INVALID_INPUT: "The staged history classification input is invalid.",
  STAGE_REF_CHANGED: "The temporary stage main ref changed during classification.",
  REMOTE_REF_CHANGED: "The temporary stage remote main ref changed during classification.",
  ANCESTRY_FAILED: "The staged history ancestry could not be determined safely.",
});

export class RepositoryGitClassifyError extends Error {
  public readonly userMessage: string;

  public constructor(public readonly code: RepositoryGitClassifyErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "RepositoryGitClassifyError";
    this.userMessage = this.message;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface RepositoryGitClassifyOptions {
  /** Inject only isomorphic-git's stage-local ancestry operation in tests. */
  readonly gitClient?: Pick<typeof git, "isDescendent">;
  readonly limits?: ReadLocalHistoryGraphOptions["limits"];
  readonly maxObjectBytes?: number;
}

export interface RepositoryGitClassificationResult {
  readonly status: RepositoryGitClassification;
  readonly localHead: string;
  readonly remoteHead: string | null;
}

function fail(code: RepositoryGitClassifyErrorCode): never {
  throw new RepositoryGitClassifyError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function ownValue(value: Record<string, unknown>, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return undefined;
    if (!("value" in descriptor)) fail("INVALID_INPUT");
    return descriptor.value;
  } catch (error) {
    if (error instanceof RepositoryGitClassifyError) throw error;
    fail("INVALID_INPUT");
  }
}

function validateOptions(value: RepositoryGitClassifyOptions | undefined): RepositoryGitClassifyOptions {
  if (value === undefined) return {};
  if (!isPlainRecord(value)) fail("INVALID_INPUT");
  let keys: (string | symbol)[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    fail("INVALID_INPUT");
  }
  const allowed = new Set(["gitClient", "limits", "maxObjectBytes"]);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) fail("INVALID_INPUT");
  for (const key of keys) {
    if (typeof key !== "string") fail("INVALID_INPUT");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) fail("INVALID_INPUT");
  }
  const gitClient = ownValue(value, "gitClient");
  if (gitClient !== undefined && (!isRecord(gitClient) || typeof gitClient.isDescendent !== "function")) {
    fail("INVALID_INPUT");
  }
  const maxObjectBytes = ownValue(value, "maxObjectBytes");
  if (
    maxObjectBytes !== undefined
    && (typeof maxObjectBytes !== "number" || !Number.isSafeInteger(maxObjectBytes) || maxObjectBytes <= 0)
  ) {
    fail("INVALID_INPUT");
  }
  const limits = ownValue(value, "limits");
  if (limits !== undefined && !isPlainRecord(limits)) fail("INVALID_INPUT");
  return value;
}

function validateHead(value: unknown, allowNull = false): value is string | null {
  if (allowNull && value === null) return true;
  return typeof value === "string" && SHA1.test(value) && value === value.toLowerCase();
}

function isMissingRef(error: unknown): boolean {
  if (!isRecord(error)) return false;
  try {
    return error.code === "NotFoundError" || error.name === "NotFoundError";
  } catch {
    return false;
  }
}

async function resolveRequiredRef(root: string, ref: string, code: RepositoryGitClassifyErrorCode): Promise<string> {
  try {
    return await git.resolveRef({ fs: GIT_FS, dir: root, ref });
  } catch {
    fail(code);
  }
}

async function resolveOptionalRemoteRef(root: string): Promise<string | null> {
  try {
    return await git.resolveRef({ fs: GIT_FS, dir: root, ref: REMOTE_MAIN_REF });
  } catch (error) {
    if (isMissingRef(error)) return null;
    fail("REMOTE_REF_CHANGED");
  }
}

async function assertRefs(
  root: string,
  stageHead: string,
  expectedRemoteHead: string | null,
): Promise<void> {
  const actualMain = await resolveRequiredRef(root, MAIN_REF, "STAGE_REF_CHANGED");
  if (actualMain !== stageHead) fail("STAGE_REF_CHANGED");
  const actualRemote = await resolveOptionalRemoteRef(root);
  if (actualRemote !== expectedRemoteHead) fail("REMOTE_REF_CHANGED");
}

function result(
  status: RepositoryGitClassification,
  localHead: string,
  remoteHead: string | null,
): RepositoryGitClassificationResult {
  return Object.freeze({ status, localHead, remoteHead });
}

/**
 * Validate and classify the pinned local main against the fetched remote main.
 * Empty remote state is accepted only as the caller-provided null probe and
 * produces local-ahead after validating the local closure.
 */
export async function classifyStagedHistory(
  stage: LocalGitStage,
  expectedRemoteHead: string | null,
  expectedIdentity: RepositoryIdentity,
  options?: RepositoryGitClassifyOptions,
): Promise<RepositoryGitClassificationResult> {
  const normalizedOptions = validateOptions(options);
  if (!(stage instanceof LocalGitStage) || !validateHead(stage.head)) fail("INVALID_INPUT");
  if (!validateHead(expectedRemoteHead, true)) fail("INVALID_INPUT");

  try {
    return await stage.withOwnedDirectory(async (stagePath) => {
      await assertRefs(stagePath, stage.head, expectedRemoteHead);
      const graphOptions: ReadLocalHistoryGraphOptions = {
        limits: normalizedOptions.limits,
        maxObjectBytes: normalizedOptions.maxObjectBytes,
      };

      // Always validate the authored local closure, including an empty remote.
      await validateLocalHistoryGraphAtRoot(stagePath, stage.head, expectedIdentity, graphOptions);
      if (expectedRemoteHead === null) {
        await assertRefs(stagePath, stage.head, null);
        return result("local-ahead", stage.head, null);
      }

      // The remote closure is independently validated before ancestry. No
      // fetched object is trusted merely because its ref was advertised.
      await validateLocalHistoryGraphAtRoot(stagePath, expectedRemoteHead, expectedIdentity, graphOptions);
      await assertRefs(stagePath, stage.head, expectedRemoteHead);
      if (stage.head === expectedRemoteHead) {
        await assertRefs(stagePath, stage.head, expectedRemoteHead);
        return result("synced", stage.head, expectedRemoteHead);
      }

      let localDescendsRemote: boolean;
      let remoteDescendsLocal: boolean;
      const gitClient = normalizedOptions.gitClient ?? git;
      try {
        localDescendsRemote = await gitClient.isDescendent({
          fs: GIT_FS,
          dir: stagePath,
          oid: stage.head,
          ancestor: expectedRemoteHead,
        });
        remoteDescendsLocal = await gitClient.isDescendent({
          fs: GIT_FS,
          dir: stagePath,
          oid: expectedRemoteHead,
          ancestor: stage.head,
        });
      } catch {
        fail("ANCESTRY_FAILED");
      }
      await assertRefs(stagePath, stage.head, expectedRemoteHead);
      if (localDescendsRemote) return result("local-ahead", stage.head, expectedRemoteHead);
      if (remoteDescendsLocal) return result("remote-ahead", stage.head, expectedRemoteHead);
      return result("diverged", stage.head, expectedRemoteHead);
    });
  } catch (error) {
    if (error instanceof RepositoryGitClassifyError || error instanceof RepositoryGitStageError) throw error;
    throw error;
  }
}
