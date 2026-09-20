/** Renderer-safe lifecycle handshake for normal Electron shutdown. */

export const AUTOSAVE_FLUSH_REQUEST_CHANNEL = "maginalia:autosave-flush-request";
export const AUTOSAVE_FLUSH_RESPONSE_CHANNEL = "maginalia:autosave-flush-response";

export interface AutosaveFlushRequest {
  readonly requestId: string;
}

export interface AutosaveFlushResponseRequest {
  readonly requestId: string;
  readonly ok: boolean;
}

export type AutosaveFlushResponseResult =
  | { readonly kind: "accepted" }
  | { readonly kind: "error"; readonly message: string };

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}

export function isAutosaveFlushRequest(value: unknown): value is AutosaveFlushRequest {
  return isRecord(value)
    && hasExactKeys(value, ["requestId"])
    && typeof value.requestId === "string"
    && REQUEST_ID.test(value.requestId);
}

export function isAutosaveFlushResponseRequest(value: unknown): value is AutosaveFlushResponseRequest {
  return isRecord(value)
    && hasExactKeys(value, ["requestId", "ok"])
    && typeof value.requestId === "string"
    && REQUEST_ID.test(value.requestId)
    && typeof value.ok === "boolean";
}
