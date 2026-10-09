import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertElectronSmokeMarker, runElectronSmoke } from "./electron-smoke-launcher.mjs";

const marker = "MAGINALIA_BRAND_PROGRESS_SMOKE_OK";
const smokeArgument = "--brand-progress-smoke";
let temporaryDirectory;
try {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "maginalia-brand-progress-smoke-"));
  const result = await runElectronSmoke({
    userDataRoot: path.join(temporaryDirectory, "electron-user-data"),
    appArgs: [smokeArgument],
    env: {
      MAGINALIA_BRAND_SMOKE_OUTPUT: process.env.MAGINALIA_BRAND_SMOKE_OUTPUT
        ?? path.join(temporaryDirectory, "captures"),
    },
  });
  assertElectronSmokeMarker(result, marker, "Branded startup progress smoke");
  process.stdout.write(result.stdout + result.stderr);

  await verifyExpectedFailure({
    temporaryDirectory,
    name: "splash-failure",
    envName: "MAGINALIA_BRAND_SMOKE_FAIL_SPLASH",
    diagnostic: "Branded startup splash failed to load",
  });
  await verifyExpectedFailure({
    temporaryDirectory,
    name: "splash-destroyed",
    envName: "MAGINALIA_BRAND_SMOKE_DESTROY_SPLASH",
    diagnostic: "startup progress window closed before startup completed",
  });
  await verifyExpectedFailure({
    temporaryDirectory,
    name: "renderer-failure",
    envName: "MAGINALIA_BRAND_SMOKE_FAIL_RENDERER",
    diagnostic: "MAGINALIA_BRAND_RENDERER_LOAD_FAILED",
  });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
}

async function verifyExpectedFailure({ temporaryDirectory, name, envName, diagnostic }) {
  const startedAt = Date.now();
  const result = await runElectronSmoke({
    userDataRoot: path.join(temporaryDirectory, `${name}-user-data`),
    appArgs: [smokeArgument],
    env: { [envName]: "1" },
    timeoutMs: 20_000,
  });
  const output = result.stdout + result.stderr;
  const elapsedMs = Date.now() - startedAt;
  if (result.code !== 1 || !output.includes(diagnostic) || output.includes(marker) || elapsedMs > 15_000) {
    throw new Error(
      `Branded startup ${name} did not fail promptly and diagnostically (${result.exitDescription}, ${elapsedMs}ms).\n${output}`
    );
  }
  process.stdout.write(output);
}
