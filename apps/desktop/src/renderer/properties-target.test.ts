import { describe, expect, it } from "vitest";

import { ownsCurrentPropertiesTarget, shouldPreserveUnappliedPropertiesForm, type PropertiesTarget } from "./properties-target";

const target: PropertiesTarget = { documentId: "a.md", revision: 3 };

describe("Properties target ownership", () => {
  it("fails closed after a source revision changes", () => {
    expect(ownsCurrentPropertiesTarget(target, { documentId: "a.md", revision: 4 })).toBe(false);
  });

  it("does not let a stale Properties form cross document tabs", () => {
    expect(ownsCurrentPropertiesTarget(target, { documentId: "b.md", revision: 3 })).toBe(false);
    expect(ownsCurrentPropertiesTarget(null, { documentId: "a.md", revision: 3 })).toBe(false);
  });

  it("preserves dirty user input as stale instead of rebinding it to newer source", () => {
    expect(shouldPreserveUnappliedPropertiesForm(target, { documentId: "a.md", revision: 4 }, true, false)).toBe(true);
    expect(shouldPreserveUnappliedPropertiesForm(target, { documentId: "b.md", revision: 3 }, true, false)).toBe(true);
    expect(shouldPreserveUnappliedPropertiesForm(target, { documentId: "a.md", revision: 3 }, true, false)).toBe(false);
    expect(shouldPreserveUnappliedPropertiesForm(target, { documentId: "a.md", revision: 4 }, false, false)).toBe(false);
  });

  it("keeps an already stale dirty form stale after returning to its original revision", () => {
    expect(shouldPreserveUnappliedPropertiesForm(target, { documentId: "a.md", revision: 3 }, true, true)).toBe(true);
    expect(shouldPreserveUnappliedPropertiesForm(target, { documentId: "a.md", revision: 4 }, true, true)).toBe(true);
    expect(shouldPreserveUnappliedPropertiesForm(target, { documentId: "a.md", revision: 3 }, false, true)).toBe(false);
  });
});
