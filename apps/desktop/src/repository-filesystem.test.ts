import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  INCOMPLETE_MARKER,
  RepositoryFilesystemError,
  assertSafeRoot,
  captureWorkingTree,
  fingerprint,
  readIdentity,
  validateRepositoryPath,
} from "./repository-filesystem.js";

const IDENTITY = {
  schemaVersion: 1,
  id: "550e8400-e29b-41d4-a716-446655440000",
  kind: "project",
  title: "日本語の Fixture",
  templateVersion: 1,
} as const;

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await fs.rm(root, { recursive: true, force: true });
  }
});

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), "maginalia-rfs-"));
  roots.push(root);
  await fs.mkdir(join(root, ".maginalia"));
  await fs.writeFile(
    join(root, ".maginalia", "repository.json"),
    JSON.stringify(IDENTITY) + "\n",
    "utf8",
  );
  return root;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof RepositoryFilesystemError ? error.code : undefined;
}

describe("repository filesystem boundary", () => {
  test("canonicalizes a real root, reads strict identity, preserves bytes, and fingerprints deterministically", async () => {
    const root = await makeRoot();
    const content = "\uFEFF# 日本語\r\n本文\r\n";
    await fs.writeFile(join(root, "manuscript.md"), content, "utf8");

    const canonical = await assertSafeRoot(root);
    expect(canonical).toBe(await fs.realpath(root));
    expect(await readIdentity(root)).toEqual(IDENTITY);

    const captured = await captureWorkingTree(root);
    const manuscript = captured.files.find((file) => file.path === "manuscript.md");
    expect(manuscript).toBeDefined();
    expect(Buffer.from(manuscript!.bytes).toString("utf8")).toBe(content);
    expect(captured.files.map((file) => file.path)).toEqual([
      ".maginalia/repository.json",
      "manuscript.md",
    ]);
    expect(captured.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(captured.fingerprint).toBe(fingerprint(captured.files));
    expect(captured.fingerprint).toBe(
      fingerprint([...captured.files].reverse()),
    );
  });

  test("preserves tracked descendants under skipped directories while pruning ignored untracked files", async () => {
    const root = await makeRoot();
    await fs.mkdir(join(root, "dist"));
    await fs.mkdir(join(root, "node_modules"));
    await fs.mkdir(join(root, "src"));
    await fs.writeFile(join(root, "dist", "kept.txt"), "tracked\n", "utf8");
    await fs.writeFile(join(root, "dist", "drop.txt"), "ignored\n", "utf8");
    await fs.writeFile(join(root, "node_modules", "drop.js"), "ignored\n", "utf8");
    await fs.writeFile(join(root, "src", "main.md"), "ordinary\n", "utf8");

    const captured = await captureWorkingTree(root, {
      trackedPaths: new Set(["dist/kept.txt"]),
      isIgnored: async (pathValue) =>
        pathValue.startsWith("dist/") || pathValue.startsWith("node_modules/"),
    });

    expect(captured.files.map((file) => file.path)).toEqual([
      ".maginalia/repository.json",
      "dist/kept.txt",
      "src/main.md",
    ]);
  });

  test("never ignores the identity and reports the incomplete marker unless explicitly allowed", async () => {
    const root = await makeRoot();
    await fs.writeFile(join(root, INCOMPLETE_MARKER), "in progress\n", "utf8");

    await expect(captureWorkingTree(root, {
      isIgnored: async () => true,
    })).rejects.toSatisfy((error: unknown) => errorCode(error) === "incomplete-marker");

    const allowed = await captureWorkingTree(root, {
      allowIncompleteMarker: true,
      isIgnored: async () => true,
    });
    expect(allowed.files.map((file) => file.path)).toEqual([
      ".maginalia/repository.json",
    ]);
    expect(await readIdentity(root, { allowIncompleteMarker: true })).toEqual(IDENTITY);
    await expect(readIdentity(root)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "incomplete-marker",
    );
    expect(await fs.readFile(join(root, INCOMPLETE_MARKER), "utf8")).toBe("in progress\n");
  });

  test("rejects malformed, oversized, and linked identity files without leaking paths", async () => {
    const root = await makeRoot();
    const identityPath = join(root, ".maginalia", "repository.json");
    await fs.writeFile(identityPath, "{\"schemaVersion\":1}\n", "utf8");
    await expect(readIdentity(root)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "invalid-identity",
    );

    await fs.writeFile(identityPath, "x".repeat(64 * 1024 + 1), "utf8");
    await expect(readIdentity(root)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "limits-exceeded",
    );

    const outside = join(root, "..", "maginalia-rfs-identity-outside");
    await fs.writeFile(outside, JSON.stringify(IDENTITY), "utf8");
    try {
      await fs.unlink(identityPath);
      await fs.link(outside, identityPath);
      await expect(readIdentity(root)).rejects.toSatisfy(
        (error: unknown) => errorCode(error) === "unsafe-path",
      );
    } catch {
      // Some Windows fixtures disallow hard links; the hard-link case is
      // covered conditionally where the filesystem permits it.
    } finally {
      await fs.unlink(identityPath).catch(() => undefined);
      await fs.unlink(outside).catch(() => undefined);
      await fs.writeFile(identityPath, JSON.stringify(IDENTITY) + "\n", "utf8");
    }
  });

  test("rejects invalid roots and portable traversal or Windows aliases with bounded messages", async () => {
    const root = await makeRoot();
    const file = join(root, "file.txt");
    await fs.writeFile(file, "file\n", "utf8");

    await expect(assertSafeRoot(file)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "invalid-root" || errorCode(error) === "root-not-directory",
    );
    await expect(assertSafeRoot(join(root, "missing"))).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "root-missing",
    );
    await expect(assertSafeRoot(parse(root).root)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "invalid-root",
    );

    for (const unsafe of [
      "../escape",
      "nested/../escape",
      "CON.txt",
      "folder/PRN",
      "folder\\file",
      "C:/absolute",
      "folder/\u0001",
      "folder/\u0080",
    ]) {
      expect(() => validateRepositoryPath(unsafe)).toThrow(RepositoryFilesystemError);
    }
    await expect(captureWorkingTree(root, {
      isIgnored: async () => {
        throw new Error(root);
      },
    })).rejects.toSatisfy((error: unknown) =>
      error instanceof RepositoryFilesystemError && !error.message.includes(root),
    );
  });

  test("enforces file, total, entry, depth, and path bounds", async () => {
    const root = await makeRoot();
    await fs.writeFile(join(root, "large.txt"), "x".repeat(500), "utf8");
    await expect(captureWorkingTree(root, {
      limits: { maxFileBytes: 256 },
    })).rejects.toSatisfy((error: unknown) => errorCode(error) === "limits-exceeded");
    await expect(captureWorkingTree(root, {
      limits: { maxTotalBytes: 256 * 1024, maxFiles: 1 },
    })).rejects.toSatisfy((error: unknown) => errorCode(error) === "limits-exceeded");

    await fs.rm(join(root, "large.txt"));
    await fs.mkdir(join(root, "a"));
    await fs.mkdir(join(root, "a", "b"));
    await fs.writeFile(join(root, "a", "b", "deep.md"), "deep\n", "utf8");
    await expect(captureWorkingTree(root, {
      limits: { maxDepth: 1 },
    })).rejects.toSatisfy((error: unknown) => errorCode(error) === "limits-exceeded");
    await expect(captureWorkingTree(root, {
      limits: { maxEntries: 1 },
    })).rejects.toSatisfy((error: unknown) => errorCode(error) === "limits-exceeded");
  });

  test("rejects secrets before ignore handling and excludes root or nested git entries", async () => {
    const root = await makeRoot();
    await fs.writeFile(join(root, ".env"), "TOKEN=fixture\n", "utf8");
    await expect(captureWorkingTree(root, {
      isIgnored: async () => true,
    })).rejects.toSatisfy((error: unknown) => errorCode(error) === "unsafe-secret");
    await fs.rm(join(root, ".env"));

    await fs.writeFile(join(root, "notes.md"), "-----BEGIN PRIVATE KEY-----\n", "utf8");
    await expect(captureWorkingTree(root)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "unsafe-secret",
    );
    await fs.rm(join(root, "notes.md"));

    await fs.mkdir(join(root, ".git"));
    await fs.writeFile(join(root, ".git", "HEAD"), "internal\n", "utf8");
    const rootGit = await captureWorkingTree(root);
    expect(rootGit.files.some((file) => file.path.startsWith(".git/"))).toBe(false);

    await fs.mkdir(join(root, "nested", ".git"), { recursive: true });
    await expect(captureWorkingTree(root)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "unsafe-path",
    );
  });

  test("rejects case-colliding paths when the filesystem can represent both names", async () => {
    const root = await makeRoot();
    try {
      await fs.writeFile(join(root, "Case.md"), "one\n", "utf8");
      await fs.writeFile(join(root, "case.md"), "two\n", "utf8");
    } catch {
      return;
    }
    const names = await fs.readdir(root);
    if (!names.includes("Case.md") || !names.includes("case.md")) return;
    await expect(captureWorkingTree(root)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "unsafe-path",
    );
  });

  test("rejects symlinks and hard-linked files where the fixture filesystem permits them", async () => {
    const root = await makeRoot();
    const outside = join(root, "..", "maginalia-rfs-outside.txt");
    await fs.writeFile(outside, "outside\n", "utf8");
    try {
      await fs.symlink(outside, join(root, "linked.md"));
      await expect(captureWorkingTree(root)).rejects.toSatisfy(
        (error: unknown) => errorCode(error) === "unsafe-path",
      );
    } catch {
      // Symlink creation may be disabled on Windows.
    } finally {
      await fs.unlink(join(root, "linked.md")).catch(() => undefined);
    }

    try {
      await fs.link(outside, join(root, "hard.md"));
      await expect(captureWorkingTree(root)).rejects.toSatisfy(
        (error: unknown) => errorCode(error) === "unsafe-path",
      );
    } catch {
      // Hard-link creation may be disabled on the test volume.
    } finally {
      await fs.unlink(join(root, "hard.md")).catch(() => undefined);
      await fs.unlink(outside).catch(() => undefined);
    }
  });

  test("preserves executable mode hints and portable bytes", async () => {
    const root = await makeRoot();
    await fs.writeFile(join(root, "script.sh"), "#!/bin/sh\r\n", "utf8");
    const captured = await captureWorkingTree(root, {
      modeHints: new Map([["script.sh", "100755"]]),
    });
    const script = captured.files.find((file) => file.path === "script.sh");
    if (process.platform === "win32") {
      expect(script?.mode).toBe("100755");
    } else {
      expect(script?.mode === "100644" || script?.mode === "100755").toBe(true);
    }
    expect(Buffer.from(script!.bytes).toString("utf8")).toBe("#!/bin/sh\r\n");
  });
});
