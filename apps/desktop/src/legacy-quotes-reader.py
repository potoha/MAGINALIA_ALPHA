#!/usr/bin/env python3
"""Read the fixed legacy Reviewer quote schema without modifying its source.

This is intentionally a narrow H.6R4 bootstrap input adapter, not a general
legacy import framework.  It copies the SQLite database and any live WAL/SHM
companions to a private temporary directory before opening that copy read-only.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path


def _records(source: Path) -> list[dict[str, str]]:
    database = source / "reviewer.sqlite3"
    if not database.is_file():
        raise ValueError("legacy_quotes must contain reviewer.sqlite3")

    with tempfile.TemporaryDirectory(prefix="maginalia-h6r4-") as temporary:
        copy_root = Path(temporary)
        copy_database = copy_root / database.name
        # A SQLite WAL is part of the durable read snapshot.  Copy all three
        # files before opening the copy so the source directory stays untouched.
        for suffix in ("", "-wal", "-shm"):
            candidate = Path(f"{database}{suffix}")
            if candidate.is_file():
                shutil.copy2(candidate, copy_root / candidate.name)

        connection = sqlite3.connect(
            f"file:{copy_database.as_posix()}?mode=ro",
            uri=True,
        )
        try:
            connection.execute("PRAGMA query_only = ON")
            rows = connection.execute(
                """
                SELECT annotations.id AS annotation_id,
                       books.isbn13 AS isbn13,
                       annotations.highlight_quote AS quote,
                       annotations.page_label AS page_label,
                       annotations.comment AS comment,
                       CASE WHEN annotations.selected_region_json IS NOT NULL
                            THEN annotations.review_state ELSE pages.status END AS review_state
                  FROM annotations
                  JOIN pages ON pages.id = annotations.page_id
                  JOIN books ON books.id = pages.book_id
                 WHERE TRIM(COALESCE(annotations.highlight_quote, '')) <> ''
                   AND (CASE WHEN annotations.selected_region_json IS NOT NULL
                             THEN annotations.review_state ELSE pages.status END) = 'APPROVED'
                 ORDER BY annotations.id
                """
            ).fetchall()
        finally:
            connection.close()

    return [
        {
            "annotationId": str(row[0] or ""),
            "reviewState": "APPROVED",
            "isbn13": str(row[1] or ""),
            "quote": str(row[2] or ""),
            "pageLabel": str(row[3] or ""),
            "comment": str(row[4] or ""),
        }
        for row in rows
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description="Read legacy Reviewer approved quotes for H.6R4.")
    parser.add_argument("--source", required=True, help="Read-only legacy_quotes directory")
    arguments = parser.parse_args()
    try:
        source = Path(arguments.source).resolve(strict=True)
        if not source.is_dir():
            raise ValueError("legacy source must be a directory")
        print(json.dumps({"records": _records(source)}, ensure_ascii=False))
        return 0
    except (OSError, ValueError, sqlite3.Error) as error:
        print(f"H.6R4 legacy quote read failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
