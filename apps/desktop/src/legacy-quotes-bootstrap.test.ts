import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serializeQuoteRef } from "@maginalia/writing-core";
import { LibraryService } from "./library-service";
import { bootstrapLegacyQuotes } from "./legacy-quotes-bootstrap";
import { resolveShelfQuoteRefs } from "./shelf-resolution";

const ISBN = "9784061590298";
const FIRST_UUID = "0b974fe9-4f3a-453b-b96d-9a6b18c0b94c";
const SECOND_UUID = "f8117324-5c51-48ec-90a6-4aec62dcd1d7";
const RECORDS = [
  {
    annotationId: FIRST_UUID,
    reviewState: "APPROVED" as const,
    isbn13: ISBN,
    quote: "「日本語の引用を保存する。」",
    pageLabel: "63",
    comment: "全角記号　と注記",
  },
  {
    annotationId: SECOND_UUID,
    reviewState: "APPROVED" as const,
    isbn13: ISBN,
    quote: "「別の箇所も同じ書誌へ結び付く。」",
    pageLabel: "103",
    comment: "二件目のメモ",
  },
];

let root: string | undefined;

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function directories(): Promise<{ source: string; shelf: string }> {
  root = await mkdtemp(path.join(os.tmpdir(), "maginalia-h6r4-日本語-"));
  const source = path.join(root, "legacy_quotes");
  const shelf = path.join(root, "private_shelf");
  await Promise.all([mkdir(source), mkdir(shelf)]);
  return { source, shelf };
}

const metadata = async () => ({
  status: "ok" as const,
  metadata: {
    isbn13: ISBN,
    title: "『日本語の人文学』",
    authors: ["山田 太郎"],
    publisher: "日本語出版社",
    year: 2024,
  },
});

describe("H.6R4 legacy quote bootstrap", () => {
  it("creates an explicit canonical Private Shelf and preserves legacy UUID aliases idempotently", async () => {
    const { source, shelf } = await directories();
    const loadRecords = async () => RECORDS;
    const first = await bootstrapLegacyQuotes({
      sourceRoot: source,
      shelfRoot: shelf,
      shelfName: "私有引用棚",
      loadRecords,
      lookupMetadata: metadata,
    });
    expect(first).toMatchObject({ initialized: true, approvedRecords: 2, materialized: 2, unchanged: 0, pending: [], conflicts: 0 });
    await expect(readFile(path.join(shelf, ".maginalia", "repository.json"), "utf8"))
      .resolves.toContain('"kind": "shelf"');
    await expect(readFile(path.join(shelf, "books", `${ISBN}.json`), "utf8"))
      .resolves.toContain("『日本語の人文学』");

    const repeated = await bootstrapLegacyQuotes({
      sourceRoot: source,
      shelfRoot: shelf,
      loadRecords,
      lookupMetadata: metadata,
    });
    expect(repeated).toMatchObject({ initialized: false, approvedRecords: 2, materialized: 0, unchanged: 2, pending: [], conflicts: 0 });

    const service = new LibraryService();
    const owner = {};
    const opened = await service.openPrivateShelfForOwner(owner, shelf);
    expect(opened).toMatchObject({ kind: "opened", recordCount: 2, issueCount: 0 });
    if (opened.kind !== "opened") throw new Error("Expected the bootstrapped Shelf to open");
    expect(service.searchForOwner(owner, opened.library.libraryId, "日本語の引用")).toMatchObject({
      kind: "results",
      results: [expect.objectContaining({ sourceId: `isbn:${ISBN}` })],
    });
    const active = service.getActivePrivateShelfForOwner(owner);
    expect(active.kind).toBe("private-shelf");
    if (active.kind !== "private-shelf") throw new Error("Expected active Shelf");
    const resolution = await resolveShelfQuoteRefs(serializeQuoteRef({ quoteId: FIRST_UUID, mode: "normal" }), active.entities);
    expect(resolution).toMatchObject({ kind: "resolved", unresolved: [], resolved: [{ quotation: { annotationId: FIRST_UUID, quote: RECORDS[0].quote } }] });
  });

  it("leaves approved legacy records pending until openBD metadata is available, then retries safely", async () => {
    const { source, shelf } = await directories();
    const record = [RECORDS[0]];
    const unavailable = await bootstrapLegacyQuotes({
      sourceRoot: source,
      shelfRoot: shelf,
      loadRecords: async () => record,
      lookupMetadata: async () => ({ status: "unavailable" as const }),
    });
    expect(unavailable).toMatchObject({ materialized: 0, pending: [{ code: "openbd-metadata-missing", reviewerAnnotationId: FIRST_UUID }] });
    const retried = await bootstrapLegacyQuotes({
      sourceRoot: source,
      shelfRoot: shelf,
      loadRecords: async () => record,
      lookupMetadata: metadata,
    });
    expect(retried).toMatchObject({ initialized: false, materialized: 1, pending: [], conflicts: 0 });
  });

  it("does not merge into a nonempty non-Shelf destination", async () => {
    const { source, shelf } = await directories();
    await writeFile(path.join(shelf, "unrelated.txt"), "leave this alone", "utf8");
    await expect(bootstrapLegacyQuotes({
      sourceRoot: source,
      shelfRoot: shelf,
      loadRecords: async () => RECORDS,
    })).rejects.toThrow("empty directory or an existing Private Shelf");
    await expect(readFile(path.join(shelf, "unrelated.txt"), "utf8")).resolves.toBe("leave this alone");
  });
});
