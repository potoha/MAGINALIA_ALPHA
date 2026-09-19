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
const quote = "これは日本語の引用です。";
const title = "Shelf Smoke Book";
const author = "Shelf Smoke Author";
const initialText = "\uFEFF# Shelf smoke\r\n\r\nこれはShelf smokeの原稿です。\r\n";
const markerText = `<!-- maginalia:quote-ref v1 {"quoteId":"${annotationId}","mode":"normal"} -->`;

function startReviewerFixture() {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || requestUrl.pathname !== "/api/search") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not-found" }));
      return;
    }
    if (requestUrl.searchParams.get("q") !== "日本語"
      || requestUrl.searchParams.get("status") !== "APPROVED"
      || requestUrl.searchParams.get("limit") !== "50") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unexpected-search" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({
      results: [{
        annotationId,
        captureId: "capture-shelf-smoke",
        pageId: "page-shelf-smoke",
        sourcePageId: "source-page-shelf-smoke",
        isbn13: "9780000000042",
        title,
        authors: [author],
        quote,
        pageLabel: "42",
        comment: "Shelf smoke comment",
        reviewState: "APPROVED",
        reviewedAtMs: 1700000000000
      }],
      total: 1,
      limit: 50,
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
  for (const value of [quote, title, author]) {
    if (savedText.includes(value)) throw new Error(`Shelf smoke persisted resolved quotation metadata: ${value}`);
  }
  process.stdout.write(result.stdout + result.stderr);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (reviewerFixture) await closeReviewerFixture(reviewerFixture.server);
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
}
