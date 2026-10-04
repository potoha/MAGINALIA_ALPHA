import { validateInternalLinkTarget } from "../project-links";
import { scanFrontMatter } from "./document-properties";
import { isMarkdownFenceClosing, isMarkdownFirstLevelHeading, openingMarkdownFence } from "./markdown-fence";
import { stripDerivedReferenceList } from "./reference-list";

export const SYNCED_BLOCK_VERSION = 1;
export const SYNCED_BLOCK_PREFIX = "<!-- maginalia:synced-block ";
export const DEFAULT_SYNCED_BLOCK_MAX_DEPTH = 32;
export const DEFAULT_SYNCED_BLOCK_MAX_NODES = 256;

export interface SyncedBlockMarker {
  readonly kind: "valid";
  readonly target: string;
  readonly marker: string;
  readonly start: number;
  readonly end: number;
}

export type ParsedSyncedBlockMarker =
  | { readonly kind: "valid"; readonly target: string; readonly marker: string }
  | { readonly kind: "invalid"; readonly marker: string; readonly reason: "malformed" | "unsupported-version" | "invalid-target" };

/** Whether a complete authored line is a structural (possibly invalid) marker. */
export function isSyncedBlockStructuralLine(line: string): boolean {
  return parseSyncedBlockMarker(line) !== null;
}

export interface SyncedBlockProjection {
  readonly kind: "projected";
  readonly markdown: string;
  readonly bodyStart: number;
}

export type SyncedBlockProjectionResult = SyncedBlockProjection | {
  readonly kind: "invalid-front-matter";
  readonly message: string;
};

export type SyncedBlockResolveResult =
  | { readonly kind: "resolved"; readonly target: string; readonly fileId: string; readonly displayName: string; readonly text: string }
  | { readonly kind: "missing" | "invalid" | "unavailable" | "error"; readonly message: string };

export interface ComposedSyncedBlock {
  readonly kind: "resolved" | "unresolved";
  readonly marker: string;
  readonly target?: string;
  readonly fileId?: string;
  readonly displayName?: string;
  readonly markdown?: string;
  readonly children?: ReadonlyMap<string, ComposedSyncedBlock>;
  readonly message?: string;
}

export interface ProjectComposition {
  readonly blocks: ReadonlyMap<string, ComposedSyncedBlock>;
  readonly resolvedCount: number;
}

export interface ProjectCompositionOptions {
  readonly rootTarget: string;
  readonly resolve: (target: string) => Promise<SyncedBlockResolveResult>;
  readonly maxDepth?: number;
  readonly maxNodes?: number;
}

export type LinearProjectCompositionResult =
  | { readonly kind: "linear"; readonly markdown: string }
  | { readonly kind: "blocked"; readonly message: string };

/** Disposable renderer-side snapshot used by References and Export. */
export type ComposedMarkdownProjection =
  | { readonly kind: "composed"; readonly text: string; readonly isCurrent?: () => boolean }
  | { readonly kind: "blocked"; readonly message: string };

function sourceLineEnd(source: string, start: number): number {
  const lf = source.indexOf("\n", start);
  return lf < 0 ? source.length : lf + 1;
}

function lineText(source: string, start: number, end: number): string {
  const rawEnd = end > start && source[end - 1] === "\n" ? end - 1 : end;
  const textEnd = rawEnd > start && source[rawEnd - 1] === "\r" ? rawEnd - 1 : rawEnd;
  return source.slice(start, textEnd);
}

/** Strict portable Markdown target shared with Project internal-link safety. */
export function validateSyncedBlockTarget(value: unknown): string | null {
  if (typeof value !== "string" || !/\.(?:md|markdown)$/iu.test(value)) return null;
  const validated = validateInternalLinkTarget(value);
  return validated.kind === "valid" ? validated.target : null;
}

export function serializeSyncedBlock(target: string): string {
  const valid = validateSyncedBlockTarget(target);
  if (valid === null) throw new Error("Synced Block targets must be Project-relative Markdown paths.");
  return `<!-- maginalia:synced-block v${SYNCED_BLOCK_VERSION} ${JSON.stringify({ target: valid })} -->`;
}

/** Isolated structural insertion, preserving all Markdown outside the range. */
export function insertSyncedBlockMarker(text: string, start: number, end: number, target: string): { readonly replacement: string } {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const prefix = before.length > 0 && !/\n\n$/u.test(before) ? (before.endsWith("\n") ? "\n" : "\n\n") : "";
  const suffix = after.length > 0 && !/^\n\n/u.test(after) ? (after.startsWith("\n") ? "\n" : "\n\n") : "";
  return { replacement: `${prefix}${serializeSyncedBlock(target)}${suffix}` };
}

/** Parse one complete marker; unknown versions and malformed payloads stay inert. */
export function parseSyncedBlockMarker(marker: string): ParsedSyncedBlockMarker | null {
  if (!marker.startsWith(SYNCED_BLOCK_PREFIX) || !marker.endsWith(" -->")) return null;
  const match = /^<!-- maginalia:synced-block v(\d+) (\{.*\}) -->$/u.exec(marker);
  if (match === null) return { kind: "invalid", marker, reason: "malformed" };
  if (Number(match[1]) !== SYNCED_BLOCK_VERSION) return { kind: "invalid", marker, reason: "unsupported-version" };
  let payload: unknown;
  try { payload = JSON.parse(match[2]!); } catch { return { kind: "invalid", marker, reason: "malformed" }; }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)
    || Reflect.ownKeys(payload).length !== 1 || !Object.prototype.hasOwnProperty.call(payload, "target")) {
    return { kind: "invalid", marker, reason: "malformed" };
  }
  const target = validateSyncedBlockTarget((payload as { target?: unknown }).target);
  return target === null
    ? { kind: "invalid", marker, reason: "invalid-target" }
    : { kind: "valid", marker, target };
}

/**
 * Scan authored markers with original UTF-16 offsets. Fenced code remains
 * source code, never a composition graph edge.
 */
export function scanSyncedBlockMarkers(
  source: string,
  options: { readonly sourceMode?: "document" | "already-projected" } = {},
): readonly (SyncedBlockMarker | Extract<ParsedSyncedBlockMarker, { readonly kind: "invalid" }> & { readonly start: number; readonly end: number })[] {
  const result: (SyncedBlockMarker | Extract<ParsedSyncedBlockMarker, { readonly kind: "invalid" }> & { readonly start: number; readonly end: number })[] = [];
  const sourceMode = options.sourceMode ?? "document";
  const frontMatter = sourceMode === "document" ? scanFrontMatter(source) : { kind: "none" as const };
  // Match parseMarkdownBlocks(), which treats a leading BOM as encoding rather
  // than authored block text while retaining original source offsets.
  let cursor = frontMatter.kind === "bounded" ? frontMatter.boundary.bodyStart : (source.startsWith("\uFEFF") ? 1 : 0);
  let fence: ReturnType<typeof openingMarkdownFence> = null;
  while (cursor < source.length) {
    const end = sourceLineEnd(source, cursor);
    const line = lineText(source, cursor, end);
    if (fence !== null) {
      if (isMarkdownFenceClosing(line, fence)) fence = null;
      cursor = end;
      continue;
    }
    const opening = openingMarkdownFence(line);
    if (opening !== null) {
      fence = opening;
      cursor = end;
      continue;
    }
    // Synced Blocks are structural whole-line markers. Keeping this identical
    // to the Renderer block parser prevents an inline comment from gaining a
    // composition edge that has no rendered block counterpart.
    const parsed = isSyncedBlockStructuralLine(line) ? parseSyncedBlockMarker(line) : null;
    if (parsed !== null) {
      const markerEnd = cursor + line.length;
      if (parsed.kind === "valid") result.push({ ...parsed, start: cursor, end: markerEnd });
      else result.push({ ...parsed, start: cursor, end: markerEnd });
    }
    cursor = end;
  }
  return Object.freeze(result);
}

/**
 * Project a child document without creating a second durable representation.
 * Valid front matter and only the first real H1 are omitted; all remaining
 * Markdown keeps its original spelling and line endings.
 */
export function projectSyncedDocument(source: string): SyncedBlockProjectionResult {
  const scan = scanFrontMatter(source);
  if (scan.kind === "unterminated") {
    return { kind: "invalid-front-matter", message: "Synced document metadata is not closed. Open its source to repair it." };
  }
  const bodyStart = scan.kind === "bounded" ? scan.boundary.bodyStart : 0;
  // A BOM is an encoding marker, not projected prose. It remains untouched in
  // the durable child source but must not prevent the first real H1 from being
  // recognized when a document has no front matter.
  const projectionStart = source.startsWith("\uFEFF") && bodyStart === 0 ? 1 : bodyStart;
  let cursor = projectionStart;
  let fence: ReturnType<typeof openingMarkdownFence> = null;
  while (cursor < source.length) {
    const end = sourceLineEnd(source, cursor);
    const line = lineText(source, cursor, end);
    if (fence !== null) {
      if (isMarkdownFenceClosing(line, fence)) fence = null;
      cursor = end;
      continue;
    }
    const opening = openingMarkdownFence(line);
    if (opening !== null) {
      fence = opening;
      cursor = end;
      continue;
    }
    if (isMarkdownFirstLevelHeading(line)) {
      return { kind: "projected", markdown: `${source.slice(projectionStart, cursor)}${source.slice(end)}`, bodyStart };
    }
    cursor = end;
  }
  return { kind: "projected", markdown: source.slice(projectionStart), bodyStart };
}

/** A bounded, DOM-independent Project-local Synced Block traversal. */
export async function resolveProjectComposition(source: string, options: ProjectCompositionOptions): Promise<ProjectComposition> {
  const maxDepth = options.maxDepth ?? DEFAULT_SYNCED_BLOCK_MAX_DEPTH;
  const maxNodes = options.maxNodes ?? DEFAULT_SYNCED_BLOCK_MAX_NODES;
  let resolvedCount = 0;
  let visitedBlockCount = 0;
  const visit = async (
    text: string,
    ancestors: readonly string[],
    depth: number,
    sourceMode: "document" | "already-projected",
  ): Promise<ReadonlyMap<string, ComposedSyncedBlock>> => {
    const blocks = new Map<string, ComposedSyncedBlock>();
    for (const occurrence of scanSyncedBlockMarkers(text, { sourceMode })) {
      if (occurrence.kind === "invalid") {
        blocks.set(occurrence.marker, { kind: "unresolved", marker: occurrence.marker, message: "Synced Block marker is invalid." });
        continue;
      }
      if (depth >= maxDepth || visitedBlockCount >= maxNodes) {
        blocks.set(occurrence.marker, { kind: "unresolved", marker: occurrence.marker, target: occurrence.target, message: "Synced Block composition reached its safety limit." });
        continue;
      }
      // The bound applies to every valid edge considered, including missing
      // or malformed child sources, so hostile input cannot cause unbounded
      // resolver work through unresolved markers.
      visitedBlockCount += 1;
      if (ancestors.includes(occurrence.target)) {
        blocks.set(occurrence.marker, { kind: "unresolved", marker: occurrence.marker, target: occurrence.target, message: "Synced Block cannot be composed because it creates a cycle." });
        continue;
      }
      const resolved = await options.resolve(occurrence.target);
      if (resolved.kind !== "resolved") {
        blocks.set(occurrence.marker, { kind: "unresolved", marker: occurrence.marker, target: occurrence.target, message: resolved.message });
        continue;
      }
      const projection = projectSyncedDocument(resolved.text);
      if (projection.kind !== "projected") {
        blocks.set(occurrence.marker, { kind: "unresolved", marker: occurrence.marker, target: resolved.target, fileId: resolved.fileId, displayName: resolved.displayName, message: projection.message });
        continue;
      }
      resolvedCount += 1;
      const children = await visit(projection.markdown, [...ancestors, resolved.target], depth + 1, "already-projected");
      blocks.set(occurrence.marker, {
        kind: "resolved",
        marker: occurrence.marker,
        target: resolved.target,
        fileId: resolved.fileId,
        displayName: resolved.displayName,
        markdown: projection.markdown,
        children,
      });
    }
    return blocks;
  };
  const root = validateSyncedBlockTarget(options.rootTarget) ?? options.rootTarget;
  const blocks = await visit(source, [root], 0, "document");
  return { blocks, resolvedCount };
}

/**
 * Materialize an already-resolved ProjectComposition into one disposable
 * Markdown projection.  Resolution owns graph traversal; this function only
 * replaces its exact structural markers, so it never becomes a second graph
 * walker or a durable document authority.
 */
export function linearizeProjectComposition(source: string, composition: ProjectComposition): LinearProjectCompositionResult {
  const linearize = (
    text: string,
    blocks: ReadonlyMap<string, ComposedSyncedBlock>,
    sourceMode: "document" | "already-projected"
  ): LinearProjectCompositionResult => {
    const pieces: string[] = [];
    let cursor = 0;
    for (const occurrence of scanSyncedBlockMarkers(text, { sourceMode })) {
      if (occurrence.kind !== "valid") {
        return { kind: "blocked", message: "Synced Block marker is invalid." };
      }
      const block = blocks.get(occurrence.marker);
      if (block === undefined) {
        return { kind: "blocked", message: "Synced Block composition is incomplete." };
      }
      if (block.kind !== "resolved" || block.markdown === undefined) {
        return { kind: "blocked", message: block.message ?? "Synced document is unavailable." };
      }
      const child = linearize(block.markdown, block.children ?? new Map(), "already-projected");
      if (child.kind === "blocked") return child;
      const withoutDerivedReferences = stripDerivedReferenceList(child.markdown);
      if (withoutDerivedReferences.kind === "conflict") {
        return { kind: "blocked", message: "Synced document has an invalid derived reference list." };
      }
      pieces.push(text.slice(cursor, occurrence.start), withoutDerivedReferences.text);
      cursor = occurrence.end;
    }
    pieces.push(text.slice(cursor));
    const markdown = pieces.join("");
    return { kind: "linear", markdown };
  };
  return linearize(source, composition.blocks, "document");
}

/** Check a proposed parent -> child edge before source mutation. */
export async function wouldIntroduceSyncedBlockCycle(
  parentTarget: string,
  childTarget: string,
  resolve: (target: string) => Promise<SyncedBlockResolveResult>,
  maxNodes = DEFAULT_SYNCED_BLOCK_MAX_NODES,
): Promise<boolean> {
  if (parentTarget === childTarget) return true;
  const visited = new Set<string>();
  const visit = async (target: string): Promise<boolean> => {
    if (target === parentTarget) return true;
    if (visited.has(target)) return false;
    // Insertion must fail closed when the bounded graph walk cannot prove the
    // proposed edge is acyclic.
    if (visited.size >= maxNodes) return true;
    visited.add(target);
    const result = await resolve(target);
    if (result.kind !== "resolved") return false;
    for (const occurrence of scanSyncedBlockMarkers(result.text)) {
      if (occurrence.kind === "valid" && await visit(occurrence.target)) return true;
    }
    return false;
  };
  return visit(childTarget);
}
