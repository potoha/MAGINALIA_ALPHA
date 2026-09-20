import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MOD_HOST_PROTOCOL,
  ModHost,
  discoverModCandidates,
  isModManifest,
  parseModManifest,
  type ModUtilityProcess
} from "./mod-host";

const VALID_MANIFEST = {
  id: "dev.example.secondary-markdown",
  name: "Secondary Markdown",
  version: "0.1.0",
  apiVersion: 1,
  main: "dist/index.js"
} as const;

async function withTemporaryDirectory<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "maginalia-mod-host-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function createMod(root: string, directoryName: string, manifest: Record<string, unknown> = VALID_MANIFEST): Promise<string> {
  const directory = path.join(root, directoryName);
  await mkdir(path.join(directory, "dist"), { recursive: true });
  await writeFile(path.join(directory, "maginalia.mod.json"), `${JSON.stringify(manifest)}\n`, "utf8");
  await writeFile(path.join(directory, "dist", "index.js"), "export function activate() {}\n", "utf8");
  return directory;
}

class FakeUtilityProcess implements ModUtilityProcess {
  public readonly pid = 1234;
  public readonly messages: unknown[] = [];
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  public on(event: "message", listener: (...args: unknown[]) => void): this;
  public on(event: "exit", listener: (code: number) => void): this;
  public on(event: "error", listener: (...args: unknown[]) => void): this;
  public on(event: "message" | "exit" | "error", listener: (...args: any[]) => void): this;
  public on(event: "message" | "exit" | "error", listener: (...args: any[]) => void): this {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  public once(event: "message", listener: (...args: unknown[]) => void): this;
  public once(event: "exit", listener: (code: number) => void): this;
  public once(event: "error", listener: (...args: unknown[]) => void): this;
  public once(event: "message" | "exit" | "error", listener: (...args: any[]) => void): this;
  public once(event: "message" | "exit" | "error", listener: (...args: any[]) => void): this {
    const once = (...args: unknown[]): void => {
      this.removeListener(event, once);
      listener(...args);
    };
    return this.on(event, once);
  }

  public removeListener(event: "message", listener: (...args: unknown[]) => void): this;
  public removeListener(event: "exit", listener: (code: number) => void): this;
  public removeListener(event: "error", listener: (...args: unknown[]) => void): this;
  public removeListener(event: "message" | "exit" | "error", listener: (...args: any[]) => void): this;
  public removeListener(event: "message" | "exit" | "error", listener: (...args: any[]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  public emit(event: "message" | "exit" | "error", ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  public postMessage(message: unknown): void {
    this.messages.push(message);
    if (!message || typeof message !== "object") return;
    const value = message as Record<string, unknown>;
    if (value.kind === "start") {
      queueMicrotask(() => this.emit("message", {
        kind: "commit",
        protocol: MOD_HOST_PROTOCOL,
        modId: value.modId,
        contributions: [{ kind: "view", id: "secondary", title: "Secondary", region: "secondary" }]
      }));
    } else if (value.kind === "shutdown") {
      queueMicrotask(() => {
        this.emit("message", { kind: "shutdown-ack", protocol: MOD_HOST_PROTOCOL });
        this.emit("exit", 0);
      });
    }
  }

  public kill(): boolean {
    queueMicrotask(() => this.emit("exit", 1));
    return true;
  }
}

describe("Mod manifest and discovery", () => {
  it("accepts only the small strict namespaced manifest", () => {
    expect(parseModManifest(VALID_MANIFEST)).toEqual({ kind: "valid", manifest: VALID_MANIFEST });
    expect(isModManifest(VALID_MANIFEST)).toBe(true);
    expect(isModManifest({ ...VALID_MANIFEST, id: "secondary" })).toBe(false);
    expect(isModManifest({ ...VALID_MANIFEST, extra: true })).toBe(false);
    expect(isModManifest({ ...VALID_MANIFEST, main: "../escape.js" })).toBe(false);
    expect(isModManifest({ ...VALID_MANIFEST, apiVersion: 2 })).toBe(false);
  });

  it("scans only direct global Mods children, never a Project repository", async () => {
    await withTemporaryDirectory(async (root) => {
      await createMod(path.join(root, "mods"), "dev.example.valid");
      await createMod(path.join(root, "project", "random-js-repo"), "nested");
      const candidates = await discoverModCandidates(path.join(root, "mods"));
      expect(candidates).toHaveLength(1);
      expect(candidates[0].candidate?.manifest.id).toBe(VALID_MANIFEST.id);
    });
  });

  it("reports malformed candidates without preventing a valid sibling", async () => {
    await withTemporaryDirectory(async (root) => {
      await createMod(path.join(root, "mods"), "dev.example.bad", { ...VALID_MANIFEST, id: "bad" });
      await createMod(path.join(root, "mods"), "dev.example.good");
      const candidates = await discoverModCandidates(path.join(root, "mods"));
      expect(candidates.map((candidate) => candidate.candidate !== undefined)).toEqual([false, true]);
    });
  });
});

describe("ModHost", () => {
  it("activates valid Mods transactionally and isolates invalid/duplicate IDs", async () => {
    await withTemporaryDirectory(async (root) => {
      const mods = path.join(root, "mods");
      await createMod(mods, "a-invalid", { ...VALID_MANIFEST, id: "invalid" });
      await createMod(mods, "b-valid");
      await createMod(mods, "c-duplicate");
      const host = new ModHost({
        userDataPath: root,
        fork: () => {
          const worker = new FakeUtilityProcess();
          queueMicrotask(() => worker.emit("message", { kind: "ready", protocol: MOD_HOST_PROTOCOL }));
          return worker;
        }
      });
      const snapshot = await host.start();
      expect(snapshot.mods.filter((mod) => mod.state === "active").map((mod) => mod.id)).toEqual([VALID_MANIFEST.id]);
      expect(snapshot.mods.filter((mod) => mod.state === "error")).toHaveLength(2);
      expect(snapshot.contributions).toHaveLength(1);
      await host.dispose();
    });
  });

  it("removes a Mod and its contributions when its direct folder is removed", async () => {
    await withTemporaryDirectory(async (root) => {
      const directory = await createMod(path.join(root, "mods"), "dev.example.removable");
      const host = new ModHost({
        userDataPath: root,
        fork: () => {
          const worker = new FakeUtilityProcess();
          queueMicrotask(() => worker.emit("message", { kind: "ready", protocol: MOD_HOST_PROTOCOL }));
          return worker;
        }
      });
      expect((await host.start()).contributions).toHaveLength(1);
      await rm(directory, { recursive: true, force: true });
      const afterRemoval = await host.reload();
      expect(afterRemoval.contributions).toEqual([]);
      expect(afterRemoval.mods).toEqual([]);
    });
  });

  it("opens the explicit Mods directory through the host callback", async () => {
    await withTemporaryDirectory(async (root) => {
      let opened = "";
      const host = new ModHost({ userDataPath: root, openFolder: async (directory) => { opened = directory; } });
      await host.openModsFolder();
      expect(opened).toBe(path.join(root, "mods"));
    });
  });

  it("routes declarative capability requests without exposing host objects", async () => {
    await withTemporaryDirectory(async (root) => {
      await createMod(path.join(root, "mods"), "dev.example.capability");
      let callbackValue: unknown;
      let worker: FakeUtilityProcess | undefined;
      const host = new ModHost({
        userDataPath: root,
        fork: () => {
          worker = new FakeUtilityProcess();
          queueMicrotask(() => worker?.emit("message", { kind: "ready", protocol: MOD_HOST_PROTOCOL }));
          return worker;
        },
        onCapabilityRequest: (_modId, request) => {
          callbackValue = request.value;
          return { kind: "ok", value: { accepted: true } };
        }
      });
      await host.start();
      worker?.emit("message", {
        kind: "capability-request",
        protocol: MOD_HOST_PROTOCOL,
        modId: VALID_MANIFEST.id,
        requestId: "capability-1",
        capability: "get-active-document",
        value: null
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(callbackValue).toBeNull();
      expect(worker?.messages.at(-1)).toEqual({
        kind: "capability-response",
        protocol: MOD_HOST_PROTOCOL,
        requestId: "capability-1",
        response: { kind: "ok", value: { accepted: true } }
      });
      await host.dispose();
    });
  });

  it("drops only a Mod whose utility process crashes after activation", async () => {
    await withTemporaryDirectory(async (root) => {
      await createMod(path.join(root, "mods"), "dev.example.crashy");
      const workers: FakeUtilityProcess[] = [];
      const host = new ModHost({
        userDataPath: root,
        fork: () => {
          const worker = new FakeUtilityProcess();
          workers.push(worker);
          queueMicrotask(() => worker.emit("message", { kind: "ready", protocol: MOD_HOST_PROTOCOL }));
          return worker;
        }
      });
      await host.start();
      workers[0].emit("exit", 9);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(host.snapshot().contributions).toEqual([]);
      expect(host.snapshot().mods[0]).toMatchObject({ state: "error", error: "Mod worker exited (9)." });
    });
  });
});
