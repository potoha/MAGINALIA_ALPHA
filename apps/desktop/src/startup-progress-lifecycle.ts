export type StartupReadinessState = "pending" | "ready" | "failed" | "aborted";

interface ReadinessWaiter<T> {
  readonly resolve: (value: T) => void;
  readonly reject: (reason: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Bounded, one-shot readiness for the optional branded startup window. */
export class StartupProgressReadiness<T> {
  private currentState: StartupReadinessState = "pending";
  private readyValue: T | undefined;
  private failure: Error | null = null;
  private readonly waiters = new Set<ReadinessWaiter<T>>();

  constructor(private readonly timeoutMs = 10_000) {}

  get state(): StartupReadinessState {
    return this.currentState;
  }

  wait(): Promise<T> {
    if (this.currentState === "ready") return Promise.resolve(this.readyValue as T);
    if (this.currentState === "failed" || this.currentState === "aborted") {
      return Promise.reject(this.failure ?? new Error("Startup progress was not ready."));
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error(`Timed out waiting ${this.timeoutMs}ms for the startup progress window.`));
      }, this.timeoutMs);
      this.waiters.add({ resolve, reject, timer });
    });
  }

  markReady(value: T): boolean {
    if (this.currentState !== "pending") return false;
    this.currentState = "ready";
    this.readyValue = value;
    this.settleWaiters();
    return true;
  }

  fail(reason: unknown): boolean {
    return this.settleFailure("failed", reason);
  }

  abort(reason: unknown = new Error("Startup was aborted before the progress window became ready.")): boolean {
    return this.settleFailure("aborted", reason);
  }

  invalidate(reason: unknown): boolean {
    if (this.currentState === "failed" || this.currentState === "aborted") return false;
    return this.settleFailure("failed", reason);
  }

  private settleFailure(state: "failed" | "aborted", reason: unknown): boolean {
    if (this.currentState === "failed" || this.currentState === "aborted") return false;
    this.currentState = state;
    this.readyValue = undefined;
    this.failure = reason instanceof Error ? reason : new Error(String(reason));
    this.settleWaiters();
    return true;
  }

  private settleWaiters(): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      if (this.currentState === "ready") waiter.resolve(this.readyValue as T);
      else waiter.reject(this.failure ?? new Error("Startup progress was not ready."));
    }
    this.waiters.clear();
  }
}

export type RendererStartupState = "pending" | "succeeded" | "failed";

/** Completes main-window startup only after both loadFile and ready-to-show succeed. */
export class RendererStartupGate {
  private rendererLoaded = false;
  private windowReady = false;
  private currentState: RendererStartupState = "pending";

  constructor(
    private readonly onSuccess: () => void,
    private readonly onFailure: (error: unknown) => void,
  ) {}

  get state(): RendererStartupState {
    return this.currentState;
  }

  markRendererLoaded(): void {
    if (this.currentState !== "pending") return;
    this.rendererLoaded = true;
    this.completeIfReady();
  }

  markWindowReady(): void {
    if (this.currentState !== "pending") return;
    this.windowReady = true;
    this.completeIfReady();
  }

  failRendererLoad(error: unknown): void {
    if (this.currentState !== "pending") return;
    this.currentState = "failed";
    this.onFailure(error);
  }

  private completeIfReady(): void {
    if (!this.rendererLoaded || !this.windowReady || this.currentState !== "pending") return;
    this.currentState = "succeeded";
    this.onSuccess();
  }
}
