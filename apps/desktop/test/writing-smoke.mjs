import { spawn } from "node:child_process";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
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
const marker = "MAGINALIA_ELECTRON_WRITING_SMOKE_OK";
const initialText = "\uFEFF# こんにちは\r\n\r\nこれは保存テストです。\r\n";
const editedText = `${initialText}追記`;

function runElectron(fixturePath) {
  const child = spawn(electronExecutable, [mainPath, "--smoke-writing", fixturePath], {
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
      reject(new Error("Electron writing smoke timed out."));
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
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "maginalia-writing-smoke-"));
  const fixturePath = path.join(temporaryDirectory, "writing.md");
  await writeFile(fixturePath, Buffer.from(initialText, "utf8"));

  const result = await runElectron(fixturePath);
  if (result.code !== 0 || !result.stdout.includes(marker)) {
    throw new Error(`Electron writing smoke failed (exit ${result.code ?? result.signal}).\n${result.stdout}${result.stderr}`);
  }

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
