import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

export type ReviewerStatus = "stopped" | "starting" | "ready" | "failed" | "stopping";

export interface ReviewerLaunchOptions {
  readonly port: number;
  readonly workspacePath: string;
  readonly ndlocrConfigPath?: string;
  /** A generated packaged copy may be supplied later. Source uses sidecars/contracts. */
  readonly contractsDir?: string;
  /** Per-process secret for the private loopback cooperative-stop endpoint. */
  readonly desktopShutdownToken?: string;
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
  readonly contractsDir?: string;
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
  /** Diagnostic-only attempted configuration path; it contains no secret. */
  readonly ndlocrConfigPath: string | null;
}

export const EXPECTED_REVIEWER_SERVICE = "maginalia-reviewer";
export const EXPECTED_CONTRACT_VERSION = 1;
export const MAX_PORT_RETRIES = 5;
const MAX_LOG_LINES = 100;

class ReviewerStartupCancelledError extends Error {
  public constructor() {
    super("Reviewer startup was cancelled because the application is shutting down.");
    this.name = "ReviewerStartupCancelledError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The exact health payload accepted from a managed Reviewer sidecar. */
export function isExpectedReviewerReadinessPayload(value: unknown): boolean {
  return isRecord(value)
    && value.service === EXPECTED_REVIEWER_SERVICE
    && value.contractVersion === EXPECTED_CONTRACT_VERSION;
}

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
export class UserDataReviewerWorkspaceLocator implements ReviewerWorkspaceLocator {
  public constructor(private readonly userDataPath: string) {}

  public getWorkspacePath(): string {
    if (!path.isAbsolute(this.userDataPath)) {
      throw new Error("Reviewer userData path must be absolute.");
    }
    const target = path.join(this.userDataPath, "reviewer");
    fs.mkdirSync(target, { recursive: true });
    return target;
  }
}

/**
 * Non-Electron fallback for isolated tests and development tools. Production
 * main-process code must inject UserDataReviewerWorkspaceLocator.
 */
export class DefaultReviewerWorkspaceLocator implements ReviewerWorkspaceLocator {
  public constructor(private readonly workspacePath = path.join(
    process.env.LOCALAPPDATA ?? process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Local"),
    "MAGINALIA",
    "reviewer"
  )) {}

  public getWorkspacePath(): string {
    if (!path.isAbsolute(this.workspacePath)) {
      throw new Error("Reviewer workspace path must be absolute.");
    }
    fs.mkdirSync(this.workspacePath, { recursive: true });
    return this.workspacePath;
  }
}

function isReviewerRoot(candidate: string): boolean {
  return fs.existsSync(path.join(candidate, "pyproject.toml"))
    && fs.existsSync(path.join(candidate, "src", "marginalia_reviewer", "__main__.py"));
}

/**
 * Resolve only known repository layouts. Never use process.cwd() as a hidden
 * runtime authority: built Electron and source tests have different locations.
 */
export function resolveDevelopmentReviewerRoot(fromDir = __dirname): string {
  const candidates = [
    // apps/desktop/dist/main -> repository root
    path.resolve(fromDir, "..", "..", "..", "..", "sidecars", "reviewer"),
    // apps/desktop/src when directly loaded by a TypeScript test runner
    path.resolve(fromDir, "..", "..", "..", "sidecars", "reviewer")
  ];
  const found = candidates.find(isReviewerRoot);
  if (!found) {
    throw new Error("Reviewer development runtime was not found in the expected MAGINALIA layout.");
  }
  return found;
}

/** Default Python development launch strategy for the Reviewer sidecar. */
export class PythonReviewerLaunchStrategy implements ReviewerLaunchStrategy {
  private readonly reviewerRoot: string;

  public constructor(reviewerRoot?: string) {
    this.reviewerRoot = reviewerRoot ?? resolveDevelopmentReviewerRoot();
    if (!isReviewerRoot(this.reviewerRoot)) {
      throw new Error("Reviewer development runtime is incomplete.");
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
      PYTHONUNBUFFERED: "1",
      // D032: managed Desktop Reviewer must not expose legacy publishing.
      MARGINALIA_REVIEWER_ENABLE_LEGACY_GITHUB: "0",
      ...(options.desktopShutdownToken
        ? { MARGINALIA_REVIEWER_DESKTOP_SHUTDOWN_TOKEN: options.desktopShutdownToken }
        : {}),
      ...(options.contractsDir ? { MARGINALIA_CONTRACTS_DIR: options.contractsDir } : {})
    };

    return spawn(command, args, {
      cwd: this.reviewerRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
  }
}

/**
 * Future installer seam. It intentionally accepts an explicit executable and
 * does not choose a Python/packaging technology for the product.
 */
export class PackagedReviewerLaunchStrategy implements ReviewerLaunchStrategy {
  public constructor(private readonly executablePath: string) {}

  public spawn(options: ReviewerLaunchOptions): ChildProcess {
    if (!path.isAbsolute(this.executablePath) || !fs.existsSync(this.executablePath)) {
      throw new Error("Packaged Reviewer runtime is unavailable.");
    }
    const args = ["--port", String(options.port), "--workspace", options.workspacePath, "--no-browser", "--log-level", "info"];
    if (options.ndlocrConfigPath) args.push("--ndlocr-config", options.ndlocrConfigPath);
    return spawn(this.executablePath, args, {
      cwd: path.dirname(this.executablePath),
      env: {
        ...process.env,
        ...options.env,
        MARGINALIA_REVIEWER_ENABLE_LEGACY_GITHUB: "0",
        ...(options.desktopShutdownToken
          ? { MARGINALIA_REVIEWER_DESKTOP_SHUTDOWN_TOKEN: options.desktopShutdownToken }
          : {}),
        ...(options.contractsDir ? { MARGINALIA_CONTRACTS_DIR: options.contractsDir } : {})
      },
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
function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

export async function terminateProcessTree(child: ChildProcess, timeoutMs = 3000): Promise<void> {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.killed) return;

  if (process.platform === "win32" && typeof pid === "number") {
    // Node's Windows SIGTERM is process termination, not a cooperative Unix
    // signal. The normal manager path has already attempted authenticated HTTP
    // shutdown; this function is therefore force-only cleanup on Windows.
    try {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
      killer.on("error", () => {});
    } catch {
      // Ignore
    }
    if (!await waitForChildExit(child, Math.min(timeoutMs, 1_000)) && child.exitCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore
      }
    }
    return;
  }

  // POSIX retains the conventional bounded SIGTERM/SIGKILL fallback.
  try {
    child.kill("SIGTERM");
  } catch {
    // Ignore
  }
  if (await waitForChildExit(child, timeoutMs)) return;
  if (child.exitCode === null) {
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
  /** Blocks new work during shutdown and invalidates already-starting work. */
  private acceptingWork = true;
  private lifecycleGeneration = 0;
  private activeShutdownToken: string | null = null;
  private lastShutdownUsedCooperativeEndpoint = false;

  private readonly launchStrategy: ReviewerLaunchStrategy;
  private readonly workspaceLocator: ReviewerWorkspaceLocator;
  private readonly ndlocrConfigPath?: string;
  private readonly contractsDir?: string;
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
    this.contractsDir = options.contractsDir;
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
      error: this.lastError,
      ndlocrConfigPath: this.ndlocrConfigPath ?? null,
    };
  }

  public getBaseUrl(): URL | null {
    return this.baseUrl;
  }

  /** Diagnostic-only lifecycle evidence; it never reveals the shutdown token. */
  public wasLastShutdownCooperative(): boolean {
    return this.lastShutdownUsedCooperativeEndpoint;
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
   * Confirms HTTP 200 plus the exact service and supported contract version.
   */
  public async checkReadiness(targetUrl: URL): Promise<boolean> {
    try {
      const healthEndpoint = new URL("api/health", targetUrl);
      const res = await this.fetcher(healthEndpoint.href, { method: "GET", redirect: "error" });
      if (!res.ok) return false;
      const data: unknown = await res.json();
      return isExpectedReviewerReadinessPayload(data);
    } catch {
      // Try fallback to /api/session
      try {
        const sessionEndpoint = new URL("api/session", targetUrl);
        const res = await this.fetcher(sessionEndpoint.href, { method: "GET", redirect: "error" });
        if (!res.ok) return false;
        const data: unknown = await res.json();
        return isExpectedReviewerReadinessPayload(data);
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
    if (!this.acceptingWork) {
      throw new ReviewerStartupCancelledError();
    }

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

    const generation = this.lifecycleGeneration;
    this.startupPromise = this.startInternal(generation);
    try {
      const url = await this.startupPromise;
      return url;
    } finally {
      this.startupPromise = null;
    }
  }

  private isAdmissionOpen(generation: number): boolean {
    return this.acceptingWork && this.lifecycleGeneration === generation;
  }

  private requireAdmission(generation: number): void {
    if (!this.isAdmissionOpen(generation)) {
      throw new ReviewerStartupCancelledError();
    }
  }

  private async startInternal(generation: number): Promise<URL> {
    this.requireAdmission(generation);
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
        this.requireAdmission(generation);
        if (isReady) {
          this.baseUrl = parsed;
          this.managedPort = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === "https:" ? 443 : 80);
          this.setStatus("ready");
          return this.baseUrl;
        } else {
          throw new Error("Configured MAGINALIA_REVIEWER_BASE_URL failed readiness check or contract identity.");
        }
      } catch (err: unknown) {
        if (err instanceof ReviewerStartupCancelledError) {
          throw err;
        }
        const message = err instanceof Error ? err.message : String(err);
        this.setStatus("failed", message);
        throw new Error(`Reviewer environment override failed: ${message}`);
      }
    }

    const workspacePath = this.workspaceLocator.getWorkspacePath();

    let attempts = 0;
    let lastError: Error | null = null;

    while (attempts < MAX_PORT_RETRIES) {
      this.requireAdmission(generation);
      attempts += 1;
      let port: number;
      try {
        port = await findFreeLoopbackPort();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        continue;
      }

      const targetUrl = new URL(`http://127.0.0.1:${port}/`);
      // This secret is generated for one owned child only. It is passed through
      // the child environment, never a renderer API, URL, or diagnostics.
      const desktopShutdownToken = randomBytes(32).toString("base64url");
      let child: ChildProcess;
      try {
        child = await this.launchStrategy.spawn({
          port,
          workspacePath,
          ndlocrConfigPath: this.ndlocrConfigPath,
          contractsDir: this.contractsDir,
          desktopShutdownToken
        });
      } catch (err) {
        this.requireAdmission(generation);
        lastError = err instanceof Error ? err : new Error(String(err));
        continue;
      }

      // Shutdown can begin while an asynchronous launcher is resolving. Do
      // not publish that child as managed work; terminate it before returning.
      if (!this.isAdmissionOpen(generation)) {
        await terminateProcessTree(child, this.stopTimeoutMs);
        throw new ReviewerStartupCancelledError();
      }

      this.activeChild = child;
      this.activeShutdownToken = desktopShutdownToken;
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
          this.activeShutdownToken = null;
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
        if (!this.isAdmissionOpen(generation)) {
          break;
        }
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

      if (!this.isAdmissionOpen(generation)) {
        if (this.activeChild === child) {
          this.activeChild = null;
          this.activeShutdownToken = null;
          this.baseUrl = null;
          this.managedPort = null;
        }
        await terminateProcessTree(child, this.stopTimeoutMs);
        throw new ReviewerStartupCancelledError();
      }

      if (ready) {
        this.baseUrl = targetUrl;
        this.setStatus("ready");
        return this.baseUrl;
      }

      // Cleanup failed attempt
      await terminateProcessTree(child, 1000);
      this.activeChild = null;
      this.activeShutdownToken = null;
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
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    // From this point no caller may begin a new start. A concurrent start is
    // invalidated by generation and is awaited before shutdown resolves.
    this.acceptingWork = false;
    this.lifecycleGeneration += 1;
    const startup = this.startupPromise;
    this.shutdownPromise = this.stopInternal(startup);
    try {
      await this.shutdownPromise;
    } finally {
      this.shutdownPromise = null;
    }
  }

  private async stopInternal(startup: Promise<URL> | null): Promise<void> {
    this.setStatus("stopping");
    const child = this.activeChild;
    const baseUrl = this.baseUrl;
    const shutdownToken = this.activeShutdownToken;
    this.activeChild = null;
    this.baseUrl = null;
    this.managedPort = null;
    this.activeShutdownToken = null;
    this.lastShutdownUsedCooperativeEndpoint = false;

    if (child && child.exitCode === null) {
      if (baseUrl && shutdownToken && await this.requestCooperativeShutdown(baseUrl, shutdownToken)) {
        this.lastShutdownUsedCooperativeEndpoint = true;
        if (!await waitForChildExit(child, this.stopTimeoutMs)) {
          await terminateProcessTree(child, this.stopTimeoutMs);
        }
      } else {
        await terminateProcessTree(child, this.stopTimeoutMs);
      }
    }

    if (startup) {
      await startup.catch(() => undefined);
    }

    this.setStatus("stopped");
  }

  /**
   * Ask only an owned, ready loopback sidecar to leave. A 202 response is the
   * contract acknowledgement; anything else falls back to bounded cleanup.
   */
  private async requestCooperativeShutdown(baseUrl: URL, token: string): Promise<boolean> {
    try {
      const endpoint = new URL("api/desktop/shutdown", baseUrl);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(this.stopTimeoutMs, 1_500));
      try {
        const response = await this.fetcher(endpoint.href, {
          method: "POST",
          headers: { "X-Maginalia-Reviewer-Shutdown-Token": token },
          redirect: "error",
          signal: controller.signal
        });
        return response.status === 202;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }

  /**
   * Restart the Reviewer process.
   */
  public async restart(): Promise<URL> {
    await this.shutdown();
    this.acceptingWork = true;
    return this.ensureReady();
  }

  public getDiagnosticLogs(): readonly string[] {
    return this.logs.getRecentLines();
  }

  /** Main-process-only shared secret for narrow Desktop bridge requests. */
  public getDesktopRequestToken(): string | null {
    return this.activeShutdownToken;
  }
}
