/** Renderer-safe IPC contract for the pre-alpha Mod host. */

import type {
  ModCapabilityRequest,
  ModCapabilityResponse,
  ModHostSnapshot
} from "./mod-host";

export type { ModCapabilityResponse } from "./mod-host";

export const LOAD_MODS_CHANNEL = "maginalia:load-mods";
export const RELOAD_MODS_CHANNEL = "maginalia:reload-mods";
export const OPEN_MODS_FOLDER_CHANNEL = "maginalia:open-mods-folder";
export const INVOKE_MOD_COMMAND_CHANNEL = "maginalia:invoke-mod-command";
export const MOD_CAPABILITY_REQUEST_CHANNEL = "maginalia:mod-capability-request";
export const RESPOND_MOD_CAPABILITY_CHANNEL = "maginalia:respond-mod-capability";

export type ModSnapshotResult = ModHostSnapshot;

export interface ModCommandRequest {
  readonly modId: string;
  readonly commandId: string;
  readonly args: readonly unknown[];
}

export type ModOperationFailureCode = "invalid-request" | "mod-unavailable" | "mod-error";

export interface ModOperationFailure {
  readonly kind: "error";
  readonly code: ModOperationFailureCode;
  readonly message: string;
}

export type ModOperationResult = ModSnapshotResult | ModOperationFailure;
export type InvokeModCommandResult = { readonly kind: "result"; readonly value: unknown } | ModOperationFailure;
export type OpenModsFolderResult = { readonly kind: "opened" } | ModOperationFailure;

export interface ModCapabilityRequestEvent extends ModCapabilityRequest {
  readonly modId: string;
  readonly requestId: string;
}

export interface ModCapabilityResponseRequest {
  readonly requestId: string;
  readonly response: ModCapabilityResponse;
}

export interface ModIpcInvokeEvent {
  readonly sender: object;
}

const MOD_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/u;
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_COMMAND_ARGS = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}

function isSafeId(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && value.length > 0 && pattern.test(value);
}

export function isModCommandRequest(value: unknown): value is ModCommandRequest {
  return isRecord(value)
    && hasExactKeys(value, ["modId", "commandId", "args"])
    && isSafeId(value.modId, MOD_ID)
    && isSafeId(value.commandId, COMMAND_ID)
    && Array.isArray(value.args)
    && value.args.length <= MAX_COMMAND_ARGS;
}

export function isModCapabilityRequestEvent(value: unknown): value is ModCapabilityRequestEvent {
  return isRecord(value)
    && hasExactKeys(value, ["modId", "kind", "requestId", "value"])
    && isSafeId(value.modId, MOD_ID)
    && isSafeId(value.requestId, REQUEST_ID)
    && (value.kind === "open-document-view"
      || value.kind === "close-view"
      || value.kind === "get-active-document");
}

export function isModCapabilityResponse(value: unknown): value is ModCapabilityResponse {
  return isRecord(value)
    && (value.kind === "ok" || value.kind === "error")
    && (value.kind === "ok"
      ? (!Object.hasOwn(value, "message") || value.message === undefined)
      : typeof value.message === "string" && value.message.length > 0 && value.message.length <= 500);
}

export function isModCapabilityResponseRequest(value: unknown): value is ModCapabilityResponseRequest {
  return isRecord(value)
    && hasExactKeys(value, ["requestId", "response"])
    && isSafeId(value.requestId, REQUEST_ID)
    && isModCapabilityResponse(value.response);
}

export const MOD_INVALID_REQUEST: ModOperationFailure = Object.freeze({
  kind: "error",
  code: "invalid-request",
  message: "The Mod request was invalid."
});

export const MOD_UNAVAILABLE: ModOperationFailure = Object.freeze({
  kind: "error",
  code: "mod-unavailable",
  message: "The Mod is unavailable. Reload Mods and try again."
});

export const MOD_ERROR: ModOperationFailure = Object.freeze({
  kind: "error",
  code: "mod-error",
  message: "The Mod operation could not be completed."
});
