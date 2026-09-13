import type { MarkdownPreloadApi } from "../preload-api";

declare global {
  interface Window {
    readonly maginalia: MarkdownPreloadApi;
  }
}

export {};
