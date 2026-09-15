import {
  type OpenMarkdownResult,
  type SaveMarkdownRequest,
  type SaveMarkdownResult
} from "./markdown-ipc";
import {
  OPEN_DOCUMENT_CHANNEL,
  OPEN_MANUSCRIPT_CHANNEL,
  type OpenDocumentResult,
  type OpenManuscriptRequest,
  type OpenManuscriptResult
} from "./document-workspace-ipc";
import {
  OPEN_LIBRARY_CHANNEL,
  RESOLVE_QUOTATION_FOR_INSERT_CHANNEL,
  SEARCH_LIBRARY_CHANNEL,
  type OpenLibraryResult,
  type ResolveQuotationForInsertRequest,
  type ResolveQuotationForInsertResult,
  type SearchLibraryRequest,
  type SearchLibraryResult
} from "./library-ipc";
import {
  CREATE_REPOSITORY_CHANNEL,
  CREATE_REPOSITORY_HISTORY_CHANNEL,
  LIST_REPOSITORY_HISTORY_CHANNEL,
  OPEN_REPOSITORY_CHANNEL,
  OPEN_REPOSITORY_HISTORY_CHANNEL,
  OPEN_REPOSITORY_DOCUMENT_CHANNEL,
  USE_REPOSITORY_SHELF_CHANNEL,
  type CreateRepositoryRequest,
  type CreateRepositoryResult,
  type CreateRepositoryHistoryResult,
  type ListRepositoryHistoryResult,
  type OpenRepositoryDocumentResult,
  type OpenRepositoryHistoryResult,
  type OpenRepositoryResult,
  type RepositoryHandoffRequest,
  type RepositoryHistoryCopyRequest,
  type RepositoryHistoryRequest,
  type UseRepositoryShelfResult
} from "./repository-ipc";

export const OPEN_MARKDOWN_CHANNEL = "maginalia:open-markdown";
export const SAVE_MARKDOWN_CHANNEL = "maginalia:save-markdown";
export { OPEN_DOCUMENT_CHANNEL, OPEN_MANUSCRIPT_CHANNEL } from "./document-workspace-ipc";
export {
  OPEN_LIBRARY_CHANNEL,
  SEARCH_LIBRARY_CHANNEL,
  RESOLVE_QUOTATION_FOR_INSERT_CHANNEL
} from "./library-ipc";
export {
  CREATE_REPOSITORY_CHANNEL,
  CREATE_REPOSITORY_HISTORY_CHANNEL,
  LIST_REPOSITORY_HISTORY_CHANNEL,
  OPEN_REPOSITORY_CHANNEL,
  OPEN_REPOSITORY_HISTORY_CHANNEL,
  OPEN_REPOSITORY_DOCUMENT_CHANNEL,
  USE_REPOSITORY_SHELF_CHANNEL
} from "./repository-ipc";

export type {
  OpenLibraryResult,
  QuotationReference,
  ResolveQuotationForInsertRequest,
  ResolveQuotationForInsertResult,
  SearchLibraryRequest,
  SearchLibraryResult
} from "./library-ipc";
export type {
  CreateRepositoryRequest,
  CreateRepositoryResult,
  CreateRepositoryHistoryResult,
  ListRepositoryHistoryResult,
  OpenRepositoryDocumentResult,
  OpenRepositoryHistoryResult,
  OpenRepositoryResult,
  RepositoryHandoffRequest,
  RepositoryHistoryCopyRequest,
  RepositoryHistoryRequest,
  UseRepositoryShelfResult
} from "./repository-ipc";

export interface MarkdownPreloadApi {
  openMarkdown(): Promise<OpenMarkdownResult>;
  saveMarkdown(request: SaveMarkdownRequest): Promise<SaveMarkdownResult>;
  openDocument?(): Promise<OpenDocumentResult>;
  openManuscript?(request: OpenManuscriptRequest): Promise<OpenManuscriptResult>;
  openLibrary?(): Promise<OpenLibraryResult>;
  searchLibrary?(request: SearchLibraryRequest): Promise<SearchLibraryResult>;
  resolveQuotationForInsert?(request: ResolveQuotationForInsertRequest): Promise<ResolveQuotationForInsertResult>;
  createRepository?(request: CreateRepositoryRequest): Promise<CreateRepositoryResult>;
  createRepositoryHistory?(request: RepositoryHistoryRequest): Promise<CreateRepositoryHistoryResult>;
  listRepositoryHistory?(request: RepositoryHistoryRequest): Promise<ListRepositoryHistoryResult>;
  openRepositoryHistory?(request: RepositoryHistoryCopyRequest): Promise<OpenRepositoryHistoryResult>;
  openRepository?(): Promise<OpenRepositoryResult>;
  openRepositoryDocument?(request: RepositoryHandoffRequest): Promise<OpenRepositoryDocumentResult>;
  useRepositoryShelf?(request: RepositoryHandoffRequest): Promise<UseRepositoryShelfResult>;
}

export type CompleteMarkdownPreloadApi = MarkdownPreloadApi & {
  openDocument(): Promise<OpenDocumentResult>;
  openManuscript(request: OpenManuscriptRequest): Promise<OpenManuscriptResult>;
  openLibrary(): Promise<OpenLibraryResult>;
  searchLibrary(request: SearchLibraryRequest): Promise<SearchLibraryResult>;
  resolveQuotationForInsert(request: ResolveQuotationForInsertRequest): Promise<ResolveQuotationForInsertResult>;
  createRepository(request: CreateRepositoryRequest): Promise<CreateRepositoryResult>;
  createRepositoryHistory(request: RepositoryHistoryRequest): Promise<CreateRepositoryHistoryResult>;
  listRepositoryHistory(request: RepositoryHistoryRequest): Promise<ListRepositoryHistoryResult>;
  openRepositoryHistory(request: RepositoryHistoryCopyRequest): Promise<OpenRepositoryHistoryResult>;
  openRepository(): Promise<OpenRepositoryResult>;
  openRepositoryDocument(request: RepositoryHandoffRequest): Promise<OpenRepositoryDocumentResult>;
  useRepositoryShelf(request: RepositoryHandoffRequest): Promise<UseRepositoryShelfResult>;
};

export type MarkdownInvoke = (channel: string, ...args: readonly unknown[]) => Promise<unknown>;

export function createMarkdownPreloadApi(invoke: MarkdownInvoke): CompleteMarkdownPreloadApi {
  return {
    openMarkdown: () => invoke(OPEN_MARKDOWN_CHANNEL) as Promise<OpenMarkdownResult>,
    saveMarkdown: (request) => invoke(SAVE_MARKDOWN_CHANNEL, request) as Promise<SaveMarkdownResult>,
    openDocument: () => invoke(OPEN_DOCUMENT_CHANNEL) as Promise<OpenDocumentResult>,
    openManuscript: (request) => invoke(OPEN_MANUSCRIPT_CHANNEL, request) as Promise<OpenManuscriptResult>,
    openLibrary: () => invoke(OPEN_LIBRARY_CHANNEL) as Promise<OpenLibraryResult>,
    searchLibrary: (request) => invoke(SEARCH_LIBRARY_CHANNEL, request) as Promise<SearchLibraryResult>,
    resolveQuotationForInsert: (request) =>
      invoke(RESOLVE_QUOTATION_FOR_INSERT_CHANNEL, request) as Promise<ResolveQuotationForInsertResult>,
    createRepository: (request) =>
      invoke(CREATE_REPOSITORY_CHANNEL, request) as Promise<CreateRepositoryResult>,
    createRepositoryHistory: (request) =>
      invoke(CREATE_REPOSITORY_HISTORY_CHANNEL, request) as Promise<CreateRepositoryHistoryResult>,
    listRepositoryHistory: (request) =>
      invoke(LIST_REPOSITORY_HISTORY_CHANNEL, request) as Promise<ListRepositoryHistoryResult>,
    openRepositoryHistory: (request) =>
      invoke(OPEN_REPOSITORY_HISTORY_CHANNEL, request) as Promise<OpenRepositoryHistoryResult>,
    openRepository: () => invoke(OPEN_REPOSITORY_CHANNEL) as Promise<OpenRepositoryResult>,
    openRepositoryDocument: (request) =>
      invoke(OPEN_REPOSITORY_DOCUMENT_CHANNEL, request) as Promise<OpenRepositoryDocumentResult>,
    useRepositoryShelf: (request) =>
      invoke(USE_REPOSITORY_SHELF_CHANNEL, request) as Promise<UseRepositoryShelfResult>
  };
}
