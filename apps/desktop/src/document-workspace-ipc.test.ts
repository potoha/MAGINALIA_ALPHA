import { mkdtemp, mkdir, realpath, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDocumentWorkspaceHandlers,
  isOpenManuscriptRequest,
  type DocumentWorkspaceHandlers
} from "./document-workspace-ipc";
import { DocumentWorkspaceService, type DocumentWorkspaceOpened } from "./document-workspace";
import { MarkdownFileService } from "./markdown-file-service";
import type { OpenMarkdownSuccess } from "./markdown-ipc";

async function withTempDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "maginalia-document-ipc-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function openedDocument(result: Awaited<ReturnType<DocumentWorkspaceHandlers["openDocument"]>>): DocumentWorkspaceOpened {
  expect(result.kind).toBe("opened");
  if (result.kind !== "opened") throw new Error("Expected a Document to open");
  return result;
}

function openedMarkdown(result: Awaited<ReturnType<DocumentWorkspaceHandlers["openManuscript"]>>): OpenMarkdownSuccess {
  expect(result.kind).toBe("opened");
  if (result.kind !== "opened") throw new Error("Expected a Markdown manuscript to open");
  return result;
}

describe("Document workspace IPC boundary", () => {
  it("accepts only two opaque IDs and rejects paths or extra request fields", () => {
    const valid = {
      documentId: "00000000-0000-4000-8000-000000000000",
      manuscriptId: "11111111-1111-4111-8111-111111111111"
    };
    expect(isOpenManuscriptRequest(valid)).toBe(true);
    expect(isOpenManuscriptRequest({ ...valid, path: "C:\\outside.md" })).toBe(false);
    expect(isOpenManuscriptRequest({ ...valid, extra: true })).toBe(false);
    expect(isOpenManuscriptRequest({ ...valid, documentId: "../../outside" })).toBe(false);
    expect(isOpenManuscriptRequest({ ...valid, manuscriptId: "" })).toBe(false);
    expect(isOpenManuscriptRequest({ documentId: valid.documentId })).toBe(false);
    expect(isOpenManuscriptRequest(null)).toBe(false);
    expect(isOpenManuscriptRequest([valid])).toBe(false);
  });

  it("returns typed cancellation and rejects unexpected openDocument arguments", async () => {
    let picked = 0;
    const handlers = createDocumentWorkspaceHandlers({
      pickDocumentFolder: async () => {
        picked += 1;
        return { canceled: true, filePaths: [] };
      },
      openDocumentRoot: async () => ({
        kind: "error",
        code: "root-unreadable",
        message: "unused"
      }),
      resolveManuscriptPath: async () => ({
        kind: "error",
        code: "manuscript-unavailable",
        message: "unused"
      }),
      openMarkdown: async () => ({ kind: "cancelled" })
    });
    const event = { sender: {} };

    expect(await handlers.openDocument(event)).toEqual({ kind: "cancelled" });
    expect(picked).toBe(1);
    expect(await handlers.openDocument(event, { path: "C:\\outside" })).toMatchObject({
      kind: "error",
      code: "invalid-request"
    });
    expect(picked).toBe(1);
  });

  it("opens a selected manuscript through the workspace and Markdown services without exposing a path", async () => {
    await withTempDirectory(async (directory) => {
      const root = path.join(directory, "document");
      const manuscriptPath = path.join(root, "notes.md");
      const text = "\uFEFF# 日本語\r\n本文\r\n";
      await mkdir(root);
      await writeFile(manuscriptPath, Buffer.from(text, "utf8"));

      const owner = {};
      const workspace = new DocumentWorkspaceService();
      const markdown = new MarkdownFileService();
      let resolvedPath: string | undefined;
      const handlers = createDocumentWorkspaceHandlers({
        pickDocumentFolder: async () => ({ canceled: false, filePaths: [root] }),
        openDocumentRoot: (requestOwner, rootPath) => workspace.openForOwner(requestOwner, rootPath),
        resolveManuscriptPath: async (requestOwner, documentId, manuscriptId) => {
          const result = await workspace.resolveManuscriptPath(requestOwner, documentId, manuscriptId);
          if (result.kind === "resolved") resolvedPath = result.canonicalPath;
          return result;
        },
        openMarkdown: (requestOwner, filePath) => markdown.openForOwner(requestOwner, filePath)
      });

      const document = openedDocument(await handlers.openDocument({ sender: owner }));
      expect(document.manuscripts.map((manuscript) => manuscript.displayName)).toEqual(["notes.md"]);
      expect(JSON.stringify(document)).not.toContain(root);

      const manuscript = openedMarkdown(await handlers.openManuscript(
        { sender: owner },
        {
          documentId: document.document.documentId,
          manuscriptId: document.manuscripts[0].manuscriptId
        }
      ));
      expect(manuscript.text).toBe(text);
      expect(JSON.stringify(manuscript)).not.toContain(root);
      expect(resolvedPath).toBe(await realpath(manuscriptPath));
      expect(await readFile(manuscriptPath, "utf8")).toBe(text);

      expect(await handlers.openManuscript(
        { sender: {} },
        {
          documentId: document.document.documentId,
          manuscriptId: document.manuscripts[0].manuscriptId
        }
      )).toMatchObject({ kind: "error", code: "document-not-owned" });

      workspace.dispose();
      markdown.dispose();
    });
  });

  it("does not resolve or open a path for an invalid manuscript request", async () => {
    let resolved = 0;
    let opened = 0;
    const handlers = createDocumentWorkspaceHandlers({
      pickDocumentFolder: async () => ({ canceled: true, filePaths: [] }),
      openDocumentRoot: async () => ({
        kind: "error",
        code: "root-unreadable",
        message: "unused"
      }),
      resolveManuscriptPath: async () => {
        resolved += 1;
        return { kind: "error", code: "manuscript-unavailable", message: "unused" };
      },
      openMarkdown: async () => {
        opened += 1;
        return { kind: "cancelled" };
      }
    });

    const result = await handlers.openManuscript(
      { sender: {} },
      {
        documentId: "00000000-0000-4000-8000-000000000000",
        manuscriptId: "../../outside",
        path: "C:\\outside.md"
      }
    );
    expect(result).toMatchObject({ kind: "error", code: "invalid-request" });
    expect(resolved).toBe(0);
    expect(opened).toBe(0);
  });
});
