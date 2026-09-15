import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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
const marker = "MAGINALIA_ELECTRON_REPOSITORY_SMOKE_OK";

function runElectron(smokeRoot) {
  const child = spawn(electronExecutable, [mainPath, "--smoke-repository", smokeRoot], {
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
      reject(new Error("Electron repository smoke timed out."));
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
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "maginalia-repository-smoke-"));
  await mkdir(path.join(temporaryDirectory, "repository-parent"));
  await mkdir(path.join(temporaryDirectory, "history-destination"));

  const result = await runElectron(temporaryDirectory);
  if (result.code !== 0 || !result.stdout.includes(marker)) {
    throw new Error(
      "Electron repository smoke failed (exit "
        + (result.code ?? result.signal)
        + ").\n"
        + result.stdout
        + result.stderr
    );
  }

  const parentEntries = await readdir(path.join(temporaryDirectory, "repository-parent"));
  const destinationEntries = await readdir(path.join(temporaryDirectory, "history-destination"));
  if (parentEntries.length !== 2 || destinationEntries.length !== 1) {
    throw new Error(
      `Repository smoke left an unexpected temporary layout (${parentEntries.length} source entries, ${destinationEntries.length} copy entries).`
    );
  }
  let output = "";
  for (const entry of parentEntries) {
    output = await readFile(path.join(temporaryDirectory, "repository-parent", entry, "manuscript.md"), "utf8").catch(() => "");
    if (output.length > 0) break;
  }
  if (!output.includes("SECOND_HISTORY_VERSION")) {
    throw new Error("Repository smoke did not leave the source working copy at its latest saved version.");
  }
  process.stdout.write(result.stdout + result.stderr);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
}
