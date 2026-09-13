import { describe, expect, it, vi } from "vitest";
import { decideDirtySwitch } from "./dirty-decision";

describe("dirty switch decision", () => {
  it.each([
    { answers: [true], expected: "save" },
    { answers: [false, true], expected: "discard" },
    { answers: [false, false], expected: "cancel" }
  ] as const)("maps staged confirmations to $expected", ({ answers, expected }) => {
    let promptIndex = 0;
    const confirm = vi.fn((message: string) => {
      expect(message).toContain("notes.md");
      return answers[promptIndex++] ?? false;
    });

    const result = decideDirtySwitch({
      currentDisplayName: "notes.md",
      target: { kind: "manuscript", displayName: "other.md" }
    }, confirm);

    expect(result).toBe(expected);
    expect(confirm).toHaveBeenCalledTimes(answers.length);
  });
});
