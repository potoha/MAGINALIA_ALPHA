import { afterEach, describe, expect, it, vi } from "vitest";
import { RendererStartupGate, StartupProgressReadiness } from "./startup-progress-lifecycle";

describe("startup progress lifecycle", () => {
  afterEach(() => vi.useRealTimers());

  it("does not report success when the Renderer fails before load completion", () => {
    const onSuccess = vi.fn();
    const onFailure = vi.fn();
    const gate = new RendererStartupGate(onSuccess, onFailure);

    gate.markWindowReady();
    gate.failRendererLoad(new Error("renderer load failed"));

    expect(gate.state).toBe("failed");
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it("reports success only after load and window readiness both complete", () => {
    const onSuccess = vi.fn();
    const gate = new RendererStartupGate(onSuccess, vi.fn());

    gate.markWindowReady();
    expect(onSuccess).not.toHaveBeenCalled();
    gate.markRendererLoaded();
    gate.markRendererLoaded();

    expect(gate.state).toBe("succeeded");
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it("resolves readiness only after the window is marked ready and clears its timeout", async () => {
    vi.useFakeTimers();
    const readiness = new StartupProgressReadiness<object>(500);
    const window = {};
    const waiting = readiness.wait();

    expect(readiness.state).toBe("pending");
    expect(readiness.markReady(window)).toBe(true);

    await expect(waiting).resolves.toBe(window);
    expect(vi.getTimerCount()).toBe(0);
    expect(readiness.state).toBe("ready");
  });

  it("rejects pending waits when splash loading fails and keeps the failure for later waits", async () => {
    vi.useFakeTimers();
    const readiness = new StartupProgressReadiness<object>(500);
    const waiting = readiness.wait();
    const failure = new Error("splash failed to load");

    expect(readiness.fail(failure)).toBe(true);
    await expect(waiting).rejects.toBe(failure);
    await expect(readiness.wait()).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects pending waits when startup is cancelled", async () => {
    vi.useFakeTimers();
    const readiness = new StartupProgressReadiness<object>(500);
    const waiting = readiness.wait();
    const cancellation = new Error("startup aborted");

    readiness.abort(cancellation);

    await expect(waiting).rejects.toBe(cancellation);
    expect(readiness.state).toBe("aborted");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects readiness after its bounded timeout", async () => {
    vi.useFakeTimers();
    const readiness = new StartupProgressReadiness<object>(250);
    const waiting = readiness.wait();
    const assertion = expect(waiting).rejects.toThrow("Timed out waiting 250ms");

    await vi.advanceTimersByTimeAsync(250);
    await assertion;

    expect(readiness.state).toBe("failed");
    expect(vi.getTimerCount()).toBe(0);
  });
});
