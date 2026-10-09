import * as path from "node:path";

/** Fixed resource layout emitted by the Windows runtime staging script. */
export interface PackagedRuntimePaths {
  readonly reviewerExecutable: string;
  readonly contractsDirectory: string;
  readonly pandocExecutable: string;
  readonly tutorialRoot: string;
  readonly noticesDirectory: string;
  readonly manualPdfPath: string;
}

export function resolvePackagedRuntimePaths(resourcesPath: string): PackagedRuntimePaths {
  if (!path.isAbsolute(resourcesPath)) throw new Error("Packaged runtime resource root must be absolute.");
  return Object.freeze({
    reviewerExecutable: path.join(resourcesPath, "reviewer", "marginalia-reviewer.exe"),
    contractsDirectory: path.join(resourcesPath, "contracts"),
    pandocExecutable: path.join(resourcesPath, "pandoc", "pandoc.exe"),
    tutorialRoot: path.join(resourcesPath, "tutorial-sample"),
    noticesDirectory: path.join(resourcesPath, "THIRD-PARTY-NOTICES"),
    manualPdfPath: path.join(resourcesPath, "manual", "マニュアル.pdf"),
  });
}
