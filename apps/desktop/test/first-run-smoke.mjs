import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertElectronSmokeMarker, desktopRoot, runElectronSmoke } from "./electron-smoke-launcher.mjs";

const marker = "MAGINALIA_FIRST_RUN_SMOKE_OK";
let temporaryDirectory;
try {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "maginalia-first-run-smoke-"));
  const userDataRoot = path.join(temporaryDirectory, "electron-user-data");
  const workdeskRoot = path.join(temporaryDirectory, "Documents", "MAGINALIA", "Workdesk");
  const shelfRoot = path.join(temporaryDirectory, "Documents", "MAGINALIA", "Private Shelf");
  const downloadsRoot = path.join(temporaryDirectory, "Downloads");
  const outputDirectory = path.resolve(desktopRoot, "../../docs/installer-readiness/screenshots");
  const result = await runElectronSmoke({
    userDataRoot,
    appArgs: ["--first-run-smoke"],
    env: {
      MAGINALIA_FIRST_RUN_SMOKE_WORKDESK: workdeskRoot,
      MAGINALIA_FIRST_RUN_SMOKE_SHELF: shelfRoot,
      MAGINALIA_FIRST_RUN_SMOKE_DOWNLOADS: downloadsRoot,
      MAGINALIA_FIRST_RUN_SMOKE_OUTPUT: outputDirectory,
    },
    timeoutMs: 180_000,
  });
  assertElectronSmokeMarker(result, marker, "First-run setup Electron smoke");
  for (const filename of ["first-run-setup.png", "first-run-complete.png", "tutorial-project-open.png"]) {
    const screenshot = path.join(outputDirectory, filename);
    await access(screenshot);
    if ((await stat(screenshot)).size < 1_000) throw new Error(`First-run screenshot is unexpectedly small: ${filename}`);
  }
  const restarted = await runElectronSmoke({
    userDataRoot,
    appArgs: ["--first-run-restore-smoke"],
    env: { MAGINALIA_FIRST_RUN_SMOKE_WORKDESK: workdeskRoot },
    timeoutMs: 90_000,
  });
  assertElectronSmokeMarker(restarted, "MAGINALIA_FIRST_RUN_RESTORE_SMOKE_OK", "first-run Tutorial Project restart restore");
  process.stdout.write(result.stdout + result.stderr + restarted.stdout + restarted.stderr);
  process.stdout.write(`First-run screenshots: ${outputDirectory}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
}
