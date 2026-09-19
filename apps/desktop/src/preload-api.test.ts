import { describe, expect, it } from "vitest";
import {
  createMarkdownPreloadApi,
  OPEN_DOCUMENT_CHANNEL,
  OPEN_MARKDOWN_CHANNEL,
  OPEN_MANUSCRIPT_CHANNEL,
  OPEN_PROJECT_CHANNEL,
  CREATE_PROJECT_CHANNEL,
  RESTORE_PROJECT_CHANNEL,
  OPEN_PROJECT_FILE_CHANNEL,
  CREATE_PROJECT_FILE_CHANNEL,
  SAVE_MARKDOWN_CHANNEL,
  OPEN_LIBRARY_CHANNEL,
  SEARCH_LIBRARY_CHANNEL,
  RESOLVE_QUOTATION_FOR_INSERT_CHANNEL,
  SEARCH_SHELF_CHANNEL,
  CREATE_REPOSITORY_CHANNEL,
  CREATE_REPOSITORY_HISTORY_CHANNEL,
  LIST_REPOSITORY_HISTORY_CHANNEL,
  OPEN_REPOSITORY_CHANNEL,
  OPEN_REPOSITORY_HISTORY_CHANNEL,
  OPEN_REPOSITORY_DOCUMENT_CHANNEL,
  USE_REPOSITORY_SHELF_CHANNEL,
  DISCOVER_PRIVATE_WORKS_CHANNEL,
  CANCEL_PRIVATE_WORKS_DISCOVERY_CHANNEL,
  GITHUB_DEVICE_PROMPT_CHANNEL,
  GITHUB_DEVICE_VERIFICATION_URI
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
      "openProject",
      "createProject",
      "restoreProject",
      "openProjectFile",
      "createProjectFile",
      "openLibrary",
      "searchLibrary",
      "resolveQuotationForInsert",
      "searchShelf",
      "createRepository",
      "createRepositoryHistory",
      "listRepositoryHistory",
      "openRepositoryHistory",
      "openRepository",
      "openRepositoryDocument",
      "useRepositoryShelf",
      "discoverPrivateWorks",
      "cancelPrivateWorksDiscovery",
      "onDevicePrompt"
    ]);
    await api.openMarkdown();
    await api.saveMarkdown({ sessionId: "opaque-session", text: "# Draft\r\n" });
    await api.openDocument();
    await api.openManuscript({
      documentId: "00000000-0000-4000-8000-000000000000",
      manuscriptId: "11111111-1111-4111-8111-111111111111"
    });
    await api.openProject();
    await api.createProject({ title: "Coffee" });
    await api.restoreProject();
    await api.openProjectFile({
      projectId: "77777777-7777-4777-8777-777777777777",
      fileId: "88888888-8888-4888-8888-888888888888"
    });
    await api.createProjectFile({
      projectId: "77777777-7777-4777-8777-777777777777",
      fileName: "memo.md",
      title: "Memo",
      documentType: "memo"
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
    await api.searchShelf({ query: "日本語" });
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
    await api.discoverPrivateWorks();
    await api.cancelPrivateWorksDiscovery();

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
      { channel: OPEN_PROJECT_CHANNEL, args: [] },
      { channel: CREATE_PROJECT_CHANNEL, args: [{ title: "Coffee" }] },
      { channel: RESTORE_PROJECT_CHANNEL, args: [] },
      {
        channel: OPEN_PROJECT_FILE_CHANNEL,
        args: [{
          projectId: "77777777-7777-4777-8777-777777777777",
          fileId: "88888888-8888-4888-8888-888888888888"
        }]
      },
      {
        channel: CREATE_PROJECT_FILE_CHANNEL,
        args: [{
          projectId: "77777777-7777-4777-8777-777777777777",
          fileName: "memo.md",
          title: "Memo",
          documentType: "memo"
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
      { channel: SEARCH_SHELF_CHANNEL, args: [{ query: "日本語" }] },
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
      },
      { channel: DISCOVER_PRIVATE_WORKS_CHANNEL, args: [] },
      { channel: CANCEL_PRIVATE_WORKS_DISCOVERY_CHANNEL, args: [] }
    ]);
  });

  it("subscribes only to the fixed Device Flow prompt channel and validates payloads", () => {
    const listeners = new Map<string, (value: unknown) => void>();
    const subscribeCalls: string[] = [];
    const api = createMarkdownPreloadApi(
      async () => ({ kind: "cancelled" }),
      (channel, listener) => {
        subscribeCalls.push(channel);
        listeners.set(channel, listener);
        return () => listeners.delete(channel);
      },
    );
    const prompts: unknown[] = [];
    const unsubscribe = api.onDevicePrompt((prompt) => prompts.push(prompt));
    const listener = listeners.get(GITHUB_DEVICE_PROMPT_CHANNEL);
    expect(listener).toBeDefined();
    listener?.({
      userCode: "ABCD-1234",
      verificationUri: GITHUB_DEVICE_VERIFICATION_URI,
    });
    listener?.({
      userCode: "ABCD-1234",
      verificationUri: "https://evil.example/device",
    });
    listener?.({
      userCode: "../../secret",
      verificationUri: GITHUB_DEVICE_VERIFICATION_URI,
    });
    listener?.({
      userCode: "A".repeat(65),
      verificationUri: GITHUB_DEVICE_VERIFICATION_URI,
    });
    listener?.({
      userCode: "ABCD-1234",
      verificationUri: GITHUB_DEVICE_VERIFICATION_URI,
      token: "secret",
    });
    expect(subscribeCalls).toEqual([GITHUB_DEVICE_PROMPT_CHANNEL]);
    expect(prompts).toEqual([{
      userCode: "ABCD-1234",
      verificationUri: GITHUB_DEVICE_VERIFICATION_URI,
    }]);
    expect(Object.isFrozen(prompts[0])).toBe(true);

    unsubscribe();
    expect(listeners.has(GITHUB_DEVICE_PROMPT_CHANNEL)).toBe(false);
  });

  it("rejects an invalid prompt callback without subscribing", () => {
    let subscriptions = 0;
    const api = createMarkdownPreloadApi(
      async () => ({ kind: "cancelled" }),
      () => {
        subscriptions += 1;
        return () => undefined;
      },
    );
    expect(() => api.onDevicePrompt(null as never)).toThrow(TypeError);
    expect(subscriptions).toBe(0);
  });
});
