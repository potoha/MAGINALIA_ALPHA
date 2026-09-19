import type { ProjectDocumentType } from "../project-metadata";

const INVALID_FILE_NAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]+/gu;
const RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const MARKDOWN_EXTENSION = /\.(?:md|markdown)$/iu;
const MAX_FILE_NAME_LENGTH = 240;

function dateStamp(value: Date): string {
  const year = String(value.getFullYear()).padStart(4, "0");
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function trimFileNameBase(value: string): string {
  return value
    .replace(MARKDOWN_EXTENSION, "")
    .replace(INVALID_FILE_NAME_CHARACTERS, "-")
    .replace(/[. ]+$/u, "")
    .trim();
}

function boundedBase(value: string, suffix = ""): string {
  const available = Math.max(1, MAX_FILE_NAME_LENGTH - ".md".length - suffix.length);
  const bounded = value.slice(0, available).replace(/[. ]+$/u, "");
  return bounded || "untitled";
}

function candidateExists(candidate: string, existingNames: ReadonlySet<string>): boolean {
  return existingNames.has(candidate.toLocaleLowerCase());
}

/**
 * Keep the human title recognizable while adapting only filesystem-invalid
 * characters. Existing names are checked so a title can be used repeatedly
 * without asking the user for an internal filename.
 */
export function createProjectFileName(
  title: string,
  documentType: ProjectDocumentType,
  existingNames: readonly string[] = [],
  now = new Date(),
): string {
  const existing = new Set(existingNames.map((name) => name.toLocaleLowerCase()));
  let base = trimFileNameBase(title);
  if (!base) base = `${documentType}-${dateStamp(now)}`;
  if (RESERVED_DEVICE_NAME.test(base)) base = `document-${base}`;

  const first = `${boundedBase(base)}.md`;
  if (!candidateExists(first, existing)) return first;

  for (let index = 1; index < 1000; index += 1) {
    const suffix = `-${String(index).padStart(3, "0")}`;
    const candidate = `${boundedBase(base, suffix)}${suffix}.md`;
    if (!candidateExists(candidate, existing)) return candidate;
  }

  const suffix = `-${Date.now().toString(36)}`;
  return `${boundedBase(base, suffix)}${suffix}.md`;
}
