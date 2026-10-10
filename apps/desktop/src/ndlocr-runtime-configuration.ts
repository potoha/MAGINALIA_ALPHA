import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const ENGINE = "NDLOCR-Lite";
const VERSION = "1.3.1";
const SOURCE_COMMIT = "6feccb29e33c2467ea48894e66502a7788ae2b2d";
const EXPECTED_MANIFEST_PATH = "ndlocr/runtime-manifest.json";
const EXPECTED_EXECUTABLE_PATH = "ndlocr/ndlocr-lite/ndlocr-lite.exe";
const CONFIG_SCHEMA_VERSION = 1;
const MANAGED_BY = "MAGINALIA Desktop";
const HASH_PATTERN = /^[a-f0-9]{64}$/i;
const LEGACY_VERSION = "1.2.3";
const LEGACY_COMMIT = "c3cc7676e7f4613c6b5d51bfae7ca764098424d2";
const LEGACY_DISTRIBUTION_SHA256 = "f9e615ca1bba70c48fee156e685631cc2ef413f5c18c06fcbb9a949382519668";
const LEGACY_CONFIG_KEYS = ["engine", "version", "commit", "distributionSha256", "executableSha256", "command"];

interface NdlocrRuntimeContract {
  readonly schemaVersion: 1;
  readonly engine: typeof ENGINE;
  readonly version: typeof VERSION;
  readonly sourceCommit: typeof SOURCE_COMMIT;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly executablePath: string;
  readonly executableSha256: string;
}

interface NdlocrRuntimeManifest {
  readonly schemaVersion: 1;
  readonly engine: typeof ENGINE;
  readonly version: typeof VERSION;
  readonly source: {
    readonly repository: string;
    readonly tag: string;
    readonly commit: string;
  };
  readonly files: readonly {
    readonly path: string;
    readonly size: number;
    readonly sha256: string;
  }[];
}

export interface ManagedNdlocrConfiguration {
  readonly schemaVersion: 1;
  readonly managedBy: typeof MANAGED_BY;
  readonly engine: typeof ENGINE;
  readonly version: typeof VERSION;
  readonly commit: typeof SOURCE_COMMIT;
  readonly distributionSha256: string;
  readonly manifestPath: string;
  readonly executableSha256: string;
  readonly command: readonly [
    string,
    "--sourceimg",
    "{input}",
    "--output",
    "{outputDir}",
    "--json-only",
    "--device",
    "cpu",
  ];
}

export type NdlocrConfigurationResult =
  | { readonly status: "configured"; readonly message: string }
  | { readonly status: "migrated"; readonly message: string; readonly backupPath: string }
  | { readonly status: "unavailable"; readonly message: string }
  | { readonly status: "conflict"; readonly message: string }
  | { readonly status: "invalid"; readonly message: string };

const MESSAGES = Object.freeze({
  configured: "文字認識機能の設定を確認しました。",
  unavailable: "このPCには文字認識機能が追加されていません。MAGINALIAの基本機能は利用できます。",
  conflict: "文字認識機能の設定は既存の設定を保護するため変更しませんでした。設定を確認してください。",
  invalid: "文字認識機能の構成を確認できませんでした。アプリを再インストールするか、サポートにご相談ください。",
  migrated: "以前の文字認識設定を控えとして保存し、新しい設定へ更新しました。",
});

function result(status: Exclude<NdlocrConfigurationResult["status"], "migrated">): NdlocrConfigurationResult {
  return { status, message: MESSAGES[status] } as NdlocrConfigurationResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function resolveContractPath(resourcesRoot: string, relativePath: unknown): string | undefined {
  if (typeof relativePath !== "string" || relativePath.length === 0) return undefined;
  // Contract paths are portable POSIX-style relative paths. Reject alternate
  // separators and drive/UNC forms rather than letting them vary by host OS.
  if (relativePath.includes("\\") || path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) return undefined;
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return undefined;
  const candidate = path.resolve(resourcesRoot, ...segments);
  return isContained(resourcesRoot, candidate) ? candidate : undefined;
}

function isContract(value: unknown): value is NdlocrRuntimeContract {
  return isRecord(value)
    && value.schemaVersion === 1
    && value.engine === ENGINE
    && value.version === VERSION
    && value.sourceCommit === SOURCE_COMMIT
    && value.manifestPath === EXPECTED_MANIFEST_PATH
    && isSha256(value.manifestSha256)
    && value.executablePath === EXPECTED_EXECUTABLE_PATH
    && isSha256(value.executableSha256);
}

function isManifest(value: unknown): value is NdlocrRuntimeManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.engine !== ENGINE || value.version !== VERSION) return false;
  if (!isRecord(value.source)
    || value.source.repository !== "https://github.com/ndl-lab/ndlocr-lite"
    || value.source.tag !== VERSION
    || value.source.commit !== SOURCE_COMMIT
    || !Array.isArray(value.files)) return false;
  return value.files.every((file) => isRecord(file)
    && typeof file.path === "string"
    && Number.isSafeInteger(file.size)
    && (file.size as number) >= 0
    && isSha256(file.sha256));
}

async function readJson(filePath: string): Promise<unknown> {
  const contents = await fs.readFile(filePath, "utf8");
  return JSON.parse(contents) as unknown;
}

type ExistingConfiguration =
  | { readonly status: "missing" }
  | { readonly status: "managed"; readonly bytes: Buffer }
  | { readonly status: "legacy"; readonly bytes: Buffer }
  | { readonly status: "unmanaged" };

function isLegacyConfiguration(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== LEGACY_CONFIG_KEYS.length || keys.some((key, index) => key !== [...LEGACY_CONFIG_KEYS].sort()[index])) return false;
  if (value.engine !== ENGINE
    || value.version !== LEGACY_VERSION
    || value.commit !== LEGACY_COMMIT
    || value.distributionSha256 !== LEGACY_DISTRIBUTION_SHA256
    || !isSha256(value.executableSha256)
    || !Array.isArray(value.command)
    || value.command.length !== 6) return false;
  const command = value.command;
  return typeof command[0] === "string"
    && (path.isAbsolute(command[0]) || path.win32.isAbsolute(command[0]))
    && command[1] === "--sourceimg"
    && command[2] === "{input}"
    && command[3] === "--output"
    && command[4] === "{outputDir}"
    && command[5] === "--json-only";
}

async function inspectExistingConfiguration(configPath: string): Promise<ExistingConfiguration> {
  let stat;
  try {
    stat = await fs.lstat(configPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { status: "missing" };
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return { status: "unmanaged" };
  try {
    const bytes = await fs.readFile(configPath);
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    if (isRecord(parsed) && parsed.schemaVersion === CONFIG_SCHEMA_VERSION && parsed.managedBy === MANAGED_BY) {
      return { status: "managed", bytes };
    }
    if (isLegacyConfiguration(parsed)) return { status: "legacy", bytes };
    return { status: "unmanaged" };
  } catch {
    return { status: "unmanaged" };
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function writeConfigAtomically(
  configPath: string,
  configuration: ManagedNdlocrConfiguration,
  replace: boolean,
  beforeCommit?: () => Promise<void>,
): Promise<void> {
  const directory = path.dirname(configPath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(configPath)}.${crypto.randomUUID()}.tmp`);
  const bytes = Buffer.from(`${JSON.stringify(configuration, null, 2)}\n`, "utf8");
  try {
    const handle = await fs.open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await beforeCommit?.();
    if (replace) {
      await fs.rename(temporaryPath, configPath);
    } else {
      // Hard-link creation is exclusive and atomic on the same volume. It
      // prevents a file that appeared after inspection from being overwritten.
      await fs.link(temporaryPath, configPath);
      await fs.unlink(temporaryPath);
    }
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function createLegacyConfigurationBackup(configPath: string, bytes: Buffer): Promise<string> {
  const directory = path.dirname(configPath);
  const baseName = path.basename(configPath);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const backupPath = path.join(directory, `${baseName}.legacy-${LEGACY_VERSION}-${crypto.randomUUID()}.bak`);
    let created = false;
    let complete = false;
    try {
      const handle = await fs.open(backupPath, "wx", 0o600);
      created = true;
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const backupBytes = await fs.readFile(backupPath);
      if (!backupBytes.equals(bytes)) throw new Error("Legacy OCR configuration backup verification failed.");
      complete = true;
      return backupPath;
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") continue;
      throw error;
    } finally {
      if (created && !complete) await fs.rm(backupPath, { force: true }).catch(() => undefined);
    }
  }
  throw new Error("Could not allocate a unique legacy OCR configuration backup name.");
}

/**
 * Materialize only the MAGINALIA-managed NDLOCR configuration after verifying
 * the optional packaged runtime. User-owned settings are never replaced. The
 * exact documented 1.2.3 configuration is migrated only after a byte-verified
 * backup is created in the same application-data directory.
 */
export async function ensureNdlocrConfiguration(
  configPath: string,
  resourcesPath: string,
): Promise<NdlocrConfigurationResult> {
  if (!path.isAbsolute(configPath) || !path.isAbsolute(resourcesPath)) return result("invalid");

  const absoluteConfigPath = path.resolve(configPath);
  const resourcesRoot = path.resolve(resourcesPath);
  let priorConfig: ExistingConfiguration;
  try {
    priorConfig = await inspectExistingConfiguration(absoluteConfigPath);
  } catch {
    return result("conflict");
  }
  if (priorConfig.status === "unmanaged") return result("conflict");

  let resourcesRealPath: string;
  try {
    resourcesRealPath = await fs.realpath(resourcesRoot);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return result("unavailable");
    return result("invalid");
  }

  const contractPath = path.join(resourcesRoot, "ndlocr-runtime-contract.json");
  let contractRaw: unknown;
  try {
    const contractRealPath = await fs.realpath(contractPath);
    if (!isContained(resourcesRealPath, contractRealPath)) return result("invalid");
    contractRaw = await readJson(contractRealPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return result("invalid");
    return result("invalid");
  }
  if (!isContract(contractRaw)) return result("invalid");

  const manifestPath = resolveContractPath(resourcesRoot, contractRaw.manifestPath);
  const executablePath = resolveContractPath(resourcesRoot, contractRaw.executablePath);
  if (!manifestPath || !executablePath) return result("invalid");

  let manifestRealPath: string;
  let manifestBytes: Buffer;
  try {
    manifestRealPath = await fs.realpath(manifestPath);
    if (!isContained(resourcesRealPath, manifestRealPath)) return result("invalid");
    manifestBytes = await fs.readFile(manifestRealPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return result("unavailable");
    return result("invalid");
  }
  const manifestHash = sha256(manifestBytes);
  if (manifestHash.toLowerCase() !== contractRaw.manifestSha256.toLowerCase()) return result("invalid");

  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8")) as unknown;
  } catch {
    return result("invalid");
  }
  if (!isManifest(manifest)) return result("invalid");

  const executableRelativePath = "ndlocr-lite/ndlocr-lite.exe";
  const executableRecord = manifest.files.find((file) => file.path === executableRelativePath);
  if (!executableRecord || executableRecord.sha256.toLowerCase() !== contractRaw.executableSha256.toLowerCase()) {
    return result("invalid");
  }

  let executableBytes: Buffer;
  try {
    const executableRealPath = await fs.realpath(executablePath);
    if (!isContained(resourcesRealPath, executableRealPath)) return result("invalid");
    executableBytes = await fs.readFile(executableRealPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return result("invalid");
    return result("invalid");
  }
  if (executableBytes.length !== executableRecord.size || sha256(executableBytes).toLowerCase() !== executableRecord.sha256.toLowerCase()) {
    return result("invalid");
  }

  const configuration: ManagedNdlocrConfiguration = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    managedBy: MANAGED_BY,
    engine: ENGINE,
    version: VERSION,
    commit: SOURCE_COMMIT,
    distributionSha256: manifestHash,
    manifestPath: path.resolve(manifestPath),
    executableSha256: contractRaw.executableSha256.toLowerCase(),
    command: [
      path.resolve(executablePath),
      "--sourceimg",
      "{input}",
      "--output",
      "{outputDir}",
      "--json-only",
      "--device",
      "cpu",
    ],
  };

  try {
    // Recheck immediately before replacing in case another process changed the
    // file while packaged runtime integrity was being verified.
    const latestConfig = await inspectExistingConfiguration(absoluteConfigPath);
    if (latestConfig.status === "unmanaged") return result("conflict");
    if (priorConfig.status === "missing" && latestConfig.status !== "missing") return result("conflict");

    let backupPath: string | undefined;
    if (priorConfig.status === "legacy") {
      if (latestConfig.status !== "legacy" || !latestConfig.bytes.equals(priorConfig.bytes)) return result("conflict");
      backupPath = await createLegacyConfigurationBackup(absoluteConfigPath, priorConfig.bytes);
      const afterBackup = await inspectExistingConfiguration(absoluteConfigPath);
      if (afterBackup.status !== "legacy" || !afterBackup.bytes.equals(priorConfig.bytes)) return result("conflict");
    }

    const verifyLegacyUnchanged = priorConfig.status === "legacy"
      ? async () => {
        const immediatelyBeforeReplace = await inspectExistingConfiguration(absoluteConfigPath);
        if (immediatelyBeforeReplace.status !== "legacy" || !immediatelyBeforeReplace.bytes.equals(priorConfig.bytes)) {
          throw new Error("Legacy OCR configuration changed before migration could commit.");
        }
      }
      : undefined;
    await writeConfigAtomically(absoluteConfigPath, configuration, latestConfig.status !== "missing", verifyLegacyUnchanged);
    if (backupPath) return { status: "migrated", message: MESSAGES.migrated, backupPath };
  } catch {
    return result("conflict");
  }
  return result("configured");
}
