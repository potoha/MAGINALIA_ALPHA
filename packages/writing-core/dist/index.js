export function openDocument(document) {
    return {
        documentId: document.documentId,
        displayName: document.displayName,
        currentText: document.text,
        savedText: document.text
    };
}
export function editDocument(state, text) {
    return {
        ...state,
        currentText: text
    };
}
export function createSaveSnapshot(state) {
    return {
        documentId: state.documentId,
        text: state.currentText
    };
}
export function confirmSave(state, snapshot) {
    if (snapshot.documentId !== state.documentId) {
        return state;
    }
    return {
        ...state,
        savedText: snapshot.text
    };
}
export function isDirty(state) {
    return state.currentText !== state.savedText;
}
