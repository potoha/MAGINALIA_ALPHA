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
const marker = "MAGINALIA_ELECTRON_PROJECT_SMOKE_OK";

function runElectron(userDataRoot, smokeFlag, fixtureRoot) {
  const child = spawn(electronExecutable, [`--user-data-dir=${userDataRoot}`, mainPath, smokeFlag, fixtureRoot], {
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
      reject(new Error(`Electron project smoke timed out.\n${stdout}${stderr}`));
    }, 60_000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

let temporaryDirectory;
let userDataDirectory;
try {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "maginalia-project-smoke-"));
  userDataDirectory = await mkdtemp(path.join(tmpdir(), "maginalia-project-userdata-"));
  const result = await runElectron(userDataDirectory, "--smoke-project-create", temporaryDirectory);
  if (result.code !== 0 || !result.stdout.includes(marker)) {
    throw new Error(`Electron project smoke failed (exit ${result.code ?? result.signal}).\n${result.stdout}${result.stderr}`);
  }
  const projectRoot = path.join(temporaryDirectory, "Coffee Smoke");
  const saved = await readFile(path.join(projectRoot, "Smoke memo.md"), "utf8");
  if (!saved.includes("type: memo") || !saved.includes("作成")) {
    throw new Error(`Project smoke file did not retain metadata and edit: ${JSON.stringify(saved)}`);
  }
  const restored = await runElectron(userDataDirectory, "--smoke-project-restore", projectRoot);
  if (restored.code !== 0 || !restored.stdout.includes(marker)) {
    throw new Error(`Electron Project restore smoke failed (exit ${restored.code ?? restored.signal}).\n${restored.stdout}${restored.stderr}`);
  }
  process.stdout.write(`${result.stdout}${result.stderr}${restored.stdout}${restored.stderr}`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  if (userDataDirectory) await rm(userDataDirectory, { recursive: true, force: true });
}
