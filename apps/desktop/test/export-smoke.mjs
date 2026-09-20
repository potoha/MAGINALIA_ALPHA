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
const marker = "MAGINALIA_ELECTRON_EXPORT_SMOKE_OK";
const annotationId = "e5c6d7a8-9012-4b3c-8d7e-6f5a4b3c2d1e";
const isbn13 = "9780000000002";
const quote = "これはExport smokeの解決済み引用です。";
const title = "Export Smoke Book";
const author = "Export Smoke Author";
const captureId = "capture-export-smoke";
const quoteMarker = `<!-- maginalia:quote-ref v1 {"quoteId":"${annotationId}","mode":"normal"} -->`;
const referenceStart = "<!-- maginalia:reference-list-start v1 -->";
const referenceEnd = "<!-- maginalia:reference-list-end v1 -->";
const initialA = `\uFEFF# Export A\r\n\r\n${quoteMarker}\r\n\r\n## 参考文献\r\n\r\n${referenceStart}\r\n- old generated entry\r\n${referenceEnd}\r\n\r\n手書きの参考メモです。\r\n`;
const initialB = "\uFEFF# Export B\r\n\r\nB-only document.\r\n";

function startReviewerFixture() {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not-found" }));
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

function runElectron(projectRoot, userDataRoot, reviewerBaseUrl) {
  const child = spawn(electronExecutable, [
    mainPath,
    `--user-data-dir=${userDataRoot}`,
    "--smoke-export",
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
      reject(new Error("Electron Export smoke timed out."));
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
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "maginalia-export-smoke-"));
  const projectRoot = path.join(temporaryDirectory, "project-root");
  const userDataRoot = path.join(temporaryDirectory, "electron-user-data");
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, "a.md"), Buffer.from(initialA, "utf8"));
  await writeFile(path.join(projectRoot, "b.md"), Buffer.from(initialB, "utf8"));

  reviewerFixture = await startReviewerFixture();
  const result = await runElectron(projectRoot, userDataRoot, reviewerFixture.baseUrl);
  if (result.code !== 0 || !result.stdout.includes(marker)) {
    throw new Error(
      "Electron Export smoke failed (exit "
        + (result.code ?? result.signal)
        + ").\n"
        + result.stdout
        + result.stderr
    );
  }

  const authoringA = await readFile(path.join(projectRoot, "a.md"));
  const authoringB = await readFile(path.join(projectRoot, "b.md"));
  if (!authoringA.equals(Buffer.from(initialA, "utf8"))) {
    throw new Error("Export smoke changed authoring A bytes.");
  }
  if (!authoringB.equals(Buffer.from(initialB, "utf8"))) {
    throw new Error("Export smoke changed authoring B bytes.");
  }

  const outputA = await readFile(path.join(projectRoot, "export-1.resolved.md"), "utf8");
  if (!outputA.includes(`> ${quote}`)
    || !outputA.includes(`（${author}『${title}』、p.42）`)
    || !outputA.includes(`- ${author}『${title}』 Export Smoke Publisher、2024。`)
    || !outputA.includes("Unsaved export-only edit.")
    || outputA.includes(quoteMarker)
    || outputA.includes(referenceStart)
    || outputA.includes(referenceEnd)
    || outputA.includes(annotationId)
    || outputA.includes(captureId)
    || outputA.includes("page-export-smoke")
    || outputA.includes("source-page-internal")
    || outputA.includes("book:isbn13:")) {
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
