import { describe, expect, it, vi } from "vitest";

import { createSyncedBlockHandlers } from "./synced-block-ipc";

const PROJECT = "11111111-1111-4111-8111-111111111111";

describe("Synced Block IPC", () => {
  it("passes only Project-relative requests and never exposes a canonical path", async () => {
    const resolve = vi.fn(async () => ({
      kind: "resolved" as const,
      target: "chapters/春.md",
      fileId: "22222222-2222-4222-8222-222222222222",
      displayName: "chapters/春.md",
      text: "# 春\n本文\n",
    }));
    const handlers = createSyncedBlockHandlers({ resolveSyncedBlockDocument: resolve });
    await expect(handlers.resolveSyncedBlockDocument({ sender: {} }, { projectId: PROJECT, target: "chapters/春.md" })).resolves.toEqual({
      kind: "resolved",
      target: "chapters/春.md",
      fileId: "22222222-2222-4222-8222-222222222222",
      displayName: "chapters/春.md",
      text: "# 春\n本文\n",
    });
    await expect(handlers.resolveSyncedBlockDocument({ sender: {} }, { projectId: PROJECT, target: "a.md", unexpected: true }))
      .resolves.toMatchObject({ kind: "error", code: "invalid-request" });
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
