import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { MarkdownFileService } from "./markdown-file-service";
import { MAX_MARKDOWN_BYTES, type OpenMarkdownSuccess } from "./markdown-ipc";

async function withTempDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "maginalia-markdown-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function opened(result: Awaited<ReturnType<MarkdownFileService["openForOwner"]>>): OpenMarkdownSuccess {
  expect(result.kind).toBe("opened");
  if (result.kind !== "opened") throw new Error("Expected Markdown file to open");
  return result;
}

describe("Markdown file service", () => {
  it("opens a Markdown session without returning the selected path", async () => {
    await withTempDirectory(async (directory) => {
      const filePath = path.join(directory, "notes.MARKDOWN");
      const text = "# Heading\r\n";
      await writeFile(filePath, Buffer.from(text, "utf8"));
      const owner = {};
      const service = new MarkdownFileService();
      const result = await service.openForOwner(owner, filePath);

      const metadata = opened(result);
      expect(metadata.displayName).toBe("notes.MARKDOWN");
      expect(metadata.text).toBe(text);
      expect(JSON.stringify(metadata)).not.toContain(filePath);
      expect(service.getSessionInfoForOwner(owner, metadata.sessionId)?.projectId).toBeUndefined();
    });
  });

  it("saves successfully and updates its baseline", async () => {
    await withTempDirectory(async (directory) => {
      const filePath = path.join(directory, "notes.md");
      await writeFile(filePath, "before", "utf8");
      const owner = {};
      const service = new MarkdownFileService();
      const session = opened(await service.openForOwner(owner, filePath));

      const result = await service.saveForOwner(owner, { sessionId: session.sessionId, text: "after" });

      expect(result).toMatchObject({ kind: "saved", sessionId: session.sessionId, text: "after" });
      expect(await readFile(filePath, "utf8")).toBe("after");
      const second = await service.saveForOwner(owner, { sessionId: session.sessionId, text: "after again" });
      expect(second.kind).toBe("saved");
    });
  });

  it("keeps concurrent owner sessions for separate files and reuses a session on re-open", async () => {
    await withTempDirectory(async (directory) => {
      const firstPath = path.join(directory, "first.md");
      const secondPath = path.join(directory, "second.md");
      await writeFile(firstPath, "first", "utf8");
      await writeFile(secondPath, "second", "utf8");
      const owner = {};
      const service = new MarkdownFileService();

      const first = opened(await service.openForOwner(owner, firstPath));
      const second = opened(await service.openForOwner(owner, secondPath));
      const firstAgain = opened(await service.openForOwner(owner, firstPath));

      expect(second.sessionId).not.toBe(first.sessionId);
      expect(firstAgain.sessionId).toBe(first.sessionId);
      expect(firstAgain.text).toBe("first");
      expect(await service.saveForOwner(owner, { sessionId: first.sessionId, text: "first edited" }))
        .toMatchObject({ kind: "saved", sessionId: first.sessionId });
      expect(await service.saveForOwner(owner, { sessionId: second.sessionId, text: "second edited" }))
        .toMatchObject({ kind: "saved", sessionId: second.sessionId });
    });
  });

  it("reports an external-change conflict without overwriting external bytes", async () => {
    await withTempDirectory(async (directory) => {
      const filePath = path.join(directory, "notes.md");
      await writeFile(filePath, "before", "utf8");
      const owner = {};
      const service = new MarkdownFileService();
      const session = opened(await service.openForOwner(owner, filePath));
      const external = Buffer.from("external\r\n", "utf8");
      await writeFile(filePath, external);

      const result = await service.saveForOwner(owner, { sessionId: session.sessionId, text: "local" });

      expect(result.kind).toBe("conflict");
      expect(await readFile(filePath)).toEqual(external);
    });
  });

  it("reports a missing-file failure without writing a replacement", async () => {
    await withTempDirectory(async (directory) => {
      const filePath = path.join(directory, "notes.md");
      await writeFile(filePath, "before", "utf8");
      const owner = {};
      const service = new MarkdownFileService();
      const session = opened(await service.openForOwner(owner, filePath));
      await rm(filePath);

      const result = await service.saveForOwner(owner, { sessionId: session.sessionId, text: "local" });

      expect(result).toMatchObject({ kind: "error", code: "missing-file" });
    });
  });

  it("rejects non-Markdown and oversized files/content", async () => {
    await withTempDirectory(async (directory) => {
      const service = new MarkdownFileService();
      const owner = {};
      const textFile = path.join(directory, "notes.txt");
      await writeFile(textFile, "plain", "utf8");
      expect(await service.openForOwner(owner, textFile)).toMatchObject({ kind: "error", code: "invalid-extension" });

      const largeFile = path.join(directory, "large.md");
      await writeFile(largeFile, Buffer.alloc(MAX_MARKDOWN_BYTES + 1, "x"));
      expect(await service.openForOwner(owner, largeFile)).toMatchObject({ kind: "error", code: "file-too-large" });

      const smallFile = path.join(directory, "small.md");
      await writeFile(smallFile, "small", "utf8");
      const session = opened(await service.openForOwner(owner, smallFile));
      const result = await service.saveForOwner(owner, {
        sessionId: session.sessionId,
        text: "x".repeat(MAX_MARKDOWN_BYTES + 1)
      });
      expect(result).toMatchObject({ kind: "error", code: "content-too-large" });
      expect(await readFile(smallFile, "utf8")).toBe("small");
    });
  });

  it("rejects a guessed session or a session owned by another renderer", async () => {
    await withTempDirectory(async (directory) => {
      const filePath = path.join(directory, "notes.md");
      await writeFile(filePath, "before", "utf8");
      const service = new MarkdownFileService();
      const owner = {};
      const otherOwner = {};
      const session = opened(await service.openForOwner(owner, filePath));

      expect(await service.saveForOwner(otherOwner, { sessionId: session.sessionId, text: "other" }))
        .toMatchObject({ kind: "error", code: "session-not-owned" });
      expect(await service.saveForOwner(owner, { sessionId: "guessed-session", text: "guess" }))
        .toMatchObject({ kind: "error", code: "session-not-owned" });
      expect(await readFile(filePath, "utf8")).toBe("before");
    });
  });

  it("serializes overlapping saves so the newest request is written last", async () => {
    await withTempDirectory(async (directory) => {
      const filePath = path.join(directory, "notes.md");
      await writeFile(filePath, "before", "utf8");
      const service = new MarkdownFileService();
      const owner = {};
      const session = opened(await service.openForOwner(owner, filePath));

      const first = service.saveForOwner(owner, { sessionId: session.sessionId, text: "first" });
      const second = service.saveForOwner(owner, { sessionId: session.sessionId, text: "second" });
      const results = await Promise.all([first, second]);

      expect(results[0].kind).toBe("saved");
      expect(results[1].kind).toBe("saved");
      expect(await readFile(filePath, "utf8")).toBe("second");
    });
  });

  it("preserves CRLF and a UTF-8 BOM while opening and saving", async () => {
    await withTempDirectory(async (directory) => {
      const filePath = path.join(directory, "notes.md");
      const openedText = "\uFEFF# Heading\r\n\r\nBody\r\n";
      const savedText = `${openedText}追加\r\n`;
      await writeFile(filePath, Buffer.from(openedText, "utf8"));
      const service = new MarkdownFileService();
      const owner = {};
      const session = opened(await service.openForOwner(owner, filePath));
      expect(session.text).toBe(openedText);

      const result = await service.saveForOwner(owner, { sessionId: session.sessionId, text: savedText });

      expect(result).toMatchObject({ kind: "saved", text: savedText });
      expect(await readFile(filePath)).toEqual(Buffer.from(savedText, "utf8"));
    });
  });
});
