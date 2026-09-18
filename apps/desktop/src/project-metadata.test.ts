import { describe, expect, it } from "vitest";
import {
  createProjectMarkdown,
  normalizeProjectFileName,
  parseProjectMetadata
} from "./project-metadata";

describe("Project Markdown metadata", () => {
  it("reads supported ordinary frontmatter without changing the body", () => {
    const text = "\uFEFF---\ntype: draft\ntitle: Open Work\ncreated: 2026-09-19\n---\n\n# Open Work\n本文\n";
    expect(parseProjectMetadata(text, "draft.md")).toEqual({
      documentType: "draft",
      title: "Open Work",
      valid: true
    });
  });

  it("falls back to other for malformed or unsupported metadata", () => {
    expect(parseProjectMetadata("---\ntype: unknown\n---\n\n本文", "memo.md")).toMatchObject({
      documentType: "other",
      title: "memo",
      valid: false
    });
    expect(parseProjectMetadata("---\n:type\n---\n\n本文", "memo.md").documentType).toBe("other");
    expect(parseProjectMetadata("本文だけ", "memo.md")).toMatchObject({
      documentType: "other",
      title: "memo",
      valid: true
    });
  });

  it("normalizes new filenames and creates readable Markdown", () => {
    expect(normalizeProjectFileName("idea")).toBe("idea.md");
    expect(normalizeProjectFileName("idea.md")).toBe("idea.md");
    expect(normalizeProjectFileName("../secret")).toBeUndefined();
    const text = createProjectMarkdown("A note", "memo", new Date("2026-09-19T00:00:00Z"));
    expect(text).toContain("type: memo");
    expect(text).toContain("title: A note");
    expect(text).toContain("# A note");
  });
});
