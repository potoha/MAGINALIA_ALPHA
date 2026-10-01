import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { assertElectronSmokeMarker, runElectronSmoke } from "./electron-smoke-launcher.mjs";

const marker = "MAGINALIA_ELECTRON_H5_SMOKE_OK";

function isPortClosed(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 2_000);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(false); });
    socket.once("error", () => { clearTimeout(timer); resolve(true); });
  });
}

let temporaryDirectory;
try {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "maginalia-h5-smoke-"));
  const result = await runElectronSmoke({
    userDataRoot: path.join(temporaryDirectory, "electron-user-data"),
    appArgs: ["--smoke-h5"],
    timeoutMs: 90_000
  });
  assertElectronSmokeMarker(result, marker, "Electron H.5 smoke");
  const match = result.stdout.match(/MAGINALIA_ELECTRON_H5_SMOKE_OK port=(\d+) cooperativeShutdown=1/);
  if (!match) throw new Error(`Electron H.5 smoke did not report its Reviewer port.\n${result.stdout}${result.stderr}`);
  if (!await isPortClosed(Number(match[1]))) {
    throw new Error(`Owned Reviewer still listened on port ${match[1]} after normal Desktop exit.`);
  }
  process.stdout.write(result.stdout + result.stderr);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
}
