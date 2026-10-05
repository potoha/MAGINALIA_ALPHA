import { access, copyFile, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { collectMarkdownTables } from "./renderer/markdown-table-commands";
import { isMarkdownFenceClosing, openingMarkdownFence, parseMarkdownHeading } from "./renderer/markdown-fence";
import { parseMarkdownListItem } from "./renderer/markdown-structure";
import { createExportDocumentModel, type ExportDocumentBlock } from "./renderer/export-document-model";
import type { ExportPresentationSettings, ExportPaperSize } from "./export-presentation-settings";

const PAGE_DIMENSIONS: Readonly<Record<ExportPaperSize, readonly [number, number]>> = Object.freeze({
  A3: [297, 420],
  A4: [210, 297],
  A5: [148, 210],
  B3: [364, 515],
  B4: [257, 364],
  B5: [182, 257],
  Letter: [215.9, 279.4],
  Legal: [215.9, 355.6]
});

function html(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function cssString(value: string): string {
  // CSS strings are not JSON strings. In particular, authored header text
  // must not terminate the HTML style element.
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/[\r\n]/gu, " ").replace(/</gu, "\\3c ")}"`;
}

function inline(value: string): string {
  // Escape plain text once, after finding Markdown tokens. Performing regex
  // replacements on generated HTML would let later tokens rewrite attributes.
  const tokens = /!\[([^\]]*)\]\(([^\s)]+)\)|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*/giu;
  let result = "";
  let cursor = 0;
  for (const match of value.matchAll(tokens)) {
    result += html(value.slice(cursor, match.index));
    if (match[1] !== undefined) result += `<span class="media-reference">${html(match[1] || match[2]!)}</span>`;
    else if (match[3] !== undefined) result += `<a href="${html(match[4]!)}">${inline(match[3])}</a>`;
    else if (match[5] !== undefined) result += `<code>${html(match[5])}</code>`;
    else if (match[6] !== undefined) result += `<strong>${inline(match[6])}</strong>`;
    else result += `<em>${inline(match[7]!)}</em>`;
    cursor = match.index + match[0].length;
  }
  result += html(value.slice(cursor));
  return result;
}

function tableHtml(markdown: string): string {
  const table = collectMarkdownTables(markdown)[0];
  if (table === undefined) return `<pre>${html(markdown)}</pre>`;
  const row = (cells: readonly string[], tag: "th" | "td"): string =>
    `<tr>${cells.map((cell) => `<${tag}>${inline(cell)}</${tag}>`).join("")}</tr>`;
  return `<table><thead>${row(table.header, "th")}</thead><tbody>${table.rows.map((cells) => row(cells, "td")).join("")}</tbody></table>`;
}

function blockHtml(block: ExportDocumentBlock): string {
  if (block.kind === "metadata" || block.kind === "raw") return "";
  if (block.kind === "heading") {
    const line = block.markdown.replace(/\r?\n$/u, "");
    const heading = parseMarkdownHeading(line);
    return heading === null ? `<p>${inline(line)}</p>` : `<h${heading.level}>${inline(heading.content)}</h${heading.level}>`;
  }
  if (block.kind === "paragraph") {
    return `<p class="body-paragraph">${inline(block.markdown.replace(/\r?\n$/u, "").replace(/\r?\n/gu, "\n"))}</p>`;
  }
  if (block.kind === "blockquote") {
    const text = block.markdown.split(/\r?\n/gu).filter((line) => line.length > 0).map((line) => line.replace(/^>\s?/u, "")).join("\n");
    return `<blockquote>${inline(text)}</blockquote>`;
  }
  if (block.kind === "code") {
    const lines = block.markdown.split(/\r?\n/gu);
    const opener = openingMarkdownFence(lines[0]!.replace(/^\uFEFF/u, ""));
    const content = lines.slice(1);
    if (content.at(-1) === "") content.pop();
    if (opener !== null && content.length > 0 && isMarkdownFenceClosing(content.at(-1)!, opener)) content.pop();
    return `<pre><code>${html(content.join("\n"))}</code></pre>`;
  }
  if (block.kind === "table") return tableHtml(block.markdown);
  const lines = block.markdown.split(/\r?\n/gu).filter((line) => line.length > 0);
  const items = lines.map((line) => {
    const item = parseMarkdownListItem(line);
    return item === null ? `<li>${inline(line)}</li>` : `<li>${inline(item.content)}</li>`;
  }).join("");
  return `<${block.ordered ? "ol" : "ul"}>${items}</${block.ordered ? "ol" : "ul"}>`;
}

function pageSize(settings: ExportPresentationSettings): string {
  const [short, long] = PAGE_DIMENSIONS[settings.paperSize];
  return settings.orientation === "portrait" ? `${short}mm ${long}mm` : `${long}mm ${short}mm`;
}

/** Convert the format-neutral model into Vivliostyle input HTML. */
export function renderExportDocumentHtml(markdown: string, settings: ExportPresentationSettings): string {
  const header = settings.header;
  const headerCss = [
    `@top-left { content: ${cssString(header.left)}; }`,
    `@top-center { content: ${cssString(header.center)}; }`,
    `@top-right { content: ${cssString(header.right)}; }`,
    settings.pageNumber ? `@bottom-center { content: counter(page); }` : ""
  ].join("\n");
  const body = createExportDocumentModel(markdown).blocks.map(blockHtml).join("\n");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>
@page { size: ${pageSize(settings)}; margin: 18mm 16mm 20mm; ${headerCss} }
html { font-family: sans-serif; }
body { color: #111; line-height: 1.6; }
.body-paragraph { white-space: pre-wrap; ${settings.paragraphIndent ? "text-indent: 1em;" : ""} }
h1, h2, h3, h4, h5, h6 { break-after: avoid; }
blockquote { margin: 1em 2em; border-left: 0.2em solid #888; padding-left: 1em; }
pre { white-space: pre-wrap; font-family: monospace; background: #f5f5f5; padding: 0.7em; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #888; padding: 0.25em 0.5em; vertical-align: top; }
th { background: #eee; }
img { max-width: 100%; }
</style></head><body>${body}</body></html>`;
}

async function executableOnPath(executable: string): Promise<string> {
  if (path.isAbsolute(executable)) return executable;
  if (executable.includes("/") || executable.includes("\\")) return path.resolve(executable);
  const names = process.platform === "win32" && path.extname(executable) === ""
    ? [executable, `${executable}.exe`, `${executable}.cmd`]
    : [executable];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      try { await access(candidate); return candidate; } catch { /* Check the next PATH entry. */ }
    }
  }
  throw new Error("Vivliostyle CLI was not found. Configure its executable or JavaScript CLI entry.");
}

async function vivliostyleCommand(executable: string, args: readonly string[]): Promise<{
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}> {
  const resolved = await executableOnPath(executable);
  let entry = resolved;
  if (/\.(?:cmd|bat)$/iu.test(resolved)) {
    // Standard npm Windows shims cannot be spawned without a shell. Resolve
    // only their known JS entries; no shell ever receives user output paths.
    const relative = /^npx\.cmd$/iu.test(path.basename(resolved))
      ? "node_modules/npm/bin/npx-cli.js"
      : /^vivliostyle\.cmd$/iu.test(path.basename(resolved))
        ? "node_modules/@vivliostyle/cli/dist/cli.js"
        : null;
    if (relative === null) throw new Error("Configure the Vivliostyle JavaScript CLI entry instead of a command script.");
    entry = path.join(path.dirname(resolved), relative);
    await access(entry);
  }
  if (/\.(?:mjs|cjs|js)$/iu.test(entry)) {
    return { executable: process.execPath, args: [entry, ...args], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } };
  }
  return { executable: resolved, args, env: process.env };
}

async function runVivliostyle(executable: string, args: readonly string[]): Promise<void> {
  const command = await vivliostyleCommand(executable, args);
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, [...command.args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: command.env,
      shell: false,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-16_384); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16_384); });
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolve()
      : reject(new Error((stderr || stdout).trim() || `Vivliostyle exited with ${code ?? "unknown"}.`)));
  });
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

async function commitPdf(stagedPdfPath: string, outputPath: string): Promise<void> {
  // The Vivliostyle staging root may be on a different volume from the
  // user's destination. Copy into a same-directory temporary file first so
  // the final replace remains atomic on that destination volume.
  const temporaryPath = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.maginalia-${randomUUID()}.tmp`);
  let temporaryCreated = false;
  try {
    await copyFile(stagedPdfPath, temporaryPath, 0);
    temporaryCreated = true;
    try {
      await rename(temporaryPath, outputPath);
      temporaryCreated = false;
    } catch (error: unknown) {
      if (!(["EEXIST", "EPERM", "ENOTEMPTY"] as readonly string[]).includes(errorCode(error) ?? "")) throw error;
      const destination = await stat(outputPath);
      if (!destination.isFile()) throw error;
      await rm(outputPath, { force: false });
      await rename(temporaryPath, outputPath);
      temporaryCreated = false;
    }
  } finally {
    if (temporaryCreated) await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

/** Main-process adapter. Vivliostyle owns the actual PDF/typesetting boundary. */
export async function writePdfWithVivliostyle(
  outputPath: string,
  markdown: string,
  settings: ExportPresentationSettings,
  executable = process.env.MAGINALIA_VIVLIOSTYLE_BIN ?? "vivliostyle"
): Promise<void> {
  // Keep the staged artifact as a file in the process workspace rather than a
  // directory under the manuscript context; the CLI rejects output paths that
  // are interpreted as its input/workspace directory.
  const temporaryDirectory = await mkdtemp(path.join(process.cwd(), ".maginalia-vivliostyle-"));
  const inputPath = path.join(temporaryDirectory, "resolved.html");
  const stagingRoot = process.cwd();
  const stagedPdfPath = path.join(stagingRoot, `.maginalia-vivliostyle-${randomUUID()}.pdf`);
  try {
    await writeFile(inputPath, renderExportDocumentHtml(markdown, settings), "utf8");
    const commandArgs = /(?:^|[\\/])npx(?:\.cmd)?$/iu.test(executable)
      ? ["--yes", "@vivliostyle/cli", "build", inputPath, "-o", stagedPdfPath, "-d", "--no-enable-static-serve"]
      : ["build", inputPath, "-o", stagedPdfPath, "-d", "--no-enable-static-serve"];
    await runVivliostyle(executable, commandArgs);
    const output = await stat(stagedPdfPath);
    if (!output.isFile() || output.size < 5 || !(await readFile(stagedPdfPath)).subarray(0, 5).equals(Buffer.from("%PDF-"))) {
      throw new Error("Vivliostyle did not create a valid PDF.");
    }
    // Commit only after successful generation and validation. Failed processes
    // cannot leave a truncated artifact at the user's selected destination.
    await commitPdf(stagedPdfPath, outputPath);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
    await rm(stagedPdfPath, { force: true });
  }
}
