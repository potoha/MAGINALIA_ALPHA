import type { FirstRunChoices, FirstRunResult } from "./first-run-coordinator.js";

export type { FirstRunChoices } from "./first-run-coordinator.js";

export const GET_FIRST_RUN_STATUS_CHANNEL = "maginalia:first-run-status";
export const RUN_FIRST_RUN_SETUP_CHANNEL = "maginalia:first-run-setup";
export const FIRST_RUN_PROGRESS_CHANNEL = "maginalia:first-run-progress";

export interface FirstRunStatus {
  readonly kind: "ready" | "complete" | "error";
  readonly stage?: string;
  readonly message?: string;
}

export interface FirstRunProgressEvent {
  readonly message: string;
}

export function isFirstRunChoices(value: unknown): value is FirstRunChoices {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (record.workdeskMode === "new" || record.workdeskMode === "existing")
    && (record.privateShelfMode === "new" || record.privateShelfMode === "existing")
    && typeof record.registerPublicShelf === "boolean"
    && Object.keys(record).every((key) => ["workdeskMode", "privateShelfMode", "registerPublicShelf"].includes(key));
}

export function isFirstRunProgressEvent(value: unknown): value is FirstRunProgressEvent {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).message === "string";
}

export type FirstRunSetupResult = FirstRunResult;
