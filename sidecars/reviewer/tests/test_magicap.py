from __future__ import annotations

import io
import json
import sqlite3
import stat
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from marginalia_reviewer.app import create_app
from marginalia_reviewer.config import Settings
from marginalia_reviewer.db import Workspace
from marginalia_reviewer.importer import BundleValidationError, ImportLimits, MagicapImporter
from marginalia_reviewer.ocr import NdlocrLiteAdapter, normalized_region_to_pixel_box
from marginalia_reviewer.ui import INDEX_HTML
import marginalia_reviewer.app as app_module

ISBN = "9780306406157"
PACKAGE_ID = "capkg:01ARZ3NDEKTSV4RRFFQ69G5FAV"
PAGE_ID = "page-1"


def jpeg_fixture() -> bytes:
    output = io.BytesIO()
    Image.new("RGB", (100, 200), "white").save(output, format="JPEG")
    return output.getvalue()


def capture(capture_id: str, *, page_id: str = PAGE_ID, path: str | None = None, region: dict[str, object] | None = None) -> dict[str, object]:
    return {
        "id": capture_id,
        "ocrStatus": "pending",
        # The miniapp book id is intentionally opaque and not necessarily ISBN.
        "bookId": "source-book-id",
        "pageImage": {"id": page_id, "path": path or f"images/{page_id}.jpg", "mediaType": "image/jpeg", "width": 100, "height": 200},
        "selectedRegion": region or {"left": .1, "top": .2, "right": .8, "bottom": .4},
        "pageNumber": 12,
        "comment": "phone note",
        "createdAt": "2026-08-27T00:00:00.000Z",
    }


def magicap_manifest(count: int) -> dict[str, object]:
    return {"format": "maginalia-capture-package", "version": 1, "packageId": PACKAGE_ID, "createdAt": "2026-08-27T00:00:00.000Z", "book": {"isbn13": ISBN}, "captureCount": count}


def make_magicap(path: Path, captures: list[dict[str, object]] | None = None, image: bytes | None = None, manifest: dict[str, object] | None = None, extra: dict[str, bytes] | None = None) -> None:
    captures = captures or [capture("capture-1")]
    image = image or jpeg_fixture()
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(manifest or magicap_manifest(len(captures))))
        for item in captures:
            archive.writestr(f"captures/{item['id']}.json", json.dumps(item))
        for page in {str(item["pageImage"]["path"]) for item in captures}:  # type: ignore[index]
            archive.writestr(page, image)
        for name, value in (extra or {}).items():
            archive.writestr(name, value)


def importer(tmp_path: Path) -> tuple[Workspace, MagicapImporter]:
    workspace = Workspace(tmp_path / "reviewer.sqlite3")
    workspace.initialize()
    return workspace, MagicapImporter(workspace, tmp_path / "imports", ImportLimits(10_000_000, 10_000_000, 30))


def test_imports_shared_image_once_and_keeps_capture_rectangles(tmp_path: Path) -> None:
    workspace, service = importer(tmp_path)
    bundle = tmp_path / "book.magicap"
    make_magicap(bundle, [capture("capture-1"), capture("capture-2", region={"left": .2, "top": .5, "right": .7, "bottom": .8})])
    service.import_magicap(bundle, bundle.name)
    pages = workspace.list_pages()
    assert len(pages) == 1
    page = workspace.get_page(str(pages[0]["id"]))
    assert page is not None
    assert len(page["annotations"]) == 2
    assert {row["source_capture_id"] for row in page["annotations"]} == {"capture-1", "capture-2"}
    assert {row["source_book_id"] for row in page["annotations"]} == {"source-book-id"}
    assert page["annotations"][0]["selected_region"] is not None
    assert page["annotations"][0]["geometry"] == []
    assert page["image_media_type"] == "image/jpeg"


def test_accepts_magicap_zip_alias_but_not_arbitrary_zip(tmp_path: Path) -> None:
    _, service = importer(tmp_path)
    alias = tmp_path / "book.magicap.zip"
    make_magicap(alias)
    service.import_magicap(alias, alias.name)
    generic = tmp_path / "book.zip"
    make_magicap(generic)
    with pytest.raises(BundleValidationError, match=".magicap"):
        service.import_magicap(generic, generic.name)


@pytest.mark.parametrize("mutate, message", [
    (lambda manifest, captures: manifest.__setitem__("format", "wrong"), "format"),
    (lambda manifest, captures: manifest.__setitem__("version", 2), "format"),
    (lambda manifest, captures: manifest.__setitem__("packageId", "capkg:invalid"), "packageId"),
    (lambda manifest, captures: manifest["book"].__setitem__("isbn13", "9780306406158"), "ISBN"),  # type: ignore[index]
    (lambda manifest, captures: manifest.__setitem__("captureCount", 2), "captureCount"),
    (lambda manifest, captures: captures[0].__setitem__("selectedRegion", {"left": 0, "top": 0, "right": 0, "bottom": 1}), "selectedRegion"),
])
def test_rejects_bad_contract_without_partial_import(tmp_path: Path, mutate, message: str) -> None:  # type: ignore[no-untyped-def]
    workspace, service = importer(tmp_path)
    data = magicap_manifest(1); captures = [capture("capture-1")]
    mutate(data, captures)
    bundle = tmp_path / "bad.magicap"; make_magicap(bundle, captures, manifest=data)
    with pytest.raises(BundleValidationError, match=message):
        service.import_magicap(bundle, bundle.name)
    assert workspace.list_pages() == []
    assert not (tmp_path / "imports").exists() or list((tmp_path / "imports").iterdir()) == []


def test_rejects_missing_image_dimensions_and_unsafe_members(tmp_path: Path) -> None:
    _, service = importer(tmp_path)
    missing = tmp_path / "missing.magicap"
    with zipfile.ZipFile(missing, "w") as archive:
        archive.writestr("manifest.json", json.dumps(magicap_manifest(1))); archive.writestr("captures/capture-1.json", json.dumps(capture("capture-1")))
    with pytest.raises(BundleValidationError, match="missing or unsafe image"):
        service.import_magicap(missing, missing.name)
    dimensions = tmp_path / "dimensions.magicap"; bad = capture("capture-1"); bad["pageImage"]["width"] = 101  # type: ignore[index]
    make_magicap(dimensions, [bad])
    with pytest.raises(BundleValidationError, match="dimensions"):
        service.import_magicap(dimensions, dimensions.name)
    traversal = tmp_path / "traversal.magicap"; make_magicap(traversal, extra={"../escape": b"x"})
    with pytest.raises(BundleValidationError, match="unsafe"):
        service.import_magicap(traversal, traversal.name)


def test_rejects_conflicting_shared_page_image_id(tmp_path: Path) -> None:
    _, service = importer(tmp_path)
    first = capture("capture-1", page_id="page-1")
    second = capture("capture-2", page_id="page-1", path="images/page-1.jpeg")
    bundle = tmp_path / "conflicting-page-id.magicap"
    make_magicap(bundle, [first, second])
    with pytest.raises(BundleValidationError, match="conflicting metadata for shared page image id"):
        service.import_magicap(bundle, bundle.name)


def test_rejects_symlink_and_compression_bomb(tmp_path: Path) -> None:
    _, service = importer(tmp_path)
    symlink = tmp_path / "symlink.magicap"; make_magicap(symlink)
    with zipfile.ZipFile(symlink, "a") as archive:
        info = zipfile.ZipInfo("images/link.jpg"); info.create_system = 3; info.external_attr = (stat.S_IFLNK | 0o777) << 16; archive.writestr(info, b"x")
    with pytest.raises(BundleValidationError, match="symbolic"):
        service.import_magicap(symlink, symlink.name)
    bomb = tmp_path / "bomb.magicap"; make_magicap(bomb, extra={"notes.txt": b"0" * 1_000_000})
    with pytest.raises(BundleValidationError, match="compression ratio"):
        service.import_magicap(bomb, bomb.name)


def test_rectangle_candidate_and_manual_review_without_ocr(tmp_path: Path) -> None:
    workspace, service = importer(tmp_path)
    bundle = tmp_path / "review.magicap"; make_magicap(bundle)
    service.import_magicap(bundle, bundle.name)
    page_id = str(workspace.list_pages()[0]["id"])
    page = workspace.get_page(page_id); assert page is not None
    annotation = page["annotations"][0]
    assert annotation["candidates"]["quote"] == ""
    assert workspace.update_annotation(str(annotation["id"]), {"highlight_quote": "手入力引用", "sentence_before": "", "sentence_after": "", "page_label": "12", "chapter_label": "", "comment": "corrected"})
    assert workspace.approve_capture(str(annotation["id"]), 5)
    restored = Workspace(tmp_path / "reviewer.sqlite3").get_page(page_id)
    assert restored is not None and restored["annotations"][0]["review_state"] == "APPROVED"


def test_normalized_selected_region_uses_canonical_crop_bounds_at_edges() -> None:
    assert normalized_region_to_pixel_box({"left": 0, "top": 0, "right": .1, "bottom": .1}, 100, 200) == (0, 0, 10, 20)
    assert normalized_region_to_pixel_box({"left": .201, "top": .251, "right": .799, "bottom": .749}, 100, 200) == (20, 50, 80, 150)
    assert normalized_region_to_pixel_box({"left": .9, "top": .9, "right": 1, "bottom": 1}, 100, 200) == (90, 180, 100, 200)


def test_capture_review_exposes_page_ocr_and_reprocess_action() -> None:
    assert "Page OCR（全ページ）" in INDEX_HTML
    assert "選択範囲を再認識" in INDEX_HTML
    assert "選択範囲 OCR 候補" in INDEX_HTML
    assert "OCR 読み順" in INDEX_HTML
    assert "/ocr-orientation" in INDEX_HTML


def test_selected_region_ocr_receives_a_jpeg_crop(tmp_path: Path) -> None:
    canonical = tmp_path / "canonical.jpg"
    canonical.write_bytes(jpeg_fixture())
    adapter = object.__new__(NdlocrLiteAdapter)
    seen: dict[str, object] = {}

    def recognize(image_path: Path, width: int, height: int, page_id: str):  # type: ignore[no-untyped-def]
        with Image.open(image_path) as crop:
            seen["format"] = crop.format
            seen["size"] = crop.size
        seen["expected"] = (width, height, page_id)
        return [], {"engine": "test"}

    adapter.recognize = recognize  # type: ignore[method-assign]
    evidence = adapter.recognize_selected_region(
        canonical, 100, 200, "page", "capture", {"left": .2, "top": .25, "right": .8, "bottom": .75}
    )
    assert seen == {"format": "JPEG", "size": (60, 100), "expected": (60, 100, "page:capture:capture")}
    assert evidence["pixelBounds"] == {"left": 20, "top": 50, "right": 80, "bottom": 150}


def test_capture_quote_uses_crop_ocr_while_page_ocr_stays_complete(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    selected = {"left": .2, "top": .25, "right": .8, "bottom": .75}
    bundle = tmp_path / "candidate.magicap"
    make_magicap(bundle, [capture("capture-1", region=selected)])
    config = tmp_path / "ocr.json"; config.write_text("{}", encoding="utf-8")
    calls: list[tuple[int, int, str]] = []

    class Adapter:
        def __init__(self, config_path: Path, timeout: int) -> None:
            pass

        def recognize(self, image_path: Path, width: int, height: int, page_id: str):  # type: ignore[no-untyped-def]
            calls.append((width, height, page_id))
            if ":capture:" not in page_id:
                return [
                    {"id": "full-right", "left": .80, "top": 0, "right": 1, "bottom": 1, "kind": "COLUMN", "text": "頁外右列"},
                    {"id": "full-middle", "left": .45, "top": 0, "right": .65, "bottom": 1, "kind": "COLUMN", "text": "頁全体中央列"},
                    {"id": "full-left", "left": 0, "top": 0, "right": .25, "bottom": 1, "kind": "COLUMN", "text": "頁外左列"},
                ], {"engine": "test", "raw": "complete page"}
            return [
                {"id": "crop-left", "left": .05, "top": 0, "right": .25, "bottom": 1, "kind": "COLUMN", "text": "選択左"},
                {"id": "crop-right", "left": .70, "top": 0, "right": .90, "bottom": 1, "kind": "COLUMN", "text": "選択右"},
            ], {"engine": "test", "raw": "selected crop"}

        def recognize_selected_region(self, image_path: Path, width: int, height: int, page_id: str, capture_id: str, region: dict[str, object]):  # type: ignore[no-untyped-def]
            left, top, right, bottom = normalized_region_to_pixel_box(region, width, height)
            regions, provenance = self.recognize(image_path, right - left, bottom - top, f"{page_id}:capture:{capture_id}")
            return {"regions": regions, "provenance": provenance, "pixelBounds": {"left": left, "top": top, "right": right, "bottom": bottom}}

    monkeypatch.setattr(app_module, "NdlocrLiteAdapter", Adapter)
    app = create_app(Settings(workspace=tmp_path / "workspace", ndlocr_config=config))
    client = TestClient(app, base_url="http://127.0.0.1")
    headers = {"X-CSRF-Token": client.get("/api/session").json()["csrfToken"]}
    with bundle.open("rb") as source:
        assert client.post("/api/import", headers=headers, files={"bundle": (bundle.name, source)}).status_code == 201
    page_id = client.get("/api/pages").json()[0]["id"]
    assert client.post(f"/api/pages/{page_id}/ocr", headers=headers).status_code == 200
    page = client.get(f"/api/pages/{page_id}").json()
    assert calls == [(100, 200, page_id), (60, 100, f"{page_id}:capture:{page['annotations'][0]['id']}")]
    assert page["page_ocr_transcription"] == "頁外右列頁全体中央列頁外左列"
    assert page["page_ocr_orientation"] == "VERTICAL"
    assert page["annotations"][0]["candidates"]["quote"] == "選択右選択左"
    assert page["annotations"][0]["capture_ocr_orientation"] == "VERTICAL"
    assert "頁外" not in page["annotations"][0]["candidates"]["quote"]
    assert page["annotations"][0]["capture_ocr"]["pixelBounds"] == {"left": 20, "top": 50, "right": 80, "bottom": 150}


def test_capture_orientation_override_is_stored_and_replaces_auto_detection(tmp_path: Path) -> None:
    workspace, service = importer(tmp_path)
    bundle = tmp_path / "orientation.magicap"; make_magicap(bundle)
    service.import_magicap(bundle, bundle.name)
    page_id = str(workspace.list_pages()[0]["id"])
    assert workspace.transition(page_id, {"PENDING"}, "RUNNING")
    regions = [
        {"id": "column", "left": .8, "top": 0, "right": .9, "bottom": 1, "kind": "LINE", "text": "右"},
        {"id": "column2", "left": .1, "top": 0, "right": .2, "bottom": 1, "kind": "LINE", "text": "左"},
    ]
    workspace.save_ocr(page_id, regions, {"engine": "test"})
    assert workspace.get_page(page_id)["page_ocr_orientation"] == "VERTICAL"  # type: ignore[index]
    assert workspace.update_ocr_orientation_override(page_id, "HORIZONTAL")
    page = workspace.get_page(page_id)
    assert page is not None
    assert page["ocr_orientation_override"] == "HORIZONTAL"
    assert page["page_ocr_orientation"] == "HORIZONTAL"
    assert page["page_ocr_transcription"] == "左右"


def test_api_imports_magicap_and_approves_a_capture(tmp_path: Path) -> None:
    bundle = tmp_path / "book.magicap"; make_magicap(bundle)
    app = create_app(Settings(workspace=tmp_path / "workspace"))
    client = TestClient(app, base_url="http://127.0.0.1")
    headers = {"X-CSRF-Token": client.get("/api/session").json()["csrfToken"]}
    with bundle.open("rb") as source:
        response = client.post("/api/import", headers=headers, files={"bundle": (bundle.name, source, "application/zip")})
    assert response.status_code == 201, response.text
    page = client.get("/api/pages").json()[0]
    detail = client.get(f"/api/pages/{page['id']}").json()
    annotation = detail["annotations"][0]
    assert annotation["selected_region"] == {"left": .1, "top": .2, "right": .8, "bottom": .4}
    assert client.get(f"/api/pages/{page['id']}/image").headers["content-type"].startswith("image/jpeg")
    review = {"quote": "human text", "pageLabel": "12", "comment": "reviewed"}
    assert client.put(f"/api/annotations/{annotation['id']}", headers=headers, json=review).status_code == 200
    assert client.post(f"/api/captures/{annotation['id']}/approve", headers=headers).status_code == 200
    assert client.get(f"/api/pages/{page['id']}").json()["status"] == "APPROVED"


def test_additive_migration_keeps_legacy_annotation(tmp_path: Path) -> None:
    path = tmp_path / "legacy.sqlite3"
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE annotations (id TEXT PRIMARY KEY, page_id TEXT NOT NULL, source_annotation_id TEXT, geometry_json TEXT NOT NULL DEFAULT '[]', highlight_quote TEXT NOT NULL DEFAULT '', sentence_before TEXT NOT NULL DEFAULT '', sentence_after TEXT NOT NULL DEFAULT '', page_label TEXT NOT NULL DEFAULT '', chapter_label TEXT NOT NULL DEFAULT '', comment TEXT NOT NULL DEFAULT '', created_at TEXT, updated_at TEXT NOT NULL)")
        db.execute("INSERT INTO annotations VALUES('legacy','page','source','[]','q','','','1','chapter','comment',NULL,'then')")
    Workspace(path).initialize()
    with sqlite3.connect(path) as db:
        row = db.execute("SELECT highlight_quote, source_capture_id, source_book_id, selected_region_json, phone_comment, review_state FROM annotations WHERE id='legacy'").fetchone()
    assert row == ("q", None, None, None, "", "PENDING")
