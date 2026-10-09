import { mkdtemp, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagedExecutable = process.env.MAGINALIA_SMOKE_PACKAGED_EXECUTABLE;
if (!packagedExecutable || !path.isAbsolute(packagedExecutable)) {
  throw new Error("Set MAGINALIA_SMOKE_PACKAGED_EXECUTABLE to the built Desktop executable.");
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "maginalia-profile-location-日本語-"));
const safeTemporaryRoot = path.resolve(temporaryRoot);
const safeTemporaryBase = `${path.resolve(tmpdir())}${path.sep}`;
if (!safeTemporaryRoot.startsWith(safeTemporaryBase)) throw new Error("Temporary profile escaped the operating system temp directory.");
const selectedProfile = path.join(temporaryRoot, "selected-profile");

try {
  const childEnv = {
    ...process.env,
    PATH: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32"),
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.MAGINALIA_SMOKE_EXPECTED_USER_DATA;
  const result = await launch(packagedExecutable, selectedProfile, childEnv);
  if (result.code !== 0 || !result.stdout.includes("MAGINALIA_ELECTRON_SMOKE_OK")) {
    throw new Error(`Packaged Desktop did not start with a fresh isolated Windows profile (exit ${result.code ?? result.signal}).\n${result.stdout}\n${result.stderr}`);
  }
  const match = result.stdout.match(/MAGINALIA_ELECTRON_SMOKE_OK userData=(.+)/);
  if (!match || path.resolve(JSON.parse(match[1])) !== path.resolve(selectedProfile)) {
    throw new Error(`The packaged app did not retain Electron's selected profile path. Expected ${selectedProfile}.\n${result.stdout}`);
  }
  if (!(await stat(selectedProfile)).isDirectory()) throw new Error("The packaged app did not create the selected profile directory.");
  process.stdout.write(`${result.stdout.trim()}\n`);
  process.stdout.write(`MAGINALIA_PROFILE_PRESERVATION_SMOKE_OK selectedProfileRetained=true\n`);
} finally {
  await rm(safeTemporaryRoot, { recursive: true, force: true });
}

function launch(executable, selectedProfile, env) {
  const child = spawn(executable, [`--user-data-dir=${selectedProfile}`, "--smoke"], { cwd: desktopRoot, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Packaged profile smoke timed out.\n${stdout}\n${stderr}`));
    }, 60_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}
