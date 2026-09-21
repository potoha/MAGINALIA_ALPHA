import { describe, expect, it, vi } from "vitest";
import { importDroppedImageIntoDocument } from "./dropped-image";

const target = {
  documentId: "11111111-1111-4111-8111-111111111111" as never,
  revision: 3,
  range: { start: 2, end: 2 }
};

describe("dropped image insertion", () => {
  it("inserts only a successful Project-relative asset reference", async () => {
    const insertMarkdownText = vi.fn(() => true);
    const result = await importDroppedImageIntoDocument({
      writing: { captureInsertionTarget: () => target, isInsertionTargetCurrent: () => true, insertMarkdownText },
      importImage: async () => ({ kind: "imported", relativePath: "assets/figure.webp", mimeType: "image/webp" })
    });
    expect(result).toEqual({ kind: "inserted", relativePath: "assets/figure.webp" });
    expect(insertMarkdownText).toHaveBeenCalledWith(target, "![[assets/figure.webp]]");
  });

  it("does not edit the document when import fails or the captured target becomes stale", async () => {
    const insertMarkdownText = vi.fn(() => true);
    const failed = await importDroppedImageIntoDocument({
      writing: { captureInsertionTarget: () => target, isInsertionTargetCurrent: () => true, insertMarkdownText },
      importImage: async () => ({ kind: "error", code: "unsupported", message: "bad image" })
    });
    const stale = await importDroppedImageIntoDocument({
      writing: { captureInsertionTarget: () => target, isInsertionTargetCurrent: () => false, insertMarkdownText },
      importImage: async () => ({ kind: "imported", relativePath: "assets/figure.webp", mimeType: "image/webp" })
    });
    expect(failed.kind).toBe("error");
    expect(stale.kind).toBe("error");
    expect(insertMarkdownText).not.toHaveBeenCalled();
  });
});
