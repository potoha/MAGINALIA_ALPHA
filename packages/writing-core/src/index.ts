/**
 * The document id is opaque to Writing Core. It is only compared for identity;
 * it is not interpreted as a filesystem path or any other host identifier.
 */
export type DocumentId = string;

export interface OpenDocument {
  readonly documentId: DocumentId;
  readonly displayName: string;
  readonly text: string;
}

export interface DocumentState {
  readonly documentId: DocumentId;
  readonly displayName: string;
  readonly currentText: string;
  /** The text from the most recent save confirmation. */
  readonly savedText: string;
}

export interface SaveSnapshot {
  readonly documentId: DocumentId;
  readonly text: string;
}

export function openDocument(document: OpenDocument): DocumentState {
  return {
    documentId: document.documentId,
    displayName: document.displayName,
    currentText: document.text,
    savedText: document.text
  };
}

export function editDocument(state: DocumentState, text: string): DocumentState {
  return {
    ...state,
    currentText: text
  };
}

export function createSaveSnapshot(state: DocumentState): SaveSnapshot {
  return {
    documentId: state.documentId,
    text: state.currentText
  };
}

export function confirmSave(state: DocumentState, snapshot: SaveSnapshot): DocumentState {
  if (snapshot.documentId !== state.documentId) {
    return state;
  }

  return {
    ...state,
    savedText: snapshot.text
  };
}

export function isDirty(state: DocumentState): boolean {
  return state.currentText !== state.savedText;
}
