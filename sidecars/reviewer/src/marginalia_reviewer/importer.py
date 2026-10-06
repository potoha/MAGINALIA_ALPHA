from __future__ import annotations

import json
import hashlib
import os
import re
import shutil
import sqlite3
import stat
import uuid
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from PIL import Image, UnidentifiedImageError

from .db import Workspace, now_iso
from .schema import ContractValidationError, validate_contract

JPEG_EXTENSIONS = {".jpg", ".jpeg"}
ISBN13 = re.compile(r"^[0-9]{13}$")
MAGICAP_PACKAGE_ID = re.compile(r"^capkg:[0-7][0-9A-HJKMNP-TV-Z]{25}$")
MAGICAP_CAPTURE_PATH = re.compile(r"^captures/([^/]+)\.json$")
MAGICAP_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
MAGICAP_MEDIA_TYPES = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}


class BundleValidationError(ValueError):
    pass


class UnsupportedCapturePackageVersion(BundleValidationError):
    pass


class DuplicateCapturePackageError(BundleValidationError):
    def __init__(self, package_id: str) -> None:
        super().__init__(
            "この Capture Package はすでに取り込まれています。\n"
            f"packageId: {package_id}\n"
            "既存のReviewerデータを確認してください。"
        )
        self.package_id = package_id


@dataclass(frozen=True)
class ImportLimits:
    max_zip_bytes: int
    max_uncompressed_bytes: int
    max_entries: int
    max_entry_bytes: int = 256 * 1024 * 1024
    max_compression_ratio: float = 200.0


def _safe_member(name: str) -> PurePosixPath:
    if "\\" in name or "\x00" in name:
        raise BundleValidationError(f"unsafe ZIP member: {name!r}")
    path = PurePosixPath(name)
    if path.is_absolute() or not path.parts or any(part in {"", ".", ".."} for part in path.parts):
        raise BundleValidationError(f"unsafe ZIP member: {name!r}")
    return path


def _image_reference(page: dict[str, Any]) -> str | None:
    for key in ("image", "imagePath", "relativeImagePath", "image_path", "path"):
        value = page.get(key)
        if isinstance(value, str):
            return value.replace("\\", "/")
    return None


def _page_id(page: dict[str, Any], fallback: str) -> str:
    for key in ("id", "pageId", "page_id"):
        if isinstance(page.get(key), str) and page[key]:
            return page[key]
    return fallback


def _as_list(value: object) -> list[Any]:
    return value if isinstance(value, list) else []


def _valid_isbn13(value: str) -> bool:
    if not ISBN13.fullmatch(value):
        return False
    checksum = sum(int(digit) * (1 if index % 2 == 0 else 3) for index, digit in enumerate(value[:12]))
    return (10 - checksum % 10) % 10 == int(value[12])


def _validate_manifest_semantics(manifest: dict[str, Any]) -> None:
    book = manifest["book"]
    if not _valid_isbn13(book["isbn13"]):
        raise BundleValidationError("book.isbn13 has an invalid ISBN-13 check digit")
    page_ids: set[str] = set()
    annotation_ids: set[str] = set()
    region_ids: set[str] = set()
    for page_index, page in enumerate(manifest["pages"]):
        page_id = page["id"]
        if page_id in page_ids:
            raise BundleValidationError(f"duplicate page id: {page_id}")
        page_ids.add(page_id)
        if page["imagePath"] != f"pages/{page_id}.jpg":
            raise BundleValidationError(f"page image path does not match page id: {page_id}")
        for region in page["mobileOcr"]["regions"]:
            region_id = region["id"]
            if region_id in region_ids:
                raise BundleValidationError(f"duplicate OCR region id: {region_id}")
            region_ids.add(region_id)
            if not region_id.startswith(f"mobile:{page_id}:"):
                raise BundleValidationError(f"OCR region id does not belong to page {page_id}")
            if region["right"] <= region["left"] or region["bottom"] <= region["top"]:
                raise BundleValidationError(f"degenerate OCR region: {region_id}")
        for annotation in page["annotations"]:
            annotation_id = annotation["id"]
            if annotation_id in annotation_ids:
                raise BundleValidationError(f"duplicate annotation id: {annotation_id}")
            annotation_ids.add(annotation_id)
            points = annotation["strokePoints"]
            orders = [point["order"] for point in points]
            if len(orders) != len(set(orders)) or sorted(orders) != list(range(len(points))):
                raise BundleValidationError(f"stroke point order must be unique and contiguous: {annotation_id}")
            coordinates = {(point["x"], point["y"]) for point in points}
            if len(coordinates) < 2:
                raise BundleValidationError(f"annotation stroke is degenerate: {annotation_id}")


class BundleImporter:
    def __init__(self, workspace: Workspace, imports_root: Path, limits: ImportLimits) -> None:
        self.workspace = workspace
        self.imports_root = imports_root
        self.limits = limits

    def import_zip(self, zip_path: Path, source_name: str | None = None) -> str:
        if zip_path.stat().st_size > self.limits.max_zip_bytes:
            raise BundleValidationError("ZIP exceeds configured size limit")
        import_id = str(uuid.uuid4())
        destination = self.imports_root / import_id
        try:
            manifest = self._validate_and_extract(zip_path, destination)
            self._persist(import_id, source_name or zip_path.name, destination, manifest)
        except Exception:
            shutil.rmtree(destination, ignore_errors=True)
            raise
        return import_id

    def _validate_and_extract(self, zip_path: Path, destination: Path) -> dict[str, Any]:
        with zipfile.ZipFile(zip_path) as archive:
            infos = archive.infolist()
            if len(infos) > self.limits.max_entries:
                raise BundleValidationError("ZIP contains too many entries")
            total = 0
            normalized: set[str] = set()
            for info in infos:
                if info.flag_bits & 0x1:
                    raise BundleValidationError(f"encrypted ZIP members are not allowed: {info.filename}")
                path = _safe_member(info.filename.rstrip("/"))
                key = path.as_posix().casefold()
                if key in normalized:
                    raise BundleValidationError(f"duplicate ZIP member: {info.filename}")
                normalized.add(key)
                mode = info.external_attr >> 16
                if stat.S_ISLNK(mode):
                    raise BundleValidationError(f"symbolic links are not allowed: {info.filename}")
                file_type = stat.S_IFMT(mode)
                if file_type and not (info.is_dir() or stat.S_ISREG(mode)):
                    raise BundleValidationError(f"special ZIP members are not allowed: {info.filename}")
                if info.file_size > self.limits.max_entry_bytes:
                    raise BundleValidationError(f"ZIP member exceeds configured size limit: {info.filename}")
                total += info.file_size
                if total > self.limits.max_uncompressed_bytes:
                    raise BundleValidationError("ZIP expands beyond configured size limit")
                if info.file_size and info.compress_size == 0:
                    raise BundleValidationError("invalid ZIP compression metadata")
                if info.compress_size and info.file_size / info.compress_size > self.limits.max_compression_ratio:
                    raise BundleValidationError("suspicious ZIP compression ratio")
            try:
                raw_manifest = archive.read("manifest.json")
            except KeyError as exc:
                raise BundleValidationError("manifest.json is required at the ZIP root") from exc
            try:
                manifest = json.loads(raw_manifest.decode("utf-8-sig"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise BundleValidationError("manifest.json must be valid UTF-8 JSON") from exc
            if not isinstance(manifest, dict):
                raise BundleValidationError("manifest.json must be a JSON object")
            try:
                validate_contract(manifest, "manifest-v1.schema.json")
            except ContractValidationError as exc:
                raise BundleValidationError(str(exc)) from exc
            _validate_manifest_semantics(manifest)
            pages = _as_list(manifest.get("pages"))
            image_names = {
                PurePosixPath(info.filename).as_posix()
                for info in infos
                if not info.is_dir() and PurePosixPath(info.filename).suffix.lower() in JPEG_EXTENSIONS
            }
            if any(not name.startswith("pages/") for name in image_names):
                raise BundleValidationError("all JPEGs must be files under pages/")
            declared_images: set[str] = set()
            for index, page in enumerate(pages):
                if not isinstance(page, dict):
                    raise BundleValidationError(f"pages[{index}] must be an object")
                image = _image_reference(page)
                if image is None or image not in image_names:
                    raise BundleValidationError(f"declared page image is missing: {image}")
                if image in declared_images:
                    raise BundleValidationError(f"page image is declared more than once: {image}")
                declared_images.add(image)
                with archive.open(image) as source:
                    digest = hashlib.sha256()
                    for chunk in iter(lambda: source.read(1024 * 1024), b""):
                        digest.update(chunk)
                if digest.hexdigest() != page["imageSha256"]:
                    raise BundleValidationError(f"SHA-256 mismatch for {image}")
                try:
                    with archive.open(image) as source, Image.open(source) as decoded:
                        if decoded.format != "JPEG":
                            raise BundleValidationError(f"declared page image is not JPEG: {image}")
                        if decoded.size != (page["width"], page["height"]):
                            raise BundleValidationError(
                                f"image dimensions do not match manifest for {image}: "
                                f"{decoded.width}x{decoded.height} != {page['width']}x{page['height']}"
                            )
                        decoded.verify()
                except BundleValidationError:
                    raise
                except (UnidentifiedImageError, OSError, ValueError) as exc:
                    raise BundleValidationError(f"invalid JPEG page image: {image}") from exc
            if image_names != declared_images:
                raise BundleValidationError("ZIP contains undeclared JPEG page images")
            regular_members = {
                PurePosixPath(info.filename).as_posix()
                for info in infos
                if not info.is_dir()
            }
            expected_members = {"manifest.json", *declared_images}
            if regular_members != expected_members:
                raise BundleValidationError("ZIP contains undeclared files")
            destination.mkdir(parents=True, exist_ok=False)
            for info in infos:
                if info.is_dir():
                    continue
                path = _safe_member(info.filename)
                target = destination.joinpath(*path.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(info) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
            return manifest

    def _persist(self, import_id: str, source_name: str, root: Path, manifest: dict[str, Any]) -> None:
        book = manifest.get("book") if isinstance(manifest.get("book"), dict) else {}
        assert isinstance(book, dict)
        isbn = book.get("isbn13") if isinstance(book.get("isbn13"), str) else None
        if isbn is not None and not _valid_isbn13(isbn):
            raise BundleValidationError("book.isbn13 must be a valid ISBN-13")
        metadata = book.get("metadata") if isinstance(book.get("metadata"), dict) else {}
        assert isinstance(metadata, dict)
        book_id = str(uuid.uuid4())
        declared_pages = _as_list(manifest.get("pages"))
        image_paths = sorted(path.relative_to(root).as_posix() for path in (root / "pages").rglob("*") if path.is_file())
        if declared_pages:
            page_inputs = declared_pages
        else:
            page_inputs = [{"id": Path(name).stem, "imagePath": name} for name in image_paths]
        global_annotations = _as_list(manifest.get("annotations"))
        with self.workspace.connect() as db:
            db.execute(
                "INSERT INTO imports(id,source_name,root_path,manifest_json,imported_at,package_id) VALUES(?,?,?,?,?,NULL)",
                (import_id, source_name, str(root.resolve()), json.dumps(manifest, ensure_ascii=False), now_iso()),
            )
            authors = metadata.get("authors", [])
            if isinstance(authors, str):
                authors = [authors]
            if not isinstance(authors, list) or not all(isinstance(item, str) for item in authors):
                authors = []
            db.execute(
                "INSERT INTO books(id,import_id,isbn13,title,authors_json,orientation,source_json) VALUES(?,?,?,?,?,?,?)",
                (
                    book_id, import_id, isbn, metadata.get("title") if isinstance(metadata.get("title"), str) else None,
                    json.dumps(authors, ensure_ascii=False),
                    book.get("orientation") if isinstance(book.get("orientation"), str) else None,
                    json.dumps(book, ensure_ascii=False),
                ),
            )
            for index, page_value in enumerate(page_inputs):
                if not isinstance(page_value, dict):
                    continue
                source_page_id = _page_id(page_value, str(index + 1))
                image = _image_reference(page_value) or (image_paths[index] if index < len(image_paths) else None)
                if image is None:
                    raise BundleValidationError(f"page {source_page_id} has no image")
                image_path = (root / PurePosixPath(image)).resolve()
                if root.resolve() not in image_path.parents or not image_path.is_file():
                    raise BundleValidationError(f"invalid image for page {source_page_id}")
                page_id = str(uuid.uuid4())
                db.execute(
                    """INSERT INTO pages(
                           id,book_id,source_page_id,image_path,width,height,captured_at,status,
                           mobile_ocr_regions_json,ocr_regions_json,ocr_provenance_json,error_summary,updated_at
                       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        page_id, book_id, source_page_id, str(image_path), page_value.get("width"),
                        page_value.get("height"), page_value.get("capturedAtMs"), "PENDING",
                        json.dumps(page_value["mobileOcr"]["regions"], ensure_ascii=False),
                        "[]", None, None, now_iso(),
                    ),
                )
                page_annotations = _as_list(page_value.get("annotations"))
                matching_global = [
                    item for item in global_annotations if isinstance(item, dict)
                    and item.get("pageId", item.get("page_id")) == source_page_id
                ]
                annotations = page_annotations + matching_global
                for ann_index, annotation in enumerate(annotations):
                    if not isinstance(annotation, dict):
                        continue
                    source_ann_id = annotation.get("id") if isinstance(annotation.get("id"), str) else str(ann_index + 1)
                    geometry = annotation.get("points", annotation.get("strokePoints", annotation.get("geometry", [])))
                    if not isinstance(geometry, list):
                        geometry = []
                    elif geometry and all(isinstance(point, dict) and isinstance(point.get("order"), int) for point in geometry):
                        geometry = sorted(geometry, key=lambda point: point["order"])
                    db.execute(
                        """INSERT INTO annotations(
                               id,page_id,source_annotation_id,geometry_json,highlight_quote,
                               sentence_before,sentence_after,page_label,chapter_label,comment,
                               created_at,reviewed_at_ms,updated_at
                           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                        (
                            str(uuid.uuid4()), page_id, source_ann_id, json.dumps(geometry),
                            annotation.get("highlightQuote", annotation.get("highlight_quote", "")),
                            annotation.get("sentenceBefore", annotation.get("sentence_before", "")),
                            annotation.get("sentenceAfter", annotation.get("sentence_after", "")),
                            annotation.get("pageLabel", annotation.get("page_label", "")),
                            annotation.get("chapterLabel", annotation.get("chapter_label", "")),
                            annotation.get("comment", ""), annotation.get("createdAtMs"), None, now_iso(),
                        ),
                    )


def is_magicap_filename(name: str) -> bool:
    lower = Path(name).name.casefold()
    return lower.endswith(".magicap") or lower.endswith(".magicap.zip")


class MagicapImporter:
    """Version-dispatched, transaction-safe importer for .magicap v1-v3."""

    def __init__(self, workspace: Workspace, imports_root: Path, limits: ImportLimits) -> None:
        self.workspace = workspace
        self.imports_root = imports_root
        self.limits = limits

    def import_magicap(self, zip_path: Path, source_name: str) -> str:
        if not is_magicap_filename(source_name):
            raise BundleValidationError("Capture packages must use a .magicap or .magicap.zip filename")
        if zip_path.stat().st_size > self.limits.max_zip_bytes:
            raise BundleValidationError("Capture package exceeds configured size limit")
        manifest = self._read_manifest(zip_path)
        package_id = manifest["packageId"]
        if self.workspace.has_package_id(package_id):
            raise DuplicateCapturePackageError(package_id)
        import_id = str(uuid.uuid4())
        destination = self.imports_root / import_id
        try:
            manifest, captures = self._validate_and_extract(zip_path, destination, manifest)
            self._persist(import_id, source_name, destination, manifest, captures)
        except sqlite3.IntegrityError as exc:
            shutil.rmtree(destination, ignore_errors=True)
            if self.workspace.has_package_id(package_id):
                raise DuplicateCapturePackageError(package_id) from exc
            raise
        except Exception:
            shutil.rmtree(destination, ignore_errors=True)
            raise
        return import_id

    def _safe_infos(self, archive: zipfile.ZipFile) -> tuple[list[zipfile.ZipInfo], set[str]]:
        infos = archive.infolist()
        if len(infos) > self.limits.max_entries:
            raise BundleValidationError("Capture package contains too many entries")
        total = 0
        names: set[str] = set()
        folded_names: set[str] = set()
        for info in infos:
            if info.flag_bits & 0x1:
                raise BundleValidationError(f"encrypted ZIP members are not allowed: {info.filename}")
            path = _safe_member(info.filename.rstrip("/"))
            name = path.as_posix()
            if name.casefold() in folded_names:
                raise BundleValidationError(f"duplicate ZIP member: {info.filename}")
            names.add(name)
            folded_names.add(name.casefold())
            mode = info.external_attr >> 16
            if stat.S_ISLNK(mode):
                raise BundleValidationError(f"symbolic links are not allowed: {info.filename}")
            file_type = stat.S_IFMT(mode)
            if file_type and not (info.is_dir() or stat.S_ISREG(mode)):
                raise BundleValidationError(f"special ZIP members are not allowed: {info.filename}")
            if info.file_size > self.limits.max_entry_bytes:
                raise BundleValidationError(f"ZIP member exceeds configured size limit: {info.filename}")
            total += info.file_size
            if total > self.limits.max_uncompressed_bytes:
                raise BundleValidationError("Capture package expands beyond configured size limit")
            if info.file_size and info.compress_size == 0:
                raise BundleValidationError("invalid ZIP compression metadata")
            if info.compress_size and info.file_size / info.compress_size > self.limits.max_compression_ratio:
                raise BundleValidationError("suspicious ZIP compression ratio")
        return infos, names

    @staticmethod
    def _record(value: object, label: str) -> dict[str, Any]:
        if not isinstance(value, dict):
            raise BundleValidationError(f"{label} must be an object")
        return value

    @staticmethod
    def _number(value: object, label: str) -> float:
        import math
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise BundleValidationError(f"{label} must be a finite number")
        return float(value)

    def _validate_manifest(self, manifest: dict[str, Any]) -> int:
        version = manifest.get("version")
        if manifest.get("format") != "maginalia-capture-package":
            raise BundleValidationError("manifest.format is unsupported")
        if isinstance(version, bool) or not isinstance(version, int):
            raise BundleValidationError("manifest.version must be an integer")
        if version not in {1, 2, 3}:
            raise UnsupportedCapturePackageVersion(f"Unsupported Capture Package version: {version}")
        if version == 1:
            try:
                validate_contract(manifest, "magicap-v1-manifest.schema.json")
            except ContractValidationError as exc:
                raise BundleValidationError(str(exc)) from exc
            book = self._record(manifest.get("book"), "manifest.book")
            isbn = book.get("isbn13")
            if not isinstance(isbn, str) or not _valid_isbn13(isbn):
                raise BundleValidationError("manifest.book.isbn13 has an invalid ISBN-13 check digit")
            return version

        schema = f"magicap-v{version}-manifest.schema.json"
        try:
            validate_contract(manifest, schema)
        except ContractValidationError as exc:
            raise BundleValidationError(str(exc)) from exc
        source = self._record(manifest.get("source"), "manifest.source")
        isbn = source.get("isbn13")
        if isinstance(isbn, str) and not _valid_isbn13(isbn):
            raise BundleValidationError("manifest.source.isbn13 has an invalid ISBN-13 check digit")
        for item in source.get("files", []):
            file_record = self._record(item, "manifest.source.files item")
            try:
                _safe_member(str(file_record.get("path", "")))
            except BundleValidationError as exc:
                raise BundleValidationError("manifest.source.files contains an unsafe path") from exc
        return version

    def _read_manifest(self, zip_path: Path) -> dict[str, Any]:
        with zipfile.ZipFile(zip_path) as archive:
            infos, _ = self._safe_infos(archive)
            if not any(info.filename == "manifest.json" and not info.is_dir() for info in infos):
                raise BundleValidationError("manifest.json is required at the ZIP root")
            try:
                value = json.loads(archive.read("manifest.json").decode("utf-8-sig"))
            except (UnicodeDecodeError, json.JSONDecodeError, KeyError) as exc:
                raise BundleValidationError("manifest.json must be valid UTF-8 JSON") from exc
            manifest = self._record(value, "manifest.json")
            self._validate_manifest(manifest)
            return manifest

    def _validate_capture(self, capture: object, entries: set[str], version: int) -> dict[str, Any]:
        item = self._record(capture, "capture")
        capture_id = item.get("id")
        if not isinstance(capture_id, str) or not MAGICAP_SAFE_ID.fullmatch(capture_id):
            raise BundleValidationError("capture id is unsafe or missing")
        if item.get("ocrStatus") != "pending" or not isinstance(item.get("bookId"), str) or not item["bookId"].strip() or not isinstance(item.get("createdAt"), str):
            raise BundleValidationError(f"capture {capture_id} has invalid status, book, or timestamp")
        comment = item.get("comment")
        if not isinstance(comment, str):
            raise BundleValidationError(f"capture {capture_id}.comment must be text")
        # The v1 importer historically ignored optional fields on captures.
        # Keep that compatibility without treating an extra v1 value as a
        # current Capture quote.
        quote = "" if version == 1 else item.get("quote", "")
        if not isinstance(quote, str):
            raise BundleValidationError(f"capture {capture_id}.quote must be text")
        page_number = item.get("pageNumber")
        if page_number is not None and (isinstance(page_number, bool) or not isinstance(page_number, int) or page_number <= 0):
            raise BundleValidationError(f"capture {capture_id}.pageNumber must be null or a positive integer")
        selected = self._record(item.get("selectedRegion"), f"capture {capture_id}.selectedRegion")
        region = {key: self._number(selected.get(key), f"capture {capture_id}.selectedRegion.{key}") for key in ("left", "top", "right", "bottom")}
        if any(value < 0 or value > 1 for value in region.values()) or region["right"] <= region["left"] or region["bottom"] <= region["top"]:
            raise BundleValidationError(f"capture {capture_id} has invalid selectedRegion bounds")
        page = self._record(item.get("pageImage"), f"capture {capture_id}.pageImage")
        page_id, path, media_type = page.get("id"), page.get("path"), page.get("mediaType")
        if not isinstance(page_id, str) or not MAGICAP_SAFE_ID.fullmatch(page_id):
            raise BundleValidationError(f"capture {capture_id} has an invalid pageImage.id")
        if not isinstance(path, str) or path not in entries or not path.startswith("images/") or len(PurePosixPath(path).parts) != 2:
            raise BundleValidationError(f"capture {capture_id} references a missing or unsafe image")
        if media_type not in set(MAGICAP_MEDIA_TYPES.values()):
            raise BundleValidationError(f"capture {capture_id} has an unsupported image media type")
        image_name = PurePosixPath(path)
        valid_suffixes = {
            "image/jpeg": {".jpg", ".jpeg"},
            "image/png": {".png"},
            "image/webp": {".webp"},
        }
        if image_name.stem != page_id or image_name.suffix.lower() not in valid_suffixes[media_type]:
            raise BundleValidationError(f"capture {capture_id} pageImage path does not match its id and media type")
        width, height = page.get("width"), page.get("height")
        if isinstance(width, bool) or isinstance(height, bool) or not isinstance(width, int) or not isinstance(height, int) or width <= 0 or height <= 0:
            raise BundleValidationError(f"capture {capture_id} has invalid image dimensions")
        return {
            "id": capture_id,
            "bookId": item["bookId"],
            "pageImage": {"id": page_id, "path": path, "mediaType": media_type, "width": width, "height": height},
            "selectedRegion": region,
            "pageNumber": page_number,
            "comment": comment,
            "quote": quote,
            "createdAt": item["createdAt"],
        }

    def _validate_and_extract(
        self,
        zip_path: Path,
        destination: Path,
        manifest: dict[str, Any],
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        with zipfile.ZipFile(zip_path) as archive:
            infos, names = self._safe_infos(archive)
            regular = {PurePosixPath(info.filename).as_posix() for info in infos if not info.is_dir()}
            if "manifest.json" not in regular:
                raise BundleValidationError("manifest.json is required at the ZIP root")
            try:
                archive_manifest = json.loads(archive.read("manifest.json").decode("utf-8-sig"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise BundleValidationError("manifest.json must be valid UTF-8 JSON") from exc
            archive_manifest = self._record(archive_manifest, "manifest.json")
            version = self._validate_manifest(archive_manifest)
            if archive_manifest != manifest:
                raise BundleValidationError("manifest.json changed during validation")
            source = archive_manifest.get("source") if version >= 2 else archive_manifest.get("book")
            source = self._record(source, "manifest.source" if version >= 2 else "manifest.book")
            declared_source_files: dict[str, dict[str, Any]] = {}
            if version == 3:
                seen_source_paths: set[str] = set()
                for index, item in enumerate(source.get("files", [])):
                    file_record = self._record(item, f"manifest.source.files[{index}]")
                    if file_record["path"] in seen_source_paths:
                        raise BundleValidationError("manifest.source.files contains a duplicate path")
                    seen_source_paths.add(file_record["path"])
                    declared_source_files[file_record["path"]] = file_record
                    if file_record["path"] not in regular:
                        raise BundleValidationError(f"canonical source file is missing: {file_record['path']}")
            capture_names = sorted(name for name in regular if MAGICAP_CAPTURE_PATH.fullmatch(name))
            if any(name.startswith("captures/") and name not in capture_names for name in regular):
                raise BundleValidationError("captures must be JSON files directly under captures/")
            if len(capture_names) != manifest["captureCount"]:
                raise BundleValidationError("manifest.captureCount does not match capture records")
            captures = []
            capture_ids: set[str] = set()
            images: dict[str, dict[str, Any]] = {}
            page_images: dict[str, dict[str, Any]] = {}
            for name in capture_names:
                try:
                    parsed = json.loads(archive.read(name).decode("utf-8-sig"))
                except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                    raise BundleValidationError(f"{name} must be valid UTF-8 JSON") from exc
                capture = self._validate_capture(parsed, regular, version)
                if PurePosixPath(name).stem != capture["id"]:
                    raise BundleValidationError(f"capture filename does not match capture id: {name}")
                if capture["id"] in capture_ids:
                    raise BundleValidationError(f"duplicate capture id: {capture['id']}")
                capture_ids.add(capture["id"])
                page = capture["pageImage"]
                previous = images.get(page["path"])
                if previous and previous != page:
                    raise BundleValidationError(f"conflicting metadata for shared image: {page['path']}")
                images[page["path"]] = page
                previous_page = page_images.get(page["id"])
                if previous_page and previous_page != page:
                    raise BundleValidationError(f"conflicting metadata for shared page image id: {page['id']}")
                page_images[page["id"]] = page
                captures.append(capture)
            image_names = {
                PurePosixPath(info.filename).as_posix()
                for info in infos
                if not info.is_dir() and PurePosixPath(info.filename).suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
            }
            allowed_images = set(images) | set(declared_source_files)
            if any(name.startswith("images/") and name not in allowed_images for name in regular):
                raise BundleValidationError("Capture package contains undeclared image files")
            if image_names - allowed_images:
                raise BundleValidationError("Capture package contains undeclared image files")
            expected = {"manifest.json", *capture_names, *images, *declared_source_files}
            if regular != expected:
                raise BundleValidationError("Capture package contains undeclared files")
            for path, page in images.items():
                try:
                    with archive.open(path) as source, Image.open(source) as decoded:
                        actual = MAGICAP_MEDIA_TYPES.get(decoded.format or "")
                        if actual != page["mediaType"]:
                            raise BundleValidationError(f"image media type does not match source: {path}")
                        if decoded.size != (page["width"], page["height"]):
                            raise BundleValidationError(f"image dimensions do not match capture metadata: {path}")
                        decoded.verify()
                except BundleValidationError:
                    raise
                except (UnidentifiedImageError, OSError, ValueError) as exc:
                    raise BundleValidationError(f"invalid source image: {path}") from exc
            for file_path, file_record in declared_source_files.items():
                digest = hashlib.sha256()
                try:
                    with archive.open(file_path) as source_stream:
                        prefix = source_stream.read(8)
                        digest.update(prefix)
                        for chunk in iter(lambda: source_stream.read(1024 * 1024), b""):
                            digest.update(chunk)
                except (KeyError, OSError, RuntimeError) as exc:
                    raise BundleValidationError(f"canonical source file could not be read: {file_path}") from exc
                if digest.hexdigest() != file_record["sha256"]:
                    raise BundleValidationError(f"SHA-256 mismatch for canonical source file: {file_path}")
                if file_record["mediaType"] == "application/pdf":
                    if not prefix.startswith(b"%PDF-"):
                        raise BundleValidationError(f"canonical source file is not a PDF: {file_path}")
                else:
                    try:
                        with archive.open(file_path) as source_stream, Image.open(source_stream) as decoded:
                            if decoded.format != "JPEG":
                                raise BundleValidationError(f"canonical source file is not JPEG: {file_path}")
                            decoded.verify()
                    except BundleValidationError:
                        raise
                    except (UnidentifiedImageError, OSError, ValueError) as exc:
                        raise BundleValidationError(f"invalid canonical JPEG source file: {file_path}") from exc
            destination.mkdir(parents=True, exist_ok=False)
            for info in infos:
                if info.is_dir():
                    continue
                path = _safe_member(info.filename)
                target = destination.joinpath(*path.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(info) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
            return archive_manifest, captures

    def source_asset_for_annotation(self, annotation_id: str, asset_path: str) -> tuple[Path, str] | None:
        """Resolve only a declared v3 canonical asset for an approved capture."""
        if not re.fullmatch(r"[0-9a-fA-F-]{36}", annotation_id):
            return None
        try:
            safe_path = _safe_member(asset_path).as_posix()
        except BundleValidationError:
            return None
        with self.workspace.connect() as db:
            row = db.execute(
                """SELECT imports.root_path, imports.manifest_json
                   FROM annotations
                   JOIN pages ON pages.id=annotations.page_id
                   JOIN books ON books.id=pages.book_id
                   JOIN imports ON imports.id=books.import_id
                   WHERE annotations.id=? AND annotations.review_state='APPROVED'
                     AND annotations.selected_region_json IS NOT NULL""",
                (annotation_id,),
            ).fetchone()
        if row is None:
            return None
        try:
            manifest = json.loads(row["manifest_json"])
        except (TypeError, json.JSONDecodeError):
            return None
        if not isinstance(manifest, dict) or manifest.get("version") != 3:
            return None
        source = manifest.get("source")
        files = source.get("files") if isinstance(source, dict) else None
        if not isinstance(files, list):
            return None
        item = next(
            (entry for entry in files if isinstance(entry, dict) and entry.get("path") == safe_path),
            None,
        )
        if item is None:
            return None
        root = Path(row["root_path"]).resolve(strict=True)
        candidate = root.joinpath(*PurePosixPath(safe_path).parts)
        try:
            resolved = candidate.resolve(strict=True)
            if root not in resolved.parents or candidate.is_symlink() or not resolved.is_file():
                return None
            digest_state = hashlib.sha256()
            with resolved.open("rb") as source:
                while chunk := source.read(1024 * 1024):
                    digest_state.update(chunk)
            digest = digest_state.hexdigest()
        except (OSError, RuntimeError):
            return None
        if digest != item.get("sha256"):
            return None
        media_type = item.get("mediaType")
        if media_type not in {"image/jpeg", "application/pdf"}:
            return None
        return resolved, media_type

    def _persist(self, import_id: str, source_name: str, root: Path, manifest: dict[str, Any], captures: list[dict[str, Any]]) -> None:
        version = manifest["version"]
        source = manifest["source"] if version >= 2 else manifest["book"]
        isbn = source.get("isbn13")
        title = source.get("title")
        authors = source.get("authors", [])
        book_id = str(uuid.uuid4())
        page_ids: dict[str, str] = {}
        with self.workspace.connect() as db:
            db.execute(
                "INSERT INTO imports(id,source_name,root_path,manifest_json,imported_at,package_id) VALUES(?,?,?,?,?,?)",
                (import_id, source_name, str(root.resolve()), json.dumps(manifest, ensure_ascii=False), now_iso(), manifest["packageId"]),
            )
            db.execute(
                "INSERT INTO books(id,import_id,isbn13,title,authors_json,orientation,source_json) VALUES(?,?,?,?,?,?,?)",
                (book_id, import_id, isbn, title, json.dumps(authors, ensure_ascii=False), None, json.dumps(source, ensure_ascii=False)),
            )
            for capture in captures:
                page = capture["pageImage"]
                page_id = page_ids.get(page["id"])
                if page_id is None:
                    page_id = str(uuid.uuid4()); page_ids[page["id"]] = page_id
                    image_path = (root / PurePosixPath(page["path"])).resolve()
                    if root.resolve() not in image_path.parents or not image_path.is_file():
                        raise BundleValidationError(f"invalid image path for page {page['id']}")
                    db.execute("""INSERT INTO pages(id,book_id,source_page_id,image_path,image_media_type,width,height,captured_at,status,mobile_ocr_regions_json,ocr_regions_json,ocr_provenance_json,error_summary,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (page_id, book_id, page["id"], str(image_path), page["mediaType"], page["width"], page["height"], capture["createdAt"], "PENDING", "[]", "[]", None, None, now_iso()))
                db.execute("""INSERT INTO annotations(id,page_id,source_annotation_id,geometry_json,highlight_quote,sentence_before,sentence_after,page_label,chapter_label,comment,created_at,source_capture_id,source_book_id,selected_region_json,phone_comment,review_state,reviewed_at_ms,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (str(uuid.uuid4()), page_id, capture["id"], "[]", capture["quote"], "", "", str(capture["pageNumber"]) if capture["pageNumber"] is not None else "", "", capture["comment"], capture["createdAt"], capture["id"], capture["bookId"], json.dumps(capture["selectedRegion"]), capture["comment"], "PENDING", None, now_iso()))
