import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
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
const marker = "MAGINALIA_ELECTRON_D5_SMOKE_OK";
const modId = "dev.maginalia.secondary-markdown";

function runElectron(userDataRoot, flag, fixtureRoot) {
  const child = spawn(electronExecutable, [
    `--user-data-dir=${userDataRoot}`,
    mainPath,
    flag,
    fixtureRoot
  ], {
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
      reject(new Error(`Electron D.5 smoke timed out.\n${stdout}${stderr}`));
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

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

let temporaryDirectory;
try {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "maginalia-d5-smoke-"));
  const projectRoot = path.join(temporaryDirectory, "project-root");
  const userDataRoot = path.join(temporaryDirectory, "electron-user-data");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(path.join(userDataRoot, "mods"), { recursive: true });
  await writeFile(path.join(projectRoot, "first.md"), "# First\n\nFirst document.\n", "utf8");
  await writeFile(path.join(projectRoot, "second.md"), "# Second\n\nSecond document.\n", "utf8");
  // A repository nested in Project content must never be discovered as a Mod.
  await mkdir(path.join(projectRoot, "random-js-repo"), { recursive: true });
  await writeFile(
    path.join(projectRoot, "random-js-repo", "maginalia.mod.json"),
    JSON.stringify({ id: "dev.example.project-repo", name: "Project Repo", version: "0.1.0", apiVersion: 1, main: "index.js" })
      + "\n",
    "utf8"
  );

  const firstPartyMod = path.join(repositoryRoot, "mods", modId);
  await cp(firstPartyMod, path.join(userDataRoot, "mods", modId), { recursive: true });

  const first = await runElectron(userDataRoot, "--smoke-d5", projectRoot);
  if (first.code !== 0 || !first.stdout.includes(marker)) {
    throw new Error(`Electron D.5 smoke failed (exit ${first.code ?? first.signal}).\n${first.stdout}${first.stderr}`);
  }
  const firstText = await readFile(path.join(projectRoot, "first.md"), "utf8");
  if (!firstText.includes("D5 tab edit") || !firstText.includes("D5 close autosave") || !firstText.includes("D5 shutdown autosave")) {
    throw new Error("D.5 smoke did not persist the active tab edits.");
  }
  if (await exists(path.join(userDataRoot, "mods", modId))) {
    throw new Error("D.5 smoke did not remove the first-party Mod after reload.");
  }

  const restored = await runElectron(userDataRoot, "--smoke-d5-restore", projectRoot);
  if (restored.code !== 0 || !restored.stdout.includes(marker)) {
    let savedWorkspace = "<workspace-state unavailable>";
    try {
      savedWorkspace = await readFile(path.join(userDataRoot, "workspace-state.json"), "utf8");
    } catch {
      // Include the normal Electron output below when no state file exists.
    }
    throw new Error(`Electron D.5 restore smoke failed (exit ${restored.code ?? restored.signal}).\n${restored.stdout}${restored.stderr}\nworkspace-state.json:\n${savedWorkspace}`);
  }
  process.stdout.write(first.stdout + first.stderr + restored.stdout + restored.stderr);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
}
