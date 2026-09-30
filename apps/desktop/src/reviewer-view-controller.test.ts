import { describe, expect, it, vi } from "vitest";
import {
  OPEN_REVIEWER_COMMAND,
  REVIEWER_VIEW_ID,
  ReviewerViewController,
  getManagedReviewerOrigin,
  type ReviewerViewBounds,
  type ReviewerNavigationEvent,
  type ReviewerViewHost,
  type ReviewerViewWebContents,
  type ReviewerWindowOpenDetails
} from "./reviewer-view-controller";

class FakeWebContents implements ReviewerViewWebContents {
  public navigationListener: ((event: ReviewerNavigationEvent, url: string) => void) | undefined;
  public windowOpenHandler: ((details: ReviewerWindowOpenDetails) => { action: "deny" }) | undefined;

  public on(_event: "will-navigate", listener: (event: ReviewerNavigationEvent, url: string) => void): void {
    this.navigationListener = listener;
  }

  public setWindowOpenHandler(handler: (details: ReviewerWindowOpenDetails) => { action: "deny" }): void {
    this.windowOpenHandler = handler;
  }
}

class FakeHost implements ReviewerViewHost {
  public readonly webContents = new FakeWebContents();
  public readonly loadURL = vi.fn(async (_url: string) => {});
  public readonly attach = vi.fn();
  public readonly detach = vi.fn();
  public readonly focus = vi.fn();
  public readonly setBounds = vi.fn((_bounds: ReviewerViewBounds) => {});
  public readonly dispose = vi.fn(() => { this.destroyed = true; });
  public destroyed = false;

  public isDestroyed(): boolean {
    return this.destroyed;
  }

}

function createController(baseUrl: URL | string | Error = "http://127.0.0.1:51001/") {
  const host = new FakeHost();
  const create = vi.fn(() => host);
  const controller = new ReviewerViewController({
    hostFactory: { create },
    getManagedReviewerBaseUrl: async () => {
      if (baseUrl instanceof Error) throw baseUrl;
      return baseUrl;
    }
  });
  return { controller, host, create };
}

describe("ReviewerViewController", () => {
  it("declares the Shelf-facing reviewer command and a central view identity", () => {
    expect(OPEN_REVIEWER_COMMAND).toBe("maginalia.shelf.openReviewer");
    expect(REVIEWER_VIEW_ID).toBe("reviewer");
  });

  it("opens exactly one managed Reviewer view and reuses it", async () => {
    const { controller, host, create } = createController();

    await expect(controller.open()).resolves.toEqual({ kind: "opened", viewId: "reviewer" });
    await expect(controller.open()).resolves.toEqual({ kind: "activated", viewId: "reviewer" });

    expect(create).toHaveBeenCalledTimes(1);
    expect(host.loadURL).toHaveBeenCalledWith("http://127.0.0.1:51001/");
    expect(host.attach).toHaveBeenCalledTimes(2);
    expect(host.focus).toHaveBeenCalledTimes(2);
    expect(controller.hasOpenView()).toBe(true);
  });

  it("deduplicates concurrent opens before creating a host", async () => {
    const host = new FakeHost();
    let resolveBaseUrl: ((value: URL | string) => void) | undefined;
    const controller = new ReviewerViewController({
      hostFactory: { create: vi.fn(() => host) },
      getManagedReviewerBaseUrl: () => new Promise((resolve) => { resolveBaseUrl = resolve; })
    });

    const first = controller.open();
    const second = controller.open();
    resolveBaseUrl?.("http://localhost:51002/");

    expect(await first).toEqual({ kind: "opened", viewId: REVIEWER_VIEW_ID });
    expect(await second).toEqual({ kind: "opened", viewId: REVIEWER_VIEW_ID });
  });

  it("denies remote navigation and every window.open request", async () => {
    const { controller, host } = createController("http://localhost:51003/review");
    await controller.open();

    const denied = { preventDefault: vi.fn() };
    host.webContents.navigationListener?.(denied, "https://example.com/");
    expect(denied.preventDefault).toHaveBeenCalledOnce();

    const allowed = { preventDefault: vi.fn() };
    host.webContents.navigationListener?.(allowed, "http://localhost:51003/import");
    expect(allowed.preventDefault).not.toHaveBeenCalled();
    expect(host.webContents.windowOpenHandler?.({ url: "https://example.com/" })).toEqual({ action: "deny" });
  });

  it("returns a bounded unavailable result if managed Reviewer startup fails", async () => {
    const { controller, create } = createController(new Error("sidecar failed"));
    await expect(controller.open()).resolves.toEqual({
      kind: "unavailable",
      action: "retry-reviewer",
      message: "Reviewer unavailable. Try again from Shelf Review."
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a non-loopback or credential-bearing managed origin", async () => {
    expect(() => getManagedReviewerOrigin("https://example.com:51004/")).toThrow(/loopback/);
    expect(() => getManagedReviewerOrigin("http://user:pass@127.0.0.1:51004/")).toThrow(/loopback/);

    const { controller, create } = createController("http://example.com:51004/");
    await expect(controller.open()).resolves.toMatchObject({ kind: "unavailable" });
    expect(create).not.toHaveBeenCalled();
  });

  it("attaches the service host to the existing central surface and detaches it on return", async () => {
    const { controller, host, create } = createController("http://127.0.0.1:51005/");
    await controller.open();
    controller.setBounds({ x: 220, y: 128, width: 720, height: 540 });

    expect(create).toHaveBeenCalledTimes(1);
    expect(host.attach).toHaveBeenCalledOnce();
    expect(host.setBounds).toHaveBeenCalledWith({ x: 220, y: 128, width: 720, height: 540 });
    expect(controller.close()).toEqual({ kind: "closed" });
    expect(host.detach).toHaveBeenCalledOnce();
    expect(host.dispose).toHaveBeenCalledOnce();
    expect(controller.hasOpenView()).toBe(false);
  });

  it("disposes an unattached host when load fails", async () => {
    const host = new FakeHost();
    host.loadURL.mockRejectedValueOnce(new Error("load failed"));
    const controller = new ReviewerViewController({
      hostFactory: { create: () => host },
      getManagedReviewerBaseUrl: async () => "http://127.0.0.1:51006/"
    });
    await expect(controller.open()).resolves.toMatchObject({ kind: "unavailable" });
    expect(host.attach).not.toHaveBeenCalled();
    expect(host.dispose).toHaveBeenCalledOnce();
  });
});
