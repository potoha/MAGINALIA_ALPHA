import { createRequire } from "node:module";
import {
  createRepositoryWindowsJobController,
  type RepositoryWindowsJobAttachment,
  type RepositoryWindowsJobController,
  type RepositoryWindowsJobLimits,
  type RepositoryWindowsJobSnapshot,
} from "./repository-windows-job";
import {
  REPOSITORY_MATERIALIZATION_WORKER_PROTOCOL,
  type RepositoryMaterializationWorkerCommand,
  type RepositoryMaterializationWorkerResultMessage,
} from "./repository-materialization-worker";

const nodeRequire = createRequire(__filename);
const WORKER_EXIT_WAIT_MS = 2_000;
const WORKER_READY_TIMEOUT_MS = 5_000;
const WORKER_START_TIMEOUT_MS = 30_000;
const WORKER_REQUEST_ID = "request-1";

export type RepositoryMaterializationWorkerFailureCode =
  | "unsupported-platform"
  | "already-active"
  | "launch-failed"
  | "worker-exited-before-start"
  | "job-attach-failed"
  | "protocol-mismatch"
  | "worker-exited-before-result"
  | "worker-exit-failed"
  | "job-cleanup-failed"
  | "job-terminate-failed"
  | "start-timeout"
  | "cancelled"
  | "worker-crashed"
  | "termination-unconfirmed"
  | "invalid-input";

export class RepositoryMaterializationWorkerError extends Error {
  public readonly code: RepositoryMaterializationWorkerFailureCode;
  public readonly workerExitCode: number | undefined;

  public constructor(code: RepositoryMaterializationWorkerFailureCode, workerExitCode?: number) {
    super(`Repository materialization worker failed (${code}).`);
    this.name = "RepositoryMaterializationWorkerError";
    this.code = code;
    this.workerExitCode = workerExitCode;
  }
}

export interface RepositoryMaterializationUtilityProcess {
  readonly pid: number | undefined;
  on(event: "message", listener: (message: unknown) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  on(event: "spawn", listener: () => void): this;
  on(event: "error", listener: (...args: unknown[]) => void): this;
  once(event: "exit", listener: (code: number) => void): this;
  once(event: "spawn", listener: () => void): this;
  once(event: "error", listener: (...args: unknown[]) => void): this;
  removeListener(event: "message", listener: (message: unknown) => void): this;
  removeListener(event: "exit", listener: (code: number) => void): this;
  removeListener(event: "spawn", listener: () => void): this;
  removeListener(event: "error", listener: (...args: unknown[]) => void): this;
  postMessage(message: unknown): void;
  kill(): boolean;
}

export type RepositoryMaterializationUtilityProcessFork = (
  modulePath: string,
) => RepositoryMaterializationUtilityProcess;

export type RepositoryMaterializationWorkerResult = {
  readonly kind: "completed";
  readonly requestId: string;
};

export interface RepositoryMaterializationWorkerStartOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface RepositoryMaterializationWorkerSession {
  readonly pid: number;
  readonly snapshot: RepositoryWindowsJobSnapshot;
  start(
    command?: RepositoryMaterializationWorkerCommand,
    options?: RepositoryMaterializationWorkerStartOptions,
  ): Promise<RepositoryMaterializationWorkerResult>;
  cancel(): Promise<number>;
  close(): Promise<number>;
  terminate(): Promise<number>;
}

export interface RepositoryMaterializationWorkerLauncherOptions {
  readonly workerPath: string;
  readonly platform?: NodeJS.Platform;
  readonly startupTimeoutMs?: number;
  readonly executionTimeoutMs?: number;
  readonly terminationWaitMs?: number;
  readonly limits?: RepositoryWindowsJobLimits;
  readonly fork?: RepositoryMaterializationUtilityProcessFork;
  readonly jobController?: RepositoryWindowsJobController;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isReadyMessage(value: unknown): boolean {
  return isRecord(value)
    && value.kind === "ready"
    && value.protocol === REPOSITORY_MATERIALIZATION_WORKER_PROTOCOL;
}

function isResultMessage(value: unknown): value is RepositoryMaterializationWorkerResultMessage {
  return isRecord(value)
    && value.kind === "result"
    && value.protocol === REPOSITORY_MATERIALIZATION_WORKER_PROTOCOL
    && value.requestId === WORKER_REQUEST_ID
    && value.status === "completed";
}

function defaultFork(modulePath: string): RepositoryMaterializationUtilityProcess {
  try {
    const loaded = nodeRequire("electron") as {
      readonly utilityProcess?: {
        fork(
          path: string,
          args: string[],
          options: {
            readonly env: Record<string, string>;
            readonly stdio: "ignore";
            readonly serviceName: string;
          },
        ): RepositoryMaterializationUtilityProcess;
      };
    };
    if (loaded === null || typeof loaded !== "object" || loaded.utilityProcess === undefined) {
      throw new Error("electron utilityProcess unavailable");
    }
    // Empty args/env are deliberate: operation paths and secrets travel over
    // the private start message only after containment verification.
    return loaded.utilityProcess.fork(modulePath, [], {
      env: {},
      stdio: "ignore",
      serviceName: "MAGINALIA repository materialization worker",
    });
  } catch {
    throw new RepositoryMaterializationWorkerError("launch-failed");
  }
}

function waitForExit(
  worker: RepositoryMaterializationUtilityProcess,
  timeoutMs: number = WORKER_EXIT_WAIT_MS,
  knownExitCode?: () => number | undefined,
): Promise<number | undefined> {
  const known = knownExitCode?.();
  if (known !== undefined) return Promise.resolve(known);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeListener("exit", onExit);
      resolve(code);
    };
    const onExit = (code: number): void => finish(code);
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    worker.once("exit", onExit);
  });
}

class RepositoryMaterializationWorkerSessionImpl implements RepositoryMaterializationWorkerSession {
  public readonly pid: number;
  public readonly snapshot: RepositoryWindowsJobSnapshot;

  private readonly worker: RepositoryMaterializationUtilityProcess;
  private readonly attachment: RepositoryWindowsJobAttachment;
  private readonly onSettled: () => void;
  private started = false;
  private cancelRequested = false;
  private cleanupRequested = false;
  private settledNotified = false;
  private exitAcknowledged = false;
  private exitCode: number | undefined;

  public constructor(
    worker: RepositoryMaterializationUtilityProcess,
    attachment: RepositoryWindowsJobAttachment,
    private readonly executionTimeoutMs: number,
    private readonly terminationWaitMs: number,
    onSettled: () => void,
  ) {
    if (worker.pid === undefined || worker.pid <= 0) {
      throw new RepositoryMaterializationWorkerError("launch-failed");
    }
    this.worker = worker;
    this.attachment = attachment;
    this.pid = worker.pid;
    this.snapshot = attachment.snapshot;
    this.onSettled = onSettled;
    this.worker.on("exit", (code) => {
      this.exitCode = code;
      this.exitAcknowledged = true;
      this.notifySettledIfExited();
    });
  }

  public async start(
    command: RepositoryMaterializationWorkerCommand = { kind: "noop" },
    options: RepositoryMaterializationWorkerStartOptions = {},
  ): Promise<RepositoryMaterializationWorkerResult> {
    if (this.cleanupRequested || this.started) {
      throw new RepositoryMaterializationWorkerError("protocol-mismatch");
    }
    const timeoutMs = options.timeoutMs ?? this.executionTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new RepositoryMaterializationWorkerError("invalid-input");
    }
    this.started = true;
    try {
      const result = await new Promise<RepositoryMaterializationWorkerResult>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(
          () => fail(new RepositoryMaterializationWorkerError("start-timeout")),
          timeoutMs,
        );
        const onAbort = (): void => {
          fail(new RepositoryMaterializationWorkerError("cancelled"));
        };
        const fail = (error: RepositoryMaterializationWorkerError): void => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };
        const onMessage = (message: unknown): void => {
          if (settled) return;
          if (!isResultMessage(message)) {
            fail(new RepositoryMaterializationWorkerError("protocol-mismatch"));
            return;
          }
          settled = true;
          cleanup();
          resolve({ kind: "completed", requestId: message.requestId });
        };
        const onExit = (code: number): void => {
          if (this.cancelRequested) {
            fail(new RepositoryMaterializationWorkerError("cancelled"));
          } else if (code === 0) {
            fail(new RepositoryMaterializationWorkerError("worker-exited-before-result"));
          } else {
            fail(new RepositoryMaterializationWorkerError("worker-crashed", code));
          }
        };
        const cleanup = (): void => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          this.worker.removeListener("message", onMessage);
          this.worker.removeListener("exit", onExit);
        };
        this.worker.on("message", onMessage);
        this.worker.once("exit", onExit);
        if (options.signal?.aborted) {
          onAbort();
          return;
        }
        options.signal?.addEventListener("abort", onAbort, { once: true });
        try {
          this.worker.postMessage({
            kind: "start",
            protocol: REPOSITORY_MATERIALIZATION_WORKER_PROTOCOL,
            requestId: WORKER_REQUEST_ID,
            command,
          });
        } catch {
          cleanup();
          reject(new RepositoryMaterializationWorkerError("protocol-mismatch"));
        }
      });
      const exitCode = await waitForExit(this.worker, this.terminationWaitMs, () => this.exitCode);
      if (this.cancelRequested) {
        throw new RepositoryMaterializationWorkerError("cancelled");
      }
      if (exitCode !== 0) {
        throw new RepositoryMaterializationWorkerError("worker-exit-failed");
      }
      await this.closeJob();
      this.requestCleanup();
      return result;
    } catch (error) {
      await this.terminateAfterFailure();
      throw error;
    }
  }

  public cancel(): Promise<number> {
    this.cancelRequested = true;
    return this.terminate();
  }

  public async close(): Promise<number> {
    if (this.cleanupRequested) {
      const exitCode = await waitForExit(this.worker, this.terminationWaitMs, () => this.exitCode);
      if (exitCode === undefined) {
        try { this.worker.kill(); } catch { /* fail closed */ }
        throw new RepositoryMaterializationWorkerError("termination-unconfirmed");
      }
      return exitCode;
    }
    this.requestCleanup();
    let failure: RepositoryMaterializationWorkerError | undefined;
    try {
      await this.closeJob();
    } catch {
      failure = new RepositoryMaterializationWorkerError("job-cleanup-failed");
    }
    const exitCode = await waitForExit(this.worker, this.terminationWaitMs, () => this.exitCode);
    if (exitCode === undefined) {
      try { this.worker.kill(); } catch { /* fail closed */ }
      failure ??= new RepositoryMaterializationWorkerError("termination-unconfirmed");
    }
    if (failure !== undefined) throw failure;
    return exitCode ?? 0;
  }

  public async terminate(): Promise<number> {
    if (this.cleanupRequested) {
      const exitCode = await waitForExit(this.worker, this.terminationWaitMs, () => this.exitCode);
      if (exitCode === undefined) {
        try { this.worker.kill(); } catch { /* fail closed */ }
        throw new RepositoryMaterializationWorkerError("termination-unconfirmed");
      }
      return exitCode;
    }
    this.requestCleanup();
    let failure: RepositoryMaterializationWorkerError | undefined;
    let exitCode: number | undefined;
    try {
      this.attachment.terminate(1);
    } catch {
      failure = new RepositoryMaterializationWorkerError("job-terminate-failed");
    }
    try {
      await this.closeJob();
    } catch {
      failure ??= new RepositoryMaterializationWorkerError("job-cleanup-failed");
    }
    exitCode = await waitForExit(this.worker, this.terminationWaitMs, () => this.exitCode);
    if (exitCode === undefined) {
      try { this.worker.kill(); } catch { /* fail closed */ }
      failure ??= new RepositoryMaterializationWorkerError("termination-unconfirmed");
    }
    if (failure !== undefined) throw failure;
    return exitCode ?? 0;
  }

  private async closeJob(): Promise<void> {
    try {
      this.attachment.close();
    } catch {
      throw new RepositoryMaterializationWorkerError("job-cleanup-failed");
    }
  }

  private async terminateAfterFailure(): Promise<void> {
    if (this.cleanupRequested) {
      const exitCode = await waitForExit(this.worker, this.terminationWaitMs, () => this.exitCode);
      if (exitCode === undefined) {
        try { this.worker.kill(); } catch { /* fail closed */ }
      }
      return;
    }
    this.requestCleanup();
    try {
      this.attachment.terminate(1);
    } catch {
      // The final finite error remains the original protocol/exit failure.
    }
    try {
      this.attachment.close();
    } catch {
      // No uncontained retry or fallback is permitted.
    }
    const exitCode = await waitForExit(this.worker, this.terminationWaitMs, () => this.exitCode);
    if (exitCode === undefined) {
      try { this.worker.kill(); } catch { /* fail closed */ }
    }
  }

  private requestCleanup(): void {
    this.cleanupRequested = true;
    this.notifySettledIfExited();
  }

  private notifySettledIfExited(): void {
    if (!this.cleanupRequested || !this.exitAcknowledged || this.settledNotified) return;
    this.settledNotified = true;
    this.onSettled();
  }
}

export class RepositoryMaterializationWorkerLauncher {
  private readonly options: RepositoryMaterializationWorkerLauncherOptions;
  private active = false;

  public constructor(options: RepositoryMaterializationWorkerLauncherOptions) {
    this.options = options;
  }

  public async launch(): Promise<RepositoryMaterializationWorkerSession> {
    if (this.active) {
      throw new RepositoryMaterializationWorkerError("already-active");
    }
    this.active = true;
    const platform = this.options.platform ?? process.platform;
    if (platform !== "win32") {
      this.active = false;
      throw new RepositoryMaterializationWorkerError("unsupported-platform");
    }

    let worker: RepositoryMaterializationUtilityProcess | undefined;
    let attachment: RepositoryWindowsJobAttachment | undefined;
    let workerExitCode: number | undefined;
    let workerExitAcknowledged = false;
    let launchCleanupRequested = false;
    try {
      worker = (this.options.fork ?? defaultFork)(this.options.workerPath);
      worker.on("exit", (code) => {
        workerExitCode = code;
        workerExitAcknowledged = true;
        if (launchCleanupRequested) this.active = false;
      });
      let controller: RepositoryWindowsJobController;
      try {
        controller = this.options.jobController
          ?? createRepositoryWindowsJobController({ platform });
      } catch {
        throw new RepositoryMaterializationWorkerError("job-attach-failed");
      }
      attachment = await this.waitForSpawnAndReady(worker, (pid) => {
        attachment = controller.attach(pid, this.options.limits);
        return attachment;
      }, this.options.startupTimeoutMs);
      const session = new RepositoryMaterializationWorkerSessionImpl(
        worker,
        attachment,
        this.options.executionTimeoutMs ?? WORKER_START_TIMEOUT_MS,
        this.options.terminationWaitMs ?? WORKER_EXIT_WAIT_MS,
        () => { this.active = false; },
      );
      attachment = undefined;
      return session;
    } catch (error) {
      launchCleanupRequested = true;
      if (attachment !== undefined) {
        try { attachment.terminate(1); } catch { /* fail closed */ }
        try { attachment.close(); } catch { /* fail closed */ }
      }
      if (worker !== undefined) {
        try { worker.kill(); } catch { /* fail closed */ }
        await waitForExit(
          worker,
          this.options.terminationWaitMs ?? WORKER_EXIT_WAIT_MS,
          () => workerExitCode,
        );
        if (workerExitAcknowledged || workerExitCode !== undefined) {
          this.active = false;
        }
      } else {
        this.active = false;
      }
      if (error instanceof RepositoryMaterializationWorkerError) throw error;
      throw new RepositoryMaterializationWorkerError("launch-failed");
    }
  }

  private async waitForSpawnAndReady(
    worker: RepositoryMaterializationUtilityProcess,
    attach: (pid: number) => RepositoryWindowsJobAttachment,
    timeoutMs: number = WORKER_READY_TIMEOUT_MS,
  ): Promise<RepositoryWindowsJobAttachment> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let spawned = false;
      let ready = false;
      let attachment: RepositoryWindowsJobAttachment | undefined;
      const timer = setTimeout(() => finish(false), timeoutMs);
      const finish = (success: boolean, error?: RepositoryMaterializationWorkerError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.removeListener("message", onMessage);
        worker.removeListener("exit", onExit);
        worker.removeListener("error", onError);
        worker.removeListener("spawn", onSpawn);
        if (success && attachment !== undefined) resolve(attachment);
        else reject(error ?? new RepositoryMaterializationWorkerError("worker-exited-before-start"));
      };
      const onSpawn = (): void => {
        spawned = true;
        try {
          const pid = worker.pid;
          if (pid === undefined || pid <= 0) {
            finish(false, new RepositoryMaterializationWorkerError("launch-failed"));
            return;
          }
          attachment = attach(pid);
        } catch {
          finish(false, new RepositoryMaterializationWorkerError("job-attach-failed"));
          return;
        }
        if (ready) finish(true);
      };
      const onMessage = (message: unknown): void => {
        if (!isReadyMessage(message)) {
          finish(false, new RepositoryMaterializationWorkerError("protocol-mismatch"));
          return;
        }
        ready = true;
        if (spawned && attachment !== undefined) finish(true);
      };
      const onExit = (): void => finish(false);
      const onError = (): void => finish(false, new RepositoryMaterializationWorkerError("launch-failed"));
      worker.once("spawn", onSpawn);
      worker.on("message", onMessage);
      worker.once("exit", onExit);
      worker.once("error", onError);
    });
  }
}
