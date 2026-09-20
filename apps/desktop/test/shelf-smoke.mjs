import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(desktopRoot, "../..");
const electronExecutable = path.join(
  repositoryRoot,
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32"
    ? "electron.exe"
    : process.platform === "darwin"
      ? "Electron.app/Contents/MacOS/Electron"
      : "electron"
);
const mainPath = path.join(desktopRoot, "dist", "main", "main.js");
const marker = "MAGINALIA_ELECTRON_SHELF_SMOKE_OK";
const annotationId = "2b6c4e0c-7268-4da0-9ad3-f5d1c8b7f2a1";
const sameBookAnnotationId = "8ad9f3d2-2a9a-4f14-a2f6-6f7f3dd8a9c1";
const secondBookAnnotationId = "b1d8f4c7-6a1e-4fd1-8c22-2d8b7e5a4f30";
const firstIsbn13 = "9780000000002";
const secondIsbn13 = "9780000000019";
const quote = "これは日本語の引用です。";
const sameBookQuote = "同じ本からの二つ目の引用です。";
const secondBookQuote = "別の本からの引用です。";
const title = "Shelf Smoke Book";
const sameBookTitle = title;
const secondBookTitle = "Shelf Smoke Second Book";
const author = "Shelf Smoke Author";
const secondBookAuthor = "Shelf Smoke Second Author";
const firstPublisher = "Shelf Smoke Publisher";
const secondPublisher = "Shelf Smoke Second Publisher";
const firstPublishedDate = "2024";
const secondPublishedDate = "2025";
const markerText = `<!-- maginalia:quote-ref v1 {"quoteId":"${annotationId}","mode":"normal"} -->`;
const sameBookMarkerText = `<!-- maginalia:quote-ref v1 {"quoteId":"${sameBookAnnotationId}","mode":"normal"} -->`;
const secondBookMarkerText = `<!-- maginalia:quote-ref v1 {"quoteId":"${secondBookAnnotationId}","mode":"normal"} -->`;
const referenceStart = "<!-- maginalia:reference-list-start v1 -->";
const referenceEnd = "<!-- maginalia:reference-list-end v1 -->";
const manualReferenceText = "手書きの参考メモは保持されます。";
const initialText = `\uFEFF# Shelf smoke\r\n\r\nこれはShelf smokeの原稿です。\r\n\r\n${manualReferenceText}\r\n`;

const quotations = [
  {
    annotationId,
    isbn13: firstIsbn13,
    title,
    authors: [author],
    quote,
    pageLabel: "42",
    comment: "Shelf smoke comment"
  },
  {
    annotationId: sameBookAnnotationId,
    isbn13: firstIsbn13,
    title: sameBookTitle,
    authors: [author],
    quote: sameBookQuote,
    pageLabel: "43",
    comment: "Same book comment"
  },
  {
    annotationId: secondBookAnnotationId,
    isbn13: secondIsbn13,
    title: secondBookTitle,
    authors: [secondBookAuthor],
    quote: secondBookQuote,
    pageLabel: "7",
    comment: "Second book comment"
  }
];

function reviewerResult(record) {
  return {
    ...record,
    captureId: `capture-${record.annotationId}`,
    pageId: `page-${record.annotationId}`,
    sourcePageId: `source-page-${record.annotationId}`,
    reviewState: "APPROVED",
    reviewedAtMs: 1700000000000
  };
}

function startReviewerFixture() {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not-found" }));
      return;
    }

    if (requestUrl.pathname === "/api/books/9780000000002/publication"
      || requestUrl.pathname === "/api/books/9780000000019/publication") {
      const secondBook = requestUrl.pathname.endsWith(secondIsbn13 + "/publication");
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        updatedAtMs: 1700000000000,
        book: {
          isbn13: secondBook ? secondIsbn13 : firstIsbn13,
          title: secondBook ? secondBookTitle : title,
          authors: secondBook ? [secondBookAuthor] : [author],
          publisher: secondBook ? secondPublisher : firstPublisher,
          publishedDate: secondBook ? secondPublishedDate : firstPublishedDate
        },
        highlights: []
      }));
      return;
    }

    if (requestUrl.pathname !== "/api/search"
      || requestUrl.searchParams.get("status") !== "APPROVED") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unexpected-search" }));
      return;
    }

    const query = requestUrl.searchParams.get("q");
    const limit = requestUrl.searchParams.get("limit");
    const offset = requestUrl.searchParams.get("offset") ?? "0";
    let records;
    if (query === "") {
      if (limit !== "100" || offset !== "0") {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "unexpected-resolution-pagination" }));
        return;
      }
      records = quotations;
    } else if (query === "日本語") {
      if (limit !== "50" || offset !== "0") {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "unexpected-shelf-pagination" }));
        return;
      }
      records = [quotations[0]];
    } else if (query === "二つ目") {
      records = [quotations[1]];
    } else if (query === "別の本") {
      records = [quotations[2]];
    } else {
      records = [];
    }

    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({
      results: records.map(reviewerResult),
      total: query === "" ? quotations.length : records.length,
      limit: Number(limit ?? "50"),
      offset: Number(offset)
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

function closeReviewerFixture(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function runElectron(projectRoot, userDataRoot, reviewerBaseUrl) {
  const child = spawn(electronExecutable, [
    mainPath,
    `--user-data-dir=${userDataRoot}`,
    "--smoke-shelf",
    projectRoot
  ], {
    cwd: desktopRoot,
    env: { ...process.env, MAGINALIA_REVIEWER_BASE_URL: reviewerBaseUrl },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Electron Shelf smoke timed out."));
    }, 60_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

let temporaryDirectory;
let reviewerFixture;
try {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "maginalia-shelf-smoke-"));
  const projectRoot = path.join(temporaryDirectory, "project-root");
  const userDataRoot = path.join(temporaryDirectory, "electron-user-data");
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, "manuscript.md"), Buffer.from(initialText, "utf8"));
  await writeFile(
    path.join(projectRoot, "notes.md"),
    Buffer.from("\uFEFF# Shelf notes\r\n\r\n別の原稿です。\r\n", "utf8")
  );

  reviewerFixture = await startReviewerFixture();
  const result = await runElectron(projectRoot, userDataRoot, reviewerFixture.baseUrl);
  if (result.code !== 0 || !result.stdout.includes(marker)) {
    throw new Error(
      "Electron Shelf smoke failed (exit "
        + (result.code ?? result.signal)
        + ").\n"
        + result.stdout
        + result.stderr
    );
  }

  const savedText = await readFile(path.join(projectRoot, "manuscript.md"), "utf8");
  if (savedText.split(markerText).length - 1 !== 1) {
    throw new Error("Shelf smoke did not persist exactly one QuoteRef marker.");
  }
  if (savedText.split(sameBookMarkerText).length - 1 !== 1) {
    throw new Error("Shelf smoke did not persist the same-book QuoteRef marker.");
  }
  if (savedText.includes(secondBookMarkerText)) {
    throw new Error("Shelf smoke did not remove the final second-book QuoteRef marker.");
  }
  for (const value of [quote, sameBookQuote, secondBookQuote]) {
    if (savedText.includes(value)) throw new Error(`Shelf smoke persisted resolved quotation metadata: ${value}`);
  }
  if (!savedText.includes(referenceStart) || !savedText.includes(referenceEnd)) {
    throw new Error("Shelf smoke did not persist the derived Reference List markers.");
  }
  if (savedText.split(title).length - 1 !== 1 || savedText.includes(secondBookTitle)) {
    throw new Error("Shelf smoke did not dedupe/remove derived source entries.");
  }
  if (!savedText.includes(manualReferenceText)) {
    throw new Error("Shelf smoke removed manual reference text.");
  }
  process.stdout.write(result.stdout + result.stderr);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (reviewerFixture) await closeReviewerFixture(reviewerFixture.server);
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
}
