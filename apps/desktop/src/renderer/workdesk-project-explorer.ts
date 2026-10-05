import type { WorkdeskProjectNode } from "../workdesk-ipc";

export interface WorkdeskExplorerRoot {
  readonly workdesk: { readonly documentId: string };
  readonly projects: readonly WorkdeskProjectNode[];
}

export interface WorkdeskProjectExplorerShortcut extends WorkdeskProjectNode {
  readonly kind: "project-shortcut";
}

/** Registered Projects are virtual root children only while the Workdesk's loose-file Explorer is active. */
export function workdeskProjectShortcutsForRoot(
  workdesk: WorkdeskExplorerRoot | null,
  activeDocumentId: string | null
): readonly WorkdeskProjectExplorerShortcut[] {
  return workdesk !== null && workdesk.workdesk.documentId === activeDocumentId
    ? workdesk.projects.map((project) => ({ ...project, kind: "project-shortcut" as const }))
    : [];
}
