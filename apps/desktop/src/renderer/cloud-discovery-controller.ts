import { GITHUB_DEVICE_VERIFICATION_URI } from "../repository-cloud-ipc";
import type { DevicePromptCallback, DevicePromptUnsubscribe } from "../preload-api";
import type {
  RepositoryCloudDiscoveryCancelResult,
  RepositoryCloudDiscoveryIpcResult,
} from "../repository-cloud-ipc";

export type CloudDiscoveryWorkKind = "project" | "workbench" | "shelf";

export interface CloudDiscoveryWork {
  readonly id: string;
  readonly title: string;
  readonly kind: CloudDiscoveryWorkKind;
}

export interface CloudDiscoveryPrompt {
  readonly userCode: string;
  readonly verificationUri: typeof GITHUB_DEVICE_VERIFICATION_URI;
}

export type CloudDiscoveryStatus = "idle" | "discovering" | "ready" | "error";

export interface CloudDiscoveryState {
  readonly status: CloudDiscoveryStatus;
  readonly prompt: CloudDiscoveryPrompt | null;
  readonly works: readonly CloudDiscoveryWork[];
  readonly error: string | null;
}

export interface CloudDiscoveryControllerApi {
  readonly discoverPrivateWorks: () => Promise<RepositoryCloudDiscoveryIpcResult>;
  readonly cancelPrivateWorksDiscovery: () => Promise<RepositoryCloudDiscoveryCancelResult>;
  readonly onDevicePrompt: (callback: DevicePromptCallback) => DevicePromptUnsubscribe;
}

export interface CloudDiscoveryControllerOptions {
  readonly api: CloudDiscoveryControllerApi;
  readonly onState?: (state: CloudDiscoveryState) => void;
}

const MAX_WORKS = 1_000;
const MAX_WORK_ID_LENGTH = 256;
const MAX_WORK_TITLE_LENGTH = 256;
const MAX_USER_CODE_LENGTH = 64;
const WORK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/u;
const USER_CODE_PATTERN = /^[A-Za-z0-9-]+$/u;

const DISCOVERY_FAILED = "Private cloud discovery could not be completed. Try again.";
const CANCELLATION_UNCERTAIN = "Cloud discovery cancellation could not be confirmed. Try again.";
const INVALID_PROMPT = "The cloud verification prompt was invalid.";
const CONTROLLER_UNAVAILABLE = "Cloud discovery is unavailable. Reload MAGINALIA to try again.";

const EMPTY_STATE: CloudDiscoveryState = Object.freeze({
  status: "idle",
  prompt: null,
  works: Object.freeze([]),
  error: null,
});

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function hasExactDataKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  try {
    const keys = Reflect.ownKeys(value);
    return keys.length === expected.length
      && keys.every((key) => typeof key === "string" && expected.includes(key))
      && expected.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && "value" in descriptor;
      });
  } catch {
    return false;
  }
}

function copyPrompt(value: unknown): CloudDiscoveryPrompt | undefined {
  if (!isPlainRecord(value) || !hasExactDataKeys(value, ["userCode", "verificationUri"])) return undefined;
  try {
    const userCode = value.userCode;
    if (typeof userCode !== "string"
      || userCode.length === 0
      || userCode.length > MAX_USER_CODE_LENGTH
      || !USER_CODE_PATTERN.test(userCode)
      || value.verificationUri !== GITHUB_DEVICE_VERIFICATION_URI) {
      return undefined;
    }
    return Object.freeze({
      userCode,
      verificationUri: GITHUB_DEVICE_VERIFICATION_URI,
    });
  } catch {
    return undefined;
  }
}

function copyWork(value: unknown): CloudDiscoveryWork | undefined {
  if (!isPlainRecord(value) || !hasExactDataKeys(value, ["id", "title", "kind"])) return undefined;
  try {
    const id = value.id;
    const title = value.title;
    const kind = value.kind;
    if (typeof id !== "string"
      || id.length === 0
      || id.length > MAX_WORK_ID_LENGTH
      || !WORK_ID_PATTERN.test(id)
      || typeof title !== "string"
      || title.length === 0
      || title.length > MAX_WORK_TITLE_LENGTH
      || /[\u0000-\u001F\u007F-\u009F]/u.test(title)
      || (kind !== "project" && kind !== "workbench" && kind !== "shelf")) {
      return undefined;
    }
    return Object.freeze({ id, title, kind });
  } catch {
    return undefined;
  }
}

function copyWorks(value: unknown): readonly CloudDiscoveryWork[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_WORKS) return undefined;
  const seen = new Set<string>();
  const works: CloudDiscoveryWork[] = [];
  for (const item of value) {
    const work = copyWork(item);
    if (work === undefined || seen.has(work.id.toLowerCase())) return undefined;
    seen.add(work.id.toLowerCase());
    works.push(work);
  }
  return Object.freeze(works);
}

function normalizeDiscoveryResult(value: unknown): readonly CloudDiscoveryWork[] | undefined {
  if (!isPlainRecord(value) || !hasExactDataKeys(value, ["kind", "works"])) return undefined;
  if (value.kind !== "works") return undefined;
  return copyWorks(value.works);
}

function isCancelResult(value: unknown): value is RepositoryCloudDiscoveryCancelResult {
  if (!isPlainRecord(value) || !hasExactDataKeys(value, ["kind"])) return false;
  try {
    return value.kind === "cancelled" || value.kind === "idle" || value.kind === "invalid-request";
  } catch {
    return false;
  }
}

function copyState(state: CloudDiscoveryState): CloudDiscoveryState {
  return Object.freeze({
    status: state.status,
    prompt: state.prompt === null ? null : Object.freeze({
      userCode: state.prompt.userCode,
      verificationUri: GITHUB_DEVICE_VERIFICATION_URI,
    }),
    works: Object.freeze(state.works.map((work) => Object.freeze({
      id: work.id,
      title: work.title,
      kind: work.kind,
    }))),
    error: state.error,
  });
}

function validateApi(value: CloudDiscoveryControllerApi): CloudDiscoveryControllerApi {
  if (value === null || typeof value !== "object"
    || typeof value.discoverPrivateWorks !== "function"
    || typeof value.cancelPrivateWorksDiscovery !== "function"
    || typeof value.onDevicePrompt !== "function") {
    throw new TypeError(CONTROLLER_UNAVAILABLE);
  }
  return value;
}

/** Renderer-only state controller for one explicit read-only discovery operation. */
export class CloudDiscoveryController {
  private readonly api: CloudDiscoveryControllerApi;
  private readonly onState: (state: CloudDiscoveryState) => void;
  private state: CloudDiscoveryState = EMPTY_STATE;
  private promptUnsubscribe: DevicePromptUnsubscribe | null = null;
  private activeOperation: number | null = null;
  private generation = 0;
  private disposed = false;
  private backendCancelTail: Promise<boolean> = Promise.resolve(true);
  private backendCancelPending = false;

  public constructor(options: CloudDiscoveryControllerOptions) {
    if (options === null || typeof options !== "object") throw new TypeError(CONTROLLER_UNAVAILABLE);
    this.api = validateApi(options.api);
    this.onState = typeof options.onState === "function" ? options.onState : () => undefined;
    this.publish();
  }

  public getState(): CloudDiscoveryState {
    return copyState(this.state);
  }

  public async discover(): Promise<void> {
    if (this.disposed) return;
    const operation = ++this.generation;
    const wasActive = this.activeOperation !== null;
    this.activeOperation = null;
    this.clearPromptSubscription();
    this.replaceState({ status: "idle", prompt: null, works: [], error: null });

    if (wasActive) {
      const cancelled = await this.requestBackendCancel(operation);
      if (cancelled === false || !this.isGenerationCurrent(operation)) return;
    } else if (this.backendCancelPending) {
      const cancelled = await this.backendCancelTail;
      if (!this.isGenerationCurrent(operation)) return;
      if (!cancelled) {
        this.replaceState({ status: "idle", prompt: null, works: [], error: CANCELLATION_UNCERTAIN });
        return;
      }
    }
    if (!this.isGenerationCurrent(operation)) return;

    this.activeOperation = operation;
    this.replaceState({ status: "discovering", prompt: null, works: [], error: null });
    try {
      const unsubscribe = this.api.onDevicePrompt((prompt) => this.receivePrompt(operation, prompt));
      if (typeof unsubscribe !== "function") throw new Error("invalid subscription");
      if (!this.isGenerationCurrent(operation)) {
        try {
          unsubscribe();
        } catch {
          // A stale subscription cannot affect current state.
        }
        return;
      }
      this.promptUnsubscribe = unsubscribe;
    } catch {
      if (this.isGenerationCurrent(operation)) {
        this.activeOperation = null;
        this.replaceState({ status: "error", prompt: null, works: [], error: DISCOVERY_FAILED });
      }
      return;
    }

    let result: RepositoryCloudDiscoveryIpcResult;
    try {
      result = await this.api.discoverPrivateWorks();
    } catch {
      if (this.isActive(operation)) this.finishWithError(operation, DISCOVERY_FAILED);
      return;
    }
    if (!this.isActive(operation)) return;

    this.activeOperation = null;
    this.clearPromptSubscription();
    const works = normalizeDiscoveryResult(result);
    if (works === undefined) {
      this.replaceState({ status: "error", prompt: null, works: [], error: DISCOVERY_FAILED });
      return;
    }
    this.replaceState({ status: "ready", prompt: null, works, error: null });
  }

  public async cancel(): Promise<void> {
    if (this.disposed) return;
    const operation = ++this.generation;
    const wasActive = this.activeOperation !== null;
    this.activeOperation = null;
    this.clearPromptSubscription();
    this.replaceState({ status: "idle", prompt: null, works: [], error: null });
    if (!wasActive) return;

    let result: unknown;
    try {
      result = await this.enqueueBackendCancel();
    } catch {
      if (this.isGenerationCurrent(operation)) {
        this.replaceState({ status: "idle", prompt: null, works: [], error: CANCELLATION_UNCERTAIN });
      }
      return;
    }
    if (!this.isGenerationCurrent(operation)) return;
    if (result !== true) {
      this.replaceState({ status: "idle", prompt: null, works: [], error: CANCELLATION_UNCERTAIN });
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    const wasActive = this.activeOperation !== null;
    this.disposed = true;
    this.generation += 1;
    this.activeOperation = null;
    this.clearPromptSubscription();
    this.replaceState({ status: "idle", prompt: null, works: [], error: null });
    if (wasActive) void this.enqueueBackendCancel();
  }

  private receivePrompt(operation: number, value: unknown): void {
    if (!this.isActive(operation)) return;
    const prompt = copyPrompt(value);
    if (prompt === undefined) {
      this.generation += 1;
      this.activeOperation = null;
      this.clearPromptSubscription();
      this.replaceState({ status: "error", prompt: null, works: [], error: INVALID_PROMPT });
      void this.enqueueBackendCancel();
      return;
    }
    this.replaceState({ status: "discovering", prompt, works: [], error: null });
  }

  private async requestBackendCancel(operation: number): Promise<boolean> {
    const cancelled = await this.enqueueBackendCancel();
    if (!this.isGenerationCurrent(operation)) return false;
    if (!cancelled) {
      this.replaceState({ status: "idle", prompt: null, works: [], error: CANCELLATION_UNCERTAIN });
      return false;
    }
    return true;
  }

  private enqueueBackendCancel(): Promise<boolean> {
    this.backendCancelPending = true;
    const previous = this.backendCancelTail;
    const task = previous.then(async () => {
      try {
        const result = await this.api.cancelPrivateWorksDiscovery();
        return isCancelResult(result) && result.kind !== "invalid-request";
      } catch {
        return false;
      }
    });
    let settled!: Promise<boolean>;
    settled = task.then((result) => {
      if (this.backendCancelTail === settled) this.backendCancelPending = false;
      return result;
    });
    this.backendCancelTail = settled;
    return settled;
  }

  private isGenerationCurrent(operation: number): boolean {
    return !this.disposed && this.generation === operation;
  }

  private isActive(operation: number): boolean {
    return this.isGenerationCurrent(operation) && this.activeOperation === operation;
  }

  private finishWithError(operation: number, error: string): void {
    if (!this.isActive(operation)) return;
    this.activeOperation = null;
    this.clearPromptSubscription();
    this.replaceState({ status: "error", prompt: null, works: [], error });
  }

  private clearPromptSubscription(): void {
    const unsubscribe = this.promptUnsubscribe;
    this.promptUnsubscribe = null;
    if (unsubscribe === null) return;
    try {
      unsubscribe();
    } catch {
      // State is already detached; a broken renderer listener cannot revive it.
    }
  }

  private replaceState(update: Partial<CloudDiscoveryState>): void {
    this.state = copyState({ ...this.state, ...update });
    this.publish();
  }

  private publish(): void {
    try {
      this.onState(this.getState());
    } catch {
      // Renderer view errors must not change operation or credential state.
    }
  }
}
