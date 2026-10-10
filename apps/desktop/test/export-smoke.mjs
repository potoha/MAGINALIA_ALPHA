import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { assertElectronSmokeMarker, runElectronSmoke } from "./electron-smoke-launcher.mjs";

const marker = "MAGINALIA_ELECTRON_EXPORT_SMOKE_OK";
const annotationId = "e5c6d7a8-9012-4b3c-8d7e-6f5a4b3c2d1e";
const dirtyChildAnnotationId = "f6d7e8a9-0123-4c5d-9e8f-7a6b5c4d3e2f";
const isbn13 = "9780000000002";
const quote = "これはExport smokeの解決済み引用です。";
const dirtyChildQuote = "これはExport smokeの未保存子引用です。";
const title = "Export Smoke Book";
const author = "Export Smoke Author";
const captureId = "capture-export-smoke";
const canonicalAnnotationId = "ann:01ARZ3NDEKTSV4RRFFQ69G5FAV";
const dirtyChildCanonicalAnnotationId = "ann:01ARZ3NDEKTSV4RRFFQ69G5FB0";
const quoteMarker = `<!-- maginalia:quote-ref v1 {"quoteId":"${annotationId}","mode":"normal"} -->`;
const referenceStart = "<!-- maginalia:reference-list-start v1 -->";
const referenceEnd = "<!-- maginalia:reference-list-end v1 -->";
const syncedChildMarker = "<!-- maginalia:synced-block v1 {\"target\":\"child.md\"} -->";
const syncedNestedMarker = "<!-- maginalia:synced-block v1 {\"target\":\"nested.md\"} -->";
const initialA = `\uFEFF# Export A\r\n\r\n日本語の本文です。全角記号（「」）と Latin text を混在させます。\r\n\r\nこれは通常の文章です。[参考リンク](https://example.com) を参照します。\r\n\r\n本文 [YouTube](https://youtu.be/dQw4w9WgXcQ) を参照します。\r\n\r\n## 第二章\r\n\r\n### 第三級\r\n\r\n#### 第四級\r\n\r\n##### 第五級\r\n\r\n###### 第六級\r\n\r\n- リスト項目\r\n\r\n> 引用ブロックです。\r\n\r\n${quoteMarker}\r\n\r\n${syncedChildMarker}\r\n\r\n[[b.md|Second document]] [[missing.md]]\r\n[Generic](https://example.com/article) [YouTube](https://youtu.be/dQw4w9WgXcQ) [X](https://x.com/example/status/123456)\r\n![Figure](assets/figure.png) ![[assets/図版 資料.png]] ![[assets/movie.mp4]]\r\n![[assets/missing.png]]\r\n\r\n| 列一 | 列二 | 列三 | 列四 | 列五 | 列六 | 列七 | 列八 |\r\n| --- | --- | --- | --- | --- | --- | --- | --- |\r\n| 日本語 | Latin | 全角！ | 研究 | 表 | 横幅 | 確認 | 完了 |\r\n\r\n<script>window.MAGINALIA_F_SMOKE_XSS = true</script>\r\n\r\n## 参考文献\r\n\r\n${referenceStart}\r\n- old generated entry\r\n${referenceEnd}\r\n\r\n手書きの参考メモです。\r\n`;
const wideTableCell = "研究資料 Latin 全角！ ".repeat(32);
const smokeInitialA = initialA.replace(
  "| 日本語 | Latin | 全角！ | 研究 | 表 | 横幅 | 確認 | 完了 |",
  `| 日本語 | Latin | 全角！ | ![[assets/図版 資料.png]] | 表 | 横幅 | 確認 | ${wideTableCell} |`
);
const initialB = [
  "\uFEFF# Export B",
  "",
  "B-only document.",
  "",
  "PNG image: ![PNG figure](assets/figure.png)",
  "",
  "JPEG image: ![[assets/写真 資料.jpg]]",
  "",
  "WebP image: ![[assets/図版 WebP.webp]]",
  ""
].join("\r\n");
const initialChild = `---\r\ntitle: Child local title\r\n---\r\n# Child local title\r\nSynced child prose\r\n\r\n${quoteMarker}\r\n\r\n${syncedNestedMarker}\r\n\r\n## 参考文献\r\n\r\n${referenceStart}\r\n- stale child reference\r\n${referenceEnd}\r\n`;
const initialNested = `# Nested local title\r\nNested synced prose\r\n\r\n${quoteMarker}\r\n`;

function startReviewerFixture() {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not-found" }));
      return;
    }

    // The managed Reviewer bridge verifies these fields even for the explicit
    // loopback fixture used by this deterministic export regression test.
    if (requestUrl.pathname === "/api/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({
        status: "ok",
        service: "maginalia-reviewer",
        contractVersion: 1
      }));
      return;
    }

    if (requestUrl.pathname === `/api/books/${isbn13}/publication`) {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        updatedAtMs: 1700000000000,
        book: {
          isbn13,
          title,
          authors: [author],
          publisher: "Export Smoke Publisher",
          publishedDate: "2024"
        },
        highlights: []
      }));
      return;
    }

    if (requestUrl.pathname !== "/api/search"
      || requestUrl.searchParams.get("q") !== ""
      || requestUrl.searchParams.get("status") !== "APPROVED"
      || requestUrl.searchParams.get("limit") !== "100"
      || requestUrl.searchParams.get("offset") !== "0") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unexpected-search" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({
      results: [{
        annotationId,
        captureId,
        pageId: "page-export-smoke",
        sourcePageId: "source-page-internal",
        isbn13,
        title,
        authors: [author],
        quote,
        pageLabel: "42",
        comment: "internal comment must not export",
        reviewState: "APPROVED",
        reviewedAtMs: 1700000000000
      }],
      total: 1,
      limit: 100,
      offset: 0
    }));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Reviewer fixture did not expose a TCP address."));
        return;
      }
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

let temporaryDirectory;
let reviewerFixture;
try {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "maginalia-export-smoke-"));
  const projectRoot = path.join(temporaryDirectory, "project-root");
  const shelfRoot = path.join(projectRoot, "private-shelf");
  const userDataRoot = path.join(temporaryDirectory, "electron-user-data");
  await mkdir(projectRoot);
  await mkdir(path.join(projectRoot, "assets"));
  await mkdir(path.join(shelfRoot, "books"), { recursive: true });
  await mkdir(path.join(shelfRoot, "annotations"), { recursive: true });
  await writeFile(path.join(shelfRoot, "library.json"), JSON.stringify({
    type: "library",
    version: "0.1",
    name: "Export Smoke Shelf",
    booksPath: "books",
    annotationsPath: "annotations"
  }), "utf8");
  await writeFile(path.join(shelfRoot, "books", "export-smoke-book.json"), JSON.stringify({
    type: "book",
    version: "0.1",
    id: `isbn:${isbn13}`,
    isbn13,
    title,
    authors: [author],
    publisher: "Export Smoke Publisher",
    year: 2024
  }), "utf8");
  await writeFile(path.join(shelfRoot, "annotations", "export-smoke-annotation.json"), JSON.stringify({
    type: "annotation",
    version: "0.1",
    id: canonicalAnnotationId,
    source: `isbn:${isbn13}`,
    location: { page: 42 },
    quote,
    deviceMetadata: {
      maginaliaReviewer: {
        version: 1,
        annotationId,
        digest: "export-smoke-canonical-alias"
      }
    }
  }), "utf8");
  await writeFile(path.join(shelfRoot, "annotations", "export-smoke-dirty-child-annotation.json"), JSON.stringify({
    type: "annotation",
    version: "0.1",
    id: dirtyChildCanonicalAnnotationId,
    source: `isbn:${isbn13}`,
    location: { page: 43 },
    quote: dirtyChildQuote,
    deviceMetadata: {
      maginaliaReviewer: {
        version: 1,
        annotationId: dirtyChildAnnotationId,
        digest: "export-smoke-dirty-child-canonical-alias"
      }
    }
  }), "utf8");
  await mkdir(userDataRoot, { recursive: true });
  await writeFile(path.join(userDataRoot, "shelf_location.yml"), [
    "version: 1",
    "",
    "private_shelf:",
    `  registry: ${JSON.stringify(shelfRoot)}`,
    "  urls:",
    "    github: null",
    "    homepage: null",
    "    other: []",
    "",
    "public_shelf:",
    "  registry: null",
    "  urls:",
    "    github: null",
    "    homepage: null",
    "    other: []",
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(projectRoot, "a.md"), Buffer.from(smokeInitialA, "utf8"));
  await writeFile(path.join(projectRoot, "b.md"), Buffer.from(initialB, "utf8"));
  await writeFile(path.join(projectRoot, "child.md"), Buffer.from(initialChild, "utf8"));
  await writeFile(path.join(projectRoot, "nested.md"), Buffer.from(initialNested, "utf8"));
  // Real image bytes exercise Chromium's PDF embedding and Pandoc's DOCX media
  // materialization, including Japanese and spaced Project asset names.
  await sharp({
    create: { width: 800, height: 360, channels: 4, background: { r: 217, g: 226, b: 79, alpha: 1 } }
  }).png().toFile(path.join(projectRoot, "assets", "figure.png"));
  await sharp({
    create: { width: 420, height: 600, channels: 3, background: { r: 198, g: 155, b: 134 } }
  }).jpeg().toFile(path.join(projectRoot, "assets", "写真 資料.jpg"));
  await sharp({
    create: { width: 640, height: 400, channels: 4, background: { r: 82, g: 140, b: 117, alpha: 1 } }
  }).webp().toFile(path.join(projectRoot, "assets", "図版 WebP.webp"));
  await sharp({
    create: { width: 1600, height: 320, channels: 3, background: { r: 198, g: 155, b: 134 } }
  }).png().toFile(path.join(projectRoot, "assets", "図版 資料.png"));
  await writeFile(path.join(projectRoot, "assets", "movie.mp4"), Buffer.from([0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));

  reviewerFixture = await startReviewerFixture();
  const result = await runElectronSmoke({
    userDataRoot,
    appArgs: ["--smoke-export", projectRoot],
    env: { MAGINALIA_REVIEWER_BASE_URL: reviewerFixture.baseUrl },
    timeoutMs: 180_000
  });
  assertElectronSmokeMarker(result, marker, "Electron Export smoke");

  const authoringA = await readFile(path.join(projectRoot, "a.md"), "utf8");
  const authoringB = await readFile(path.join(projectRoot, "b.md"));
  const authoringChild = await readFile(path.join(projectRoot, "child.md"));
  const authoringNested = await readFile(path.join(projectRoot, "nested.md"));
  // The export projection itself never mutates authoring text. The process
  // exits through the normal before-quit autosave handshake, so the dirty
  // active-session edit is expected to reach the ordinary source file before
  // the Electron process exits.
  if (!authoringA.startsWith(smokeInitialA) || !authoringA.includes("Unsaved export-only edit.")) {
    throw new Error("Export smoke did not retain the autosaved authoring A text.");
  }
  if (!authoringB.equals(Buffer.from(initialB, "utf8"))) {
    throw new Error("Export smoke changed authoring B bytes.");
  }
  if (!authoringChild.toString("utf8").startsWith(initialChild) || !authoringNested.equals(Buffer.from(initialNested, "utf8"))) {
    throw new Error("Export smoke changed a Synced Block source file.");
  }

  const outputA = await readFile(path.join(projectRoot, "export-1.resolved.md"), "utf8");
  if (!outputA.includes(`> ${quote}`)
    || !outputA.includes(`（${author}『${title}』、p.42）`)
    || !outputA.includes(`- ${author}『${title}』 Export Smoke Publisher、2024。`)
    || !outputA.includes("Unsaved export-only edit.")
    || !outputA.includes("Synced child prose")
    || !outputA.includes("Nested synced prose")
    || outputA.includes("stale child reference")
    || outputA.includes(quoteMarker)
    || outputA.includes("maginalia:synced-block")
    || outputA.includes(referenceStart)
    || outputA.includes(referenceEnd)
    || outputA.includes(annotationId)
    || outputA.includes(captureId)
    || outputA.includes("page-export-smoke")
    || outputA.includes("source-page-internal")
    || outputA.includes("book:isbn13:")
    || outputA.includes("[[b.md")) {
    throw new Error("Export smoke output A was not a safe ordinary Markdown projection.");
  }

  const outputB = await readFile(path.join(projectRoot, "export-2.resolved.md"), "utf8");
  if (!outputB.includes("B-only document.")
    || outputB.includes(quote)
    || outputB.includes(title)
    || outputB.includes("Unsaved export-only edit.")
    || outputB.includes(quoteMarker)) {
    throw new Error("Export smoke exported inactive document content into output B.");
  }

  process.stdout.write(result.stdout + result.stderr);
  process.stdout.write(`${marker}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (reviewerFixture) await closeServer(reviewerFixture.server);
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
}
