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

export const OPEN_MARKDOWN_CHANNEL = "maginalia:open-markdown";
export const SAVE_MARKDOWN_CHANNEL = "maginalia:save-markdown";
export { OPEN_DOCUMENT_CHANNEL, OPEN_MANUSCRIPT_CHANNEL } from "./document-workspace-ipc";

export interface MarkdownPreloadApi {
  openMarkdown(): Promise<OpenMarkdownResult>;
  saveMarkdown(request: SaveMarkdownRequest): Promise<SaveMarkdownResult>;
  openDocument?(): Promise<OpenDocumentResult>;
  openManuscript?(request: OpenManuscriptRequest): Promise<OpenManuscriptResult>;
}

export type CompleteMarkdownPreloadApi = MarkdownPreloadApi & {
  openDocument(): Promise<OpenDocumentResult>;
  openManuscript(request: OpenManuscriptRequest): Promise<OpenManuscriptResult>;
};

export type MarkdownInvoke = (channel: string, ...args: readonly unknown[]) => Promise<unknown>;

export function createMarkdownPreloadApi(invoke: MarkdownInvoke): CompleteMarkdownPreloadApi {
  return {
    openMarkdown: () => invoke(OPEN_MARKDOWN_CHANNEL) as Promise<OpenMarkdownResult>,
    saveMarkdown: (request) => invoke(SAVE_MARKDOWN_CHANNEL, request) as Promise<SaveMarkdownResult>,
    openDocument: () => invoke(OPEN_DOCUMENT_CHANNEL) as Promise<OpenDocumentResult>,
    openManuscript: (request) => invoke(OPEN_MANUSCRIPT_CHANNEL, request) as Promise<OpenManuscriptResult>
  };
}
