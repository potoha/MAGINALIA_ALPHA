import { describe, expect, it } from "vitest";
import {
  createMarkdownPreloadApi,
  OPEN_DOCUMENT_CHANNEL,
  OPEN_MARKDOWN_CHANNEL,
  OPEN_MANUSCRIPT_CHANNEL,
  SAVE_MARKDOWN_CHANNEL
} from "./preload-api";

describe("Markdown preload boundary", () => {
  it("exposes only the two semantic methods", async () => {
    const calls: Array<{ channel: string; args: unknown[] }> = [];
    const api = createMarkdownPreloadApi(async (channel, ...args) => {
      calls.push({ channel, args: [...args] });
      return { kind: "cancelled" };
    });

    expect(Object.keys(api)).toEqual(["openMarkdown", "saveMarkdown", "openDocument", "openManuscript"]);
    await api.openMarkdown();
    await api.saveMarkdown({ sessionId: "opaque-session", text: "# Draft\r\n" });
    await api.openDocument();
    await api.openManuscript({
      documentId: "00000000-0000-4000-8000-000000000000",
      manuscriptId: "11111111-1111-4111-8111-111111111111"
    });

    expect(calls).toEqual([
      { channel: OPEN_MARKDOWN_CHANNEL, args: [] },
      { channel: SAVE_MARKDOWN_CHANNEL, args: [{ sessionId: "opaque-session", text: "# Draft\r\n" }] },
      { channel: OPEN_DOCUMENT_CHANNEL, args: [] },
      {
        channel: OPEN_MANUSCRIPT_CHANNEL,
        args: [{
          documentId: "00000000-0000-4000-8000-000000000000",
          manuscriptId: "11111111-1111-4111-8111-111111111111"
        }]
      }
    ]);
  });
});
