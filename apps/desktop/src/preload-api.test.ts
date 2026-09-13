import { describe, expect, it } from "vitest";
import {
  createMarkdownPreloadApi,
  OPEN_MARKDOWN_CHANNEL,
  SAVE_MARKDOWN_CHANNEL
} from "./preload-api";

describe("Markdown preload boundary", () => {
  it("exposes only the two semantic methods", async () => {
    const calls: Array<{ channel: string; args: unknown[] }> = [];
    const api = createMarkdownPreloadApi(async (channel, ...args) => {
      calls.push({ channel, args: [...args] });
      return { kind: "cancelled" };
    });

    expect(Object.keys(api)).toEqual(["openMarkdown", "saveMarkdown"]);
    await api.openMarkdown();
    await api.saveMarkdown({ sessionId: "opaque-session", text: "# Draft\r\n" });

    expect(calls).toEqual([
      { channel: OPEN_MARKDOWN_CHANNEL, args: [] },
      { channel: SAVE_MARKDOWN_CHANNEL, args: [{ sessionId: "opaque-session", text: "# Draft\r\n" }] }
    ]);
  });
});
