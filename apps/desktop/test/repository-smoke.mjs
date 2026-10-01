import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertElectronSmokeMarker, runElectronSmoke } from "./electron-smoke-launcher.mjs";

const marker = "MAGINALIA_ELECTRON_REPOSITORY_SMOKE_OK";

let temporaryDirectory;
try {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "maginalia-repository-smoke-"));
  await mkdir(path.join(temporaryDirectory, "repository-parent"));
  await mkdir(path.join(temporaryDirectory, "history-destination"));

  const result = await runElectronSmoke({
    userDataRoot: path.join(temporaryDirectory, "electron-user-data"),
    appArgs: ["--smoke-repository", temporaryDirectory]
  });
  assertElectronSmokeMarker(result, marker, "Electron repository smoke");

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
