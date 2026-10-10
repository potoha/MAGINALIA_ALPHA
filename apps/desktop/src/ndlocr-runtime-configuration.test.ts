import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureNdlocrConfiguration } from "./ndlocr-runtime-configuration";

const ENGINE = "NDLOCR-Lite";
const VERSION = "1.3.1";
const COMMIT = "6feccb29e33c2467ea48894e66502a7788ae2b2d";
const LEGACY_COMMIT = "c3cc7676e7f4613c6b5d51bfae7ca764098424d2";
const LEGACY_DISTRIBUTION_SHA256 = "f9e615ca1bba70c48fee156e685631cc2ef413f5c18c06fcbb9a949382519668";
const EXECUTABLE_RELATIVE_PATH = "ndlocr-lite/ndlocr-lite.exe";
const MANIFEST_RELATIVE_PATH = "ndlocr/runtime-manifest.json";

const temporaryRoots: string[] = [];

async function createFixture(includeRuntime = true) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "maginalia-ndlocr-設定 OCR "));
  temporaryRoots.push(base);
  const resourcesPath = path.join(base, "アプリ 資料", "resources");
  const configPath = path.join(base, "利用者 設定", "MAGINALIA desktop", "ndlocr.json");
  const runtimeRoot = path.join(resourcesPath, "ndlocr");
  const manifestPath = path.join(runtimeRoot, "runtime-manifest.json");
  const executablePath = path.join(runtimeRoot, "ndlocr-lite", "ndlocr-lite.exe");
  const executableBytes = Buffer.from("NDLOCR-Lite test executable bytes", "utf8");
  const executableSha256 = digest(executableBytes);
  const manifest = {
    schemaVersion: 1,
    engine: ENGINE,
    version: VERSION,
    source: {
      repository: "https://github.com/ndl-lab/ndlocr-lite",
      tag: VERSION,
      commit: COMMIT,
    },
    files: [{ path: EXECUTABLE_RELATIVE_PATH, size: executableBytes.length, sha256: executableSha256 }],
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
  const contract = {
    schemaVersion: 1,
    engine: ENGINE,
    version: VERSION,
    sourceCommit: COMMIT,
    manifestPath: MANIFEST_RELATIVE_PATH,
    manifestSha256: digest(manifestBytes),
    executablePath: "ndlocr/ndlocr-lite/ndlocr-lite.exe",
    executableSha256,
  };

  await fs.mkdir(resourcesPath, { recursive: true });
  await fs.writeFile(path.join(resourcesPath, "ndlocr-runtime-contract.json"), JSON.stringify(contract));
  if (includeRuntime) {
    await fs.mkdir(path.dirname(executablePath), { recursive: true });
    await fs.writeFile(manifestPath, manifestBytes);
    await fs.writeFile(executablePath, executableBytes);
  }
  return { base, resourcesPath, configPath, manifestPath, executablePath, contract, manifest, executableBytes };
}

function digest(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function legacyConfiguration(executablePath: string) {
  return {
    engine: ENGINE,
    version: "1.2.3",
    commit: LEGACY_COMMIT,
    distributionSha256: LEGACY_DISTRIBUTION_SHA256,
    executableSha256: "a".repeat(64),
    command: [executablePath, "--sourceimg", "{input}", "--output", "{outputDir}", "--json-only"],
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("managed NDLOCR runtime configuration", () => {
  it("reports the optional component unavailable without creating configuration", async () => {
    const fixture = await createFixture(false);

    const result = await ensureNdlocrConfiguration(fixture.configPath, fixture.resourcesPath);

    expect(result.status).toBe("unavailable");
    expect(result.message).toContain("基本機能は利用できます");
    await expect(fs.stat(fixture.configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes a verified configuration for an installed runtime under Unicode paths with spaces", async () => {
    const fixture = await createFixture();

    const result = await ensureNdlocrConfiguration(fixture.configPath, fixture.resourcesPath);

    expect(result.status).toBe("configured");
    const config = JSON.parse(await fs.readFile(fixture.configPath, "utf8")) as Record<string, unknown>;
    expect(config).toMatchObject({
      schemaVersion: 1,
      managedBy: "MAGINALIA Desktop",
      engine: ENGINE,
      version: VERSION,
      commit: COMMIT,
      distributionSha256: digest(await fs.readFile(fixture.manifestPath)),
      manifestPath: fixture.manifestPath,
      executableSha256: digest(fixture.executableBytes),
      command: [
        fixture.executablePath,
        "--sourceimg", "{input}",
        "--output", "{outputDir}",
        "--json-only",
        "--device", "cpu",
      ],
    });
    expect(path.dirname(fixture.configPath)).toContain("利用者 設定");
    expect(fixture.executablePath).toContain("アプリ 資料");
  });

  it("does not overwrite an unmanaged user configuration", async () => {
    const fixture = await createFixture();
    const original = Buffer.from('{"engine":"other-tool","userSetting":"keep me"}\n', "utf8");
    await fs.mkdir(path.dirname(fixture.configPath), { recursive: true });
    await fs.writeFile(fixture.configPath, original);

    const result = await ensureNdlocrConfiguration(fixture.configPath, fixture.resourcesPath);

    expect(result.status).toBe("conflict");
    expect(await fs.readFile(fixture.configPath)).toEqual(original);
  });

  it("migrates only the exact legacy 1.2.3 configuration after making a byte-identical backup", async () => {
    const fixture = await createFixture();
    const original = Buffer.from(`${JSON.stringify(legacyConfiguration("C:\\Program Files\\NDLOCR\\ndlocr-lite.exe"), null, 2)}\r\n`, "utf8");
    await fs.mkdir(path.dirname(fixture.configPath), { recursive: true });
    await fs.writeFile(fixture.configPath, original);

    const result = await ensureNdlocrConfiguration(fixture.configPath, fixture.resourcesPath);

    expect(result.status).toBe("migrated");
    if (result.status !== "migrated") throw new Error("Expected the known legacy configuration to migrate.");
    expect(path.dirname(result.backupPath)).toBe(path.dirname(fixture.configPath));
    expect(path.basename(result.backupPath)).toMatch(/\.legacy-1\.2\.3-[0-9a-f-]+\.bak$/u);
    expect(await fs.readFile(result.backupPath)).toEqual(original);
    const migrated = JSON.parse(await fs.readFile(fixture.configPath, "utf8")) as Record<string, unknown>;
    expect(migrated).toMatchObject({ version: VERSION, commit: COMMIT, managedBy: "MAGINALIA Desktop" });
  });

  it("preserves the legacy configuration when the optional runtime is absent", async () => {
    const fixture = await createFixture(false);
    const original = Buffer.from(JSON.stringify(legacyConfiguration("C:\\Program Files\\NDLOCR\\ndlocr-lite.exe")));
    await fs.mkdir(path.dirname(fixture.configPath), { recursive: true });
    await fs.writeFile(fixture.configPath, original);

    const result = await ensureNdlocrConfiguration(fixture.configPath, fixture.resourcesPath);

    expect(result.status).toBe("unavailable");
    expect(await fs.readFile(fixture.configPath)).toEqual(original);
    await expect(fs.readdir(path.dirname(fixture.configPath))).resolves.toEqual([path.basename(fixture.configPath)]);
  });

  it("does not treat custom legacy commands or additional settings as migratable", async () => {
    const fixture = await createFixture();
    const customized = {
      ...legacyConfiguration("C:\\Program Files\\NDLOCR\\ndlocr-lite.exe"),
      command: ["C:\\custom-wrapper.exe", "--sourceimg", "{input}", "--output", "{outputDir}", "--json-only", "--custom"],
      userSetting: "preserve",
    };
    const original = Buffer.from(JSON.stringify(customized));
    await fs.mkdir(path.dirname(fixture.configPath), { recursive: true });
    await fs.writeFile(fixture.configPath, original);

    const result = await ensureNdlocrConfiguration(fixture.configPath, fixture.resourcesPath);

    expect(result.status).toBe("conflict");
    expect(await fs.readFile(fixture.configPath)).toEqual(original);
    await expect(fs.readdir(path.dirname(fixture.configPath))).resolves.toEqual([path.basename(fixture.configPath)]);
  });

  it("rejects a contract with a changed upstream identity", async () => {
    const fixture = await createFixture();
    const contractPath = path.join(fixture.resourcesPath, "ndlocr-runtime-contract.json");
    const altered = { ...fixture.contract, sourceCommit: "0".repeat(40) };
    await fs.writeFile(contractPath, JSON.stringify(altered));

    const result = await ensureNdlocrConfiguration(fixture.configPath, fixture.resourcesPath);

    expect(result.status).toBe("invalid");
    await expect(fs.stat(fixture.configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a tampered manifest before writing configuration", async () => {
    const fixture = await createFixture();
    await fs.writeFile(fixture.manifestPath, JSON.stringify(fixture.manifest));

    const result = await ensureNdlocrConfiguration(fixture.configPath, fixture.resourcesPath);

    expect(result.status).toBe("invalid");
    await expect(fs.stat(fixture.configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("updates only its own managed configuration after runtime verification", async () => {
    const fixture = await createFixture();
    await fs.mkdir(path.dirname(fixture.configPath), { recursive: true });
    await fs.writeFile(fixture.configPath, JSON.stringify({ schemaVersion: 1, managedBy: "MAGINALIA Desktop", version: "1.2.3" }));

    const result = await ensureNdlocrConfiguration(fixture.configPath, fixture.resourcesPath);

    expect(result.status).toBe("configured");
    const config = JSON.parse(await fs.readFile(fixture.configPath, "utf8")) as { version: string; commit: string };
    expect(config).toMatchObject({ version: VERSION, commit: COMMIT });
  });

  it("preserves an existing managed configuration when the optional runtime is absent", async () => {
    const fixture = await createFixture(false);
    const original = Buffer.from(JSON.stringify({ schemaVersion: 1, managedBy: "MAGINALIA Desktop", version: "previous" }));
    await fs.mkdir(path.dirname(fixture.configPath), { recursive: true });
    await fs.writeFile(fixture.configPath, original);

    const result = await ensureNdlocrConfiguration(fixture.configPath, fixture.resourcesPath);

    expect(result.status).toBe("unavailable");
    expect(await fs.readFile(fixture.configPath)).toEqual(original);
  });

  it("rejects traversal paths and non-absolute roots", async () => {
    const fixture = await createFixture();
    const contractPath = path.join(fixture.resourcesPath, "ndlocr-runtime-contract.json");
    await fs.writeFile(contractPath, JSON.stringify({ ...fixture.contract, manifestPath: "../runtime-manifest.json" }));

    expect((await ensureNdlocrConfiguration(fixture.configPath, fixture.resourcesPath)).status).toBe("invalid");
    expect((await ensureNdlocrConfiguration("relative/ndlocr.json", fixture.resourcesPath)).status).toBe("invalid");
  });
});
