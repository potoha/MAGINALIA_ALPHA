import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { installModBootstrap, MOD_HOST_PROTOCOL, type ModWorkerPort } from "./mod-bootstrap";

class FakePort implements ModWorkerPort {
  public readonly messages: unknown[] = [];
  private listener: ((event: unknown) => void) | undefined;

  public postMessage(message: unknown): void {
    this.messages.push(message);
  }

  public on(_event: "message", listener: (event: unknown) => void): unknown {
    this.listener = listener;
    return this;
  }

  public send(message: unknown): void {
    this.listener?.(message);
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for Mod bootstrap message.");
}

async function withTemporaryDirectory<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "maginalia-mod-bootstrap-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const manifest = {
  id: "dev.example.test",
  name: "Test Mod",
  version: "0.1.0",
  apiVersion: 1 as const,
  main: "index.mjs"
};

describe("Mod bootstrap protocol", () => {
  it("loads the first-party Secondary Markdown Mod through the ordinary boundary", async () => {
    const modDirectory = path.resolve(__dirname, "..", "..", "..", "mods", "dev.maginalia.secondary-markdown");
    const entry = path.join(modDirectory, "dist", "index.js");
    const firstPartyManifest = {
      id: "dev.maginalia.secondary-markdown",
      name: "Secondary Markdown",
      version: "0.1.0",
      apiVersion: 1 as const,
      main: "dist/index.js"
    };
    const port = new FakePort();
    installModBootstrap(port, { exit: () => undefined });
    port.send({
      kind: "start",
      protocol: MOD_HOST_PROTOCOL,
      modId: firstPartyManifest.id,
      manifest: firstPartyManifest,
      directoryPath: modDirectory,
      entryPath: entry
    });
    await waitFor(() => port.messages.some((message) => (message as { kind?: unknown }).kind === "commit"));
    expect(port.messages.at(-1)).toEqual({
      kind: "commit",
      protocol: MOD_HOST_PROTOCOL,
      modId: firstPartyManifest.id,
      contributions: [
        { kind: "view", id: "secondary-markdown", title: "Secondary Markdown", region: "secondary", groupId: "sidebar-group-1" },
        {
          kind: "command",
          id: "dev.maginalia.secondary-markdown.open-active-document-in-secondary",
          title: "Open Active Markdown in Secondary Pane",
          category: "Secondary Markdown",
          keywords: ["secondary", "markdown", "pane"]
        },
        {
          kind: "context-menu",
          id: "dev.maginalia.secondary-markdown.menu.open-active-document-in-secondary",
          location: "editor.caret",
          command: "dev.maginalia.secondary-markdown.open-active-document-in-secondary",
          group: "mod",
          order: 100
        },
        {
          kind: "utility-bar",
          id: "dev.maginalia.secondary-markdown.utility.open-active-document-in-secondary",
          command: "dev.maginalia.secondary-markdown.open-active-document-in-secondary",
          group: "more",
          label: "Secondary",
          title: "Open active Markdown in secondary pane",
          order: 100
        }
      ]
    });
  });

  it("loads a Mod only after start and commits declarations atomically", async () => {
    await withTemporaryDirectory(async (root) => {
      const entry = path.join(root, "index.mjs");
      await writeFile(entry, [
        "export function activate(api) {",
        "  api.registerView({ id: 'secondary', title: 'Secondary', region: 'secondary' });",
        "  api.registerCommand({ id: 'dev.example.test.open', title: 'Open' }, () => ({ kind: 'opened' }));",
        "}"
      ].join("\n"), "utf8");
      const port = new FakePort();
      installModBootstrap(port, { exit: () => undefined });
      expect(port.messages).toEqual([{ kind: "ready", protocol: MOD_HOST_PROTOCOL }]);
      port.send({
        kind: "start",
        protocol: MOD_HOST_PROTOCOL,
        modId: manifest.id,
        manifest,
        directoryPath: root,
        entryPath: entry
      });
      await waitFor(() => port.messages.some((message) => (message as { kind?: unknown }).kind === "commit"));
      expect(port.messages.at(-1)).toEqual({
        kind: "commit",
        protocol: MOD_HOST_PROTOCOL,
        modId: manifest.id,
        contributions: [
          { kind: "view", id: "secondary", title: "Secondary", region: "secondary" },
        { kind: "command", id: "dev.example.test.open", title: "Open" }
        ]
      });
    });
  });

  it("does not commit partial declarations when activation fails", async () => {
    await withTemporaryDirectory(async (root) => {
      const entry = path.join(root, "index.mjs");
      await writeFile(entry, [
        "export function activate(api) {",
        "  api.registerView({ id: 'partial', title: 'Partial', region: 'secondary' });",
        "  throw new Error('broken mod');",
        "}"
      ].join("\n"), "utf8");
      const port = new FakePort();
      const exits: number[] = [];
      installModBootstrap(port, { exit: (code) => exits.push(code) });
      port.send({
        kind: "start",
        protocol: MOD_HOST_PROTOCOL,
        modId: manifest.id,
        manifest,
        directoryPath: root,
        entryPath: entry
      });
      await waitFor(() => port.messages.some((message) => (message as { kind?: unknown }).kind === "error"));
      expect(port.messages.some((message) => (message as { kind?: unknown }).kind === "commit")).toBe(false);
      expect(port.messages.at(-1)).toMatchObject({ kind: "error", message: "broken mod" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(exits).toEqual([1]);
    });
  });
});
