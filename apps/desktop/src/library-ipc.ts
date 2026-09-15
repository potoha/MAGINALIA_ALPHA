import type {
  LibraryFailure,
  LibraryOpenResult,
  LibraryQuotationResult,
  LibrarySearchResult,
} from "./library-service";

export const OPEN_LIBRARY_CHANNEL = "maginalia:open-library";
export const SEARCH_LIBRARY_CHANNEL = "maginalia:search-library";
export const RESOLVE_QUOTATION_FOR_INSERT_CHANNEL = "maginalia:resolve-quotation-for-insert";

export const MAX_LIBRARY_QUERY_CHARS = 2_000;

export interface LibraryInvokeEvent {
  readonly sender: object;
}

export interface LibraryFolderSelection {
  readonly canceled: boolean;
  readonly filePaths: readonly string[];
}

export interface LibraryCancelled {
  readonly kind: "cancelled";
}

export type LibraryIpcFailureCode =
  | "invalid-request"
  | "folder-dialog-failed"
  | "library-open-failed"
  | "library-search-failed"
  | "quotation-resolve-failed";

export interface LibraryIpcFailure {
  readonly kind: "error";
  readonly code: LibraryIpcFailureCode;
  readonly message: string;
}

export type OpenLibraryResult = LibraryOpenResult | LibraryCancelled | LibraryIpcFailure;

export interface SearchLibraryRequest {
  readonly libraryId: string;
  readonly query: string;
}

export interface QuotationReference {
  readonly annotationId: string;
  readonly sourceId: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly page?: number;
}

export interface SearchLibrarySuccess {
  readonly kind: "results";
  readonly libraryId: string;
  readonly results: readonly QuotationReference[];
}

export type SearchLibraryResult = SearchLibrarySuccess | LibraryFailure | LibraryIpcFailure;

export interface ResolveQuotationForInsertRequest {
  readonly libraryId: string;
  readonly annotationId: string;
}

export interface ResolveQuotationForInsertSuccess {
  readonly kind: "resolved";
  readonly libraryId: string;
  readonly annotationId: string;
  readonly sourceId: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly page?: number;
  readonly quote: string;
}

export type ResolveQuotationForInsertResult =
  | ResolveQuotationForInsertSuccess
  | LibraryFailure
  | LibraryIpcFailure;

export interface LibraryHandlerDependencies {
  readonly pickLibraryFolder: () => Promise<LibraryFolderSelection>;
  readonly openLibraryRoot: (owner: object, rootPath: string) => Promise<LibraryOpenResult>;
  readonly searchLibrary: (
    owner: object,
    libraryId: string,
    query: string,
  ) => LibrarySearchResult | Promise<LibrarySearchResult>;
  readonly resolveQuotationForInsert: (
    owner: object,
    libraryId: string,
    annotationId: string,
  ) => LibraryQuotationResult | Promise<LibraryQuotationResult>;
}

export interface LibraryHandlers {
  readonly openLibrary: (
    event: LibraryInvokeEvent,
    ...args: readonly unknown[]
  ) => Promise<OpenLibraryResult>;
  readonly searchLibrary: (
    event: LibraryInvokeEvent,
    request: unknown,
    ...args: readonly unknown[]
  ) => Promise<SearchLibraryResult>;
  readonly resolveQuotationForInsert: (
    event: LibraryInvokeEvent,
    request: unknown,
    ...args: readonly unknown[]
  ) => Promise<ResolveQuotationForInsertResult>;
}

const INVALID_REQUEST: LibraryIpcFailure = {
  kind: "error",
  code: "invalid-request",
  message: "The Library request was invalid.",
};

const FOLDER_DIALOG_FAILED: LibraryIpcFailure = {
  kind: "error",
  code: "folder-dialog-failed",
  message: "The Library folder could not be selected. Try again.",
};

const LIBRARY_OPEN_FAILED: LibraryIpcFailure = {
  kind: "error",
  code: "library-open-failed",
  message: "The Library could not be opened. Choose it again.",
};

const LIBRARY_SEARCH_FAILED: LibraryIpcFailure = {
  kind: "error",
  code: "library-search-failed",
  message: "The Library search could not be completed. Try again.",
};

const QUOTATION_RESOLVE_FAILED: LibraryIpcFailure = {
  kind: "error",
  code: "quotation-resolve-failed",
  message: "The quotation could not be resolved. Try again.",
};

const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ANNOTATION_ID = /^ann:[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID.test(value);
}

function isFolderSelection(value: unknown): value is LibraryFolderSelection {
  return isRecord(value)
    && typeof value.canceled === "boolean"
    && Array.isArray(value.filePaths)
    && value.filePaths.every((filePath) => typeof filePath === "string");
}

export function isSearchLibraryRequest(value: unknown): value is SearchLibraryRequest {
  if (!isRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === 2
    && keys.includes("libraryId")
    && keys.includes("query")
    && isOpaqueId(value.libraryId)
    && typeof value.query === "string"
    && value.query.length <= MAX_LIBRARY_QUERY_CHARS;
}

export function isResolveQuotationForInsertRequest(
  value: unknown,
): value is ResolveQuotationForInsertRequest {
  if (!isRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === 2
    && keys.includes("libraryId")
    && keys.includes("annotationId")
    && isOpaqueId(value.libraryId)
    && typeof value.annotationId === "string"
    && ANNOTATION_ID.test(value.annotationId);
}

function toQuotationReference(reference: {
  readonly annotationId: string;
  readonly sourceId: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly page?: number;
}): QuotationReference {
  const output: {
    annotationId: string;
    sourceId: string;
    title: string;
    authors: readonly string[];
    page?: number;
  } = {
    annotationId: reference.annotationId,
    sourceId: reference.sourceId,
    title: reference.title,
    authors: Object.freeze([...reference.authors]),
  };
  if (reference.page !== undefined) output.page = reference.page;
  return Object.freeze(output);
}

function toResolveResult(result: {
  readonly kind: "resolved";
  readonly libraryId: string;
  readonly annotationId: string;
  readonly sourceId: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly page?: number;
  readonly quote: string;
}): ResolveQuotationForInsertSuccess {
  const output: {
    kind: "resolved";
    libraryId: string;
    annotationId: string;
    sourceId: string;
    title: string;
    authors: readonly string[];
    page?: number;
    quote: string;
  } = {
    kind: "resolved",
    libraryId: result.libraryId,
    annotationId: result.annotationId,
    sourceId: result.sourceId,
    title: result.title,
    authors: Object.freeze([...result.authors]),
    quote: result.quote,
  };
  if (result.page !== undefined) output.page = result.page;
  return Object.freeze(output);
}

export function createLibraryHandlers(dependencies: LibraryHandlerDependencies): LibraryHandlers {
  return {
    openLibrary: async (event, ...args) => {
      if (args.length !== 0) return INVALID_REQUEST;

      let selection: LibraryFolderSelection;
      try {
        selection = await dependencies.pickLibraryFolder();
      } catch (_error: unknown) {
        return FOLDER_DIALOG_FAILED;
      }
      if (!isFolderSelection(selection)) return FOLDER_DIALOG_FAILED;
      if (selection.canceled || selection.filePaths.length === 0) return { kind: "cancelled" };
      if (selection.filePaths.length !== 1) return FOLDER_DIALOG_FAILED;

      try {
        return await dependencies.openLibraryRoot(event.sender, selection.filePaths[0]);
      } catch (_error: unknown) {
        return LIBRARY_OPEN_FAILED;
      }
    },
    searchLibrary: async (event, request, ...args) => {
      if (args.length !== 0 || !isSearchLibraryRequest(request)) return INVALID_REQUEST;

      try {
        const result = await dependencies.searchLibrary(event.sender, request.libraryId, request.query);
        if (result.kind !== "results") return result;
        return Object.freeze({
          kind: "results",
          libraryId: result.libraryId,
          results: Object.freeze(result.results.map(toQuotationReference)),
        });
      } catch (_error: unknown) {
        return LIBRARY_SEARCH_FAILED;
      }
    },
    resolveQuotationForInsert: async (event, request, ...args) => {
      if (args.length !== 0 || !isResolveQuotationForInsertRequest(request)) return INVALID_REQUEST;

      try {
        const result = await dependencies.resolveQuotationForInsert(
          event.sender,
          request.libraryId,
          request.annotationId,
        );
        if (result.kind !== "resolved") return result;
        return toResolveResult(result);
      } catch (_error: unknown) {
        return QUOTATION_RESOLVE_FAILED;
      }
    },
  };
}
