import { describe, expect, it } from "vitest";

import {
  projectSyncedDocument,
  resolveProjectComposition,
  scanSyncedBlockMarkers,
  serializeSyncedBlock,
  validateSyncedBlockTarget,
  wouldIntroduceSyncedBlockCycle,
} from "./synced-block";
import { projectMarkdownPreviewSource } from "./markdown-renderer";

const marker = (target: string): string => serializeSyncedBlock(target);

describe("Synced Block marker contract", () => {
  it("serializes and scans only a strict portable v1 marker", () => {
    const source = `before\n\n${marker("chapters/春.md")}\n\nafter`;
    expect(scanSyncedBlockMarkers(source)).toEqual([{
      kind: "valid",
      marker: marker("chapters/春.md"),
      target: "chapters/春.md",
      start: source.indexOf("<!--"),
      end: source.indexOf("-->") + 3,
    }]);
    expect(validateSyncedBlockTarget("../../outside.md")).toBeNull();
    expect(validateSyncedBlockTarget("C:\\secret.md")).toBeNull();
    expect(validateSyncedBlockTarget("notes/no-extension")).toBeNull();
  });

  it("keeps malformed and unknown markers inert, including fenced code", () => {
    const source = [
      "```md",
      marker("fake.md"),
      "```",
      "<!-- maginalia:synced-block v2 {\"target\":\"future.md\"} -->",
      "<!-- maginalia:synced-block v1 {\"target\":\"ok.md\",\"extra\":true} -->",
    ].join("\n");
    const scanned = scanSyncedBlockMarkers(source);
    expect(scanned).toHaveLength(2);
    expect(scanned.map((item) => item.kind === "invalid" ? item.reason : "valid")).toEqual(["unsupported-version", "malformed"]);
  });

  it("does not treat metadata text as a composition edge", () => {
    const source = `---\nnote: '${marker("not-a-child.md")}'\n---\n\n${marker("real.md")}`;
    expect(scanSyncedBlockMarkers(source)).toMatchObject([{ kind: "valid", target: "real.md" }]);
  });

  it("only scans complete structural marker lines", () => {
    expect(scanSyncedBlockMarkers(`prose ${marker("not-a-block.md")}`)).toEqual([]);
    expect(scanSyncedBlockMarkers(`> ${marker("quote.md")}\n- ${marker("list.md")}`)).toEqual([]);
  });

  it("keeps a leading-BOM marker aligned with the Renderer block parser", () => {
    const source = `\uFEFF${marker("first.md")}\n`;
    expect(scanSyncedBlockMarkers(source)).toMatchObject([{
      kind: "valid",
      target: "first.md",
      start: 1,
      end: source.length - 1,
    }]);
  });
});

describe("Synced Block source projection", () => {
  it("strips bounded front matter and the first real H1 while preserving preface and lower headings", () => {
    const source = "\uFEFF---\r\ntitle: Child\r\n---\r\npreface\r\n# Child\r\nparagraph\r\n## Section\r\n";
    expect(projectSyncedDocument(source)).toEqual({
      kind: "projected",
      bodyStart: source.indexOf("preface"),
      markdown: "preface\r\nparagraph\r\n## Section\r\n",
    });
  });

  it("does not treat a fenced fake H1 as the document title and fails closed for unterminated metadata", () => {
    expect(projectSyncedDocument("```md\n# Fake\n```\n# Real\ntext\n")).toMatchObject({
      kind: "projected",
      markdown: "```md\n# Fake\n```\ntext\n",
    });
    expect(projectSyncedDocument("---\ntitle: broken\n# body\n")).toMatchObject({ kind: "invalid-front-matter" });
  });

  it("recognizes and removes a first H1 after a BOM without front matter", () => {
    expect(projectSyncedDocument("\uFEFF# Child\n本文\n")).toMatchObject({
      kind: "projected",
      markdown: "本文\n",
    });
  });

  it("uses the shared Renderer H1 grammar", () => {
    expect(projectSyncedDocument("#\tChild\n本文\n")).toMatchObject({
      kind: "projected",
      markdown: "本文\n",
    });
  });

  it("retains a child table and documents without an H1 after metadata projection", () => {
    expect(projectSyncedDocument("---\ntitle: Table child\n---\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n")).toMatchObject({
      kind: "projected",
      markdown: "\n| A | B |\n| --- | --- |\n| 1 | 2 |\n",
    });
    expect(projectSyncedDocument("preface only\n")).toMatchObject({ kind: "projected", markdown: "preface only\n" });
  });

  it("does not project a child body a second time when it begins with thematic-rule-like text", async () => {
    const rawChild = `---\ntitle: Child\n---\n# Child\n---\n${marker("nested.md")}\n---\nTail\n`;
    const projected = projectSyncedDocument(rawChild);
    expect(projected).toMatchObject({
      kind: "projected",
      markdown: `---\n${marker("nested.md")}\n---\nTail\n`,
    });
    if (projected.kind !== "projected") throw new Error("expected projected child");
    expect(projectMarkdownPreviewSource(projected.markdown, "already-projected").body).toBe(projected.markdown);
    expect(scanSyncedBlockMarkers(projected.markdown, { sourceMode: "already-projected" })).toMatchObject([
      { kind: "valid", target: "nested.md" },
    ]);

    const sources = new Map<string, string>([
      ["child.md", rawChild],
      ["nested.md", "# Nested\nNested body\n"],
    ]);
    const composition = await resolveProjectComposition(marker("child.md"), {
      rootTarget: "parent.md",
      resolve: async (target) => ({ kind: "resolved", target, fileId: target, displayName: target, text: sources.get(target)! }),
    });
    expect(composition.blocks.get(marker("child.md"))?.children?.get(marker("nested.md"))).toMatchObject({
      kind: "resolved",
      markdown: "Nested body\n",
    });
  });
});

describe("Synced Block composition", () => {
  it("recursively composes sources and rejects cycles without recursing", async () => {
    const sources = new Map<string, string>([
      ["a.md", `A\n${marker("b.md")}`],
      ["b.md", `---\ntitle: B\n---\n# B\nB\n${marker("c.md")}`],
      ["c.md", "# C\nC"],
    ]);
    const composition = await resolveProjectComposition(sources.get("a.md")!, {
      rootTarget: "a.md",
      resolve: async (target) => ({ kind: "resolved", target, fileId: target, displayName: target, text: sources.get(target)! }),
    });
    const b = composition.blocks.get(marker("b.md"));
    expect(b).toMatchObject({ kind: "resolved", markdown: "B\n<!-- maginalia:synced-block v1 {\"target\":\"c.md\"} -->" });
    expect(b?.children?.get(marker("c.md"))).toMatchObject({ kind: "resolved", markdown: "C" });

    sources.set("c.md", `# C\n${marker("a.md")}`);
    const cyclic = await resolveProjectComposition(sources.get("a.md")!, {
      rootTarget: "a.md",
      resolve: async (target) => ({ kind: "resolved", target, fileId: target, displayName: target, text: sources.get(target)! }),
    });
    expect(cyclic.blocks.get(marker("b.md"))?.children?.get(marker("c.md"))?.children?.get(marker("a.md")))
      .toMatchObject({ kind: "unresolved", message: expect.stringContaining("cycle") });
  });

  it("returns bounded unresolved blocks for unavailable source and traversal limits", async () => {
    const missing = await resolveProjectComposition(marker("missing.md"), {
      rootTarget: "root.md",
      resolve: async () => ({ kind: "missing", message: "Synced document unavailable." }),
    });
    expect(missing.blocks.get(marker("missing.md"))).toMatchObject({ kind: "unresolved" });
    const limited = await resolveProjectComposition(marker("one.md"), {
      rootTarget: "root.md",
      maxNodes: 0,
      resolve: async () => ({ kind: "resolved", target: "one.md", fileId: "one", displayName: "one.md", text: "text" }),
    });
    expect(limited.blocks.get(marker("one.md"))).toMatchObject({ kind: "unresolved", message: expect.stringContaining("limit") });
  });

  it("counts unresolved valid targets toward the traversal bound", async () => {
    const composition = await resolveProjectComposition(`${marker("missing-a.md")}\n${marker("missing-b.md")}`, {
      rootTarget: "root.md",
      maxNodes: 1,
      resolve: async () => ({ kind: "missing", message: "Synced document unavailable." }),
    });
    expect(composition.blocks.get(marker("missing-a.md"))).toMatchObject({ kind: "unresolved", message: "Synced document unavailable." });
    expect(composition.blocks.get(marker("missing-b.md"))).toMatchObject({ kind: "unresolved", message: expect.stringContaining("limit") });
  });

  it("fails closed when insertion-time cycle analysis reaches its graph bound", async () => {
    const sources = new Map<string, string>([
      ["b.md", marker("c.md")],
      ["c.md", marker("a.md")],
    ]);
    await expect(wouldIntroduceSyncedBlockCycle("a.md", "b.md", async (target) => ({
      kind: "resolved", target, fileId: target, displayName: target, text: sources.get(target) ?? "",
    }), 1)).resolves.toBe(true);
  });
});
