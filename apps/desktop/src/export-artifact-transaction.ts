import { copyFile, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as path from "node:path";

export interface StagedArtifactFileSystem {
  copyFile(source: string, destination: string, mode?: number): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  rm(target: string, options?: { readonly force?: boolean }): Promise<void>;
  stat(target: string): Promise<{ isFile(): boolean }>;
}

const defaultFileSystem: StagedArtifactFileSystem = { copyFile, rename, rm, stat };

/**
 * Replace a user-selected artifact only after it has been generated and
 * validated. The temporary and backup files live beside the destination so
 * the final rename stays on the destination volume.
 */
export async function commitStagedArtifact(
  stagedArtifactPath: string,
  outputPath: string,
  fileSystem: StagedArtifactFileSystem = defaultFileSystem
): Promise<void> {
  const temporaryPath = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.maginalia-${randomUUID()}.tmp`);
  const backupPath = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.maginalia-${randomUUID()}.bak`);
  let temporaryCreated = false;
  let backupCreated = false;
  let installed = false;
  try {
    await fileSystem.copyFile(stagedArtifactPath, temporaryPath, 0);
    temporaryCreated = true;
    const destination = await fileSystem.stat(outputPath).catch((error: unknown) => {
      if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    if (destination !== null) {
      if (!destination.isFile()) throw new Error("Export destination is not a file.");
      await fileSystem.rename(outputPath, backupPath);
      backupCreated = true;
    }
    try {
      await fileSystem.rename(temporaryPath, outputPath);
      temporaryCreated = false;
      installed = true;
    } catch (error: unknown) {
      if (backupCreated) {
        try {
          await fileSystem.rename(backupPath, outputPath);
          backupCreated = false;
        } catch (rollbackError: unknown) {
          try {
            await fileSystem.copyFile(backupPath, outputPath);
            await fileSystem.rm(backupPath, { force: true });
            backupCreated = false;
          } catch (restoreError: unknown) {
            throw new AggregateError([error, rollbackError, restoreError], "Export replacement failed and the previous artifact could not be restored.");
          }
        }
        throw error;
      }
      throw error;
    }
  } finally {
    if (temporaryCreated) await fileSystem.rm(temporaryPath, { force: true }).catch(() => undefined);
    if (installed && backupCreated) await fileSystem.rm(backupPath, { force: true }).catch(() => undefined);
  }
}
