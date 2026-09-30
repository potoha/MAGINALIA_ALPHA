import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(desktopRoot, "../..");
const electronExecutable = path.join(repositoryRoot, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
const mainPath = path.join(desktopRoot, "dist", "main", "main.js");
const marker = "MAGINALIA_ELECTRON_H5_SMOKE_OK";

function isPortClosed(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 2_000);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(false); });
    socket.once("error", () => { clearTimeout(timer); resolve(true); });
  });
}

async function runElectron(userDataRoot) {
  const child = spawn(electronExecutable, [`--user-data-dir=${userDataRoot}`, mainPath, "--smoke-h5"], {
    cwd: desktopRoot,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Electron H.5 smoke timed out.\n${stdout}${stderr}`)); }, 90_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

let temporaryDirectory;
try {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "maginalia-h5-smoke-"));
  const result = await runElectron(path.join(temporaryDirectory, "electron-user-data"));
  if (result.code !== 0 || !result.stdout.includes(marker)) {
    throw new Error(`Electron H.5 smoke failed.\n${result.stdout}${result.stderr}`);
  }
  const match = result.stdout.match(/MAGINALIA_ELECTRON_H5_SMOKE_OK port=(\d+) cooperativeShutdown=1/);
  if (!match) throw new Error(`Electron H.5 smoke did not report its Reviewer port.\n${result.stdout}${result.stderr}`);
  if (!await isPortClosed(Number(match[1]))) {
    throw new Error(`Owned Reviewer still listened on port ${match[1]} after normal Desktop exit.`);
  }
  process.stdout.write(result.stdout + result.stderr);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
}
