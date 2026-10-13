from __future__ import annotations

import sys
import hashlib
import json
from io import BytesIO
import re
import zipfile
from pathlib import Path

import pytest

REPOSITORY = Path(__file__).resolve().parents[3]
CONTRACTS = REPOSITORY / "sidecars" / "contracts"
TEST_TOOLS = CONTRACTS / "test_tools"
FIXTURES = CONTRACTS / "fixtures"
sys.path.insert(0, str(TEST_TOOLS))

from build_magicap_bundle_fixtures import JPEG_BYTES, build_fixtures  # noqa: E402
from magicap_bundle_validator import (  # noqa: E402
    BundleContractValidationError,
    BundleLimits,
    validate_bundle,
)


def _read_zip_members(source: Path | BytesIO | bytes) -> dict[str, bytes]:
    if isinstance(source, bytes):
        source = BytesIO(source)
    with zipfile.ZipFile(source) as archive:
        return {info.filename: archive.read(info) for info in archive.infolist()}


def _write_zip_members(destination: Path, members: dict[str, bytes]) -> None:
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, data in members.items():
            archive.writestr(name, data)


def test_valid_fixture_checks_outer_and_unchanged_v3_child_without_persistence() -> None:
    bundle = FIXTURES / "magicap-bundle-v3.1.valid.magicap.bundle"
    result = validate_bundle(bundle)
    assert result == {
        "bundleId": "capbundle:01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "packages": [
            {"packageId": "capkg:01ARZ3NDEKTSV4RRFFQ69G5FAW", "captureCount": 2},
            {"packageId": "capkg:01ARZ3NDEKTSV4RRFFQ69G5FAX", "captureCount": 1},
            {"packageId": "capkg:01ARZ3NDEKTSV4RRFFQ69G5FAY", "captureCount": 1},
            {"packageId": "capkg:01ARZ3NDEKTSV4RRFFQ69G5FAZ", "captureCount": 1},
        ],
    }
    with zipfile.ZipFile(bundle) as outer:
        manifest = json.loads(outer.read("manifest.json"))
        packages = manifest["packages"]
        assert packages[0]["captureIds"] == ["capture-01", "capture-02"]
        assert packages[0]["bookId"] == packages[1]["bookId"] == "capture-book-id:isbn-backed"
        assert packages[0]["get"]["date"] != packages[1]["get"]["date"]
        child_kinds: list[str] = []
        for package in packages:
            child_bytes = outer.read(package["path"])
            assert len(child_bytes) == package["sizeBytes"]
            assert hashlib.sha256(child_bytes).hexdigest() == package["sha256"]
            with zipfile.ZipFile(BytesIO(child_bytes)) as child:
                inner = json.loads(child.read("manifest.json"))
                child_kinds.append(inner["source"]["kind"])
                assert inner["version"] == 3
                assert inner["packageId"] == package["packageId"]
                assert inner["get"]["date"] == package["get"]["date"]
                captures = [json.loads(child.read(name)) for name in child.namelist() if name.startswith("captures/")]
                assert {capture["id"] for capture in captures} == set(package["captureIds"])
                assert {capture["bookId"] for capture in captures} == {package["bookId"]}
                assert child.read("images/page-1.jpg") == JPEG_BYTES
                for source_file in inner["source"].get("files", []):
                    exact_bytes = child.read(source_file["path"])
                    assert exact_bytes == JPEG_BYTES
                    assert hashlib.sha256(exact_bytes).hexdigest() == source_file["sha256"]
        assert child_kinds == ["book", "book", "bookwithoutisbn", "Handwritten"]


@pytest.mark.parametrize(
    ("fixture", "message"),
    [
        ("invalid-traversal.magicap.bundle", "traversal ZIP path component"),
        ("invalid-device-path.magicap.bundle", "reserved device"),
        ("invalid-symlink.magicap.bundle", "symbolic links and special"),
        ("invalid-encrypted.magicap.bundle", "encrypted ZIP entries"),
        ("invalid-duplicate-json-key.magicap.bundle", "duplicate JSON object key"),
        ("invalid-nonfinite-number.magicap.bundle", "non-finite JSON number"),
        ("invalid-outer-hash.magicap.bundle", "SHA-256 mismatch for child package"),
        ("invalid-inner-source-hash.magicap.bundle", "SHA-256 mismatch for canonical source file"),
        ("invalid-inner-duplicate-json-key.magicap.bundle", "duplicate JSON object key"),
        ("invalid-child-crc.magicap.bundle", "could not safely read ZIP entry"),
        ("invalid-inner-version.magicap.bundle", "unchanged .magicap v3 package"),
        ("invalid-book-id.magicap.bundle", "outer bookId does not exactly match"),
        ("invalid-size.magicap.bundle", "size does not match the declared size"),
        ("invalid-package-id.magicap.bundle", "outer and inner packageId differ"),
        ("invalid-date.magicap.bundle", "outer and inner get.date differ"),
        ("invalid-capture-ids.magicap.bundle", "captureIds do not exactly match"),
        ("invalid-duplicate-capture-id.magicap.bundle", "duplicate capture ID across bundle"),
        ("invalid-duplicate-group.magicap.bundle", "duplicate exact (bookId, get.date) group"),
        ("invalid-duplicate-package-id.magicap.bundle", "duplicate child packageId"),
        ("invalid-missing-child.magicap.bundle", "missing="),
        ("invalid-missing-inner-image.magicap.bundle", "canonical source file is missing"),
        ("invalid-unreferenced-entry.magicap.bundle", "must match manifest declarations"),
        ("invalid-path-alias.magicap.bundle", "duplicate or aliased ZIP member"),
        ("invalid-compression-ratio.magicap.bundle", "compression-ratio limit"),
        ("invalid-inner-compression-ratio.magicap.bundle", "compression-ratio limit"),
    ],
)
def test_concrete_invalid_bundle_fixtures_are_rejected(fixture: str, message: str) -> None:
    with pytest.raises(BundleContractValidationError, match=re.escape(message)):
        validate_bundle(FIXTURES / f"magicap-bundle-v3.1.{fixture}")


def test_fixture_builder_reproduces_checked_in_zip_bytes(tmp_path: Path) -> None:
    generated = build_fixtures(tmp_path)
    assert len(generated) == 26
    for name, data in generated.items():
        assert (FIXTURES / name).read_bytes() == data


def test_deep_json_string_validation_is_reported_as_bundle_error(tmp_path: Path) -> None:
    valid = FIXTURES / "magicap-bundle-v3.1.valid.magicap.bundle"
    members = _read_zip_members(valid)
    nested = b"[" * 998 + b"0" + b"]" * 998
    # Ensure the input is accepted by the JSON parser and reaches string-tree validation.
    json.loads(nested)
    members["manifest.json"] = members["manifest.json"][:-1] + b',"deep":' + nested + b"}"
    malformed = tmp_path / "deep-json.magicap.bundle"
    _write_zip_members(malformed, members)

    with pytest.raises(BundleContractValidationError, match="manifest.json must be strict UTF-8 JSON"):
        validate_bundle(malformed)


def test_outer_zip_rejects_windows_illegal_member_characters(tmp_path: Path) -> None:
    valid = FIXTURES / "magicap-bundle-v3.1.valid.magicap.bundle"
    members = _read_zip_members(valid)
    members["unexpected?.txt"] = b"extra"
    malformed = tmp_path / "outer-illegal-path.magicap.bundle"
    _write_zip_members(malformed, members)

    with pytest.raises(BundleContractValidationError, match="Windows-illegal character"):
        validate_bundle(malformed)


def test_inner_zip_rejects_windows_illegal_member_characters(tmp_path: Path) -> None:
    valid = FIXTURES / "magicap-bundle-v3.1.valid.magicap.bundle"
    members = _read_zip_members(valid)
    outer_manifest = json.loads(members["manifest.json"])
    package = outer_manifest["packages"][0]
    child_members = _read_zip_members(members[package["path"]])
    child_members["unexpected?.txt"] = b"extra"
    child_output = BytesIO()
    with zipfile.ZipFile(child_output, "w", compression=zipfile.ZIP_STORED) as child_zip:
        for name, data in child_members.items():
            child_zip.writestr(name, data)
    child_bytes = child_output.getvalue()
    members[package["path"]] = child_bytes
    package["sizeBytes"] = len(child_bytes)
    package["sha256"] = hashlib.sha256(child_bytes).hexdigest()
    members["manifest.json"] = json.dumps(
        outer_manifest, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    malformed = tmp_path / "inner-illegal-path.magicap.bundle"
    _write_zip_members(malformed, members)

    with pytest.raises(BundleContractValidationError, match="Windows-illegal character"):
        validate_bundle(malformed)


@pytest.mark.parametrize("mutation", ["missing-required-property", "numeric-version"])
def test_outer_manifest_schema_rejects_missing_property_and_wrong_version(
    tmp_path: Path, mutation: str
) -> None:
    valid = FIXTURES / "magicap-bundle-v3.1.valid.magicap.bundle"
    members = _read_zip_members(valid)
    outer_manifest = json.loads(members["manifest.json"])
    if mutation == "missing-required-property":
        outer_manifest.pop("packages")
    else:
        outer_manifest["version"] = 3.1
    members["manifest.json"] = json.dumps(
        outer_manifest, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    malformed = tmp_path / f"{mutation}.magicap.bundle"
    _write_zip_members(malformed, members)

    with pytest.raises(BundleContractValidationError):
        validate_bundle(malformed)


def test_bundle_budgets_are_shared_across_outer_and_inner_entries() -> None:
    valid = FIXTURES / "magicap-bundle-v3.1.valid.magicap.bundle"
    with zipfile.ZipFile(valid) as outer:
        outer_size = sum(info.file_size for info in outer.infolist())
        child_sizes = []
        child_entries = []
        for name in outer.namelist():
            if not name.startswith("packages/"):
                continue
            child = BytesIO(outer.read(name))
            with zipfile.ZipFile(child) as archive:
                child_sizes.append(sum(info.file_size for info in archive.infolist()))
                child_entries.append(len(archive.infolist()))
        expanded_limit = outer_size + sum(child_sizes) - 1
        entry_limit = len(outer.infolist()) + sum(child_entries) - 1
    with pytest.raises(BundleContractValidationError, match="shared expanded-size limit"):
        validate_bundle(valid, limits=BundleLimits(max_shared_expanded_bytes=expanded_limit))
    with pytest.raises(BundleContractValidationError, match="shared entry-count limit"):
        validate_bundle(valid, limits=BundleLimits(max_shared_entries=entry_limit))
    with pytest.raises(BundleContractValidationError, match="JSON size limit"):
        validate_bundle(valid, limits=BundleLimits(max_json_bytes=10))


def test_bundle_extension_is_distinct_from_standalone_magicap() -> None:
    bundle = FIXTURES / "magicap-bundle-v3.1.valid.magicap.bundle"
    with pytest.raises(BundleContractValidationError, match="Capture Bundles must use"):
        validate_bundle(bundle, source_name="standalone.magicap")
    assert zipfile.is_zipfile(bundle)
