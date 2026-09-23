from __future__ import annotations

import io
import json
import sqlite3
import zipfile
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

from marginalia_reviewer.app import create_app
from marginalia_reviewer.config import Settings
from marginalia_reviewer.db import Workspace
from marginalia_reviewer.importer import ImportLimits, MagicapImporter


ISBN = "9780306406157"


def jpeg_fixture() -> bytes:
    output = io.BytesIO()
    Image.new("RGB", (100, 200), "white").save(output, format="JPEG")
    return output.getvalue()


JPEG = jpeg_fixture()


def capture(capture_id: str, page_id: str, page_number: int, comment: str = "") -> dict[str, object]:
    return {
        "id": capture_id,
        "ocrStatus": "pending",
        "bookId": "source-book-id",
        "pageImage": {
            "id": page_id,
            "path": f"images/{page_id}.jpg",
            "mediaType": "image/jpeg",
            "width": 100,
            "height": 200,
        },
        "selectedRegion": {"left": 0.1, "top": 0.2, "right": 0.8, "bottom": 0.4},
        "pageNumber": page_number,
        "comment": comment,
        "createdAt": "2026-08-27T00:00:00.000Z",
    }


def make_magicap(path: Path, captures: list[dict[str, object]]) -> None:
    manifest = {
        "format": "maginalia-capture-package",
        "version": 1,
        "packageId": "capkg:01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "createdAt": "2026-08-27T00:00:00.000Z",
        "book": {"isbn13": ISBN},
        "captureCount": len(captures),
    }
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(manifest))
        for item in captures:
            archive.writestr(f"captures/{item['id']}.json", json.dumps(item))
        for page_id in {str(item["pageImage"]["id"]) for item in captures}:  # type: ignore[index]
            archive.writestr(f"images/{page_id}.jpg", JPEG)


def seeded_workspace(tmp_path: Path) -> tuple[Workspace, dict[str, dict[str, str]]]:
    workspace = Workspace(tmp_path / "reviewer.sqlite3")
    workspace.initialize()
    captures = [
        capture("capture-approved-old", "page-old", 12, "レビューコメント"),
        capture("capture-approved-new", "page-new", 34, "新しいコメント"),
        capture("capture-pending", "page-pending", 56, "保留コメント"),
        capture("capture-raw-only", "page-raw", 78),
    ]
    bundle = tmp_path / "search.magicap"
    make_magicap(bundle, captures)
    MagicapImporter(workspace, tmp_path / "imports", ImportLimits(10_000_000, 10_000_000, 30)).import_magicap(
        bundle, bundle.name
    )
    with workspace.connect() as db:
        db.execute(
            "UPDATE books SET title=?, authors_json=? WHERE isbn13=?",
            ("検索の本", json.dumps(["山田太郎", "Jane Doe"], ensure_ascii=False), ISBN),
        )

    records: dict[str, dict[str, str]] = {}
    for page in workspace.list_pages():
        detail = workspace.get_page(str(page["id"]))
        assert detail is not None
        annotation = detail["annotations"][0]
        records[str(annotation["source_capture_id"])] = {
            "page_id": str(page["id"]),
            "annotation_id": str(annotation["id"]),
        }

    old = records["capture-approved-old"]
    new = records["capture-approved-new"]
    pending = records["capture-pending"]
    raw = records["capture-raw-only"]
    assert workspace.update_annotation(
        old["annotation_id"],
        {
            "highlight_quote": "これは日本語の引用です。",
            "sentence_before": "",
            "sentence_after": "",
            "page_label": "12",
            "chapter_label": "",
            "comment": "レビューコメント",
        },
    )
    assert workspace.approve_capture(old["annotation_id"], 10)
    assert workspace.update_annotation(
        new["annotation_id"],
        {
            "highlight_quote": "新しい承認引用",
            "sentence_before": "",
            "sentence_after": "",
            "page_label": "34",
            "chapter_label": "",
            "comment": "新しいコメント",
        },
    )
    assert workspace.approve_capture(new["annotation_id"], 20)
    assert workspace.update_annotation(
        pending["annotation_id"],
        {
            "highlight_quote": "保留の引用",
            "sentence_before": "",
            "sentence_after": "",
            "page_label": "56",
            "chapter_label": "",
            "comment": "保留コメント",
        },
    )
    assert workspace.transition(raw["page_id"], {"PENDING"}, "RUNNING")
    workspace.save_ocr(
        raw["page_id"],
        [{"id": "ndl:raw", "left": 0.1, "top": 0.2, "right": 0.8, "bottom": 0.4, "kind": "LINE", "text": "RAW_OCR_ONLY"}],
        {"engine": "test", "raw": "RAW_OCR_ONLY"},
    )
    return workspace, records


def reviewer_client(tmp_path: Path) -> tuple[Workspace, TestClient, dict[str, dict[str, str]]]:
    workspace, records = seeded_workspace(tmp_path)
    return workspace, TestClient(create_app(Settings(workspace=tmp_path)), base_url="http://127.0.0.1"), records


def test_search_fields_and_literal_japanese_substring(tmp_path: Path) -> None:
    workspace, records = seeded_workspace(tmp_path)

    for query in ("日本語", "レビューコメント", "12"):
        results, total = workspace.search_quotes(query=query)
        assert total == 1
        assert results[0]["annotationId"] == records["capture-approved-old"]["annotation_id"]
    author_results, author_total = workspace.search_quotes(query="山田太郎")
    assert author_total == 2
    assert {item["title"] for item in author_results} == {"検索の本"}
    title_results, title_total = workspace.search_quotes(query="検索の本")
    assert title_total == 2
    assert {item["title"] for item in title_results} == {"検索の本"}
    results, _ = workspace.search_quotes(isbn=ISBN)
    assert {item["quote"] for item in results} == {"これは日本語の引用です。", "新しい承認引用"}
    results, _ = workspace.search_quotes(book="検索")
    assert len(results) == 2


def test_pending_and_raw_ocr_are_excluded_by_default_but_explicit_status_works(tmp_path: Path) -> None:
    workspace, _ = seeded_workspace(tmp_path)

    assert workspace.search_quotes(query="保留")[0] == []
    pending, total = workspace.search_quotes(query="保留", status="NEEDS_REVIEW")
    assert total == 1 and pending[0]["reviewState"] == "NEEDS_REVIEW"
    assert workspace.search_quotes(query="RAW_OCR_ONLY")[0] == []
    assert workspace.search_quotes(status="ALL")[1] == 3


def test_empty_query_returns_recent_approved_quotes(tmp_path: Path) -> None:
    workspace, _ = seeded_workspace(tmp_path)
    results, total = workspace.search_quotes()
    assert total == 2
    assert [item["quote"] for item in results] == ["新しい承認引用", "これは日本語の引用です。"]
    assert results[0]["pageLabel"] == "34"


def test_corrected_approved_quote_becomes_searchable(tmp_path: Path) -> None:
    workspace, records = seeded_workspace(tmp_path)
    annotation_id = records["capture-approved-old"]["annotation_id"]
    fields = {
        "highlight_quote": "訂正後の引用",
        "sentence_before": "",
        "sentence_after": "",
        "page_label": "12",
        "chapter_label": "",
        "comment": "修正済み",
    }
    assert workspace.update_annotation(annotation_id, fields)
    assert workspace.search_quotes(query="訂正後の引用")[0] == []
    assert workspace.approve_capture(annotation_id, 30)
    results, _ = workspace.search_quotes(query="訂正後")
    assert results[0]["quote"] == "訂正後の引用"
    assert results[0]["reviewedAtMs"] == 30


def test_search_result_opens_correct_page_and_annotation_and_is_read_only(tmp_path: Path) -> None:
    workspace, client, records = reviewer_client(tmp_path)
    before = workspace.get_page(records["capture-approved-old"]["page_id"])
    response = client.get("/api/search", params={"q": "日本語"})
    assert response.status_code == 200
    result = response.json()["results"][0]
    assert result["captureId"] == "capture-approved-old"
    assert result["pageId"] == records["capture-approved-old"]["page_id"]
    assert result["annotationId"] == records["capture-approved-old"]["annotation_id"]
    assert result["pageLabel"] == "12"
    assert "ocr" not in json.dumps(result).casefold()
    opened = client.get(f"/api/pages/{result['pageId']}")
    assert opened.status_code == 200
    assert any(annotation["id"] == result["annotationId"] for annotation in opened.json()["annotations"])
    after = workspace.get_page(records["capture-approved-old"]["page_id"])
    assert after == before


def test_search_endpoint_filters_paginates_and_validates_inputs(tmp_path: Path) -> None:
    _, client, _ = reviewer_client(tmp_path)
    assert client.get("/api/search", params={"limit": 1}).json()["total"] == 2
    page = client.get("/api/search", params={"limit": 1, "offset": 1}).json()
    assert page["limit"] == 1 and page["offset"] == 1 and len(page["results"]) == 1
    assert client.get("/api/search", params={"limit": 0}).status_code == 422
    assert client.get("/api/search", params={"limit": 101}).status_code == 422
    assert client.get("/api/search", params={"offset": -1}).status_code == 422
    assert client.get("/api/search", params={"q": "x" * 501}).status_code == 422
    assert client.get("/api/search", params={"status": "not-a-state"}).status_code == 422


def test_search_ui_has_copy_and_open_review_actions(tmp_path: Path) -> None:
    client = TestClient(create_app(Settings(workspace=tmp_path)), base_url="http://127.0.0.1")
    html = client.get("/").text
    assert "/api/search?" in html
    assert "navigator.clipboard.writeText" in html
    assert "クリップボードを利用できないため、引用本文を選択しました" in html
    assert "data-copy" in html
    assert "data-open" in html


def test_search_migration_preserves_existing_data(tmp_path: Path) -> None:
    path = tmp_path / "legacy.sqlite3"
    with sqlite3.connect(path) as db:
        db.executescript(
            """
            CREATE TABLE imports (id TEXT PRIMARY KEY, source_name TEXT NOT NULL, root_path TEXT NOT NULL, manifest_json TEXT NOT NULL, imported_at TEXT NOT NULL);
            CREATE TABLE books (id TEXT PRIMARY KEY, import_id TEXT NOT NULL, isbn13 TEXT, title TEXT, authors_json TEXT NOT NULL DEFAULT '[]', orientation TEXT, source_json TEXT NOT NULL);
            CREATE TABLE pages (id TEXT PRIMARY KEY, book_id TEXT NOT NULL, source_page_id TEXT, image_path TEXT NOT NULL, width INTEGER, height INTEGER, captured_at TEXT, status TEXT NOT NULL, mobile_ocr_regions_json TEXT NOT NULL DEFAULT '[]', ocr_regions_json TEXT NOT NULL DEFAULT '[]', ocr_provenance_json TEXT, error_summary TEXT, updated_at TEXT NOT NULL);
            CREATE TABLE annotations (id TEXT PRIMARY KEY, page_id TEXT NOT NULL, source_annotation_id TEXT, geometry_json TEXT NOT NULL DEFAULT '[]', highlight_quote TEXT NOT NULL DEFAULT '', sentence_before TEXT NOT NULL DEFAULT '', sentence_after TEXT NOT NULL DEFAULT '', page_label TEXT NOT NULL DEFAULT '', chapter_label TEXT NOT NULL DEFAULT '', comment TEXT NOT NULL DEFAULT '', created_at TEXT, updated_at TEXT NOT NULL);
            INSERT INTO imports VALUES ('import-1','legacy.zip','C:/legacy','{}','2026-08-27T00:00:00Z');
            INSERT INTO books VALUES ('book-1','import-1','9780306406157','移行された本','["移行著者"]','HORIZONTAL','{}');
            INSERT INTO pages VALUES ('page-1','book-1','source-page','C:/legacy/page.jpg',100,200,1,'APPROVED','[]','[]',NULL,NULL,'2026-08-27T00:00:00Z');
            INSERT INTO annotations VALUES ('annotation-1','page-1','source-ann','[]','移行済み引用','','','1','章','移行コメント',NULL,'2026-08-27T00:00:00Z');
            """
        )
    workspace = Workspace(path)
    workspace.initialize()
    results, total = workspace.search_quotes(query="移行")
    assert total == 1
    assert results[0]["quote"] == "移行済み引用"
    assert results[0]["authors"] == ["移行著者"]


def test_search_does_not_treat_like_wildcards_as_wildcards(tmp_path: Path) -> None:
    workspace, _ = seeded_workspace(tmp_path)
    assert workspace.search_quotes(query="%")[1] == 0
    assert workspace.search_quotes(query="_")[1] == 0
