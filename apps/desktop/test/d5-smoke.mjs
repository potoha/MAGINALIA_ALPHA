import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertElectronSmokeMarker, repositoryRoot, runElectronSmoke } from "./electron-smoke-launcher.mjs";

const marker = "MAGINALIA_ELECTRON_D5_SMOKE_OK";
const modId = "dev.maginalia.secondary-markdown";

function runElectron(userDataRoot, flag, fixtureRoot) {
  return runElectronSmoke({ userDataRoot, appArgs: [flag, fixtureRoot] });
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
  assertElectronSmokeMarker(first, marker, "Electron D.5 smoke");
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
