/**
 * Main-process-only local-first Sync preflight.
 *
 * This helper owns no authentication, network client, token, or renderer
 * boundary.  Its returned graph contains raw Git object bytes and therefore
 * must stay inside trusted main-process orchestration; it is not a renderer
 * DTO.  The pin is a bounded handoff, not a claim of impossible TOCTOU
 * exclusion: the later transport/materialization boundary must revalidate it.
 */

import { isAbsolute } from "node:path";
import type { RepositoryIdentity } from "@maginalia/repository-core" with { "resolution-mode": "import" };
import {
  captureWorkingTree,
  createHistorySnapshot,
  inspectRepository,
  readLocalHistoryGraph,
  type LocalHistoryObjectGraph,
  type LocalHistorySnapshot,
  type LocalRepositoryInspection,
} from "./repository-local-history.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SHA1_PATTERN = /^[0-9a-f]{40}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/iu;
type ParseIdentity = typeof import("@maginalia/repository-core", {
  with: { "resolution-mode": "import" }
})["parseIdentity"];

let parseIdentityPromise: Promise<ParseIdentity> | undefined;

export type RepositoryCloudLocalPreflightErrorCode =
  | "INVALID_INPUT"
  | "DIRTY_CONTENT"
  | "SNAPSHOT_FAILED"
  | "GRAPH_FAILED"
  | "WORKING_TREE_CHANGED"
  | "IDENTITY_MISMATCH"
  | "LOCAL_STATE_CHANGED";

const ERROR_MESSAGES: Readonly<Record<RepositoryCloudLocalPreflightErrorCode, string>> = Object.freeze({
  INVALID_INPUT: "The local cloud preflight input is invalid.",
  DIRTY_CONTENT: "Unsaved local content must be resolved before cloud setup.",
  SNAPSHOT_FAILED: "The local History snapshot could not be established safely.",
  GRAPH_FAILED: "The local History graph could not be validated safely.",
  WORKING_TREE_CHANGED: "The local working tree changed during cloud preflight.",
  IDENTITY_MISMATCH: "The local repository identity changed during cloud preflight.",
  LOCAL_STATE_CHANGED: "The local repository state changed during cloud preflight.",
});

/** Errors contain only a fixed local classification; never provider/path data. */
export class RepositoryCloudLocalPreflightError extends Error {
  public readonly code: RepositoryCloudLocalPreflightErrorCode;
  public readonly userMessage: string;

  public constructor(code: RepositoryCloudLocalPreflightErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "RepositoryCloudLocalPreflightError";
    this.code = code;
    this.userMessage = this.message;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type AssertNoDirtyContent = () => void | Promise<void>;

/**
 * Main-only result handed to later cloud orchestration.  `canonicalRoot` is
 * intentionally not a renderer-facing value; the graph's bytes are likewise
 * kept behind this trusted main-process boundary.
 */
export interface RepositoryCloudLocalPin {
  readonly canonicalRoot: string;
  readonly identity: RepositoryIdentity;
  readonly snapshot: LocalHistorySnapshot;
  readonly graph: LocalHistoryObjectGraph;
  readonly workingTreeFingerprint: string;
}

function fail(code: RepositoryCloudLocalPreflightErrorCode): never {
  throw new RepositoryCloudLocalPreflightError(code);
}

async function loadParseIdentity(): Promise<ParseIdentity> {
  parseIdentityPromise ??= import("@maginalia/repository-core").then((module) => module.parseIdentity);
  return parseIdentityPromise;
}

async function normalizeIdentity(value: unknown): Promise<RepositoryIdentity> {
  try {
    const parseIdentity = await loadParseIdentity();
    const parsed = parseIdentity(value);
    if (!UUID_PATTERN.test(parsed.id)) fail("INVALID_INPUT");
    return Object.freeze({ ...parsed, id: parsed.id.toLowerCase() });
  } catch (error) {
    if (error instanceof RepositoryCloudLocalPreflightError) throw error;
    fail("INVALID_INPUT");
  }
}

function sameIdentity(left: RepositoryIdentity, right: RepositoryIdentity): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.id.toLowerCase() === right.id.toLowerCase()
    && left.kind === right.kind
    && left.title === right.title
    && left.templateVersion === right.templateVersion;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  try {
    const code = (error as { readonly code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

function normalizeSnapshotFailure(error: unknown): RepositoryCloudLocalPreflightError {
  if (error instanceof RepositoryCloudLocalPreflightError) return error;
  const code = errorCode(error);
  if (code === "changed") return new RepositoryCloudLocalPreflightError("LOCAL_STATE_CHANGED");
  if (code === "invalid-identity") return new RepositoryCloudLocalPreflightError("IDENTITY_MISMATCH");
  return new RepositoryCloudLocalPreflightError("SNAPSHOT_FAILED");
}

function normalizeGraphFailure(error: unknown): RepositoryCloudLocalPreflightError {
  if (error instanceof RepositoryCloudLocalPreflightError) return error;
  const code = errorCode(error);
  if (code === "changed") return new RepositoryCloudLocalPreflightError("LOCAL_STATE_CHANGED");
  if (code === "invalid-identity") return new RepositoryCloudLocalPreflightError("IDENTITY_MISMATCH");
  return new RepositoryCloudLocalPreflightError("GRAPH_FAILED");
}

function normalizeInspectionFailure(error: unknown): RepositoryCloudLocalPreflightError {
  if (error instanceof RepositoryCloudLocalPreflightError) return error;
  const code = errorCode(error);
  if (code === "changed") return new RepositoryCloudLocalPreflightError("LOCAL_STATE_CHANGED");
  if (code === "invalid-identity") return new RepositoryCloudLocalPreflightError("IDENTITY_MISMATCH");
  return new RepositoryCloudLocalPreflightError("LOCAL_STATE_CHANGED");
}

async function runDirtyGuard(assertNoDirtyContent: AssertNoDirtyContent): Promise<void> {
  try {
    await assertNoDirtyContent();
  } catch {
    fail("DIRTY_CONTENT");
  }
}

function validateRoot(root: unknown): asserts root is string {
  if (typeof root !== "string" || root.length === 0 || root.trim() !== root || !isAbsolute(root)) {
    fail("INVALID_INPUT");
  }
}

function validateGuard(value: unknown): asserts value is AssertNoDirtyContent {
  if (typeof value !== "function") fail("INVALID_INPUT");
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

function ownValue(value: Record<string, unknown>, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function hasExactDataKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  try {
    const ownNames = Object.getOwnPropertyNames(value);
    return Object.getOwnPropertySymbols(value).length === 0
      && ownNames.length === keys.length
      && keys.every((key) => ownNames.includes(key))
      && ownNames.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && "value" in descriptor;
      });
  } catch {
    return false;
  }
}

async function validatePin(value: unknown): Promise<RepositoryCloudLocalPin> {
  if (!isPlainRecord(value)
    || !hasExactDataKeys(value, ["canonicalRoot", "identity", "snapshot", "graph", "workingTreeFingerprint"])) {
    fail("INVALID_INPUT");
  }
  const canonicalRoot = ownValue(value, "canonicalRoot");
  if (typeof canonicalRoot !== "string"
    || canonicalRoot.length === 0
    || canonicalRoot.trim() !== canonicalRoot
    || !isAbsolute(canonicalRoot)) {
    fail("INVALID_INPUT");
  }
  const identity = await normalizeIdentity(ownValue(value, "identity"));
  const workingTreeFingerprint = ownValue(value, "workingTreeFingerprint");
  if (typeof workingTreeFingerprint !== "string" || !SHA256_PATTERN.test(workingTreeFingerprint)) {
    fail("INVALID_INPUT");
  }

  const snapshotValue = ownValue(value, "snapshot");
  if (!isPlainRecord(snapshotValue)
    || !hasExactDataKeys(snapshotValue, ["head", "fingerprint", "created"])) {
    fail("INVALID_INPUT");
  }
  const snapshotHead = ownValue(snapshotValue, "head");
  const snapshotFingerprint = ownValue(snapshotValue, "fingerprint");
  const snapshotCreated = ownValue(snapshotValue, "created");
  if (typeof snapshotHead !== "string"
    || !SHA1_PATTERN.test(snapshotHead)
    || typeof snapshotFingerprint !== "string"
    || !SHA256_PATTERN.test(snapshotFingerprint)
    || typeof snapshotCreated !== "boolean"
    || snapshotFingerprint.toLowerCase() !== workingTreeFingerprint.toLowerCase()) {
    fail("INVALID_INPUT");
  }

  const graphValue = ownValue(value, "graph");
  if (!isPlainRecord(graphValue)
    || !hasExactDataKeys(graphValue, ["identity", "head", "indexHash", "objects"])) {
    fail("INVALID_INPUT");
  }
  const graphIdentity = await normalizeIdentity(ownValue(graphValue, "identity"));
  const graphHead = ownValue(graphValue, "head");
  const indexHash = ownValue(graphValue, "indexHash");
  const objects = ownValue(graphValue, "objects");
  if (typeof graphHead !== "string"
    || !SHA1_PATTERN.test(graphHead)
    || typeof indexHash !== "string"
    || !SHA256_PATTERN.test(indexHash)
    || !Array.isArray(objects)
    || objects.length === 0
    || !sameIdentity(identity, graphIdentity)
    || snapshotHead.toLowerCase() !== graphHead.toLowerCase()) {
    fail("INVALID_INPUT");
  }

  return Object.freeze({
    canonicalRoot,
    identity,
    snapshot: Object.freeze({
      head: snapshotHead,
      fingerprint: snapshotFingerprint,
      created: snapshotCreated,
    }),
    graph: graphValue as unknown as LocalHistoryObjectGraph,
    workingTreeFingerprint,
  });
}

function compareSavedState(
  baselineRoot: string,
  baselineIdentity: RepositoryIdentity,
  snapshot: LocalHistorySnapshot,
  graph: LocalHistoryObjectGraph,
  inspection: LocalRepositoryInspection,
  workingTreeFingerprint: string,
): void {
  if (inspection.canonicalRoot !== baselineRoot) fail("LOCAL_STATE_CHANGED");
  if (!sameIdentity(graph.identity, baselineIdentity)
    || !sameIdentity(inspection.identity, baselineIdentity)) {
    fail("IDENTITY_MISMATCH");
  }
  if (snapshot.head.toLowerCase() !== graph.head.toLowerCase()
    || inspection.head.toLowerCase() !== graph.head.toLowerCase()) {
    fail("LOCAL_STATE_CHANGED");
  }
  if (snapshot.fingerprint !== workingTreeFingerprint) fail("WORKING_TREE_CHANGED");
}

/**
 * Establish one local-first Sync pin.  The sequence is deliberately fixed:
 * caller dirty guard, safe local snapshot, complete graph read, working-tree
 * fingerprint/state comparison, then a final caller guard before return.
 */
export async function preflightCloudLocalState(
  canonicalRoot: string,
  expectedIdentity: RepositoryIdentity,
  assertNoDirtyContent: AssertNoDirtyContent,
): Promise<RepositoryCloudLocalPin> {
  validateRoot(canonicalRoot);
  const identity = await normalizeIdentity(expectedIdentity);
  validateGuard(assertNoDirtyContent);

  await runDirtyGuard(assertNoDirtyContent);

  let snapshot: LocalHistorySnapshot;
  try {
    snapshot = await createHistorySnapshot(canonicalRoot);
  } catch (error) {
    throw normalizeSnapshotFailure(error);
  }

  let graph: LocalHistoryObjectGraph;
  try {
    graph = await readLocalHistoryGraph(canonicalRoot);
  } catch (error) {
    throw normalizeGraphFailure(error);
  }

  let inspection: LocalRepositoryInspection;
  let workingTreeFingerprint: string;
  try {
    inspection = await inspectRepository(canonicalRoot);
    workingTreeFingerprint = (await captureWorkingTree(inspection.canonicalRoot)).fingerprint;
  } catch (error) {
    throw normalizeInspectionFailure(error);
  }
  compareSavedState(
    canonicalRoot,
    identity,
    snapshot,
    graph,
    inspection,
    workingTreeFingerprint,
  );

  // The guard may observe a separate manuscript/editor state not represented
  // in Git.  Recheck it after all local reads and before publishing the pin.
  await runDirtyGuard(assertNoDirtyContent);

  return Object.freeze({
    canonicalRoot: inspection.canonicalRoot,
    identity,
    snapshot,
    graph,
    workingTreeFingerprint,
  });
}

/**
 * Recheck a previously established local pin before or after communication.
 * This is a fail-closed read-only check, not a claim of impossible TOCTOU
 * exclusion: the caller must still use the result only inside its trusted
 * main-process operation boundary.
 */
export async function recheckCloudLocalPin(
  pin: RepositoryCloudLocalPin,
  assertNoDirtyContent: AssertNoDirtyContent,
): Promise<void> {
  const validatedPin = await validatePin(pin);
  validateGuard(assertNoDirtyContent);
  await runDirtyGuard(assertNoDirtyContent);

  let graph: LocalHistoryObjectGraph;
  try {
    graph = await readLocalHistoryGraph(validatedPin.canonicalRoot);
  } catch (error) {
    throw normalizeGraphFailure(error);
  }

  let inspection: LocalRepositoryInspection;
  let workingTreeFingerprint: string;
  try {
    inspection = await inspectRepository(validatedPin.canonicalRoot);
    workingTreeFingerprint = (await captureWorkingTree(inspection.canonicalRoot)).fingerprint;
  } catch (error) {
    throw normalizeInspectionFailure(error);
  }

  if (graph.indexHash.toLowerCase() !== validatedPin.graph.indexHash.toLowerCase()) {
    fail("LOCAL_STATE_CHANGED");
  }
  compareSavedState(
    validatedPin.canonicalRoot,
    validatedPin.identity,
    validatedPin.snapshot,
    graph,
    inspection,
    workingTreeFingerprint,
  );
  if (inspection.canonicalRoot !== validatedPin.canonicalRoot) fail("LOCAL_STATE_CHANGED");

  await runDirtyGuard(assertNoDirtyContent);
}
