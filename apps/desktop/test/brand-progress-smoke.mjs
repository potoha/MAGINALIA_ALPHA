import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertElectronSmokeMarker, runElectronSmoke } from "./electron-smoke-launcher.mjs";

const marker = "MAGINALIA_BRAND_PROGRESS_SMOKE_OK";
let temporaryDirectory;
try {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "maginalia-brand-progress-smoke-"));
  const result = await runElectronSmoke({
    userDataRoot: path.join(temporaryDirectory, "electron-user-data"),
    appArgs: ["--brand-progress-smoke"],
    env: {
      MAGINALIA_BRAND_SMOKE_OUTPUT: process.env.MAGINALIA_BRAND_SMOKE_OUTPUT
        ?? path.join(temporaryDirectory, "captures"),
    },
  });
  assertElectronSmokeMarker(result, marker, "Branded startup progress smoke");
  process.stdout.write(result.stdout + result.stderr);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
}
