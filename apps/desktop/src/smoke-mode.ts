export const WRITING_SMOKE_FLAG = "--smoke-writing";
export const WORKSPACE_SMOKE_FLAG = "--smoke-workspace";

export interface WritingSmokeMode {
  readonly requested: boolean;
  readonly filePath?: string;
}

export interface WorkspaceSmokeMode {
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
