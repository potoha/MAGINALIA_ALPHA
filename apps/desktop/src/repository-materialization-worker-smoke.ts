import { app } from "electron";
import { spawn } from "node:child_process";
import * as path from "node:path";
import {
  RepositoryMaterializationWorkerError,
  RepositoryMaterializationWorkerLauncher,
} from "./repository-materialization-worker-launcher";
import type { RepositoryMaterializationWorkerCommand } from "./repository-materialization-worker";
import { createRepositoryWindowsJobController } from "./repository-windows-job";

const RESOURCE_MEMORY_LIMIT_BYTES = 128 * 1024 * 1024;

function runProcessSpawnControl(): Promise<number> {
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(process.execPath, ["--version"], {
        env: {},
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? -1));
    } catch (error) {
      reject(error);
    }
  });
}

function runMemoryAllocationControl(): number {
  const allocation = Buffer.alloc(RESOURCE_MEMORY_LIMIT_BYTES + 32 * 1024 * 1024, 0xa5);
  return allocation.length;
}

function fail(error: unknown): never {
  const code = error instanceof RepositoryMaterializationWorkerError
    ? error.code
    : "unknown";
  console.error(`MAGINALIA_WORKER_JOB_SMOKE_FAILED ${code}`);
  app.exit(1);
  throw new Error("unreachable");
}

void app.whenReady().then(async () => {
  const workerPath = path.join(__dirname, "repository-materialization-worker.js");
  const testWorkerPath = path.join(__dirname, "repository-materialization-worker-test-fixture.js");
  const jobController = createRepositoryWindowsJobController();
  const timeoutJobController = createRepositoryWindowsJobController();
  const memoryJobController = createRepositoryWindowsJobController();
  const processJobController = createRepositoryWindowsJobController();
  const launcher = new RepositoryMaterializationWorkerLauncher({
    workerPath,
    jobController,
  });
  try {
    const session = await launcher.launch();
    console.log(
      "MAGINALIA_WORKER_JOB_ATTACH_OK"
      + ` pid=${session.pid}`
      + ` flags=${session.snapshot.limitFlags}`
      + ` activeProcessLimit=${session.snapshot.activeProcessLimit}`
      + ` processMemoryBytes=${session.snapshot.processMemoryBytes}`
      + ` jobMemoryBytes=${session.snapshot.jobMemoryBytes}`,
    );
    const result = await session.start({ kind: "noop" });
    console.log(`MAGINALIA_WORKER_START_OK requestId=${result.requestId}`);

    const closeSession = await launcher.launch();
    const closePid = closeSession.pid;
    const closeExitCode = await closeSession.close();
    console.log(`MAGINALIA_WORKER_JOB_CLOSE_OK pid=${closePid} exitCode=${closeExitCode}`);

    const timeoutLauncher = new RepositoryMaterializationWorkerLauncher({
      workerPath: testWorkerPath,
      jobController: timeoutJobController,
    });
    const hungSession = await timeoutLauncher.launch();
    const hungPid = hungSession.pid;
    try {
      const holdCommand = { kind: "hold" } as unknown as RepositoryMaterializationWorkerCommand;
      await hungSession.start(holdCommand, { timeoutMs: 100 });
      throw new Error("hung worker unexpectedly completed");
    } catch (error) {
      if (!(error instanceof RepositoryMaterializationWorkerError)
        || error.code !== "start-timeout") {
        throw error;
      }
      console.log(`MAGINALIA_WORKER_TIMEOUT_OK pid=${hungPid} code=${error.code}`);
    }
    const afterTimeout = await timeoutLauncher.launch();
    const afterTimeoutPid = afterTimeout.pid;
    const afterTimeoutExitCode = await afterTimeout.close();
    console.log(
      `MAGINALIA_WORKER_TIMEOUT_REUSE_OK pid=${afterTimeoutPid} exitCode=${afterTimeoutExitCode}`,
    );

    const processControlExitCode = await runProcessSpawnControl();
    if (processControlExitCode !== 0) {
      throw new Error(`process control failed (${processControlExitCode})`);
    }
    console.log("MAGINALIA_WORKER_PROCESS_CONTROL_OK exitCode=0");

    const memoryControlBytes = runMemoryAllocationControl();
    if (memoryControlBytes <= RESOURCE_MEMORY_LIMIT_BYTES) {
      throw new Error("memory control did not allocate beyond the worker policy");
    }
    console.log(`MAGINALIA_WORKER_MEMORY_CONTROL_OK bytes=${memoryControlBytes}`);

    const memoryLauncher = new RepositoryMaterializationWorkerLauncher({
      workerPath: testWorkerPath,
      jobController: memoryJobController,
      limits: {
        processMemoryBytes: RESOURCE_MEMORY_LIMIT_BYTES,
        jobMemoryBytes: RESOURCE_MEMORY_LIMIT_BYTES,
        activeProcessLimit: 1,
      },
    });
    const memorySession = await memoryLauncher.launch();
    const memoryPid = memorySession.pid;
    try {
      const memoryCommand = { kind: "memory-limit" } as unknown as RepositoryMaterializationWorkerCommand;
      await memorySession.start(memoryCommand, { timeoutMs: 5_000 });
      throw new Error("memory limit fixture unexpectedly completed");
    } catch (error) {
      if (!(error instanceof RepositoryMaterializationWorkerError)
        || error.code !== "worker-crashed") {
        throw error;
      }
      console.log(
        `MAGINALIA_WORKER_MEMORY_LIMIT_OK pid=${memoryPid}`
        + ` limitBytes=${RESOURCE_MEMORY_LIMIT_BYTES}`
        + ` exitCode=${error.workerExitCode ?? "unknown"}`
        + ` code=${error.code}`,
      );
    }

    const processLauncher = new RepositoryMaterializationWorkerLauncher({
      workerPath: testWorkerPath,
      jobController: processJobController,
    });
    const processSession = await processLauncher.launch();
    const processPid = processSession.pid;
    try {
      const processCommand = { kind: "process-limit" } as unknown as RepositoryMaterializationWorkerCommand;
      await processSession.start(processCommand, { timeoutMs: 5_000 });
      throw new Error("process limit fixture unexpectedly completed");
    } catch (error) {
      if (!(error instanceof RepositoryMaterializationWorkerError)
        || error.code !== "worker-crashed"
        || ![43, 44, 45, 46].includes(error.workerExitCode ?? -1)) {
        throw error;
      }
      console.log(
        `MAGINALIA_WORKER_PROCESS_LIMIT_OK pid=${processPid}`
        + " activeProcessLimit=1"
        + ` exitCode=${error.workerExitCode}`
        + ` code=${error.code}`,
      );
    }
    console.log("MAGINALIA_WORKER_JOB_SMOKE_OK");
    app.exit(0);
  } catch (error) {
    fail(error);
  }
});
