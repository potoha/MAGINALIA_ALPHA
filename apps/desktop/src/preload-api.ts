import {
  type OpenMarkdownResult,
  type SaveMarkdownRequest,
  type SaveMarkdownResult
} from "./markdown-ipc";

export const OPEN_MARKDOWN_CHANNEL = "maginalia:open-markdown";
export const SAVE_MARKDOWN_CHANNEL = "maginalia:save-markdown";

export interface MarkdownPreloadApi {
  openMarkdown(): Promise<OpenMarkdownResult>;
  saveMarkdown(request: SaveMarkdownRequest): Promise<SaveMarkdownResult>;
}

export type MarkdownInvoke = (channel: string, ...args: readonly unknown[]) => Promise<unknown>;

export function createMarkdownPreloadApi(invoke: MarkdownInvoke): MarkdownPreloadApi {
  return {
    openMarkdown: () => invoke(OPEN_MARKDOWN_CHANNEL) as Promise<OpenMarkdownResult>,
    saveMarkdown: (request) => invoke(SAVE_MARKDOWN_CHANNEL, request) as Promise<SaveMarkdownResult>
  };
}
