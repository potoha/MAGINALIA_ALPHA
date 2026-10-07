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
  let deskRoot;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "electron-user-data") continue;
    const candidate = path.join(temporaryDirectory, entry.name);
    try {
      const markerText = await readFile(path.join(candidate, "workdesk.magi"), "utf8");
      if (markerText.includes("type = workdesk")) {
        deskRoot = candidate;
        break;
      }
    } catch { /* The temporary directory also contains standalone Project fixtures. */ }
  }
  if (!deskRoot) throw new Error("Workdesk folder was not created.");
  const memo = await readFile(path.join(deskRoot, "memo.md"), "utf8");
  if (!memo.includes("H Smoke Memo")) throw new Error("Workdesk loose memo was not created.");
  const childRoot = path.join(deskRoot, "projects");
  const children = await readdir(childRoot, { withFileTypes: true });
  let childEntry;
  for (const entry of children) {
    if (!entry.isDirectory()) continue;
    try {
      await readFile(path.join(childRoot, entry.name, "memo.md"), "utf8");
      childEntry = entry;
      break;
    } catch { /* Only Project B receives the Workdesk memo copy. */ }
  }
  if (!childEntry) throw new Error("Workdesk child Project was not created.");
  const copy = await readFile(path.join(childRoot, childEntry.name, "memo.md"), "utf8");
  if (!memo.includes("H Smoke unsaved update")) throw new Error("Returning to Workdesk did not preserve the edited memo text.");
  if (!copy.includes("H Smoke Memo") || copy.includes("H Smoke unsaved update")) {
    throw new Error("The child Project copy changed when the Workdesk memo was edited.");
  }

  const restored = await runElectron(userDataRoot, temporaryDirectory, true);
  assertElectronSmokeMarker(restored, marker, "Electron H restore smoke");
  process.stdout.write(first.stdout + first.stderr + restored.stdout + restored.stderr);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
}
