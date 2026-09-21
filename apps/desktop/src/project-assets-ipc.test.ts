import { describe, expect, it, vi } from "vitest";
import { createProjectAssetHandlers } from "./project-assets-ipc";

const PROJECT = "11111111-1111-4111-8111-111111111111";

describe("Project asset IPC", () => {
  it("accepts only bounded request shapes and never leaks a filesystem path", async () => {
    const resolve = vi.fn(async () => ({
      kind: "resolved" as const,
      assetKind: "image" as const,
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,AA=="
    }));
    const handlers = createProjectAssetHandlers({
      resolve,
      importDroppedImage: async () => ({ kind: "error" as const, code: "unsupported" as const, message: "unsupported" })
    });
    const event = { sender: {} };
    await expect(handlers.resolveAsset(event, { projectId: PROJECT, relativePath: "assets/figure.png" }))
      .resolves.toMatchObject({ kind: "resolved", dataUrl: "data:image/png;base64,AA==" });
    expect(resolve).toHaveBeenCalledWith(event.sender, PROJECT, "assets/figure.png");
    await expect(handlers.resolveAsset(event, { projectId: PROJECT, relativePath: "assets/figure.png", extra: true }))
      .resolves.toMatchObject({ kind: "error", code: "invalid-request" });
    await expect(handlers.resolveAsset(event, { projectId: "not-an-id", relativePath: "assets/figure.png" }))
      .resolves.toMatchObject({ kind: "error", code: "invalid-request" });
  });
});
