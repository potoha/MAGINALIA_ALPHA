import { describe, expect, it } from "vitest";
import { adaptBookSource, type IsbnBookSource } from "@maginalia/source-core";
import {
  REFERENCE_LIST_MARKER_END,
  REFERENCE_LIST_MARKER_START,
  formatReferenceSource,
  refreshReferenceList
} from "./reference-list";

const sourceA = adaptBookSource({
  isbn13: "9780307476463",
  title: "開かれた作品",
  authors: ["ウンベルト・エーコ"],
  publisher: "青土社",
  publishedDate: "2018"
}) as IsbnBookSource;
const sourceB = adaptBookSource({
  isbn13: "9784003101018",
  title: "別の本",
  authors: ["著者"],
  publisher: "出版社"
}) as IsbnBookSource;

function pair(interior: string): string {
  return `${REFERENCE_LIST_MARKER_START}\n${interior}${interior.length > 0 ? "\n" : ""}${REFERENCE_LIST_MARKER_END}`;
}

describe("reference-list derived region", () => {
  it("appends a deterministic Japanese reference section when absent", () => {
    const result = refreshReferenceList("# Draft\n", [sourceA]);
    expect(result.kind).toBe("changed");
    expect(result.text).toBe(
      `# Draft\n\n## 参考文献\n\n${pair("- ウンベルト・エーコ『開かれた作品』 青土社、2018。")}`
    );
  });

  it("orders and deduplicates sources by stable id", () => {
    const result = refreshReferenceList("", [sourceB, sourceA, sourceA]);
    expect(result.kind).toBe("changed");
    // The identities are not emitted in the normal bibliography line, but
    // each source must occur exactly once through its deterministic ISBN.
    expect(result.text.match(/別の本/gu)?.length).toBe(1);
    expect(result.text.match(/開かれた作品/gu)?.length).toBe(1);
    expect(result.text.indexOf("開かれた作品")).toBeLessThan(result.text.indexOf("別の本"));
  });

  it("replaces only generated interior and preserves surrounding manual text", () => {
    const text = `# Draft\n\n手書きメモ\n${REFERENCE_LIST_MARKER_START}\nold\n${REFERENCE_LIST_MARKER_END}\n\n追記`;
    const result = refreshReferenceList(text, [sourceA]);
    expect(result.kind).toBe("changed");
    expect(result.text).toContain("手書きメモ");
    expect(result.text).toContain("追記");
    expect(result.text).toContain("開かれた作品");
    expect(result.text).not.toContain("old");
  });

  it("empties a valid generated region when no sources resolve", () => {
    const text = `# Draft\n## 参考文献\n${pair("old")}`;
    const result = refreshReferenceList(text, []);
    expect(result.kind).toBe("changed");
    expect(result.text).toBe(`# Draft\n## 参考文献\n${pair("")}`);
  });

  it("does not edit malformed, reversed, duplicate, or nested marker structures", () => {
    const cases = [
      `${REFERENCE_LIST_MARKER_START}\nbody`,
      `${REFERENCE_LIST_MARKER_END}\nbody`,
      `${REFERENCE_LIST_MARKER_END}\n${REFERENCE_LIST_MARKER_START}`,
      pair("one") + `\n${REFERENCE_LIST_MARKER_START}\ninner\n${REFERENCE_LIST_MARKER_END}`,
      `${REFERENCE_LIST_MARKER_START}\nbody\n${REFERENCE_LIST_MARKER_END}\n${REFERENCE_LIST_MARKER_END}`
    ];
    for (const text of cases) {
      const result = refreshReferenceList(text, [sourceA]);
      expect(result.kind).toBe("conflict");
      expect(result.text).toBe(text);
    }
  });

  it("is byte-idempotent and retains CRLF outside the region", () => {
    const text = `# Draft\r\n\r\n${REFERENCE_LIST_MARKER_START}\r\nold\r\n${REFERENCE_LIST_MARKER_END}\r\nmanual`;
    const first = refreshReferenceList(text, [sourceA]);
    expect(first.kind).toBe("changed");
    const second = refreshReferenceList(first.text, [sourceA]);
    expect(second.kind).toBe("unchanged");
    expect(second.text).toBe(first.text);
    expect(first.text).toContain("\r\n");
  });

  it("normalizes and escapes external metadata without placeholders", () => {
    const source = adaptBookSource({
      isbn13: "9780307476463",
      title: "A *title*\nwith control",
      authors: ["Author\tName"],
      publisher: "Pub_[x]"
    }) as IsbnBookSource;
    expect(formatReferenceSource(source)).toContain("A \\*title\\* with control");
    expect(formatReferenceSource(source)).not.toContain("unknown");
  });

  it("falls back to ISBN when all descriptive metadata is absent", () => {
    const source = adaptBookSource({ isbn13: "9780307476463" }) as IsbnBookSource;
    expect(formatReferenceSource(source)).toBe("- ISBN 9780307476463。");
  });
});
