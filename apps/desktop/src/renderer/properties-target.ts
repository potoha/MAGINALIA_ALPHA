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
