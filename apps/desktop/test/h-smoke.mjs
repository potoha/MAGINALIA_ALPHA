import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertElectronSmokeMarker, runElectronSmoke } from "./electron-smoke-launcher.mjs";

const marker = "MAGINALIA_ELECTRON_H_SMOKE_OK";

function runElectron(userDataRoot, fixtureRoot, restore = false) {
  const flag = restore ? "--smoke-h-restore" : "--smoke-h";
  return runElectronSmoke({ userDataRoot, appArgs: [flag, fixtureRoot] });
}

let temporaryDirectory;
try {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "maginalia-h-smoke-"));
  const userDataRoot = path.join(temporaryDirectory, "electron-user-data");
  const first = await runElectron(userDataRoot, temporaryDirectory);
  assertElectronSmokeMarker(first, marker, "Electron H create smoke");

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
  assertElectronSmokeMarker(restored, marker, "Electron H restore smoke");
  process.stdout.write(first.stdout + first.stderr + restored.stdout + restored.stderr);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
}
