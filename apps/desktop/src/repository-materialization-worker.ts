/**
 * One-shot utility-process entrypoint.  This file intentionally has no Git,
 * filesystem, or network imports: remote work is not allowed before the
 * parent sends the explicit start message after Job Object verification.
 */

export const REPOSITORY_MATERIALIZATION_WORKER_PROTOCOL = 1 as const;

export type RepositoryMaterializationWorkerCommand =
  { readonly kind: "noop" };

export type RepositoryMaterializationWorkerReadyMessage = {
  readonly kind: "ready";
  readonly protocol: typeof REPOSITORY_MATERIALIZATION_WORKER_PROTOCOL;
};

export type RepositoryMaterializationWorkerStartMessage = {
  readonly kind: "start";
  readonly protocol: typeof REPOSITORY_MATERIALIZATION_WORKER_PROTOCOL;
  readonly requestId: string;
  readonly command: RepositoryMaterializationWorkerCommand;
};

export type RepositoryMaterializationWorkerResultMessage = {
  readonly kind: "result";
  readonly protocol: typeof REPOSITORY_MATERIALIZATION_WORKER_PROTOCOL;
  readonly requestId: string;
  readonly status: "completed";
};

export type RepositoryMaterializationWorkerMessage =
  | RepositoryMaterializationWorkerReadyMessage
  | RepositoryMaterializationWorkerResultMessage;

export interface RepositoryMaterializationWorkerPort {
  postMessage(message: RepositoryMaterializationWorkerMessage): void;
  on(event: "message", listener: (event: unknown) => void): unknown;
}

export interface RepositoryMaterializationWorkerRuntime {
  readonly exit?: (code: number) => void;
  readonly scheduleExit?: (callback: () => void) => unknown;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unwrapMessage(value: unknown): unknown {
  if (isRecord(value) && "data" in value) return value.data;
  return value;
}

function isStartMessage(value: unknown): value is RepositoryMaterializationWorkerStartMessage {
  if (!isRecord(value)
    || value.kind !== "start"
    || value.protocol !== REPOSITORY_MATERIALIZATION_WORKER_PROTOCOL
    || typeof value.requestId !== "string"
    || !REQUEST_ID_PATTERN.test(value.requestId)
    || !isRecord(value.command)
    || value.command.kind !== "noop") {
    return false;
  }
  return true;
}

function getUtilityParentPort(): RepositoryMaterializationWorkerPort | undefined {
  const candidate = (process as unknown as {
    readonly parentPort?: RepositoryMaterializationWorkerPort;
  }).parentPort;
  return candidate;
}

/**
 * Install the worker protocol on a parent port.  Exported for protocol tests;
 * the real utility entrypoint below calls it only when Electron supplied a
 * parent port.
 */
export function installRepositoryMaterializationWorker(
  port: RepositoryMaterializationWorkerPort,
  runtime: RepositoryMaterializationWorkerRuntime = {},
): void {
  let started = false;
  let finished = false;
  const exit = runtime.exit ?? ((code: number) => process.exit(code));
  const scheduleExit = runtime.scheduleExit ?? ((callback: () => void) => setTimeout(callback, 0));

  port.postMessage({
    kind: "ready",
    protocol: REPOSITORY_MATERIALIZATION_WORKER_PROTOCOL,
  });

  const finish = (message: RepositoryMaterializationWorkerResultMessage): void => {
    if (finished) return;
    finished = true;
    port.postMessage(message);
    scheduleExit(() => exit(0));
  };

  port.on("message", (event) => {
    if (started || finished) return;
    const message = unwrapMessage(event);
    if (!isStartMessage(message)) {
      // Invalid input cannot cause work or expose an error.  The parent treats
      // an unexpected protocol response as a finite failure and kills the job.
      return;
    }
    started = true;
    finish({
      kind: "result",
      protocol: REPOSITORY_MATERIALIZATION_WORKER_PROTOCOL,
      requestId: message.requestId,
      status: "completed",
    });
  });
}

const utilityParentPort = getUtilityParentPort();
if (utilityParentPort !== undefined) {
  installRepositoryMaterializationWorker(utilityParentPort);
}
