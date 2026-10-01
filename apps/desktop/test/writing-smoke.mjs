import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertElectronSmokeMarker, runElectronSmoke } from "./electron-smoke-launcher.mjs";

const marker = "MAGINALIA_ELECTRON_WRITING_SMOKE_OK";
const initialText = "\uFEFF# こんにちは\r\n\r\nこれは保存テストです。\r\n";
const editedText = `${initialText}追記`;

let temporaryDirectory;
try {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "maginalia-writing-smoke-"));
  const fixturePath = path.join(temporaryDirectory, "writing.md");
  await writeFile(fixturePath, Buffer.from(initialText, "utf8"));

  const result = await runElectronSmoke({
    userDataRoot: path.join(temporaryDirectory, "electron-user-data"),
    appArgs: ["--smoke-writing", fixturePath]
  });
  assertElectronSmokeMarker(result, marker, "Electron writing smoke");

  const actualBytes = await readFile(fixturePath);
  const expectedBytes = Buffer.from(editedText, "utf8");
  if (!actualBytes.equals(expectedBytes)) {
    throw new Error(`Saved fixture bytes did not match the expected UTF-8 content: ${JSON.stringify(actualBytes.toString("utf8"))}`);
  }

  process.stdout.write(`${result.stdout}${result.stderr}`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
}
