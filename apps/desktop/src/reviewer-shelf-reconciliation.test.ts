import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { generateEntityId, validateShelfEntity } from "@maginalia/format";
import {
  createReviewerReconciliationCandidate,
  materializeReviewerReconciliationCandidate,
  type ApprovedReviewerRecord,
  type ReviewerReconciliationCandidate
} from "./reviewer-shelf-reconciliation";

const ISBN = "9780306406157";
const PACKAGE_ID = "capkg:01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REVIEWER_ANNOTATION_UUID = "123e4567-e89b-42d3-a456-426614174000";
const FORMAT_ULID = "01J0A1B2C3D4E5F6G7H8J9K0M1";

function reviewerRecord(overrides: Partial<ApprovedReviewerRecord> = {}): ApprovedReviewerRecord {
  return {
    annotationId: REVIEWER_ANNOTATION_UUID,
    reviewState: "APPROVED",
    packageId: PACKAGE_ID,
    sourceKind: "book",
    getDate: "202602011230",
    isbn13: ISBN,
    url: null,
    title: "『開かれた作品』",
    authors: ["ウンベルト・エーコ"],
    publisher: "青土社",
    year: 1990,
    quote: "「引用の本文」\r\nそのまま保存する。",
    pageLabel: "42",
    comment: "研究者のメモ：前付けの文脈",
    ...overrides
  };
}

async function candidateFor(record: unknown = reviewerRecord()): Promise<ReviewerReconciliationCandidate> {
  const result = await createReviewerReconciliationCandidate(record);
  if (result.kind !== "candidate") throw new Error(`Expected candidate, received ${result.code}.`);
  return result;
}

function v04Book(candidate: ReviewerReconciliationCandidate) {
  return {
    type: "book" as const,
    version: "0.4" as const,
    id: candidate.bookId,
    source: { kind: candidate.sourceKind },
    get: { date: candidate.getDate },
    ...(candidate.isbn13 === undefined ? {} : { isbn13: candidate.isbn13 }),
    ...(candidate.url === undefined ? {} : { url: candidate.url }),
    ...(candidate.title === undefined ? {} : { title: candidate.title }),
    ...(candidate.authors.length === 0 ? {} : { authors: [...candidate.authors] }),
    ...(candidate.publisher === undefined ? {} : { publisher: candidate.publisher }),
    ...(candidate.year === undefined ? {} : { year: candidate.year })
  };
}

describe("Reviewer to Shelf v0.4 reconciliation core", () => {
  it("preserves Japanese quote, package provenance, get.date, and the Reviewer UUID alias", async () => {
    const candidate = await candidateFor();
    expect(candidate).toMatchObject({
      packageId: PACKAGE_ID,
      sourceKind: "book",
      getDate: "202602011230",
      isbn13: ISBN,
      quote: "「引用の本文」\r\nそのまま保存する。",
      page: 42,
      privateMemo: "研究者のメモ：前付けの文脈"
    });
    expect(candidate.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const annotationId = vi.fn(() => `ann:${FORMAT_ULID}`);
    const output = await materializeReviewerReconciliationCandidate(candidate, v04Book(candidate), [], annotationId);
    expect(annotationId).toHaveBeenCalledOnce();
    expect(output.kind).toBe("materialized");
    if (output.kind !== "materialized") return;
    expect(output.annotation).toMatchObject({
      type: "annotation",
      version: "0.4",
      id: `ann:${FORMAT_ULID}`,
      source: { id: candidate.bookId, kind: "book" },
      get: { date: "202602011230" },
      isbn13: ISBN,
      location: { page: 42 },
      quote: "「引用の本文」\r\nそのまま保存する。",
      privateMemo: "研究者のメモ：前付けの文脈",
      deviceMetadata: { maginaliaReviewer: { annotationId: REVIEWER_ANNOTATION_UUID, digest: candidate.digest } }
    });
    expect(validateShelfEntity("book", output.book).valid).toBe(true);
    expect(validateShelfEntity("annotation", output.annotation).valid).toBe(true);
  });

  it("does not fabricate missing v1 provenance and rejects invalid package/source identities", async () => {
    expect(await createReviewerReconciliationCandidate({
      ...reviewerRecord(), packageId: undefined, sourceKind: undefined, getDate: undefined
    })).toMatchObject({ kind: "pending", code: "invalid-package-id" });
    expect(await createReviewerReconciliationCandidate(reviewerRecord({ packageId: "capkg:invalid" })))
      .toMatchObject({ kind: "pending", code: "invalid-package-id" });
    expect(await createReviewerReconciliationCandidate(reviewerRecord({ isbn13: "9780306406158" })))
      .toMatchObject({ kind: "pending", code: "invalid-isbn13" });
    expect(await createReviewerReconciliationCandidate({ ...reviewerRecord(), reviewState: "NEEDS_REVIEW" }))
      .toMatchObject({ kind: "pending", code: "reviewer-not-approved" });
    expect(await createReviewerReconciliationCandidate(reviewerRecord({ annotationId: "not-a-uuid" })))
      .toMatchObject({ kind: "pending", code: "invalid-reviewer-annotation-id" });
  });

  it("keeps unsupported page labels pending instead of coercing them", async () => {
    for (const pageLabel of ["0", "42a", " 42", "42 ", "四十二", "９", "9007199254740992"]) {
      expect(await createReviewerReconciliationCandidate(reviewerRecord({ pageLabel })))
        .toMatchObject({ kind: "pending", code: "pending-location", pageLabel });
    }
  });

  it("keeps candidate digest independent of object key order and Reviewer approval time", async () => {
    const first = reviewerRecord();
    const candidate = await candidateFor(first);
    const reordered = await candidateFor({
      comment: first.comment,
      pageLabel: first.pageLabel,
      quote: first.quote,
      isbn13: first.isbn13,
      reviewState: first.reviewState,
      annotationId: first.annotationId,
      packageId: first.packageId,
      sourceKind: first.sourceKind,
      getDate: first.getDate,
      title: first.title,
      authors: first.authors,
      publisher: first.publisher,
      year: first.year,
      reviewedAtMs: 1_728_000_000_000
    });
    expect(reordered.digest).toBe(candidate.digest);
    expect((await candidateFor(reviewerRecord({ quote: "別の引用" }))).digest).not.toBe(candidate.digest);
    expect((await candidateFor(reviewerRecord({ getDate: "202602011231" }))).digest).not.toBe(candidate.digest);
  });

  it("validates Handwritten canonical bytes and preserves the exact source file metadata", async () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0x00, 0x01]);
    const sha256 = createHash("sha256").update(jpeg).digest("hex");
    const record = reviewerRecord({
      sourceKind: "Handwritten",
      isbn13: null,
      url: null,
      sourceFiles: [{ path: "images/手書き.jpg", mediaType: "image/jpeg", sha256, originalName: "手書き.jpg", bytes: jpeg }]
    });
    const candidate = await candidateFor(record);
    expect(candidate.canonicalSourceAssets[0]?.bytes).toEqual(jpeg);
    expect(await createReviewerReconciliationCandidate(reviewerRecord({ sourceKind: "Handwritten", isbn13: null, url: null })))
      .toMatchObject({ kind: "pending", code: "canonical-source-files-missing" });
    expect(await createReviewerReconciliationCandidate({
      ...record,
      sourceFiles: [{ path: "images/手書き.jpg", mediaType: "image/jpeg", sha256: "0".repeat(64), bytes: jpeg }]
    })).toMatchObject({ kind: "pending", code: "canonical-source-hash-mismatch" });
    expect(await createReviewerReconciliationCandidate({
      ...record,
      sourceFiles: [{ path: "../手書き.jpg", mediaType: "image/jpeg", sha256, bytes: jpeg }]
    })).toMatchObject({ kind: "pending", code: "invalid-source-file" });
  });

  it("rejects invalid generated Annotation IDs", async () => {
    const candidate = await candidateFor();
    const result = await materializeReviewerReconciliationCandidate(
      candidate,
      v04Book(candidate),
      [],
      () => `ann:${REVIEWER_ANNOTATION_UUID}`
    );
    expect(result).toMatchObject({ kind: "pending", code: "invalid-generated-annotation-id" });
    expect(generateEntityId("ann")).toMatch(/^ann:[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
  });
});
