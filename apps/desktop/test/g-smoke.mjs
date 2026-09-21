import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(desktopRoot, "../..");
const electronExecutable = path.join(repositoryRoot, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
const mainPath = path.join(desktopRoot, "dist", "main", "main.js");
const marker = "MAGINALIA_ELECTRON_G_SMOKE_OK";

function runElectron(userDataRoot, projectRoot) {
  const child = spawn(electronExecutable, [`--user-data-dir=${userDataRoot}`, mainPath, "--smoke-g", projectRoot], {
    cwd: desktopRoot,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Electron G smoke timed out.\n${stdout}${stderr}`)); }, 60_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

let temporaryDirectory;
try {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "maginalia-g-smoke-"));
  const projectRoot = path.join(temporaryDirectory, "project-root");
  const userDataRoot = path.join(temporaryDirectory, "electron-user-data");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, "a.md"), "A document.\n\n[[b.md|Open B]]\n", "utf8");
  await writeFile(path.join(projectRoot, "b.md"), "# B\n\nPROJECT_LITERAL_SENTINEL\n", "utf8");
  const result = await runElectron(userDataRoot, projectRoot);
  if (result.code !== 0 || !result.stdout.includes(marker)) {
    throw new Error(`Electron G smoke failed (exit ${result.code ?? result.signal}).\n${result.stdout}${result.stderr}`);
  }
  process.stdout.write(result.stdout + result.stderr);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
}
