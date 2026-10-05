/**
 * Format-neutral presentation state for future PDF/DOCX adapters.
 *
 * These values describe how a resolved ExportDocumentModel is presented. They
 * are not Markdown metadata and are never persisted into an authoring source.
 */
export type ExportPaperSize =
  | "A3"
  | "A4"
  | "A5"
  | "B3"
  | "B4"
  | "B5"
  | "Letter"
  | "Legal";

export type ExportOrientation = "portrait" | "landscape";

export interface ExportPresentationHeader {
  readonly left: string;
  readonly center: string;
  readonly right: string;
}

export interface ExportPresentationSettings {
  readonly paperSize: ExportPaperSize;
  readonly orientation: ExportOrientation;
  readonly paragraphIndent: boolean;
  readonly header: ExportPresentationHeader;
  readonly pageNumber: boolean;
}

/** Ordered values are part of the small shared contract (B values are JIS). */
export const EXPORT_PAPER_SIZES: readonly ExportPaperSize[] = Object.freeze([
  "A3", "A4", "A5", "B3", "B4", "B5", "Letter", "Legal"
]);

export const EXPORT_ORIENTATIONS: readonly ExportOrientation[] = Object.freeze([
  "portrait", "landscape"
]);

const DEFAULT_HEADER: ExportPresentationHeader = Object.freeze({ left: "", center: "", right: "" });

export const DEFAULT_EXPORT_PRESENTATION_SETTINGS: ExportPresentationSettings = Object.freeze({
  paperSize: "A4",
  orientation: "portrait",
  paragraphIndent: true,
  header: DEFAULT_HEADER,
  pageNumber: true
});

export function isExportPaperSize(value: unknown): value is ExportPaperSize {
  return typeof value === "string" && (EXPORT_PAPER_SIZES as readonly string[]).includes(value);
}

export function isExportOrientation(value: unknown): value is ExportOrientation {
  return typeof value === "string" && (EXPORT_ORIENTATIONS as readonly string[]).includes(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try { return Object.getPrototypeOf(value) === Object.prototype; } catch { return false; }
}

/** Runtime guard for values crossing the renderer/main export boundary. */
export function isExportPresentationSettings(value: unknown): value is ExportPresentationSettings {
  if (!isPlainRecord(value)) return false;
  const header = value.header;
  return isExportPaperSize(value.paperSize)
    && isExportOrientation(value.orientation)
    && typeof value.paragraphIndent === "boolean"
    && typeof value.pageNumber === "boolean"
    && isPlainRecord(header)
    && typeof header.left === "string"
    && typeof header.center === "string"
    && typeof header.right === "string";
}

export interface ExportPresentationSettingsInput {
  readonly paperSize?: unknown;
  readonly orientation?: unknown;
  readonly paragraphIndent?: unknown;
  readonly header?: {
    readonly left?: unknown;
    readonly center?: unknown;
    readonly right?: unknown;
  };
  readonly pageNumber?: unknown;
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** Create a deeply immutable settings value without touching any source text. */
export function createExportPresentationSettings(
  input: ExportPresentationSettingsInput = {}
): ExportPresentationSettings {
  const paperSize = input.paperSize === undefined ? DEFAULT_EXPORT_PRESENTATION_SETTINGS.paperSize : input.paperSize;
  const orientation = input.orientation === undefined ? DEFAULT_EXPORT_PRESENTATION_SETTINGS.orientation : input.orientation;
  const paragraphIndent = input.paragraphIndent === undefined
    ? DEFAULT_EXPORT_PRESENTATION_SETTINGS.paragraphIndent
    : input.paragraphIndent;
  const pageNumber = input.pageNumber === undefined
    ? DEFAULT_EXPORT_PRESENTATION_SETTINGS.pageNumber
    : input.pageNumber;
  if (!isExportPaperSize(paperSize)) throw new RangeError("Unsupported export paper size.");
  if (!isExportOrientation(orientation)) throw new RangeError("Unsupported export orientation.");
  if (typeof paragraphIndent !== "boolean") throw new TypeError("Export paragraphIndent must be boolean.");
  if (typeof pageNumber !== "boolean") throw new TypeError("Export pageNumber must be boolean.");

  const sourceHeader = input.header ?? {};
  const header = Object.freeze({
    left: text(sourceHeader.left, ""),
    center: text(sourceHeader.center, ""),
    right: text(sourceHeader.right, "")
  });
  return Object.freeze({
    paperSize,
    orientation,
    paragraphIndent,
    header,
    pageNumber
  });
}
