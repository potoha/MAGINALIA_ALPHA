import { describe, expect, it } from "vitest";
import {
  CREATE_REPOSITORY_CHANNEL,
  CREATE_REPOSITORY_HISTORY_CHANNEL,
  LIST_REPOSITORY_HISTORY_CHANNEL,
  OPEN_REPOSITORY_CHANNEL,
  OPEN_REPOSITORY_HISTORY_CHANNEL,
  OPEN_REPOSITORY_DOCUMENT_CHANNEL,
  USE_REPOSITORY_SHELF_CHANNEL,
  createRepositoryHandlers,
  isCreateRepositoryRequest,
  isRepositoryHandoffRequest,
  isRepositoryHistoryRequest,
  isRepositoryHistoryCopyRequest,
  type RepositoryHandlerDependencies,
  type RepositoryHandlers,
} from "./repository-ipc";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const WORKBENCH_ID = "22222222-2222-4222-8222-222222222222";
const SHELF_ID = "33333333-3333-4333-8333-333333333333";
const OWNER = {};

function createTestHandlers(
  overrides: Partial<RepositoryHandlerDependencies> = {},
): RepositoryHandlers {
  return createRepositoryHandlers({
    pickParentFolder: async () => ({ canceled: true, filePaths: [] }),
    pickRepositoryFolder: async () => ({ canceled: true, filePaths: [] }),
    pickHistoryDestinationParent: async () => ({ canceled: true, filePaths: [] }),
    createRepository: async () => ({
      kind: "opened",
      repository: {
        repositoryId: PROJECT_ID,
        kind: "project",
        title: "Project",
        templateVersion: 1,
      },
    }),
    createHistory: async (_owner, repositoryId) => ({
      kind: "snapshot",
      repositoryId,
      created: false,
      latest: {
        historyId: "66666666-6666-4666-8666-666666666666",
        timestampMs: 1_700_000_000_000,
      },
    }),
    listHistory: async (_owner, repositoryId) => ({
      kind: "history",
      repositoryId,
      entries: [],
      truncated: false,
    }),
    openHistoryCopy: async () => ({
      kind: "opened",
      repository: {
        repositoryId: "99999999-9999-4999-8999-999999999999",
        kind: "project",
        title: "History copy",
        templateVersion: 1,
      },
    }),
    openRepository: async () => ({
      kind: "opened",
      repository: {
        repositoryId: PROJECT_ID,
        kind: "project",
        title: "Project",
        templateVersion: 1,
      },
    }),
    resolveRepository: async () => ({
      kind: "resolved",
      canonicalRoot: "C:\\private\\repository",
      identity: {
        schemaVersion: 1,
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        kind: "project",
        title: "Project",
        templateVersion: 1,
      },
    }),
    openDocument: async () => ({
      kind: "opened",
      document: {
        documentId: "44444444-4444-4444-8444-444444444444",
        displayName: "Project",
      },
      manuscripts: [],
    }),
    openLibrary: async () => ({
      kind: "opened",
      library: { libraryId: "55555555-5555-4555-8555-555555555555", displayName: "Shelf" },
      recordCount: 0,
      issueCount: 0,
    }),
    ...overrides,
  });
}

describe("repository IPC boundary", () => {
  it("accepts exact repository creation and handoff requests only", () => {
    for (const kind of ["project", "workbench", "shelf"] as const) {
      expect(isCreateRepositoryRequest({ kind, title: "日本語のタイトル" })).toBe(true);
    }
    expect(isCreateRepositoryRequest({ kind: "project", title: "Title", path: "C:\\outside" })).toBe(false);
    expect(isCreateRepositoryRequest({ kind: "unknown", title: "Title" })).toBe(false);
    expect(isCreateRepositoryRequest({ kind: "project", title: "   " })).toBe(false);
    expect(isCreateRepositoryRequest({ kind: "project", title: "x".repeat(201) })).toBe(false);
    expect(isCreateRepositoryRequest({ kind: "project", title: "line\nfeed" })).toBe(false);
    expect(isCreateRepositoryRequest(null)).toBe(false);
    expect(isCreateRepositoryRequest(["project", "Title"])).toBe(false);

    const withPrototype = Object.create({ kind: "project" }) as { kind: string; title: string };
    withPrototype.title = "Title";
    expect(isCreateRepositoryRequest(withPrototype)).toBe(false);

    const withAccessor = {} as { kind: string; title: string };
    Object.defineProperty(withAccessor, "kind", { get: () => "project", enumerable: true });
    Object.defineProperty(withAccessor, "title", { value: "Title", enumerable: true });
    expect(isCreateRepositoryRequest(withAccessor)).toBe(false);

    const valid = { repositoryId: PROJECT_ID };
    expect(isRepositoryHandoffRequest(valid)).toBe(true);
    expect(isRepositoryHandoffRequest({ ...valid, path: "C:\\outside" })).toBe(false);
    expect(isRepositoryHandoffRequest({ ...valid, extra: true })).toBe(false);
    expect(isRepositoryHandoffRequest({ repositoryId: "../../outside" })).toBe(false);
    expect(isRepositoryHandoffRequest({ repositoryId: "not-a-uuid" })).toBe(false);
    expect(isRepositoryHandoffRequest(null)).toBe(false);

    expect(isRepositoryHistoryRequest({ repositoryId: PROJECT_ID })).toBe(true);
    expect(isRepositoryHistoryRequest({ repositoryId: PROJECT_ID, path: "C:\\outside" })).toBe(false);
    expect(isRepositoryHistoryRequest({ repositoryId: "../../outside" })).toBe(false);

    expect(isRepositoryHistoryCopyRequest({
      repositoryId: PROJECT_ID,
      historyId: "66666666-6666-4666-8666-666666666666",
    })).toBe(true);
    expect(isRepositoryHistoryCopyRequest({
      repositoryId: PROJECT_ID,
      historyId: "66666666-6666-4666-8666-666666666666",
      path: "C:\\outside",
    })).toBe(false);
    expect(isRepositoryHistoryCopyRequest({ repositoryId: PROJECT_ID, historyId: "../../outside" })).toBe(false);

    const handoffWithPrototype = Object.create({ repositoryId: PROJECT_ID }) as { repositoryId: string };
    expect(isRepositoryHandoffRequest(handoffWithPrototype)).toBe(false);
  });

  it("uses native folder selections, preserves cancellation, and never returns a selected path", async () => {
    let parentPicked = 0;
    let createArgs: unknown[] = [];
    const handlers = createTestHandlers({
      pickParentFolder: async () => {
        parentPicked += 1;
        return { canceled: false, filePaths: ["C:\\private\\parent"] };
      },
      createRepository: async (owner, parent, kind, title) => {
        createArgs = [owner, parent, kind, title];
        return {
          kind: "opened",
          repository: { repositoryId: PROJECT_ID, kind, title, templateVersion: 1 },
        };
      },
    });

    const created = await handlers.createRepository(
      { sender: OWNER },
      { kind: "workbench", title: "作業場" },
    );
    expect(created).toMatchObject({ kind: "opened", repository: { kind: "workbench", title: "作業場" } });
    expect(createArgs).toEqual([OWNER, "C:\\private\\parent", "workbench", "作業場"]);
    expect(JSON.stringify(created)).not.toContain("C:\\private\\parent");

    expect(await handlers.createRepository({ sender: OWNER }, { kind: "project", title: "Title" }, "extra"))
      .toMatchObject({ kind: "error", code: "invalid-request" });
    expect(parentPicked).toBe(1);

    const cancelled = createTestHandlers({
      pickParentFolder: async () => ({ canceled: true, filePaths: [] }),
    });
    expect(await cancelled.createRepository({ sender: OWNER }, { kind: "project", title: "Title" }))
      .toEqual({ kind: "cancelled" });

    const multiple = createTestHandlers({
      pickParentFolder: async () => ({ canceled: false, filePaths: ["C:\\one", "C:\\two"] }),
    });
    expect(await multiple.createRepository({ sender: OWNER }, { kind: "project", title: "Title" }))
      .toMatchObject({ kind: "error", code: "parent-folder-dialog-failed" });
  });

  it("opens one selected repository folder and sanitizes dialog/service failures", async () => {
    let selected = "";
    const handlers = createTestHandlers({
      pickRepositoryFolder: async () => ({ canceled: false, filePaths: ["C:\\private\\repository"] }),
      openRepository: async (_owner, root) => {
        selected = root;
        return {
          kind: "opened",
          repository: { repositoryId: PROJECT_ID, kind: "project", title: "Project", templateVersion: 1 },
        };
      },
    });
    const opened = await handlers.openRepository({ sender: OWNER });
    expect(opened).toMatchObject({ kind: "opened", repository: { repositoryId: PROJECT_ID } });
    expect(selected).toBe("C:\\private\\repository");
    expect(JSON.stringify(opened)).not.toContain(selected);

    expect(await handlers.openRepository({ sender: OWNER }, { path: "C:\\outside" }))
      .toMatchObject({ kind: "error", code: "invalid-request" });

    const cancelled = createTestHandlers({
      pickRepositoryFolder: async () => ({ canceled: true, filePaths: [] }),
    });
    expect(await cancelled.openRepository({ sender: OWNER })).toEqual({ kind: "cancelled" });

    const thrown = createTestHandlers({
      pickRepositoryFolder: async () => {
        throw new Error("stack C:\\secret");
      },
    });
    const failed = await thrown.openRepository({ sender: OWNER });
    expect(failed).toMatchObject({ kind: "error", code: "repository-folder-dialog-failed" });
    expect(JSON.stringify(failed)).not.toContain("C:\\secret");

    const serviceThrown = createTestHandlers({
      pickRepositoryFolder: async () => ({ canceled: false, filePaths: ["C:\\secret"] }),
      openRepository: async () => {
        throw new Error("raw stack C:\\secret");
      },
    });
    const serviceFailure = await serviceThrown.openRepository({ sender: OWNER });
    expect(serviceFailure).toMatchObject({ kind: "error", code: "repository-open-failed" });
    expect(JSON.stringify(serviceFailure)).not.toContain("raw stack");
    expect(JSON.stringify(serviceFailure)).not.toContain("C:\\secret");
  });

  it("keeps repository opening separate from explicit document and shelf handoff", async () => {
    const calls: string[] = [];
    const handlers = createTestHandlers({
      pickRepositoryFolder: async () => ({ canceled: false, filePaths: ["C:\\private\\repository"] }),
      openRepository: async () => {
        calls.push("open-repository");
        return {
          kind: "opened",
          repository: { repositoryId: PROJECT_ID, kind: "project", title: "Project", templateVersion: 1 },
        };
      },
      resolveRepository: async (_owner, repositoryId) => {
        calls.push(`resolve:${repositoryId}`);
        return {
          kind: "resolved",
          canonicalRoot: "C:\\private\\repository",
          identity: {
            schemaVersion: 1,
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            kind: repositoryId === SHELF_ID ? "shelf" : "project",
            title: "Repository",
            templateVersion: 1,
          },
        };
      },
      openDocument: async (_owner, root) => {
        calls.push(`document:${root}`);
        return {
          kind: "opened",
          document: { documentId: "66666666-6666-4666-8666-666666666666", displayName: "Document" },
          manuscripts: [],
        };
      },
      openLibrary: async (_owner, root) => {
        calls.push(`library:${root}`);
        return {
          kind: "opened",
          library: { libraryId: "77777777-7777-4777-8777-777777777777", displayName: "Library" },
          recordCount: 0,
          issueCount: 0,
        };
      },
    });

    await handlers.openRepository({ sender: OWNER });
    expect(calls).toEqual(["open-repository"]);

    const document = await handlers.openRepositoryDocument({ sender: OWNER }, { repositoryId: PROJECT_ID });
    expect(document).toMatchObject({ kind: "opened", document: { displayName: "Document" } });
    expect(JSON.stringify(document)).not.toContain("C:\\private\\repository");

    const shelf = await handlers.useRepositoryShelf({ sender: OWNER }, { repositoryId: SHELF_ID });
    expect(shelf).toMatchObject({ kind: "opened", library: { displayName: "Library" } });
    expect(JSON.stringify(shelf)).not.toContain("C:\\private\\repository");
    expect(calls).toEqual([
      "open-repository",
      `resolve:${PROJECT_ID}`,
      "document:C:\\private\\repository",
      `resolve:${SHELF_ID}`,
      "library:C:\\private\\repository",
    ]);
  });

  it("rejects wrong-kind, stale/guessed, and malformed handoffs before path resolution", async () => {
    let resolved = 0;
    let openedDocument = 0;
    let openedLibrary = 0;
    const handlers = createTestHandlers({
      resolveRepository: async (_owner, repositoryId) => {
        resolved += 1;
        return {
          kind: "resolved",
          canonicalRoot: "C:\\private\\repository",
          identity: {
            schemaVersion: 1,
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            kind: repositoryId === SHELF_ID ? "shelf" : "project",
            title: "Shelf",
            templateVersion: 1,
          },
        };
      },
      openDocument: async () => {
        openedDocument += 1;
        return { kind: "opened", document: { documentId: PROJECT_ID, displayName: "Document" }, manuscripts: [] };
      },
      openLibrary: async () => {
        openedLibrary += 1;
        return {
          kind: "opened",
          library: { libraryId: PROJECT_ID, displayName: "Library" },
          recordCount: 0,
          issueCount: 0,
        };
      },
    });

    expect(await handlers.openRepositoryDocument({ sender: OWNER }, { repositoryId: SHELF_ID }))
      .toMatchObject({ kind: "error", code: "wrong-repository-kind" });
    expect(await handlers.useRepositoryShelf({ sender: OWNER }, { repositoryId: PROJECT_ID }))
      .toMatchObject({ kind: "error", code: "wrong-repository-kind" });
    expect(openedDocument).toBe(0);
    expect(openedLibrary).toBe(0);

    expect(await handlers.openRepositoryDocument(
      { sender: OWNER },
      { repositoryId: "../../outside", path: "C:\\outside" },
    )).toMatchObject({ kind: "error", code: "invalid-request" });
    expect(resolved).toBe(2);

    const stale = createTestHandlers({
      resolveRepository: async () => ({ kind: "error", code: "repository-not-owned", message: "not owned" }),
    });
    expect(await stale.openRepositoryDocument({ sender: OWNER }, { repositoryId: PROJECT_ID }))
      .toMatchObject({ kind: "error", code: "repository-not-owned" });
  });

  it("sanitizes thrown handoff failures", async () => {
    const handlers = createTestHandlers({
      resolveRepository: async () => {
        throw new Error("stack C:\\private\\repository");
      },
    });
    const result = await handlers.openRepositoryDocument({ sender: OWNER }, { repositoryId: PROJECT_ID });
    expect(result).toMatchObject({ kind: "error", code: "repository-handoff-failed" });
    expect(JSON.stringify(result)).not.toContain("stack");
    expect(JSON.stringify(result)).not.toContain("C:\\private\\repository");
  });

  it("maps exact History requests without accepting OIDs, limits, or paths", async () => {
    const calls: Array<[string, string]> = [];
    const handlers = createTestHandlers({
      createHistory: async (_owner, repositoryId) => {
        calls.push(["create", repositoryId]);
        return {
          kind: "snapshot",
          repositoryId,
          created: true,
          latest: {
            historyId: "88888888-8888-4888-8888-888888888888",
            timestampMs: 1_700_000_000_000,
          },
        };
      },
      listHistory: async (_owner, repositoryId) => {
        calls.push(["list", repositoryId]);
        return { kind: "history", repositoryId, entries: [], truncated: false };
      },
    });

    const created = await handlers.createRepositoryHistory(
      { sender: OWNER },
      { repositoryId: PROJECT_ID },
    );
    expect(created).toMatchObject({ kind: "snapshot", created: true });
    const listed = await handlers.listRepositoryHistory(
      { sender: OWNER },
      { repositoryId: PROJECT_ID },
    );
    expect(listed).toMatchObject({ kind: "history", entries: [], truncated: false });
    expect(calls).toEqual([["create", PROJECT_ID], ["list", PROJECT_ID]]);

    for (const invalid of [
      { repositoryId: PROJECT_ID, oid: "a".repeat(40) },
      { repositoryId: PROJECT_ID, limit: 1 },
      { repositoryId: PROJECT_ID, path: "C:\\outside" },
      { repositoryId: "not-a-handle" },
    ]) {
      expect(await handlers.createRepositoryHistory({ sender: OWNER }, invalid))
        .toMatchObject({ kind: "error", code: "invalid-request" });
      expect(await handlers.listRepositoryHistory({ sender: OWNER }, invalid))
        .toMatchObject({ kind: "error", code: "invalid-request" });
    }
    expect(await handlers.createRepositoryHistory({ sender: OWNER }, { repositoryId: PROJECT_ID }, "extra"))
      .toMatchObject({ kind: "error", code: "invalid-request" });
  });

  it("opens a selected History copy through the native destination folder only", async () => {
    let call: unknown[] = [];
    const handlers = createTestHandlers({
      pickHistoryDestinationParent: async () => ({ canceled: false, filePaths: ["C:\\private\\copies"] }),
      openHistoryCopy: async (...args) => {
        call = [...args];
        return {
          kind: "opened",
          repository: { repositoryId: PROJECT_ID, kind: "project", title: "Copy", templateVersion: 1 },
        };
      },
    });
    const result = await handlers.openRepositoryHistory({ sender: OWNER }, {
      repositoryId: PROJECT_ID,
      historyId: "66666666-6666-4666-8666-666666666666",
    });
    expect(result).toMatchObject({ kind: "opened", repository: { title: "Copy" } });
    expect(call).toEqual([
      OWNER,
      PROJECT_ID,
      "66666666-6666-4666-8666-666666666666",
      "C:\\private\\copies",
    ]);
    expect(JSON.stringify(result)).not.toContain("C:\\private\\copies");

    const cancelled = createTestHandlers({
      pickHistoryDestinationParent: async () => ({ canceled: true, filePaths: [] }),
    });
    expect(await cancelled.openRepositoryHistory({ sender: OWNER }, {
      repositoryId: PROJECT_ID,
      historyId: "66666666-6666-4666-8666-666666666666",
    })).toEqual({ kind: "cancelled" });

    for (const invalid of [
      { repositoryId: PROJECT_ID, historyId: "66666666-6666-4666-8666-666666666666", path: "C:\\outside" },
      { repositoryId: PROJECT_ID, historyId: "not-a-history-id" },
      { repositoryId: PROJECT_ID, historyId: "66666666-6666-4666-8666-666666666666", oid: "a".repeat(40) },
    ]) {
      expect(await handlers.openRepositoryHistory({ sender: OWNER }, invalid))
        .toMatchObject({ kind: "error", code: "invalid-request" });
    }
    expect(await handlers.openRepositoryHistory(
      { sender: OWNER },
      { repositoryId: PROJECT_ID, historyId: "66666666-6666-4666-8666-666666666666" },
      "extra",
    )).toMatchObject({ kind: "error", code: "invalid-request" });

    const dialogFailure = createTestHandlers({
      pickHistoryDestinationParent: async () => {
        throw new Error("raw C:\\secret");
      },
    });
    const failed = await dialogFailure.openRepositoryHistory({ sender: OWNER }, {
      repositoryId: PROJECT_ID,
      historyId: "66666666-6666-4666-8666-666666666666",
    });
    expect(failed).toMatchObject({ kind: "error", code: "history-destination-folder-dialog-failed" });
    expect(JSON.stringify(failed)).not.toContain("C:\\secret");
  });

  it("exports semantic channels without widening the preload contract", () => {
    expect([
      CREATE_REPOSITORY_CHANNEL,
      OPEN_REPOSITORY_CHANNEL,
      OPEN_REPOSITORY_HISTORY_CHANNEL,
      OPEN_REPOSITORY_DOCUMENT_CHANNEL,
      USE_REPOSITORY_SHELF_CHANNEL,
      CREATE_REPOSITORY_HISTORY_CHANNEL,
      LIST_REPOSITORY_HISTORY_CHANNEL,
    ]).toEqual([
      "maginalia:create-repository",
      "maginalia:open-repository",
      "maginalia:open-repository-history",
      "maginalia:open-repository-document",
      "maginalia:use-repository-shelf",
      "maginalia:create-repository-history",
      "maginalia:list-repository-history",
    ]);
  });
});
