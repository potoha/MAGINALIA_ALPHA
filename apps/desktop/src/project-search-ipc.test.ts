import { describe, expect, it, vi } from "vitest";
import { createProjectSearchHandlers } from "./project-search-ipc";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

describe("Project search IPC", () => {
  it("only accepts an opaque current Project id and literal query", async () => {
    const search = vi.fn(async () => ({ kind: "results" as const, results: [], total: 0 }));
    const handlers = createProjectSearchHandlers({ searchProjectMarkdown: search });
    await expect(handlers.searchProjectMarkdown({ sender: {} }, { projectId: PROJECT_ID, query: "日本語" }))
      .resolves.toMatchObject({ kind: "results" });
    expect(search).toHaveBeenCalledWith(expect.any(Object), PROJECT_ID, "日本語");
    await expect(handlers.searchProjectMarkdown({ sender: {} }, { projectId: "C:\\outside", query: "x" }))
      .resolves.toMatchObject({ kind: "error", code: "invalid-request" });
  });
});
