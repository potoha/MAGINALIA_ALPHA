import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  RepositoryMaterializationWorkerLauncher,
  type RepositoryMaterializationUtilityProcess,
} from "./repository-materialization-worker-launcher";
import type { RepositoryMaterializationWorkerCommand } from "./repository-materialization-worker";
import type {
  RepositoryWindowsJobAttachment,
  RepositoryWindowsJobController,
} from "./repository-windows-job";

const snapshot = {
  limitFlags: 0x2308,
  activeProcessLimit: 1,
  processMemoryBytes: 512 * 1024 * 1024,
  jobMemoryBytes: 512 * 1024 * 1024,
} as const;

// The production worker deliberately accepts only `noop`; this test-only
// command is consumed by the fake worker to exercise timeout/cancellation.
const HOLD_COMMAND = { kind: "hold" } as unknown as RepositoryMaterializationWorkerCommand;

type FakeWorkerMode = "complete" | "hold" | "crash";

class FakeUtilityProcess extends EventEmitter {
  public readonly pid = 4321;
  public readonly messages: unknown[] = [];
  public killed = false;

  public constructor(
    private readonly emitReady = true,
    private readonly mode: FakeWorkerMode = "complete",
    private readonly killEmitsExit = true,
  ) {
    super();
    queueMicrotask(() => {
      this.emit("spawn");
      if (this.emitReady) {
        this.emit("message", { kind: "ready", protocol: 1 });
      }
    });
  }

  public postMessage(message: unknown): void {
    this.messages.push(message);
    if (typeof message === "object" && message !== null
      && (message as { kind?: unknown }).kind === "start") {
      if (this.mode === "hold") return;
      if (this.mode === "crash") {
        this.emit("exit", 42);
        return;
      }
      // Emit both messages synchronously to cover the result/exit listener
      // race.  The session's persistent exit tracker must retain code 0.
      this.emit("message", {
        kind: "result",
        protocol: 1,
        requestId: "request-1",
        status: "completed",
      });
      this.emit("exit", 0);
    }
  }

  public kill(): boolean {
    this.killed = true;
    if (this.killEmitsExit) this.emit("exit", 1);
    return true;
  }
}

function makeJobController(worker: FakeUtilityProcess): {
  controller: RepositoryWindowsJobController;
  state: { attached: boolean; closed: boolean; terminated: boolean };
} {
  const state = { attached: false, closed: false, terminated: false };
  const attachment: RepositoryWindowsJobAttachment = {
    pid: worker.pid,
    snapshot,
    terminate: () => {
      state.terminated = true;
      worker.emit("exit", 1);
    },
    close: () => {
      state.closed = true;
      worker.emit("exit", 0);
    },
  };
  return {
    state,
    controller: {
      attach: (pid) => {
        expect(pid).toBe(worker.pid);
        state.attached = true;
        return attachment;
      },
    },
  };
}

describe("RepositoryMaterializationWorkerLauncher", () => {
  it("attaches before sending the one start message and survives exit race", async () => {
    let worker: FakeUtilityProcess | undefined;
    const launcher = new RepositoryMaterializationWorkerLauncher({
      workerPath: "C:\\worker.js",
      platform: "win32",
      fork: () => {
        worker = new FakeUtilityProcess();
        return worker as unknown as RepositoryMaterializationUtilityProcess;
      },
      jobController: {
        attach: (pid) => {
          expect(worker).toBeDefined();
          expect(pid).toBe(worker!.pid);
          return makeJobController(worker!).controller.attach(pid);
        },
      },
    });

    const session = await launcher.launch();
    expect(worker!.messages).toEqual([]);
    expect(await session.start()).toEqual({ kind: "completed", requestId: "request-1" });
    expect(worker!.messages).toHaveLength(1);
    expect((worker!.messages[0] as { kind: string }).kind).toBe("start");
  });

  it("closes an unattached worker through Job kill-on-close without sending start", async () => {
    let worker: FakeUtilityProcess | undefined;
    let state: { attached: boolean; closed: boolean; terminated: boolean } | undefined;
    const launcher = new RepositoryMaterializationWorkerLauncher({
      workerPath: "C:\\worker.js",
      platform: "win32",
      fork: () => {
        worker = new FakeUtilityProcess();
        return worker as unknown as RepositoryMaterializationUtilityProcess;
      },
      jobController: {
        attach: (pid) => {
          const result = makeJobController(worker!);
          state = result.state;
          return result.controller.attach(pid);
        },
      },
    });

    const session = await launcher.launch();
    const exitCode = await session.close();
    expect(exitCode).toBe(0);
    expect(state).toEqual({ attached: true, closed: true, terminated: false });
    expect(worker!.messages).toEqual([]);
  });

  it("fails closed after a bounded silent-worker startup wait", async () => {
    let worker: FakeUtilityProcess | undefined;
    const launcher = new RepositoryMaterializationWorkerLauncher({
      workerPath: "C:\\worker.js",
      platform: "win32",
      startupTimeoutMs: 5,
      fork: () => {
        worker = new FakeUtilityProcess(false);
        return worker as unknown as RepositoryMaterializationUtilityProcess;
      },
      jobController: {
        attach: (pid) => {
          expect(pid).toBe(worker!.pid);
          return makeJobController(worker!).controller.attach(pid);
        },
      },
    });

    await expect(launcher.launch()).rejects.toMatchObject({
      code: "worker-exited-before-start",
    });
    expect(worker!.killed).toBe(true);
  });

  it("keeps the launch gate closed after startup failure until exit is acknowledged", async () => {
    let worker: FakeUtilityProcess | undefined;
    let launchCount = 0;
    const launcher = new RepositoryMaterializationWorkerLauncher({
      workerPath: "C:\\worker.js",
      platform: "win32",
      startupTimeoutMs: 5,
      terminationWaitMs: 5,
      fork: () => {
        launchCount += 1;
        worker = new FakeUtilityProcess(launchCount > 1, "complete", launchCount > 1);
        return worker as unknown as RepositoryMaterializationUtilityProcess;
      },
      jobController: {
        attach: (pid) => ({
          pid,
          snapshot,
          terminate: () => { /* leave the first worker unacknowledged */ },
          close: () => {
            if (launchCount > 1) worker!.emit("exit", 0);
          },
        }),
      },
    });

    await expect(launcher.launch()).rejects.toMatchObject({ code: "worker-exited-before-start" });
    expect(worker!.killed).toBe(true);
    await expect(launcher.launch()).rejects.toMatchObject({ code: "already-active" });

    worker!.emit("exit", 1);
    const recovered = await launcher.launch();
    await expect(recovered.close()).resolves.toBe(0);
  });

  it("ends a held start on timeout and allows reuse after exit acknowledgement", async () => {
    let worker: FakeUtilityProcess | undefined;
    const launcher = new RepositoryMaterializationWorkerLauncher({
      workerPath: "C:\\worker.js",
      platform: "win32",
      executionTimeoutMs: 5,
      terminationWaitMs: 5,
      fork: () => {
        worker = new FakeUtilityProcess(true, "hold");
        return worker as unknown as RepositoryMaterializationUtilityProcess;
      },
      jobController: {
        attach: (pid) => makeJobController(worker!).controller.attach(pid),
      },
    });

    const session = await launcher.launch();
    await expect(session.start(HOLD_COMMAND)).rejects.toMatchObject({ code: "start-timeout" });
    // Termination emitted an exit acknowledgement, so reuse is now allowed.
    const recovered = await launcher.launch();
    await recovered.close();
  });

  it("cancels a held start through AbortSignal and terminates the Job", async () => {
    let worker: FakeUtilityProcess | undefined;
    const launcher = new RepositoryMaterializationWorkerLauncher({
      workerPath: "C:\\worker.js",
      platform: "win32",
      executionTimeoutMs: 5,
      terminationWaitMs: 5,
      fork: () => {
        worker = new FakeUtilityProcess(true, "hold");
        return worker as unknown as RepositoryMaterializationUtilityProcess;
      },
      jobController: {
        attach: (pid) => makeJobController(worker!).controller.attach(pid),
      },
    });

    const session = await launcher.launch();
    const controller = new AbortController();
    const pending = session.start(HOLD_COMMAND, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    const recovered = await launcher.launch();
    await recovered.close();
  });

  it("reports cancelled when direct cancel overlaps a held start", async () => {
    let worker: FakeUtilityProcess | undefined;
    const launcher = new RepositoryMaterializationWorkerLauncher({
      workerPath: "C:\\worker.js",
      platform: "win32",
      terminationWaitMs: 5,
      fork: () => {
        worker = new FakeUtilityProcess(true, "hold");
        return worker as unknown as RepositoryMaterializationUtilityProcess;
      },
      jobController: {
        attach: (pid) => makeJobController(worker!).controller.attach(pid),
      },
    });

    const session = await launcher.launch();
    const pending = session.start(HOLD_COMMAND);
    const pendingExpectation = expect(pending).rejects.toMatchObject({ code: "cancelled" });
    await expect(session.cancel()).resolves.toBe(0);
    await pendingExpectation;
    const recovered = await launcher.launch();
    await recovered.close();
  });

  it("reports a worker crash as a finite failure", async () => {
    let worker: FakeUtilityProcess | undefined;
    const launcher = new RepositoryMaterializationWorkerLauncher({
      workerPath: "C:\\worker.js",
      platform: "win32",
      terminationWaitMs: 5,
      fork: () => {
        worker = new FakeUtilityProcess(true, "crash");
        return worker as unknown as RepositoryMaterializationUtilityProcess;
      },
      jobController: {
        attach: (pid) => makeJobController(worker!).controller.attach(pid),
      },
    });

    const session = await launcher.launch();
    await expect(session.start()).rejects.toMatchObject({ code: "worker-crashed" });
  });

  it("keeps the launcher exclusive when termination is not acknowledged", async () => {
    let worker: FakeUtilityProcess | undefined;
    const state = { attached: false, closed: false, terminated: false };
    const launcher = new RepositoryMaterializationWorkerLauncher({
      workerPath: "C:\\worker.js",
      platform: "win32",
      executionTimeoutMs: 5,
      terminationWaitMs: 5,
      fork: () => {
        worker = new FakeUtilityProcess(true, "hold", false);
        return worker as unknown as RepositoryMaterializationUtilityProcess;
      },
      jobController: {
        attach: (pid) => {
          expect(pid).toBe(worker!.pid);
          const attachment: RepositoryWindowsJobAttachment = {
            pid,
            snapshot,
            terminate: () => { state.terminated = true; },
            close: () => { state.closed = true; },
          };
          state.attached = true;
          return attachment;
        },
      },
    });

    const session = await launcher.launch();
    await expect(session.start(HOLD_COMMAND)).rejects.toMatchObject({
      code: "start-timeout",
    });
    expect(state).toEqual({ attached: true, closed: true, terminated: true });
    await expect(launcher.launch()).rejects.toMatchObject({ code: "already-active" });
    worker!.emit("exit", 1);
  });
});
