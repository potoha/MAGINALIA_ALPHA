import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const repositoryRoot = path.resolve(desktopRoot, "../..");
export const electronExecutable = path.join(
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
export const mainPath = path.join(desktopRoot, "dist", "main", "main.js");

function formatExit(code, signal) {
  return code === null ? `signal ${signal ?? "unknown"}` : `exit ${code}`;
}

/**
 * Launch the built Desktop app with Chromium switches before its entry point.
 * A caller-owned, unique profile is required so smoke runs never acquire the
 * normal Desktop single-instance lock.
 */
export function runElectronSmoke({ userDataRoot, appArgs, env = {}, electronSwitches = [], timeoutMs = 60_000 }) {
  if (!userDataRoot) throw new Error("Electron smoke requires an isolated userData directory.");
  if (appArgs.some((argument) => argument.startsWith("--user-data-dir"))) {
    throw new Error("--user-data-dir is an Electron switch and must not be an application argument.");
  }

  const childEnv = {
    ...process.env,
    ...env,
    MAGINALIA_SMOKE_EXPECTED_USER_DATA: path.resolve(userDataRoot)
  };
  // This makes programmatic Electron launches behave as Electron even when a
  // parent Node-based test runner inherited this development-only switch.
  delete childEnv.ELECTRON_RUN_AS_NODE;

  const child = spawn(electronExecutable, [
    ...electronSwitches,
    `--user-data-dir=${userDataRoot}`,
    mainPath,
    ...appArgs
  ], {
    cwd: desktopRoot,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Electron smoke timed out after ${timeoutMs}ms.\n${stdout}${stderr}`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Electron smoke could not spawn: ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, exitDescription: formatExit(code, signal) });
    });
  });
}

export function assertElectronSmokeMarker(result, marker, label) {
  if (result.code === 0 && result.stdout.includes(marker)) return;
  throw new Error(
    `${label} failed (${result.exitDescription}); expected ${marker}.\n`
      + `stdout:\n${result.stdout}\n`
      + `stderr:\n${result.stderr}`
  );
}
