import { describe, expect, it } from "vitest";
import { insertLink, setBlockStyle, toggleInline, toggleLinePrefix } from "./markdown-commands";

describe("Markdown command transforms", () => {
  it("sets paragraph and headings over the current block", () => {
    expect(setBlockStyle("plain", 1, 1, 1).text).toBe("# plain");
    expect(setBlockStyle("# old", 2, 2, 0).text).toBe("old");
  });

  it("toggles inline markdown without a private editor API", () => {
    expect(toggleInline("hello", 0, 5, "**").text).toBe("**hello**");
    expect(toggleInline("**hello**", 0, 9, "**").text).toBe("hello");
    expect(toggleInline("hello", 1, 1, "*").changed).toBe(false);
  });

  it("toggles line prefixes and creates portable links", () => {
    expect(toggleLinePrefix("one\ntwo", 0, 7, "- ").text).toBe("- one\n- two");
    expect(toggleLinePrefix("- one\n- two", 0, 11, "- ").text).toBe("one\ntwo");
    expect(insertLink("title", 0, 5, "internal", "notes/eco").text).toBe("[[notes/eco|title]]");
    expect(insertLink("title", 0, 5, "external", "https://example.test").text).toBe("[title](https://example.test)");
  });
});
