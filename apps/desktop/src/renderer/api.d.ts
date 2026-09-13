import type { CompleteMarkdownPreloadApi } from "../preload-api";

declare global {
  interface Window {
    readonly maginalia: CompleteMarkdownPreloadApi;
  }
}

export {};
