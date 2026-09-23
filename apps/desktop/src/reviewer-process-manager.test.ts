import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  ReviewerProcessManager,
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

class FakeWorkspaceLocator implements ReviewerWorkspaceLocator {
  public getWorkspacePath(): string {
    return "/test/fake-workspace";
  }
}

describe("ReviewerProcessManager", () => {
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
