import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertElectronSmokeMarker, runElectronSmoke } from "./electron-smoke-launcher.mjs";

const marker = "MAGINALIA_ELECTRON_G_SMOKE_OK";

let temporaryDirectory;
try {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "maginalia-g-smoke-"));
  const projectRoot = path.join(temporaryDirectory, "project-root");
  const userDataRoot = path.join(temporaryDirectory, "electron-user-data");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, "a.md"), "A document.\n\n[[b.md|Open B]]\n", "utf8");
  await writeFile(path.join(projectRoot, "b.md"), "# B\n\nPROJECT_LITERAL_SENTINEL\n", "utf8");
  await writeFile(path.join(projectRoot, "c.md"), "# C\n\nThird document.\n", "utf8");
  const result = await runElectronSmoke({ userDataRoot, appArgs: ["--smoke-g", projectRoot] });
  assertElectronSmokeMarker(result, marker, "Electron G smoke");
  const restored = await runElectronSmoke({ userDataRoot, appArgs: ["--smoke-g-restore", projectRoot] });
  assertElectronSmokeMarker(restored, marker, "Electron G restore smoke");
  process.stdout.write(result.stdout + result.stderr + restored.stdout + restored.stderr);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
}
