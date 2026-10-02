import { describe, expect, it, vi } from "vitest";
import { validateEntity } from "@maginalia/format";
import {
  createReviewerReconciliationCandidate,
  materializeReviewerReconciliationCandidate,
  type ApprovedReviewerRecord,
  type OpenBdBookMetadata,
  type ReviewerReconciliationCandidate
} from "./reviewer-shelf-reconciliation";

const ISBN = "9780306406157";
const REVIEWER_ANNOTATION_UUID = "123e4567-e89b-42d3-a456-426614174000";
const FORMAT_ULID = "01J0A1B2C3D4E5F6G7H8J9K0M1";

function reviewerRecord(overrides: Partial<ApprovedReviewerRecord> = {}): ApprovedReviewerRecord {
  return {
    annotationId: REVIEWER_ANNOTATION_UUID,
    reviewState: "APPROVED",
    isbn13: ISBN,
    quote: "「引用の本文」\r\nそのまま保存する。",
    pageLabel: "42",
    comment: "研究者のメモ：前付けの文脈",
    ...overrides
  };
}

function openBdMetadata(overrides: Partial<OpenBdBookMetadata> = {}): OpenBdBookMetadata {
  return {
    isbn13: ISBN,
    title: "『開かれた作品』",
    authors: ["ウンベルト・エーコ"],
    publisher: "青土社",
    year: 1990,
    ...overrides
  };
}

async function candidateFor(
  record: unknown = reviewerRecord(),
  metadata: unknown = openBdMetadata()
): Promise<ReviewerReconciliationCandidate> {
  const result = await createReviewerReconciliationCandidate(record, metadata);
  if (result.kind !== "candidate") throw new Error(`Expected candidate, received ${result.code}.`);
  return result;
}

describe("Reviewer to Format v0.1 reconciliation core", () => {
  it("keeps Japanese quotation/comment text exact and stores the Reviewer UUID as an opaque private alias", async () => {
    const idGenerator = vi.fn(() => `ann:${FORMAT_ULID}`);
    const candidate = await candidateFor();

    expect(candidate.book).toEqual({
      type: "book",
      version: "0.1",
      id: `isbn:${ISBN}`,
      isbn13: ISBN,
      title: "『開かれた作品』",
      authors: ["ウンベルト・エーコ"],
      publisher: "青土社",
      year: 1990
    });
    expect(candidate.annotation).not.toHaveProperty("id");
    expect(candidate.annotation).toMatchObject({
      type: "annotation",
      version: "0.1",
      source: `isbn:${ISBN}`,
      location: { page: 42 },
      quote: "「引用の本文」\r\nそのまま保存する。",
      privateMemo: "研究者のメモ：前付けの文脈",
      deviceMetadata: {
        maginaliaReviewer: {
          version: 1,
          annotationId: REVIEWER_ANNOTATION_UUID,
          digest: candidate.digest
        }
      }
    });
    expect(candidate.annotation).not.toHaveProperty("comment");
    expect(idGenerator).not.toHaveBeenCalled();

    const materialized = await materializeReviewerReconciliationCandidate(candidate, idGenerator);
    expect(idGenerator).toHaveBeenCalledTimes(1);
    expect(materialized.kind).toBe("materialized");
    if (materialized.kind !== "materialized") return;
    expect(materialized.annotation.id).toBe(`ann:${FORMAT_ULID}`);
    expect(materialized.annotation.id).not.toContain(REVIEWER_ANNOTATION_UUID);
    expect(validateEntity("book", materialized.book).valid).toBe(true);
    expect(validateEntity("annotation", materialized.annotation).valid).toBe(true);
  });

  it("validates ISBN-13 checksum and approval state before creating a candidate", async () => {
    expect(await createReviewerReconciliationCandidate(
      reviewerRecord({ isbn13: "9780306406158" }), openBdMetadata({ isbn13: "9780306406158" })
    )).toMatchObject({ kind: "pending", code: "invalid-isbn13" });
    expect(await createReviewerReconciliationCandidate(
      { ...reviewerRecord(), reviewState: "NEEDS_REVIEW" }, openBdMetadata()
    )).toMatchObject({ kind: "pending", code: "reviewer-not-approved" });
    expect(await createReviewerReconciliationCandidate(
      reviewerRecord({ annotationId: "not-a-uuid" }), openBdMetadata()
    )).toMatchObject({ kind: "pending", code: "invalid-reviewer-annotation-id" });
  });

  it("requires matching openBD ISBN, nonempty title/authors, and valid optional fields", async () => {
    const invalidCases: readonly [unknown, string][] = [
      [undefined, "openbd-metadata-missing"],
      [openBdMetadata({ isbn13: "9780134685991" }), "openbd-isbn-mismatch"],
      [openBdMetadata({ title: "  " }), "invalid-openbd-title"],
      [openBdMetadata({ authors: [] }), "invalid-openbd-authors"],
      [openBdMetadata({ authors: ["山田太郎", " "] }), "invalid-openbd-authors"],
      [{ ...openBdMetadata(), publisher: 42 }, "invalid-openbd-publisher"],
      [{ ...openBdMetadata(), year: 1990.5 }, "invalid-openbd-year"],
      [{ ...openBdMetadata(), year: -1 }, "invalid-openbd-year"]
    ];
    for (const [metadata, code] of invalidCases) {
      expect(await createReviewerReconciliationCandidate(reviewerRecord(), metadata)).toMatchObject({
        kind: "pending",
        code
      });
    }

    const withoutOptionalFields = await candidateFor(reviewerRecord(), {
      isbn13: ISBN,
      title: "本の題名",
      authors: ["著者"]
    });
    expect(withoutOptionalFields.book).not.toHaveProperty("publisher");
    expect(withoutOptionalFields.book).not.toHaveProperty("year");
  });

  it("leaves noninteger page labels pending when no legal Format locator is supplied", async () => {
    const result = await createReviewerReconciliationCandidate(
      reviewerRecord({ pageLabel: "前付け xiv" }), openBdMetadata()
    );
    expect(result).toMatchObject({
      kind: "pending",
      code: "pending-location",
      reviewerAnnotationId: REVIEWER_ANNOTATION_UUID,
      pageLabel: "前付け xiv"
    });
    if (result.kind === "pending") expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it.each(["0", "42a", " 42", "42 ", "四十二", "９", "9007199254740992"]) (
    "does not coerce page label %j to a numeric Format page",
    async (pageLabel) => {
      expect(await createReviewerReconciliationCandidate(
        reviewerRecord({ pageLabel }), openBdMetadata()
      )).toMatchObject({ kind: "pending", code: "pending-location", pageLabel });
    }
  );

  it("computes a stable digest and candidate for the same consumed Reviewer/openBD fields", async () => {
    const first = reviewerRecord();
    const reordered = {
      comment: first.comment,
      pageLabel: first.pageLabel,
      quote: first.quote,
      isbn13: first.isbn13,
      reviewState: first.reviewState,
      annotationId: first.annotationId,
      reviewedAtMs: 123,
      title: "ignored Reviewer title"
    };
    const metadata = openBdMetadata();
    const firstCandidate = await candidateFor(first, metadata);
    const secondCandidate = await candidateFor(reordered, {
      year: metadata.year,
      publisher: metadata.publisher,
      authors: [...metadata.authors],
      title: metadata.title,
      isbn13: metadata.isbn13
    });

    expect(secondCandidate).toEqual(firstCandidate);
    expect(firstCandidate.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect((await candidateFor(reviewerRecord({ quote: "別の引用" }), metadata)).digest).not.toBe(firstCandidate.digest);
  });

  it("uses the Format ULID generator only during materialization and rejects invalid generated IDs", async () => {
    const candidate = await candidateFor();
    const invalidIdGenerator = vi.fn(() => `ann:${REVIEWER_ANNOTATION_UUID}`);
    const result = await materializeReviewerReconciliationCandidate(candidate, invalidIdGenerator);
    expect(invalidIdGenerator).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ kind: "pending", code: "invalid-generated-annotation-id" });
  });

  it("uses the Format ULID generator by default on first materialization", async () => {
    const result = await materializeReviewerReconciliationCandidate(await candidateFor());
    expect(result.kind).toBe("materialized");
    if (result.kind !== "materialized") return;
    expect(result.annotation.id).toMatch(/^ann:[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
    expect(validateEntity("annotation", result.annotation).valid).toBe(true);
  });
});
