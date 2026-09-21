import { parseInternalLinks } from "../project-links";
import type { ResolveInternalLinkResult } from "../project-link-ipc";
import type { PreviewInternalLinkMap } from "./markdown-renderer";

/** The renderer can resolve only authoring targets through this bounded API. */
export interface PreviewProjectLinkApi {
  resolveInternalLink(request: {
    readonly projectId: string;
    readonly target: string;
  }): Promise<ResolveInternalLinkResult>;
}

/**
 * Turn canonical Project wiki links into renderer-only opaque file handles.
 * Resolution failures intentionally remain absent from the map so the preview
 * can render an explicit unresolved state without exposing a filesystem path.
 */
export async function resolvePreviewInternalLinks(
  api: PreviewProjectLinkApi | null,
  projectId: string | null,
  text: string
): Promise<PreviewInternalLinkMap> {
  const targets = [...new Set(parseInternalLinks(text)
    .flatMap((link) => link.kind === "link" ? [link.target] : []))];
  const result = new Map<string, { readonly fileId?: string }>();
  if (api === null || projectId === null) return result;

  await Promise.all(targets.map(async (target) => {
    try {
      const resolved = await api.resolveInternalLink({ projectId, target });
      if (resolved.kind === "resolved") result.set(target, { fileId: resolved.fileId });
    } catch {
      // An unavailable Project resolver leaves just this rendered link unresolved.
    }
  }));
  return result;
}
