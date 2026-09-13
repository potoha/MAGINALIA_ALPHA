import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(desktopRoot, "../..");
const electronExecutable = path.join(
  repositoryRoot,
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32"
    ? "electron.exe"
    : process.platform === "darwin"
      ? "Electron.app/Contents/MacOS/Electron"
      : "electron"
);
const mainPath = path.join(desktopRoot, "dist", "main", "main.js");
const marker = "MAGINALIA_ELECTRON_WORKSPACE_SMOKE_OK";
const manuscriptText = "\uFEFF# こんにちは\r\n\r\nこれは原稿です。\r\n";
const notesText = "\uFEFF# ノート\r\n\r\nこれはノートです。\r\n";
const editedManuscriptText = `${manuscriptText}追記`;
const editedNotesText = `${notesText}追記`;

function runElectron(fixtureRoot) {
  const child = spawn(electronExecutable, [mainPath, "--smoke-workspace", fixtureRoot], {
    cwd: desktopRoot,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Electron workspace smoke timed out."));
    }, 60_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

let temporaryDirectory;
try {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "maginalia-workspace-smoke-"));
  await writeFile(path.join(temporaryDirectory, "manuscript.md"), Buffer.from(manuscriptText, "utf8"));
  await writeFile(path.join(temporaryDirectory, "notes.md"), Buffer.from(notesText, "utf8"));

  const result = await runElectron(temporaryDirectory);
  if (result.code !== 0 || !result.stdout.includes(marker)) {
    throw new Error(`Electron workspace smoke failed (exit ${result.code ?? result.signal}).\n${result.stdout}${result.stderr}`);
  }

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
