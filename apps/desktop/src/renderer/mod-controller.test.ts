import { describe, expect, it, vi } from "vitest";
import { ModController, type ModControllerState } from "./mod-controller";
import type { WritingController } from "./controller";
import type { ModSnapshotResult } from "../mod-ipc";

function writingStub(options: {
  readonly document?: { readonly documentId: string; readonly displayName: string };
  readonly views?: readonly { readonly documentId: string; readonly region: "main" | "secondary" }[];
} = {}): WritingController {
  return {
    getDocumentState: () => options.document ?? null,
    getDocumentViews: () => options.views ?? [],
    getSessionStore: () => ({ getSession: (documentId: string) =>
      (options.document?.documentId === documentId ? options.document : null) })
  } as unknown as WritingController;
}

function makeController(writing: WritingController) {
  let state: ModControllerState | undefined;
  const view = { setModState: (next: ModControllerState) => { state = next; } };
  const emptySnapshot: ModSnapshotResult = { mods: [], contributions: [] };
  const api = {
    loadMods: vi.fn(async () => emptySnapshot),
    reloadMods: vi.fn(async () => emptySnapshot),
    openModsFolder: vi.fn(async () => ({ kind: "opened" as const })),
    invokeModCommand: vi.fn(async (): Promise<{ kind: "result"; value: unknown }> => ({ kind: "result", value: null })),
    onModCapabilityRequest: vi.fn(() => () => undefined)
  };
  return { controller: new ModController({ api, writing, view }), api, getState: () => state };
}

describe("ModController", () => {
  it("rejects a secondary placement when the document is already central", async () => {
    const { controller } = makeController(writingStub({
      document: { documentId: "doc-a", displayName: "a.md" },
      views: [{ documentId: "doc-a", region: "main" }]
    }));

    await expect(controller.handleCapability({
      modId: "dev.maginalia.secondary-markdown",
      kind: "open-document-view",
      requestId: "request-1",
      value: {
        documentId: "doc-a",
        viewType: "markdown",
        region: "secondary",
        groupId: "sidebar-group-1"
      }
    })).resolves.toEqual({
      kind: "error",
      message: "This Markdown is already open in the central editor. A second pane is deferred."
    });
  });

  it("keeps the core usable when no document is active", async () => {
    const { controller } = makeController(writingStub());
    await expect(controller.handleCapability({
      modId: "dev.maginalia.secondary-markdown",
      kind: "get-active-document",
      requestId: "request-2",
      value: null
    })).resolves.toEqual({ kind: "error", message: "Open a Markdown document before using this Mod." });
  });

  it("removes command contributions after a reload without touching writing state", async () => {
    const { controller, api, getState } = makeController(writingStub());
    api.reloadMods.mockResolvedValueOnce({
      mods: [{ directoryName: "secondary", id: "dev.maginalia.secondary-markdown", name: "Secondary Markdown", version: "0.1.0", state: "active" }],
      contributions: [{
        modId: "dev.maginalia.secondary-markdown",
        contribution: { kind: "command", id: "open-active-document-in-secondary", title: "Open" }
      }]
    } satisfies ModSnapshotResult);
    api.reloadMods.mockResolvedValueOnce({ mods: [], contributions: [] });
    await controller.reload();
    expect(getState()?.snapshot.contributions).toHaveLength(1);
    await controller.reload();
    expect(getState()?.snapshot.contributions).toEqual([]);
  });

  it("surfaces a declarative command refusal from the Mod worker", async () => {
    const { controller, api, getState } = makeController(writingStub({
      document: { documentId: "doc-a", displayName: "a.md" },
      views: [{ documentId: "doc-a", region: "main" }]
    }));
    api.invokeModCommand.mockResolvedValueOnce({
      kind: "result" as const,
      value: {
        kind: "error",
        message: "This Markdown is already open in the central editor. A second pane is deferred."
      }
    });

    await controller.invoke("dev.maginalia.secondary-markdown", "open-active-document-in-secondary");

    expect(getState()?.message).toContain("A second pane is deferred");
  });
});
