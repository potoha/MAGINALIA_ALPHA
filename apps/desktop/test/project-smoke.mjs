import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertElectronSmokeMarker, runElectronSmoke } from "./electron-smoke-launcher.mjs";

const marker = "MAGINALIA_ELECTRON_PROJECT_SMOKE_OK";

let temporaryDirectory;
let userDataDirectory;
try {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "maginalia-project-smoke-"));
  userDataDirectory = await mkdtemp(path.join(tmpdir(), "maginalia-project-userdata-"));
  const projectRoot = temporaryDirectory;
  await writeFile(path.join(projectRoot, "project.magi"), `version = 1\ntype = project\nid = ${randomUUID()}\nparent = null\n`, "utf8");
  await writeFile(path.join(projectRoot, "starter.md"), "# Project smoke\n\nInitial authored text.\n", "utf8");
  const result = await runElectronSmoke({
    userDataRoot: userDataDirectory,
    appArgs: ["--smoke-project", projectRoot]
  });
  assertElectronSmokeMarker(result, marker, "Electron project smoke");
  const saved = await readFile(path.join(projectRoot, "Smoke memo.md"), "utf8");
  if (!saved.includes("type: memo") || !saved.includes("追記")) {
    throw new Error(`Project smoke file did not retain metadata and edit: ${JSON.stringify(saved)}`);
  }
  const nestedDirectory = path.join(projectRoot, "資料", "執筆", "深い");
  await mkdir(nestedDirectory, { recursive: true });
  await writeFile(path.join(nestedDirectory, "研究ノート.md"), "# Tree smoke\n\nNested Explorer entry.\n", "utf8");
  const restored = await runElectronSmoke({
    userDataRoot: userDataDirectory,
    appArgs: ["--smoke-project-restore", projectRoot]
  });
  assertElectronSmokeMarker(restored, marker, "Electron Project restore smoke");
  process.stdout.write(`${result.stdout}${result.stderr}${restored.stdout}${restored.stderr}`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  if (userDataDirectory) await rm(userDataDirectory, { recursive: true, force: true });
}
