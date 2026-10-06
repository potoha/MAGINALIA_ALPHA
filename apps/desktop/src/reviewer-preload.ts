import { contextBridge, ipcRenderer } from "electron";

// Electron sandboxed preload bundles cannot require local shared chunks. Keep
// this literal aligned with the main-process controller channel contract.
const REVIEWER_APPROVAL_NOTIFICATION_CHANNEL = "maginalia:reviewer-capture-approved";

const REVIEWER_ANNOTATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

contextBridge.exposeInMainWorld("maginaliaReviewer", Object.freeze({
  captureApproved(annotationId: unknown): void {
    if (typeof annotationId !== "string" || !REVIEWER_ANNOTATION_UUID.test(annotationId)) return;
    ipcRenderer.send(REVIEWER_APPROVAL_NOTIFICATION_CHANNEL, annotationId);
  }
}));
