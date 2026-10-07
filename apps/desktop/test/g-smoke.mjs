import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertElectronSmokeMarker, runElectronSmoke } from "./electron-smoke-launcher.mjs";

const marker = "MAGINALIA_ELECTRON_G_SMOKE_OK";

let temporaryDirectory;
try {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "maginalia-g-smoke-"));
  const projectRoot = path.join(temporaryDirectory, "project-root");
  const userDataRoot = path.join(temporaryDirectory, "electron-user-data");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(path.join(projectRoot, "nested"), { recursive: true });
  await writeFile(path.join(projectRoot, "a.md"), "A document.\n\n[[b.md|Open B]]\n", "utf8");
  await writeFile(path.join(projectRoot, "b.md"), "# B\n\nPROJECT_LITERAL_SENTINEL\n", "utf8");
  await writeFile(path.join(projectRoot, "c.md"), "# C\n\nThird document.\n", "utf8");
  await writeFile(path.join(projectRoot, "nested", "notes.md"), "# Nested source\n\nPROJECT_NESTED_SYNC_SENTINEL\n", "utf8");
  await writeFile(path.join(projectRoot, "chapter.md"), "---\ntitle: Chapter\n---\n\n# Chapter\n\nChapter prose.\n\n<!-- maginalia:synced-block v1 {\"target\":\"section.md\"} -->\n", "utf8");
  await writeFile(path.join(projectRoot, "section.md"), "---\ntitle: Section\n---\n\n# Section\n\nSection prose.\n", "utf8");
  const trailingQuoteRef = '<!-- maginalia:quote-ref v1 {"quoteId":"00000000-0000-4000-8000-000000000044","mode":"normal"} -->';
  const trailingSyncedBlock = '<!-- maginalia:synced-block v1 {"target":"section.md"} -->';
  await writeFile(path.join(projectRoot, "trailing-heading.md"), "# H1 only", "utf8");
  await writeFile(path.join(projectRoot, "trailing-paragraph.md"), "ordinary final paragraph", "utf8");
  await writeFile(path.join(projectRoot, "trailing-quote.md"), trailingQuoteRef, "utf8");
  await writeFile(path.join(projectRoot, "trailing-synced.md"), trailingSyncedBlock, "utf8");
  await writeFile(path.join(projectRoot, "preview-enter-crlf.md"), "# 見出し\r\n\r\n前🌸日本語後続\r\n次の行\r\n", "utf8");
  await writeFile(path.join(projectRoot, "preview-enter-lf.md"), "# 見出し\n\n前🌸日本語後続\n次の行\n", "utf8");
  await writeFile(path.join(projectRoot, "preview-enter-tail.md"), "末尾の文", "utf8");
  const protectedProse = "保護対象前";
  await writeFile(path.join(projectRoot, "preview-enter-protected-quote.md"), `${protectedProse}\n${trailingQuoteRef}`, "utf8");
  const protectedImage = "![[assets/preview-enter.png]]";
  await writeFile(path.join(projectRoot, "preview-enter-protected-image.md"), `${protectedProse}\n${protectedImage}`, "utf8");
  await writeFile(path.join(projectRoot, "preview-enter-protected-synced.md"), `${protectedProse}\n${trailingSyncedBlock}`, "utf8");
  await writeFile(path.join(projectRoot, "preview-enter-undo.md"), "Undo前後", "utf8");
  await writeFile(path.join(projectRoot, "preview-enter-structural.md"), [
    "# 見出し",
    "",
    "- 項目",
    "",
    "> 引用",
    "",
    "本文 **強調** [リンク](https://example.test)",
    "",
    trailingQuoteRef,
    "",
    "| A | B |",
    "| --- | --- |",
    "| 1 | 2 |"
  ].join("\n"), "utf8");
  const result = await runElectronSmoke({ userDataRoot, appArgs: ["--smoke-g", projectRoot] });
  assertElectronSmokeMarker(result, marker, "Electron G smoke");
  const restored = await runElectronSmoke({ userDataRoot, appArgs: ["--smoke-g-restore", projectRoot] });
  assertElectronSmokeMarker(restored, marker, "Electron G restore smoke");
  process.stdout.write(result.stdout + result.stderr + restored.stdout + restored.stderr);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
}
