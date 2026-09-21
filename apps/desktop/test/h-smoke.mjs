import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(desktopRoot, "../..");
const electronExecutable = path.join(repositoryRoot, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
const mainPath = path.join(desktopRoot, "dist", "main", "main.js");
const marker = "MAGINALIA_ELECTRON_H_SMOKE_OK";

function runElectron(userDataRoot, fixtureRoot, restore = false) {
  const flag = restore ? "--smoke-h-restore" : "--smoke-h";
  const child = spawn(electronExecutable, [`--user-data-dir=${userDataRoot}`, mainPath, flag, fixtureRoot], {
    cwd: desktopRoot,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Electron H smoke timed out.\n${stdout}${stderr}`)); }, 60_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

let temporaryDirectory;
try {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "maginalia-h-smoke-"));
  const userDataRoot = path.join(temporaryDirectory, "electron-user-data");
  const first = await runElectron(userDataRoot, temporaryDirectory);
  if (first.code !== 0 || !first.stdout.includes(marker)) throw new Error(`Electron H create smoke failed.\n${first.stdout}${first.stderr}`);

  const entries = await readdir(temporaryDirectory, { withFileTypes: true });
  const deskEntry = entries.find((entry) => entry.isDirectory() && entry.name !== "electron-user-data");
  if (!deskEntry) throw new Error("Workdesk folder was not created.");
  const deskRoot = path.join(temporaryDirectory, deskEntry.name);
  const memo = await readFile(path.join(deskRoot, "memo.md"), "utf8");
  if (!memo.includes("H Smoke Memo")) throw new Error("Workdesk loose memo was not created.");
  const childRoot = path.join(deskRoot, "projects");
  const children = await readdir(childRoot, { withFileTypes: true });
  const childEntry = children.find((entry) => entry.isDirectory());
  if (!childEntry) throw new Error("Workdesk child Project was not created.");
  const copy = await readFile(path.join(childRoot, childEntry.name, "memo.md"), "utf8");
  if (copy !== memo) throw new Error("Workdesk copy was not independent byte-preserving Markdown.");

  const restored = await runElectron(userDataRoot, temporaryDirectory, true);
  if (restored.code !== 0 || !restored.stdout.includes(marker)) throw new Error(`Electron H restore smoke failed.\n${restored.stdout}${restored.stderr}`);
  process.stdout.write(first.stdout + first.stderr + restored.stdout + restored.stderr);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
}
