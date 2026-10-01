import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertElectronSmokeMarker, runElectronSmoke } from "./electron-smoke-launcher.mjs";

const marker = "MAGINALIA_ELECTRON_SMOKE_OK";
let temporaryDirectory;
try {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "maginalia-electron-smoke-"));
  const result = await runElectronSmoke({
    userDataRoot: path.join(temporaryDirectory, "electron-user-data"),
    appArgs: ["--smoke"]
  });
  assertElectronSmokeMarker(result, marker, "Electron basic smoke");
  process.stdout.write(result.stdout + result.stderr);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
}
