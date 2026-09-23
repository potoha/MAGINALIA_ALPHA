from __future__ import annotations

import hashlib
import io
import json
import stat
import sys
import threading
import time
import zipfile
import urllib.error
import urllib.request
from copy import deepcopy
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from marginalia_reviewer.app import create_app
from marginalia_reviewer.config import Settings
from marginalia_reviewer.db import Workspace
from marginalia_reviewer.importer import BundleImporter, BundleValidationError, ImportLimits
from marginalia_reviewer.ocr import (
    NDLOCR_LITE_COMMIT,
    NDLOCR_LITE_WINDOWS_SHA256,
    NdlocrLiteAdapter,
    OcrConfigurationError,
)
from marginalia_reviewer.publisher import GitHubContentsClient, PublishConflict, RemoteContent, build_publication, publication_diff
import marginalia_reviewer.publisher as publisher_module
import marginalia_reviewer.app as app_module
import marginalia_reviewer.__main__ as reviewer_main

PAGE_ID = "c5dd9d85-00cb-48f1-ae7a-0aa95826db67"
ANNOTATION_ID = "f82d8f9b-e173-4ef4-8f44-509f2e68f7c6"


def jpeg_fixture(width: int = 100, height: int = 200) -> bytes:
    output = io.BytesIO()
    Image.new("RGB", (width, height), "white").save(output, format="JPEG")
    return output.getvalue()


JPEG_FIXTURE = jpeg_fixture()


def executable_sha256() -> str:
    return hashlib.sha256(Path(sys.executable).read_bytes()).hexdigest()


def test_cli_uses_bundled_ndlocr_config_when_not_explicitly_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MARGINALIA_NDLOCR_CONFIG", raising=False)
    monkeypatch.setattr(sys, "argv", ["marginalia-reviewer", "--no-browser"])
    observed: dict[str, object] = {}
    monkeypatch.setattr(reviewer_main, "create_app", lambda settings: observed.setdefault("settings", settings))
    monkeypatch.setattr(reviewer_main.uvicorn, "run", lambda *args, **kwargs: None)

    reviewer_main.main()

    settings = observed["settings"]
    assert isinstance(settings, Settings)
    assert settings.ndlocr_config == Path(reviewer_main.__file__).resolve().parents[2] / "ndlocr.json"


def manifest(image: bytes = JPEG_FIXTURE) -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "exportedAtMs": 1,
        "book": {
            "isbn13": "9784000000000",
            "orientation": "HORIZONTAL",
            "metadata": {
                "title": "Fixture",
                "subtitle": None,
                "authors": ["Author"],
                "publisher": "Press",
                "publishedDate": "2026",
                "description": None,
                "toc": "One",
                "coverUrl": None,
                "provenance": {"title": "openBD"},
            },
        },
        "pages": [
            {
                "id": PAGE_ID,
                "imagePath": f"pages/{PAGE_ID}.jpg",
                "width": 100,
                "height": 200,
                "capturedAtMs": 2,
                "imageSha256": hashlib.sha256(image).hexdigest(),
                "mobileOcr": {"state": "PENDING", "errorSummary": None, "attemptAtMs": None, "regions": []},
                "annotations": [
                    {
                        "id": ANNOTATION_ID,
                        "comment": "phone note",
                        "createdAtMs": 3,
                        "updatedAtMs": 4,
                        "strokePoints": [
                            {"order": 0, "x": 0.1, "y": 0.2},
                            {"order": 1, "x": 0.8, "y": 0.2},
                        ],
                    }
                ],
            }
        ],
    }


def make_zip(path: Path, data: dict[str, object] | None = None, image: bytes = JPEG_FIXTURE) -> None:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(data or manifest(image)))
        archive.writestr(f"pages/{PAGE_ID}.jpg", image)


def importer(tmp_path: Path) -> tuple[Workspace, BundleImporter]:
    workspace = Workspace(tmp_path / "reviewer.sqlite3")
    workspace.initialize()
    return workspace, BundleImporter(workspace, tmp_path / "imports", ImportLimits(10_000_000, 10_000_000, 20))


def test_import_validates_hash_and_persists_contract_fields(tmp_path: Path) -> None:
    workspace, service = importer(tmp_path)
    bundle = tmp_path / "book.zip"
    make_zip(bundle)
    service.import_zip(bundle)
    pages = workspace.list_pages()
    assert len(pages) == 1
    page = workspace.get_page(pages[0]["id"])
    assert page is not None
    assert page["source_page_id"] == PAGE_ID
    assert page["title"] == "Fixture"
    assert page["mobile_ocr_regions"] == []
    assert page["annotations"][0]["source_annotation_id"] == ANNOTATION_ID


def test_import_rejects_hash_traversal_and_symlink(tmp_path: Path) -> None:
    _, service = importer(tmp_path)
    wrong = tmp_path / "wrong.zip"
    make_zip(wrong, manifest(b"different"))
    with pytest.raises(BundleValidationError, match="SHA-256"):
        service.import_zip(wrong)

    traversal = tmp_path / "traversal.zip"
    make_zip(traversal)
    with zipfile.ZipFile(traversal, "a") as archive:
        archive.writestr("../escape", b"x")
    with pytest.raises(BundleValidationError, match="unsafe"):
        service.import_zip(traversal)

    symlink = tmp_path / "symlink.zip"
    make_zip(symlink)
    with zipfile.ZipFile(symlink, "a") as archive:
        info = zipfile.ZipInfo("pages/link.jpg")
        info.create_system = 3
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(info, PAGE_ID + ".jpg")
    with pytest.raises(BundleValidationError, match="symbolic"):
        service.import_zip(symlink)

    extra = tmp_path / "extra.zip"
    make_zip(extra)
    with zipfile.ZipFile(extra, "a") as archive:
        archive.writestr("notes.txt", b"not declared")
    with pytest.raises(BundleValidationError, match="undeclared files"):
        service.import_zip(extra)


def test_import_rejects_semantic_duplicates_checksum_and_ratio(tmp_path: Path) -> None:
    _, service = importer(tmp_path)
    invalid_isbn = manifest()
    invalid_isbn["book"]["isbn13"] = "9784000000007"  # type: ignore[index]
    path = tmp_path / "isbn.zip"
    make_zip(path, invalid_isbn)
    with pytest.raises(BundleValidationError, match="check digit"):
        service.import_zip(path)

    duplicate = manifest()
    duplicate["pages"].append(dict(duplicate["pages"][0]))  # type: ignore[union-attr,index]
    path = tmp_path / "duplicate.zip"
    make_zip(path, duplicate)
    with pytest.raises(BundleValidationError, match="duplicate page id"):
        service.import_zip(path)

    compressed = b"0" * 1_000_000
    path = tmp_path / "ratio.zip"
    make_zip(path, manifest(compressed), compressed)
    with pytest.raises(BundleValidationError, match="compression ratio"):
        service.import_zip(path)


def test_import_rejects_non_jpeg_and_wrong_dimensions(tmp_path: Path) -> None:
    _, service = importer(tmp_path)
    invalid = b"not a jpeg"
    path = tmp_path / "invalid-jpeg.zip"
    make_zip(path, manifest(invalid), invalid)
    with pytest.raises(BundleValidationError, match="invalid JPEG"):
        service.import_zip(path)

    dimensions = manifest()
    dimensions["pages"][0]["width"] = 101  # type: ignore[index]
    path = tmp_path / "dimensions.zip"
    make_zip(path, dimensions)
    with pytest.raises(BundleValidationError, match="dimensions do not match"):
        service.import_zip(path)


def test_review_and_image_free_publication(tmp_path: Path) -> None:
    workspace, service = importer(tmp_path)
    bundle = tmp_path / "book.zip"
    make_zip(bundle)
    service.import_zip(bundle)
    page_id = workspace.list_pages()[0]["id"]
    annotation_id = workspace.get_page(page_id)["annotations"][0]["id"]  # type: ignore[index]
    assert workspace.transition(page_id, {"PENDING"}, "RUNNING")
    workspace.save_ocr(page_id, [], {"engine": "test"})
    assert workspace.update_annotation(
        annotation_id,
        {
            "highlight_quote": "Quote",
            "sentence_before": "Before",
            "sentence_after": "After",
            "page_label": "12",
            "chapter_label": "Chapter",
            "comment": "Comment",
        },
    )
    assert workspace.approve_page(page_id, 10)
    payload = build_publication(workspace, "9784000000000")
    encoded = json.dumps(payload)
    assert payload["highlights"][0]["id"] == ANNOTATION_ID
    assert "image" not in encoded.casefold()
    assert set(payload) == {"schemaVersion", "revision", "updatedAtMs", "book", "highlights"}
    assert set(payload["book"]) == {
        "isbn13", "title", "subtitle", "authors", "publisher", "publishedDate", "toc", "coverUrl", "provenance",
    }
    assert set(payload["highlights"][0]) == {
        "id", "quote", "contextBefore", "contextAfter", "pageLabel", "chapterLabel", "comment", "reviewedAtMs",
    }
    assert not any(term in encoded for term in ("boundingBox", "geometry", "stroke", "ocr_provenance", "raw"))


def test_publication_diff_reports_book_and_field_changes_in_contract_order() -> None:
    before = {
        "book": {"title": "旧題", "authors": ["著者"], "publisher": "社"},
        "highlights": [{
            "id": ANNOTATION_ID, "quote": "旧引用", "contextBefore": "", "contextAfter": "",
            "pageLabel": "1", "chapterLabel": "一", "comment": "", "reviewedAtMs": 1,
        }],
    }
    after = {
        "book": {"title": "新題", "authors": ["著者"], "publisher": "新社"},
        "highlights": [{
            "id": ANNOTATION_ID, "quote": "新引用", "contextBefore": "前", "contextAfter": "後",
            "pageLabel": "2", "chapterLabel": "一", "comment": "注", "reviewedAtMs": 2,
        }, {
            "id": "a5b5e5c0-0bd1-48b9-9de2-1b4f4ce93d77", "quote": "追加", "contextBefore": "", "contextAfter": "",
            "pageLabel": "3", "chapterLabel": "二", "comment": "", "reviewedAtMs": 3,
        }],
    }
    diff = publication_diff(after, before)
    assert [item["field"] for item in diff["bookFields"]] == ["title", "publisher"]
    assert diff["summary"] == {
        "bookChanged": True,
        "bookChangedFields": 2,
        "addedHighlights": 1,
        "changedHighlights": 1,
        "removedHighlights": 0,
    }
    assert [item["field"] for item in diff["highlights"]["changed"][0]["fields"]] == [
        "quote", "contextBefore", "contextAfter", "pageLabel", "comment", "reviewedAtMs",
    ]


def test_publication_diff_remote_missing_marks_all_local_highlights_added() -> None:
    local = {"book": {"title": "題名"}, "highlights": [{"id": ANNOTATION_ID, "quote": "引用"}]}
    diff = publication_diff(local, None)
    assert diff["summary"]["addedHighlights"] == 1
    assert diff["summary"]["removedHighlights"] == 0


def test_publication_omits_non_public_description_provenance(tmp_path: Path) -> None:
    workspace, service = importer(tmp_path)
    data = manifest()
    metadata = data["book"]["metadata"]  # type: ignore[index]
    metadata["description"] = "Local-only synopsis"
    metadata["provenance"]["description"] = "googleBooks"
    bundle = tmp_path / "description.zip"
    make_zip(bundle, data)
    service.import_zip(bundle)
    page_id = workspace.list_pages()[0]["id"]
    annotation_id = workspace.get_page(page_id)["annotations"][0]["id"]  # type: ignore[index]
    assert workspace.transition(page_id, {"PENDING"}, "RUNNING")
    workspace.save_ocr(page_id, [], {"engine": "test"})
    assert workspace.update_annotation(
        annotation_id,
        {
            "highlight_quote": "Quote", "sentence_before": "", "sentence_after": "",
            "page_label": "1", "chapter_label": "不明", "comment": "",
        },
    )
    assert workspace.approve_page(page_id, 10)
    payload = build_publication(workspace, "9784000000000")
    assert "description" not in payload["book"]
    assert "description" not in payload["book"]["provenance"]


def test_annotation_free_page_can_be_approved_without_fake_highlight(tmp_path: Path) -> None:
    workspace, service = importer(tmp_path)
    data = manifest()
    data["pages"][0]["annotations"] = []  # type: ignore[index]
    bundle = tmp_path / "no-annotations.zip"
    make_zip(bundle, data)
    service.import_zip(bundle)
    page_id = workspace.list_pages()[0]["id"]
    assert workspace.get_page(page_id)["annotations"] == []  # type: ignore[index]
    assert workspace.transition(page_id, {"PENDING"}, "RUNNING")
    workspace.save_ocr(page_id, [], {"engine": "test"})
    assert workspace.approve_page(page_id, 10)
    assert build_publication(workspace, "9784000000000")["highlights"] == []


def test_sqlite_recovers_interrupted_ocr(tmp_path: Path) -> None:
    workspace, service = importer(tmp_path)
    bundle = tmp_path / "book.zip"
    make_zip(bundle)
    service.import_zip(bundle)
    page_id = workspace.list_pages()[0]["id"]
    assert workspace.transition(page_id, {"PENDING"}, "RUNNING")
    assert Workspace(tmp_path / "reviewer.sqlite3").recover_interrupted() == 1
    assert workspace.get_page(page_id)["status"] == "PENDING"  # type: ignore[index]


def test_app_host_origin_csrf_and_review_endpoint(tmp_path: Path) -> None:
    settings = Settings(workspace=tmp_path)
    app = create_app(settings)
    client = TestClient(app, base_url="http://127.0.0.1")
    assert client.get("/api/pages", headers={"host": "evil.example"}).status_code == 400
    assert client.post("/api/import").status_code == 403
    session = client.get("/api/session").json()
    headers = {"X-CSRF-Token": session["csrfToken"]}
    assert client.post("/api/import", headers={**headers, "Origin": "https://evil.example"}).status_code == 403
    bundle = tmp_path / "upload.zip"
    make_zip(bundle)
    with bundle.open("rb") as source:
        response = client.post("/api/import", headers=headers, files={"bundle": ("book.zip", source, "application/zip")})
    assert response.status_code == 201, response.text
    page = client.get("/api/pages").json()[0]
    detail = client.get(f"/api/pages/{page['id']}").json()
    annotation = detail["annotations"][0]
    review = {
        "quote": "Quote", "contextBefore": "Before", "contextAfter": "After",
        "pageLabel": "1", "chapterLabel": "I", "comment": "Note",
    }
    assert client.put(f"/api/annotations/{annotation['id']}", headers=headers, json=review).status_code == 200
    workspace = app.state.workspace
    assert workspace.transition(page["id"], {"PENDING"}, "RUNNING")
    workspace.save_ocr(page["id"], [], {"engine": "test"})
    regions = {"regions": [{"id": "ndl:manual", "left": .1, "top": .2, "right": .5, "bottom": .4, "kind": "LINE", "text": "x"}]}
    assert client.put(f"/api/pages/{page['id']}/regions", headers=headers, json=regions).status_code == 200


def test_ocr_pin_and_raw_provenance(tmp_path: Path) -> None:
    script = tmp_path / "fake_ocr.py"
    script.write_text(
        "import json,sys\njson.dump({'width':100,'height':200,'regions':[{'text':'ok','boundingBox':{'x':10,'y':20,'width':40,'height':60}}],'other':42},open(sys.argv[2],'w',encoding='utf-8'))\n",
        encoding="utf-8",
    )
    config = tmp_path / "ocr.json"
    config.write_text(json.dumps({"engine": "NDLOCR-Lite", "version": "1.2.3", "commit": NDLOCR_LITE_COMMIT, "distributionSha256": NDLOCR_LITE_WINDOWS_SHA256, "executableSha256": executable_sha256(), "command": [sys.executable, str(script), "{input}", "{output}"]}), encoding="utf-8")
    regions, provenance = NdlocrLiteAdapter(config).recognize(tmp_path / "image.jpg", 100, 200, PAGE_ID)
    assert regions[0]["left"] == pytest.approx(.1)
    assert regions[0]["bottom"] == pytest.approx(.4)
    assert provenance["version"] == "1.2.3"
    assert provenance["executableSha256"] == executable_sha256()
    assert provenance["raw"]["other"] == 42
    config.write_text(json.dumps({"engine": "NDLOCR-Lite", "version": "1.2.4", "commit": NDLOCR_LITE_COMMIT, "distributionSha256": NDLOCR_LITE_WINDOWS_SHA256, "command": ["x", "{input}", "{output}"]}), encoding="utf-8")
    with pytest.raises(OcrConfigurationError, match="1.2.3"):
        NdlocrLiteAdapter(config)


def test_ocr_accepts_official_123_json_and_output_directory(tmp_path: Path) -> None:
    script = tmp_path / "fake_official.py"
    script.write_text(
        "import json,sys,pathlib\n"
        "raw={'contents':[[{'text':'縦書き','boundingBox':[[10,20],[10,80],[50,20],[50,80]],'isVertical':'true'}]],'imginfo':{'img_width':100,'img_height':200}}\n"
        "json.dump(raw,open(pathlib.Path(sys.argv[2])/'image.json','w',encoding='utf-8'))\n",
        encoding="utf-8",
    )
    config = tmp_path / "official.json"
    config.write_text(
        json.dumps({
            "engine": "NDLOCR-Lite", "version": "1.2.3", "commit": NDLOCR_LITE_COMMIT,
            "distributionSha256": NDLOCR_LITE_WINDOWS_SHA256,
            "executableSha256": executable_sha256(),
            "command": [sys.executable, str(script), "{input}", "{outputDir}"],
        }),
        encoding="utf-8",
    )

    regions, _ = NdlocrLiteAdapter(config).recognize(tmp_path / "image.jpg", 100, 200, PAGE_ID)

    assert regions == [{
        "id": f"ndl:{PAGE_ID}:0", "left": .1, "top": .1, "right": .5, "bottom": .4,
        "kind": "LINE", "text": "縦書き",
    }]


def test_ocr_clips_small_official_detector_boundary_overshoot() -> None:
    region = NdlocrLiteAdapter._normalize_region(
        {"text": "edge", "boundingBox": [[10, 20], [10, 80], [102, 20], [102, 80]]},
        0,
        100,
        200,
    )
    assert region == {"id": "ndl:0", "left": .1, "top": .1, "right": 1.0, "bottom": .4, "kind": "LINE", "text": "edge"}
    with pytest.raises(RuntimeError, match="outside the canonical image"):
        NdlocrLiteAdapter._normalize_region(
            {"boundingBox": [[0, 0], [0, 10], [109, 0], [109, 10]]}, 0, 100, 200
        )


def test_ocr_rejects_executable_hash_mismatch(tmp_path: Path) -> None:
    config = tmp_path / "wrong-hash.json"
    config.write_text(json.dumps({
        "engine": "NDLOCR-Lite", "version": "1.2.3", "commit": NDLOCR_LITE_COMMIT,
        "distributionSha256": NDLOCR_LITE_WINDOWS_SHA256,
        "executableSha256": "0" * 64,
        "command": [sys.executable, "{input}", "{output}"],
    }), encoding="utf-8")
    with pytest.raises(OcrConfigurationError, match="executable SHA-256"):
        NdlocrLiteAdapter(config)


def test_publication_size_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(publisher_module, "MAX_PUBLICATION_BYTES", 10)
    with pytest.raises(ValueError, match="10 MiB"):
        publisher_module.publication_json_bytes({"large": "payload"})


def test_github_update_requires_matching_blob_sha() -> None:
    class FakeClient(GitHubContentsClient):
        def get(self, owner: str, repo: str, path: str, branch: str) -> RemoteContent | None:
            return RemoteContent("current-sha", b"{}")

    client = FakeClient("token")
    with pytest.raises(PublishConflict, match="remote blob changed"):
        client.put_json("owner", "repo", "book.json", "main", {"book": {"isbn13": "x"}}, "stale-sha")


def test_github_commit_message_and_api_conflict(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    class CapturingClient(GitHubContentsClient):
        def get(self, owner: str, repo: str, path: str, branch: str) -> RemoteContent | None:
            return None

        def _request(self, request):  # type: ignore[no-untyped-def]
            captured.update(json.loads(request.data))
            return 200, {"content": {"sha": "new-sha"}}

    payload = {"revision": "18f40001-df43-4ddc-8e41-ecffea24cc11", "book": {"isbn13": "9784000000000"}}
    assert CapturingClient("token").put_json("o", "r", "book.json", "main", payload, None) == "new-sha"
    assert captured["message"] == "marginalia: publish 9784000000000 18f40001-df43-4ddc-8e41-ecffea24cc11"

    error = urllib.error.HTTPError("https://api.github.test", 409, "Conflict", {}, io.BytesIO(b"conflict"))
    monkeypatch.setattr(publisher_module.urllib.request, "urlopen", lambda *args, **kwargs: (_ for _ in ()).throw(error))
    with pytest.raises(PublishConflict, match="conflict"):
        GitHubContentsClient("token")._request(urllib.request.Request("https://api.github.test"))


def test_publish_api_fixes_path_forbids_override_and_reports_conflict(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    app = create_app(Settings(workspace=tmp_path))
    client = TestClient(app, base_url="http://127.0.0.1")
    csrf = client.get("/api/session").json()["csrfToken"]
    headers = {"X-CSRF-Token": csrf}
    bundle = tmp_path / "book.zip"
    make_zip(bundle)
    with bundle.open("rb") as source:
        assert client.post("/api/import", headers=headers, files={"bundle": ("book.zip", source)}).status_code == 201
    preview = client.get("/api/books/9784000000000/publication-preview").json()
    body = {
        "account": "me", "owner": "o", "repo": "r", "branch": "main", "expectedSha": "old",
        "previewRevision": preview["payload"]["revision"],
        "previewUpdatedAtMs": preview["payload"]["updatedAtMs"],
        "previewDigest": preview["digest"],
    }
    assert client.post(
        "/api/books/9784000000000/publish", headers=headers, json={**body, "path": "escape.json"}
    ).status_code == 422

    class Credentials:
        def get_token(self, account: str) -> str:
            return "token"

    class Client:
        def __init__(self, token: str) -> None:
            pass

        def put_json(self, owner, repo, path, branch, payload, expected_sha):  # type: ignore[no-untyped-def]
            assert path == "marginalia/v1/books/9784000000000.json"
            raise PublishConflict("remote blob changed")

    monkeypatch.setattr(app_module, "GitHubCredentials", Credentials)
    monkeypatch.setattr(app_module, "GitHubContentsClient", Client)
    response = client.post("/api/books/9784000000000/publish", headers=headers, json=body)
    assert response.status_code == 409


def test_integrated_publication_preview_returns_remote_and_structured_diff(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    app = create_app(Settings(workspace=tmp_path))
    client = TestClient(app, base_url="http://127.0.0.1")
    csrf = client.get("/api/session").json()["csrfToken"]
    headers = {"X-CSRF-Token": csrf}
    bundle = tmp_path / "book.zip"
    make_zip(bundle)
    with bundle.open("rb") as source:
        assert client.post("/api/import", headers=headers, files={"bundle": ("book.zip", source)}).status_code == 201

    local = client.get("/api/books/9784000000000/publication-preview").json()["payload"]
    remote = deepcopy(local)
    remote["book"]["title"] = "Remote title"
    remote["highlights"] = []

    class Credentials:
        def get_token(self, account: str) -> str:
            assert account == "me"
            return "token"

    class Client:
        def __init__(self, token: str) -> None:
            assert token == "token"

        def get(self, owner, repo, path, branch):  # type: ignore[no-untyped-def]
            assert (owner, repo, path, branch) == ("o", "r", "marginalia/v1/books/9784000000000.json", "main")
            return RemoteContent("a" * 40, json.dumps(remote).encode("utf-8"))

    monkeypatch.setattr(app_module, "GitHubCredentials", Credentials)
    monkeypatch.setattr(app_module, "GitHubContentsClient", Client)
    response = client.get(
        "/api/books/9784000000000/publication-preview",
        params={"account": "me", "owner": "o", "repo": "r", "branch": "main"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["remote"] == {"exists": True, "sha": "a" * 40}
    assert body["diff"]["summary"]["bookChangedFields"] == 1
    assert body["diff"]["summary"]["addedHighlights"] == len(local["highlights"])
    assert body["diff"]["summary"]["removedHighlights"] == 0


def test_ocr_endpoints_use_single_process_worker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    data = manifest()
    second = deepcopy(data["pages"][0])  # type: ignore[index]
    second["id"] = "49949d0d-b17e-4825-9464-398cab84bdb3"
    second["imagePath"] = "pages/49949d0d-b17e-4825-9464-398cab84bdb3.jpg"
    second["annotations"][0]["id"] = "d31e779a-dd4f-485a-99ca-0f43e26bd351"
    data["pages"].append(second)  # type: ignore[union-attr]
    bundle = tmp_path / "two.zip"
    with zipfile.ZipFile(bundle, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(data))
        archive.writestr(f"pages/{PAGE_ID}.jpg", JPEG_FIXTURE)
        archive.writestr("pages/49949d0d-b17e-4825-9464-398cab84bdb3.jpg", JPEG_FIXTURE)
    config = tmp_path / "ocr.json"
    config.write_text("{}", encoding="utf-8")
    active = 0
    maximum = 0
    counter_lock = threading.Lock()

    class Adapter:
        def __init__(self, config_path: Path, timeout: int) -> None:
            pass

        def recognize(self, image_path: Path, width: int, height: int, page_id: str):  # type: ignore[no-untyped-def]
            nonlocal active, maximum
            with counter_lock:
                active += 1
                maximum = max(maximum, active)
            time.sleep(.1)
            with counter_lock:
                active -= 1
            return [], {"engine": "test"}

    monkeypatch.setattr(app_module, "NdlocrLiteAdapter", Adapter)
    app = create_app(Settings(workspace=tmp_path / "workspace", ndlocr_config=config))
    setup = TestClient(app, base_url="http://127.0.0.1")
    token = setup.get("/api/session").json()["csrfToken"]
    headers = {"X-CSRF-Token": token}
    with bundle.open("rb") as source:
        assert setup.post("/api/import", headers=headers, files={"bundle": ("book.zip", source)}).status_code == 201
    page_ids = [page["id"] for page in setup.get("/api/pages").json()]
    statuses: list[int] = []
    barrier = threading.Barrier(2)

    def invoke(page_id: str) -> None:
        with TestClient(app, base_url="http://127.0.0.1") as concurrent:
            concurrent.cookies.set("marginalia_csrf", token)
            barrier.wait()
            statuses.append(concurrent.post(f"/api/pages/{page_id}/ocr", headers=headers).status_code)

    threads = [threading.Thread(target=invoke, args=(page_id,)) for page_id in page_ids]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=5)
    assert statuses == [200, 200]
    assert maximum == 1


def test_health_and_session_readiness_contract(tmp_path: Path) -> None:
    app = create_app(Settings(workspace=tmp_path))
    client = TestClient(app, base_url="http://127.0.0.1")
    health = client.get("/api/health")
    assert health.status_code == 200
    assert health.json() == {
        "status": "ok",
        "service": "maginalia-reviewer",
        "contractVersion": 1,
    }
    session = client.get("/api/session")
    assert session.status_code == 200
    data = session.json()
    assert data["service"] == "maginalia-reviewer"
    assert data["contractVersion"] == 1
    assert "csrfToken" in data

