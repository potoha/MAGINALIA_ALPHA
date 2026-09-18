import { describe, expect, it } from "vitest";
import {
  createRepositoryWindowsJobController,
  DEFAULT_REPOSITORY_WINDOWS_JOB_LIMITS,
} from "./repository-windows-job";

const LIMIT_FLAGS = 0x2308;

function makeNativeApi(): {
  readonly api: {
    createJobObject(): bigint;
    setExtendedLimits(job: bigint, limits: typeof DEFAULT_REPOSITORY_WINDOWS_JOB_LIMITS): boolean;
    queryExtendedLimits(job: bigint): typeof DEFAULT_REPOSITORY_WINDOWS_JOB_LIMITS & {
      readonly limitFlags: number;
    };
    openProcess(pid: number): bigint;
    assignProcessToJob(job: bigint, process: bigint): boolean;
    isProcessInJob(job: bigint, process: bigint): boolean;
    terminateJobObject(job: bigint, exitCode: number): boolean;
    closeHandle(handle: bigint): boolean;
    getLastError(): number;
  };
  readonly createdJobs: bigint[];
  readonly terminatedJobs: bigint[];
} {
  let nextJob = 100n;
  const jobs = new Map<bigint, typeof DEFAULT_REPOSITORY_WINDOWS_JOB_LIMITS>();
  const processJobs = new Map<bigint, bigint>();
  const createdJobs: bigint[] = [];
  const terminatedJobs: bigint[] = [];

  const api = {
    createJobObject: (): bigint => {
      const job = nextJob;
      nextJob += 1n;
      createdJobs.push(job);
      return job;
    },
    setExtendedLimits: (
      job: bigint,
      limits: typeof DEFAULT_REPOSITORY_WINDOWS_JOB_LIMITS,
    ): boolean => {
      jobs.set(job, limits);
      return true;
    },
    queryExtendedLimits: (job: bigint) => {
      const limits = jobs.get(job);
      if (limits === undefined) throw new Error("missing job");
      return { ...limits, limitFlags: LIMIT_FLAGS };
    },
    openProcess: (pid: number): bigint => BigInt(pid) + 10_000n,
    assignProcessToJob: (job: bigint, process: bigint): boolean => {
      processJobs.set(process, job);
      return true;
    },
    isProcessInJob: (job: bigint, process: bigint): boolean => processJobs.get(process) === job,
    terminateJobObject: (job: bigint, _exitCode: number): boolean => {
      terminatedJobs.push(job);
      return true;
    },
    closeHandle: (_handle: bigint): boolean => true,
    getLastError: (): number => 0,
  };

  return { api, createdJobs, terminatedJobs };
}

describe("repository Windows Job bridge", () => {
  it("keeps bindings/controller instances reusable while each attachment owns its Job", () => {
    const fake = makeNativeApi();
    const firstController = createRepositoryWindowsJobController({
      platform: "win32",
      nativeApi: fake.api,
    });
    const secondController = createRepositoryWindowsJobController({
      platform: "win32",
      nativeApi: fake.api,
    });

    const first = firstController.attach(101);
    const second = secondController.attach(102);

    expect(fake.createdJobs).toEqual([100n, 101n]);
    expect(first.pid).toBe(101);
    expect(second.pid).toBe(102);
    expect(first.snapshot).toEqual({
      ...DEFAULT_REPOSITORY_WINDOWS_JOB_LIMITS,
      limitFlags: LIMIT_FLAGS,
    });
    expect(second.snapshot).toEqual(first.snapshot);

    first.terminate();
    first.close();
    second.close();
    expect(fake.terminatedJobs).toEqual([100n]);
  });
});
