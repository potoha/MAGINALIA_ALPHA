import type { ProjectAssetImportResult, ProjectAssetResult } from "./project-assets";

export const RESOLVE_PROJECT_ASSET_CHANNEL = "maginalia:resolve-project-asset";
export const IMPORT_DROPPED_IMAGE_CHANNEL = "maginalia:import-dropped-image";

export interface ResolveProjectAssetRequest { readonly projectId: string; readonly relativePath: string; }
export interface ImportDroppedImageRequest { readonly projectId: string; readonly sourcePath: string; readonly optimize: boolean; }
export type ProjectAssetIpcResult = ProjectAssetResult | ProjectAssetImportResult | { readonly kind: "error"; readonly code: "invalid-request" | "operation-failed"; readonly message: string };

export interface ProjectAssetDependencies {
  readonly resolve: (owner: object, projectId: string, relativePath: string) => Promise<ProjectAssetResult>;
  readonly importDroppedImage: (owner: object, projectId: string, sourcePath: string, optimize: boolean) => Promise<ProjectAssetImportResult>;
}

const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Reflect.ownKeys(value).length === keys.length && keys.every((key) => Reflect.ownKeys(value).includes(key));
}
function resolveRequest(value: unknown): value is ResolveProjectAssetRequest {
  return record(value, ["projectId", "relativePath"]) && typeof value.projectId === "string" && OPAQUE_ID.test(value.projectId)
    && typeof value.relativePath === "string" && value.relativePath.length <= 1_024;
}
function importRequest(value: unknown): value is ImportDroppedImageRequest {
  return record(value, ["projectId", "sourcePath", "optimize"]) && typeof value.projectId === "string" && OPAQUE_ID.test(value.projectId)
    && typeof value.sourcePath === "string" && value.sourcePath.length <= 32_768 && typeof value.optimize === "boolean";
}

export function createProjectAssetHandlers(dependencies: ProjectAssetDependencies): {
  readonly resolveAsset: (event: { readonly sender: object }, request: unknown, ...args: readonly unknown[]) => Promise<ProjectAssetIpcResult>;
  readonly importDroppedImage: (event: { readonly sender: object }, request: unknown, ...args: readonly unknown[]) => Promise<ProjectAssetIpcResult>;
} {
  const invalid = { kind: "error" as const, code: "invalid-request" as const, message: "The Project asset request is invalid." };
  return {
    async resolveAsset(event, request, ...args) {
      if (args.length !== 0 || !resolveRequest(request)) return invalid;
      try { return await dependencies.resolve(event.sender, request.projectId, request.relativePath); }
      catch { return { kind: "error", code: "operation-failed", message: "The Project asset could not be resolved." }; }
    },
    async importDroppedImage(event, request, ...args) {
      if (args.length !== 0 || !importRequest(request)) return invalid;
      try { return await dependencies.importDroppedImage(event.sender, request.projectId, request.sourcePath, request.optimize); }
      catch { return { kind: "error", code: "operation-failed", message: "The image could not be imported." }; }
    }
  };
}
