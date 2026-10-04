import { describe, expect, it } from "vitest";
import { PreviewCompositionGate } from "./preview-editing";

describe("Preview composition gate", () => {
  it("does not commit intermediate IME input and commits only after compositionend", () => {
    const gate = new PreviewCompositionGate();
    expect(gate.mayCommitInput()).toBe(true);
    gate.start();
    expect(gate.mayCommitInput()).toBe(false);
    expect(gate.end()).toBe(true);
    expect(gate.mayCommitInput()).toBe(false);
    expect(gate.mayCommitInput()).toBe(true);
    expect(gate.end()).toBe(false);
  });
});
