/**
 * Test-only utility worker.  It deliberately holds or triggers fixed resource
 * conditions after the explicit start gate so the parent can exercise bounded
 * cleanup.  Production code must use repository-materialization-worker.ts
 * instead.
 */

import { spawn } from "node:child_process";

const REPOSITORY_MATERIALIZATION_WORKER_PROTOCOL = 1 as const;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

type FixturePort = {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: unknown) => void): unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unwrapMessage(value: unknown): unknown {
  if (isRecord(value) && "data" in value) return value.data;
  return value;
}

function getParentPort(): FixturePort | undefined {
  return (process as unknown as { readonly parentPort?: FixturePort }).parentPort;
}

const MEMORY_TRIGGER_BYTES = 160 * 1024 * 1024;

function triggerMemoryLimit(): void {
  try {
    // Fill the allocation so the test asks Windows to commit the pages rather
    // than merely reserving virtual address space.  The parent applies the
    // bounded memory policy before this command is accepted.
    const allocation = Buffer.alloc(MEMORY_TRIGGER_BYTES, 0xa5);
    void allocation;
    // Reaching this branch means the fixed trigger did not hit the policy.
    // Exit cleanly so the parent reports a finite limit-not-enforced result,
    // rather than mistaking an intentional fixture exit for a crash.
    process.exit(0);
  } catch {
    process.exit(42);
  }
}

function triggerProcessLimit(): void {
  let settled = false;
  const finish = (exitCode: number): void => {
    if (settled) return;
    settled = true;
    process.exit(exitCode);
  };

  try {
    // No shell or inherited command is involved.  With the parent Job's
    // active-process limit of one, Windows must reject/terminate this child.
    const child = spawn(process.execPath, ["--version"], {
      env: {},
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", (error: unknown) => {
      const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
      if (code === "EAGAIN") finish(43);
      else if (code === "EPERM") finish(44);
      else if (code === "EACCES") finish(45);
      else finish(47);
    });
    child.once("exit", (code: number | null) => finish(code === 0 ? 0 : 43));
    setTimeout(() => finish(48), 1_000);
  } catch {
    finish(46);
  }
}

const parentPort = getParentPort();
if (parentPort !== undefined) {
  parentPort.postMessage({
    kind: "ready",
    protocol: REPOSITORY_MATERIALIZATION_WORKER_PROTOCOL,
  });
  parentPort.on("message", (event) => {
    const message = unwrapMessage(event);
    if (!isRecord(message)
      || message.kind !== "start"
      || message.protocol !== REPOSITORY_MATERIALIZATION_WORKER_PROTOCOL
      || typeof message.requestId !== "string"
      || !REQUEST_ID_PATTERN.test(message.requestId)
      || !isRecord(message.command)
      || typeof message.command.kind !== "string"
      || !["hold", "memory-limit", "process-limit"].includes(message.command.kind)) {
      return;
    }
    if (message.command.kind === "hold") {
      // Keep the worker alive until the parent timeout/cancel terminates its Job.
      return;
    }
    if (message.command.kind === "memory-limit") {
      triggerMemoryLimit();
      return;
    }
    triggerProcessLimit();
  });
}
