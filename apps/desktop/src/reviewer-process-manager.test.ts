import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ReviewerProcessManager,
  UserDataReviewerWorkspaceLocator,
  isExpectedReviewerReadinessPayload,
  resolveDevelopmentReviewerRoot,
  terminateProcessTree,
  type ReviewerLaunchOptions,
  type ReviewerLaunchStrategy,
  type ReviewerWorkspaceLocator
} from "./reviewer-process-manager";

class FakeChildProcess extends EventEmitter {
  public pid = 4242;
  public exitCode: number | null = null;
  public killed = false;
  public stdout = new EventEmitter();
  public stderr = new EventEmitter();

  public kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.exitCode = signal === "SIGKILL" ? 137 : 0;
    process.nextTick(() => {
      this.emit("exit", this.exitCode, signal ?? null);
    });
    return true;
  }
}

class FakeLaunchStrategy implements ReviewerLaunchStrategy {
  public spawnCount = 0;
  public lastOptions: ReviewerLaunchOptions | null = null;
  public currentChild: FakeChildProcess | null = null;

  public spawn(options: ReviewerLaunchOptions): ChildProcess {
    this.spawnCount += 1;
    this.lastOptions = options;
    const child = new FakeChildProcess();
    this.currentChild = child;
    return child as unknown as ChildProcess;
  }
}

class DeferredLaunchStrategy implements ReviewerLaunchStrategy {
  public spawnCount = 0;
  public currentChild: FakeChildProcess | null = null;
  private resolveChild: ((child: ChildProcess) => void) | null = null;
  private readonly enteredPromise: Promise<void>;
  private resolveEntered!: () => void;

  public constructor() {
    this.enteredPromise = new Promise((resolve) => {
      this.resolveEntered = resolve;
    });
  }

  public spawn(): Promise<ChildProcess> {
    this.spawnCount += 1;
    this.currentChild = new FakeChildProcess();
    this.resolveEntered();
    return new Promise((resolve) => {
      this.resolveChild = resolve;
    });
  }

  public async waitUntilSpawnRequested(): Promise<void> {
    return this.enteredPromise;
  }

  public resolveSpawn(): void {
    if (!this.currentChild || !this.resolveChild) {
      throw new Error("Deferred Reviewer launch was not requested.");
    }
    this.resolveChild(this.currentChild as unknown as ChildProcess);
  }
}

class FakeWorkspaceLocator implements ReviewerWorkspaceLocator {
  public getWorkspacePath(): string {
    return "/test/fake-workspace";
  }
}

class GracefulChildProcess extends EventEmitter {
  public pid = 4243;
  public exitCode: number | null = null;
  public killed = false;
  public readonly signals: Array<NodeJS.Signals | undefined> = [];

  public kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if (signal === "SIGTERM") {
      setTimeout(() => {
        this.exitCode = 0;
        this.emit("exit", 0, signal);
      }, 15);
    }
    return true;
  }
}

describe("ReviewerProcessManager", () => {
  it("requires the exact service and contract version for readiness", () => {
    expect(isExpectedReviewerReadinessPayload({ service: "maginalia-reviewer", contractVersion: 1 })).toBe(true);
    expect(isExpectedReviewerReadinessPayload({ service: "maginalia-reviewer" })).toBe(false);
    expect(isExpectedReviewerReadinessPayload({ service: "maginalia-reviewer", contractVersion: 2 })).toBe(false);
    expect(isExpectedReviewerReadinessPayload({ service: "unrelated", contractVersion: 1 })).toBe(false);
  });

  it("locates Reviewer state under an injected Unicode userData directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "MAGINALIA-\u30ec\u30d3\u30e5\u30a2-"));
    try {
      const workspace = new UserDataReviewerWorkspaceLocator(root).getWorkspacePath();
      expect(workspace).toBe(path.join(root, "reviewer"));
      expect(fs.existsSync(workspace)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves only explicit source and built Desktop layouts, never cwd", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "maginalia-reviewer-layout-"));
    const reviewerRoot = path.join(root, "sidecars", "reviewer");
    fs.mkdirSync(path.join(reviewerRoot, "src", "marginalia_reviewer"), { recursive: true });
    fs.writeFileSync(path.join(reviewerRoot, "pyproject.toml"), "[project]\nname = 'reviewer'\n", "utf8");
    fs.writeFileSync(path.join(reviewerRoot, "src", "marginalia_reviewer", "__main__.py"), "", "utf8");
    try {
      const sourceDir = path.join(root, "apps", "desktop", "src");
      const builtDir = path.join(root, "apps", "desktop", "dist", "main");
      expect(resolveDevelopmentReviewerRoot(sourceDir)).toBe(reviewerRoot);
      expect(resolveDevelopmentReviewerRoot(builtDir)).toBe(reviewerRoot);
      expect(() => resolveDevelopmentReviewerRoot(path.join(root, "unrelated"))).toThrow(/expected MAGINALIA layout/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses SIGTERM only on POSIX fallback cleanup", async () => {
    const child = new GracefulChildProcess();
    await terminateProcessTree(child as unknown as ChildProcess, 100);
    if (process.platform === "win32") {
      // Windows force cleanup must not pretend that Node SIGTERM is graceful.
      expect(child.signals).not.toContain("SIGTERM");
    } else {
      expect(child.signals).toEqual(["SIGTERM"]);
      expect(child.exitCode).toBe(0);
    }
  });

  it("manages loopback port and reaches ready state on valid readiness response", async () => {
    const launchStrategy = new FakeLaunchStrategy();
    const fakeFetcher: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("/api/health") || url.includes("/api/session")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: "ok",
            service: "maginalia-reviewer",
            contractVersion: 1
          })
        } as unknown as Response;
      }
      return { ok: false, status: 404 } as unknown as Response;
    });

    const manager = new ReviewerProcessManager({
      launchStrategy,
      workspaceLocator: new FakeWorkspaceLocator(),
      fetcher: fakeFetcher,
      readinessTimeoutMs: 1_000,
      readinessPollIntervalMs: 10
    });

    expect(manager.getStatus().status).toBe("stopped");

    const baseUrl = await manager.ensureReady();
    expect(baseUrl).toBeInstanceOf(URL);
    expect(baseUrl.hostname).toBe("127.0.0.1");
    expect(baseUrl.protocol).toBe("http:");
    expect(manager.getStatus().status).toBe("ready");
    expect(manager.getStatus().baseUrl).toBe(baseUrl.href);
    expect(launchStrategy.spawnCount).toBe(1);
    expect(launchStrategy.lastOptions?.workspacePath).toBe("/test/fake-workspace");

    await manager.shutdown();
    expect(manager.getStatus().status).toBe("stopped");
    expect(manager.getStatus().baseUrl).toBeNull();
  });

  it("deduplicates concurrent ensureReady calls and starts only one child process", async () => {
    const launchStrategy = new FakeLaunchStrategy();
    const fakeFetcher: typeof fetch = vi.fn(async () => {
      // Simulate small delay before readiness
      await new Promise((resolve) => setTimeout(resolve, 30));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: "ok",
          service: "maginalia-reviewer",
          contractVersion: 1
        })
      } as unknown as Response;
    });

    const manager = new ReviewerProcessManager({
      launchStrategy,
      workspaceLocator: new FakeWorkspaceLocator(),
      fetcher: fakeFetcher,
      readinessTimeoutMs: 1_000,
      readinessPollIntervalMs: 10
    });

    const [url1, url2, url3] = await Promise.all([
      manager.ensureReady(),
      manager.ensureReady(),
      manager.ensureReady()
    ]);

    expect(url1.href).toBe(url2.href);
    expect(url2.href).toBe(url3.href);
    expect(launchStrategy.spawnCount).toBe(1);

    await manager.shutdown();
  });

  it("uses the per-launch authenticated loopback endpoint before force cleanup", async () => {
    const launchStrategy = new FakeLaunchStrategy();
    const fakeFetcher: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes("/api/desktop/shutdown")) {
        expect((init?.headers as Record<string, string>)["X-Maginalia-Reviewer-Shutdown-Token"])
          .toMatch(/^[A-Za-z0-9_-]{40,}$/);
        const child = launchStrategy.currentChild!;
        process.nextTick(() => {
          child.exitCode = 0;
          child.emit("exit", 0, null);
        });
        return { ok: true, status: 202, json: async () => ({ status: "shutting-down" }) } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ service: "maginalia-reviewer", contractVersion: 1 })
      } as unknown as Response;
    });
    const manager = new ReviewerProcessManager({
      launchStrategy,
      workspaceLocator: new FakeWorkspaceLocator(),
      fetcher: fakeFetcher,
      readinessTimeoutMs: 1_000,
      readinessPollIntervalMs: 10,
      stopTimeoutMs: 100
    });

    await manager.ensureReady();
    await manager.shutdown();

    expect(fakeFetcher).toHaveBeenCalledWith(
      expect.stringContaining("/api/desktop/shutdown"),
      expect.objectContaining({ method: "POST" })
    );
    expect(manager.wasLastShutdownCooperative()).toBe(true);
    expect(launchStrategy.currentChild?.killed).toBe(false);
  });

  it("stops admission and cleans up a child that resolves after shutdown begins", async () => {
    const launchStrategy = new DeferredLaunchStrategy();
    const manager = new ReviewerProcessManager({
      launchStrategy,
      workspaceLocator: new FakeWorkspaceLocator(),
      fetcher: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ service: "maginalia-reviewer", contractVersion: 1 })
      }) as unknown as Response),
      readinessTimeoutMs: 1_000,
      readinessPollIntervalMs: 10
    });

    const starting = manager.ensureReady();
    await launchStrategy.waitUntilSpawnRequested();
    const stopping = manager.shutdown();
    launchStrategy.resolveSpawn();

    await stopping;
    await expect(starting).rejects.toThrow(/startup was cancelled/i);
    expect(launchStrategy.spawnCount).toBe(1);
    expect(launchStrategy.currentChild?.killed).toBe(true);
    expect(manager.getStatus()).toMatchObject({ status: "stopped", baseUrl: null, port: null });
    await expect(manager.ensureReady()).rejects.toThrow(/shutting down/i);
  });

  it("rejects wrong service on port and marks status as failed", async () => {
    const launchStrategy = new FakeLaunchStrategy();
    const fakeFetcher: typeof fetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: "ok",
          service: "some-unrelated-apache-server",
          contractVersion: 1
        })
      } as unknown as Response;
    });

    const manager = new ReviewerProcessManager({
      launchStrategy,
      workspaceLocator: new FakeWorkspaceLocator(),
      fetcher: fakeFetcher,
      readinessTimeoutMs: 100,
      readinessPollIntervalMs: 20
    });

    await expect(manager.ensureReady()).rejects.toThrow(/Reviewer startup failed/);
    expect(manager.getStatus().status).toBe("failed");
    expect(manager.getBaseUrl()).toBeNull();
  });

  it("rejects an incompatible contract version on an otherwise matching service", async () => {
    const launchStrategy = new FakeLaunchStrategy();
    const manager = new ReviewerProcessManager({
      launchStrategy,
      workspaceLocator: new FakeWorkspaceLocator(),
      fetcher: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ service: "maginalia-reviewer", contractVersion: 999 })
      }) as unknown as Response),
      readinessTimeoutMs: 100,
      readinessPollIntervalMs: 20
    });

    await expect(manager.ensureReady()).rejects.toThrow(/Reviewer startup failed/);
    expect(manager.getStatus().status).toBe("failed");
  });

  it("fails visibly on readiness timeout", async () => {
    const launchStrategy = new FakeLaunchStrategy();
    const fakeFetcher: typeof fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });

    const manager = new ReviewerProcessManager({
      launchStrategy,
      workspaceLocator: new FakeWorkspaceLocator(),
      fetcher: fakeFetcher,
      readinessTimeoutMs: 120,
      readinessPollIntervalMs: 20
    });

    await expect(manager.ensureReady()).rejects.toThrow(/Reviewer startup failed/);
    expect(manager.getStatus().status).toBe("failed");
  });

  it("transitions to failed when child process exits unexpectedly", async () => {
    const launchStrategy = new FakeLaunchStrategy();
    const fakeFetcher: typeof fetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: "ok",
          service: "maginalia-reviewer",
          contractVersion: 1
        })
      } as unknown as Response;
    });

    const statusChanges: string[] = [];
    const manager = new ReviewerProcessManager({
      launchStrategy,
      workspaceLocator: new FakeWorkspaceLocator(),
      fetcher: fakeFetcher,
      readinessTimeoutMs: 1_000,
      readinessPollIntervalMs: 10,
      onStatusChange: (status) => statusChanges.push(status)
    });

    await manager.ensureReady();
    expect(manager.getStatus().status).toBe("ready");

    // Simulate unexpected crash of child process
    const child = launchStrategy.currentChild;
    expect(child).not.toBeNull();
    child!.exitCode = 1;
    child!.emit("exit", 1, null);

    expect(manager.getStatus().status).toBe("failed");
    expect(manager.getBaseUrl()).toBeNull();
    expect(statusChanges).toContain("failed");
  });

  it("supports restart without creating duplicate processes", async () => {
    const launchStrategy = new FakeLaunchStrategy();
    const fakeFetcher: typeof fetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: "ok",
          service: "maginalia-reviewer",
          contractVersion: 1
        })
      } as unknown as Response;
    });

    const manager = new ReviewerProcessManager({
      launchStrategy,
      workspaceLocator: new FakeWorkspaceLocator(),
      fetcher: fakeFetcher,
      readinessTimeoutMs: 1_000,
      readinessPollIntervalMs: 10
    });

    const firstUrl = await manager.ensureReady();
    const firstChild = launchStrategy.currentChild;
    expect(launchStrategy.spawnCount).toBe(1);

    const restartedUrl = await manager.restart();
    expect(firstChild?.killed).toBe(true);
    expect(launchStrategy.spawnCount).toBe(2);
    expect(restartedUrl).toBeInstanceOf(URL);
    expect(manager.getStatus().status).toBe("ready");

    await manager.shutdown();
  });

  it("honors valid loopback environment override with contract identity", async () => {
    const launchStrategy = new FakeLaunchStrategy();
    const fakeFetcher: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.startsWith("http://127.0.0.1:9999/api/health")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: "ok",
            service: "maginalia-reviewer",
            contractVersion: 1
          })
        } as unknown as Response;
      }
      return { ok: false, status: 500 } as unknown as Response;
    });

    const manager = new ReviewerProcessManager({
      launchStrategy,
      workspaceLocator: new FakeWorkspaceLocator(),
      fetcher: fakeFetcher,
      envOverrideUrl: "http://127.0.0.1:9999"
    });

    const url = await manager.ensureReady();
    expect(url.href).toBe("http://127.0.0.1:9999/");
    expect(launchStrategy.spawnCount).toBe(0); // Spawning bypassed for valid override
    expect(manager.getStatus().status).toBe("ready");

    await manager.shutdown();
  });

  it("rejects non-loopback environment override", async () => {
    const launchStrategy = new FakeLaunchStrategy();
    const fakeFetcher: typeof fetch = vi.fn();

    const manager = new ReviewerProcessManager({
      launchStrategy,
      workspaceLocator: new FakeWorkspaceLocator(),
      fetcher: fakeFetcher,
      envOverrideUrl: "http://example.com:8765"
    });

    await expect(manager.ensureReady()).rejects.toThrow(/loopback host/);
    expect(launchStrategy.spawnCount).toBe(0);
    expect(manager.getStatus().status).toBe("failed");
  });
});
