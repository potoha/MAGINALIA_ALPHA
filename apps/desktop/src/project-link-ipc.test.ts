import { describe, expect, it, vi } from "vitest";
import { createProjectLinkHandlers, validateOpenExternalUrl } from "./project-link-ipc";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const FILE = "22222222-2222-4222-8222-222222222222";

describe("Project link IPC", () => {
  it("does not expose paths and rejects arbitrary external protocols", async () => {
    const openExternal = vi.fn(async () => undefined);
    const handlers = createProjectLinkHandlers({
      resolveInternalLink: async () => ({ kind: "resolved", fileId: FILE, displayName: "notes/eco.md" }),
      openInternalLink: async () => ({ kind: "error", code: "manuscript-unavailable", message: "missing" }),
      openExternal
    });
    await expect(handlers.resolveInternalLink({ sender: {} }, { projectId: PROJECT, target: "notes/eco.md" })).resolves.toEqual({ kind: "resolved", fileId: FILE, displayName: "notes/eco.md" });
    await expect(handlers.openExternalLink({ sender: {} }, { url: "javascript:alert(1)" })).resolves.toMatchObject({ kind: "error", code: "invalid-url" });
    await handlers.openExternalLink({ sender: {} }, { url: "https://example.test/a" });
    expect(openExternal).toHaveBeenCalledWith("https://example.test/a");
    expect(validateOpenExternalUrl("file:///C:/secret")).toBeNull();
  });
});
