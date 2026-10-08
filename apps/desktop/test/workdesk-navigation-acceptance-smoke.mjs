import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertElectronSmokeMarker, runElectronSmoke } from "./electron-smoke-launcher.mjs";

const [workdeskRoot, projectRoot] = process.argv.slice(2);
if (!workdeskRoot || !projectRoot) {
  throw new Error("Usage: npm run smoke:h-navigation-acceptance -- <workdesk-root> <project-root>");
}

const marker = "MAGINALIA_ELECTRON_H_SMOKE_OK";
const portableIndex = ".maginalia/workdesk-projects.json";

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function snapshotTree(root, { skipGit = false, skipRelative = null } = {}) {
  const result = new Map();
  const visit = async (directory, relative = "") => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en", { sensitivity: "variant" }));
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if ((skipGit && entry.name.toLowerCase() === ".git") || childRelative === skipRelative) continue;
      const absolute = path.join(directory, entry.name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) {
        result.set(childRelative, `link:${await import("node:fs/promises").then(({ readlink }) => readlink(absolute))}`);
      } else if (metadata.isDirectory()) {
        result.set(childRelative, "directory");
        await visit(absolute, childRelative);
      } else if (metadata.isFile()) {
        result.set(childRelative, `file:${metadata.mode & 0o777}:${metadata.size}:${hash(await readFile(absolute))}`);
      } else {
        result.set(childRelative, `other:${metadata.mode}`);
      }
    }
  };
  await visit(root);
  return result;
}

function gitValue(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true }).trim();
}

async function gitSnapshot(root) {
  const exists = await lstat(path.join(root, ".git")).then(() => true, () => false);
  if (!exists) return null;
  const indexPath = gitValue(root, ["rev-parse", "--git-path", "index"]);
  const absoluteIndexPath = path.isAbsolute(indexPath) ? indexPath : path.resolve(root, indexPath);
  return {
    head: gitValue(root, ["rev-parse", "HEAD"]),
    status: gitValue(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
    index: hash(await readFile(absoluteIndexPath)),
  };
}

function assertSameTree(before, after, label) {
  if (before.size !== after.size) throw new Error(`${label} file set changed (${before.size} → ${after.size}).`);
  for (const [name, value] of before) {
    if (after.get(name) !== value) throw new Error(`${label} content changed: ${name}`);
  }
}

function assertGitUnchanged(before, after, expectedNewStatus) {
  if (JSON.stringify(before && { head: before.head, index: before.index })
    !== JSON.stringify(after && { head: after.head, index: after.index })) {
    throw new Error("Real Workdesk Git HEAD or index changed during acceptance.");
  }
  if (before === null && after === null) return;
  const oldLines = (before?.status ?? "").split("\n").filter(Boolean);
  const newLines = (after?.status ?? "").split("\n").filter(Boolean);
  const removed = oldLines.filter((line) => !newLines.includes(line));
  const added = newLines.filter((line) => !oldLines.includes(line));
  if (removed.length !== 0 || added.some((line) => line !== expectedNewStatus)
    || added.length > (expectedNewStatus ? 1 : 0)) {
    throw new Error(`Real Workdesk Git status changed unexpectedly: ${JSON.stringify({ removed, added })}`);
  }
}

let temporaryDirectory;
try {
  const canonicalWorkdesk = path.resolve(workdeskRoot);
  const canonicalProject = path.resolve(projectRoot);
  const markerPath = path.join(canonicalWorkdesk, "workdesk.magi");
  const projectMarkerPath = path.join(canonicalProject, "project.magi");
  const [workdeskMarkerBefore, projectMarkerBefore] = await Promise.all([
    readFile(markerPath),
    readFile(projectMarkerPath),
  ]);
  const existingPortableIndex = await readFile(path.join(canonicalWorkdesk, portableIndex)).then((value) => value, (error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  const workdeskTreeBefore = await snapshotTree(canonicalWorkdesk, { skipGit: true, skipRelative: portableIndex });
  const projectTreeBefore = await snapshotTree(canonicalProject, { skipGit: true });
  const workdeskGitBefore = await gitSnapshot(canonicalWorkdesk);
  const projectGitBefore = await gitSnapshot(canonicalProject);

  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "maginalia-h-navigation-real-"));
  const userDataRoot = path.join(temporaryDirectory, "electron-user-data");
  const first = await runElectronSmoke({
    userDataRoot,
    appArgs: ["--smoke-h-acceptance", canonicalWorkdesk, canonicalProject],
    timeoutMs: 90_000,
  });
  assertElectronSmokeMarker(first, marker, "real Workdesk navigation first-run acceptance");
  const restored = await runElectronSmoke({
    userDataRoot,
    appArgs: ["--smoke-h-acceptance-restore", canonicalWorkdesk, canonicalProject],
    timeoutMs: 90_000,
  });
  assertElectronSmokeMarker(restored, marker, "real Workdesk navigation restart acceptance");

  const indexBytes = await readFile(path.join(canonicalWorkdesk, portableIndex));
  const index = JSON.parse(indexBytes.toString("utf8"));
  const projectMarker = projectMarkerBefore.toString("utf8");
  const id = /^id\s*=\s*([0-9a-f-]{36})\s*$/imu.exec(projectMarker)?.[1];
  if (!id || index?.schemaVersion !== 1 || !Array.isArray(index.projects)
    || index.projects.filter((entry) => entry?.projectIdentityId === id).length !== 1) {
    throw new Error("The real Workdesk portable index does not contain exactly one registration for the real Project.");
  }
  if (!existingPortableIndex && index.projects.length !== 1) {
    throw new Error("The real Workdesk portable index contains an unexpected additional registration.");
  }

  assertSameTree(workdeskTreeBefore,
    await snapshotTree(canonicalWorkdesk, { skipGit: true, skipRelative: portableIndex }), "Workdesk authored data");
  assertSameTree(projectTreeBefore,
    await snapshotTree(canonicalProject, { skipGit: true }), "Project authored data and marker");
  if (!(await readFile(markerPath)).equals(workdeskMarkerBefore)
    || !(await readFile(projectMarkerPath)).equals(projectMarkerBefore)) {
    throw new Error("A real folder identity marker changed during acceptance.");
  }
  const expectedStatus = existingPortableIndex ? null : "?? .maginalia/workdesk-projects.json";
  assertGitUnchanged(workdeskGitBefore, await gitSnapshot(canonicalWorkdesk), expectedStatus);
  assertGitUnchanged(projectGitBefore, await gitSnapshot(canonicalProject), null);
  process.stdout.write(first.stdout + first.stderr + restored.stdout + restored.stderr);
  process.stdout.write(`REAL_WORKDESK_NAVIGATION_ACCEPTANCE_OK workdesk=${JSON.stringify(canonicalWorkdesk)} project=${JSON.stringify(canonicalProject)} portableIndex=${JSON.stringify(path.join(canonicalWorkdesk, portableIndex))}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
}
