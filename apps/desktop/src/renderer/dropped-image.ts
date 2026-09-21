import type { ProjectAssetIpcResult } from "../project-assets-ipc";
import type { CapturedInsertionTarget } from "./controller";

export interface DroppedImageWritingPort {
  captureInsertionTarget(): CapturedInsertionTarget | null;
  isInsertionTargetCurrent(target: CapturedInsertionTarget | null): boolean;
  insertMarkdownText(target: CapturedInsertionTarget, text: string): boolean;
}

export type DroppedImageInsertionResult =
  | { readonly kind: "inserted"; readonly relativePath: string }
  | { readonly kind: "error"; readonly message: string };

/**
 * Keeps DnD orchestration out of the DOM event handler.  The main process
 * imports first; only a successful result can enter the existing writing
 * insertion boundary (and therefore Autosave).  A failed import cannot edit
 * source text.
 */
export async function importDroppedImageIntoDocument(options: {
  readonly writing: DroppedImageWritingPort;
  readonly importImage: () => Promise<ProjectAssetIpcResult>;
}): Promise<DroppedImageInsertionResult> {
  const target = options.writing.captureInsertionTarget();
  if (target === null) return { kind: "error", message: "Open a Project document before dropping an image." };
  let result: ProjectAssetIpcResult;
  try {
    result = await options.importImage();
  } catch {
    return { kind: "error", message: "The image could not be imported." };
  }
  if (result.kind !== "imported") {
    return { kind: "error", message: "message" in result ? result.message : "The image could not be imported." };
  }
  if (!options.writing.isInsertionTargetCurrent(target)) {
    return { kind: "error", message: "Image imported, but the document changed before it could be inserted." };
  }
  if (!options.writing.insertMarkdownText(target, `![[${result.relativePath}]]`)) {
    return { kind: "error", message: "The imported image could not be inserted into this document." };
  }
  return { kind: "inserted", relativePath: result.relativePath };
}
