import type { ProjectSearchResult } from "./project-service";

/** Renderer-safe, current-Project-only literal Markdown search boundary. */
export const SEARCH_PROJECT_MARKDOWN_CHANNEL = "maginalia:search-project-markdown";
export const MAX_PROJECT_SEARCH_QUERY_CHARS = 500;
export const MAX_PROJECT_SEARCH_RESULTS = 100;

export interface SearchProjectMarkdownRequest {
  readonly projectId: string;
  readonly query: string;
}

export type ProjectSearchIpcFailure = {
  readonly kind: "error";
  readonly code: "invalid-request" | "search-failed";
  readonly message: string;
};

export type SearchProjectMarkdownResult = ProjectSearchResult | ProjectSearchIpcFailure;

export interface ProjectSearchInvokeEvent { readonly sender: object; }

export interface ProjectSearchHandlers {
  readonly searchProjectMarkdown: (
    event: ProjectSearchInvokeEvent,
    request: unknown,
    ...args: readonly unknown[]
  ) => Promise<SearchProjectMarkdownResult>;
}

export interface ProjectSearchDependencies {
  readonly searchProjectMarkdown: (
    owner: object,
    projectId: string,
    query: string
  ) => Promise<ProjectSearchResult>;
}

const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isRequest(value: unknown): value is SearchProjectMarkdownRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(record);
  return keys.length === 2
    && keys.includes("projectId")
    && keys.includes("query")
    && typeof record.projectId === "string"
    && OPAQUE_ID.test(record.projectId)
    && typeof record.query === "string"
    && record.query.length <= MAX_PROJECT_SEARCH_QUERY_CHARS;
}

export function createProjectSearchHandlers(dependencies: ProjectSearchDependencies): ProjectSearchHandlers {
  return {
    async searchProjectMarkdown(event, request, ...args) {
      if (args.length !== 0 || !isRequest(request)) {
        return { kind: "error", code: "invalid-request", message: "The Project search request is invalid." };
      }
      try {
        return await dependencies.searchProjectMarkdown(event.sender, request.projectId, request.query);
      } catch {
        return { kind: "error", code: "search-failed", message: "The Project search could not be completed. Try again." };
      }
    }
  };
}
