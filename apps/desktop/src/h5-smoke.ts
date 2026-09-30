import * as fs from "node:fs";
import * as path from "node:path";
import { createReviewerSearchAdapter } from "./reviewer-ipc";
import { EXPECTED_CONTRACT_VERSION, EXPECTED_REVIEWER_SERVICE, type ReviewerProcessManager } from "./reviewer-process-manager";
import { type ReviewerViewController } from "./reviewer-view-controller";

export const H5_SMOKE_MARKER = "MAGINALIA_ELECTRON_H5_SMOKE_OK";
const H5_SMOKE_CAPTURE_ID = "h5-smoke-capture";
const H5_SMOKE_QUOTE = "H.5 managed Reviewer approval reaches Shelf";

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function writeUint16(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  for (let index = 0; index < 4; index += 1) target[offset + index] = (value >>> (index * 8)) & 0xff;
}

/** Create a deliberately tiny, stored ZIP for the preserved .magicap importer. */
function createStoredZip(entries: readonly { readonly name: string; readonly body: Uint8Array }[]): Uint8Array {
  const encoder = new TextEncoder();
  const records = entries.map((entry) => ({ ...entry, nameBytes: encoder.encode(entry.name), checksum: crc32(entry.body) }));
  const localSize = records.reduce((total, entry) => total + 30 + entry.nameBytes.length + entry.body.length, 0);
  const centralSize = records.reduce((total, entry) => total + 46 + entry.nameBytes.length, 0);
  const archive = new Uint8Array(localSize + centralSize + 22);
  let offset = 0;
  const offsets: number[] = [];
  for (const entry of records) {
    offsets.push(offset);
    writeUint32(archive, offset, 0x04034b50); writeUint16(archive, offset + 4, 20);
    writeUint32(archive, offset + 14, entry.checksum); writeUint32(archive, offset + 18, entry.body.length);
    writeUint32(archive, offset + 22, entry.body.length); writeUint16(archive, offset + 26, entry.nameBytes.length);
    archive.set(entry.nameBytes, offset + 30); archive.set(entry.body, offset + 30 + entry.nameBytes.length);
    offset += 30 + entry.nameBytes.length + entry.body.length;
  }
  const centralOffset = offset;
  records.forEach((entry, index) => {
    writeUint32(archive, offset, 0x02014b50); writeUint16(archive, offset + 4, 20); writeUint16(archive, offset + 6, 20);
    writeUint32(archive, offset + 16, entry.checksum); writeUint32(archive, offset + 20, entry.body.length);
    writeUint32(archive, offset + 24, entry.body.length); writeUint16(archive, offset + 28, entry.nameBytes.length);
    writeUint32(archive, offset + 42, offsets[index]); archive.set(entry.nameBytes, offset + 46);
    offset += 46 + entry.nameBytes.length;
  });
  writeUint32(archive, offset, 0x06054b50); writeUint16(archive, offset + 8, records.length); writeUint16(archive, offset + 10, records.length);
  writeUint32(archive, offset + 12, centralSize); writeUint32(archive, offset + 16, centralOffset);
  return archive;
}

function createMagicapFixture(): Uint8Array {
  const encoder = new TextEncoder();
  const pageId = "h5-smoke-page";
  const manifest = {
    format: "maginalia-capture-package",
    version: 1,
    packageId: "capkg:01ARZ3NDEKTSV4RRFFQ69G5FAV",
    createdAt: "2026-09-30T00:00:00.000Z",
    book: { isbn13: "9780306406157" },
    captureCount: 1
  };
  const capture = {
    id: H5_SMOKE_CAPTURE_ID,
    ocrStatus: "pending",
    bookId: "h5-smoke-book",
    pageImage: { id: pageId, path: `images/${pageId}.jpg`, mediaType: "image/jpeg", width: 1, height: 1 },
    selectedRegion: { left: 0, top: 0, right: 1, bottom: 1 },
    pageNumber: 42,
    comment: "H.5 smoke",
    createdAt: "2026-09-30T00:00:00.000Z"
  };
  // A valid one-pixel JPEG. The preserved importer verifies image bytes,
  // declared media type, and dimensions before accepting the archive.
  const image = Uint8Array.from(Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnKkpKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==", "base64"));
  return createStoredZip([
    { name: "manifest.json", body: encoder.encode(JSON.stringify(manifest)) },
    { name: `captures/${H5_SMOKE_CAPTURE_ID}.json`, body: encoder.encode(JSON.stringify(capture)) },
    { name: `images/${pageId}.jpg`, body: image }
  ]);
}

async function approveAndFindThroughShelf(baseUrl: URL): Promise<void> {
  const session = await fetch(new URL("api/session", baseUrl), { method: "GET", redirect: "error" });
  if (!session.ok) throw new Error(`Reviewer session returned ${session.status}.`);
  const sessionPayload = await session.json() as { csrfToken?: unknown };
  if (typeof sessionPayload.csrfToken !== "string" || sessionPayload.csrfToken.length === 0) {
    throw new Error("Reviewer did not issue a CSRF session token.");
  }
  const csrfToken = sessionPayload.csrfToken;
  const mutationHeaders = { "X-CSRF-Token": csrfToken, Cookie: `marginalia_csrf=${csrfToken}` };
  const form = new FormData();
  form.append("bundle", new Blob([createMagicapFixture()], { type: "application/zip" }), "h5-smoke.magicap");
  const imported = await fetch(new URL("api/import", baseUrl), { method: "POST", headers: mutationHeaders, body: form, redirect: "error" });
  if (imported.status !== 201) {
    const detail = (await imported.text()).slice(0, 500);
    throw new Error(`Reviewer .magicap import returned ${imported.status}: ${detail}`);
  }

  const pages = await fetch(new URL("api/pages", baseUrl), { method: "GET", redirect: "error" });
  if (!pages.ok) throw new Error(`Reviewer pages returned ${pages.status}.`);
  const pageList = await pages.json() as readonly { readonly id?: unknown }[];
  const pageId = pageList.find((page) => typeof page.id === "string")?.id;
  if (typeof pageId !== "string") throw new Error("Reviewer did not expose the imported page.");
  const detailResponse = await fetch(new URL(`api/pages/${encodeURIComponent(pageId)}`, baseUrl), { method: "GET", redirect: "error" });
  if (!detailResponse.ok) throw new Error(`Reviewer page detail returned ${detailResponse.status}.`);
  const detail = await detailResponse.json() as { annotations?: readonly { readonly id?: unknown }[] };
  const annotationId = detail.annotations?.find((annotation) => typeof annotation.id === "string")?.id;
  if (typeof annotationId !== "string") throw new Error("Reviewer did not expose the imported annotation.");

  const review = await fetch(new URL(`api/annotations/${encodeURIComponent(annotationId)}`, baseUrl), {
    method: "PUT", headers: { ...mutationHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ quote: H5_SMOKE_QUOTE, pageLabel: "42", comment: "H.5 approved" }), redirect: "error"
  });
  if (!review.ok) throw new Error(`Reviewer review update returned ${review.status}.`);
  const approved = await fetch(new URL(`api/captures/${encodeURIComponent(annotationId)}/approve`, baseUrl), {
    method: "POST", headers: mutationHeaders, redirect: "error"
  });
  if (!approved.ok) throw new Error(`Reviewer approval returned ${approved.status}.`);

  // Use the actual Desktop Shelf boundary, not a direct database or a second
  // state store. The same manager-owned origin must immediately surface the
  // just-approved opaque annotation identity without restarting Electron.
  const search = createReviewerSearchAdapter({ getBaseUrl: async () => baseUrl });
  const result = await search(H5_SMOKE_QUOTE);
  if (result.kind !== "results" || !result.results.some((quote) => quote.annotationId === annotationId)) {
    throw new Error("Approved quotation was not visible through the Desktop Shelf adapter.");
  }
}

/**
 * Real Electron main-process proof for the bounded Reviewer service view.
 * The smoke deliberately uses the same manager and controller as Shelf Review:
 * it neither starts Python itself nor supplies a Reviewer origin from renderer
 * input.  Normal application shutdown exercises the manager's graceful
 * process cleanup after this returns.
 */
export async function runH5Smoke(options: {
  readonly reviewer: ReviewerProcessManager;
  readonly reviewerView: ReviewerViewController;
  readonly userDataPath: string;
}): Promise<void> {
  const opened = await options.reviewerView.open();
  if (opened.kind !== "opened") {
    const detail = opened.kind === "unavailable" ? opened.message : opened.kind;
    throw new Error(`Reviewer View did not open: ${detail}`);
  }
  if (!options.reviewerView.hasOpenView()) {
    throw new Error("Reviewer View did not attach to the central Workbench surface.");
  }

  const status = options.reviewer.getStatus();
  if (status.status !== "ready" || status.baseUrl === null || status.port === null) {
    throw new Error(`Reviewer was not ready after opening Shelf Review: ${status.status}.`);
  }
  const baseUrl = new URL(status.baseUrl);
  if (baseUrl.protocol !== "http:" || baseUrl.hostname !== "127.0.0.1") {
    throw new Error("Reviewer smoke accepted a non-managed loopback endpoint.");
  }
  const health = await fetch(new URL("api/health", baseUrl), { method: "GET", redirect: "error" });
  if (!health.ok) throw new Error(`Reviewer health returned ${health.status}.`);
  const payload: unknown = await health.json();
  if (payload === null || typeof payload !== "object"
    || (payload as Record<string, unknown>).service !== EXPECTED_REVIEWER_SERVICE
    || (payload as Record<string, unknown>).contractVersion !== EXPECTED_CONTRACT_VERSION) {
    throw new Error("Reviewer health identity or contract version was not accepted.");
  }

  const workspace = path.join(options.userDataPath, "reviewer");
  if (!fs.existsSync(workspace) || !fs.existsSync(path.join(workspace, "reviewer.sqlite3"))) {
    throw new Error("Reviewer did not use the application-owned persistent workspace.");
  }

  await approveAndFindThroughShelf(baseUrl);

  // Return to the Workbench before normal app shutdown. This proves the
  // central service surface is detachable and has no DocumentSession owner.
  if (options.reviewerView.close().kind !== "closed") {
    throw new Error("Reviewer View did not close cleanly.");
  }
  // Exercise the exact production manager shutdown boundary while the managed
  // sidecar is still healthy. This proves the authenticated cooperative route
  // was acknowledged; the smoke harness then independently confirms the port
  // is closed after the Desktop process exits.
  await options.reviewer.shutdown();
  if (!options.reviewer.wasLastShutdownCooperative()) {
    throw new Error("Reviewer did not acknowledge cooperative shutdown.");
  }
  console.log(`${H5_SMOKE_MARKER} port=${status.port} cooperativeShutdown=1`);
}
