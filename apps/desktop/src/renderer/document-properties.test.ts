import { describe, expect, it } from "vitest";

import {
  applyDocumentProperties,
  findFrontMatterBoundary,
  projectMarkdownBody,
  readDocumentProperties,
  scanFrontMatter,
  type ApplyDocumentPropertiesResult,
  type DocumentProperties,
} from "./document-properties";

const defaultProperties: DocumentProperties = { title: "New title", type: "draft", author: "未田3字", tags: ["俳句", "受容美学"], created: "2026-10-04" };

function apply(source: string, result: ApplyDocumentPropertiesResult): string {
  expect(result.kind).toBe("applied");
  if (result.kind !== "applied") return source;
  return `${source.slice(0, result.edit.start)}${result.edit.replacement}${source.slice(result.edit.end)}`;
}

describe("front matter source boundary", () => {
  it("retains original BOM and CRLF offsets for the body projection", () => {
    const source = "\uFEFF---\r\ntitle: Test\r\n---\r\n\r\n# Test\r\n本文\r\n";
    const boundary = findFrontMatterBoundary(source);
    expect(boundary?.bodyStart).toBe(source.indexOf("# Test") - 2);
    expect(boundary?.lineEnding).toBe("\r\n");
    expect(projectMarkdownBody(source)).toEqual({ body: "\r\n# Test\r\n本文\r\n", start: source.indexOf("# Test") - 2 });
  });

  it("accepts an ellipsis closing marker", () => {
    expect(projectMarkdownBody("---\ntitle: Test\n...\n# Test\n")).toEqual({ body: "# Test\n", start: 20 });
  });

  it("distinguishes an unterminated opener from no front matter without hiding source", () => {
    const source = "---\ntype: draft\ntitle: [\n# Heading\n本文\n";
    expect(scanFrontMatter(source)).toEqual({ kind: "unterminated", openingStart: 0 });
    expect(projectMarkdownBody(source)).toEqual({ body: source, start: 0 });
    expect(readDocumentProperties(source, "notes.md")).toMatchObject({
      kind: "invalid",
      boundary: undefined,
      message: "Metadata front matter is not closed. Open raw source to repair it."
    });
    expect(applyDocumentProperties(source, "notes.md", defaultProperties, { allowBody: true })).toMatchObject({ kind: "invalid" });
    expect(scanFrontMatter("# Notes\ntext\n")).toEqual({ kind: "none" });
  });

  it("fails closed for an unterminated BOM and CRLF front matter opener", () => {
    const source = "\uFEFF---\r\ntitle: Test\r\n\r\n本文\r\n";
    expect(scanFrontMatter(source)).toEqual({ kind: "unterminated", openingStart: 1 });
    expect(readDocumentProperties(source, "notes.md")).toMatchObject({ kind: "invalid", boundary: undefined });
    expect(projectMarkdownBody(source)).toEqual({ body: source, start: 0 });
  });
});

describe("document properties", () => {
  it("reads supported values without altering unknown metadata", () => {
    const source = "---\n# retained comment\ntype: draft\ntitle: Old\ncustom-field: keep-me\nnested:\n  hello: world\n---\n\n# Old\n本文\n";
    const state = readDocumentProperties(source, "old.md");
    expect(state.kind).toBe("ready");
    if (state.kind === "ready") expect(state.properties).toMatchObject({ title: "Old", type: "draft" });
    const result = applyDocumentProperties(source, "old.md", { ...defaultProperties, title: "New" }, { allowBody: true });
    const next = apply(source, result);
    expect(next).toContain("custom-field: keep-me");
    expect(next).toContain("nested:\n  hello: world");
    expect(next).toContain("# retained comment");
    expect(next).toContain("author: 未田3字");
    expect(next).toContain("created: 2026-10-04");
    expect(next).toContain("# New\n本文\n");
  });

  it("creates front matter only when a no-front-matter document is applied", () => {
    const source = "# Notes\ntext\n";
    expect(readDocumentProperties(source, "Notes.md")).toMatchObject({ kind: "ready", boundary: undefined });
    const next = apply(source, applyDocumentProperties(source, "Notes.md", { ...defaultProperties, title: "Notes", author: "", tags: [], created: "" }, { allowBody: true }));
    expect(next).toBe("---\ntype: draft\ntitle: Notes\n---\n\n# Notes\ntext\n");
  });

  it("fails closed for malformed YAML and complex supported values", () => {
    expect(readDocumentProperties("---\ntitle: [\ntype: draft\n---\n# Test\n", "test.md").kind).toBe("invalid");
    expect(readDocumentProperties("---\nauthor:\n  name: Someone\n---\n# Test\n", "test.md").kind).toBe("raw-only");
    expect(readDocumentProperties("---\ntags:\n  research:\n    - one\n---\n# Test\n", "test.md").kind).toBe("raw-only");
    expect(readDocumentProperties(`---\ntitle: ${"x".repeat(241)}\n---\n# Test\n`, "test.md").kind).toBe("raw-only");
  });

  it("preserves BOM, CRLF, and body bytes while changing supported fields", () => {
    const source = "\uFEFF---\r\ntype: draft\r\ntitle: Old\r\n---\r\n\r\n# Different heading\r\n表 | 値\r\n";
    const next = apply(source, applyDocumentProperties(source, "old.md", { ...defaultProperties, title: "New" }, { allowBody: true }));
    expect(next.startsWith("\uFEFF---\r\n")).toBe(true);
    expect(next.replace(/\r\n/gu, "")).not.toContain("\n");
    expect(next.endsWith("# Different heading\r\n表 | 値\r\n")).toBe(true);
  });

  it("synchronizes only a first H1 exactly matching the prior metadata title", () => {
    const matching = "---\ntype: draft\ntitle: Old\n---\n\n# Old\ntext\n";
    const different = "---\ntype: draft\ntitle: Old\n---\n\n# Deliberately different\ntext\n";
    const matchingNext = apply(matching, applyDocumentProperties(matching, "x.md", defaultProperties, { allowBody: true }));
    const differentNext = apply(different, applyDocumentProperties(different, "x.md", defaultProperties, { allowBody: true }));
    expect(matchingNext).toContain("# New title\n");
    expect(differentNext).toContain("# Deliberately different\n");
  });

  it("never mistakes a fenced-code comment for the first H1", () => {
    const source = "---\ntype: draft\ntitle: Old\n---\n\n```markdown\n# Old\n```\n\n# Old\n";
    const next = apply(source, applyDocumentProperties(source, "x.md", defaultProperties, { allowBody: true }));
    expect(next).toContain("```markdown\n# Old\n```");
    expect(next.endsWith("# New title\n")).toBe(true);
  });

  it("trims empty tags but preserves their order and Unicode", () => {
    const source = "---\ntype: other\ntitle: Test\n---\n\n# Test\n";
    const next = apply(source, applyDocumentProperties(source, "x.md", { ...defaultProperties, tags: ["  一  ", "", "二", "一"] }, { allowBody: true }));
    expect(next).toContain("tags:\n  - 一\n  - 二\n  - 一\n");
  });

  it("does not allow a loose Workdesk document to become body", () => {
    const source = "---\ntype: memo\ntitle: Test\n---\n\n# Test\n";
    expect(applyDocumentProperties(source, "x.md", { ...defaultProperties, type: "body" }, { allowBody: false })).toMatchObject({ kind: "invalid" });
  });

  it("preserves pipe, QuoteRef, and table body content exactly", () => {
    const source = "---\ntype: draft\ntitle: Old\n---\n\n# Different\n[@ann:01H]\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n";
    const next = apply(source, applyDocumentProperties(source, "x.md", defaultProperties, { allowBody: true }));
    expect(next.slice(next.indexOf("# Different"))).toBe(source.slice(source.indexOf("# Different")));
  });
});
