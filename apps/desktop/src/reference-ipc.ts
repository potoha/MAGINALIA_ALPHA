/** Semantic main-process boundary for explicit derived-reference refreshes. */

import {
  type ReviewerResolutionFailure,
  type ReviewerResolutionResult,
  type ReviewerResolutionSuccess
} from "./reviewer-resolution";

export const RESOLVE_REFERENCES_CHANNEL = "maginalia:resolve-references";
export const MAX_REFERENCE_RESOLUTION_TEXT_CHARS = 5_000_000;

export interface ResolveReferencesRequest {
  readonly text: string;
}

export type ResolveReferencesResult = ReviewerResolutionResult;
export type ResolveReferencesSuccess = ReviewerResolutionSuccess;
export type ResolveReferencesFailure = ReviewerResolutionFailure;

export interface ReferenceInvokeEvent {
  readonly sender: object;
}

export interface ReferenceHandlers {
  readonly resolveReferences: (
    event: ReferenceInvokeEvent,
    request: unknown,
    ...args: readonly unknown[]
  ) => Promise<ResolveReferencesResult>;
}

const INVALID_REQUEST: ResolveReferencesFailure = Object.freeze({
  kind: "error",
  code: "invalid-request",
  message: "The reference refresh request was invalid."
});

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  try {
    const keys = Reflect.ownKeys(value);
    return keys.length === expected.length
      && keys.every((key) => typeof key === "string" && expected.includes(key));
  } catch {
    return false;
  }
}

export function isResolveReferencesRequest(value: unknown): value is ResolveReferencesRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ["text"])
    && typeof value.text === "string"
    && value.text.length <= MAX_REFERENCE_RESOLUTION_TEXT_CHARS;
}

export interface ReferenceResolutionDependencies {
  readonly resolve: (owner: object, text: string) => ResolveReferencesResult | Promise<ResolveReferencesResult>;
}

export function createReferenceHandlers(dependencies: ReferenceResolutionDependencies): ReferenceHandlers {
  return {
    resolveReferences: async (event, request, ...args) => {
      if (args.length !== 0 || !isResolveReferencesRequest(request)) return INVALID_REQUEST;
      try {
        return await dependencies.resolve(event.sender, request.text);
      } catch (_error: unknown) {
        return Object.freeze({
          kind: "error",
          code: "reviewer-error",
          message: "Reference refresh could not be completed. Try again."
        });
      }
    }
  };
}
