import type { ProjectAssetIpcResult } from "../project-assets-ipc";
import { scanLocalMediaTargets, type PreviewMediaMap } from "./markdown-renderer";

export interface ProjectMediaApi {
  resolveProjectAsset(request: { readonly projectId: string; readonly relativePath: string }): Promise<ProjectAssetIpcResult>;
}

/** Renderer-only cache builder: filesystem paths never enter this boundary. */
export async function resolvePreviewMedia(
  api: ProjectMediaApi | null,
  projectId: string | null,
  text: string
): Promise<PreviewMediaMap> {
  const result = new Map();
  const targets = scanLocalMediaTargets(text);
  if (targets.length === 0) return result;
  if (api === null || projectId === null) {
    for (const target of targets) result.set(target, { state: "unresolved", reason: "Open this Project to preview media." });
    return result;
  }
  await Promise.all(targets.map(async (target) => {
    try {
      const asset = await api.resolveProjectAsset({ projectId, relativePath: target });
      if (asset.kind === "resolved") {
        result.set(target, {
          state: "resolved",
          assetKind: asset.assetKind,
          mimeType: asset.mimeType,
          dataUrl: asset.dataUrl
        });
      } else {
        result.set(target, {
          state: "unresolved",
          reason: "message" in asset ? asset.message : "Project media unavailable."
        });
      }
    } catch {
      result.set(target, { state: "unresolved", reason: "Project media unavailable." });
    }
  }));
  return result;
}
