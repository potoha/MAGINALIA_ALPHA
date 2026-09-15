import { describe, expect, it } from "vitest";
import {
  createMarkdownPreloadApi,
  OPEN_DOCUMENT_CHANNEL,
  OPEN_MARKDOWN_CHANNEL,
  OPEN_MANUSCRIPT_CHANNEL,
  SAVE_MARKDOWN_CHANNEL,
  OPEN_LIBRARY_CHANNEL,
  SEARCH_LIBRARY_CHANNEL,
  RESOLVE_QUOTATION_FOR_INSERT_CHANNEL,
  CREATE_REPOSITORY_CHANNEL,
  CREATE_REPOSITORY_HISTORY_CHANNEL,
  LIST_REPOSITORY_HISTORY_CHANNEL,
  OPEN_REPOSITORY_CHANNEL,
  OPEN_REPOSITORY_HISTORY_CHANNEL,
  OPEN_REPOSITORY_DOCUMENT_CHANNEL,
  USE_REPOSITORY_SHELF_CHANNEL
} from "./preload-api";

describe("preload boundary", () => {
  it("exposes only the narrow semantic methods", async () => {
    const calls: Array<{ channel: string; args: unknown[] }> = [];
    const api = createMarkdownPreloadApi(async (channel, ...args) => {
      calls.push({ channel, args: [...args] });
      return { kind: "cancelled" };
    });

    expect(Object.keys(api)).toEqual([
      "openMarkdown",
      "saveMarkdown",
      "openDocument",
      "openManuscript",
      "openLibrary",
      "searchLibrary",
      "resolveQuotationForInsert",
      "createRepository",
      "createRepositoryHistory",
      "listRepositoryHistory",
      "openRepositoryHistory",
      "openRepository",
      "openRepositoryDocument",
      "useRepositoryShelf"
    ]);
    await api.openMarkdown();
    await api.saveMarkdown({ sessionId: "opaque-session", text: "# Draft\r\n" });
    await api.openDocument();
    await api.openManuscript({
      documentId: "00000000-0000-4000-8000-000000000000",
      manuscriptId: "11111111-1111-4111-8111-111111111111"
    });
    await api.openLibrary();
    await api.searchLibrary({
      libraryId: "22222222-2222-4222-8222-222222222222",
      query: "日本語"
    });
    await api.resolveQuotationForInsert({
      libraryId: "22222222-2222-4222-8222-222222222222",
      annotationId: "ann:01ARZ3NDEKTSV4RRFFQ69G5FAV"
    });
    await api.createRepository({ kind: "project", title: "Project" });
    await api.createRepositoryHistory({ repositoryId: "55555555-5555-4555-8555-555555555555" });
    await api.listRepositoryHistory({ repositoryId: "55555555-5555-4555-8555-555555555555" });
    await api.openRepositoryHistory({
      repositoryId: "55555555-5555-4555-8555-555555555555",
      historyId: "66666666-6666-4666-8666-666666666666"
    });
    await api.openRepository();
    await api.openRepositoryDocument({
      repositoryId: "33333333-3333-4333-8333-333333333333"
    });
    await api.useRepositoryShelf({
      repositoryId: "44444444-4444-4444-8444-444444444444"
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
      },
      { channel: OPEN_LIBRARY_CHANNEL, args: [] },
      {
        channel: SEARCH_LIBRARY_CHANNEL,
        args: [{ libraryId: "22222222-2222-4222-8222-222222222222", query: "日本語" }]
      },
      {
        channel: RESOLVE_QUOTATION_FOR_INSERT_CHANNEL,
        args: [{
          libraryId: "22222222-2222-4222-8222-222222222222",
          annotationId: "ann:01ARZ3NDEKTSV4RRFFQ69G5FAV"
        }]
      },
      {
        channel: CREATE_REPOSITORY_CHANNEL,
        args: [{ kind: "project", title: "Project" }]
      },
      {
        channel: CREATE_REPOSITORY_HISTORY_CHANNEL,
        args: [{ repositoryId: "55555555-5555-4555-8555-555555555555" }]
      },
      {
        channel: LIST_REPOSITORY_HISTORY_CHANNEL,
        args: [{ repositoryId: "55555555-5555-4555-8555-555555555555" }]
      },
      {
        channel: OPEN_REPOSITORY_HISTORY_CHANNEL,
        args: [{
          repositoryId: "55555555-5555-4555-8555-555555555555",
          historyId: "66666666-6666-4666-8666-666666666666"
        }]
      },
      { channel: OPEN_REPOSITORY_CHANNEL, args: [] },
      {
        channel: OPEN_REPOSITORY_DOCUMENT_CHANNEL,
        args: [{ repositoryId: "33333333-3333-4333-8333-333333333333" }]
      },
      {
        channel: USE_REPOSITORY_SHELF_CHANNEL,
        args: [{ repositoryId: "44444444-4444-4444-8444-444444444444" }]
      }
    ]);
  });
});
