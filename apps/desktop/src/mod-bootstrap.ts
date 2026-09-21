/**
 * Fixed Electron utility-process entrypoint for user Mods.
 *
 * This file is the only code that dynamically imports a user supplied Mod.
 * The main process sends an already validated manifest and contained entry
 * path after this process announces readiness.  The Mod receives capability
 * functions and can submit only declarative contributions; Electron, Monaco,
 * DOM, and Workbench objects never cross this boundary.
 */

import { pathToFileURL } from "node:url";
import * as path from "node:path";
import type {
  ModCommandContribution,
  ModContextMenuContribution,
  ModManifest,
  ModUtilityBarContribution,
  ModViewContribution,
  ModViewRegion
} from "./mod-host";

// Keep the bootstrap self-contained: it is the fixed utility-process entry
// point and must not load host services or any user module before start.
export const MOD_HOST_PROTOCOL = 1 as const;

export type ModWorkerPort = {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: unknown) => void): unknown;
};

export interface ModBootstrapRuntime {
  readonly exit?: (code: number) => void;
  readonly scheduleExit?: (callback: () => void) => unknown;
}

interface StartMessage {
  readonly kind: "start";
  readonly protocol: typeof MOD_HOST_PROTOCOL;
  readonly modId: string;
  readonly manifest: ModManifest;
  readonly directoryPath: string;
  readonly entryPath: string;
}

interface CapabilityResponseMessage {
  readonly kind: "capability-response";
  readonly protocol: typeof MOD_HOST_PROTOCOL;
  readonly requestId: string;
  readonly response: { readonly kind: "ok" | "error"; readonly value?: unknown; readonly message?: string };
}

interface InvokeCommandMessage {
  readonly kind: "invoke-command";
  readonly protocol: typeof MOD_HOST_PROTOCOL;
  readonly requestId: string;
  readonly commandId: string;
  readonly args: readonly unknown[];
}

interface ShutdownMessage {
  readonly kind: "shutdown";
  readonly protocol: typeof MOD_HOST_PROTOCOL;
}

type HostMessage = CapabilityResponseMessage | InvokeCommandMessage | ShutdownMessage;

export interface ModDocumentViewRequest {
  readonly documentId?: string;
  readonly viewType?: string;
  readonly region?: ModViewRegion;
  readonly groupId?: string;
}

export interface ModActiveDocument {
  readonly documentId: string;
  readonly displayName: string;
}

export interface ModCapabilityApi {
  openDocumentView(request: ModDocumentViewRequest): Promise<unknown>;
  closeView(instanceId: string): Promise<unknown>;
  getActiveDocument(): Promise<ModActiveDocument | null>;
}

export interface ModContributionApi extends ModCapabilityApi {
  registerCommand(
    contribution: Omit<ModCommandContribution, "kind">,
    handler: (args: readonly unknown[]) => unknown | Promise<unknown>,
  ): void;
  registerContextMenu(contribution: Omit<ModContextMenuContribution, "kind">): void;
  registerUtilityBar(contribution: Omit<ModUtilityBarContribution, "kind">): void;
  registerView(contribution: Omit<ModViewContribution, "kind">): void;
}

export interface ModModule {
  readonly activate?: (api: ModContributionApi) => void | Promise<void>;
  readonly deactivate?: () => void | Promise<void>;
  readonly default?: ((api: ModContributionApi) => void | Promise<void>) | {
    readonly activate?: (api: ModContributionApi) => void | Promise<void>;
    readonly deactivate?: () => void | Promise<void>;
  };
}

interface ParentPortLike {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: unknown) => void): unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unwrapMessage(value: unknown): unknown {
  if (isRecord(value) && "data" in value) return value.data;
  return value;
}

function isStartMessage(value: unknown): value is StartMessage {
  return isRecord(value)
    && value.kind === "start"
    && value.protocol === MOD_HOST_PROTOCOL
    && typeof value.modId === "string"
    && isValidManifest(value.manifest)
    && value.modId === value.manifest.id
    && typeof value.directoryPath === "string"
    && path.isAbsolute(value.directoryPath)
    && typeof value.entryPath === "string"
    && path.isAbsolute(value.entryPath)
    && value.entryPath.length > 0
    && isContainedEntry(value.directoryPath, value.entryPath, value.manifest.main);
}

function isValidManifest(value: unknown): value is ModManifest {
  if (!isRecord(value)
    || Object.keys(value).sort().join("\u0000") !== ["apiVersion", "id", "main", "name", "version"].join("\u0000")
    || typeof value.id !== "string"
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/u.test(value.id)
    || typeof value.name !== "string"
    || value.name.length === 0
    || value.name.length > 160
    || value.name.trim() !== value.name
    || typeof value.version !== "string"
    || !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(value.version)
    || value.apiVersion !== 1
    || typeof value.main !== "string"
    || value.main.length === 0
    || value.main.length > 240
    || value.main.trim() !== value.main
    || value.main.includes("\\")
    || value.main.includes("\u0000")
    || value.main.includes(":")
    || path.posix.isAbsolute(value.main)
    || path.win32.isAbsolute(value.main)) return false;
  const parts = value.main.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

function isContainedEntry(directoryPath: string, entryPath: string, main: string): boolean {
  const directory = path.resolve(directoryPath);
  const candidate = path.resolve(directory, ...main.split("/"));
  if (path.resolve(entryPath) !== candidate) return false;
  const relative = path.relative(directory, candidate);
  return relative.length > 0
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function isCapabilityResponse(value: unknown): value is CapabilityResponseMessage {
  return isRecord(value)
    && value.kind === "capability-response"
    && value.protocol === MOD_HOST_PROTOCOL
    && typeof value.requestId === "string"
    && isRecord(value.response)
    && (value.response.kind === "ok" || value.response.kind === "error");
}

function isInvokeCommand(value: unknown): value is InvokeCommandMessage {
  return isRecord(value)
    && value.kind === "invoke-command"
    && value.protocol === MOD_HOST_PROTOCOL
    && typeof value.requestId === "string"
    && typeof value.commandId === "string"
    && Array.isArray(value.args);
}

function isShutdown(value: unknown): value is ShutdownMessage {
  return isRecord(value) && value.kind === "shutdown" && value.protocol === MOD_HOST_PROTOCOL;
}

function isCommandId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function isTitle(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 160
    && value.trim() === value
    && !/[\u0000\r\n]/u.test(value);
}

function isGroupId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value);
}

function isWhen(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && isTitle(value) && value.length <= 240);
}

function isKeywords(value: unknown): value is readonly string[] | undefined {
  return value === undefined || (Array.isArray(value) && value.length <= 24 && value.every((item) => typeof item === "string" && isTitle(item) && item.length <= 64));
}

function isOrder(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= -10_000 && value <= 10_000);
}

function onlyKeys(value: Record<string, unknown>, required: readonly string[], allowed: readonly string[]): boolean {
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.includes(key));
}

function validateCommand(value: Omit<ModCommandContribution, "kind">, ownerId: string): Omit<ModCommandContribution, "kind"> {
  if (!isRecord(value)
    || !onlyKeys(value, ["id", "title"], ["id", "title", "category", "keywords", "when"])
    || !isCommandId(value.id)
    || !isTitle(value.title)
    || !value.id.startsWith(`${ownerId}.`)
    || (value.category !== undefined && !isTitle(value.category))
    || !isKeywords(value.keywords)
    || !isWhen(value.when)) throw new Error("Invalid Mod command contribution.");
  return Object.freeze({ id: value.id, title: value.title,
    ...(value.category === undefined ? {} : { category: value.category }),
    ...(value.keywords === undefined ? {} : { keywords: Object.freeze([...value.keywords]) }),
    ...(value.when === undefined ? {} : { when: value.when }) });
}

function validateContextMenu(value: Omit<ModContextMenuContribution, "kind">, ownerId: string): Omit<ModContextMenuContribution, "kind"> {
  if (!isRecord(value)
    || !onlyKeys(value, ["id", "location", "command"], ["id", "location", "command", "group", "order", "when"])
    || !isCommandId(value.id) || !isCommandId(value.command)
    || !value.id.startsWith(`${ownerId}.`) || !value.command.startsWith(`${ownerId}.`)
    || typeof value.location !== "string" || !/^[a-z][a-z0-9.-]{0,127}$/iu.test(value.location)
    || (value.group !== undefined && !isGroupId(value.group)) || !isOrder(value.order) || !isWhen(value.when)) {
    throw new Error("Invalid Mod context menu contribution.");
  }
  return Object.freeze({ id: value.id, location: value.location, command: value.command,
    ...(value.group === undefined ? {} : { group: value.group }),
    ...(value.order === undefined ? {} : { order: value.order }),
    ...(value.when === undefined ? {} : { when: value.when }) });
}

function validateUtilityBar(value: Omit<ModUtilityBarContribution, "kind">, ownerId: string): Omit<ModUtilityBarContribution, "kind"> {
  if (!isRecord(value)
    || !onlyKeys(value, ["id", "command", "group", "label"], ["id", "command", "group", "label", "title", "when", "order"])
    || !isCommandId(value.id) || !isCommandId(value.command)
    || !value.id.startsWith(`${ownerId}.`) || !value.command.startsWith(`${ownerId}.`)
    || !isGroupId(value.group) || !isTitle(value.label) || value.label.length > 80
    || (value.title !== undefined && !isTitle(value.title)) || !isWhen(value.when) || !isOrder(value.order)) {
    throw new Error("Invalid Mod utility bar contribution.");
  }
  return Object.freeze({ id: value.id, command: value.command, group: value.group, label: value.label,
    ...(value.title === undefined ? {} : { title: value.title }),
    ...(value.when === undefined ? {} : { when: value.when }),
    ...(value.order === undefined ? {} : { order: value.order }) });
}

function validateView(value: Omit<ModViewContribution, "kind">): Omit<ModViewContribution, "kind"> {
  if (!isRecord(value)
    || (!exactKeys(value, ["id", "title", "region"])
      && !exactKeys(value, ["id", "title", "region", "groupId"]))
    || !isCommandId(value.id)
    || !isTitle(value.title)
    || (value.region !== "main" && value.region !== "secondary")
    || ("groupId" in value && !isGroupId(value.groupId))) {
    throw new Error("Invalid Mod view contribution.");
  }
  return Object.freeze({
    id: value.id,
    title: value.title,
    region: value.region,
    ...(value.groupId === undefined ? {} : { groupId: value.groupId })
  });
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function getParentPort(): ParentPortLike | undefined {
  const candidate = (process as unknown as { readonly parentPort?: ParentPortLike }).parentPort;
  return candidate;
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : "Mod activation failed.";
}

/**
 * Install the bootstrap protocol. Exported so the protocol can be tested with
 * a deterministic fake port; the actual utility process calls it at module
 * load only when Electron supplies parentPort.
 */
export function installModBootstrap(
  port: ModWorkerPort,
  runtime: ModBootstrapRuntime = {},
): void {
  let started = false;
  let finished = false;
  let activationCommitted = false;
  let manifest: ModManifest | undefined;
  let modId: string | undefined;
  let deactivate: (() => void | Promise<void>) | undefined;
  const commands = new Map<string, (args: readonly unknown[]) => unknown | Promise<unknown>>();
  const contributions: Array<ModCommandContribution | ModContextMenuContribution | ModUtilityBarContribution | ModViewContribution> = [];
  const pendingCapabilities = new Map<string, {
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: Error) => void;
  }>();
  let nextRequest = 1;
  const exit = runtime.exit ?? ((code: number) => process.exit(code));
  const scheduleExit = runtime.scheduleExit ?? ((callback: () => void) => setTimeout(callback, 0));

  const fail = (message: string, code = "activation-failed"): void => {
    if (finished) return;
    finished = true;
    port.postMessage({ kind: "error", protocol: MOD_HOST_PROTOCOL, code, message });
    scheduleExit(() => exit(1));
  };

  const requestCapability = (capability: "open-document-view" | "close-view" | "get-active-document", value: unknown): Promise<unknown> => {
    if (modId === undefined || finished) return Promise.reject(new Error("Mod capability is unavailable."));
    const requestId = `capability-${nextRequest++}`;
    return new Promise((resolve, reject) => {
      pendingCapabilities.set(requestId, { resolve, reject });
      try {
        port.postMessage({
          kind: "capability-request",
          protocol: MOD_HOST_PROTOCOL,
          modId,
          requestId,
          capability,
          value
        });
      } catch (error) {
        pendingCapabilities.delete(requestId);
        reject(error instanceof Error ? error : new Error("Mod capability request failed."));
      }
    });
  };

  const activate = async (message: StartMessage): Promise<void> => {
    manifest = message.manifest;
    modId = message.modId;
    const loaded = await import(pathToFileURL(message.entryPath).href) as ModModule;
    const defaultExport = loaded.default;
    const activateFunction = loaded.activate
      ?? (typeof defaultExport === "function" ? defaultExport : defaultExport?.activate);
    if (typeof activateFunction !== "function") throw new Error("Mod entrypoint must export activate(api).");
    deactivate = loaded.deactivate
      ?? (typeof defaultExport === "object" && defaultExport !== null ? defaultExport.deactivate : undefined);
    const api: ModContributionApi = {
      registerCommand: (value, handler): void => {
        if (finished || activationCommitted) throw new Error("Mod activation is finished.");
        const contribution = validateCommand(value, message.modId);
        if (commands.has(contribution.id)) throw new Error(`Duplicate Mod command: ${contribution.id}.`);
        commands.set(contribution.id, handler);
        contributions.push({ kind: "command", ...contribution });
      },
      registerContextMenu: (value): void => {
        if (finished || activationCommitted) throw new Error("Mod activation is finished.");
        const contribution = validateContextMenu(value, message.modId);
        if (contributions.some((entry) => entry.kind === "context-menu" && entry.id === contribution.id)) {
          throw new Error(`Duplicate Mod context menu: ${contribution.id}.`);
        }
        contributions.push({ kind: "context-menu", ...contribution });
      },
      registerUtilityBar: (value): void => {
        if (finished || activationCommitted) throw new Error("Mod activation is finished.");
        const contribution = validateUtilityBar(value, message.modId);
        if (contributions.some((entry) => entry.kind === "utility-bar" && entry.id === contribution.id)) {
          throw new Error(`Duplicate Mod utility bar item: ${contribution.id}.`);
        }
        contributions.push({ kind: "utility-bar", ...contribution });
      },
      registerView: (value): void => {
        if (finished || activationCommitted) throw new Error("Mod activation is finished.");
        const contribution = validateView(value);
        if (contributions.some((entry) => entry.kind === "view" && entry.id === contribution.id)) {
          throw new Error(`Duplicate Mod view: ${contribution.id}.`);
        }
        contributions.push({ kind: "view", ...contribution });
      },
      openDocumentView: (request): Promise<unknown> => requestCapability("open-document-view", request),
      closeView: (instanceId): Promise<unknown> => {
        if (!isCommandId(instanceId)) return Promise.reject(new Error("Invalid view instance id."));
        return requestCapability("close-view", instanceId);
      },
      getActiveDocument: (): Promise<ModActiveDocument | null> => requestCapability("get-active-document", null) as Promise<ModActiveDocument | null>
    };
    await activateFunction(api);
    if (finished) return;
    activationCommitted = true;
    port.postMessage({
      kind: "commit",
      protocol: MOD_HOST_PROTOCOL,
      modId,
      contributions
    });
  };

  const onMessage = async (event: unknown): Promise<void> => {
    const message = unwrapMessage(event) as HostMessage;
    if (!started) {
      if (!isStartMessage(message)) return;
      started = true;
      try {
        await activate(message);
      } catch (error) {
        fail(asErrorMessage(error));
      }
      return;
    }
    if (isCapabilityResponse(message)) {
      const pending = pendingCapabilities.get(message.requestId);
      if (pending === undefined) return;
      pendingCapabilities.delete(message.requestId);
      if (message.response.kind === "ok") pending.resolve(message.response.value);
      else pending.reject(new Error(message.response.message ?? "Mod capability failed."));
      return;
    }
    if (isInvokeCommand(message)) {
      const handler = commands.get(message.commandId);
      if (handler === undefined) {
        port.postMessage({
          kind: "command-result",
          protocol: MOD_HOST_PROTOCOL,
          requestId: message.requestId,
          result: { kind: "error", message: "Mod command is unavailable." }
        });
        return;
      }
      try {
        const result = await handler(message.args);
        port.postMessage({ kind: "command-result", protocol: MOD_HOST_PROTOCOL, requestId: message.requestId, result });
      } catch (error) {
        port.postMessage({
          kind: "command-result",
          protocol: MOD_HOST_PROTOCOL,
          requestId: message.requestId,
          result: { kind: "error", message: asErrorMessage(error) }
        });
      }
      return;
    }
    if (isShutdown(message)) {
      try { await deactivate?.(); } catch { /* shutdown is best effort */ }
      finished = true;
      for (const pending of pendingCapabilities.values()) pending.reject(new Error("Mod is shutting down."));
      pendingCapabilities.clear();
      port.postMessage({ kind: "shutdown-ack", protocol: MOD_HOST_PROTOCOL });
      scheduleExit(() => exit(0));
    }
  };

  port.on("message", (event) => { void onMessage(event); });
  // Register before announcing readiness so a parent that responds
  // immediately cannot race the first start message.
  port.postMessage({ kind: "ready", protocol: MOD_HOST_PROTOCOL });
}

const parentPort = getParentPort();
if (parentPort !== undefined) installModBootstrap(parentPort);
