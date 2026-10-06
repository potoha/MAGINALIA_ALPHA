import { describe, expect, it, vi } from "vitest";
import type { ReviewerShelfSyncResult } from "./reviewer-shelf-sync";
import { materializeApprovedReviewerRecords } from "./reviewer-approval-materializer";

function completed(materialized: number, unchanged = 0): ReviewerShelfSyncResult {
  return {
    kind: "completed",
    materialized,
    unchanged,
    pending: 0,
    pendingRecords: [],
    conflicts: 0,
    failed: 0
  };
}

describe("approval-triggered Private Shelf materialization", () => {
  it("uses the configured registry root and reloads immediately after writes", async () => {
    const owner = {};
    const configuredShelf = {
      getActive: vi.fn(async () => ({ kind: "private-shelf" as const, canonicalRoot: "D:/private-shelf" })),
      reload: vi.fn(async () => ({ kind: "opened" as const }))
    };
    const synchronize = vi.fn(async () => completed(1));

    await expect(materializeApprovedReviewerRecords(owner, configuredShelf, synchronize)).resolves.toEqual(completed(1));

    expect(synchronize).toHaveBeenCalledWith("D:/private-shelf");
    expect(configuredShelf.reload).toHaveBeenCalledWith(owner);
  });

  it("reloads when a retry finds an already-written alias", async () => {
    const owner = {};
    const configuredShelf = {
      getActive: vi.fn(async () => ({ kind: "private-shelf" as const, canonicalRoot: "D:/private-shelf" })),
      reload: vi.fn(async () => ({ kind: "opened" as const }))
    };
    const synchronize = vi.fn(async () => completed(0, 1));

    await expect(materializeApprovedReviewerRecords(owner, configuredShelf, synchronize)).resolves.toEqual(completed(0, 1));

    expect(configuredShelf.reload).toHaveBeenCalledWith(owner);
  });

  it("preserves approval and leaves retryable records alone when no durable write occurred", async () => {
    const owner = {};
    const configuredShelf = {
      getActive: vi.fn(async () => ({ kind: "private-shelf" as const, canonicalRoot: "D:/private-shelf" })),
      reload: vi.fn(async () => ({ kind: "opened" as const }))
    };
    const pending: ReviewerShelfSyncResult = {
      ...completed(0),
      pending: 1,
      pendingRecords: [{ kind: "pending", code: "canonical-source-unavailable" }]
    };
    const synchronize = vi.fn(async () => pending);

    await expect(materializeApprovedReviewerRecords(owner, configuredShelf, synchronize)).resolves.toEqual(pending);

    expect(configuredShelf.reload).not.toHaveBeenCalled();
  });

  it("does not select a filesystem destination when the registry has no active Private Shelf", async () => {
    const configuredShelf = {
      getActive: vi.fn(async () => ({ kind: "error" as const, code: "invalid-library-config" as const, message: "unconfigured" })),
      reload: vi.fn()
    };
    const synchronize = vi.fn(async () => completed(1));

    await expect(materializeApprovedReviewerRecords({}, configuredShelf, synchronize)).resolves.toBeNull();

    expect(synchronize).not.toHaveBeenCalled();
    expect(configuredShelf.reload).not.toHaveBeenCalled();
  });
});
