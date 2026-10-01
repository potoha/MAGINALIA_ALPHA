import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertElectronSmokeMarker, runElectronSmoke } from "./electron-smoke-launcher.mjs";

const marker = "MAGINALIA_ELECTRON_WORKSPACE_SMOKE_OK";
const manuscriptText = "\uFEFF# こんにちは\r\n\r\nこれは原稿です。\r\n";
const notesText = "\uFEFF# ノート\r\n\r\nこれはノートです。\r\n";
const editedManuscriptText = `${manuscriptText}追記`;
const editedNotesText = `${notesText}追記`;

let temporaryDirectory;
try {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "maginalia-workspace-smoke-"));
  await writeFile(path.join(temporaryDirectory, "manuscript.md"), Buffer.from(manuscriptText, "utf8"));
  await writeFile(path.join(temporaryDirectory, "notes.md"), Buffer.from(notesText, "utf8"));

  const result = await runElectronSmoke({
    userDataRoot: path.join(temporaryDirectory, "electron-user-data"),
    appArgs: ["--smoke-workspace", temporaryDirectory]
  });
  assertElectronSmokeMarker(result, marker, "Electron workspace smoke");

  const actualBytes = await readFile(path.join(temporaryDirectory, "manuscript.md"));
  const expectedBytes = Buffer.from(editedManuscriptText, "utf8");
  if (!actualBytes.equals(expectedBytes)) {
    throw new Error(`Saved manuscript.md bytes did not match expected UTF-8 content: ${JSON.stringify(actualBytes.toString("utf8"))}`);
  }
  const notesBytes = await readFile(path.join(temporaryDirectory, "notes.md"));
  const expectedNotesBytes = Buffer.from(editedNotesText, "utf8");
  if (!notesBytes.equals(expectedNotesBytes)) {
    throw new Error(`Saved notes.md bytes did not match expected UTF-8 content: ${JSON.stringify(notesBytes.toString("utf8"))}`);
  }

  process.stdout.write(`${result.stdout}${result.stderr}`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
}
