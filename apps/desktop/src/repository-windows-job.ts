import { createRequire } from "node:module";

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9;
const JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x0008;
const JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x0100;
const JOB_OBJECT_LIMIT_JOB_MEMORY = 0x0200;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x0800;
const JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK = 0x1000;

const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const PROCESS_ACCESS = PROCESS_TERMINATE
  | PROCESS_SET_QUOTA
  | PROCESS_QUERY_LIMITED_INFORMATION;

const nodeRequire = createRequire(__filename);

export const DEFAULT_REPOSITORY_WINDOWS_JOB_LIMITS = Object.freeze({
  processMemoryBytes: 512 * 1024 * 1024,
  jobMemoryBytes: 512 * 1024 * 1024,
  activeProcessLimit: 1,
});

export type RepositoryWindowsJobLimits = {
  readonly processMemoryBytes: number;
  readonly jobMemoryBytes: number;
  readonly activeProcessLimit: number;
};

export type RepositoryWindowsJobFailureCode =
  | "unsupported-platform"
  | "invalid-input"
  | "native-load-failed"
  | "job-create-failed"
  | "job-configure-failed"
  | "process-open-failed"
  | "job-attach-failed"
  | "job-verify-failed"
  | "job-close-failed"
  | "job-terminate-failed";

export class RepositoryWindowsJobError extends Error {
  public readonly code: RepositoryWindowsJobFailureCode;
  public readonly nativeErrorCode: number | undefined;

  public constructor(
    code: RepositoryWindowsJobFailureCode,
    nativeErrorCode?: number,
  ) {
    super(`Repository worker containment failed (${code}).`);
    this.name = "RepositoryWindowsJobError";
    this.code = code;
    this.nativeErrorCode = nativeErrorCode;
  }
}

export type RepositoryWindowsJobSnapshot = RepositoryWindowsJobLimits & {
  readonly limitFlags: number;
};

export interface RepositoryWindowsJobAttachment {
  readonly pid: number;
  readonly snapshot: RepositoryWindowsJobSnapshot;
  terminate(exitCode?: number): void;
  close(): void;
}

export interface RepositoryWindowsJobController {
  attach(pid: number, limits?: RepositoryWindowsJobLimits): RepositoryWindowsJobAttachment;
}

type NativeHandle = bigint;

interface NativeJobApi {
  createJobObject(): NativeHandle | null;
  setExtendedLimits(job: NativeHandle, limits: RepositoryWindowsJobLimits): boolean;
  queryExtendedLimits(job: NativeHandle): RepositoryWindowsJobSnapshot | null;
  openProcess(pid: number): NativeHandle | null;
  assignProcessToJob(job: NativeHandle, process: NativeHandle): boolean;
  isProcessInJob(job: NativeHandle, process: NativeHandle): boolean;
  terminateJobObject(job: NativeHandle, exitCode: number): boolean;
  closeHandle(handle: NativeHandle): boolean;
  getLastError(): number;
}

interface KoffiModule {
  readonly default?: KoffiModule;
  load(path: string): KoffiLibrary;
  pointer(ref: unknown): unknown;
  pointer(name: string, ref: unknown): unknown;
  opaque(name?: string): unknown;
  struct(name: string, definition: Record<string, unknown>): unknown;
  out(type: unknown): unknown;
  sizeof(type: unknown): number;
}

interface KoffiLibrary {
  func(
    convention: string,
    name: string,
    result: unknown,
    parameters: unknown[],
  ): (...args: any[]) => any;
}

function loadKoffi(): KoffiModule {
  try {
    const loaded = nodeRequire("koffi") as KoffiModule;
    return loaded.default ?? loaded;
  } catch {
    throw new RepositoryWindowsJobError("native-load-failed");
  }
}

function toSafeNumber(value: number | bigint, code: RepositoryWindowsJobFailureCode): number {
  const numeric = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new RepositoryWindowsJobError(code);
  }
  return numeric;
}

function createNativeJobApi(): NativeJobApi {
  const koffi = loadKoffi();
  try {
    const kernel32 = koffi.load("kernel32.dll");
    const HANDLE = koffi.pointer("HANDLE", koffi.opaque());
    const IO_COUNTERS = koffi.struct("IO_COUNTERS", {
      ReadOperationCount: "uint64_t",
      WriteOperationCount: "uint64_t",
      OtherOperationCount: "uint64_t",
      ReadTransferCount: "uint64_t",
      WriteTransferCount: "uint64_t",
      OtherTransferCount: "uint64_t",
    });
    const JOBOBJECT_BASIC_LIMIT_INFORMATION = koffi.struct(
      "JOBOBJECT_BASIC_LIMIT_INFORMATION",
      {
        PerProcessUserTimeLimit: "int64_t",
        PerJobUserTimeLimit: "int64_t",
        LimitFlags: "uint32_t",
        MinimumWorkingSetSize: "uintptr_t",
        MaximumWorkingSetSize: "uintptr_t",
        ActiveProcessLimit: "uint32_t",
        Affinity: "uintptr_t",
        PriorityClass: "uint32_t",
        SchedulingClass: "uint32_t",
      },
    );
    const JOBOBJECT_EXTENDED_LIMIT_INFORMATION = koffi.struct(
      "JOBOBJECT_EXTENDED_LIMIT_INFORMATION",
      {
        BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION,
        IoInfo: IO_COUNTERS,
        ProcessMemoryLimit: "uintptr_t",
        JobMemoryLimit: "uintptr_t",
        PeakProcessMemoryUsed: "uintptr_t",
        PeakJobMemoryUsed: "uintptr_t",
      },
    );
    const extendedLimitPointer = koffi.pointer(JOBOBJECT_EXTENDED_LIMIT_INFORMATION);
    const createJobObjectW = kernel32.func(
      "__stdcall",
      "CreateJobObjectW",
      HANDLE,
      ["void *", "str16"],
    );
    const setInformationJobObject = kernel32.func(
      "__stdcall",
      "SetInformationJobObject",
      "bool",
      [HANDLE, "int", extendedLimitPointer, "uint32_t"],
    );
    const queryInformationJobObject = kernel32.func(
      "__stdcall",
      "QueryInformationJobObject",
      "bool",
      [
        HANDLE,
        "int",
        koffi.out(extendedLimitPointer),
        "uint32_t",
        koffi.out(koffi.pointer("uint32_t")),
      ],
    );
    const openProcess = kernel32.func(
      "__stdcall",
      "OpenProcess",
      HANDLE,
      ["uint32_t", "bool", "uint32_t"],
    );
    const assignProcessToJobObject = kernel32.func(
      "__stdcall",
      "AssignProcessToJobObject",
      "bool",
      [HANDLE, HANDLE],
    );
    const isProcessInJob = kernel32.func(
      "__stdcall",
      "IsProcessInJob",
      "bool",
      [HANDLE, HANDLE, koffi.out(koffi.pointer("bool"))],
    );
    const terminateJobObject = kernel32.func(
      "__stdcall",
      "TerminateJobObject",
      "bool",
      [HANDLE, "uint32_t"],
    );
    const closeHandle = kernel32.func(
      "__stdcall",
      "CloseHandle",
      "bool",
      [HANDLE],
    );
    const getLastError = kernel32.func(
      "__stdcall",
      "GetLastError",
      "uint32_t",
      [],
    );
    const structSize = koffi.sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION);

    const toNativeLimitInfo = (limits: RepositoryWindowsJobLimits): Record<string, unknown> => ({
      BasicLimitInformation: {
        PerProcessUserTimeLimit: 0n,
        PerJobUserTimeLimit: 0n,
        LimitFlags: JOB_OBJECT_LIMIT_ACTIVE_PROCESS
          | JOB_OBJECT_LIMIT_PROCESS_MEMORY
          | JOB_OBJECT_LIMIT_JOB_MEMORY
          | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        MinimumWorkingSetSize: 0n,
        MaximumWorkingSetSize: 0n,
        ActiveProcessLimit: limits.activeProcessLimit,
        Affinity: 0n,
        PriorityClass: 0,
        SchedulingClass: 0,
      },
      IoInfo: {
        ReadOperationCount: 0n,
        WriteOperationCount: 0n,
        OtherOperationCount: 0n,
        ReadTransferCount: 0n,
        WriteTransferCount: 0n,
        OtherTransferCount: 0n,
      },
      // Keep this field order identical to JOBOBJECT_EXTENDED_LIMIT_INFORMATION.
      ProcessMemoryLimit: BigInt(limits.processMemoryBytes),
      JobMemoryLimit: BigInt(limits.jobMemoryBytes),
      PeakProcessMemoryUsed: 0n,
      PeakJobMemoryUsed: 0n,
    });

    const readSnapshot = (info: any): RepositoryWindowsJobSnapshot => ({
      limitFlags: toSafeNumber(info.BasicLimitInformation.LimitFlags, "job-verify-failed"),
      activeProcessLimit: toSafeNumber(
        info.BasicLimitInformation.ActiveProcessLimit,
        "job-verify-failed",
      ),
      processMemoryBytes: toSafeNumber(info.ProcessMemoryLimit, "job-verify-failed"),
      jobMemoryBytes: toSafeNumber(info.JobMemoryLimit, "job-verify-failed"),
    });

    return {
      createJobObject: () => createJobObjectW(null, null) as NativeHandle | null,
      setExtendedLimits: (job, limits) =>
        setInformationJobObject(
          job,
          JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
          toNativeLimitInfo(limits),
          structSize,
        ) === true,
      queryExtendedLimits: (job) => {
        const info: Record<string, unknown> = {};
        const returnedLength = [0];
        if (queryInformationJobObject(
          job,
          JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
          info,
          structSize,
          returnedLength,
        ) !== true) {
          return null;
        }
        return readSnapshot(info);
      },
      openProcess: (pid) => openProcess(PROCESS_ACCESS, false, pid) as NativeHandle | null,
      assignProcessToJob: (job, process) => assignProcessToJobObject(job, process) === true,
      isProcessInJob: (job, process) => {
        const result = [false];
        if (isProcessInJob(process, job, result) !== true) return false;
        return result[0] === true;
      },
      terminateJobObject: (job, exitCode) => terminateJobObject(job, exitCode) === true,
      closeHandle: (handle) => closeHandle(handle) === true,
      getLastError: () => toSafeNumber(getLastError(), "job-verify-failed"),
    };
  } catch {
    throw new RepositoryWindowsJobError("native-load-failed");
  }
}

// Koffi registers named structs in the process-wide native binding.  Keep the
// binding (not any Job or process handle) process-local and immutable so a
// second controller does not try to redeclare the same native types.  A
// failed bind is also remembered: callers fail closed instead of repeatedly
// attempting an unavailable native setup.
let sharedNativeJobApi: NativeJobApi | undefined;
let sharedNativeJobApiFailure: RepositoryWindowsJobError | undefined;

function getSharedNativeJobApi(): NativeJobApi {
  if (sharedNativeJobApi !== undefined) return sharedNativeJobApi;
  if (sharedNativeJobApiFailure !== undefined) {
    throw new RepositoryWindowsJobError(
      sharedNativeJobApiFailure.code,
      sharedNativeJobApiFailure.nativeErrorCode,
    );
  }
  try {
    sharedNativeJobApi = createNativeJobApi();
    return sharedNativeJobApi;
  } catch (error) {
    const failure = error instanceof RepositoryWindowsJobError
      ? error
      : new RepositoryWindowsJobError("native-load-failed");
    sharedNativeJobApiFailure = new RepositoryWindowsJobError(
      failure.code,
      failure.nativeErrorCode,
    );
    throw new RepositoryWindowsJobError(
      sharedNativeJobApiFailure.code,
      sharedNativeJobApiFailure.nativeErrorCode,
    );
  }
}

function validateLimits(limits: RepositoryWindowsJobLimits): void {
  if (limits === null || typeof limits !== "object"
    || !Number.isSafeInteger(limits.processMemoryBytes)
    || limits.processMemoryBytes <= 0
    || !Number.isSafeInteger(limits.jobMemoryBytes)
    || limits.jobMemoryBytes <= 0
    || !Number.isSafeInteger(limits.activeProcessLimit)
    || limits.activeProcessLimit !== 1) {
    throw new RepositoryWindowsJobError("invalid-input");
  }
}

function validatePid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new RepositoryWindowsJobError("invalid-input");
  }
}

function errorWithLastError(
  api: NativeJobApi,
  code: RepositoryWindowsJobFailureCode,
): RepositoryWindowsJobError {
  let nativeErrorCode: number | undefined;
  try {
    nativeErrorCode = api.getLastError();
  } catch {
    nativeErrorCode = undefined;
  }
  return new RepositoryWindowsJobError(code, nativeErrorCode);
}

function closeQuietly(api: NativeJobApi, handle: NativeHandle | null): void {
  if (handle === null) return;
  try {
    api.closeHandle(handle);
  } catch {
    // Preserve the operation failure that caused cleanup.
  }
}

function snapshotsEqual(
  actual: RepositoryWindowsJobSnapshot,
  expected: RepositoryWindowsJobLimits,
): boolean {
  const requiredFlags = JOB_OBJECT_LIMIT_ACTIVE_PROCESS
    | JOB_OBJECT_LIMIT_PROCESS_MEMORY
    | JOB_OBJECT_LIMIT_JOB_MEMORY
    | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  const forbiddenFlags = JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
  return (actual.limitFlags & requiredFlags) === requiredFlags
    && (actual.limitFlags & forbiddenFlags) === 0
    && actual.activeProcessLimit === expected.activeProcessLimit
    && actual.processMemoryBytes === expected.processMemoryBytes
    && actual.jobMemoryBytes === expected.jobMemoryBytes;
}

class RepositoryWindowsJobControllerImpl implements RepositoryWindowsJobController {
  private readonly api: NativeJobApi;

  public constructor(api: NativeJobApi) {
    this.api = api;
  }

  public attach(
    pid: number,
    limits: RepositoryWindowsJobLimits = DEFAULT_REPOSITORY_WINDOWS_JOB_LIMITS,
  ): RepositoryWindowsJobAttachment {
    validatePid(pid);
    validateLimits(limits);

    const job = this.api.createJobObject();
    if (job === null || job === 0n) {
      throw errorWithLastError(this.api, "job-create-failed");
    }

    let processHandle: NativeHandle | null = null;
    try {
      if (!this.api.setExtendedLimits(job, limits)) {
        throw errorWithLastError(this.api, "job-configure-failed");
      }
      processHandle = this.api.openProcess(pid);
      if (processHandle === null || processHandle === 0n) {
        throw errorWithLastError(this.api, "process-open-failed");
      }
      if (!this.api.assignProcessToJob(job, processHandle)) {
        throw errorWithLastError(this.api, "job-attach-failed");
      }
      if (!this.api.isProcessInJob(job, processHandle)) {
        throw errorWithLastError(this.api, "job-verify-failed");
      }
      const snapshot = this.api.queryExtendedLimits(job);
      if (snapshot === null || !snapshotsEqual(snapshot, limits)) {
        throw errorWithLastError(this.api, "job-verify-failed");
      }

      let closed = false;
      let terminated = false;
      return {
        pid,
        snapshot,
        terminate: (exitCode = 1) => {
          if (closed || terminated) return;
          if (!this.api.terminateJobObject(job, exitCode)) {
            throw errorWithLastError(this.api, "job-terminate-failed");
          }
          terminated = true;
        },
        close: () => {
          if (closed) return;
          closed = true;
          let failure: RepositoryWindowsJobError | undefined;
          if (processHandle !== null) {
            if (!this.api.closeHandle(processHandle)) {
              failure = errorWithLastError(this.api, "job-close-failed");
            }
            processHandle = null;
          }
          if (!this.api.closeHandle(job) && failure === undefined) {
            failure = errorWithLastError(this.api, "job-close-failed");
          }
          if (failure !== undefined) throw failure;
        },
      };
    } catch (error) {
      closeQuietly(this.api, processHandle);
      closeQuietly(this.api, job);
      throw error;
    }
  }
}

export function createRepositoryWindowsJobController(options: {
  readonly platform?: NodeJS.Platform;
  readonly nativeApi?: NativeJobApi;
} = {}): RepositoryWindowsJobController {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    throw new RepositoryWindowsJobError("unsupported-platform");
  }
  return new RepositoryWindowsJobControllerImpl(options.nativeApi ?? getSharedNativeJobApi());
}

export const repositoryWindowsJobTestInternals = {
  JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
  JOB_OBJECT_LIMIT_PROCESS_MEMORY,
  JOB_OBJECT_LIMIT_JOB_MEMORY,
  JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
