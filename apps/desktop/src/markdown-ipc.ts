export const MAX_MARKDOWN_BYTES = 5_000_000;

export interface OpenMarkdownSuccess {
  readonly kind: "opened";
  readonly sessionId: string;
  readonly displayName: string;
  readonly text: string;
}

export interface MarkdownCancelled {
  readonly kind: "cancelled";
}

export type MarkdownFailureCode =
  | "invalid-request"
  | "invalid-extension"
  | "not-regular-file"
  | "file-too-large"
  | "missing-file"
  | "file-unreadable"
  | "session-not-owned"
  | "content-too-large"
  | "save-failed";

export interface MarkdownFailure {
  readonly kind: "error";
  readonly code: MarkdownFailureCode;
  readonly message: string;
}

export type OpenMarkdownResult = OpenMarkdownSuccess | MarkdownCancelled | MarkdownFailure;

export interface SaveMarkdownRequest {
  readonly sessionId: string;
  readonly text: string;
}

export interface SaveMarkdownSuccess {
  readonly kind: "saved";
  readonly sessionId: string;
  readonly displayName: string;
  readonly text: string;
}

export interface MarkdownConflict {
  readonly kind: "conflict";
  readonly code: "external-change";
  readonly message: string;
}

export type SaveMarkdownResult = SaveMarkdownSuccess | MarkdownConflict | MarkdownFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isSaveMarkdownRequest(value: unknown): value is SaveMarkdownRequest {
  return isRecord(value)
    && typeof value.sessionId === "string"
    && value.sessionId.length > 0
    && typeof value.text === "string";
}
