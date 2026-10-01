import { describe, expect, it } from "vitest";
import { lookupOpenBdMetadata, type OpenBdFetchResponse } from "./openbd-metadata";

const ISBN13 = "9784834000825";

function response(body: unknown, ok = true): OpenBdFetchResponse {
  return { ok, json: async () => body };
}

describe("openBD metadata adapter", () => {
  it("uses the fixed endpoint and preserves Japanese metadata while splitting catalog author names", async () => {
    let requestedUrl: string | undefined;
    const result = await lookupOpenBdMetadata(ISBN13, async (url) => {
      requestedUrl = url;
      return response([{
        summary: {
          isbn: ISBN13,
          title: "「開かれた作品」　研究",
          author: "中川,李枝子 大村,百合子"
        }
      }]);
    });

    expect(requestedUrl).toBe(`https://api.openbd.jp/v1/get?isbn=${ISBN13}`);
    expect(result).toEqual({
      status: "ok",
      metadata: {
        isbn13: ISBN13,
        title: "「開かれた作品」　研究",
        authors: ["中川,李枝子", "大村,百合子"]
      }
    });
  });

  it("reports a null catalog result as not found", async () => {
    await expect(lookupOpenBdMetadata(ISBN13, async () => response([null]))).resolves.toEqual({
      status: "not-found"
    });
  });

  it("reports transport and HTTP failures as unavailable", async () => {
    await expect(lookupOpenBdMetadata(ISBN13, async () => {
      throw new Error("network unavailable");
    })).resolves.toEqual({ status: "unavailable" });

    await expect(lookupOpenBdMetadata(ISBN13, async () => response(null, false))).resolves.toEqual({
      status: "unavailable"
    });
  });

  it("reports missing required title or authors as incomplete", async () => {
    await expect(lookupOpenBdMetadata(ISBN13, async () => response([{
      summary: { title: "題名だけ" }
    }]))).resolves.toEqual({ status: "incomplete" });

    await expect(lookupOpenBdMetadata(ISBN13, async () => response([{
      summary: { title: "  \t ", author: "著者" }
    }]))).resolves.toEqual({ status: "incomplete" });
  });

  it("does not split an ambiguous author name on ordinary whitespace", async () => {
    await expect(lookupOpenBdMetadata(ISBN13, async () => response([{
      summary: { title: "A book", author: "John Ronald Reuel Tolkien" }
    }]))).resolves.toEqual({
      status: "ok",
      metadata: {
        isbn13: ISBN13,
        title: "A book",
        authors: ["John Ronald Reuel Tolkien"]
      }
    });
  });

  it("rejects a response whose ISBN does not match the request", async () => {
    await expect(lookupOpenBdMetadata(ISBN13, async () => response([{
      summary: {
        isbn: "9780000000000",
        title: "別の本",
        author: "著者"
      }
    }]))).resolves.toEqual({ status: "invalid-response" });
  });

  it("parses publisher and the publication year from the summary pubdate", async () => {
    await expect(lookupOpenBdMetadata(ISBN13, async () => response([{
      summary: {
        isbn: ISBN13,
        title: "ぐりとぐら",
        author: "中川,李枝子",
        publisher: "福音館書店",
        pubdate: "196701"
      }
    }]))).resolves.toEqual({
      status: "ok",
      metadata: {
        isbn13: ISBN13,
        title: "ぐりとぐら",
        authors: ["中川,李枝子"],
        publisher: "福音館書店",
        year: 1967
      }
    });
  });

  it("reports malformed JSON payloads as invalid response", async () => {
    await expect(lookupOpenBdMetadata(ISBN13, async () => ({
      ok: true,
      json: async () => { throw new Error("invalid json"); }
    }))).resolves.toEqual({ status: "invalid-response" });
  });
});
