import { createRequire } from "node:module";
import { lstat, mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import * as path from "node:path";

/**
 * The host side of the pre-alpha Mod boundary.
 *
 * A Mod is never imported by this process.  The only file loaded by the host
 * is the fixed bootstrap entrypoint, which is run in an Electron utility
 * process and imports the user supplied entrypoint there.  Messages crossing
 * the boundary contain only validated, declarative data.
 */

export const MOD_HOST_PROTOCOL = 1 as const;
export const MOD_API_VERSION = 1 as const;
export const MOD_DIRECTORY_NAME = "mods" as const;
export const MOD_MANIFEST_NAME = "maginalia.mod.json" as const;

const MOD_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/u;
const MOD_VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const CONTRIBUTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const GROUP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const MAX_MODS = 200;
const MAX_CONTRIBUTIONS = 200;
const MAX_TITLE_LENGTH = 160;
const DEFAULT_START_TIMEOUT_MS = 5_000;
const DEFAULT_STOP_TIMEOUT_MS = 1_000;

const nodeRequire = createRequire(__filename);

export interface ModManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly apiVersion: typeof MOD_API_VERSION;
  readonly main: string;
}

export type ModManifestParseResult =
  | { readonly kind: "valid"; readonly manifest: ModManifest }
  | { readonly kind: "invalid"; readonly message: string };

export interface ModCommandContribution {
  readonly kind: "command";
  readonly id: string;
  readonly title: string;
  readonly category?: string;
  readonly keywords?: readonly string[];
  readonly when?: string;
}

/** Declarative only: the renderer decides how and where to draw this item. */
export interface ModContextMenuContribution {
  readonly kind: "context-menu";
  readonly id: string;
  readonly location: string;
  readonly command: string;
  readonly group?: string;
  readonly order?: number;
  readonly when?: string;
}

/** Declarative only: no DOM, Monaco, or Electron object crosses this boundary. */
export interface ModUtilityBarContribution {
  readonly kind: "utility-bar";
  readonly id: string;
  readonly command: string;
  readonly group: string;
  readonly label: string;
  readonly title?: string;
  readonly when?: string;
  readonly order?: number;
}

export type ModViewRegion = "main" | "secondary";

export interface ModViewContribution {
  readonly kind: "view";
  readonly id: string;
  readonly title: string;
  readonly region: ModViewRegion;
  readonly groupId?: string;
}

export type ModContribution = ModCommandContribution | ModContextMenuContribution | ModUtilityBarContribution | ModViewContribution;

/** A contribution after its owning Mod has been attached. */
export interface ModContributionRegistration {
  readonly modId: string;
  readonly contribution: ModContribution;
}

export interface ModCandidate {
  readonly directoryName: string;
  readonly directoryPath: string;
  readonly manifestPath: string;
  readonly manifest: ModManifest;
  readonly entryPath: string;
}

export type ModStatus = {
  readonly directoryName: string;
  readonly id: string | null;
  readonly name: string | null;
  readonly version: string | null;
  readonly state: "active" | "error";
  readonly error?: string;
};

export interface ModHostSnapshot {
  readonly mods: readonly ModStatus[];
  readonly contributions: readonly ModContributionRegistration[];
  readonly error?: string;
}

export interface ModCapabilityRequest {
  readonly kind: "open-document-view" | "close-view" | "get-active-document";
  readonly requestId: string;
  readonly value: unknown;
}

export interface ModCapabilityResponse {
  readonly kind: "ok" | "error";
  readonly value?: unknown;
  readonly message?: string;
}

export interface ModHostOptions {
  /** The only directory from which candidates may be discovered. */
  readonly userDataPath: string;
  /** Fixed, application-owned bootstrap path. User entrypoints are not passed here. */
  readonly bootstrapPath?: string;
  readonly fork?: ModUtilityProcessFork;
  readonly startTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  readonly openFolder?: (directoryPath: string) => Promise<void>;
  readonly onCapabilityRequest?: (
    modId: string,
    request: ModCapabilityRequest,
  ) => Promise<ModCapabilityResponse> | ModCapabilityResponse;
  readonly onError?: (message: string, error?: unknown) => void;
}

export interface ModUtilityProcess {
  readonly pid?: number;
  on(event: "message", listener: (...args: unknown[]) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  on(event: "error", listener: (...args: unknown[]) => void): this;
  once(event: "message", listener: (...args: unknown[]) => void): this;
  once(event: "exit", listener: (code: number) => void): this;
  once(event: "error", listener: (...args: unknown[]) => void): this;
  removeListener(event: "message", listener: (...args: unknown[]) => void): this;
  removeListener(event: "exit", listener: (code: number) => void): this;
  removeListener(event: "error", listener: (...args: unknown[]) => void): this;
  postMessage(message: unknown): void;
  kill(): boolean;
  readonly stderr?: NodeJS.ReadableStream | null;
}

export type ModUtilityProcessFork = (bootstrapPath: string) => ModUtilityProcess;

interface ValidModRuntime {
  readonly candidate: ModCandidate;
  readonly worker: ModUtilityProcess;
  readonly contributions: readonly ModContribution[];
  disposed: boolean;
}

export interface ModCandidateResult {
  readonly directoryName: string;
  readonly directoryPath: string;
  readonly manifestPath: string;
  readonly candidate?: ModCandidate;
  readonly error?: string;
}

interface WorkerReadyMessage {
  readonly kind: "ready";
  readonly protocol: typeof MOD_HOST_PROTOCOL;
}

interface WorkerCommitMessage {
  readonly kind: "commit";
  readonly protocol: typeof MOD_HOST_PROTOCOL;
  readonly modId: string;
  readonly contributions: readonly unknown[];
}

interface WorkerFailureMessage {
  readonly kind: "error";
  readonly protocol: typeof MOD_HOST_PROTOCOL;
  readonly code: string;
  readonly message: string;
}

interface WorkerCapabilityMessage {
  readonly kind: "capability-request";
  readonly protocol: typeof MOD_HOST_PROTOCOL;
  readonly modId: string;
  readonly requestId: string;
  readonly capability: ModCapabilityRequest["kind"];
  readonly value: unknown;
}

interface WorkerShutdownAckMessage {
  readonly kind: "shutdown-ack";
  readonly protocol: typeof MOD_HOST_PROTOCOL;
}

interface WorkerCommandResultMessage {
  readonly kind: "command-result";
  readonly protocol: typeof MOD_HOST_PROTOCOL;
  readonly requestId: string;
  readonly result: unknown;
}

type WorkerMessage =
  | WorkerReadyMessage
  | WorkerCommitMessage
  | WorkerFailureMessage
  | WorkerCapabilityMessage
  | WorkerShutdownAckMessage
  | WorkerCommandResultMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function isExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasOnlyKeys(value: Record<string, unknown>, required: readonly string[], allowed: readonly string[]): boolean {
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.includes(key));
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && value.trim() === value
    && !/[\u0000\r\n]/u.test(value);
}

function boundedOptionalText(value: unknown, maxLength: number): value is string | undefined {
  return value === undefined || boundedText(value, maxLength);
}

function validKeywords(value: unknown): value is readonly string[] | undefined {
  return value === undefined
    || (Array.isArray(value) && value.length <= 24 && value.every((item) => boundedText(item, 64)));
}

function validWhen(value: unknown): value is string | undefined {
  return value === undefined || boundedText(value, 240);
}

function validOrder(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= -10_000 && value <= 10_000);
}

function validLocation(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9.-]{0,127}$/iu.test(value);
}

/** Validate the small, versioned manifest without applying defaults. */
export function parseModManifest(value: unknown): ModManifestParseResult {
  if (!isPlainRecord(value) || !isExactKeys(value, ["id", "name", "version", "apiVersion", "main"])) {
    return { kind: "invalid", message: "Manifest must contain exactly id, name, version, apiVersion, and main." };
  }
  if (typeof value.id !== "string" || !MOD_ID_PATTERN.test(value.id)) {
    return { kind: "invalid", message: "Manifest id must be a lowercase namespaced identifier." };
  }
  if (!boundedText(value.name, MAX_TITLE_LENGTH)) {
    return { kind: "invalid", message: "Manifest name must be non-empty bounded text." };
  }
  if (typeof value.version !== "string" || !MOD_VERSION_PATTERN.test(value.version)) {
    return { kind: "invalid", message: "Manifest version must be a semantic version." };
  }
  if (value.apiVersion !== MOD_API_VERSION) {
    return { kind: "invalid", message: `Unsupported Mod API version: ${String(value.apiVersion)}.` };
  }
  if (typeof value.main !== "string"
    || value.main.length === 0
    || value.main.length > 240
    || value.main.trim() !== value.main
    || value.main.includes("\\")
    || value.main.includes("\u0000")
    || value.main.includes(":")
    || path.posix.isAbsolute(value.main)
    || path.win32.isAbsolute(value.main)) {
    return { kind: "invalid", message: "Manifest main must be a relative POSIX path." };
  }
  const parts = value.main.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    return { kind: "invalid", message: "Manifest main must stay inside the Mod directory." };
  }
  return {
    kind: "valid",
    manifest: Object.freeze({
      id: value.id,
      name: value.name,
      version: value.version,
      apiVersion: MOD_API_VERSION,
      main: value.main
    })
  };
}

export function isModManifest(value: unknown): value is ModManifest {
  return parseModManifest(value).kind === "valid";
}

function isContainedPath(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative.length > 0
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

/** Resolve a manifest entry without permitting traversal or an absolute path. */
export function resolveModEntryPath(directoryPath: string, manifest: ModManifest): string | undefined {
  const entryPath = path.resolve(directoryPath, ...manifest.main.split("/"));
  return isContainedPath(path.resolve(directoryPath), entryPath) ? entryPath : undefined;
}

async function inspectCandidate(
  directoryName: string,
  directoryPath: string,
): Promise<ModCandidateResult> {
  const manifestPath = path.join(directoryPath, MOD_MANIFEST_NAME);
  try {
    const manifestStats = await lstat(manifestPath);
    if (!manifestStats.isFile()) {
      return { directoryName, directoryPath, manifestPath, error: "Manifest is not a regular file." };
    }
    const raw = await readFile(manifestPath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return { directoryName, directoryPath, manifestPath, error: "Manifest is not valid JSON." };
    }
    const manifestResult = parseModManifest(parsed);
    if (manifestResult.kind === "invalid") {
      return { directoryName, directoryPath, manifestPath, error: manifestResult.message };
    }
    const entryPath = resolveModEntryPath(directoryPath, manifestResult.manifest);
    if (entryPath === undefined) {
      return { directoryName, directoryPath, manifestPath, error: "Manifest main escapes the Mod directory." };
    }
    const canonicalDirectory = await realpath(directoryPath);
    const canonicalEntry = await realpath(entryPath);
    if (!isContainedPath(canonicalDirectory, canonicalEntry)) {
      return { directoryName, directoryPath, manifestPath, error: "Manifest main resolves outside the Mod directory." };
    }
    const entryStats = await stat(canonicalEntry);
    if (!entryStats.isFile()) {
      return { directoryName, directoryPath, manifestPath, error: "Manifest main is not a file." };
    }
    return {
      directoryName,
      directoryPath,
      manifestPath,
      candidate: {
        directoryName,
        // Send the same canonical root used for entryPath. Windows may
        // return an 8.3 short path for one side of a realpath call; keeping
        // both paths canonical prevents the worker-side containment check
        // from rejecting an otherwise valid Mod.
        directoryPath: canonicalDirectory,
        manifestPath,
        manifest: manifestResult.manifest,
        entryPath: canonicalEntry
      }
    };
  } catch {
    return { directoryName, directoryPath, manifestPath, error: "Manifest or entrypoint could not be read." };
  }
}

/**
 * Enumerate only direct, real directories below the explicit global Mods
 * directory.  Project folders and nested directories are never considered.
 */
export async function discoverModCandidates(modsDirectory: string): Promise<readonly ModCandidateResult[]> {
  await mkdir(modsDirectory, { recursive: true });
  const rootStats = await lstat(modsDirectory);
  if (!rootStats.isDirectory()) throw new Error("The Mods path is not a regular directory.");
  const entries = (await readdir(modsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    .slice(0, MAX_MODS);
  const results: ModCandidateResult[] = [];
  for (const entry of entries) {
    results.push(await inspectCandidate(entry.name, path.join(modsDirectory, entry.name)));
  }
  return results;
}

function unwrapWorkerMessage(args: readonly unknown[]): unknown {
  // Electron UtilityProcess supplies (event, value), while protocol fakes and
  // Node-style EventEmitters commonly supply just (value).
  const candidate = args.length >= 2 ? args[1] : args[0];
  if (isRecord(candidate) && "data" in candidate && Object.keys(candidate).length === 1) return candidate.data;
  return candidate;
}

function isWorkerReady(value: unknown): value is WorkerReadyMessage {
  return isRecord(value) && value.kind === "ready" && value.protocol === MOD_HOST_PROTOCOL;
}

function isWorkerCommit(value: unknown): value is WorkerCommitMessage {
  return isRecord(value)
    && value.kind === "commit"
    && value.protocol === MOD_HOST_PROTOCOL
    && typeof value.modId === "string"
    && Array.isArray(value.contributions);
}

function isWorkerFailure(value: unknown): value is WorkerFailureMessage {
  return isRecord(value)
    && value.kind === "error"
    && value.protocol === MOD_HOST_PROTOCOL
    && typeof value.code === "string"
    && typeof value.message === "string";
}

function isWorkerCapability(value: unknown): value is WorkerCapabilityMessage {
  return isRecord(value)
    && value.kind === "capability-request"
    && value.protocol === MOD_HOST_PROTOCOL
    && typeof value.modId === "string"
    && typeof value.requestId === "string"
    && (value.capability === "open-document-view"
      || value.capability === "close-view"
      || value.capability === "get-active-document");
}

function isWorkerShutdownAck(value: unknown): value is WorkerShutdownAckMessage {
  return isRecord(value) && value.kind === "shutdown-ack" && value.protocol === MOD_HOST_PROTOCOL;
}

function isWorkerCommandResult(value: unknown): value is WorkerCommandResultMessage {
  return isRecord(value)
    && value.kind === "command-result"
    && value.protocol === MOD_HOST_PROTOCOL
    && typeof value.requestId === "string"
    && "result" in value;
}

function validateContribution(value: unknown, modId: string): ModContribution | undefined {
  if (!isPlainRecord(value) || typeof value.kind !== "string") return undefined;
  if (value.kind === "command") {
    if (!hasOnlyKeys(value, ["kind", "id", "title"], ["kind", "id", "title", "category", "keywords", "when"])
      || typeof value.id !== "string"
      || !value.id.startsWith(`${modId}.`)
      || !CONTRIBUTION_ID_PATTERN.test(value.id)
      || !boundedText(value.title, MAX_TITLE_LENGTH)
      || !boundedOptionalText(value.category, MAX_TITLE_LENGTH)
      || !validKeywords(value.keywords)
      || !validWhen(value.when)) return undefined;
    return Object.freeze({
      kind: "command", id: value.id, title: value.title,
      ...(value.category === undefined ? {} : { category: value.category }),
      ...(value.keywords === undefined ? {} : { keywords: Object.freeze([...value.keywords]) }),
      ...(value.when === undefined ? {} : { when: value.when })
    });
  }
  if (value.kind === "context-menu") {
    if (!hasOnlyKeys(value, ["kind", "id", "location", "command"], ["kind", "id", "location", "command", "group", "order", "when"])
      || typeof value.id !== "string"
      || !value.id.startsWith(`${modId}.`)
      || !CONTRIBUTION_ID_PATTERN.test(value.id)
      || typeof value.command !== "string"
      || !value.command.startsWith(`${modId}.`)
      || !CONTRIBUTION_ID_PATTERN.test(value.command)
      || !validLocation(value.location)
      || (value.group !== undefined && (typeof value.group !== "string" || !GROUP_ID_PATTERN.test(value.group)))
      || !validOrder(value.order)
      || !validWhen(value.when)) return undefined;
    return Object.freeze({
      kind: "context-menu", id: value.id, location: value.location, command: value.command,
      ...(value.group === undefined ? {} : { group: value.group }),
      ...(value.order === undefined ? {} : { order: value.order }),
      ...(value.when === undefined ? {} : { when: value.when })
    });
  }
  if (value.kind === "utility-bar") {
    if (!hasOnlyKeys(value, ["kind", "id", "command", "group", "label"], ["kind", "id", "command", "group", "label", "title", "when", "order"])
      || typeof value.id !== "string"
      || !value.id.startsWith(`${modId}.`)
      || !CONTRIBUTION_ID_PATTERN.test(value.id)
      || typeof value.command !== "string"
      || !value.command.startsWith(`${modId}.`)
      || !CONTRIBUTION_ID_PATTERN.test(value.command)
      || typeof value.group !== "string"
      || !GROUP_ID_PATTERN.test(value.group)
      || !boundedText(value.label, 80)
      || !boundedOptionalText(value.title, MAX_TITLE_LENGTH)
      || !validWhen(value.when)
      || !validOrder(value.order)) return undefined;
    return Object.freeze({
      kind: "utility-bar", id: value.id, command: value.command, group: value.group, label: value.label,
      ...(value.title === undefined ? {} : { title: value.title }),
      ...(value.when === undefined ? {} : { when: value.when }),
      ...(value.order === undefined ? {} : { order: value.order })
    });
  }
  if (value.kind === "view") {
    if ((!isExactKeys(value, ["kind", "id", "title", "region"])
      && !isExactKeys(value, ["kind", "id", "title", "region", "groupId"]))
      || !(value.region === "main" || value.region === "secondary")
      || typeof value.id !== "string"
      || !CONTRIBUTION_ID_PATTERN.test(value.id)
      || !boundedText(value.title, MAX_TITLE_LENGTH)) return undefined;
    const groupId = value.groupId;
    if (groupId !== undefined && (typeof groupId !== "string" || !GROUP_ID_PATTERN.test(groupId))) return undefined;
    return Object.freeze({
      kind: "view",
      id: value.id,
      title: value.title,
      region: value.region,
      ...(groupId === undefined ? {} : { groupId })
    });
  }
  return undefined;
}

function validateCommit(value: WorkerCommitMessage, expectedModId: string): readonly ModContribution[] | undefined {
  if (value.modId !== expectedModId || value.contributions.length > MAX_CONTRIBUTIONS) return undefined;
  const contributions: ModContribution[] = [];
  const ids = new Set<string>();
  for (const raw of value.contributions) {
    const contribution = validateContribution(raw, expectedModId);
    if (contribution === undefined || ids.has(`${contribution.kind}:${contribution.id}`)) return undefined;
    ids.add(`${contribution.kind}:${contribution.id}`);
    contributions.push(contribution);
  }
  return Object.freeze(contributions);
}

function defaultFork(bootstrapPath: string): ModUtilityProcess {
  const electron = nodeRequire("electron") as {
    readonly utilityProcess?: {
      fork(path: string, args: readonly string[], options: {
      readonly env?: Record<string, string>;
        readonly stdio: "pipe" | "ignore";
        readonly serviceName: string;
      }): ModUtilityProcess;
    };
  };
  if (electron.utilityProcess === undefined) throw new Error("Electron utilityProcess is unavailable.");
  return electron.utilityProcess.fork(bootstrapPath, [], {
    stdio: "pipe",
    serviceName: "MAGINALIA Mod host"
  });
}

function defaultBootstrapPath(): string {
  return path.join(__dirname, "mod-bootstrap.js");
}

function timeoutValue(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value !== undefined && value > 0 ? value : fallback;
}

function statusForCandidate(candidate: ModCandidateResult): ModStatus {
  return {
    directoryName: candidate.directoryName,
    id: candidate.candidate?.manifest.id ?? null,
    name: candidate.candidate?.manifest.name ?? null,
    version: candidate.candidate?.manifest.version ?? null,
    state: "error",
    ...(candidate.error === undefined ? {} : { error: candidate.error })
  };
}

export class ModHost {
  public readonly modsDirectory: string;

  private readonly options: ModHostOptions;
  private readonly runtimes = new Map<string, ValidModRuntime>();
  private readonly listeners = new Set<(snapshot: ModHostSnapshot) => void>();
  private statuses: readonly ModStatus[] = [];
  private hostError: string | undefined;
  private reloadChain: Promise<ModHostSnapshot> | undefined;

  public constructor(options: ModHostOptions) {
    if (typeof options.userDataPath !== "string" || options.userDataPath.trim().length === 0) {
      throw new Error("A userDataPath is required for the Mod host.");
    }
    this.options = options;
    this.modsDirectory = path.join(path.resolve(options.userDataPath), MOD_DIRECTORY_NAME);
  }

  public onDidChange(listener: (snapshot: ModHostSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  public snapshot(): ModHostSnapshot {
    const contributions: ModContributionRegistration[] = [];
    for (const [modId, runtime] of [...this.runtimes.entries()].sort(([left], [right]) => left.localeCompare(right, "en"))) {
      for (const contribution of runtime.contributions) contributions.push({ modId, contribution });
    }
    return Object.freeze({
      mods: Object.freeze(this.statuses.map((status) => Object.freeze({ ...status }))),
      contributions: Object.freeze(contributions.map((entry) => Object.freeze({
        modId: entry.modId,
        contribution: Object.freeze({ ...entry.contribution })
      }))),
      ...(this.hostError === undefined ? {} : { error: this.hostError })
    }) as ModHostSnapshot;
  }

  public getSnapshot(): ModHostSnapshot {
    return this.snapshot();
  }

  public async start(): Promise<ModHostSnapshot> {
    return this.reload();
  }

  /**
   * Discover and activate a complete new candidate set before swapping it in.
   * A malformed or crashing Mod is represented as one status and cannot abort
   * the core or prevent unrelated valid Mods from activating.
   */
  public reload(): Promise<ModHostSnapshot> {
    const next = (this.reloadChain ?? Promise.resolve(this.snapshot())).then(() => this.reloadOnce());
    this.reloadChain = next.catch(() => this.snapshot());
    return next;
  }

  public reloadMods(): Promise<ModHostSnapshot> {
    return this.reload();
  }

  public async openModsFolder(): Promise<void> {
    await mkdir(this.modsDirectory, { recursive: true });
    const stats = await lstat(this.modsDirectory);
    if (!stats.isDirectory()) throw new Error("The Mods path is not a regular directory.");
    if (this.options.openFolder !== undefined) {
      await this.options.openFolder(this.modsDirectory);
      return;
    }
    const electron = nodeRequire("electron") as { readonly shell?: { openPath(path: string): Promise<string> } };
    if (electron.shell === undefined) throw new Error("Electron shell is unavailable.");
    const openPath = await electron.shell.openPath(this.modsDirectory);
    if (openPath.length > 0) throw new Error(openPath);
  }

  public async invokeCommand(
    modId: string,
    commandId: string,
    args: readonly unknown[] = [],
  ): Promise<unknown> {
    const runtime = this.runtimes.get(modId);
    if (runtime === undefined || runtime.disposed) throw new Error("Mod command is unavailable.");
    const requestId = `command-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        runtime.worker.removeListener("message", onMessage);
        runtime.worker.removeListener("exit", onExit);
        callback();
      };
      const onMessage = (...messageArgs: unknown[]): void => {
        if (settled) return;
        const message = unwrapWorkerMessage(messageArgs);
        if (!isWorkerCommandResult(message) || message.requestId !== requestId) return;
        finish(() => resolve(message.result));
      };
      const onExit = (): void => finish(() => reject(new Error("Mod worker exited while running a command.")));
      const timer = setTimeout(() => finish(() => reject(new Error("Mod command timed out."))), 5_000);
      runtime.worker.on("message", onMessage);
      runtime.worker.once("exit", onExit);
      try {
        runtime.worker.postMessage({
          kind: "invoke-command",
          protocol: MOD_HOST_PROTOCOL,
          requestId,
          commandId,
          args
        });
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error("Mod command could not be sent.")));
      }
    });
  }

  public async dispose(): Promise<void> {
    const current = [...this.runtimes.values()];
    this.runtimes.clear();
    this.statuses = [];
    for (const runtime of current) await this.stopRuntime(runtime);
    this.notify();
  }

  private async reloadOnce(): Promise<ModHostSnapshot> {
    let candidates: readonly ModCandidateResult[];
    try {
      candidates = await discoverModCandidates(this.modsDirectory);
      this.hostError = undefined;
    } catch (error) {
      this.hostError = "The Mods directory could not be read.";
      this.options.onError?.(this.hostError, error);
      this.notify();
      return this.snapshot();
    }

    const statuses: ModStatus[] = [];
    const next = new Map<string, ValidModRuntime>();
    const seenIds = new Set<string>();
    for (const candidate of candidates) {
      if (candidate.candidate === undefined) {
        statuses.push(statusForCandidate(candidate));
        continue;
      }
      const modId = candidate.candidate.manifest.id;
      if (seenIds.has(modId)) {
        statuses.push({
          directoryName: candidate.directoryName,
          id: modId,
          name: candidate.candidate.manifest.name,
          version: candidate.candidate.manifest.version,
          state: "error",
          error: "Duplicate Mod id; only the first directory is activated."
        });
        continue;
      }
      seenIds.add(modId);
      try {
        const runtime = await this.startRuntime(candidate.candidate);
        next.set(modId, runtime);
        statuses.push({
          directoryName: candidate.directoryName,
          id: modId,
          name: candidate.candidate.manifest.name,
          version: candidate.candidate.manifest.version,
          state: "active"
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Mod activation failed.";
        statuses.push({
          directoryName: candidate.directoryName,
          id: modId,
          name: candidate.candidate.manifest.name,
          version: candidate.candidate.manifest.version,
          state: "error",
          error: message
        });
        this.options.onError?.(`Mod ${modId} failed to activate.`, error);
      }
    }

    const previous = [...this.runtimes.values()];
    this.runtimes.clear();
    for (const [modId, runtime] of next) this.runtimes.set(modId, runtime);
    this.statuses = Object.freeze(statuses.map((status) => Object.freeze(status)));
    this.notify();
    for (const runtime of previous) await this.stopRuntime(runtime);
    return this.snapshot();
  }

  private async startRuntime(candidate: ModCandidate): Promise<ValidModRuntime> {
    const fork = this.options.fork ?? defaultFork;
    const worker = fork(this.options.bootstrapPath ?? defaultBootstrapPath());
    worker.stderr?.on("data", (chunk: unknown) => {
      const text = String(chunk).trim();
      if (text.length > 0) this.options.onError?.(`Mod ${candidate.manifest.id} stderr.`, text);
    });
    if (worker.pid !== undefined && (!Number.isSafeInteger(worker.pid) || worker.pid <= 0)) {
      try { worker.kill(); } catch { /* finite activation failure */ }
      throw new Error("Mod worker did not provide a valid process id.");
    }
    return new Promise((resolve, reject) => {
      let ready = false;
      let settled = false;
      const timer = setTimeout(() => finishReject(new Error("Mod activation timed out.")), timeoutValue(this.options.startTimeoutMs, DEFAULT_START_TIMEOUT_MS));
      const cleanup = (): void => {
        clearTimeout(timer);
        worker.removeListener("message", onMessage);
        worker.removeListener("exit", onExit);
        worker.removeListener("error", onError);
      };
      const finishReject = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        try { worker.kill(); } catch { /* finite activation failure */ }
        reject(error);
      };
      const onError = (...args: unknown[]): void => {
        const error = args.find((value): value is Error => value instanceof Error);
        finishReject(error ?? new Error("Mod worker failed to start."));
      };
      const onExit = (code: number): void => {
        if (!settled) finishReject(new Error(`Mod worker exited during activation (${code}).`));
      };
      const onMessage = (...messageArgs: unknown[]): void => {
        const message = unwrapWorkerMessage(messageArgs);
        if (isWorkerCapability(message)) {
          if (message.modId !== candidate.manifest.id) {
            finishReject(new Error("Mod capability request has the wrong owner."));
            return;
          }
          void this.handleCapability(worker, message, candidate.manifest.id);
          return;
        }
        if (isWorkerFailure(message)) {
          finishReject(new Error(message.message));
          return;
        }
        if (isWorkerReady(message)) {
          if (ready) {
            finishReject(new Error("Mod worker sent duplicate ready messages."));
            return;
          }
          ready = true;
          try {
            worker.postMessage({
              kind: "start",
              protocol: MOD_HOST_PROTOCOL,
              modId: candidate.manifest.id,
              manifest: candidate.manifest,
              directoryPath: candidate.directoryPath,
              entryPath: candidate.entryPath
            });
          } catch {
            finishReject(new Error("Mod activation message could not be sent."));
          }
          return;
        }
        if (isWorkerCommit(message)) {
          if (!ready) {
            finishReject(new Error("Mod worker committed before ready."));
            return;
          }
          const contributions = validateCommit(message, candidate.manifest.id);
          if (contributions === undefined) {
            finishReject(new Error("Mod contribution commit was invalid."));
            return;
          }
          settled = true;
          cleanup();
          const runtime: ValidModRuntime = { candidate, worker, contributions, disposed: false };
          worker.on("message", (...runtimeArgs: unknown[]) => {
            const runtimeMessage = unwrapWorkerMessage(runtimeArgs);
            if (isWorkerCapability(runtimeMessage) && runtimeMessage.modId === candidate.manifest.id) {
              void this.handleCapability(worker, runtimeMessage, candidate.manifest.id);
            }
          });
          worker.on("exit", (code) => {
            if (runtime.disposed) return;
            runtime.disposed = true;
            this.removeRuntimeAfterCrash(candidate.manifest.id, code);
          });
          resolve(runtime);
        }
      };
      worker.on("message", onMessage);
      worker.once("exit", onExit);
      worker.once("error", onError);
    });
  }

  private async handleCapability(
    worker: ModUtilityProcess,
    message: WorkerCapabilityMessage,
    expectedModId: string,
  ): Promise<void> {
    if (message.modId !== expectedModId) return;
    let response: ModCapabilityResponse;
    try {
      response = this.options.onCapabilityRequest === undefined
        ? { kind: "error", message: "The Mod capability is unavailable." }
        : await this.options.onCapabilityRequest(message.modId, {
          kind: message.capability,
          requestId: message.requestId,
          value: message.value
        });
    } catch {
      response = { kind: "error", message: "The Mod capability failed." };
    }
    try {
      worker.postMessage({
        kind: "capability-response",
        protocol: MOD_HOST_PROTOCOL,
        requestId: message.requestId,
        response
      });
    } catch {
      // The worker may have exited while the callback was running.
    }
  }

  private removeRuntimeAfterCrash(modId: string, code: number): void {
    const runtime = this.runtimes.get(modId);
    if (runtime === undefined || !runtime.disposed) return;
    this.runtimes.delete(modId);
    this.statuses = Object.freeze(this.statuses.map((status) => status.id === modId
      ? Object.freeze({ ...status, state: "error" as const, error: `Mod worker exited (${code}).` })
      : status));
    this.options.onError?.(`Mod ${modId} worker exited.`, code);
    this.notify();
  }

  private async stopRuntime(runtime: ValidModRuntime): Promise<void> {
    runtime.disposed = true;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        runtime.worker.removeListener("message", onMessage);
        runtime.worker.removeListener("exit", onExit);
        resolve();
      };
      const onMessage = (...args: unknown[]): void => {
        if (isWorkerShutdownAck(unwrapWorkerMessage(args))) finish();
      };
      const onExit = (): void => finish();
      const timer = setTimeout(() => {
        try { runtime.worker.kill(); } catch { /* finite shutdown */ }
        finish();
      }, timeoutValue(this.options.stopTimeoutMs, DEFAULT_STOP_TIMEOUT_MS));
      runtime.worker.on("message", onMessage);
      runtime.worker.once("exit", onExit);
      try {
        runtime.worker.postMessage({ kind: "shutdown", protocol: MOD_HOST_PROTOCOL });
      } catch {
        // A crashed worker is already stopped.
        finish();
      }
    });
  }

  private notify(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try { listener(snapshot); } catch { /* a listener cannot abort host state */ }
    }
  }
}
