export const WRITING_SMOKE_FLAG = "--smoke-writing";
export const WORKSPACE_SMOKE_FLAG = "--smoke-workspace";
export const QUOTATION_SMOKE_FLAG = "--smoke-quotation";
export const REPOSITORY_SMOKE_FLAG = "--smoke-repository";
export const PROJECT_SMOKE_FLAG = "--smoke-project";
export const PROJECT_RESTORE_SMOKE_FLAG = "--smoke-project-restore";
export const PROJECT_CREATE_SMOKE_FLAG = "--smoke-project-create";
export const SHELF_SMOKE_FLAG = "--smoke-shelf";
export const D5_SMOKE_FLAG = "--smoke-d5";
export const D5_RESTORE_SMOKE_FLAG = "--smoke-d5-restore";
export const EXPORT_SMOKE_FLAG = "--smoke-export";
export const G_SMOKE_FLAG = "--smoke-g";

export interface WritingSmokeMode {
  readonly requested: boolean;
  readonly filePath?: string;
}

export interface WorkspaceSmokeMode {
  readonly requested: boolean;
  readonly rootPath?: string;
}

export interface QuotationSmokeMode {
  readonly requested: boolean;
  readonly documentRoot?: string;
  readonly libraryRoot?: string;
}

export interface RepositorySmokeMode {
  readonly requested: boolean;
  readonly rootPath?: string;
}

export interface ProjectSmokeMode {
  readonly requested: boolean;
  readonly rootPath?: string;
  readonly restore?: boolean;
  readonly create?: boolean;
}

export interface ShelfSmokeMode {
  readonly requested: boolean;
  readonly rootPath?: string;
}

export interface D5SmokeMode {
  readonly requested: boolean;
  readonly rootPath?: string;
  readonly restore?: boolean;
}

export interface ExportSmokeMode {
  readonly requested: boolean;
  readonly rootPath?: string;
}

export interface GSmokeMode {
  readonly requested: boolean;
  readonly rootPath?: string;
}

export function parseWritingSmokeMode(args: readonly string[]): WritingSmokeMode {
  const flagIndex = args.indexOf(WRITING_SMOKE_FLAG);
  if (flagIndex < 0) return { requested: false };

  const candidate = args[flagIndex + 1];
  if (!candidate || candidate.startsWith("--")) return { requested: true };
  return { requested: true, filePath: candidate };
}

export function parseWorkspaceSmokeMode(args: readonly string[]): WorkspaceSmokeMode {
  const flagIndex = args.indexOf(WORKSPACE_SMOKE_FLAG);
  if (flagIndex < 0) return { requested: false };

  const candidate = args[flagIndex + 1];
  if (!candidate || candidate.startsWith("--")) return { requested: true };
  return { requested: true, rootPath: candidate };
}

export function parseQuotationSmokeMode(args: readonly string[]): QuotationSmokeMode {
  const flagIndex = args.indexOf(QUOTATION_SMOKE_FLAG);
  if (flagIndex < 0) return { requested: false };

  const documentRoot = args[flagIndex + 1];
  const libraryRoot = args[flagIndex + 2];
  if (!documentRoot || documentRoot.startsWith("--")) return { requested: true };
  if (!libraryRoot || libraryRoot.startsWith("--")) {
    return { requested: true, documentRoot };
  }
  return { requested: true, documentRoot, libraryRoot };
}

export function parseRepositorySmokeMode(args: readonly string[]): RepositorySmokeMode {
  const flagIndex = args.indexOf(REPOSITORY_SMOKE_FLAG);
  if (flagIndex < 0) return { requested: false };

  const candidate = args[flagIndex + 1];
  if (!candidate || candidate.startsWith("--")) return { requested: true };
  return { requested: true, rootPath: candidate };
}

export function parseProjectSmokeMode(args: readonly string[]): ProjectSmokeMode {
  const restoreIndex = args.indexOf(PROJECT_RESTORE_SMOKE_FLAG);
  if (restoreIndex >= 0) {
    const candidate = args[restoreIndex + 1];
    if (!candidate || candidate.startsWith("--")) return { requested: true, restore: true };
    return { requested: true, restore: true, rootPath: candidate };
  }
  const createIndex = args.indexOf(PROJECT_CREATE_SMOKE_FLAG);
  if (createIndex >= 0) {
    const candidate = args[createIndex + 1];
    if (!candidate || candidate.startsWith("--")) return { requested: true, create: true };
    return { requested: true, create: true, rootPath: candidate };
  }
  const flagIndex = args.indexOf(PROJECT_SMOKE_FLAG);
  if (flagIndex < 0) return { requested: false };
  const candidate = args[flagIndex + 1];
  if (!candidate || candidate.startsWith("--")) return { requested: true };
  return { requested: true, rootPath: candidate };
}

export function parseShelfSmokeMode(args: readonly string[]): ShelfSmokeMode {
  const flagIndex = args.indexOf(SHELF_SMOKE_FLAG);
  if (flagIndex < 0) return { requested: false };

  const candidate = args[flagIndex + 1];
  if (!candidate || candidate.startsWith("--")) return { requested: true };
  return { requested: true, rootPath: candidate };
}

export function parseD5SmokeMode(args: readonly string[]): D5SmokeMode {
  const restoreIndex = args.indexOf(D5_RESTORE_SMOKE_FLAG);
  if (restoreIndex >= 0) {
    const candidate = args[restoreIndex + 1];
    if (!candidate || candidate.startsWith("--")) return { requested: true, restore: true };
    return { requested: true, restore: true, rootPath: candidate };
  }
  const flagIndex = args.indexOf(D5_SMOKE_FLAG);
  if (flagIndex < 0) return { requested: false };
  const candidate = args[flagIndex + 1];
  if (!candidate || candidate.startsWith("--")) return { requested: true };
  return { requested: true, rootPath: candidate };
}

export function parseExportSmokeMode(args: readonly string[]): ExportSmokeMode {
  const flagIndex = args.indexOf(EXPORT_SMOKE_FLAG);
  if (flagIndex < 0) return { requested: false };

  const candidate = args[flagIndex + 1];
  if (!candidate || candidate.startsWith("--")) return { requested: true };
  return { requested: true, rootPath: candidate };
}

export function parseGSmokeMode(args: readonly string[]): GSmokeMode {
  const flagIndex = args.indexOf(G_SMOKE_FLAG);
  if (flagIndex < 0) return { requested: false };
  const candidate = args[flagIndex + 1];
  if (!candidate || candidate.startsWith("--")) return { requested: true };
  return { requested: true, rootPath: candidate };
}
