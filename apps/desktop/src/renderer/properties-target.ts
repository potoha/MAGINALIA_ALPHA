/** Ephemeral Properties form ownership follows the active source document revision. */
export interface PropertiesTarget {
  readonly documentId: string;
  readonly revision: number;
}

export interface PropertiesTargetDocument {
  readonly documentId: string;
  readonly revision: number;
}

export function ownsCurrentPropertiesTarget(
  target: PropertiesTarget | null,
  document: PropertiesTargetDocument | null,
): boolean {
  return target !== null
    && document !== null
    && target.documentId === document.documentId
    && target.revision === document.revision;
}

/**
 * A dirty form is ephemeral user input. Preserve it when its source ownership
 * changes; callers must mark it stale instead of rebinding it to new source.
 */
export function shouldPreserveUnappliedPropertiesForm(
  target: PropertiesTarget | null,
  document: PropertiesTargetDocument | null,
  dirty: boolean,
  stale: boolean,
): boolean {
  return dirty && target !== null && (stale || !ownsCurrentPropertiesTarget(target, document));
}
