import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

export type ReviewerStatus = "stopped" | "starting" | "ready" | "failed" | "stopping";

export interface ReviewerLaunchOptions {
  readonly port: number;
  readonly workspacePath: string;
  readonly ndlocrConfigPath?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ReviewerLaunchStrategy {
  spawn(options: ReviewerLaunchOptions): Promise<ChildProcess> | ChildProcess;
}

export interface ReviewerWorkspaceLocator {
  getWorkspacePath(): string;
}

export interface ReviewerProcessManagerOptions {
  readonly launchStrategy?: ReviewerLaunchStrategy;
  readonly workspaceLocator?: ReviewerWorkspaceLocator;
  readonly ndlocrConfigPath?: string;
  readonly readinessTimeoutMs?: number;
  readonly readinessPollIntervalMs?: number;
  readonly stopTimeoutMs?: number;
  readonly fetcher?: typeof fetch;
  readonly envOverrideUrl?: string;
  readonly onStatusChange?: (status: ReviewerStatus) => void;
}

export interface ReviewerStatusSnapshot {
  readonly status: ReviewerStatus;
  readonly baseUrl: string | null;
  readonly port: number | null;
  readonly error: string | null;
}

export const EXPECTED_REVIEWER_SERVICE = "maginalia-reviewer";
export const EXPECTED_CONTRACT_VERSION = 1;
export const MAX_PORT_RETRIES = 5;
const MAX_LOG_LINES = 100;

/** Restrict string to loopback host names. */
export function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

/** Find an available ephemeral TCP port on loopback. */
export function findFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        server.close(() => reject(new Error("Unable to obtain loopback address.")));
        return;
      }
      const port = addr.port;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

/** Default workspace locator storing Reviewer data in persistent local user storage. */
export class DefaultReviewerWorkspaceLocator implements ReviewerWorkspaceLocator {
  private readonly customPath?: string;

  public constructor(customPath?: string) {
    this.customPath = customPath;
  }

  public getWorkspacePath(): string {
    if (this.customPath) {
      fs.mkdirSync(this.customPath, { recursive: true });
      return this.customPath;
    }
    const envPath = process.env.MARGINALIA_REVIEWER_WORKSPACE;
    if (envPath) {
      fs.mkdirSync(envPath, { recursive: true });
      return envPath;
    }
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const target = path.join(localAppData, "MarginaliaReviewer");
    fs.mkdirSync(target, { recursive: true });
    return target;
  }
}

/** Default Python development launch strategy for the Reviewer sidecar. */
export class PythonReviewerLaunchStrategy implements ReviewerLaunchStrategy {
  private readonly reviewerRoot: string;

  public constructor(reviewerRoot?: string) {
    if (reviewerRoot) {
      this.reviewerRoot = reviewerRoot;
    } else {
      // Look in MAGINALIA_ALPHA/sidecars/reviewer
      const candidateSidecar = path.resolve(__dirname, "..", "..", "..", "sidecars", "reviewer");
      if (fs.existsSync(candidateSidecar)) {
        this.reviewerRoot = candidateSidecar;
      } else {
        // Fallback relative to cwd
        this.reviewerRoot = path.resolve(process.cwd(), "sidecars", "reviewer");
      }
    }
  }

  public spawn(options: ReviewerLaunchOptions): ChildProcess {
    const venvPythonWin = path.join(this.reviewerRoot, ".venv", "Scripts", "python.exe");
    const venvPythonPosix = path.join(this.reviewerRoot, ".venv", "bin", "python");
    const venvPython = process.platform === "win32" ? venvPythonWin : venvPythonPosix;

    const baseArgs = [
      "-m",
      "marginalia_reviewer",
      "--port",
      String(options.port),
      "--workspace",
      options.workspacePath,
      "--no-browser",
      "--log-level",
      "info"
    ];

    if (options.ndlocrConfigPath) {
      baseArgs.push("--ndlocr-config", options.ndlocrConfigPath);
    }

    let command: string;
    let args: string[];

    if (fs.existsSync(venvPython)) {
      command = venvPython;
      args = baseArgs;
    } else {
      // Run via uv
      command = process.platform === "win32" ? "uv.exe" : "uv";
      args = ["run", "--project", this.reviewerRoot, "python", ...baseArgs];
    }

    const env = {
      ...process.env,
      ...options.env,
      PYTHONUNBUFFERED: "1"
    };

    return spawn(command, args, {
      cwd: this.reviewerRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
  }
}

/** Bounded string ring-buffer for diagnostic logs. */
class DiagnosticLogBuffer {
  private readonly lines: string[] = [];

  public append(line: string): void {
    const sanitized = line.replace(/\r?\n$/, "").trim();
    if (!sanitized) return;
    this.lines.push(sanitized);
    if (this.lines.length > MAX_LOG_LINES) {
      this.lines.shift();
    }
  }

  public getRecentLines(): readonly string[] {
    return Object.freeze([...this.lines]);
  }

  public clear(): void {
    this.lines.length = 0;
  }
}

/**
 * Kill process tree reliably, particularly on Windows.
 */
export async function terminateProcessTree(child: ChildProcess, timeoutMs = 3000): Promise<void> {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.killed) return;

  const exitPromise = new Promise<void>((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
  });

  try {
    child.kill("SIGTERM");
  } catch {
    // Ignore
  }

  if (process.platform === "win32" && typeof pid === "number") {
    try {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
      killer.on("error", () => {});
    } catch {
      // Ignore
    }
  }

  const raceResult = await Promise.race([
    exitPromise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs))
  ]);

  if (!raceResult && child.exitCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Ignore
    }
  }
}

/**
 * Owns and coordinates the Reviewer Python sidecar lifecycle for MAGINALIA Desktop.
 */
export class ReviewerProcessManager {
  private status: ReviewerStatus = "stopped";
  private baseUrl: URL | null = null;
  private managedPort: number | null = null;
  private lastError: string | null = null;
  private activeChild: ChildProcess | null = null;
  private startupPromise: Promise<URL> | null = null;
  private shutdownPromise: Promise<void> | null = null;

  private readonly launchStrategy: ReviewerLaunchStrategy;
  private readonly workspaceLocator: ReviewerWorkspaceLocator;
  private readonly ndlocrConfigPath?: string;
  private readonly readinessTimeoutMs: number;
  private readonly readinessPollIntervalMs: number;
  private readonly stopTimeoutMs: number;
  private readonly fetcher: typeof fetch;
  private readonly envOverrideUrl?: string;
  private readonly onStatusChange?: (status: ReviewerStatus) => void;
  private readonly logs = new DiagnosticLogBuffer();

  public constructor(options: ReviewerProcessManagerOptions = {}) {
    this.launchStrategy = options.launchStrategy ?? new PythonReviewerLaunchStrategy();
    this.workspaceLocator = options.workspaceLocator ?? new DefaultReviewerWorkspaceLocator();
    this.ndlocrConfigPath = options.ndlocrConfigPath;
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? 10_000;
    this.readinessPollIntervalMs = options.readinessPollIntervalMs ?? 100;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 4_000;
    this.fetcher = options.fetcher ?? fetch;
    this.envOverrideUrl = options.envOverrideUrl ?? process.env.MAGINALIA_REVIEWER_BASE_URL;
    this.onStatusChange = options.onStatusChange;
  }

  public getStatus(): ReviewerStatusSnapshot {
    return {
      status: this.status,
      baseUrl: this.baseUrl ? this.baseUrl.href : null,
      port: this.managedPort,
      error: this.lastError
    };
  }

  public getBaseUrl(): URL | null {
    return this.baseUrl;
  }

  private setStatus(next: ReviewerStatus, error: string | null = null): void {
    if (this.status === next && this.lastError === error) return;
    this.status = next;
    this.lastError = error;
    try {
      this.onStatusChange?.(next);
    } catch {
      // Listener errors do not abort manager
    }
  }

  /**
   * Verify readiness of a loopback server.
   * Confirms HTTP 200 and expected contract identity { service: "maginalia-reviewer" }.
   */
  public async checkReadiness(targetUrl: URL): Promise<boolean> {
    try {
      const healthEndpoint = new URL("api/health", targetUrl);
      const res = await this.fetcher(healthEndpoint.href, { method: "GET", redirect: "error" });
      if (!res.ok) return false;
      const data: unknown = await res.json();
      if (
        data !== null &&
        typeof data === "object" &&
        (data as Record<string, unknown>).service === EXPECTED_REVIEWER_SERVICE
      ) {
        return true;
      }
      return false;
    } catch {
      // Try fallback to /api/session
      try {
        const sessionEndpoint = new URL("api/session", targetUrl);
        const res = await this.fetcher(sessionEndpoint.href, { method: "GET", redirect: "error" });
        if (!res.ok) return false;
        const data: unknown = await res.json();
        if (
          data !== null &&
          typeof data === "object" &&
          (data as Record<string, unknown>).service === EXPECTED_REVIEWER_SERVICE
        ) {
          return true;
        }
      } catch {
        // Not ready
      }
      return false;
    }
  }

  /**
   * Ensure that the Reviewer sidecar is running, healthy, and ready for requests.
   * Deduplicates concurrent calls via a single startup promise.
   */
  public async ensureReady(): Promise<URL> {
    if (this.status === "ready" && this.baseUrl) {
      if (this.activeChild === null || this.activeChild.exitCode === null) {
        return this.baseUrl;
      }
    }

    if (this.startupPromise) {
      return this.startupPromise;
    }

    if (this.shutdownPromise) {
      await this.shutdownPromise;
    }

    this.startupPromise = this.startInternal();
    try {
      const url = await this.startupPromise;
      return url;
    } finally {
      this.startupPromise = null;
    }
  }

  private async startInternal(): Promise<URL> {
    this.setStatus("starting");
    this.logs.clear();

    // Check environment override first if provided
    if (this.envOverrideUrl && this.envOverrideUrl.trim().length > 0) {
      try {
        const parsed = new URL(this.envOverrideUrl.trim());
        if (!isLoopbackHost(parsed.hostname)) {
          throw new Error(`Environment override must use a loopback host, received: ${parsed.hostname}`);
        }
        const isReady = await this.checkReadiness(parsed);
        if (isReady) {
          this.baseUrl = parsed;
          this.managedPort = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === "https:" ? 443 : 80);
          this.setStatus("ready");
          return this.baseUrl;
        } else {
          throw new Error("Configured MAGINALIA_REVIEWER_BASE_URL failed readiness check or contract identity.");
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.setStatus("failed", message);
        throw new Error(`Reviewer environment override failed: ${message}`);
      }
    }

    const workspacePath = this.workspaceLocator.getWorkspacePath();

    let attempts = 0;
    let lastError: Error | null = null;

    while (attempts < MAX_PORT_RETRIES) {
      attempts += 1;
      let port: number;
      try {
        port = await findFreeLoopbackPort();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        continue;
      }

      const targetUrl = new URL(`http://127.0.0.1:${port}/`);
      let child: ChildProcess;
      try {
        child = await this.launchStrategy.spawn({
          port,
          workspacePath,
          ndlocrConfigPath: this.ndlocrConfigPath
        });
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        continue;
      }

      this.activeChild = child;
      this.managedPort = port;

      child.stdout?.on("data", (chunk: Buffer | string) => {
        this.logs.append(chunk.toString("utf-8"));
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        this.logs.append(chunk.toString("utf-8"));
      });

      // Hook unexpected exit
      child.once("exit", (code, signal) => {
        if (this.activeChild === child) {
          this.activeChild = null;
          if (this.status !== "stopping" && this.status !== "stopped") {
            const exitReason = `Reviewer process exited unexpectedly (code: ${code}, signal: ${signal})`;
            this.setStatus("failed", exitReason);
            this.baseUrl = null;
            this.managedPort = null;
          }
        }
      });

      // Wait for HTTP readiness with timeout
      const startTime = Date.now();
      let ready = false;
      let earlyExit = false;

      while (Date.now() - startTime < this.readinessTimeoutMs) {
        if (child.exitCode !== null) {
          earlyExit = true;
          break;
        }

        const ok = await this.checkReadiness(targetUrl);
        if (ok) {
          ready = true;
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, this.readinessPollIntervalMs));
      }

      if (ready) {
        this.baseUrl = targetUrl;
        this.setStatus("ready");
        return this.baseUrl;
      }

      // Cleanup failed attempt
      await terminateProcessTree(child, 1000);
      this.activeChild = null;
      this.managedPort = null;

      if (earlyExit) {
        const recent = this.logs.getRecentLines().join("\n");
        lastError = new Error(`Reviewer exited prematurely. Logs:\n${recent}`);
      } else {
        lastError = new Error(`Reviewer failed readiness check within ${this.readinessTimeoutMs}ms on port ${port}.`);
      }
    }

    const message = lastError ? lastError.message : "Failed to start Reviewer after bounded retries.";
    this.setStatus("failed", message);
    throw new Error(`Reviewer startup failed: ${message}`);
  }

  /**
   * Gracefully stop the Reviewer sidecar.
   */
  public async shutdown(): Promise<void> {
    if (this.status === "stopped" && this.activeChild === null) {
      return;
    }

    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.shutdownPromise = this.stopInternal();
    try {
      await this.shutdownPromise;
    } finally {
      this.shutdownPromise = null;
    }
  }

  private async stopInternal(): Promise<void> {
    this.setStatus("stopping");
    const child = this.activeChild;
    this.activeChild = null;
    this.baseUrl = null;
    this.managedPort = null;

    if (child && child.exitCode === null) {
      await terminateProcessTree(child, this.stopTimeoutMs);
    }

    this.setStatus("stopped");
  }

  /**
   * Restart the Reviewer process.
   */
  public async restart(): Promise<URL> {
    await this.shutdown();
    return this.ensureReady();
  }

  public getDiagnosticLogs(): readonly string[] {
    return this.logs.getRecentLines();
  }
}
