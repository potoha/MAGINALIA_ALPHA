import { describe, expect, it, vi } from "vitest";
import { AutosaveShutdownCoordinator, type BeforeQuitEvent } from "./autosave-shutdown";

function event(): BeforeQuitEvent & { prevented: boolean } {
  return {
    prevented: false,
    preventDefault() { this.prevented = true; }
  };
}

describe("AutosaveShutdownCoordinator", () => {
  it("waits for a successful renderer flush before quitting", async () => {
    const quit = vi.fn();
    const request = vi.fn(async () => true);
    const coordinator = new AutosaveShutdownCoordinator({ requestFlush: request, quit });
    const first = event();

    coordinator.beforeQuit(first);
    expect(first.prevented).toBe(true);
    expect(quit).not.toHaveBeenCalled();
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
    const second = event();
    coordinator.beforeQuit(second);
    expect(second.prevented).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent quit requests into one flush", async () => {
    let resolve!: (ok: boolean) => void;
    const request = vi.fn(() => new Promise<boolean>((nextResolve) => { resolve = nextResolve; }));
    const coordinator = new AutosaveShutdownCoordinator({ requestFlush: request, quit: vi.fn() });
    const first = event();
    const second = event();

    coordinator.beforeQuit(first);
    coordinator.beforeQuit(second);
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    resolve(true);
    await Promise.resolve();
    await Promise.resolve();
  });

  it("keeps the application open after failure and allows retry", async () => {
    const quit = vi.fn();
    const failure = vi.fn();
    const request = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const coordinator = new AutosaveShutdownCoordinator({ requestFlush: request, quit, onFailure: failure });

    const failed = event();
    coordinator.beforeQuit(failed);
    await vi.waitFor(() => expect(failure).toHaveBeenCalledTimes(1));
    expect(failed.prevented).toBe(true);
    expect(failure).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();

    const retried = event();
    coordinator.beforeQuit(retried);
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
    expect(request).toHaveBeenCalledTimes(2);
    expect(quit).toHaveBeenCalledTimes(1);
  });
});
