import type { ReviewerQuotation } from "../reviewer-ipc";
import type { SearchProjectMarkdownResult } from "../project-search-ipc";
import type { CapturedInsertionTarget } from "./controller";

export type UnifiedSearchMode = "all" | "shelf" | "project";
export type ShelfSearchField = "quote" | "comment" | "title" | "authors" | "pageLabel";

export const DEFAULT_SHELF_SEARCH_FIELDS: ReadonlySet<ShelfSearchField> = new Set([
  "quote", "comment", "title", "authors", "pageLabel"
]);

export interface ProjectSearchResultItem {
  readonly fileId: string;
  readonly displayName: string;
  readonly excerpt: string;
  /** Raw Markdown is limited to the selected current-Project document. */
  readonly text: string;
}

export type ProjectSearchState =
  | { readonly kind: "idle" }
  | { readonly kind: "searching" }
  | { readonly kind: "results"; readonly results: readonly ProjectSearchResultItem[]; readonly total: number }
  | { readonly kind: "error"; readonly message: string };

export interface ProjectSearchApi {
  searchProjectMarkdown(request: { readonly projectId: string; readonly query: string }): Promise<SearchProjectMarkdownResult>;
}

export function normalizeSearchText(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase();
}

function includesLiteral(value: string | null | undefined, query: string): boolean {
  return typeof value === "string" && normalizeSearchText(value).includes(query);
}

/** Filter a broad Reviewer response locally without changing its identity contract. */
export function filterShelfResults(
  results: readonly ReviewerQuotation[],
  query: string,
  fields: ReadonlySet<ShelfSearchField>
): readonly ReviewerQuotation[] {
  if (fields.size === 0) return [];
  const normalized = normalizeSearchText(query);
  if (normalized.length === 0) return results;
  return results.filter((result) => (
    (fields.has("quote") && includesLiteral(result.quote, normalized))
    || (fields.has("comment") && includesLiteral(result.comment, normalized))
    || (fields.has("title") && includesLiteral(result.title, normalized))
    || (fields.has("authors") && result.authors.some((author) => includesLiteral(author, normalized)))
    || (fields.has("pageLabel") && includesLiteral(result.pageLabel, normalized))
  ));
}

export function shelfFilterValidation(fields: ReadonlySet<ShelfSearchField>): string | null {
  return fields.size === 0 ? "Choose at least one Shelf field to search." : null;
}

/** A small controller keeps Project search asynchronous state out of the DOM. */
export class ProjectSearchController {
  private operation = 0;
  private state: ProjectSearchState = { kind: "idle" };

  public constructor(private readonly api: ProjectSearchApi, private readonly onState: (state: ProjectSearchState) => void) {}

  public getState(): ProjectSearchState { return this.state; }

  public async search(projectId: string | null, query: string): Promise<void> {
    const operation = ++this.operation;
    if (projectId === null) return this.replace({ kind: "error", message: "Open a Project before searching its Markdown." });
    if (query.length === 0) return this.replace({ kind: "results", results: [], total: 0 });
    this.replace({ kind: "searching" });
    let result: SearchProjectMarkdownResult;
    try {
      result = await this.api.searchProjectMarkdown({ projectId, query });
    } catch {
      if (operation === this.operation) this.replace({ kind: "error", message: "The Project search could not be completed. Try again." });
      return;
    }
    if (operation !== this.operation) return;
    if (result.kind === "error") return this.replace({ kind: "error", message: result.message });
    this.replace({ kind: "results", results: result.results, total: result.total });
  }

  public clear(): void { this.operation += 1; this.replace({ kind: "idle" }); }

  private replace(state: ProjectSearchState): void {
    this.state = state;
    this.onState(state);
  }
}

/** Literal copy only: no QuoteRef, Source, or Reference state crosses this boundary. */
export function insertProjectSearchSelection(
  target: CapturedInsertionTarget | null,
  selectedText: string,
  isCurrent: (target: CapturedInsertionTarget | null) => boolean,
  insert: (target: CapturedInsertionTarget, text: string) => boolean
): "inserted" | "empty-selection" | "stale-target" {
  if (selectedText.length === 0) return "empty-selection";
  if (target === null || !isCurrent(target)) return "stale-target";
  return insert(target, selectedText) ? "inserted" : "stale-target";
}
