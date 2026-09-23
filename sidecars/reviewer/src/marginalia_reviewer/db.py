from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterator

from .candidates import annotation_candidates, capture_ocr_candidates, ocr_transcription, resolve_ocr_orientation

REVIEW_STATES = frozenset({"PENDING", "RUNNING", "NEEDS_REVIEW", "APPROVED", "FAILED"})
MAX_SEARCH_QUERY_LENGTH = 500
MAX_SEARCH_BOOK_LENGTH = 200
MAX_SEARCH_ISBN_LENGTH = 32
MAX_SEARCH_LIMIT = 100
MAX_SEARCH_OFFSET = 100_000


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _like_pattern(value: str) -> str:
    """Build a literal substring pattern for SQLite LIKE."""
    escaped = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


class Workspace:
    def __init__(self, database_path: Path) -> None:
        self.database_path = database_path
        database_path.parent.mkdir(parents=True, exist_ok=True)

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.database_path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def initialize(self) -> None:
        with self.connect() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS imports (
                    id TEXT PRIMARY KEY,
                    source_name TEXT NOT NULL,
                    root_path TEXT NOT NULL,
                    manifest_json TEXT NOT NULL,
                    imported_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS books (
                    id TEXT PRIMARY KEY,
                    import_id TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
                    isbn13 TEXT,
                    title TEXT,
                    authors_json TEXT NOT NULL DEFAULT '[]',
                    orientation TEXT,
                    source_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS pages (
                    id TEXT PRIMARY KEY,
                    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
                    source_page_id TEXT,
                    image_path TEXT NOT NULL,
                    image_media_type TEXT NOT NULL DEFAULT 'image/jpeg',
                    width INTEGER,
                    height INTEGER,
                    captured_at TEXT,
                    status TEXT NOT NULL CHECK(status IN ('PENDING','RUNNING','NEEDS_REVIEW','APPROVED','FAILED')),
                    mobile_ocr_regions_json TEXT NOT NULL DEFAULT '[]',
                    ocr_regions_json TEXT NOT NULL DEFAULT '[]',
                    ocr_provenance_json TEXT,
                    ocr_orientation_override TEXT NOT NULL DEFAULT 'AUTO' CHECK(ocr_orientation_override IN ('AUTO','VERTICAL','HORIZONTAL')),
                    error_summary TEXT,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS annotations (
                    id TEXT PRIMARY KEY,
                    page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
                    source_annotation_id TEXT,
                    geometry_json TEXT NOT NULL DEFAULT '[]',
                    highlight_quote TEXT NOT NULL DEFAULT '',
                    sentence_before TEXT NOT NULL DEFAULT '',
                    sentence_after TEXT NOT NULL DEFAULT '',
                    page_label TEXT NOT NULL DEFAULT '',
                    chapter_label TEXT NOT NULL DEFAULT '',
                    comment TEXT NOT NULL DEFAULT '',
                    created_at TEXT,
                    source_capture_id TEXT,
                    source_book_id TEXT,
                    selected_region_json TEXT,
                    capture_ocr_json TEXT NOT NULL DEFAULT '{}',
                    phone_comment TEXT NOT NULL DEFAULT '',
                    review_state TEXT NOT NULL DEFAULT 'PENDING',
                    reviewed_at_ms INTEGER,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_pages_status ON pages(status, updated_at);
                CREATE INDEX IF NOT EXISTS idx_annotations_page ON annotations(page_id);
                """
            )
            columns = {row[1] for row in db.execute("PRAGMA table_info(annotations)")}
            if "reviewed_at_ms" not in columns:
                db.execute("ALTER TABLE annotations ADD COLUMN reviewed_at_ms INTEGER")
            # Additive migration for .magicap v1 captures. Legacy strokes and
            # their publication fields remain untouched.
            for column, definition in (
                ("source_capture_id", "TEXT"),
                ("source_book_id", "TEXT"),
                ("selected_region_json", "TEXT"),
                ("capture_ocr_json", "TEXT NOT NULL DEFAULT '{}'"),
                ("phone_comment", "TEXT NOT NULL DEFAULT ''"),
                ("review_state", "TEXT NOT NULL DEFAULT 'PENDING'"),
            ):
                if column not in columns:
                    db.execute(f"ALTER TABLE annotations ADD COLUMN {column} {definition}")
            page_columns = {row[1] for row in db.execute("PRAGMA table_info(pages)")}
            if "mobile_ocr_regions_json" not in page_columns:
                db.execute("ALTER TABLE pages ADD COLUMN mobile_ocr_regions_json TEXT NOT NULL DEFAULT '[]'")
            if "image_media_type" not in page_columns:
                db.execute("ALTER TABLE pages ADD COLUMN image_media_type TEXT NOT NULL DEFAULT 'image/jpeg'")
            if "ocr_orientation_override" not in page_columns:
                db.execute("ALTER TABLE pages ADD COLUMN ocr_orientation_override TEXT NOT NULL DEFAULT 'AUTO'")
            db.execute("CREATE INDEX IF NOT EXISTS idx_books_isbn13 ON books(isbn13)")
            db.execute("CREATE INDEX IF NOT EXISTS idx_pages_book_status_updated ON pages(book_id, status, updated_at)")
            db.execute(
                "CREATE INDEX IF NOT EXISTS idx_annotations_review_state_reviewed "
                "ON annotations(review_state, reviewed_at_ms, updated_at)"
            )

    def recover_interrupted(self) -> int:
        with self.connect() as db:
            result = db.execute(
                "UPDATE pages SET status='PENDING', error_summary='OCR interrupted; ready to retry', updated_at=? "
                "WHERE status='RUNNING'",
                (now_iso(),),
            )
            return result.rowcount

    def list_pages(self) -> list[dict[str, Any]]:
        with self.connect() as db:
            rows = db.execute(
                """SELECT pages.id, pages.source_page_id, pages.status, pages.error_summary,
                          annotations.page_label, annotations.chapter_label, books.isbn13, books.title
                   FROM pages JOIN books ON books.id=pages.book_id
                   LEFT JOIN annotations ON annotations.id=(
                       SELECT id FROM annotations WHERE page_id=pages.id ORDER BY id LIMIT 1
                   )
                   ORDER BY pages.updated_at DESC, pages.id"""
            ).fetchall()
        return [dict(row) for row in rows]

    def get_page(self, page_id: str) -> dict[str, Any] | None:
        with self.connect() as db:
            page = db.execute(
                """SELECT pages.*, books.isbn13, books.title, books.authors_json, books.orientation
                   FROM pages JOIN books ON books.id=pages.book_id WHERE pages.id=?""",
                (page_id,),
            ).fetchone()
            if page is None:
                return None
            annotations = db.execute(
                "SELECT * FROM annotations WHERE page_id=? ORDER BY id", (page_id,)
            ).fetchall()
        result = dict(page)
        result["mobile_ocr_regions"] = json.loads(result.pop("mobile_ocr_regions_json"))
        result["ocr_regions"] = json.loads(result.pop("ocr_regions_json"))
        result["ocr_provenance"] = (
            json.loads(result.pop("ocr_provenance_json")) if result["ocr_provenance_json"] else None
        )
        book_orientation = result.get("orientation") if result.get("orientation") in {"VERTICAL", "HORIZONTAL"} else None
        override = str(result.get("ocr_orientation_override") or "AUTO")
        page_orientation = resolve_ocr_orientation(override, book_orientation, result["ocr_regions"])
        result["page_ocr_orientation"] = page_orientation
        result["page_ocr_transcription"] = ocr_transcription(result["ocr_regions"], page_orientation)
        result["authors"] = json.loads(result.pop("authors_json"))
        result["annotations"] = []
        candidate_regions = result["ocr_regions"] or result["mobile_ocr_regions"]
        for row in annotations:
            annotation = dict(row)
            annotation["geometry"] = json.loads(annotation.pop("geometry_json"))
            selected_raw = annotation.pop("selected_region_json", None)
            annotation["selected_region"] = json.loads(selected_raw) if selected_raw else None
            if annotation["selected_region"] is not None:
                # The Android rectangle remains authoritative. This result was
                # recognized from a JPEG crop of that rectangle, not inferred
                # from any full-page OCR boxes it happens to intersect.
                capture_ocr = json.loads(annotation.pop("capture_ocr_json") or "{}")
                annotation["capture_ocr"] = capture_ocr or None
                capture_orientation = resolve_ocr_orientation(
                    override,
                    book_orientation,
                    capture_ocr.get("regions", []) if isinstance(capture_ocr, dict) else [],
                )
                annotation["capture_ocr_orientation"] = capture_orientation
                annotation["candidates"] = capture_ocr_candidates(
                    capture_ocr.get("regions", []) if isinstance(capture_ocr, dict) else [],
                    capture_orientation,
                )
            else:
                annotation.pop("capture_ocr_json", None)
                annotation["candidates"] = annotation_candidates(
                    annotation["geometry"], candidate_regions, str(result.get("orientation") or "HORIZONTAL")
                )
            result["annotations"].append(annotation)
        return result

    def transition(self, page_id: str, expected: set[str], target: str, error: str | None = None) -> bool:
        if target not in REVIEW_STATES or not expected <= REVIEW_STATES:
            raise ValueError("invalid review state")
        placeholders = ",".join("?" for _ in expected)
        with self.connect() as db:
            result = db.execute(
                f"UPDATE pages SET status=?, error_summary=?, updated_at=? WHERE id=? AND status IN ({placeholders})",
                (target, error, now_iso(), page_id, *sorted(expected)),
            )
            return result.rowcount == 1

    def fail_ocr(self, page_id: str, error: str) -> None:
        summary = error.strip()[:1000] or "OCR failed"
        self.transition(page_id, {"RUNNING"}, "FAILED", summary)

    def save_ocr(
        self,
        page_id: str,
        regions: list[dict[str, Any]],
        provenance: dict[str, Any],
        capture_ocr: dict[str, dict[str, Any]] | None = None,
    ) -> None:
        with self.connect() as db:
            db.execute(
                "UPDATE pages SET ocr_regions_json=?, ocr_provenance_json=?, status='NEEDS_REVIEW', "
                "error_summary=NULL, updated_at=? WHERE id=? AND status='RUNNING'",
                (json.dumps(regions, ensure_ascii=False), json.dumps(provenance), now_iso(), page_id),
            )
            db.execute(
                "UPDATE annotations SET capture_ocr_json='{}' WHERE page_id=? AND selected_region_json IS NOT NULL",
                (page_id,),
            )
            for annotation_id, evidence in (capture_ocr or {}).items():
                db.execute(
                    "UPDATE annotations SET capture_ocr_json=? WHERE id=? AND page_id=? AND selected_region_json IS NOT NULL",
                    (json.dumps(evidence, ensure_ascii=False), annotation_id, page_id),
                )

    def update_ocr_regions(self, page_id: str, regions: list[dict[str, Any]]) -> bool:
        with self.connect() as db:
            result = db.execute(
                """UPDATE pages SET ocr_regions_json=?, status='NEEDS_REVIEW', updated_at=?
                   WHERE id=? AND status IN ('NEEDS_REVIEW','APPROVED','FAILED')""",
                (json.dumps(regions, ensure_ascii=False), now_iso(), page_id),
            )
            if result.rowcount:
                db.execute("UPDATE annotations SET reviewed_at_ms=NULL WHERE page_id=?", (page_id,))
            return result.rowcount == 1

    def update_ocr_orientation_override(self, page_id: str, override: str) -> bool:
        if override not in {"AUTO", "VERTICAL", "HORIZONTAL"}:
            raise ValueError("invalid OCR orientation override")
        with self.connect() as db:
            result = db.execute(
                """UPDATE pages SET ocr_orientation_override=?, status='NEEDS_REVIEW', updated_at=?
                   WHERE id=? AND status IN ('NEEDS_REVIEW','APPROVED','FAILED')""",
                (override, now_iso(), page_id),
            )
            if result.rowcount:
                db.execute("UPDATE annotations SET reviewed_at_ms=NULL WHERE page_id=?", (page_id,))
            return result.rowcount == 1

    def update_annotation(self, annotation_id: str, fields: dict[str, str]) -> bool:
        allowed = {
            "highlight_quote", "sentence_before", "sentence_after", "page_label", "chapter_label", "comment"
        }
        if set(fields) != allowed or not all(isinstance(value, str) for value in fields.values()):
            raise ValueError("all review fields are required strings")
        with self.connect() as db:
            result = db.execute(
                """UPDATE annotations SET highlight_quote=?, sentence_before=?, sentence_after=?,
                          page_label=?, chapter_label=?, comment=?, updated_at=? WHERE id=?""",
                (
                    fields["highlight_quote"], fields["sentence_before"], fields["sentence_after"],
                    fields["page_label"], fields["chapter_label"], fields["comment"], now_iso(), annotation_id,
                ),
            )
            if result.rowcount:
                db.execute(
                    """UPDATE pages SET status='NEEDS_REVIEW', updated_at=?
                       WHERE id=(SELECT page_id FROM annotations WHERE id=?) AND status='APPROVED'""",
                    (now_iso(), annotation_id),
                )
                db.execute("UPDATE annotations SET reviewed_at_ms=NULL WHERE id=?", (annotation_id,))
                db.execute("UPDATE annotations SET review_state='NEEDS_REVIEW' WHERE id=? AND selected_region_json IS NOT NULL", (annotation_id,))
            return result.rowcount == 1

    def approve_capture(self, annotation_id: str, reviewed_at_ms: int) -> bool:
        """Approve one .magicap capture without inventing legacy chapter/context."""
        with self.connect() as db:
            annotation = db.execute(
                "SELECT page_id, highlight_quote, page_label, selected_region_json FROM annotations WHERE id=?", (annotation_id,)
            ).fetchone()
            if annotation is None or annotation["selected_region_json"] is None:
                return False
            if not str(annotation["highlight_quote"]).strip() or not str(annotation["page_label"]).strip():
                raise ValueError("quote and page label are required")
            result = db.execute(
                "UPDATE annotations SET review_state='APPROVED', reviewed_at_ms=?, updated_at=? WHERE id=?",
                (reviewed_at_ms, now_iso(), annotation_id),
            )
            if result.rowcount:
                remaining = db.execute(
                    "SELECT COUNT(*) FROM annotations WHERE page_id=? AND selected_region_json IS NOT NULL AND review_state!='APPROVED'",
                    (annotation["page_id"],),
                ).fetchone()[0]
                db.execute(
                    "UPDATE pages SET status=?, error_summary=NULL, updated_at=? WHERE id=?",
                    ("APPROVED" if remaining == 0 else "NEEDS_REVIEW", now_iso(), annotation["page_id"]),
                )
            return result.rowcount == 1

    def approve_page(self, page_id: str, reviewed_at_ms: int) -> bool:
        with self.connect() as db:
            annotations = db.execute(
                "SELECT highlight_quote, page_label, chapter_label, selected_region_json FROM annotations WHERE page_id=?",
                (page_id,),
            ).fetchall()
            for annotation in annotations:
                required = ("highlight_quote", "page_label")
                if annotation["selected_region_json"] is None:
                    required += ("chapter_label",)
                if not all(str(annotation[field]).strip() for field in required):
                    raise ValueError("quote and page label are required; legacy annotations also require chapter label")
            result = db.execute(
                "UPDATE pages SET status='APPROVED', error_summary=NULL, updated_at=? "
                "WHERE id=? AND status IN ('NEEDS_REVIEW','APPROVED')",
                (now_iso(), page_id),
            )
            if result.rowcount:
                db.execute(
                    "UPDATE annotations SET reviewed_at_ms=?, updated_at=? WHERE page_id=?",
                    (reviewed_at_ms, now_iso(), page_id),
                )
            return result.rowcount == 1

    def search_quotes(
        self,
        *,
        query: str = "",
        isbn: str | None = None,
        book: str | None = None,
        status: str | None = "APPROVED",
        limit: int = 50,
        offset: int = 0,
    ) -> tuple[list[dict[str, Any]], int]:
        """Search reviewed quote records without creating a second source of truth."""
        if not isinstance(query, str) or len(query) > MAX_SEARCH_QUERY_LENGTH:
            raise ValueError(f"query must be at most {MAX_SEARCH_QUERY_LENGTH} characters")
        if isbn is not None and (not isinstance(isbn, str) or len(isbn) > MAX_SEARCH_ISBN_LENGTH):
            raise ValueError(f"isbn must be at most {MAX_SEARCH_ISBN_LENGTH} characters")
        if book is not None and (not isinstance(book, str) or len(book) > MAX_SEARCH_BOOK_LENGTH):
            raise ValueError(f"book must be at most {MAX_SEARCH_BOOK_LENGTH} characters")
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= MAX_SEARCH_LIMIT:
            raise ValueError(f"limit must be between 1 and {MAX_SEARCH_LIMIT}")
        if not isinstance(offset, int) or isinstance(offset, bool) or not 0 <= offset <= MAX_SEARCH_OFFSET:
            raise ValueError(f"offset must be between 0 and {MAX_SEARCH_OFFSET}")

        query = query.strip()
        isbn = isbn.strip() if isbn is not None else None
        book = book.strip() if book is not None else None
        requested_status = status.strip().upper() if isinstance(status, str) else "APPROVED"
        requested_status = requested_status or "APPROVED"
        if requested_status not in REVIEW_STATES | {"ALL"}:
            raise ValueError("invalid review state")

        review_state = (
            "CASE WHEN annotations.selected_region_json IS NOT NULL "
            "THEN annotations.review_state ELSE pages.status END"
        )
        quote = "COALESCE(annotations.highlight_quote, '')"
        comment = "COALESCE(annotations.comment, '')"
        title = "COALESCE(books.title, '')"
        authors = "COALESCE(books.authors_json, '')"
        page_label = "COALESCE(annotations.page_label, '')"
        conditions = [f"TRIM({quote}) <> ''"]
        parameters: dict[str, object] = {"limit": limit, "offset": offset}
        if requested_status != "ALL":
            conditions.append(f"({review_state}) = :status")
            parameters["status"] = requested_status
        if query:
            parameters["query"] = _like_pattern(query)
            conditions.append(
                "(" + " OR ".join(
                    f"{field} LIKE :query ESCAPE '\\'"
                    for field in (quote, comment, title, authors, page_label)
                ) + ")"
            )
        if isbn:
            conditions.append("books.isbn13 = :isbn")
            parameters["isbn"] = isbn
        if book:
            conditions.append(f"{title} LIKE :book ESCAPE '\\'")
            parameters["book"] = _like_pattern(book)

        from_sql = (
            "FROM annotations "
            "JOIN pages ON pages.id = annotations.page_id "
            "JOIN books ON books.id = pages.book_id "
            "WHERE " + " AND ".join(conditions)
        )
        if query:
            order_sql = (
                f"CASE WHEN {quote} LIKE :query ESCAPE '\\' THEN 0 "
                f"WHEN {comment} LIKE :query ESCAPE '\\' THEN 1 "
                f"WHEN ({title} LIKE :query ESCAPE '\\' OR {authors} LIKE :query ESCAPE '\\') THEN 2 "
                f"WHEN {page_label} LIKE :query ESCAPE '\\' THEN 3 ELSE 4 END, "
                "COALESCE(annotations.reviewed_at_ms, 0) DESC, annotations.updated_at DESC, annotations.id"
            )
        else:
            order_sql = (
                "COALESCE(annotations.reviewed_at_ms, 0) DESC, annotations.updated_at DESC, annotations.id"
            )
        with self.connect() as db:
            total = int(db.execute(f"SELECT COUNT(*) {from_sql}", parameters).fetchone()[0])
            rows = db.execute(
                f"""SELECT annotations.id AS annotation_id,
                              annotations.source_capture_id AS capture_id,
                              pages.id AS page_id,
                              pages.source_page_id AS source_page_id,
                              books.isbn13 AS isbn13,
                              books.title AS title,
                              books.authors_json AS authors_json,
                              annotations.highlight_quote AS quote,
                              annotations.page_label AS page_label,
                              annotations.comment AS comment,
                              {review_state} AS review_state,
                              annotations.reviewed_at_ms AS reviewed_at_ms
                       {from_sql}
                       ORDER BY {order_sql}
                       LIMIT :limit OFFSET :offset""",
                parameters,
            ).fetchall()

        results: list[dict[str, Any]] = []
        for row in rows:
            try:
                parsed_authors = json.loads(row["authors_json"] or "[]")
            except (TypeError, json.JSONDecodeError):
                parsed_authors = []
            authors_list = [item for item in parsed_authors if isinstance(item, str)] if isinstance(parsed_authors, list) else []
            results.append(
                {
                    "annotationId": row["annotation_id"],
                    "captureId": row["capture_id"],
                    "pageId": row["page_id"],
                    "sourcePageId": row["source_page_id"],
                    "isbn13": row["isbn13"],
                    "title": row["title"],
                    "authors": authors_list,
                    "quote": row["quote"],
                    "pageLabel": row["page_label"],
                    "comment": row["comment"],
                    "reviewState": row["review_state"],
                    "reviewedAtMs": row["reviewed_at_ms"],
                }
            )
        return results, total

    def publication_rows(self, isbn13: str) -> tuple[dict[str, Any], list[dict[str, Any]]] | None:
        with self.connect() as db:
            book = db.execute(
                "SELECT * FROM books WHERE isbn13=? ORDER BY rowid DESC LIMIT 1", (isbn13,)
            ).fetchone()
            if book is None:
                return None
            rows = db.execute(
                """SELECT annotations.*, pages.source_page_id
                   FROM annotations JOIN pages ON pages.id=annotations.page_id
                   WHERE pages.book_id=? AND pages.status='APPROVED'
                   ORDER BY annotations.reviewed_at_ms, annotations.id""",
                (book["id"],),
            ).fetchall()
        return dict(book), [dict(row) for row in rows]
