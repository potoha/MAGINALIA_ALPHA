import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createExportHandlers,
  isResolveExportRequest,
  isWriteExportRequest,
  type ExportInvokeEvent,
  type ResolveExportSuccess,
  type WriteExportRequest
} from "./export-ipc";
import { MarkdownFileService } from "./markdown-file-service";
import { DEFAULT_EXPORT_PRESENTATION_SETTINGS } from "./export-presentation-settings";

const owner = {};
const otherOwner = {};
const event: ExportInvokeEvent = { sender: owner };
const resolution = {
  kind: "resolved" as const,
  sources: [],
  resolved: [],
  unresolved: []
};

const temporaryRoots: string[] = [];

async function fixture(contents = "# disk\n"): Promise<{ root: string; source: string; service: MarkdownFileService }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "maginalia-export-"));
  temporaryRoots.push(root);
  const source = path.join(root, "draft.md");
  await writeFile(source, contents, "utf8");
  return { root, source, service: new MarkdownFileService() };
}

async function open(
  service: MarkdownFileService,
  source: string,
  text = "# disk\n"
): Promise<string> {
  const opened = await service.openForOwner(owner, source);
  expect(opened.kind).toBe("opened");
  if (opened.kind !== "opened") throw new Error("fixture could not open");
  expect(opened.text).toBe(text);
  return opened.sessionId;
}

function resolveRequest(documentId: string, text: string, revision = 1) {
  return { documentId, revision, currentText: text };
}

async function resolve(
  handlers: ReturnType<typeof createExportHandlers>,
  documentId: string,
  text = "# dirty\n",
  revision = 2
): Promise<ResolveExportSuccess> {
  const result = await handlers.resolveExport(event, resolveRequest(documentId, text, revision));
  expect(result.kind).toBe("resolved");
  if (result.kind !== "resolved") throw new Error("export resolution failed");
  return result;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("resolved Markdown export IPC boundary", () => {
  it("accepts only semantic snapshot/write data and rejects renderer paths", () => {
    expect(isResolveExportRequest({ documentId: "session", revision: 1, currentText: "draft" })).toBe(true);
    expect(isResolveExportRequest({ documentId: "session", revision: 1, currentText: "draft", path: "C:\\secret" })).toBe(false);
    expect(isWriteExportRequest({ exportId: "opaque", documentId: "session", revision: 1, text: "export" })).toBe(true);
    expect(isWriteExportRequest({ exportId: "opaque", documentId: "session", revision: 1, text: "export", path: "C:\\secret" })).toBe(false);
  });

  it("validates session ownership before resolving", async () => {
    const { source, service } = await fixture();
    const opened = await service.openForOwner(owner, source);
    expect(opened.kind).toBe("opened");
    if (opened.kind !== "opened") return;
    const resolveSpy = vi.fn(async (_owner: object, _text: string) => resolution);
    const handlers = createExportHandlers({
      sessions: service,
      resolve: resolveSpy,
      showSaveDialog: async () => ({ canceled: true })
    });

    await expect(handlers.resolveExport({ sender: otherOwner }, resolveRequest(opened.sessionId, "dirty")))
      .resolves.toMatchObject({ kind: "error", code: "session-not-owned" });
    expect(resolveSpy).not.toHaveBeenCalled();
    await expect(handlers.resolveExport(event, {
      ...resolveRequest(opened.sessionId, "dirty"),
      path: "C:\\secret"
    })).resolves.toMatchObject({ kind: "error", code: "invalid-request" });
  });

  it("returns a transaction snapshot without mutating the authoring file", async () => {
    const { source, service } = await fixture();
    const sessionId = await open(service, source);
    let resolvedText = "";
    const resolveSpy = vi.fn(async (_owner: object, text: string) => {
      resolvedText = text;
      return resolution;
    });
    const handlers = createExportHandlers({
      sessions: service,
      resolve: resolveSpy,
      showSaveDialog: async () => ({ canceled: true })
    });
    const result = await resolve(handlers, sessionId, "# dirty\n", 9);
    expect(resolvedText).toBe("# dirty\n");
    expect(resolveSpy).toHaveBeenCalledWith(owner, "# dirty\n");
    expect(result).toMatchObject({
      kind: "resolved",
      documentId: sessionId,
      revision: 9,
      resolution
    });
    expect(await readFile(source, "utf8")).toBe("# disk\n");
  });

  it("treats dialog cancellation as a no-op", async () => {
    const { source, service } = await fixture();
    const sessionId = await open(service, source);
    const handlers = createExportHandlers({
      sessions: service,
      resolve: async () => resolution,
      showSaveDialog: async () => ({ canceled: true })
    });
    const prepared = await resolve(handlers, sessionId);
    await expect(handlers.writeExport(event, {
      exportId: prepared.exportId,
      documentId: sessionId,
      revision: prepared.revision,
      text: "# exported\n"
    })).resolves.toEqual({ kind: "cancelled" });
    expect(await readFile(source, "utf8")).toBe("# disk\n");
  });

  it("writes an ordinary Markdown output atomically and leaves source untouched", async () => {
    const { root, source, service } = await fixture();
    const sessionId = await open(service, source);
    const output = path.join(root, "draft.resolved.md");
    const handlers = createExportHandlers({
      sessions: service,
      resolve: async () => resolution,
      showSaveDialog: async (defaultPath) => {
        expect(defaultPath).toBe(output);
        return { canceled: false, filePath: output };
      }
    });
    const prepared = await resolve(handlers, sessionId);
    await expect(handlers.writeExport(event, {
      exportId: prepared.exportId,
      documentId: sessionId,
      revision: prepared.revision,
      text: "# exported\n"
    })).resolves.toEqual({ kind: "exported", fileName: "draft.resolved.md" });
    expect(await readFile(output, "utf8")).toBe("# exported\n");
    expect(await readFile(source, "utf8")).toBe("# disk\n");
  });

  it("routes PDF output through the injected Vivliostyle adapter and keeps source untouched", async () => {
    const { root, source, service } = await fixture("# 日本語\n");
    const sessionId = await open(service, source, "# 日本語\n");
    const output = path.join(root, "draft.resolved.pdf");
    const writePdf = vi.fn(async (outputPath: string, document: { readonly kind: string; readonly blocks: readonly { readonly kind: string; readonly markdown: string }[] }) => {
      expect(document.kind).toBe("export-document");
      expect(document.blocks.some((block) => block.kind === "heading" && block.markdown.includes("日本語"))).toBe(true);
      await writeFile(outputPath, Buffer.from("%PDF-1.7\n", "ascii"));
    });
    const handlers = createExportHandlers({
      sessions: service,
      resolve: async () => resolution,
      showSaveDialog: async (defaultPath, _event, format) => {
        expect(defaultPath).toBe(output);
        expect(format).toBe("pdf");
        return { canceled: false, filePath: output };
      },
      writePdf
    });
    const prepared = await resolve(handlers, sessionId, "# 日本語\n");
    await expect(handlers.writeExport(event, {
      exportId: prepared.exportId,
      documentId: sessionId,
      revision: prepared.revision,
      text: "# 日本語\n",
      format: "pdf",
      settings: DEFAULT_EXPORT_PRESENTATION_SETTINGS
    })).resolves.toEqual({ kind: "exported", fileName: "draft.resolved.pdf" });
    expect(writePdf).toHaveBeenCalledOnce();
    expect((await readFile(output)).toString("ascii")).toContain("%PDF-1.7");
    expect(await readFile(source, "utf8")).toBe("# 日本語\n");
  });

  it("rejects exact source overwrite and stale or cross-owner transactions", async () => {
    const { source, service } = await fixture();
    const sessionId = await open(service, source);
    const handlers = createExportHandlers({
      sessions: service,
      resolve: async () => resolution,
      showSaveDialog: async () => ({ canceled: false, filePath: source })
    });
    const prepared = await resolve(handlers, sessionId);
    const request: WriteExportRequest = {
      exportId: prepared.exportId,
      documentId: sessionId,
      revision: prepared.revision,
      text: "# exported\n"
    };
    await expect(handlers.writeExport(event, request)).resolves.toMatchObject({
      kind: "error",
      code: "source-overwrite"
    });
    await expect(handlers.writeExport({ sender: otherOwner }, request)).resolves.toMatchObject({
      kind: "error",
      code: "stale-export"
    });
    await expect(handlers.writeExport(event, { ...request, exportId: "guessed" })).resolves.toMatchObject({
      kind: "error",
      code: "stale-export"
    });
    expect(await readFile(source, "utf8")).toBe("# disk\n");
  });

  it("keeps the transaction tied to the captured revision while writing the rendered snapshot", async () => {
    const { root, source, service } = await fixture();
    const sessionId = await open(service, source);
    const output = path.join(root, "snapshot.md");
    const handlers = createExportHandlers({
      sessions: service,
      resolve: async () => resolution,
      showSaveDialog: async () => ({ canceled: false, filePath: output })
    });
    const prepared = await resolve(handlers, sessionId, "dirty at revision 12", 12);
    await writeFile(source, "changed on disk after click\n", "utf8");
    await expect(handlers.writeExport(event, {
      exportId: prepared.exportId,
      documentId: sessionId,
      revision: 12,
      text: "rendered from revision 12\n"
    })).resolves.toEqual({ kind: "exported", fileName: "snapshot.md" });
    expect(await readFile(output, "utf8")).toBe("rendered from revision 12\n");
  });

  it("surfaces invalid destinations and write failures", async () => {
    const { root, source, service } = await fixture();
    const sessionId = await open(service, source);
    const handlers = createExportHandlers({
      sessions: service,
      resolve: async () => resolution,
      showSaveDialog: async (_defaultPath) => ({ canceled: false, filePath: path.join(root, "no", "output.txt") })
    });
    const prepared = await resolve(handlers, sessionId);
    await expect(handlers.writeExport(event, {
      exportId: prepared.exportId,
      documentId: sessionId,
      revision: prepared.revision,
      text: "export"
    })).resolves.toMatchObject({ kind: "error", code: "invalid-output" });

    const failingHandlers = createExportHandlers({
      sessions: service,
      resolve: async () => resolution,
      showSaveDialog: async () => ({ canceled: false, filePath: path.join(root, "missing", "output.md") })
    });
    const failingPrepared = await resolve(failingHandlers, sessionId);
    await expect(failingHandlers.writeExport(event, {
      exportId: failingPrepared.exportId,
      documentId: sessionId,
      revision: failingPrepared.revision,
      text: "export"
    })).resolves.toMatchObject({ kind: "error", code: "write-failed" });
  });
});
