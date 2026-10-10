import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import * as path from "node:path";

const EXPECTED_COMMIT = "6feccb29e33c2467ea48894e66502a7788ae2b2d";

export async function buildNdlocrRuntime({ repositoryRoot, packagingRoot, runtimeRoot, stagingRoot, versions }) {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("NDLOCR-Lite runtime packaging requires a Windows x64 build host.");
  }

  const lockPath = path.join(repositoryRoot, "sidecars", "reviewer", "ndlocr-lite-1.3.1.lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  if (lock.sourceCommit !== EXPECTED_COMMIT || lock.tag !== "1.3.1") {
    throw new Error("The NDLOCR-Lite source lock does not match the reviewed 1.3.1 release.");
  }

  const sourceRoot = path.join(stagingRoot, "ndlocr-source");
  const pyprojectRoot = path.join(repositoryRoot, "sidecars", "reviewer", "ndlocr-runtime");
  const buildRoot = path.join(stagingRoot, "ndlocr-pyinstaller");
  const distRoot = path.join(stagingRoot, "ndlocr-dist");
  const componentRoot = path.join(runtimeRoot, "ndlocr");
  await rm(sourceRoot, { recursive: true, force: true });
  await rm(buildRoot, { recursive: true, force: true });
  await rm(distRoot, { recursive: true, force: true });
  await rm(componentRoot, { recursive: true, force: true });

  await run("git", ["clone", "--depth", "1", "--branch", lock.tag, lock.repository, sourceRoot], repositoryRoot);
  const sourceCommit = (await runCaptured("git", ["rev-parse", "HEAD"], sourceRoot)).stdout.trim();
  if (sourceCommit.toLowerCase() !== EXPECTED_COMMIT) {
    throw new Error(`NDLOCR-Lite tag resolved to an unexpected source commit: ${sourceCommit}`);
  }
  for (const input of lock.verifiedUpstreamInputs) {
    const filename = path.join(sourceRoot, ...input.path.split("/"));
    const info = await stat(filename);
    const digest = await sha256(filename);
    if (info.size !== input.bytes || digest !== input.sha256) {
      throw new Error(`Pinned NDLOCR-Lite source input failed verification: ${input.path}`);
    }
  }
  const smokeImageSource = path.join(sourceRoot, ...lock.smokeImage.path.split("/"));
  const smokeImageInfo = await stat(smokeImageSource);
  if (smokeImageInfo.size !== lock.smokeImage.bytes || await sha256(smokeImageSource) !== lock.smokeImage.sha256) {
    throw new Error("Pinned NDLOCR-Lite Japanese smoke image failed verification.");
  }

  await run("uv", ["sync", "--project", pyprojectRoot, "--locked", "--python", versions.ndlocrPython], repositoryRoot);
  const pythonVersionOutput = await runCaptured("uv", ["run", "--project", pyprojectRoot, "--locked", "--python", versions.ndlocrPython, "python", "--version"], repositoryRoot);
  const pythonVersion = pythonVersionOutput.stdout.trim().replace(/^Python\s+/u, "");
  if (!/^3\.11\.\d+$/u.test(pythonVersion)) throw new Error(`NDLOCR runtime build selected an unsupported Python version: ${pythonVersion}`);
  await run("uv", ["run", "--project", pyprojectRoot, "--locked", "--python", versions.ndlocrPython, "python", "src/set_version.py", lock.tag], sourceRoot);
  await mkdir(buildRoot, { recursive: true });
  await mkdir(distRoot, { recursive: true });
  await run("uv", [
    "run", "--project", pyprojectRoot, "--locked", "--python", versions.ndlocrPython,
    "python", "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir",
    "--name", "ndlocr-lite", "--distpath", distRoot, "--workpath", buildRoot,
    "--specpath", buildRoot, "--paths", path.join(sourceRoot, "src"),
    "--add-data", `${path.join(sourceRoot, "src", "model")};model`,
    "--add-data", `${path.join(sourceRoot, "src", "config")};config`,
    path.join(sourceRoot, "src", "ocr.py"),
  ], repositoryRoot);

  const builtRoot = path.join(distRoot, "ndlocr-lite");
  const executable = path.join(builtRoot, "ndlocr-lite.exe");
  await access(executable);
  const cleanPath = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  const version = await runCaptured(executable, ["--version"], sourceRoot, { PATH: cleanPath });
  if (!version.stdout.includes("1.3.1") && !version.stderr.includes("1.3.1")) {
    throw new Error("The standalone NDLOCR-Lite executable did not report version 1.3.1.");
  }

  const smokeRoot = path.join(stagingRoot, "OCR検証 資料");
  const smokeOutput = path.join(stagingRoot, "OCR 出力 制限PATH 1.3.1");
  await mkdir(smokeRoot, { recursive: true });
  await mkdir(smokeOutput, { recursive: true });
  const smokeImage = path.join(smokeRoot, "縦書き日本語 資料.png");
  await cp(smokeImageSource, smokeImage);
  await runCaptured(executable, [
    "--sourceimg", smokeImage, "--output", smokeOutput, "--json-only", "--device", "cpu",
  ], sourceRoot, { PATH: cleanPath });
  const smokeJsonPath = path.join(smokeOutput, `${path.parse(smokeImage).name}.json`);
  const smokeJson = JSON.parse(await readFile(smokeJsonPath, "utf8"));
  const regions = smokeJson?.contents?.[0];
  if (!Array.isArray(regions) || regions.length === 0) {
    throw new Error("Standalone NDLOCR-Lite smoke output did not contain recognized regions.");
  }
  if (!(smokeJson?.imginfo?.img_width > 0) || !(smokeJson?.imginfo?.img_height > 0)) {
    throw new Error("Standalone NDLOCR-Lite smoke output did not include valid image dimensions.");
  }
  if (typeof regions[0]?.text !== "string" || !regions[0].text || !Array.isArray(regions[0]?.boundingBox)) {
    throw new Error("Standalone NDLOCR-Lite smoke output did not match the reviewed region contract.");
  }

  await mkdir(path.dirname(componentRoot), { recursive: true });
  await cp(builtRoot, path.join(componentRoot, "ndlocr-lite"), { recursive: true });
  await copyLicenseInputs({ sourceRoot, componentRoot, pyprojectRoot, versions, repositoryRoot, lock });
  await cp(lockPath, path.join(componentRoot, "source-lock.json"));

  const files = await enumerateFiles(componentRoot);
  const runtimeManifest = {
    schemaVersion: 1,
    engine: "NDLOCR-Lite",
    version: lock.tag,
    source: { repository: lock.repository, tag: lock.tag, commit: sourceCommit },
    build: {
      host: `${process.platform}-${process.arch}`,
      python: pythonVersion,
      onnxruntime: lock.build.onnxruntime,
      pyinstaller: lock.build.pyinstaller,
      mode: lock.build.mode,
      device: lock.build.device,
    },
    builtAt: new Date().toISOString(),
    licensing: [
      { name: "NDLOCR-Lite", license: "CC BY 4.0", file: "licenses/NDLOCR-Lite-LICENCE.txt", source: lock.repository },
      { name: "DINOv3-derived model", license: "Meta DINOv3 license", file: "licenses/Meta-DINOv3-LICENSE.md", source: lock.dinoV3License.repository },
      { name: "Python dependencies", license: "Per-package license terms", file: "licenses/dependencies/DEPENDENCIES.json" },
    ],
    files,
    totalBytes: files.reduce((total, entry) => total + entry.size, 0),
  };
  const manifestPath = path.join(componentRoot, "runtime-manifest.json");
  const manifestBytes = `${JSON.stringify(runtimeManifest, null, 2)}\n`;
  await writeFile(manifestPath, manifestBytes, "utf8");
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  const executableRelativePath = "ndlocr-lite/ndlocr-lite.exe";
  const executableSha256 = files.find((entry) => entry.path === executableRelativePath)?.sha256;
  if (!executableSha256) throw new Error("Built NDLOCR executable was not recorded in its runtime manifest.");

  const contract = {
    schemaVersion: 1,
    engine: "NDLOCR-Lite",
    version: lock.tag,
    sourceCommit,
    manifestPath: "ndlocr/runtime-manifest.json",
    manifestSha256,
    executablePath: `ndlocr/${executableRelativePath}`,
    executableSha256,
  };
  await writeFile(path.join(runtimeRoot, "ndlocr-runtime-contract.json"), `${JSON.stringify(contract, null, 2)}\n`, "utf8");
  await writeFile(path.join(runtimeRoot, "ndlocr-installer-size.nsh"), `!define MAGINALIA_NDLOCR_SIZE_MB ${Math.ceil(runtimeManifest.totalBytes / 1_000_000)}\n`, "utf8");

  process.stdout.write(`NDLOCR-Lite ${lock.tag} standalone CPU runtime verified and staged (${runtimeManifest.totalBytes} bytes; ${files.length} files).\n`);
}

async function copyLicenseInputs({ sourceRoot, componentRoot, pyprojectRoot, versions, repositoryRoot, lock }) {
  const licensesRoot = path.join(componentRoot, "licenses");
  const dependencyRoot = path.join(licensesRoot, "dependencies");
  await mkdir(dependencyRoot, { recursive: true });
  await cp(path.join(sourceRoot, "LICENCE"), path.join(licensesRoot, "NDLOCR-Lite-LICENCE.txt"));
  await cp(path.join(sourceRoot, "LICENCE_DEPENDENCEIES"), path.join(licensesRoot, "NDLOCR-Lite-DEPENDENCY-LICENCES.txt"));
  await cp(path.join(repositoryRoot, "sidecars", "reviewer", "ndlocr-runtime", "licenses", "Meta-DINOv3-LICENSE.md"), path.join(licensesRoot, "Meta-DINOv3-LICENSE.md"));

  const sitePackages = path.join(pyprojectRoot, ".venv", "Lib", "site-packages");
  const entries = await readdir(sitePackages, { withFileTypes: true });
  const dependencyPackages = [];
  const licenseOverrides = new Map((lock.dependencyLicenses ?? []).map((item) => [`${item.name.toLowerCase()}@${item.version}`, item.license]));
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(".dist-info")) continue;
    const directory = path.join(sitePackages, entry.name);
    const metadata = await readFile(path.join(directory, "METADATA"), "utf8").catch(() => "");
    const name = metadata.match(/^Name:\s*(.+)$/imu)?.[1]?.trim() ?? entry.name;
    const version = metadata.match(/^Version:\s*(.+)$/imu)?.[1]?.trim() ?? "unknown";
    const licenseKey = `${name.toLowerCase()}@${version}`;
    const classifiers = [...metadata.matchAll(/^Classifier:\s*License :: OSI Approved :: (.+)$/gimu)].map((match) => match[1].trim());
    const license = metadata.match(/^License-Expression:\s*(.+)$/imu)?.[1]?.trim()
      ?? metadata.match(/^License:\s*(.+)$/imu)?.[1]?.trim()
      ?? licenseOverrides.get(licenseKey)
      ?? (classifiers.length > 0 ? classifiers.join("; ") : "unspecified");
    if (license === "unspecified") {
      throw new Error(`No verified license metadata is recorded for ${name} ${version}.`);
    }
    dependencyPackages.push({ name, version, license });
    await copyLicenseFiles(directory, path.join(dependencyRoot, `${safeName(name)}-${safeName(version)}`));
  }
  dependencyPackages.sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
  await writeFile(path.join(dependencyRoot, "DEPENDENCIES.json"), `${JSON.stringify(dependencyPackages, null, 2)}\n`, "utf8");

  for (const licenseFile of lock.additionalLicenseFiles ?? []) {
    const source = path.join(repositoryRoot, ...licenseFile.repositoryPath.split("/"));
    if (await sha256(source) !== licenseFile.sha256) {
      throw new Error(`Pinned third-party license file failed verification: ${licenseFile.name} ${licenseFile.version}.`);
    }
    const dependency = dependencyPackages.find((item) => item.name.toLowerCase() === licenseFile.name.toLowerCase());
    if (!dependency || dependency.version !== licenseFile.version) {
      throw new Error(`Pinned third-party license does not match the packaged dependency: ${licenseFile.name} ${licenseFile.version}.`);
    }
    const destination = path.join(dependencyRoot, `${safeName(licenseFile.name)}-${safeName(licenseFile.version)}`, licenseFile.filename);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination);
  }

  const pythonRoot = (await runCaptured("uv", ["run", "--project", pyprojectRoot, "--locked", "--python", versions.ndlocrPython, "python", "-c", "import sys; print(sys.base_prefix)"], pyprojectRoot)).stdout.trim();
  const pythonLicense = path.join(pythonRoot, "LICENSE.txt");
  await access(pythonLicense);
  await cp(pythonLicense, path.join(licensesRoot, "Python-LICENSE.txt"));

  const pyinstallerLicense = path.join(sitePackages, `pyinstaller-${versions.pyinstaller}.dist-info`, "licenses", "COPYING.txt");
  await access(pyinstallerLicense);
  await cp(pyinstallerLicense, path.join(licensesRoot, "PyInstaller-COPYING.txt"));

  const licenseFiles = await enumerateFiles(licensesRoot);
  let combined = [
    "NDLOCR-Lite 1.3.1 third-party license materials",
    `Source: https://github.com/ndl-lab/ndlocr-lite/tree/${EXPECTED_COMMIT}`,
    "NDLOCR-Lite was developed by the National Diet Library. This attribution does not imply endorsement of MAGINALIA.",
    "The following files are the applicable license and notice materials included with the optional component.",
    "",
  ].join("\n");
  for (const entry of licenseFiles.filter((item) => item.path !== "LICENSES.txt")) {
    const fullPath = path.join(licensesRoot, ...entry.path.split("/"));
    if (!/\.(?:txt|md|json)$/iu.test(entry.path)) continue;
    combined += `\n\n===== ${entry.path} =====\n\n${await readFile(fullPath, "utf8")}`;
  }
  await writeFile(path.join(licensesRoot, "LICENSES.txt"), combined, "utf8");
}

async function copyLicenseFiles(source, destination) {
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (/^(?:licenses?|third[-_ ]party|legal)$/iu.test(entry.name)) {
        await copyLicenseFiles(path.join(source, entry.name), path.join(destination, entry.name));
      }
      continue;
    }
    if (entry.isFile() && /^(?:license|licence|copying|notice|copyright)(?:[._-].*)?$/iu.test(entry.name)) {
      await mkdir(destination, { recursive: true });
      await cp(path.join(source, entry.name), path.join(destination, entry.name));
    }
  }
}

async function enumerateFiles(root) {
  const files = [];
  async function visit(current, relative = "") {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const filename = path.join(current, entry.name);
      const itemPath = relative ? path.posix.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) await visit(filename, itemPath);
      else if (entry.isFile()) files.push({ path: itemPath.replaceAll("\\", "/"), size: (await stat(filename)).size, sha256: await sha256(filename) });
      else throw new Error(`NDLOCR runtime contains an unsupported filesystem entry: ${itemPath}`);
    }
  }
  await visit(root);
  return files;
}

function safeName(value) {
  return value.replaceAll(/[<>:"/\\|?*]/gu, "_");
}

async function sha256(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", windowsHide: true, shell: false });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0
      ? resolve()
      : reject(new Error(`${path.basename(command)} failed (${code ?? signal ?? "unknown"}).`)));
  });
}

function runCaptured(command, args, cwd, overrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      env: { ...process.env, ...overrides },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`${path.basename(command)} failed (${code ?? signal ?? "unknown"}): ${stderr || stdout}`)));
  });
}
