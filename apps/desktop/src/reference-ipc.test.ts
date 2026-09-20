import { describe, expect, it, vi } from "vitest";
import {
  createReferenceHandlers,
  isResolveReferencesRequest,
  MAX_REFERENCE_RESOLUTION_TEXT_CHARS
} from "./reference-ipc";

describe("reference refresh IPC boundary", () => {
  it("accepts document text only and rejects renderer URL or DB path", () => {
    expect(isResolveReferencesRequest({ text: "# memo" })).toBe(true);
    expect(isResolveReferencesRequest({ text: "# memo", url: "file:///db" })).toBe(false);
    expect(isResolveReferencesRequest({ text: "# memo", dbPath: "C:\\secret" })).toBe(false);
    expect(isResolveReferencesRequest({ text: "x".repeat(MAX_REFERENCE_RESOLUTION_TEXT_CHARS + 1) })).toBe(false);
  });

  it("passes only text to the main-process resolver", async () => {
    const resolve = vi.fn(async (text: string) => ({
      kind: "resolved" as const,
      sources: [],
      resolved: [],
      unresolved: text.length === 0 ? [] : []
    }));
    const handlers = createReferenceHandlers({ resolve });
    await expect(handlers.resolveReferences({ sender: {} }, { text: "doc" })).resolves.toMatchObject({
      kind: "resolved"
    });
    expect(resolve).toHaveBeenCalledWith("doc");
    await expect(handlers.resolveReferences(
      { sender: {} },
      { text: "doc", url: "https://attacker.invalid" }
    )).resolves.toMatchObject({ kind: "error", code: "invalid-request" });
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
