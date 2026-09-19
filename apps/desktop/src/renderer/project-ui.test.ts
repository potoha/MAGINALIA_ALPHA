import { describe, expect, it } from "vitest";
import { createProjectFileName } from "./project-ui";

describe("Project UI filename adapter", () => {
  it("keeps the title readable while adapting filesystem separators", () => {
    expect(createProjectFileName("A/B testing", "memo")).toBe("A-B testing.md");
    expect(createProjectFileName("エーコ: 開かれた作品", "memo")).toBe("エーコ- 開かれた作品.md");
  });

  it("chooses an unused suffix from the current Project files", () => {
    expect(createProjectFileName("Memo", "memo", ["Memo.md"])).toBe("Memo-001.md");
    expect(createProjectFileName("Memo", "memo", ["Memo.md", "Memo-001.md"])).toBe("Memo-002.md");
  });

  it("uses a type and date for an empty title and avoids device names", () => {
    expect(createProjectFileName("", "draft", [], new Date(2026, 8, 19))).toBe("draft-2026-09-19.md");
    expect(createProjectFileName("CON", "memo")).toBe("document-CON.md");
  });
});
