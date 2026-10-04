import type { MarkdownTableCellTarget, MarkdownTableTarget } from "./markdown-table-commands";

/** Ephemeral identity for a table projection rendered from one document revision. */
export interface ActiveTableTarget {
  readonly documentId: string;
  readonly revision: number;
  readonly table: MarkdownTableTarget;
  readonly cell: MarkdownTableCellTarget;
}

export interface TableTargetDocument {
  readonly documentId: string;
  readonly revision: number;
}

export function ownsCurrentTableTarget(target: ActiveTableTarget | null, document: TableTargetDocument | null): boolean {
  return target !== null
    && document !== null
    && target.documentId === document.documentId
    && target.revision === document.revision;
}

/** A disposed/re-rendered table DOM may dispatch no command against a newer projection. */
export function mayDispatchTableTarget(
  active: ActiveTableTarget | null,
  document: TableTargetDocument | null,
  table: MarkdownTableTarget,
  cell: MarkdownTableCellTarget
): boolean {
  if (active === null || !ownsCurrentTableTarget(active, document)) return false;
  return active.table === table && active.cell === cell;
}
