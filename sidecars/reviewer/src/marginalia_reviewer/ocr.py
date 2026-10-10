from __future__ import annotations

import hashlib
import json
import math
import re
import subprocess
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from PIL import Image

from .config import load_json_object

NDLOCR_LITE_VERSION = "1.3.1"
NDLOCR_LITE_TAG = "1.3.1"
NDLOCR_LITE_COMMIT = "6feccb29e33c2467ea48894e66502a7788ae2b2d"
NDLOCR_LITE_REPOSITORY = "https://github.com/ndl-lab/ndlocr-lite"
NDLOCR_LITE_MANIFEST_EXECUTABLE = "ndlocr-lite/ndlocr-lite.exe"
NDLOCR_MANAGED_BY = "MAGINALIA Desktop"


class OcrConfigurationError(ValueError):
    pass


def normalized_region_to_pixel_box(
    selected_region: dict[str, Any], image_width: int, image_height: int
) -> tuple[int, int, int, int]:
    """Convert the Android-owned normalized rectangle to a Pillow crop box."""
    if image_width <= 0 or image_height <= 0:
        raise ValueError("canonical image dimensions must be positive")
    values: dict[str, float] = {}
    for key in ("left", "top", "right", "bottom"):
        value = selected_region.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f"selectedRegion.{key} must be a finite number")
        values[key] = float(value)
    if (
        values["left"] < 0
        or values["top"] < 0
        or values["right"] > 1
        or values["bottom"] > 1
        or values["right"] <= values["left"]
        or values["bottom"] <= values["top"]
    ):
        raise ValueError("selectedRegion must be a non-empty normalized rectangle")
    left = max(0, min(image_width, math.floor(values["left"] * image_width)))
    top = max(0, min(image_height, math.floor(values["top"] * image_height)))
    right = max(0, min(image_width, math.ceil(values["right"] * image_width)))
    bottom = max(0, min(image_height, math.ceil(values["bottom"] * image_height)))
    if right <= left or bottom <= top:
        raise ValueError("selectedRegion becomes empty at canonical-image resolution")
    return left, top, right, bottom


class NdlocrLiteAdapter:
    """Subprocess boundary for the locally installed, explicitly pinned NDLOCR-Lite."""

    def __init__(self, config_path: Path, timeout_seconds: int = 600) -> None:
        self.config_path = config_path
        self.timeout_seconds = timeout_seconds
        try:
            config = load_json_object(config_path)
        except (OSError, UnicodeError, ValueError) as exc:
            raise OcrConfigurationError("NDLOCR-Lite の設定を読み取れません。") from exc
        if config.get("schemaVersion") != 1 or isinstance(config.get("schemaVersion"), bool):
            raise OcrConfigurationError("NDLOCR-Lite の設定バージョンが正しくありません。")
        if config.get("managedBy") != NDLOCR_MANAGED_BY:
            raise OcrConfigurationError("NDLOCR-Lite の設定はMAGINALIAが作成したものではありません。")
        if config.get("engine") != "NDLOCR-Lite" or config.get("version") != NDLOCR_LITE_VERSION:
            raise OcrConfigurationError(
                f"NDLOCR-Lite の設定はバージョン {NDLOCR_LITE_VERSION} に対応していません。"
            )
        if config.get("commit") != NDLOCR_LITE_COMMIT:
            raise OcrConfigurationError("NDLOCR-Lite の配布元を確認できません。")
        manifest_path_value = config.get("manifestPath")
        distribution_sha256 = config.get("distributionSha256")
        if not isinstance(manifest_path_value, str) or not manifest_path_value:
            raise OcrConfigurationError("NDLOCR-Lite の配布情報を確認できません。")
        manifest_path = Path(manifest_path_value)
        if not manifest_path.is_absolute():
            raise OcrConfigurationError("NDLOCR-Lite の配布情報を確認できません。")
        if not isinstance(distribution_sha256, str) or re.fullmatch(r"[0-9a-fA-F]{64}", distribution_sha256) is None:
            raise OcrConfigurationError("NDLOCR-Lite の配布情報を確認できません。")
        try:
            manifest_path = manifest_path.resolve(strict=True)
            if manifest_path.stat().st_size > 16 * 1024 * 1024:
                raise OcrConfigurationError("NDLOCR-Lite の配布情報が大きすぎます。")
            manifest_bytes = manifest_path.read_bytes()
        except (OSError, RuntimeError, ValueError) as exc:
            if isinstance(exc, OcrConfigurationError):
                raise
            raise OcrConfigurationError("NDLOCR-Lite が見つからないか、配布情報を読み取れません。") from exc
        manifest_digest = hashlib.sha256(manifest_bytes).hexdigest()
        if manifest_digest != distribution_sha256.casefold():
            raise OcrConfigurationError("NDLOCR-Lite の配布情報が一致しません。")
        try:
            manifest = json.loads(manifest_bytes.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise OcrConfigurationError("NDLOCR-Lite の配布情報を読み取れません。") from exc
        if not isinstance(manifest, dict):
            raise OcrConfigurationError("NDLOCR-Lite の配布情報が正しくありません。")
        source = manifest.get("source")
        if (
            manifest.get("schemaVersion") != 1
            or isinstance(manifest.get("schemaVersion"), bool)
            or manifest.get("engine") != "NDLOCR-Lite"
            or manifest.get("version") != NDLOCR_LITE_VERSION
            or not isinstance(source, dict)
            or source.get("repository") != NDLOCR_LITE_REPOSITORY
            or source.get("tag") != NDLOCR_LITE_TAG
            or source.get("commit") != NDLOCR_LITE_COMMIT
        ):
            raise OcrConfigurationError("NDLOCR-Lite の配布元またはバージョンを確認できません。")
        command = config.get("command")
        if not isinstance(command, list) or not command or not all(isinstance(item, str) and item for item in command):
            raise OcrConfigurationError("NDLOCR-Lite の起動設定が正しくありません。")
        if command[1:] not in (
            ["--sourceimg", "{input}", "--output", "{outputDir}", "--json-only", "--device", "cpu"],
            ["--sourceimg", "{input}", "--output", "{output}", "--json-only", "--device", "cpu"],
        ):
            raise OcrConfigurationError("NDLOCR-Lite の起動設定が正しくありません。")
        executable_value = Path(command[0])
        if not executable_value.is_absolute():
            raise OcrConfigurationError("NDLOCR-Lite の起動先が正しくありません。")
        try:
            executable = executable_value.resolve(strict=True)
            relative_executable = executable.relative_to(manifest_path.parent).as_posix()
        except (OSError, RuntimeError, ValueError) as exc:
            raise OcrConfigurationError("NDLOCR-Lite の起動先が配布フォルダー外です。") from exc
        if relative_executable != NDLOCR_LITE_MANIFEST_EXECUTABLE or not executable.is_file():
            raise OcrConfigurationError("NDLOCR-Lite の起動先が配布フォルダー内の実行ファイルではありません。")
        files = manifest.get("files")
        if not isinstance(files, list):
            raise OcrConfigurationError("NDLOCR-Lite の配布ファイル一覧が正しくありません。")
        executable_entries = [
            entry for entry in files
            if isinstance(entry, dict) and entry.get("path") == NDLOCR_LITE_MANIFEST_EXECUTABLE
        ]
        if len(executable_entries) != 1:
            raise OcrConfigurationError("NDLOCR-Lite の実行ファイルが配布一覧にありません。")
        executable_entry = executable_entries[0]
        manifest_executable_sha256 = executable_entry.get("sha256")
        manifest_executable_size = executable_entry.get("size")
        if (
            not isinstance(manifest_executable_sha256, str)
            or re.fullmatch(r"[0-9a-fA-F]{64}", manifest_executable_sha256) is None
            or isinstance(manifest_executable_size, bool)
            or not isinstance(manifest_executable_size, int)
            or manifest_executable_size < 0
        ):
            raise OcrConfigurationError("NDLOCR-Lite の実行ファイル情報が正しくありません。")
        try:
            actual_executable_size = executable.stat().st_size
        except OSError as exc:
            raise OcrConfigurationError("NDLOCR-Lite の実行ファイルを確認できません。") from exc
        if actual_executable_size != manifest_executable_size:
            raise OcrConfigurationError("NDLOCR-Lite の実行ファイルのサイズが配布情報と一致しません。")
        executable_sha256 = config.get("executableSha256")
        if not isinstance(executable_sha256, str) or re.fullmatch(r"[0-9a-fA-F]{64}", executable_sha256) is None:
            raise OcrConfigurationError("NDLOCR-Lite の実行ファイル情報が正しくありません。")
        if executable_sha256.casefold() != manifest_executable_sha256.casefold():
            raise OcrConfigurationError("NDLOCR-Lite の実行ファイル情報が配布一覧と一致しません。")
        digest = hashlib.sha256()
        try:
            with executable.open("rb") as source_file:
                for chunk in iter(lambda: source_file.read(1024 * 1024), b""):
                    digest.update(chunk)
        except OSError as exc:
            raise OcrConfigurationError("NDLOCR-Lite の実行ファイルを読み取れません。") from exc
        actual_executable_sha256 = digest.hexdigest()
        if actual_executable_sha256 != executable_sha256.casefold():
            raise OcrConfigurationError("NDLOCR-Lite の実行ファイルが配布情報と一致しません。")
        self.command = command
        self.executable_sha256 = actual_executable_sha256
        self.distribution_sha256 = manifest_digest

    def recognize(
        self, image_path: Path, expected_width: int, expected_height: int, page_id: str
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        with tempfile.TemporaryDirectory(prefix="marginalia-ocr-") as temporary:
            output_path = Path(temporary) / "result.json"
            command = [
                item.replace("{input}", str(image_path))
                .replace("{output}", str(output_path))
                .replace("{outputDir}", str(temporary))
                for item in self.command
            ]
            completed = subprocess.run(
                command,
                cwd=self.config_path.parent,
                capture_output=True,
                text=True,
                timeout=self.timeout_seconds,
                check=False,
                shell=False,
            )
            if completed.returncode:
                detail = (completed.stderr or completed.stdout).strip()[-1000:]
                raise RuntimeError(f"NDLOCR-Lite exited with {completed.returncode}: {detail}")
            if not output_path.is_file():
                candidates = list(Path(temporary).glob("*.json"))
                if len(candidates) != 1:
                    raise RuntimeError("NDLOCR-Lite did not create exactly one JSON output")
                output_path = candidates[0]
            try:
                raw: Any = json.loads(output_path.read_text(encoding="utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise RuntimeError("NDLOCR-Lite output is not valid UTF-8 JSON") from exc
        regions_value = raw.get("regions") if isinstance(raw, dict) else None
        if regions_value is None and isinstance(raw, dict) and isinstance(raw.get("result"), dict):
            regions_value = raw["result"].get("regions")
        if regions_value is None and isinstance(raw, dict):
            contents = raw.get("contents")
            if isinstance(contents, list) and len(contents) == 1 and isinstance(contents[0], list):
                regions_value = contents[0]
        if not isinstance(regions_value, list) or not all(isinstance(item, dict) for item in regions_value):
            raise RuntimeError("NDLOCR-Lite JSON must contain a regions array")
        image_value = raw.get("image") if isinstance(raw, dict) and isinstance(raw.get("image"), dict) else {}
        assert isinstance(image_value, dict)
        image_info = raw.get("imginfo") if isinstance(raw, dict) and isinstance(raw.get("imginfo"), dict) else {}
        assert isinstance(image_info, dict)
        reported_width = image_value.get("width", raw.get("imageWidth", raw.get("width", image_info.get("img_width"))))
        reported_height = image_value.get("height", raw.get("imageHeight", raw.get("height", image_info.get("img_height"))))
        if reported_width != expected_width or reported_height != expected_height:
            raise RuntimeError(
                "NDLOCR-Lite image dimensions do not match the canonical page "
                f"({reported_width}x{reported_height} != {expected_width}x{expected_height})"
            )
        regions = [
            self._normalize_region(region, index, expected_width, expected_height)
            | {"id": f"ndl:{page_id}:{index}"}
            for index, region in enumerate(regions_value)
        ]
        provenance = {
            "engine": "NDLOCR-Lite",
            "version": NDLOCR_LITE_VERSION,
            "commit": NDLOCR_LITE_COMMIT,
            "distributionSha256": self.distribution_sha256,
            "executableSha256": self.executable_sha256,
            "executedAt": datetime.now(UTC).isoformat(timespec="seconds"),
            "raw": raw,
        }
        return regions, provenance

    def recognize_selected_region(
        self,
        image_path: Path,
        expected_width: int,
        expected_height: int,
        page_id: str,
        capture_id: str,
        selected_region: dict[str, Any],
    ) -> dict[str, Any]:
        """Run NDLOCR-Lite on a JPEG crop, never on intersecting page boxes."""
        pixel_box = normalized_region_to_pixel_box(selected_region, expected_width, expected_height)
        left, top, right, bottom = pixel_box
        with Image.open(image_path) as page:
            page.load()
            if page.size != (expected_width, expected_height):
                raise RuntimeError(
                    "canonical page dimensions do not match imported metadata "
                    f"({page.size[0]}x{page.size[1]} != {expected_width}x{expected_height})"
                )
            crop = page.crop(pixel_box)
            if crop.mode != "RGB":
                crop = crop.convert("RGB")
            with tempfile.TemporaryDirectory(prefix="marginalia-capture-ocr-") as temporary:
                crop_path = Path(temporary) / "selected-region.jpg"
                crop.save(crop_path, format="JPEG", quality=95)
                regions, provenance = self.recognize(
                    crop_path,
                    right - left,
                    bottom - top,
                    f"{page_id}:capture:{capture_id}",
                )
        return {
            "regions": regions,
            "provenance": provenance,
            "pixelBounds": {"left": left, "top": top, "right": right, "bottom": bottom},
        }

    @staticmethod
    def _normalize_region(
        region: dict[str, Any], index: int, image_width: int, image_height: int
    ) -> dict[str, Any]:
        def number(value: Any) -> float:
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise RuntimeError(f"NDLOCR-Lite region {index} has invalid pixel coordinates")
            return float(value)

        box = region.get("boundingBox", region.get("bbox"))
        if isinstance(box, list) and len(box) == 4 and all(
            isinstance(point, list) and len(point) == 2 for point in box
        ):
            xs = [number(point[0]) for point in box]
            ys = [number(point[1]) for point in box]
            left, top, right, bottom = min(xs), min(ys), max(xs), max(ys)
        elif isinstance(box, list) and len(box) == 4:
            x, y, width, height = (number(value) for value in box)
            left, top, right, bottom = x, y, x + width, y + height
        elif isinstance(box, dict):
            left = number(box.get("left", box.get("x")))
            top = number(box.get("top", box.get("y")))
            if "right" in box and "bottom" in box:
                right, bottom = number(box["right"]), number(box["bottom"])
            else:
                right = left + number(box.get("width"))
                bottom = top + number(box.get("height"))
        else:
            raise RuntimeError(f"NDLOCR-Lite region {index} has no pixel boundingBox")
        # NDLOCR-Lite's detector can overshoot an image boundary by a few
        # pixels. Keep that official-output rounding artefact from rejecting
        # the entire page, while still rejecting materially unsafe boxes.
        boundary_tolerance = 8.0
        if (
            left < -boundary_tolerance
            or top < -boundary_tolerance
            or right > image_width + boundary_tolerance
            or bottom > image_height + boundary_tolerance
        ):
            raise RuntimeError(f"NDLOCR-Lite region {index} is outside the canonical image")
        left = min(max(left, 0.0), float(image_width))
        top = min(max(top, 0.0), float(image_height))
        right = min(max(right, 0.0), float(image_width))
        bottom = min(max(bottom, 0.0), float(image_height))
        if right <= left or bottom <= top:
            raise RuntimeError(f"NDLOCR-Lite region {index} is outside or degenerate")
        return {
            "id": f"ndl:{index}",
            "left": left / image_width,
            "top": top / image_height,
            "right": right / image_width,
            "bottom": bottom / image_height,
            "kind": region.get("kind") if region.get("kind") in {"LINE", "COLUMN", "ELEMENT"} else "LINE",
            "text": region.get("text") if isinstance(region.get("text"), str) else "",
        }
