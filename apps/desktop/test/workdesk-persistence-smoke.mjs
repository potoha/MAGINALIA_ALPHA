import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createIdentity, templateFiles } from "@maginalia/repository-core";
import { assertElectronSmokeMarker, runElectronSmoke } from "./electron-smoke-launcher.mjs";

const marker = "MAGINALIA_ELECTRON_WORKDESK_PERSISTENCE_OK";

let temporaryDirectory;
try {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "maginalia-workdesk-persistence-"));
  const userDataRoot = path.join(temporaryDirectory, "electron-user-data");
  const workdeskRoot = path.join(temporaryDirectory, "選択した Workdesk");
  const identity = createIdentity("workbench", "Persistence Smoke Workdesk", "d0590000-0000-4000-8000-000000000059");
  for (const [relative, contents] of Object.entries(templateFiles(identity))) {
    const destination = path.join(workdeskRoot, ...relative.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents, "utf8");
  }

  const first = await runElectronSmoke({
    userDataRoot,
    appArgs: ["--smoke-workdesk-persistence", workdeskRoot]
  });
  assertElectronSmokeMarker(first, marker, "normal Desktop first-run Workdesk selection");
  const expectedUserData = path.resolve(userDataRoot);
  const expectedPathStore = path.join(expectedUserData, "workdesk-paths.json");
  if (!first.stdout.includes(`stage=first-run pickerCalls=1 userData=${JSON.stringify(expectedUserData)} pathStore=${JSON.stringify(expectedPathStore)}`)) {
    throw new Error(`First-run smoke did not confirm its exact Electron userData and path store paths.\n${first.stdout}${first.stderr}`);
  }

  const workdeskIdentity = JSON.parse(await readFile(path.join(workdeskRoot, ".maginalia", "repository.json"), "utf8"));
  const childIdentity = createIdentity("project", "Shortcut Smoke Project", "d0590000-0000-4000-8000-000000000060");
  const childRoot = path.join(workdeskRoot, "projects", "shortcut-smoke");
  for (const [relative, contents] of Object.entries(templateFiles(childIdentity))) {
    const destination = path.join(childRoot, ...relative.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents, "utf8");
  }
  await writeFile(path.join(workdeskRoot, ".maginalia", "workdesk-projects.json"), `${JSON.stringify({
    schemaVersion: 1,
    projects: [{ projectIdentityId: childIdentity.id, title: childIdentity.title }]
  }, null, 2)}\n`, "utf8");
  const localState = JSON.parse(await readFile(expectedPathStore, "utf8"));
  localState.workdesks[workdeskIdentity.id] = {
    projects: { [childIdentity.id]: { rootPath: await realpath(childRoot) } }
  };
  await writeFile(expectedPathStore, `${JSON.stringify(localState)}\n`, "utf8");

  const restarted = await runElectronSmoke({
    userDataRoot,
    appArgs: ["--smoke-workdesk-persistence-restore", workdeskRoot]
  });
  assertElectronSmokeMarker(restarted, marker, "normal Desktop Workdesk restart restore");
  if (!restarted.stdout.includes(`stage=restore pickerCalls=0 userData=${JSON.stringify(expectedUserData)} pathStore=${JSON.stringify(expectedPathStore)}`)) {
    throw new Error(`Restart smoke did not confirm restore without the folder picker using the same paths.\n${restarted.stdout}${restarted.stderr}`);
  }
  process.stdout.write(first.stdout + first.stderr + restarted.stdout + restarted.stderr);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
}
