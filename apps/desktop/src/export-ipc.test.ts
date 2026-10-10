import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import sharp from "sharp";
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
import { DocumentWorkspaceService } from "./document-workspace";
import { ProjectAssetService } from "./project-assets";
import { createExportPresentationSettings, type ExportPresentationSettings } from "./export-presentation-settings";

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
    const exportedText = "# exported\n![[assets/図.png]]\n";
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
      text: exportedText
    })).resolves.toEqual({ kind: "exported", fileName: "draft.resolved.md" });
    expect(await readFile(output, "utf8")).toBe(exportedText);
    expect(await readFile(source, "utf8")).toBe("# disk\n");
  });

  it("routes PDF output through the injected Vivliostyle adapter and keeps source untouched", async () => {
    const { root, source, service } = await fixture("# 日本語\n");
    const sessionId = await open(service, source, "# 日本語\n");
    const output = path.join(root, "draft.resolved.pdf");
    const selectedSettings = createExportPresentationSettings({
      paperSize: "A5",
      orientation: "landscape",
      header: { left: "左", center: "中央", right: "右" },
      pageNumber: false
    });
    const writePdf = vi.fn(async (
      outputPath: string,
      document: { readonly kind: string; readonly blocks: readonly { readonly kind: string; readonly markdown: string }[] },
      settings: ExportPresentationSettings
    ) => {
      expect(document.kind).toBe("export-document");
      expect(document.blocks.some((block) => block.kind === "heading" && block.markdown.includes("日本語"))).toBe(true);
      expect(settings).toEqual(selectedSettings);
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
      settings: selectedSettings
    })).resolves.toEqual({ kind: "exported", fileName: "draft.resolved.pdf" });
    expect(writePdf).toHaveBeenCalledOnce();
    expect((await readFile(output)).toString("ascii")).toContain("%PDF-1.7");
    expect(await readFile(source, "utf8")).toBe("# 日本語\n");
  });

  it("routes DOCX output through the injected Pandoc adapter and keeps source untouched", async () => {
    const { root, source, service } = await fixture("# 日本語\n");
    const sessionId = await open(service, source, "# 日本語\n");
    const output = path.join(root, "draft.resolved.docx");
    const selectedSettings = createExportPresentationSettings({
      paperSize: "B4",
      orientation: "landscape",
      paragraphIndent: false,
      header: { left: "左", center: "中央", right: "右" },
      pageNumber: false
    });
    const writeDocx = vi.fn(async (
      outputPath: string,
      document: { readonly kind: string; readonly blocks: readonly { readonly kind: string; readonly markdown: string }[] },
      settings: ExportPresentationSettings
    ) => {
      expect(document.kind).toBe("export-document");
      expect(document.blocks.some((block) => block.kind === "heading" && block.markdown.includes("日本語"))).toBe(true);
      expect(settings).toEqual(selectedSettings);
      await writeFile(outputPath, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("pandoc fixture")]));
    });
    const handlers = createExportHandlers({
      sessions: service,
      resolve: async () => resolution,
      showSaveDialog: async (defaultPath, _event, format) => {
        expect(defaultPath).toBe(output);
        expect(format).toBe("docx");
        return { canceled: false, filePath: output };
      },
      writeDocx
    });
    const prepared = await resolve(handlers, sessionId, "# 日本語\n");
    await expect(handlers.writeExport(event, {
      exportId: prepared.exportId,
      documentId: sessionId,
      revision: prepared.revision,
      text: "# 日本語\n",
      format: "docx",
      settings: selectedSettings
    })).resolves.toEqual({ kind: "exported", fileName: "draft.resolved.docx" });
    expect(writeDocx).toHaveBeenCalledOnce();
    expect((await readFile(output)).subarray(0, 2).toString("ascii")).toBe("PK");
    expect(await readFile(source, "utf8")).toBe("# 日本語\n");
  });

  it("resolves a Project image through ProjectAssetService and gives only that snapshot to PDF output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "maginalia-export-project-image-日本語-"));
    temporaryRoots.push(root);
    const projectRoot = path.join(root, "卒論 Project");
    const assetsRoot = path.join(projectRoot, "assets");
    await mkdir(assetsRoot, { recursive: true });
    const source = path.join(projectRoot, "draft.md");
    const sourceText = "# Draft\n";
    await writeFile(source, sourceText, "utf8");
    await sharp({ create: { width: 8, height: 5, channels: 4, background: "#d9e24f" } })
      .png().toFile(path.join(assetsRoot, "図 1.png"));

    const workspace = new DocumentWorkspaceService();
    const openedProject = await workspace.openForOwner(owner, projectRoot);
    expect(openedProject.kind).toBe("opened");
    if (openedProject.kind !== "opened") return;
    const markdown = new MarkdownFileService();
    const session = await markdown.openForOwner(owner, source, openedProject.document.documentId);
    expect(session.kind).toBe("opened");
    if (session.kind !== "opened") return;
    const output = path.join(root, "draft.resolved.pdf");
    const writePdf = vi.fn(async (
      outputPath: string,
      _document: { readonly kind: string },
      _settings: ExportPresentationSettings,
      images: ReadonlyMap<string, { readonly mimeType: string; readonly dataUrl: string }>
    ) => {
      expect(images.get("assets/図 1.png")).toMatchObject({ mimeType: "image/png" });
      expect(images.get("assets/図 1.png")?.dataUrl).toMatch(/^data:image\/png;base64,/u);
      await writeFile(outputPath, Buffer.from("%PDF-1.7\nfixture", "ascii"));
    });
    const handlers = createExportHandlers({
      sessions: markdown,
      resolve: async () => resolution,
      resolveProjectAsset: (requestOwner, projectId, relativePath) =>
        new ProjectAssetService(workspace).resolveForOwner(requestOwner, projectId, relativePath),
      showSaveDialog: async () => ({ canceled: false, filePath: output }),
      writePdf
    });
    const prepared = await resolve(handlers, session.sessionId, "# Draft\n\n![[assets/図 1.png]]\n");
    await expect(handlers.writeExport(event, {
      exportId: prepared.exportId,
      documentId: session.sessionId,
      revision: prepared.revision,
      text: "# Draft\n\n![[assets/図 1.png]]\n",
      format: "pdf",
      settings: createExportPresentationSettings()
    })).resolves.toEqual({ kind: "exported", fileName: "draft.resolved.pdf" });
    expect(writePdf).toHaveBeenCalledOnce();
    expect(await readFile(source, "utf8")).toBe(sourceText);
  });

  it("keeps packaged DOCX failures understandable without exposing runtime details", async () => {
    const { root, source, service } = await fixture("# 日本語\n");
    const sessionId = await open(service, source, "# 日本語\n");
    const output = path.join(root, "draft.resolved.docx");
    const handlers = createExportHandlers({
      sessions: service,
      resolve: async () => resolution,
      showSaveDialog: async () => ({ canceled: false, filePath: output }),
      writeDocx: async () => { throw new Error("Pandoc process failed"); },
    });
    const prepared = await resolve(handlers, sessionId, "# 日本語\n");
    const result = await handlers.writeExport(event, {
      exportId: prepared.exportId,
      documentId: sessionId,
      revision: prepared.revision,
      text: "# 日本語\n",
      format: "docx",
      settings: createExportPresentationSettings(),
    });

    expect(result).toEqual({
      kind: "error",
      code: "write-failed",
      message: "DOCXを書き出せませんでした。保存先を確認して、もう一度お試しください。",
    });
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
