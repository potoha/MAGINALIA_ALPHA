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
export declare function openDocument(document: OpenDocument): DocumentState;
export declare function editDocument(state: DocumentState, text: string): DocumentState;
export declare function createSaveSnapshot(state: DocumentState): SaveSnapshot;
export declare function confirmSave(state: DocumentState, snapshot: SaveSnapshot): DocumentState;
export declare function isDirty(state: DocumentState): boolean;
//# sourceMappingURL=index.d.ts.map