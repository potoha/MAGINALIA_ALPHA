import type { OpenMarkdownResult } from "./markdown-ipc";
import type { DocumentWorkspaceFailure } from "./document-workspace";
import type { ProjectInternalLinkResult } from "./project-service";

export const RESOLVE_INTERNAL_LINK_CHANNEL = "maginalia:resolve-internal-link";
export const OPEN_INTERNAL_LINK_CHANNEL = "maginalia:open-internal-link";
export const OPEN_EXTERNAL_LINK_CHANNEL = "maginalia:open-external-link";

export interface ResolveInternalLinkRequest { readonly projectId: string; readonly target: string; }
export interface OpenInternalLinkRequest { readonly projectId: string; readonly fileId: string; }
export interface OpenExternalLinkRequest { readonly url: string; }

export type InternalLinkIpcFailure = { readonly kind: "error"; readonly code: "invalid-request" | "resolve-failed" | "open-failed"; readonly message: string };
export type ResolveInternalLinkResult = ProjectInternalLinkResult | InternalLinkIpcFailure;
export type OpenInternalLinkResult = OpenMarkdownResult | DocumentWorkspaceFailure | InternalLinkIpcFailure;
export type OpenExternalLinkResult = { readonly kind: "opened" } | { readonly kind: "error"; readonly code: "invalid-url" | "open-failed"; readonly message: string };

export interface ProjectLinkInvokeEvent { readonly sender: object; }
export interface ProjectLinkHandlers {
  readonly resolveInternalLink: (event: ProjectLinkInvokeEvent, request: unknown, ...args: readonly unknown[]) => Promise<ResolveInternalLinkResult>;
  readonly openInternalLink: (event: ProjectLinkInvokeEvent, request: unknown, ...args: readonly unknown[]) => Promise<OpenInternalLinkResult>;
  readonly openExternalLink: (event: ProjectLinkInvokeEvent, request: unknown, ...args: readonly unknown[]) => Promise<OpenExternalLinkResult>;
}

export interface ProjectLinkDependencies {
  readonly resolveInternalLink: (owner: object, projectId: string, target: string) => Promise<ProjectInternalLinkResult>;
  readonly openInternalLink: (owner: object, projectId: string, fileId: string) => Promise<OpenMarkdownResult | DocumentWorkspaceFailure>;
  readonly openExternal: (url: string) => Promise<void>;
}

const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CONTROL = /[\u0000-\u001F\u007F]/u;

function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function opaqueId(value: unknown): value is string { return typeof value === "string" && OPAQUE_ID.test(value); }
function resolveRequest(value: unknown): value is ResolveInternalLinkRequest {
  return record(value, ["projectId", "target"]) && opaqueId(value.projectId) && typeof value.target === "string" && value.target.length <= 1_024;
}
function openRequest(value: unknown): value is OpenInternalLinkRequest {
  return record(value, ["projectId", "fileId"]) && opaqueId(value.projectId) && opaqueId(value.fileId);
}

/** Revalidate in main immediately before shell.openExternal. */
export function validateOpenExternalUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || CONTROL.test(value)) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.username.length === 0 && url.password.length === 0
      ? url.href : null;
  } catch { return null; }
}

export function createProjectLinkHandlers(dependencies: ProjectLinkDependencies): ProjectLinkHandlers {
  const invalid: InternalLinkIpcFailure = { kind: "error", code: "invalid-request", message: "The link request is invalid." };
  return {
    async resolveInternalLink(event, request, ...args) {
      if (args.length !== 0 || !resolveRequest(request)) return invalid;
      try { return await dependencies.resolveInternalLink(event.sender, request.projectId, request.target); }
      catch { return { kind: "error", code: "resolve-failed", message: "The internal link could not be resolved." }; }
    },
    async openInternalLink(event, request, ...args) {
      if (args.length !== 0 || !openRequest(request)) return invalid;
      try { return await dependencies.openInternalLink(event.sender, request.projectId, request.fileId); }
      catch { return { kind: "error", code: "open-failed", message: "The internal link could not be opened." }; }
    },
    async openExternalLink(_event, request, ...args) {
      if (args.length !== 0 || !record(request, ["url"])) return { kind: "error", code: "invalid-url", message: "The external link is invalid." };
      const url = validateOpenExternalUrl(request.url);
      if (url === null) return { kind: "error", code: "invalid-url", message: "The external link is not an allowed HTTP(S) URL." };
      try { await dependencies.openExternal(url); return { kind: "opened" }; }
      catch { return { kind: "error", code: "open-failed", message: "The external link could not be opened." }; }
    }
  };
}
