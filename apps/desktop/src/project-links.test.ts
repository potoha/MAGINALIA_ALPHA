import { describe, expect, it } from "vitest";
import {
  internalLinkDisplayName,
  parseInternalLinks,
  renderInternalLinksForExport,
  validateInternalLinkTarget
} from "./project-links";

describe("Project internal links", () => {
  it("parses canonical target and custom-label forms", () => {
    expect(parseInternalLinks("[[notes/eco.md]] and [[notes/eco.md|エーコについて]]")).toMatchObject([
      { kind: "link", target: "notes/eco.md" },
      { kind: "link", target: "notes/eco.md", label: "エーコについて" }
    ]);
  });

  it("does not parse media, fenced code, or inline code as links", () => {
    expect(parseInternalLinks("![[assets/a.webp]] `[[code]]`\n```\n[[fence]]\n```\n[[ok]]"))
      .toMatchObject([{ kind: "link", target: "ok" }]);
  });

  it("rejects traversal, absolute paths, schemes, and unsupported extensions", () => {
    for (const target of ["../x", "notes/../x", "/x", "C:/x", "\\\\server\\x", "https://x", "notes/a.txt"]) {
      expect(validateInternalLinkTarget(target).kind).toBe("invalid");
    }
  });

  it("exports only a label or basename and never the internal target", () => {
    const output = renderInternalLinksForExport("[[notes/eco.md]] / [[notes/eco.md|エーコについて]] / [[../secret.md|bad]]");
    expect(output).toBe("eco / エーコについて / unresolved link");
    expect(output).not.toContain("notes/");
    expect(output).not.toContain("secret");
    expect(internalLinkDisplayName("notes/eco.markdown")).toBe("eco");
  });
});
