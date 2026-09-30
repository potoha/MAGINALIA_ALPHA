import { describe, expect, it, vi } from "vitest";
import {
  createReviewerEmbeddedHost,
  isSafeReviewerViewBounds,
  type EmbeddedReviewerView,
  type ReviewerCentralViewOwner
} from "./reviewer-embedded-view-host";

function createFixture() {
  const webContents = {
    on: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    isDestroyed: vi.fn(() => false),
    focus: vi.fn(),
    close: vi.fn(),
    loadURL: vi.fn(async () => {})
  };
  const view: EmbeddedReviewerView = { webContents, setBounds: vi.fn() };
  const owner: ReviewerCentralViewOwner = {
    isDestroyed: vi.fn(() => false),
    getContentSize: vi.fn(() => [1200, 800] as const),
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() }
  };
  return { owner, view, webContents };
}

describe("Reviewer embedded central host", () => {
  it("attaches the WebContentsView to the existing Workbench contentView, never a top-level window", () => {
    const { owner, view } = createFixture();
    const host = createReviewerEmbeddedHost(owner, () => view);

    host.attach();
    host.attach();

    expect(owner.contentView.addChildView).toHaveBeenCalledTimes(1);
    expect(owner.contentView.addChildView).toHaveBeenCalledWith(view);
    expect(view.setBounds).toHaveBeenCalledWith({ x: 300, y: 132, width: 600, height: 650 });
  });

  it("detaches and disposes the embedded service host without touching any DocumentSession", () => {
    const { owner, view, webContents } = createFixture();
    const host = createReviewerEmbeddedHost(owner, () => view);
    host.attach();
    host.detach();
    host.dispose();

    expect(owner.contentView.removeChildView).toHaveBeenCalledTimes(1);
    expect(owner.contentView.removeChildView).toHaveBeenCalledWith(view);
    expect(webContents.close).toHaveBeenCalledOnce();
  });
});

describe("Reviewer central slot bounds", () => {
  it.each([
    null,
    {},
    { x: -1, y: 0, width: 320, height: 240 },
    { x: 0, y: 0, width: 159, height: 240 },
    { x: 0, y: 0, width: 320, height: 119 },
    { x: 0, y: 0, width: Number.NaN, height: 240 },
    { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 240 },
    { x: 0.5, y: 0, width: 320, height: 240 },
    { x: 0, y: 0, width: 10001, height: 240 }
  ])("rejects untrusted bounds %#", (value) => {
    expect(isSafeReviewerViewBounds(value)).toBe(false);
  });

  it("accepts the bounded fixed central service slot", () => {
    expect(isSafeReviewerViewBounds({ x: 220, y: 128, width: 720, height: 540 })).toBe(true);
  });
});
