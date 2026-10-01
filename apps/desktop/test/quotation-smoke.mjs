import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertElectronSmokeMarker, runElectronSmoke } from "./electron-smoke-launcher.mjs";

const marker = "MAGINALIA_ELECTRON_QUOTATION_SMOKE_OK";
const initialText = "\uFEFF# こんにちは\r\n\r\nこれは引用を挿入する原稿です。\r\n";
const quote = "これは引用 QUOTATIONTEXTSENTINEL";
const memo = "PRIVATE_MEMO_ONLY_SENTINEL";
const rawOcr = "PRIVATE_RAW_OCR_SENTINEL";
const captureImage = "PRIVATE_CAPTURE_IMAGE_SENTINEL";
const localPath = "PRIVATE_LOCAL_PATH_SENTINEL";
const deviceMetadata = "PRIVATE_DEVICE_METADATA_SENTINEL";
const comment = "PRIVATE_COMMENT_SENTINEL";
const attribution = "PRIVATE_ATTRIBUTION_SENTINEL";
const unpublished = "PRIVATE_UNPUBLISHED_SENTINEL";
const sourceId = "isbn:9781234567890";
const annotationId = "ann:01J0A1B2C3D4E5F6G7H8J9K0M1";
const bookTitle = "Smoke Book Title";
const author = "Smoke Author";
const provenance = "出典: " + bookTitle
  + " / 著者: " + author
  + " / source: " + sourceId
  + " / p. 17 / annotation: " + annotationId;

let temporaryDirectory;
let documentRoot;
let libraryRoot;
try {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "maginalia-quotation-smoke-"));
  documentRoot = path.join(temporaryDirectory, "document-root");
  libraryRoot = path.join(temporaryDirectory, "library-root");
  await mkdir(documentRoot);
  await mkdir(libraryRoot);
  await writeFile(path.join(documentRoot, "manuscript.md"), Buffer.from(initialText, "utf8"));
  await writeFile(
    path.join(documentRoot, "notes.md"),
    Buffer.from("\uFEFF# ノート\r\n\r\n別の原稿です。\r\n", "utf8")
  );

  await mkdir(path.join(libraryRoot, "books"));
  await mkdir(path.join(libraryRoot, "annotations"));
  await writeFile(path.join(libraryRoot, "library.json"), JSON.stringify({
    type: "library",
    version: "0.1",
    name: "Smoke Reference Library",
    booksPath: "books",
    annotationsPath: "annotations"
  }, null, 2));
  await writeFile(path.join(libraryRoot, "books", "smoke-book.json"), JSON.stringify({
    type: "book",
    version: "0.1",
    id: sourceId,
    title: bookTitle,
    authors: [author],
    isbn13: "9781234567890",
    publisher: "Smoke Publisher",
    year: 2026
  }, null, 2));
  await writeFile(path.join(libraryRoot, "annotations", "smoke-annotation.json"), JSON.stringify({
    type: "annotation",
    version: "0.1",
    id: annotationId,
    source: sourceId,
    location: { page: 17 },
    quote,
    privateMemo: memo,
    rawOcr,
    captureImage,
    localPath,
    deviceMetadata: { sentinel: deviceMetadata },
    comment,
    attribution,
    unpublishedComments: [unpublished]
  }, null, 2));

  const result = await runElectronSmoke({
    userDataRoot: path.join(temporaryDirectory, "electron-user-data"),
    appArgs: ["--smoke-quotation", documentRoot, libraryRoot]
  });
  assertElectronSmokeMarker(result, marker, "Electron quotation smoke");

  const actualBytes = await readFile(path.join(documentRoot, "manuscript.md"));
  const actualText = actualBytes.toString("utf8");
  if (!actualText.startsWith(initialText)
    || !actualText.includes(quote)
    || !actualText.includes(provenance)) {
    throw new Error(
      "Saved quotation text did not contain the expected quote and public provenance."
    );
  }
  for (const privateValue of [
    memo,
    rawOcr,
    captureImage,
    localPath,
    deviceMetadata,
    comment,
    attribution,
    unpublished
  ]) {
    if (actualBytes.includes(Buffer.from(privateValue, "utf8"))) {
      throw new Error("Saved quotation contained private evidence.");
    }
  }
  process.stdout.write(result.stdout + result.stderr);
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
} finally {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
}
