/**
 * Main-process-only classification of an already verified local/remote tip.
 *
 * This module is deliberately pure: it performs no transport, filesystem, or
 * repository mutation.  For a connected input, a null remote head means that
 * the caller has independently verified an empty remote; it must not be used
 * for an unknown or failed remote lookup.
 */

const SHA1_PATTERN = /^[0-9a-f]{40}$/u;
const NULL_SHA1 = "0".repeat(40);

export type RepositoryCloudSyncStatus =
  | "local-only"
  | "synced"
  | "local-ahead"
  | "remote-ahead"
  | "diverged"
  | "attention";

export type RepositoryCloudSyncAttentionCode =
  | "INVALID_INPUT"
  | "ANCESTRY_FAILED"
  | "CONTRADICTORY_ANCESTRY";

/**
 * When `connected` is true, `remoteHead: null` is only valid when the caller
 * has a verified empty remote.  A missing/unknown remote must be represented
 * by an attention result before this function is called.  When `connected` is
 * false, a null remote is the explicit local-only state.  The caller supplies
 * `connected` only after its private remote/connection proof is complete.
 */
export interface RepositoryCloudSyncInput {
  readonly connected: boolean;
  readonly localHead: string;
  readonly remoteHead: string | null;
}

/** `ancestor` is the candidate ancestor of `descendant`. */
export type RepositoryCloudSyncAncestryChecker = (
  ancestor: string,
  descendant: string,
) => Promise<boolean>;

export type RepositoryCloudSyncClassification = Readonly<{
  readonly status: Exclude<RepositoryCloudSyncStatus, "attention">;
}> | Readonly<{
  readonly status: "attention";
  readonly code: RepositoryCloudSyncAttentionCode;
}>;

function attention(code: RepositoryCloudSyncAttentionCode): RepositoryCloudSyncClassification {
  return Object.freeze({ status: "attention", code });
}

function status(value: Exclude<RepositoryCloudSyncStatus, "attention">): RepositoryCloudSyncClassification {
  return Object.freeze({ status: value });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function hasExactInputKeys(value: Record<string, unknown>): boolean {
  try {
    const names = Object.getOwnPropertyNames(value);
    if (Object.getOwnPropertySymbols(value).length !== 0 || names.length !== 3) return false;
    const expected = ["connected", "localHead", "remoteHead"] as const;
    return expected.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && "value" in descriptor;
    }) && names.every((key) => expected.includes(key as typeof expected[number]));
  } catch {
    return false;
  }
}

function readInput(value: Record<string, unknown>, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function isLowerSha1(value: unknown): value is string {
  return typeof value === "string"
    && value !== NULL_SHA1
    && SHA1_PATTERN.test(value)
    && value === value.toLowerCase();
}

/**
 * Classify a pinned local tip against a verified remote tip.
 *
 * Non-equal non-empty tips always use both ancestry directions.  This is two
 * calls by design: a checker that reports both directions true is contradictory
 * and cannot safely authorize either an ahead state or a sync operation.
 */
export async function classifyRepositoryCloudSync(
  input: RepositoryCloudSyncInput,
  isAncestor: RepositoryCloudSyncAncestryChecker,
): Promise<RepositoryCloudSyncClassification> {
  if (!isPlainRecord(input) || !hasExactInputKeys(input)) return attention("INVALID_INPUT");

  const connected = readInput(input, "connected");
  const localHead = readInput(input, "localHead");
  const remoteHead = readInput(input, "remoteHead");
  if (typeof connected !== "boolean" || !isLowerSha1(localHead)) return attention("INVALID_INPUT");
  if (remoteHead !== null && !isLowerSha1(remoteHead)) return attention("INVALID_INPUT");

  if (!connected) {
    // A remote tip while disconnected is contradictory rather than evidence
    // that the remote is usable.
    return remoteHead === null ? status("local-only") : attention("INVALID_INPUT");
  }
  if (remoteHead === null) return status("local-ahead");
  if (localHead === remoteHead) return status("synced");
  if (typeof isAncestor !== "function") return attention("INVALID_INPUT");

  let remoteIsAncestor: boolean;
  let localIsAncestor: boolean;
  try {
    remoteIsAncestor = await isAncestor(remoteHead, localHead);
    if (typeof remoteIsAncestor !== "boolean") return attention("ANCESTRY_FAILED");
    localIsAncestor = await isAncestor(localHead, remoteHead);
    if (typeof localIsAncestor !== "boolean") return attention("ANCESTRY_FAILED");
  } catch {
    return attention("ANCESTRY_FAILED");
  }

  if (remoteIsAncestor && localIsAncestor) return attention("CONTRADICTORY_ANCESTRY");
  if (remoteIsAncestor) return status("local-ahead");
  if (localIsAncestor) return status("remote-ahead");
  return status("diverged");
}
